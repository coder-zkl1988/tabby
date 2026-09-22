import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  type XhsOpsAccount,
  type XhsOpsAccountCreateInput,
  type XhsOpsAccountTransferInput,
  type XhsOpsAccountUpdateInput,
  type XhsOpsCommentDraft,
  type XhsOpsCommentListQuery,
  type XhsOpsDeviceBinding,
  type XhsOpsProfileApplyOperation,
  type XhsOpsProfileApplyStatus,
  type XhsOpsProject,
  type XhsOpsProjectCreateInput,
  type XhsOpsProjectUpdateInput,
  type XhsOpsRun,
  type XhsOpsRunListQuery,
  type XhsOpsStoreData,
  xhsOpsAccountCreateSchema,
  xhsOpsAccountTransferSchema,
  xhsOpsAccountUpdateSchema,
  xhsOpsPersonaIssues,
  xhsOpsPersonasConfirmBodySchema,
  xhsOpsProfileConfirmBodySchema,
  xhsOpsProfileDraftMissingFields,
  xhsOpsProfileIssues,
  xhsOpsProjectCreateSchema,
  xhsOpsProjectInputIssues,
  xhsOpsProjectUpdateSchema,
  xhsOpsStoreDataSchema,
} from "@nexu/shared";
import type { z } from "zod";
import { XhsOpsError, localDateString } from "../lib/xhs-ops-common.js";
import { LowDbStore } from "./lowdb-store.js";

/** Oldest runs are dropped past this many (spec §2). */
export const XHS_OPS_MAX_RUNS = 500;
/** Comment drafts are small; keep a generous window for 复盘. */
export const XHS_OPS_MAX_COMMENTS = 2000;

/** Everything a comment draft carries except the store-assigned id/timestamps. */
export type XhsOpsCommentSeed = Omit<
  XhsOpsCommentDraft,
  "id" | "createdAt" | "updatedAt"
>;

/** Everything a run carries except the store-assigned id/timestamps. */
export type XhsOpsRunSeed = Omit<XhsOpsRun, "id" | "createdAt" | "updatedAt">;

export interface XhsOpsStoreDeps {
  now?: () => string;
  genId?: () => string;
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry !== undefined) {
      (out as Record<string, unknown>)[key] = entry;
    }
  }
  return out;
}

function profileDraftContentChanged(
  previous: XhsOpsAccount["profileDraft"],
  next: XhsOpsAccount["profileDraft"],
): boolean {
  return (
    previous.nickname.trim() !== next.nickname.trim() ||
    previous.bio.trim() !== next.bio.trim() ||
    previous.avatarPath !== next.avatarPath ||
    previous.coverPath !== next.coverPath ||
    previous.gender !== next.gender ||
    previous.birthday !== next.birthday ||
    previous.region !== next.region ||
    JSON.stringify(previous.interestTags) !== JSON.stringify(next.interestTags)
  );
}

function profileDraftMatchesApplySnapshot(
  current: XhsOpsAccount["profileDraft"],
  expected: XhsOpsAccount["profileDraft"],
): boolean {
  return (
    !profileDraftContentChanged(current, expected) &&
    current.reviewedAt === expected.reviewedAt &&
    current.nickname === expected.nickname &&
    current.bio === expected.bio &&
    current.avatarPath === expected.avatarPath &&
    current.coverPath === expected.coverPath &&
    current.generatedAt === expected.generatedAt &&
    current.avatarCandidates.length === expected.avatarCandidates.length &&
    current.avatarCandidates.every(
      (entry, index) => entry === expected.avatarCandidates[index],
    ) &&
    current.coverCandidates.length === expected.coverCandidates.length &&
    current.coverCandidates.every(
      (entry, index) => entry === expected.coverCandidates[index],
    )
  );
}

export interface XhsOpsAccountUpdateOptions {
  invalidateProfileReview?: boolean;
  profileApplyResult?: {
    expectedProfileDraft: XhsOpsAccount["profileDraft"];
    expectedPlatformAccountId?: string;
    appliedAt: string | null;
    applyStatus: XhsOpsAccount["profileDraft"]["applyStatus"];
    applyResult: string | null;
    verifiedAt?: string | null;
    verifiedAccountId?: string | null;
    verificationTaskId?: string | null;
  };
}

export interface XhsOpsProfileApplyCompletion {
  taskId?: string | null;
  applyStatus: XhsOpsProfileApplyStatus;
  applyResult: string | null;
  appliedAt: string | null;
  verifiedAt?: string | null;
  verifiedAccountId?: string | null;
  verificationTaskId?: string | null;
}

function invalidateProfileDraft(
  draft: XhsOpsAccount["profileDraft"],
): XhsOpsAccount["profileDraft"] {
  return {
    ...draft,
    reviewedAt: null,
    appliedAt: null,
    applyStatus: null,
    applyResult: null,
    applyOperation: null,
    verifiedAt: null,
    verifiedAccountId: null,
    verificationTaskId: null,
  };
}

function invalidatePersona(
  account: XhsOpsAccount,
  updatedAt: string,
): XhsOpsAccount {
  return {
    ...account,
    personaReviewedAt: null,
    personaReviewNote: null,
    profileDraft: invalidateProfileDraft(account.profileDraft),
    updatedAt,
  };
}

export class XhsOpsStore {
  private readonly store: LowDbStore<XhsOpsStoreData>;
  private readonly activeDeviceBindings = new Map<
    string,
    { accountId: string; token: symbol; inFlight: boolean }
  >();
  /**
   * Every mutation runs read → transform → write under this queue. LowDbStore
   * serializes writes but not read-modify-write cycles, and the run executor
   * patches chunks while the API may be patching notes or cancelling — two
   * interleaved updaters would silently drop one another's change.
   */
  private mutationQueue: Promise<unknown> = Promise.resolve();
  private readonly now: () => string;
  private readonly genId: () => string;

  constructor(filePath: string, deps: XhsOpsStoreDeps = {}) {
    this.store = new LowDbStore<XhsOpsStoreData>(
      filePath,
      xhsOpsStoreDataSchema,
      () => ({
        schemaVersion: 1,
        projects: [],
        accounts: [],
        runs: [],
        comments: [],
      }),
    );
    this.now = deps.now ?? (() => new Date().toISOString());
    this.genId = deps.genId ?? (() => randomUUID());
  }

  private mutate<R>(
    fn: (current: XhsOpsStoreData) => { data: XhsOpsStoreData; result: R },
  ): Promise<R> {
    const next = this.mutationQueue.then(async () => {
      const current = await this.store.read();
      const { data, result } = fn(current);
      if (data !== current) {
        await this.store.write(data);
      }
      return result;
    });
    this.mutationQueue = next.catch(() => undefined);
    return next;
  }

  private nextUpdatedAt(previous: string): string {
    return new Date(
      Math.max(Date.parse(this.now()), Date.parse(previous) + 1),
    ).toISOString();
  }

  // ─── Projects ──────────────────────────────────────────────────────────────

  async listProjects(): Promise<XhsOpsProject[]> {
    return (await this.store.read()).projects;
  }

  async getProject(projectId: string): Promise<XhsOpsProject | null> {
    return (await this.listProjects()).find((p) => p.id === projectId) ?? null;
  }

  async createProject(input: XhsOpsProjectCreateInput): Promise<XhsOpsProject> {
    const parsed = xhsOpsProjectCreateSchema.parse(input);
    const now = this.now();
    const { profile, ...rest } = parsed;
    const project: XhsOpsProject = {
      ...rest,
      id: this.genId(),
      profile: profile
        ? { ...profile, confirmedAt: null, updatedAt: now }
        : null,
      createdAt: now,
      updatedAt: now,
    };
    return this.mutate((current) => ({
      data: { ...current, projects: [...current.projects, project] },
      result: project,
    }));
  }

  async updateProject(
    projectId: string,
    patch: XhsOpsProjectUpdateInput,
  ): Promise<XhsOpsProject | null> {
    const parsed = xhsOpsProjectUpdateSchema.parse(patch);
    return this.mutate((current) => {
      const index = current.projects.findIndex((p) => p.id === projectId);
      const existing = current.projects[index];
      if (!existing) {
        return { data: current, result: null };
      }
      const projectAccountIds = new Set(
        current.accounts
          .filter((account) => account.projectId === projectId)
          .map((account) => account.id),
      );
      if (this.hasRunningProfileApply(current, projectAccountIds)) {
        throw new XhsOpsError(
          409,
          "项目下有账号资料正在应用到手机，请等待任务结束",
        );
      }
      if (
        parsed.expectedUpdatedAt &&
        parsed.expectedUpdatedAt !== existing.updatedAt
      )
        throw new XhsOpsError(409, "项目已更新，请重新加载后再保存");
      const now = this.nextUpdatedAt(existing.updatedAt);
      const {
        profile,
        expectedUpdatedAt: _expectedUpdatedAt,
        ...rest
      } = parsed;
      const next: XhsOpsProject = {
        ...existing,
        ...stripUndefined(rest),
        updatedAt: now,
      };
      if (profile !== undefined) {
        next.profile = profile
          ? { ...profile, confirmedAt: null, updatedAt: now }
          : null;
      }
      const invalidates =
        profile !== undefined ||
        ["business", "audience", "opsNotes"].some(
          (key) =>
            JSON.stringify(
              existing[key as "business" | "audience" | "opsNotes"],
            ) !==
            JSON.stringify(next[key as "business" | "audience" | "opsNotes"]),
        );
      if (invalidates && next.profile)
        next.profile = { ...next.profile, confirmedAt: null, updatedAt: now };
      const projects = [...current.projects];
      projects[index] = next;
      const accounts = invalidates
        ? current.accounts.map((account) =>
            account.projectId === projectId
              ? invalidatePersona(
                  account,
                  this.nextUpdatedAt(account.updatedAt),
                )
              : account,
          )
        : current.accounts;
      return { data: { ...current, projects, accounts }, result: next };
    });
  }

  async confirmProfile(
    projectId: string,
    input: z.input<typeof xhsOpsProfileConfirmBodySchema>,
  ): Promise<XhsOpsProject> {
    const parsed = xhsOpsProfileConfirmBodySchema.parse(input);
    return this.mutate((current) => {
      const project = current.projects.find((entry) => entry.id === projectId);
      if (!project) throw new XhsOpsError(404, "项目不存在");
      if (
        this.hasRunningProfileApply(
          current,
          new Set(
            current.accounts
              .filter((account) => account.projectId === projectId)
              .map((account) => account.id),
          ),
        )
      ) {
        throw new XhsOpsError(
          409,
          "项目下有账号资料正在应用到手机，请等待任务结束",
        );
      }
      if (project.updatedAt !== parsed.expectedUpdatedAt)
        throw new XhsOpsError(409, "画像或客户信息已更新，请重新加载后核对");
      const issues = [
        ...xhsOpsProjectInputIssues(project),
        ...xhsOpsProfileIssues(parsed.profile),
      ];
      if (issues.length) throw new XhsOpsError(400, issues.join("；"));
      const now = this.nextUpdatedAt(project.updatedAt);
      const next = {
        ...project,
        profile: { ...parsed.profile, confirmedAt: now, updatedAt: now },
        updatedAt: now,
      };
      const previousContent = project.profile
        ? {
            summary: project.profile.summary,
            base: project.profile.base,
            verticalInterests: project.profile.verticalInterests,
            generalInterests: project.profile.generalInterests,
          }
        : null;
      const changed =
        JSON.stringify(previousContent) !== JSON.stringify(parsed.profile);
      return {
        data: {
          ...current,
          projects: current.projects.map((entry) =>
            entry.id === projectId ? next : entry,
          ),
          accounts: changed
            ? current.accounts.map((account) =>
                account.projectId === projectId
                  ? invalidatePersona(
                      account,
                      this.nextUpdatedAt(account.updatedAt),
                    )
                  : account,
              )
            : current.accounts,
        },
        result: next,
      };
    });
  }

  async confirmPersonas(
    projectId: string,
    input: z.input<typeof xhsOpsPersonasConfirmBodySchema>,
  ): Promise<XhsOpsAccount[]> {
    const parsed = xhsOpsPersonasConfirmBodySchema.parse(input);
    return this.mutate((current) => {
      const project = current.projects.find((entry) => entry.id === projectId);
      if (!project?.profile?.confirmedAt)
        throw new XhsOpsError(409, "请先确认目标用户画像");
      if (project.updatedAt !== parsed.expectedUpdatedAt)
        throw new XhsOpsError(409, "目标画像已更新，请重新核对人设分布");
      const selected = parsed.accounts.map((selection) => {
        const account = current.accounts.find(
          (entry) =>
            entry.id === selection.accountId && entry.projectId === projectId,
        );
        if (!account) throw new XhsOpsError(404, "账号不存在或不属于该项目");
        if (account.updatedAt !== selection.expectedUpdatedAt)
          throw new XhsOpsError(409, "人设已更新，请重新加载并复核");
        if (account.profileDraft.applyOperation?.status === "running")
          throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
        const issues =
          account.entryMode === "existing" ? [] : xhsOpsPersonaIssues(account);
        if (issues.length)
          throw new XhsOpsError(400, `${account.label}：${issues.join("；")}`);
        if (
          current.accounts.some(
            (other) =>
              other.projectId === projectId &&
              other.id !== account.id &&
              (other.label.trim() === account.label.trim() ||
                (JSON.stringify(other.persona) ===
                  JSON.stringify(account.persona) &&
                  JSON.stringify([...other.interestPool.core].sort()) ===
                    JSON.stringify([...account.interestPool.core].sort()))),
          )
        )
          throw new XhsOpsError(
            400,
            `${account.label} 与同项目账号重复，请调整定位或人设兴趣组合`,
          );
        return account;
      });
      if (
        new Set(selected.map((account) => account.id)).size !== selected.length
      )
        throw new XhsOpsError(400, "重复选择了账号");
      const updates = new Map(
        selected.map((account) => {
          const now = this.nextUpdatedAt(account.updatedAt);
          return [
            account.id,
            {
              ...account,
              personaReviewedAt: now,
              personaReviewNote: parsed.reviewNote,
              updatedAt: now,
            },
          ];
        }),
      );
      return {
        data: {
          ...current,
          accounts: current.accounts.map(
            (account) => updates.get(account.id) ?? account,
          ),
        },
        result: Array.from(updates.values()),
      };
    });
  }

  /** Deleting a project cascades to its accounts and runs (spec §2). */
  async deleteProject(projectId: string): Promise<XhsOpsProject | null> {
    return this.mutate((current) => {
      const existing = current.projects.find((p) => p.id === projectId);
      if (!existing) {
        return { data: current, result: null };
      }
      const projectAccountIds = new Set(
        current.accounts
          .filter((account) => account.projectId === projectId)
          .map((account) => account.id),
      );
      const projectDeviceIds = new Set(
        current.accounts
          .filter((account) => account.projectId === projectId)
          .map((account) => account.deviceId)
          .filter((deviceId): deviceId is string => deviceId !== null),
      );
      if (this.hasActiveDeviceBinding(projectAccountIds, projectDeviceIds)) {
        throw new XhsOpsError(409, "项目设备正在执行账号任务，请稍后重试");
      }
      if (this.hasRunningProfileApply(current, projectAccountIds)) {
        throw new XhsOpsError(
          409,
          "项目下有账号资料正在应用到手机，请等待任务结束",
        );
      }
      const today = localDateString(new Date(this.now()));
      if (
        current.runs.some(
          (run) =>
            run.projectId === projectId &&
            (run.status === "planned" ||
              run.status === "running" ||
              run.date === today ||
              localDateString(new Date(run.updatedAt)) === today),
        )
      ) {
        throw new XhsOpsError(
          409,
          "项目仍有未完成任务或当日执行记录，暂不能删除",
        );
      }
      return {
        data: {
          ...current,
          projects: current.projects.filter((p) => p.id !== projectId),
          accounts: current.accounts.filter((a) => a.projectId !== projectId),
          runs: current.runs.filter((r) => r.projectId !== projectId),
          comments: current.comments.filter((c) => c.projectId !== projectId),
        },
        result: existing,
      };
    });
  }

  // ─── Accounts ──────────────────────────────────────────────────────────────

  async listAccountsByProject(projectId: string): Promise<XhsOpsAccount[]> {
    return (await this.store.read()).accounts.filter(
      (a) => a.projectId === projectId,
    );
  }

  async getAccount(accountId: string): Promise<XhsOpsAccount | null> {
    return (
      (await this.store.read()).accounts.find((a) => a.id === accountId) ?? null
    );
  }

  private hasActiveDeviceBinding(
    accountIds: ReadonlySet<string>,
    deviceIds: ReadonlySet<string>,
  ): boolean {
    for (const [deviceId, binding] of this.activeDeviceBindings) {
      if (deviceIds.has(deviceId) || accountIds.has(binding.accountId)) {
        return true;
      }
    }
    return false;
  }

  private hasRunningProfileApply(
    current: XhsOpsStoreData,
    accountIds: ReadonlySet<string>,
  ): boolean {
    return current.accounts.some(
      (account) =>
        accountIds.has(account.id) &&
        account.profileDraft.applyOperation?.status === "running",
    );
  }

  /** Used by recovery to distinguish a live in-process apply from a stale one. */
  isDeviceBindingActive(accountId: string, deviceId: string): boolean {
    const binding = this.activeDeviceBindings.get(deviceId);
    return binding?.accountId === accountId && binding.inFlight;
  }

  /** Mark a returned-but-uncertain task as recoverable by reconciliation. */
  markDeviceBindingSettled(accountId: string, deviceId: string): void {
    const binding = this.activeDeviceBindings.get(deviceId);
    if (binding?.accountId === accountId) binding.inFlight = false;
  }

  /** Release a reservation after the caller has proved its task is terminal. */
  releaseDeviceBinding(accountId: string, deviceId: string): void {
    const binding = this.activeDeviceBindings.get(deviceId);
    if (binding?.accountId === accountId)
      this.activeDeviceBindings.delete(deviceId);
  }

  private hasUnfinishedDeviceWork(
    current: XhsOpsStoreData,
    accountIds: ReadonlySet<string>,
    deviceIds: ReadonlySet<string>,
  ): boolean {
    return current.runs.some(
      (run) =>
        (accountIds.has(run.accountId) || deviceIds.has(run.deviceId)) &&
        (run.status === "planned" ||
          run.status === "running" ||
          run.preparation?.status === "running" ||
          run.chunks.some((chunk) => chunk.status === "running")),
    );
  }

  async acquireDeviceBinding(
    accountId: string,
    deviceId: string,
  ): Promise<() => void> {
    return this.mutate((current) => {
      const account = current.accounts.find((entry) => entry.id === accountId);
      const owners = current.accounts.filter(
        (entry) => entry.deviceId === deviceId,
      );
      if (!account || account.deviceId !== deviceId || owners.length !== 1) {
        throw new XhsOpsError(409, "设备绑定已变化，请刷新后重试");
      }
      if (this.activeDeviceBindings.has(deviceId)) {
        throw new XhsOpsError(409, "设备正在执行账号任务，请稍后重试");
      }

      const token = Symbol(deviceId);
      this.activeDeviceBindings.set(deviceId, {
        accountId,
        token,
        inFlight: true,
      });
      return {
        data: current,
        result: () => {
          if (this.activeDeviceBindings.get(deviceId)?.token === token) {
            this.activeDeviceBindings.delete(deviceId);
          }
        },
      };
    });
  }

  async listDeviceBindings(): Promise<XhsOpsDeviceBinding[]> {
    const current = await this.store.read();
    const projects = new Map(
      current.projects.map((project) => [project.id, project]),
    );
    const ownersByDevice = new Map<string, XhsOpsAccount[]>();
    for (const account of current.accounts) {
      if (!account.deviceId) continue;
      const owners = ownersByDevice.get(account.deviceId) ?? [];
      owners.push(account);
      ownersByDevice.set(account.deviceId, owners);
    }

    return current.accounts.flatMap((account) => {
      if (!account.deviceId) return [];
      const project = projects.get(account.projectId);
      const owners = ownersByDevice.get(account.deviceId) ?? [];
      const accountIds = new Set([account.id]);
      const deviceIds = new Set([account.deviceId]);
      const hasActiveBinding = this.hasActiveDeviceBinding(
        accountIds,
        deviceIds,
      );
      const hasUnfinishedRun = this.hasUnfinishedDeviceWork(
        current,
        accountIds,
        deviceIds,
      );
      const blockingReason =
        owners.length !== 1
          ? "设备存在多个账号绑定，请先修复重复绑定"
          : !project
            ? "绑定账号所属项目已不存在，请先清理异常数据"
            : hasActiveBinding
              ? "设备正在执行账号任务，请稍后重试"
              : hasUnfinishedRun
                ? "账号或设备还有待执行任务，请先取消任务"
                : null;
      return [
        {
          deviceId: account.deviceId,
          accountId: account.id,
          accountLabel: account.label,
          projectId: account.projectId,
          projectName: project?.name ?? "已删除项目",
          canTransfer: blockingReason === null,
          blockingReason,
        },
      ];
    });
  }

  async transferDevice(
    projectId: string,
    input: XhsOpsAccountTransferInput,
  ): Promise<XhsOpsAccount> {
    const parsed = xhsOpsAccountTransferSchema.parse(input);
    return this.mutate((current) => {
      const project = current.projects.find((entry) => entry.id === projectId);
      if (!project) throw new XhsOpsError(404, "目标项目不存在");

      const deviceId = parsed.account.deviceId;
      const source = current.accounts.find(
        (account) => account.id === parsed.fromAccountId,
      );
      const owners = current.accounts.filter(
        (account) => account.deviceId === deviceId,
      );
      if (!source || source.deviceId !== deviceId || owners.length !== 1) {
        throw new XhsOpsError(409, "设备绑定已变化，请刷新后重试");
      }
      if (!current.projects.some((entry) => entry.id === source.projectId)) {
        throw new XhsOpsError(409, "源账号所属项目已不存在，无法转移");
      }
      if (
        this.hasRunningProfileApply(
          current,
          new Set(
            [source.id, parsed.toAccountId].filter((id): id is string =>
              Boolean(id),
            ),
          ),
        )
      ) {
        throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
      }

      const target = parsed.toAccountId
        ? current.accounts.find((account) => account.id === parsed.toAccountId)
        : null;
      if (parsed.toAccountId && !target) {
        throw new XhsOpsError(404, "目标账号不存在");
      }
      if (target && target.projectId !== projectId) {
        throw new XhsOpsError(409, "目标账号不属于目标项目");
      }
      if (target?.id === source.id) {
        throw new XhsOpsError(409, "源账号与目标账号不能相同");
      }
      if (target?.deviceId && target.deviceId !== deviceId) {
        throw new XhsOpsError(409, "目标账号已绑定其他设备，请先解除目标绑定");
      }

      const relatedAccountIds = new Set(
        [source.id, target?.id].filter((id): id is string => id !== undefined),
      );
      const relatedDeviceIds = new Set(
        [source.deviceId, target?.deviceId].filter(
          (id): id is string => id !== null && id !== undefined,
        ),
      );
      if (this.hasActiveDeviceBinding(relatedAccountIds, relatedDeviceIds)) {
        throw new XhsOpsError(409, "设备正在执行账号任务，请稍后重试");
      }
      if (
        this.hasUnfinishedDeviceWork(
          current,
          relatedAccountIds,
          relatedDeviceIds,
        )
      ) {
        throw new XhsOpsError(
          409,
          "源账号、目标账号或相关设备还有待执行任务，请先取消任务",
        );
      }

      const now = this.now();
      const sourceNext: XhsOpsAccount = {
        ...source,
        deviceId: null,
        deviceName: null,
        profileDraft: invalidateProfileDraft(source.profileDraft),
        updatedAt: this.nextUpdatedAt(source.updatedAt),
      };
      let targetNext: XhsOpsAccount;
      if (target) {
        targetNext = invalidatePersona(
          {
            ...target,
            ...parsed.account,
            profileDraft: target.profileDraft,
            updatedAt: this.nextUpdatedAt(target.updatedAt),
          },
          this.nextUpdatedAt(target.updatedAt),
        );
      } else {
        const created = xhsOpsAccountCreateSchema.parse({
          ...parsed.account,
          projectId,
        });
        targetNext = {
          ...created,
          personaReviewedAt: null,
          personaReviewNote: null,
          profileDraft: {
            ...created.profileDraft,
            reviewedAt: null,
            appliedAt: null,
            applyStatus: null,
            applyResult: null,
            applyOperation: null,
            verifiedAt: null,
            verifiedAccountId: null,
            verificationTaskId: null,
          },
          id: this.genId(),
          createdAt: now,
          updatedAt: now,
        };
      }
      const accounts = current.accounts
        .map((account) => {
          if (account.id === source.id) return sourceNext;
          if (target && account.id === target.id) return targetNext;
          return account;
        })
        .concat(target ? [] : [targetNext]);

      return {
        data: { ...current, accounts },
        result: targetNext,
      };
    });
  }

  private checkDeviceBinding(
    current: XhsOpsStoreData,
    accountId: string,
    deviceId: string | null,
  ): void {
    if (
      deviceId &&
      current.accounts.some(
        (a) => a.id !== accountId && a.deviceId === deviceId,
      )
    ) {
      throw new XhsOpsError(409, "该设备已绑定其他账号，请先解除原绑定");
    }
  }

  async assertDeviceBinding(
    accountId: string,
    deviceId: string,
  ): Promise<XhsOpsAccount> {
    const current = await this.store.read();
    const account = current.accounts.find((a) => a.id === accountId);
    if (!account || account.deviceId !== deviceId) {
      throw new XhsOpsError(409, "账号设备绑定已变化，请重新创建计划");
    }
    this.checkDeviceBinding(current, accountId, deviceId);
    return account;
  }

  async createAccount(input: XhsOpsAccountCreateInput): Promise<XhsOpsAccount> {
    const parsed = xhsOpsAccountCreateSchema.parse(input);
    const now = this.now();
    const account: XhsOpsAccount = {
      ...parsed,
      personaReviewedAt: null,
      personaReviewNote: null,
      profileDraft: {
        ...parsed.profileDraft,
        reviewedAt: null,
        appliedAt: null,
        applyStatus: null,
        applyResult: null,
        applyOperation: null,
        verifiedAt: null,
        verifiedAccountId: null,
        verificationTaskId: null,
      },
      id: this.genId(),
      createdAt: now,
      updatedAt: now,
    };
    account.deviceId = account.deviceId?.trim() || null;
    return this.mutate((current) => {
      if (!current.projects.some((project) => project.id === account.projectId))
        throw new XhsOpsError(404, "项目不存在");
      this.checkDeviceBinding(current, account.id, account.deviceId);
      return {
        data: { ...current, accounts: [...current.accounts, account] },
        result: account,
      };
    });
  }

  async updateAccount(
    accountId: string,
    patch: XhsOpsAccountUpdateInput,
    options?: XhsOpsAccountUpdateOptions,
  ): Promise<XhsOpsAccount | null> {
    const parsed = xhsOpsAccountUpdateSchema.parse(patch);
    return this.mutate((current) => {
      const index = current.accounts.findIndex((a) => a.id === accountId);
      const existing = current.accounts[index];
      if (!existing) {
        return { data: current, result: null };
      }
      if (
        existing.profileDraft.applyOperation?.status === "running" &&
        Object.keys(parsed).some((key) => key !== "expectedUpdatedAt")
      ) {
        throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
      }
      if (
        parsed.expectedUpdatedAt &&
        parsed.expectedUpdatedAt !== existing.updatedAt
      )
        throw new XhsOpsError(409, "账号已更新，请重新加载后再保存");
      if (
        options?.profileApplyResult &&
        (!profileDraftMatchesApplySnapshot(
          existing.profileDraft,
          options.profileApplyResult.expectedProfileDraft,
        ) ||
          (options.profileApplyResult.expectedPlatformAccountId !== undefined &&
            options.profileApplyResult.expectedPlatformAccountId !==
              existing.platformAccountId))
      ) {
        throw new XhsOpsError(409, "账号资料草稿已变化，未覆盖新的编辑结果");
      }
      const { expectedUpdatedAt: _expectedUpdatedAt, ...editablePatch } =
        parsed;
      const parsedPatch = stripUndefined(editablePatch);
      const next: XhsOpsAccount = {
        ...existing,
        ...parsedPatch,
        profileDraft: parsed.profileDraft
          ? {
              ...parsed.profileDraft,
              appliedAt: existing.profileDraft.appliedAt,
              applyStatus: existing.profileDraft.applyStatus,
              applyResult: existing.profileDraft.applyResult,
              reviewedAt: existing.profileDraft.reviewedAt,
              verifiedAt: existing.profileDraft.verifiedAt,
              verifiedAccountId: existing.profileDraft.verifiedAccountId,
              verificationTaskId: existing.profileDraft.verificationTaskId,
              applyOperation: existing.profileDraft.applyOperation,
            }
          : existing.profileDraft,
        updatedAt: this.nextUpdatedAt(existing.updatedAt),
      };
      const personaChanged = [
        "label",
        "positioning",
        "persona",
        "personaTags",
        "interestPool",
      ].some(
        (key) =>
          JSON.stringify(existing[key as keyof XhsOpsAccount]) !==
          JSON.stringify(next[key as keyof XhsOpsAccount]),
      );
      if (personaChanged) {
        next.personaReviewedAt = null;
        next.personaReviewNote = null;
      }
      const invalidatesProfile = Boolean(
        options?.invalidateProfileReview ||
          personaChanged ||
          existing.platformAccountId !== next.platformAccountId ||
          existing.deviceId !== next.deviceId ||
          profileDraftContentChanged(existing.profileDraft, next.profileDraft),
      );
      next.profileDraft = invalidatesProfile
        ? invalidateProfileDraft(next.profileDraft)
        : {
            ...next.profileDraft,
            appliedAt: existing.profileDraft.appliedAt,
            applyStatus: existing.profileDraft.applyStatus,
            applyResult: existing.profileDraft.applyResult,
            reviewedAt: existing.profileDraft.reviewedAt,
            verifiedAt: existing.profileDraft.verifiedAt,
            verifiedAccountId: existing.profileDraft.verifiedAccountId,
            verificationTaskId: existing.profileDraft.verificationTaskId,
            applyOperation: existing.profileDraft.applyOperation,
          };
      if (options?.profileApplyResult) {
        next.profileDraft = {
          ...existing.profileDraft,
          appliedAt: options.profileApplyResult.appliedAt,
          applyStatus: options.profileApplyResult.applyStatus,
          applyResult: options.profileApplyResult.applyResult,
          verifiedAt:
            options.profileApplyResult.applyStatus === "applied"
              ? (options.profileApplyResult.verifiedAt ?? null)
              : null,
          verifiedAccountId:
            options.profileApplyResult.applyStatus === "applied"
              ? (options.profileApplyResult.verifiedAccountId ?? null)
              : null,
          verificationTaskId:
            options.profileApplyResult.applyStatus === "applied"
              ? (options.profileApplyResult.verificationTaskId ?? null)
              : null,
        };
      }
      next.deviceId = next.deviceId?.trim() || null;
      this.checkDeviceBinding(current, accountId, next.deviceId);
      if (
        next.deviceId !== existing.deviceId &&
        this.hasActiveDeviceBinding(
          new Set([accountId]),
          new Set(
            [existing.deviceId, next.deviceId].filter(
              (id): id is string => id !== null,
            ),
          ),
        )
      ) {
        throw new XhsOpsError(409, "设备正在执行账号任务，请稍后重试");
      }
      if (
        next.deviceId !== existing.deviceId &&
        this.hasUnfinishedDeviceWork(
          current,
          new Set([accountId]),
          new Set(
            [existing.deviceId, next.deviceId].filter(
              (id): id is string => id !== null,
            ),
          ),
        )
      ) {
        throw new XhsOpsError(
          409,
          "账号或设备还有待执行任务，请先取消任务再修改绑定",
        );
      }
      const accounts = [...current.accounts];
      accounts[index] = next;
      return { data: { ...current, accounts }, result: next };
    });
  }

  /** Claim the exact account revision before any profile side effect is dispatched. */
  async beginProfileApply(
    accountId: string,
    expectedUpdatedAt: string,
    deviceId: string,
  ): Promise<XhsOpsAccount> {
    return this.mutate((current) => {
      const index = current.accounts.findIndex((a) => a.id === accountId);
      const existing = current.accounts[index];
      if (!existing) throw new XhsOpsError(404, "账号不存在");
      if (existing.updatedAt !== expectedUpdatedAt) {
        throw new XhsOpsError(
          409,
          "账号或上游资料已更新，请重新核对后再应用到手机",
        );
      }
      if (existing.profileDraft.applyOperation?.status === "running") {
        throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
      }
      const startedAt = this.now();
      const operation: XhsOpsProfileApplyOperation = {
        operationId: this.genId(),
        status: "running",
        deviceId,
        taskId: null,
        accountUpdatedAt: existing.updatedAt,
        startedAt,
        completedAt: null,
      };
      const next: XhsOpsAccount = {
        ...existing,
        profileDraft: {
          ...existing.profileDraft,
          applyOperation: operation,
        },
        updatedAt: this.nextUpdatedAt(existing.updatedAt),
      };
      const accounts = [...current.accounts];
      accounts[index] = next;
      return { data: { ...current, accounts }, result: next };
    });
  }

  /** Complete a claimed profile operation without accepting a stale snapshot. */
  async completeProfileApply(
    accountId: string,
    operationId: string,
    completion: XhsOpsProfileApplyCompletion,
  ): Promise<XhsOpsAccount | null> {
    return this.mutate((current) => {
      const index = current.accounts.findIndex((a) => a.id === accountId);
      const existing = current.accounts[index];
      if (!existing) return { data: current, result: null };
      const operation = existing.profileDraft.applyOperation;
      if (!operation || operation.operationId !== operationId) {
        throw new XhsOpsError(409, "资料应用任务已变化，请重新加载后核验");
      }
      if (operation.status !== "running") {
        throw new XhsOpsError(409, "资料应用任务已经结束，不能重复写入");
      }
      const completedAt = this.now();
      const next: XhsOpsAccount = {
        ...existing,
        profileDraft: {
          ...existing.profileDraft,
          appliedAt: completion.appliedAt,
          applyStatus: completion.applyStatus,
          applyResult: completion.applyResult,
          verifiedAt:
            completion.applyStatus === "applied"
              ? (completion.verifiedAt ?? null)
              : null,
          verifiedAccountId:
            completion.applyStatus === "applied"
              ? (completion.verifiedAccountId ?? null)
              : null,
          verificationTaskId:
            completion.applyStatus === "applied"
              ? (completion.verificationTaskId ?? null)
              : null,
          applyOperation: {
            ...operation,
            status: "completed",
            taskId: completion.taskId ?? operation.taskId,
            completedAt,
          },
        },
        updatedAt: this.nextUpdatedAt(existing.updatedAt),
      };
      const accounts = [...current.accounts];
      accounts[index] = next;
      return { data: { ...current, accounts }, result: next };
    });
  }

  async confirmProfileDraft(
    accountId: string,
    expectedUpdatedAt?: string,
  ): Promise<XhsOpsAccount | null> {
    const snapshot = await this.getAccount(accountId);
    if (!snapshot) return null;
    if (expectedUpdatedAt && expectedUpdatedAt !== snapshot.updatedAt)
      throw new XhsOpsError(409, "账号资料已更新，请重新加载后再确认");
    for (const [selected, candidates] of [
      [
        snapshot.profileDraft.avatarPath,
        snapshot.profileDraft.avatarCandidates,
      ],
      [snapshot.profileDraft.coverPath, snapshot.profileDraft.coverCandidates],
    ] as const) {
      if (
        !selected ||
        !candidates.includes(selected) ||
        !(await stat(selected).catch(() => null))?.isFile()
      )
        throw new XhsOpsError(
          400,
          "所选图片不存在或已不在候选素材中，请重新选择或生成",
        );
    }
    return this.mutate((current) => {
      const index = current.accounts.findIndex(
        (account) => account.id === accountId,
      );
      const existing = current.accounts[index];
      if (!existing) return { data: current, result: null };
      if (existing.profileDraft.applyOperation?.status === "running") {
        throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
      }
      if (existing.updatedAt !== snapshot.updatedAt)
        throw new XhsOpsError(409, "账号资料已更新，请重新加载并核对");
      const project = current.projects.find(
        (entry) => entry.id === existing.projectId,
      );
      if (
        !project?.profile?.confirmedAt ||
        (existing.entryMode !== "existing" && !existing.personaReviewedAt)
      )
        throw new XhsOpsError(409, "请先确认目标画像并复核账号人设");
      if (!existing.platformAccountId.trim())
        throw new XhsOpsError(400, "请填写要配置的目标小红书号");
      if (xhsOpsProfileDraftMissingFields(existing.profileDraft).length > 0) {
        throw new XhsOpsError(400, "请先完成账号资料与素材并校验确认");
      }
      const now = this.nextUpdatedAt(existing.updatedAt);
      const next: XhsOpsAccount = {
        ...existing,
        profileDraft: {
          ...existing.profileDraft,
          reviewedAt: now,
        },
        updatedAt: now,
      };
      const accounts = [...current.accounts];
      accounts[index] = next;
      return { data: { ...current, accounts }, result: next };
    });
  }

  /** Runs keep their `accountLabel` snapshot and are retained as history. */
  async deleteAccount(accountId: string): Promise<XhsOpsAccount | null> {
    return this.mutate((current) => {
      const existing = current.accounts.find((a) => a.id === accountId);
      if (!existing) {
        return { data: current, result: null };
      }
      if (existing.profileDraft.applyOperation?.status === "running") {
        throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
      }
      if (
        this.hasUnfinishedDeviceWork(
          current,
          new Set([existing.id]),
          new Set(existing.deviceId ? [existing.deviceId] : []),
        )
      )
        throw new XhsOpsError(
          409,
          "账号或设备还有待执行任务，请先取消任务再删除账号",
        );
      if (
        this.hasActiveDeviceBinding(
          new Set([existing.id]),
          new Set(existing.deviceId ? [existing.deviceId] : []),
        )
      ) {
        throw new XhsOpsError(409, "设备正在执行账号任务，请稍后重试");
      }
      return {
        data: {
          ...current,
          accounts: current.accounts.filter((a) => a.id !== accountId),
        },
        result: existing,
      };
    });
  }

  // ─── Runs ──────────────────────────────────────────────────────────────────

  /** Newest first (createdAt desc). */
  async listRuns(filter: XhsOpsRunListQuery = {}): Promise<XhsOpsRun[]> {
    const runs = (await this.store.read()).runs.filter(
      (run) =>
        (filter.projectId === undefined ||
          run.projectId === filter.projectId) &&
        (filter.accountId === undefined ||
          run.accountId === filter.accountId) &&
        (filter.date === undefined || run.date === filter.date),
    );
    // Stored order is insertion order; reverse it first so equal createdAt
    // values still come out newest-first under a stable sort.
    return runs
      .reverse()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getRun(runId: string): Promise<XhsOpsRun | null> {
    return (await this.store.read()).runs.find((r) => r.id === runId) ?? null;
  }

  async createRun(
    seed: XhsOpsRunSeed,
    options?: {
      claimComments?: boolean;
      reuseActive?: boolean;
      validate?: (current: XhsOpsStoreData) => void;
      onCreated?: () => void;
    },
  ): Promise<XhsOpsRun> {
    const now = this.now();
    const run: XhsOpsRun = {
      ...seed,
      id: this.genId(),
      createdAt: now,
      updatedAt: now,
    };
    let created = false;
    const result = await this.mutate((current) => {
      options?.validate?.(current);
      if (
        options?.reuseActive &&
        !options.claimComments &&
        (run.plan.kind ?? "browse") === "browse"
      ) {
        const matches = current.runs.filter(
          (candidate) =>
            candidate.projectId === run.projectId &&
            candidate.accountId === run.accountId &&
            candidate.deviceId === run.deviceId &&
            candidate.date === run.date &&
            (candidate.plan.kind ?? "browse") === "browse" &&
            candidate.segment?.index === run.segment?.index &&
            candidate.segment?.count === run.segment?.count &&
            (candidate.status === "planned" || candidate.status === "running"),
        );
        const existing =
          matches.find((candidate) => candidate.status === "running") ??
          matches.find((candidate) => candidate.queuedBehindRunId) ??
          matches[0];
        if (existing) return { data: current, result: existing };
      }
      const draftIds = new Set((run.plan.comments ?? []).map((c) => c.draftId));
      if (options?.claimComments) {
        if (draftIds.size !== run.plan.comments?.length)
          throw new XhsOpsError(400, "评论草稿不能重复");
        for (const entry of run.plan.comments ?? []) {
          const draft = current.comments.find((d) => d.id === entry.draftId);
          if (
            !draft ||
            draft.status !== "approved" ||
            draft.sentRunId ||
            draft.accountId !== run.accountId ||
            draft.projectId !== run.projectId ||
            draft.deviceId !== run.deviceId ||
            draft.text !== entry.text ||
            draft.post.title !== entry.postTitle ||
            draft.post.author !== entry.postAuthor
          ) {
            throw new XhsOpsError(
              409,
              "评论草稿已变化或被其他任务认领，请刷新后重试",
            );
          }
        }
      }
      const runs = [...current.runs, run];
      created = true;
      const today = localDateString(new Date(now));
      while (runs.length > XHS_OPS_MAX_RUNS) {
        const removable = runs.findIndex(
          (candidate) =>
            candidate.status !== "planned" &&
            candidate.status !== "running" &&
            candidate.date !== today &&
            localDateString(new Date(candidate.updatedAt)) !== today &&
            !runs.some((r) => r.queuedBehindRunId === candidate.id),
        );
        if (removable < 0) {
          throw new XhsOpsError(
            409,
            "任务记录已达上限，当日记录和未完成任务不能自动清理",
          );
        }
        runs.splice(removable, 1);
      }
      return {
        data: {
          ...current,
          runs,
          comments: options?.claimComments
            ? current.comments.map((d) =>
                draftIds.has(d.id)
                  ? { ...d, sentRunId: run.id, updatedAt: now }
                  : d,
              )
            : current.comments,
        },
        result: run,
      };
    });
    if (created) options?.onCreated?.();
    return result;
  }

  /** Release only drafts proven not attempted; ambiguous sends require review. */
  async settleCommentClaims(runId: string): Promise<void> {
    await this.mutate((current) => {
      const run = current.runs.find((r) => r.id === runId);
      const comments = current.comments.map((draft) => {
        if (draft.sentRunId !== runId || draft.status !== "approved")
          return draft;
        const chunk = run?.chunks.find((c) => c.commentDraftId === draft.id);
        const unattempted =
          chunk &&
          !chunk.startedAt &&
          !chunk.taskId &&
          ["pending", "cancelled", "skipped"].includes(chunk.status);
        return unattempted
          ? { ...draft, sentRunId: null, updatedAt: this.now() }
          : {
              ...draft,
              status: "failed" as const,
              sendResult: "发送结果待核验，不自动重试",
              updatedAt: this.now(),
            };
      });
      return { data: { ...current, comments }, result: undefined };
    });
  }

  async updateRun(
    runId: string,
    updater: (current: XhsOpsRun) => XhsOpsRun,
  ): Promise<XhsOpsRun | null> {
    return this.mutate((current) => {
      const index = current.runs.findIndex((r) => r.id === runId);
      const existing = current.runs[index];
      if (!existing) {
        return { data: current, result: null };
      }
      const next = { ...updater(existing), id: existing.id };
      if (next.updatedAt === existing.updatedAt) {
        next.updatedAt = this.now();
      }
      const runs = [...current.runs];
      runs[index] = next;
      return { data: { ...current, runs }, result: next };
    });
  }

  async deleteRun(runId: string): Promise<XhsOpsRun | null> {
    return this.mutate((current) => {
      const existing = current.runs.find((r) => r.id === runId);
      if (!existing) {
        return { data: current, result: null };
      }
      return {
        data: { ...current, runs: current.runs.filter((r) => r.id !== runId) },
        result: existing,
      };
    });
  }

  // ─── Comment drafts (P3-1 D1) ──────────────────────────────────────────────

  /** Newest first. */
  async listComments(
    filter: XhsOpsCommentListQuery & { projectId?: string } = {},
  ): Promise<XhsOpsCommentDraft[]> {
    const comments = (await this.store.read()).comments.filter(
      (c) =>
        (filter.projectId === undefined || c.projectId === filter.projectId) &&
        (filter.accountId === undefined || c.accountId === filter.accountId) &&
        (filter.status === undefined || c.status === filter.status),
    );
    return comments
      .reverse()
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  async getComment(commentId: string): Promise<XhsOpsCommentDraft | null> {
    return (
      (await this.store.read()).comments.find((c) => c.id === commentId) ?? null
    );
  }

  async createComment(seed: XhsOpsCommentSeed): Promise<XhsOpsCommentDraft> {
    const now = this.now();
    const draft: XhsOpsCommentDraft = {
      ...seed,
      id: this.genId(),
      createdAt: now,
      updatedAt: now,
    };
    return this.mutate((current) => {
      const comments = [...current.comments, draft];
      const overflow = Math.max(0, comments.length - XHS_OPS_MAX_COMMENTS);
      return {
        data: {
          ...current,
          comments: overflow > 0 ? comments.slice(overflow) : comments,
        },
        result: draft,
      };
    });
  }

  async updateComment(
    commentId: string,
    updater: (current: XhsOpsCommentDraft) => XhsOpsCommentDraft,
  ): Promise<XhsOpsCommentDraft | null> {
    return this.mutate((current) => {
      const index = current.comments.findIndex((c) => c.id === commentId);
      const existing = current.comments[index];
      if (!existing) {
        return { data: current, result: null };
      }
      const next = { ...updater(existing), id: existing.id };
      const comments = [...current.comments];
      comments[index] = next;
      return { data: { ...current, comments }, result: next };
    });
  }
}
