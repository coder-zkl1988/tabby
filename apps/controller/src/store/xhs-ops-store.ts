import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import {
  XHS_ACCOUNT_IDENTITY_LOCKED_MESSAGE,
  XHS_TAKEOVER_DEVICE_HOLD_MESSAGE,
  XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
  XHS_TAKEOVER_IDENTITY_READ_TTL_MS,
  XHS_TAKEOVER_RESUME_HISTORY_LIMIT,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsAccountCreateInput,
  type XhsOpsAccountDiagnosis,
  type XhsOpsAccountTransferInput,
  type XhsOpsAccountUpdateInput,
  type XhsOpsAuditPartStatus,
  type XhsOpsChangeOrder,
  type XhsOpsCommentDraft,
  type XhsOpsCommentListQuery,
  type XhsOpsDeviceBinding,
  type XhsOpsDeviceWorkKind,
  type XhsOpsDeviceWorkPurpose,
  type XhsOpsProfileApplyOperation,
  type XhsOpsProfileApplyStatus,
  type XhsOpsProject,
  type XhsOpsProjectCreateInput,
  type XhsOpsProjectUpdateInput,
  type XhsOpsRun,
  type XhsOpsRunListQuery,
  type XhsOpsSafetyPause,
  type XhsOpsStoreData,
  type XhsOpsTakeover,
  xhsOpsAccountAuditSchema,
  xhsOpsAccountCreateSchema,
  xhsOpsAccountDiagnosisSchema,
  xhsOpsAccountEntryModeLocked,
  xhsOpsAccountTransferSchema,
  xhsOpsAccountUpdateSchema,
  xhsOpsChangeOrderSchema,
  xhsOpsDeviceWorkMessage,
  xhsOpsLegacyExistingVerified,
  xhsOpsPersonaIssues,
  xhsOpsPersonasConfirmBodySchema,
  xhsOpsProfileConfirmBodySchema,
  xhsOpsProfileDraftMissingFields,
  xhsOpsProfileIssues,
  xhsOpsProjectCreateSchema,
  xhsOpsProjectInputIssues,
  xhsOpsProjectUpdateSchema,
  xhsOpsStoreDataSchema,
  xhsOpsTakeoverAuthorizeBodySchema,
  xhsOpsTakeoverDeviceHoldReleaseBodySchema,
  xhsOpsTakeoverIdentityConfirmBodySchema,
  xhsOpsTakeoverPausedMessage,
  xhsOpsTakeoverPlanConfirmBodySchema,
  xhsOpsTakeoverPlanIssues,
  xhsOpsTakeoverPlanRevertBodySchema,
  xhsOpsTakeoverPlanSnapshotSchema,
  xhsOpsTakeoverResumeBodySchema,
  xhsOpsTakeoverSchema,
  xhsOpsToneGuideSchema,
} from "@nexu/shared";
import type { z } from "zod";
import { XhsOpsError, localDateString } from "../lib/xhs-ops-common.js";
import { LowDbStore } from "./lowdb-store.js";
import {
  XHS_ACTIVE_CHANGE_ORDER_STATUSES,
  XHS_DEVICE_TASK_CHANGE_ORDER_STATUSES,
  XHS_PLAN_LOCKING_CHANGE_ORDER_STATUSES,
  type XhsOpsAuditSeed,
  type XhsOpsChangeOrderSeed,
  type XhsOpsDiagnosisSeed,
  type XhsOpsTakeoverPauseInput,
  type XhsOpsTakeoverSkippedField,
  deriveTakeoverPlan,
  draftTakeoverChangeOrders,
  evictAudits,
  evictChangeOrders,
  evictDiagnoses,
  invalidateTakeoverIdentity,
  newestFirst,
  raiseTakeoverPause,
  recheckTakeoverParameters,
  settleDiagnosisGeneration,
  takeoverAfterResume,
  takeoverPlanFields,
  takeoverResumeIssue,
  takeoverResumeNeedsGate,
  withActiveAuditId,
} from "./xhs-ops-takeover-records.js";

export type {
  XhsOpsAuditSeed,
  XhsOpsChangeOrderSeed,
  XhsOpsDiagnosisSeed,
  XhsOpsTakeoverPauseInput,
  XhsOpsTakeoverSkippedField,
} from "./xhs-ops-takeover-records.js";

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

/** Optimistic check of one record update; a mismatch is a 409. */
export interface XhsOpsRecordUpdateOptions {
  expectedUpdatedAt?: string;
}

export type { XhsOpsDeviceWorkPurpose } from "@nexu/shared";

export interface XhsOpsExclusiveDeviceOptions {
  /** The caller's own running audit does not block it. */
  ownAuditId?: string;
  /** The caller's own change order does not block it. */
  ownOrderId?: string;
  purpose?: XhsOpsDeviceWorkPurpose;
}

export interface XhsOpsExclusiveDeviceClaim<R>
  extends XhsOpsExclusiveDeviceOptions {
  /**
   * Runs inside the same mutation once every check passed, before the lock is
   * taken: its data is written and its result returned. Throwing aborts the
   * claim without taking the lock.
   */
  claim: (
    current: XhsOpsStoreData,
    account: XhsOpsAccount,
  ) => { data: XhsOpsStoreData; result: R };
}

/** Read-only view handed to a mutateTakeover callback. */
export interface XhsOpsTakeoverSnapshot {
  account: XhsOpsAccount;
  project: XhsOpsProject | null;
  /** This account's records, in stored order. */
  audits: XhsOpsAccountAudit[];
  diagnoses: XhsOpsAccountDiagnosis[];
  changeOrders: XhsOpsChangeOrder[];
  now: string;
  /** Local YYYY-MM-DD of `now`. */
  today: string;
}

/**
 * Replacements a mutateTakeover callback returns. Records are matched by id
 * and must already exist and belong to the account; a changed record whose
 * updatedAt was left alone gets a fresh one.
 */
export interface XhsOpsTakeoverMutation<R> {
  account?: XhsOpsAccount;
  audits?: XhsOpsAccountAudit[];
  diagnoses?: XhsOpsAccountDiagnosis[];
  changeOrders?: XhsOpsChangeOrder[];
  result: R;
}

/** The account after the mutation and every record actually written. */
export interface XhsOpsTakeoverMutationResult<R> {
  result: R;
  account: XhsOpsAccount;
  audits: XhsOpsAccountAudit[];
  diagnoses: XhsOpsAccountDiagnosis[];
  changeOrders: XhsOpsChangeOrder[];
}

/** Plan confirm and revert: the account, its diagnosis and its change orders afterwards (newest first). */
export interface XhsOpsTakeoverPlanResult {
  account: XhsOpsAccount;
  diagnosis: XhsOpsAccountDiagnosis;
  changeOrders: XhsOpsChangeOrder[];
  /** Adopted profile fields that did not become a draft, with the reason. */
  skippedFields: XhsOpsTakeoverSkippedField[];
}

export interface XhsOpsTakeoverPlanRevertResult {
  account: XhsOpsAccount;
  /** The active diagnosis afterwards (normally the plan's own, back at ready); null when none is. */
  diagnosis: XhsOpsAccountDiagnosis | null;
  changeOrders: XhsOpsChangeOrder[];
}

/** Result of /takeover/identity/read, kept server-side until confirmed. */
export interface XhsOpsTakeoverIdentityRead {
  taskId: string;
  deviceId: string;
  screenshotUrl: string | null;
  /** 小红书号 the phone showed, "" when unreadable. Never logged or put in events. */
  readAccountId: string;
  /** Defaults to now. */
  readAt?: string;
}

/** A pause that may resume, and whether the identity gate must run first. */
export interface XhsOpsTakeoverResumeCheck {
  account: XhsOpsAccount;
  pause: XhsOpsSafetyPause;
  gateRequired: boolean;
}

export interface XhsOpsTakeoverResumeInput {
  /** `since` of the pause the check saw; another pause in between is a 409. */
  pauseSince: string;
  reason?: string;
  /** The identity gate's verdict; null when the pause needs no gate. */
  gateReady: boolean | null;
  /** The gate task that reported ready, for takeover.resumeHistory. */
  gateTaskId?: string | null;
}

/** Startup sweep of takeover work the previous controller left running (§2.6). */
export interface XhsOpsTakeoverRecovery {
  /** Now interrupted; `activeTaskId` is the phone task to reconcile. */
  audits: XhsOpsAccountAudit[];
  /** Now failed. */
  diagnoses: XhsOpsAccountDiagnosis[];
  /** prechecking went back to draft, applying/verifying became interrupted. */
  changeOrders: Array<{
    order: XhsOpsChangeOrder;
    previousStatus: "prechecking" | "applying" | "verifying";
    /** The phone task of that step, to stop or reconcile. */
    taskId: string | null;
  }>;
}

type XhsOpsAuthorizedTakeover = XhsOpsTakeover & { authorizedAt: string };

/** A takeover the operator authorized; everything after T1 needs one. */
function requireAuthorizedTakeover(
  account: XhsOpsAccount,
): XhsOpsAuthorizedTakeover {
  const takeover = account.takeover;
  if (
    account.entryMode !== "existing" ||
    !takeover ||
    takeover.authorizedAt === null
  )
    throw new XhsOpsError(409, "请先在接管卡片上授权接管该账号");
  return { ...takeover, authorizedAt: takeover.authorizedAt };
}

/**
 * Persona/core dedupe only means something for rows with a persona: an
 * existing row the takeover has not filled in yet compares by label alone
 * (§5.3 #10), or two blank takeover rows would collide.
 */
function blankExistingPersona(account: XhsOpsAccount): boolean {
  return (
    account.entryMode === "existing" &&
    Object.values(account.persona).every((value) => !value.trim()) &&
    !account.interestPool.core.some((value) => value.trim())
  );
}

function interruptPart<P extends { status: XhsOpsAuditPartStatus }>(
  part: P | null,
): P | null {
  return part?.status === "running" ? { ...part, status: "interrupted" } : part;
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

/**
 * Whether an account's 小红书号 may only change through the takeover identity
 * flow (§2.5): a takeover, or an existing row with a 小红书号 or a phone
 * verification on record. Clearing it through a PATCH would also lift
 * xhsOpsAccountEntryModeLocked, so a second PATCH could then switch the row
 * into the new-account flow.
 */
function accountIdentityLocked(account: XhsOpsAccount): boolean {
  if (account.takeover) return true;
  return (
    account.entryMode === "existing" &&
    (account.platformAccountId.trim() !== "" ||
      Boolean(account.profileDraft.verifiedAccountId?.trim()))
  );
}

/** The entryMode lock on the row before and after a write, against the mode it would leave. */
function entryModeSwitchLocked(
  before: XhsOpsAccount,
  after: XhsOpsAccount,
): boolean {
  if (after.entryMode === before.entryMode) return false;
  return (
    xhsOpsAccountEntryModeLocked(before) ||
    xhsOpsAccountEntryModeLocked({ ...after, entryMode: before.entryMode })
  );
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
        audits: [],
        diagnoses: [],
        changeOrders: [],
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
                (!blankExistingPersona(account) &&
                  !blankExistingPersona(other) &&
                  JSON.stringify(other.persona) ===
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
      const work = this.unfinishedDeviceWork(
        current,
        projectAccountIds,
        projectDeviceIds,
      );
      if (work && work !== "run") {
        throw new XhsOpsError(409, xhsOpsDeviceWorkMessage(work));
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
          audits: current.audits.filter((a) => a.projectId !== projectId),
          diagnoses: current.diagnoses.filter((d) => d.projectId !== projectId),
          // Change orders stay: they are the public-change trail and budget ledger.
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

  /**
   * The most severe unfinished work on these accounts or devices (§2.5):
   * runs — a planned one included, so a queued day of nurture blocks too —
   * running audits, a takeover's unconfirmed phone stop (deviceHold), and the
   * change order activeChangeOrderId points at, plus any order with a phone
   * task in flight. A precheck that expired un-confirmed no longer counts.
   * `exclude` lets a takeover step pass its own audit or order; an identity
   * read only minds orders with a phone task in flight, or a verify waiting
   * for the re-lock after an identity change could never run (§5.2 状态表).
   */
  private unfinishedDeviceWork(
    current: XhsOpsStoreData,
    accountIds: ReadonlySet<string>,
    deviceIds: ReadonlySet<string>,
    exclude: {
      auditId?: string;
      orderId?: string;
      purpose?: XhsOpsDeviceWorkPurpose;
      /** The run service asking about its own next dispatch: runs are its own queue. */
      ignoreRuns?: boolean;
    } = {},
  ): XhsOpsDeviceWorkKind | null {
    const touches = (accountId: string, deviceId: string | null) =>
      accountIds.has(accountId) ||
      (deviceId !== null && deviceIds.has(deviceId));
    const related = current.accounts.filter((account) =>
      touches(account.id, account.deviceId),
    );
    if (related.some((account) => account.takeover?.deviceHold))
      return "device_hold";
    if (
      !exclude.ignoreRuns &&
      current.runs.some(
        (run) =>
          touches(run.accountId, run.deviceId) &&
          (run.status === "planned" ||
            run.status === "running" ||
            run.preparation?.status === "running" ||
            run.chunks.some((chunk) => chunk.status === "running")),
      )
    )
      return "run";
    if (
      current.audits.some(
        (audit) =>
          audit.status === "running" &&
          audit.id !== exclude.auditId &&
          touches(audit.accountId, audit.deviceId),
      )
    )
      return "audit";
    const nowMs = Date.parse(this.now());
    for (const account of exclude.purpose === "identity" ? [] : related) {
      const orderId = account.takeover?.activeChangeOrderId;
      if (!orderId || orderId === exclude.orderId) continue;
      const order = current.changeOrders.find((entry) => entry.id === orderId);
      if (
        order &&
        XHS_ACTIVE_CHANGE_ORDER_STATUSES.has(order.status) &&
        !(
          order.status === "awaiting_confirm" &&
          order.precheck &&
          Date.parse(order.precheck.expiresAt) <= nowMs
        )
      )
        return "change_order";
    }
    if (
      current.changeOrders.some(
        (order) =>
          order.id !== exclude.orderId &&
          XHS_DEVICE_TASK_CHANGE_ORDER_STATUSES.has(order.status) &&
          touches(order.accountId, order.deviceId),
      )
    )
      return "change_order";
    return null;
  }

  /**
   * What owns this device besides xhs-ops runs (§5.4 N3), for the run
   * service to ask before every phone dispatch: the in-memory lock of a
   * takeover step or a profile apply in this process, a takeover's
   * deviceHold, a running audit, the change order activeChangeOrderId points
   * at or one with a phone task in flight. Runs serialise through the run
   * service's own device queue and do not count. Returns why the device is
   * taken, or null when it is free.
   */
  async runDispatchBlocker(
    accountId: string,
    deviceId: string,
  ): Promise<string | null> {
    const accountIds = new Set([accountId]);
    const deviceIds = new Set([deviceId]);
    if (this.hasActiveDeviceBinding(accountIds, deviceIds))
      return "手机正在执行只读盘点、资料变更或资料应用任务";
    const work = this.unfinishedDeviceWork(
      await this.store.read(),
      accountIds,
      deviceIds,
      { ignoreRuns: true },
    );
    return work ? xhsOpsDeviceWorkMessage(work) : null;
  }

  /**
   * Device lock for a takeover step (§2.5, N3): unlike acquireDeviceBinding it
   * also refuses unfinished device work — planned runs included — except the
   * caller's own audit or order. The new-account apply keeps
   * acquireDeviceBinding unchanged.
   */
  async acquireExclusiveDeviceBinding(
    accountId: string,
    deviceId: string,
    options: XhsOpsExclusiveDeviceOptions = {},
  ): Promise<() => void> {
    const { release } = await this.claimExclusiveDevice(accountId, deviceId, {
      ...options,
      claim: (current) => ({ data: current, result: undefined }),
    });
    return release;
  }

  /**
   * acquireExclusiveDeviceBinding plus a write in the same mutation, e.g. the
   * audit service creating its running audit so that audit cannot block
   * itself, or a change order entering prechecking.
   */
  async claimExclusiveDevice<R>(
    accountId: string,
    deviceId: string,
    options: XhsOpsExclusiveDeviceClaim<R>,
  ): Promise<{ release: () => void; result: R }> {
    const taken: { token: symbol | null } = { token: null };
    try {
      return await this.mutate((current) => {
        const account = current.accounts.find(
          (entry) => entry.id === accountId,
        );
        const owners = current.accounts.filter(
          (entry) => entry.deviceId === deviceId,
        );
        if (!account || account.deviceId !== deviceId || owners.length !== 1) {
          throw new XhsOpsError(409, "设备绑定已变化，请刷新后重试");
        }
        if (this.activeDeviceBindings.has(deviceId)) {
          throw new XhsOpsError(409, "设备正在执行账号任务，请稍后重试");
        }
        const work = this.unfinishedDeviceWork(
          current,
          new Set([accountId]),
          new Set([deviceId]),
          {
            auditId: options.ownAuditId,
            orderId: options.ownOrderId,
            purpose: options.purpose,
          },
        );
        if (work) {
          throw new XhsOpsError(
            409,
            xhsOpsDeviceWorkMessage(work, options.purpose),
          );
        }
        const claimed = options.claim(current, account);
        const owned = Symbol(deviceId);
        taken.token = owned;
        this.activeDeviceBindings.set(deviceId, {
          accountId,
          token: owned,
          inFlight: true,
        });
        return {
          data: claimed.data,
          result: {
            release: () => {
              if (this.activeDeviceBindings.get(deviceId)?.token === owned) {
                this.activeDeviceBindings.delete(deviceId);
              }
            },
            result: claimed.result,
          },
        };
      });
    } catch (error) {
      // The claim's write failed after the lock was taken: give it back.
      if (
        taken.token &&
        this.activeDeviceBindings.get(deviceId)?.token === taken.token
      )
        this.activeDeviceBindings.delete(deviceId);
      throw error;
    }
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
      const work = this.unfinishedDeviceWork(current, accountIds, deviceIds);
      const blockingReason =
        owners.length !== 1
          ? "设备存在多个账号绑定，请先修复重复绑定"
          : !project
            ? "绑定账号所属项目已不存在，请先清理异常数据"
            : hasActiveBinding
              ? "设备正在执行账号任务，请稍后重试"
              : work
                ? xhsOpsDeviceWorkMessage(work)
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
      const relatedWork = this.unfinishedDeviceWork(
        current,
        relatedAccountIds,
        relatedDeviceIds,
      );
      if (relatedWork) {
        throw new XhsOpsError(
          409,
          relatedWork === "run"
            ? "源账号、目标账号或相关设备还有待执行任务，请先取消任务"
            : xhsOpsDeviceWorkMessage(relatedWork),
        );
      }
      if (
        target &&
        parsed.account.entryMode !== target.entryMode &&
        xhsOpsAccountEntryModeLocked(target)
      ) {
        throw new XhsOpsError(409, XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE);
      }
      // A locked target keeps its 小红书号: the planner sends none (the
      // schema default is ""), and a transfer that cleared it would lift the
      // entryMode lock for the next PATCH (§2.5). Another id is refused.
      const targetIdentityLocked = target
        ? accountIdentityLocked(target)
        : false;
      if (
        target &&
        targetIdentityLocked &&
        parsed.account.platformAccountId !== "" &&
        parsed.account.platformAccountId !== target.platformAccountId
      ) {
        throw new XhsOpsError(409, XHS_ACCOUNT_IDENTITY_LOCKED_MESSAGE);
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
            ...(targetIdentityLocked
              ? { platformAccountId: target.platformAccountId }
              : {}),
            profileDraft: target.profileDraft,
            updatedAt: this.nextUpdatedAt(target.updatedAt),
          },
          this.nextUpdatedAt(target.updatedAt),
        );
        if (entryModeSwitchLocked(target, targetNext))
          throw new XhsOpsError(409, XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE);
        // The transfer rewrites the target's cadence: a takeover target gets
        // the PATCH re-check, with the transfer's own overrideReason (§2.5).
        targetNext.takeover = recheckTakeoverParameters(
          target,
          targetNext,
          parsed.overrideReason,
          targetNext.updatedAt,
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
          takeover: null,
          toneGuide: xhsOpsToneGuideSchema.parse({}),
          id: this.genId(),
          createdAt: now,
          updatedAt: now,
        };
      }
      // Both sides of a takeover lose their identity lock with the device.
      const sourceSettled = this.withIdentityInvalidated(
        current,
        source,
        sourceNext,
      );
      const targetSettled = target
        ? this.withIdentityInvalidated(sourceSettled, target, targetNext)
        : { ...sourceSettled, account: targetNext };
      const accounts = current.accounts
        .map((account) => {
          if (account.id === source.id) return sourceSettled.account;
          if (target && account.id === target.id) return targetSettled.account;
          return account;
        })
        .concat(target ? [] : [targetSettled.account]);

      return {
        data: {
          ...current,
          accounts,
          audits: targetSettled.audits,
          changeOrders: targetSettled.changeOrders,
        },
        result: targetSettled.account,
      };
    });
  }

  /** Applies invalidateTakeoverIdentity when a takeover's 小红书号 or device changed. */
  private withIdentityInvalidated(
    collections: Pick<XhsOpsStoreData, "audits" | "changeOrders">,
    previous: XhsOpsAccount,
    next: XhsOpsAccount,
  ): {
    account: XhsOpsAccount;
    audits: XhsOpsAccountAudit[];
    changeOrders: XhsOpsChangeOrder[];
  } {
    if (
      !previous.takeover ||
      (previous.platformAccountId === next.platformAccountId &&
        previous.deviceId === next.deviceId)
    )
      return {
        account: next,
        audits: collections.audits,
        changeOrders: collections.changeOrders,
      };
    return invalidateTakeoverIdentity(next, collections, (updatedAt) =>
      this.nextUpdatedAt(updatedAt),
    );
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
      takeover: null,
      toneGuide: xhsOpsToneGuideSchema.parse({}),
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
      // §2.5: a started takeover, or an existing row with a 小红书号 on
      // record, can never be switched into the new-account flow, and its
      // 小红书号 cannot be cleared or replaced here — clearing it would lift
      // that lock for the next PATCH.
      if (
        parsed.entryMode !== undefined &&
        parsed.entryMode !== existing.entryMode &&
        xhsOpsAccountEntryModeLocked(existing)
      )
        throw new XhsOpsError(409, XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE);
      if (
        parsed.platformAccountId !== undefined &&
        parsed.platformAccountId !== existing.platformAccountId &&
        accountIdentityLocked(existing)
      )
        throw new XhsOpsError(409, XHS_ACCOUNT_IDENTITY_LOCKED_MESSAGE);
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
      const {
        expectedUpdatedAt: _expectedUpdatedAt,
        overrideReason,
        ...editablePatch
      } = parsed;
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
      // The same lock on the patched row: a PATCH that records a 小红书号 on
      // an existing row cannot switch it to the new-account flow either.
      if (entryModeSwitchLocked(existing, next))
        throw new XhsOpsError(409, XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE);
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
          // N1: a takeover no longer rests on the profile-draft verification,
          // so tuning its persona or pool must not relock nurture.
          (personaChanged && existing.takeover === null) ||
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
      const bindingWork =
        next.deviceId !== existing.deviceId
          ? this.unfinishedDeviceWork(
              current,
              new Set([accountId]),
              new Set(
                [existing.deviceId, next.deviceId].filter(
                  (id): id is string => id !== null,
                ),
              ),
            )
          : null;
      if (bindingWork) {
        throw new XhsOpsError(
          409,
          bindingWork === "run"
            ? "账号或设备还有待执行任务，请先取消任务再修改绑定"
            : xhsOpsDeviceWorkMessage(bindingWork),
        );
      }
      next.takeover = recheckTakeoverParameters(
        existing,
        next,
        overrideReason,
        next.updatedAt,
      );
      const settled = this.withIdentityInvalidated(current, existing, next);
      const accounts = [...current.accounts];
      accounts[index] = settled.account;
      return {
        data: {
          ...current,
          accounts,
          audits: settled.audits,
          changeOrders: settled.changeOrders,
        },
        result: settled.account,
      };
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
        changeOrderId: null,
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
      const deleteWork = this.unfinishedDeviceWork(
        current,
        new Set([existing.id]),
        new Set(existing.deviceId ? [existing.deviceId] : []),
      );
      if (deleteWork)
        throw new XhsOpsError(
          409,
          deleteWork === "run"
            ? "账号或设备还有待执行任务，请先取消任务再删除账号"
            : xhsOpsDeviceWorkMessage(deleteWork),
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

  // ─── Takeover (老号接管) ────────────────────────────────────────────────────
  // Design: docs/plans/2026-10-14-xhs-account-takeover-design.md. Routes and
  // services decide when to call these; the store keeps every rule that has
  // to hold in one mutation.

  /** Bump updatedAt of a changed record the caller left stamped as before. */
  private stamp<T extends { updatedAt: string }>(previous: T, next: T): T {
    if (
      next.updatedAt !== previous.updatedAt ||
      JSON.stringify(next) === JSON.stringify(previous)
    )
      return next;
    return { ...next, updatedAt: this.nextUpdatedAt(previous.updatedAt) };
  }

  /** One-account write; returning the same object writes nothing. */
  private mutateAccount(
    accountId: string,
    fn: (account: XhsOpsAccount, current: XhsOpsStoreData) => XhsOpsAccount,
  ): Promise<XhsOpsAccount> {
    return this.mutate((current) => {
      const index = current.accounts.findIndex(
        (account) => account.id === accountId,
      );
      const existing = current.accounts[index];
      if (!existing) throw new XhsOpsError(404, "账号不存在");
      const next = fn(existing, current);
      if (next === existing) return { data: current, result: existing };
      const written: XhsOpsAccount = {
        ...next,
        id: existing.id,
        projectId: existing.projectId,
        updatedAt: this.nextUpdatedAt(existing.updatedAt),
      };
      const accounts = [...current.accounts];
      accounts[index] = written;
      return { data: { ...current, accounts }, result: written };
    });
  }

  /**
   * Card ① (T1): the ownership statement starts the takeover. An account the
   * old flow had applied and verified for this 小红书号 carries that record
   * over as its identity lock (identitySource "legacy", D5), so its schedule
   * keeps running until the plan is confirmed.
   */
  async authorizeTakeover(
    accountId: string,
    input: z.input<typeof xhsOpsTakeoverAuthorizeBodySchema>,
  ): Promise<XhsOpsAccount> {
    const body = xhsOpsTakeoverAuthorizeBodySchema.parse(input);
    return this.mutateAccount(accountId, (account, current) => {
      if (account.updatedAt !== body.expectedUpdatedAt)
        throw new XhsOpsError(409, "账号已更新，请重新加载后再授权");
      if (account.entryMode !== "existing")
        throw new XhsOpsError(409, "只有已有账号才能开始接管");
      if (account.takeover?.authorizedAt)
        throw new XhsOpsError(409, "该账号已授权接管");
      if (!account.deviceId)
        throw new XhsOpsError(409, "请先绑定这台手机，再授权接管");
      this.checkDeviceBinding(current, account.id, account.deviceId);
      if (account.profileDraft.applyOperation?.status === "running")
        throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
      const legacy = xhsOpsLegacyExistingVerified(account);
      return {
        ...account,
        takeover: xhsOpsTakeoverSchema.parse({
          ...account.takeover,
          authorizedAt: this.now(),
          authorizationNote: body.authorizationNote ?? "",
          ...(legacy
            ? {
                legacyVerified: true,
                identityConfirmedAt: account.profileDraft.verifiedAt,
                identitySource: "legacy",
                identityTaskId: account.profileDraft.verificationTaskId,
              }
            : {}),
        }),
      };
    });
  }

  /**
   * Store the result of /takeover/identity/read server-side (§2.1): only
   * that read can back a later confirm; a new read replaces the old one.
   */
  async recordTakeoverIdentityRead(
    accountId: string,
    read: XhsOpsTakeoverIdentityRead,
  ): Promise<XhsOpsAccount> {
    return this.mutateAccount(accountId, (account) => {
      const takeover = requireAuthorizedTakeover(account);
      if (!account.deviceId || account.deviceId !== read.deviceId)
        throw new XhsOpsError(409, "设备绑定已变化，请刷新后重新读取");
      return {
        ...account,
        takeover: {
          ...takeover,
          pendingIdentity: {
            taskId: read.taskId,
            deviceId: read.deviceId,
            readAt: read.readAt ?? this.now(),
            screenshotUrl: read.screenshotUrl,
            readAccountId: read.readAccountId.trim(),
          },
        },
      };
    });
  }

  /**
   * T2 lock (§2.1): the confirm must name the pending read's task, on the
   * same device, read after authorization and at most 30 minutes ago; an id
   * other than the one read needs overrideRead. A different 小红书号 than the
   * one on record first invalidates baseline, plan and change orders.
   */
  async confirmTakeoverIdentity(
    accountId: string,
    input: z.input<typeof xhsOpsTakeoverIdentityConfirmBodySchema>,
  ): Promise<XhsOpsAccount> {
    const body = xhsOpsTakeoverIdentityConfirmBodySchema.parse(input);
    return this.mutate((current) => {
      const index = current.accounts.findIndex(
        (account) => account.id === accountId,
      );
      const account = current.accounts[index];
      if (!account) throw new XhsOpsError(404, "账号不存在");
      const takeover = requireAuthorizedTakeover(account);
      if (account.profileDraft.applyOperation?.status === "running")
        throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
      const pending = takeover.pendingIdentity;
      if (!pending || pending.taskId !== body.identityTaskId)
        throw new XhsOpsError(409, "读取结果已失效，请重新读取手机当前账号");
      if (pending.deviceId !== account.deviceId)
        throw new XhsOpsError(409, "设备绑定已变化，请重新读取手机当前账号");
      const now = this.now();
      const readAt = Date.parse(pending.readAt);
      if (
        !(readAt > Date.parse(takeover.authorizedAt)) ||
        Date.parse(now) - readAt > XHS_TAKEOVER_IDENTITY_READ_TTL_MS
      )
        throw new XhsOpsError(
          409,
          "读取结果早于授权或已超过 30 分钟，请重新读取手机当前账号",
        );
      if (
        body.platformAccountId !== pending.readAccountId &&
        body.overrideRead !== true
      )
        throw new XhsOpsError(
          409,
          "填写的小红书号与手机读取结果不一致，请对照截图核对后确认",
        );
      const changed = body.platformAccountId !== account.platformAccountId;
      const settled = this.withIdentityInvalidated(current, account, {
        ...account,
        platformAccountId: body.platformAccountId,
        profileDraft: changed
          ? invalidateProfileDraft(account.profileDraft)
          : account.profileDraft,
      });
      const next: XhsOpsAccount = {
        ...settled.account,
        takeover: {
          ...(settled.account.takeover ?? takeover),
          identityConfirmedAt: now,
          identitySource: "takeover",
          identityTaskId: pending.taskId,
          identityScreenshotUrl: pending.screenshotUrl,
          pendingIdentity: null,
        },
        updatedAt: this.nextUpdatedAt(account.updatedAt),
      };
      const accounts = [...current.accounts];
      accounts[index] = next;
      return {
        data: {
          ...current,
          accounts,
          audits: settled.audits,
          changeOrders: settled.changeOrders,
        },
        result: next,
      };
    });
  }

  /**
   * Raise a safety pause (§6.5) from a run, audit, change order or the
   * card's 「暂停接管」 (code manual). Only a takeover has somewhere to keep
   * it; an existing row whose takeover never started fails its run instead.
   */
  async pauseTakeover(
    accountId: string,
    input: XhsOpsTakeoverPauseInput,
  ): Promise<XhsOpsAccount> {
    return this.mutateAccount(accountId, (account) => {
      const takeover = requireAuthorizedTakeover(account);
      const next = raiseTakeoverPause(takeover, input, this.now());
      if (next === takeover) return account;
      return { ...account, takeover: next };
    });
  }

  /**
   * First half of 「恢复」 (§6.5): no write. Says whether the pause may lift
   * now and whether the identity gate has to report ready first; the caller
   * runs the gate and hands its verdict to resumeTakeover.
   */
  async assertTakeoverResumable(
    accountId: string,
    input: z.input<typeof xhsOpsTakeoverResumeBodySchema>,
  ): Promise<XhsOpsTakeoverResumeCheck> {
    const body = xhsOpsTakeoverResumeBodySchema.parse(input);
    const account = await this.getAccount(accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
    if (account.updatedAt !== body.expectedUpdatedAt)
      throw new XhsOpsError(409, "账号已更新，请重新加载后再恢复");
    const takeover = requireAuthorizedTakeover(account);
    const issue = takeoverResumeIssue(takeover, body.reason, this.now());
    if (issue || !takeover.safetyPause)
      throw new XhsOpsError(409, issue ?? "账号没有暂停，无需恢复");
    return {
      account,
      pause: takeover.safetyPause,
      gateRequired: takeoverResumeNeedsGate(takeover),
    };
  }

  /**
   * Second half of 「恢复」: lifts the same pause once the rules and the gate
   * allow it, and appends the lift to takeover.resumeHistory (last 20). A
   * pause that masked an observation failure leaves that failure in force
   * (takeoverAfterResume).
   */
  async resumeTakeover(
    accountId: string,
    input: XhsOpsTakeoverResumeInput,
  ): Promise<XhsOpsAccount> {
    return this.mutateAccount(accountId, (account) => {
      const takeover = requireAuthorizedTakeover(account);
      const pause = takeover.safetyPause;
      if (!pause || pause.since !== input.pauseSince)
        throw new XhsOpsError(409, "暂停状态已变化，请刷新后重试");
      const now = this.now();
      const issue = takeoverResumeIssue(takeover, input.reason, now);
      if (issue) throw new XhsOpsError(409, issue);
      if (takeoverResumeNeedsGate(takeover) && input.gateReady !== true)
        throw new XhsOpsError(409, "身份闸门未通过，账号保持暂停");
      return {
        ...account,
        takeover: {
          ...takeover,
          // A pause that masked an observation failure raises it again (§6.5).
          ...takeoverAfterResume(takeover),
          resumeHistory: [
            ...takeover.resumeHistory,
            {
              at: now,
              code: pause.code,
              since: pause.since,
              sourceRef: pause.sourceRef,
              pauseReason: pause.reason,
              reason: (input.reason ?? "").trim().slice(0, 200),
              gateTaskId: input.gateTaskId ?? null,
            },
          ].slice(-XHS_TAKEOVER_RESUME_HISTORY_LIMIT),
        },
      };
    });
  }

  /**
   * A phone task whose stop was never confirmed (§3.1 表二): nothing is
   * dispatched to the account's device until a human releases it. The first
   * hold stands; later ones cannot happen while it does.
   */
  async holdTakeoverDevice(
    accountId: string,
    hold: { taskId: string; sourceRef: string },
  ): Promise<XhsOpsAccount> {
    return this.mutateAccount(accountId, (account) => {
      const takeover = requireAuthorizedTakeover(account);
      if (takeover.deviceHold) return account;
      return {
        ...account,
        takeover: {
          ...takeover,
          deviceHold: {
            taskId: hold.taskId,
            sourceRef: hold.sourceRef.slice(0, 80),
            since: this.now(),
          },
        },
      };
    });
  }

  /**
   * The operator confirmed on the phone that the task ended. The device lock
   * a failed step may have kept for the account is given back with the hold.
   */
  async releaseTakeoverDeviceHold(
    accountId: string,
    input: z.input<typeof xhsOpsTakeoverDeviceHoldReleaseBodySchema>,
  ): Promise<XhsOpsAccount> {
    const body = xhsOpsTakeoverDeviceHoldReleaseBodySchema.parse(input);
    const released = await this.mutateAccount(accountId, (account) => {
      if (account.updatedAt !== body.expectedUpdatedAt)
        throw new XhsOpsError(409, "账号已更新，请重新加载后再解除");
      const takeover = requireAuthorizedTakeover(account);
      if (!takeover.deviceHold)
        throw new XhsOpsError(409, "没有待解除的手机任务");
      return { ...account, takeover: { ...takeover, deviceHold: null } };
    });
    if (released.deviceId)
      this.releaseDeviceBinding(released.id, released.deviceId);
    return released;
  }

  /**
   * 「确认优化方案」 in one mutation (§5.1): re-checks the plan server-side,
   * snapshots the eight plan fields on the first confirmation only, writes
   * the L0 fields without touching the profile-draft review (N1), and drafts
   * every adopted public field as change orders (§5.2 step 1). Confirming a
   * newer diagnosis again cancels the previous plan's unstarted drafts.
   * `imageFieldsSupported` is whether the bound phone runs Android 10+;
   * `imageFieldsSkipReason` replaces the too-old-version skip reason when
   * the version is not why (a phone that could not be asked).
   */
  async confirmTakeoverPlan(
    diagnosisId: string,
    input: z.input<typeof xhsOpsTakeoverPlanConfirmBodySchema>,
    options: {
      imageFieldsSupported?: boolean;
      imageFieldsSkipReason?: string;
    } = {},
  ): Promise<XhsOpsTakeoverPlanResult> {
    const body = xhsOpsTakeoverPlanConfirmBodySchema.parse(input);
    return this.mutate((current) => {
      const diagnosis = current.diagnoses.find(
        (entry) => entry.id === diagnosisId,
      );
      if (!diagnosis) throw new XhsOpsError(404, "诊断不存在");
      if (diagnosis.updatedAt !== body.expectedUpdatedAt)
        throw new XhsOpsError(409, "诊断已更新，请重新加载后再确认方案");
      if (diagnosis.status !== "ready")
        throw new XhsOpsError(
          409,
          diagnosis.status === "confirmed"
            ? "该诊断的方案已经确认"
            : "诊断尚未生成完成或已失效，请重新生成",
        );
      const index = current.accounts.findIndex(
        (entry) => entry.id === diagnosis.accountId,
      );
      const account = current.accounts[index];
      if (!account) throw new XhsOpsError(404, "账号不存在");
      const takeover = requireAuthorizedTakeover(account);
      if (account.profileDraft.applyOperation?.status === "running")
        throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
      if (!account.platformAccountId.trim() || !takeover.identityConfirmedAt)
        throw new XhsOpsError(409, "请先读取并锁定手机上的小红书号");
      const deviceId = account.deviceId;
      if (!deviceId) throw new XhsOpsError(409, "请先绑定这台手机");
      if (!takeover.baselineAuditId)
        throw new XhsOpsError(409, "请先完成只读盘点并确认基线");
      if (diagnosis.auditId !== takeover.latestAuditId)
        throw new XhsOpsError(
          409,
          "诊断依据的不是最近一次盘点，请基于最新盘点重新生成",
        );
      const audit = current.audits.find(
        (entry) => entry.id === diagnosis.auditId,
      );
      if (
        !audit?.profile?.accountMatched ||
        audit.flags.includes("identityStale")
      )
        throw new XhsOpsError(
          409,
          "该次盘点没有核对通过小红书号，请重新盘点后再确认方案",
        );
      // A ready version stays ready while its regeneration runs (§2.3): only
      // the active one is confirmable.
      if (takeover.activeDiagnosisId !== diagnosis.id)
        throw new XhsOpsError(
          409,
          current.diagnoses.some(
            (entry) =>
              entry.accountId === account.id && entry.status === "generating",
          )
            ? "诊断正在重新生成，请等它结束后再确认方案"
            : "这不是当前诊断，请在最新的诊断上确认方案",
        );
      if (takeover.safetyPause)
        throw new XhsOpsError(
          409,
          xhsOpsTakeoverPausedMessage(takeover.safetyPause.reason),
        );
      if (takeover.deviceHold)
        throw new XhsOpsError(409, XHS_TAKEOVER_DEVICE_HOLD_MESSAGE);
      if (
        current.changeOrders.some(
          (order) =>
            order.accountId === account.id &&
            XHS_PLAN_LOCKING_CHANGE_ORDER_STATUSES.has(order.status),
        )
      )
        throw new XhsOpsError(
          409,
          "有资料变更单正在预检、执行或待人工核对，暂不能确认方案",
        );

      const now = this.now();
      const plan = deriveTakeoverPlan(account, diagnosis, now);
      const issues = xhsOpsTakeoverPlanIssues(plan.fields, plan.maturity);
      if (issues.length > 0)
        throw new XhsOpsError(
          409,
          issues.map((issue) => issue.message).join("；"),
        );
      const drafted = body.keepAllPublic
        ? { seeds: [], skipped: [] }
        : draftTakeoverChangeOrders({
            account,
            deviceId,
            diagnosisId: diagnosis.id,
            baseline:
              current.audits.find(
                (entry) => entry.id === takeover.baselineAuditId,
              ) ?? null,
            orders: current.changeOrders,
            changes: plan.profileChanges,
            imageFieldsSupported: options.imageFieldsSupported === true,
            imageFieldsSkipReason: options.imageFieldsSkipReason,
          });

      let activeChangeOrderId = takeover.activeChangeOrderId;
      const settledOrders = current.changeOrders.map(
        (order): XhsOpsChangeOrder => {
          if (
            order.accountId !== account.id ||
            order.diagnosisId === null ||
            order.rollbackOfId !== null ||
            (order.status !== "draft" && order.status !== "awaiting_confirm")
          )
            return order;
          if (activeChangeOrderId === order.id) activeChangeOrderId = null;
          return {
            ...order,
            status: "cancelled",
            precheck: null,
            error: "方案已重新确认，旧草案作废",
            updatedAt: this.nextUpdatedAt(order.updatedAt),
          };
        },
      );
      const created = drafted.seeds.map((seed) =>
        xhsOpsChangeOrderSchema.parse({
          ...seed,
          id: this.genId(),
          createdAt: now,
          updatedAt: now,
        }),
      );
      const changeOrders = evictChangeOrders(
        [...settledOrders, ...created],
        now,
      );
      const nextAccount: XhsOpsAccount = {
        ...account,
        ...plan.fields,
        takeover: {
          ...takeover,
          prePlanSnapshot:
            takeover.prePlanSnapshot ??
            xhsOpsTakeoverPlanSnapshotSchema.parse(takeoverPlanFields(account)),
          planConfirmedAt: now,
          maturity: plan.maturity,
          activeDiagnosisId: diagnosis.id,
          keepAllPublic: body.keepAllPublic === true,
          // Kept for the card past a remount; this plan's list replaces the last one's.
          skippedFields: drafted.skipped,
          activeChangeOrderId,
        },
        updatedAt: this.nextUpdatedAt(account.updatedAt),
      };
      const nextDiagnosis: XhsOpsAccountDiagnosis = {
        ...diagnosis,
        status: "confirmed",
        confirmedAt: now,
        updatedAt: this.nextUpdatedAt(diagnosis.updatedAt),
      };
      const accounts = [...current.accounts];
      accounts[index] = nextAccount;
      return {
        data: {
          ...current,
          accounts,
          diagnoses: current.diagnoses.map((entry) =>
            entry.id === diagnosis.id ? nextDiagnosis : entry,
          ),
          changeOrders,
        },
        result: {
          account: nextAccount,
          diagnosis: nextDiagnosis,
          changeOrders: newestFirst(
            changeOrders.filter((order) => order.accountId === account.id),
          ),
          skippedFields: drafted.skipped,
        },
      };
    });
  }

  /**
   * 「撤销方案」 (§5.1 step 6, §5.2 step 9): restores the pre-plan snapshot
   * as a whole, puts the plan's diagnosis back to ready and cancels the
   * unstarted change orders. A change order mid-precheck, mid-apply or awaiting a human
   * check makes it a 409. The snapshot itself stays: it is the state before
   * the takeover, which a later confirmation must not overwrite.
   */
  async revertTakeoverPlan(
    accountId: string,
    input: z.input<typeof xhsOpsTakeoverPlanRevertBodySchema>,
  ): Promise<XhsOpsTakeoverPlanRevertResult> {
    const body = xhsOpsTakeoverPlanRevertBodySchema.parse(input);
    return this.mutate((current) => {
      const index = current.accounts.findIndex(
        (entry) => entry.id === accountId,
      );
      const account = current.accounts[index];
      if (!account) throw new XhsOpsError(404, "账号不存在");
      if (account.updatedAt !== body.expectedUpdatedAt)
        throw new XhsOpsError(409, "账号已更新，请重新加载后再撤销方案");
      const takeover = requireAuthorizedTakeover(account);
      const snapshot = takeover.prePlanSnapshot;
      if (!snapshot)
        throw new XhsOpsError(409, "还没有确认过接管方案，无需撤销");
      if (account.profileDraft.applyOperation?.status === "running")
        throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
      if (
        current.changeOrders.some(
          (order) =>
            order.accountId === account.id &&
            XHS_PLAN_LOCKING_CHANGE_ORDER_STATUSES.has(order.status),
        )
      )
        throw new XhsOpsError(
          409,
          "有资料变更单正在预检、执行或待人工核对，暂不能撤销方案",
        );
      let activeChangeOrderId = takeover.activeChangeOrderId;
      const changeOrders = current.changeOrders.map(
        (order): XhsOpsChangeOrder => {
          if (
            order.accountId !== account.id ||
            (order.status !== "draft" && order.status !== "awaiting_confirm")
          )
            return order;
          if (activeChangeOrderId === order.id) activeChangeOrderId = null;
          return {
            ...order,
            status: "cancelled",
            precheck: null,
            error: "方案已撤销，草案作废",
            updatedAt: this.nextUpdatedAt(order.updatedAt),
          };
        },
      );
      const nextAccount: XhsOpsAccount = {
        ...account,
        ...snapshot,
        takeover: {
          ...takeover,
          planConfirmedAt: null,
          maturity: null,
          keepAllPublic: false,
          skippedFields: [],
          activeChangeOrderId,
        },
        updatedAt: this.nextUpdatedAt(account.updatedAt),
      };
      // The plan came from the newest confirmed version. It goes back to
      // ready, or to superseded when a newer version became active since.
      const planDiagnosis = newestFirst(
        current.diagnoses.filter(
          (entry) =>
            entry.accountId === account.id && entry.status === "confirmed",
        ),
      ).sort((left, right) =>
        (right.confirmedAt ?? "").localeCompare(left.confirmedAt ?? ""),
      )[0];
      const reopened: XhsOpsAccountDiagnosis | null = planDiagnosis
        ? {
            ...planDiagnosis,
            status:
              planDiagnosis.id === takeover.activeDiagnosisId
                ? "ready"
                : "superseded",
            confirmedAt: null,
            updatedAt: this.nextUpdatedAt(planDiagnosis.updatedAt),
          }
        : null;
      const diagnoses = current.diagnoses.map((entry) =>
        entry.id === reopened?.id ? reopened : entry,
      );
      const accounts = [...current.accounts];
      accounts[index] = nextAccount;
      return {
        data: {
          ...current,
          accounts,
          diagnoses,
          changeOrders,
        },
        result: {
          account: nextAccount,
          diagnosis:
            diagnoses.find(
              (entry) => entry.id === takeover.activeDiagnosisId,
            ) ?? null,
          changeOrders: newestFirst(
            changeOrders.filter((order) => order.accountId === account.id),
          ),
        },
      };
    });
  }

  /**
   * Typed compound write for the takeover services (audit, diagnosis, change
   * order): one mutation sees the account with its records and returns
   * replacements, so a state transition and the account pointers it moves
   * (latestAuditId, activeChangeOrderId, observationUntil, safetyPause, …)
   * land together. The transition rules stay with the caller.
   */
  async mutateTakeover<R>(
    accountId: string,
    fn: (snapshot: XhsOpsTakeoverSnapshot) => XhsOpsTakeoverMutation<R>,
    options: XhsOpsRecordUpdateOptions = {},
  ): Promise<XhsOpsTakeoverMutationResult<R>> {
    return this.mutate((current) => {
      const index = current.accounts.findIndex(
        (entry) => entry.id === accountId,
      );
      const account = current.accounts[index];
      if (!account) throw new XhsOpsError(404, "账号不存在");
      if (
        options.expectedUpdatedAt &&
        options.expectedUpdatedAt !== account.updatedAt
      )
        throw new XhsOpsError(409, "账号已更新，请重新加载后再操作");
      const now = this.now();
      const mutation = fn({
        account,
        project:
          current.projects.find((entry) => entry.id === account.projectId) ??
          null,
        audits: current.audits.filter((entry) => entry.accountId === accountId),
        diagnoses: current.diagnoses.filter(
          (entry) => entry.accountId === accountId,
        ),
        changeOrders: current.changeOrders.filter(
          (entry) => entry.accountId === accountId,
        ),
        now,
        today: localDateString(new Date(now)),
      });
      const proposed = mutation.account ?? account;
      if (
        proposed !== account &&
        (proposed.id !== account.id || proposed.projectId !== account.projectId)
      )
        throw new Error(
          "mutateTakeover cannot change the account id or project",
        );
      const audits = this.replaceOwned(
        current.audits,
        mutation.audits,
        accountId,
      );
      // The audits as written decide takeover.activeAuditId: an audit that
      // leaves "running" here clears it.
      const synced = withActiveAuditId(proposed, audits.records);
      const nextAccount =
        synced === account ? account : this.stamp(account, synced);
      const diagnoses = this.replaceOwned(
        current.diagnoses,
        mutation.diagnoses,
        accountId,
      );
      const changeOrders = this.replaceOwned(
        current.changeOrders,
        mutation.changeOrders,
        accountId,
      );
      const accounts = [...current.accounts];
      accounts[index] = nextAccount;
      return {
        data: {
          ...current,
          accounts,
          audits: audits.records,
          diagnoses: diagnoses.records,
          changeOrders: changeOrders.records,
        },
        result: {
          result: mutation.result,
          account: nextAccount,
          audits: audits.written,
          diagnoses: diagnoses.written,
          changeOrders: changeOrders.written,
        },
      };
    });
  }

  private replaceOwned<
    T extends {
      id: string;
      accountId: string;
      projectId: string;
      updatedAt: string;
    },
  >(
    records: T[],
    updates: readonly T[] | undefined,
    accountId: string,
  ): { records: T[]; written: T[] } {
    if (!updates?.length) return { records, written: [] };
    const pending = new Map(updates.map((update) => [update.id, update]));
    const written: T[] = [];
    const next = records.map((record) => {
      const update = pending.get(record.id);
      if (!update) return record;
      pending.delete(record.id);
      if (record.accountId !== accountId || update.accountId !== accountId)
        throw new Error("mutateTakeover records must belong to the account");
      const stamped = this.stamp(record, {
        ...update,
        projectId: record.projectId,
      });
      written.push(stamped);
      return stamped;
    });
    if (pending.size > 0)
      throw new Error("mutateTakeover can only replace existing records");
    return { records: next, written };
  }

  /**
   * Startup sweep (§2.6): running audits become interrupted (their
   * activeTaskId is what the audit service reconciles) and no takeover
   * keeps an activeAuditId, generating
   * diagnoses fail, a prechecking change order goes back to draft — a
   * precheck changes nothing — and applying/verifying orders become
   * interrupted, keeping activeChangeOrderId until verify re-checks them.
   * Call once, before any takeover work of this process starts.
   */
  async recoverInterruptedTakeoverWork(): Promise<XhsOpsTakeoverRecovery> {
    return this.mutate((current) => {
      const recovery: XhsOpsTakeoverRecovery = {
        audits: [],
        diagnoses: [],
        changeOrders: [],
      };
      const audits = current.audits.map((audit) => {
        if (audit.status !== "running") return audit;
        const next: XhsOpsAccountAudit = {
          ...audit,
          status: "interrupted",
          reason: audit.reason || "controller 重启，盘点中断",
          profile: interruptPart(audit.profile),
          home: interruptPart(audit.home),
          creator: interruptPart(audit.creator),
          updatedAt: this.nextUpdatedAt(audit.updatedAt),
        };
        recovery.audits.push(next);
        return next;
      });
      let diagnoses = current.diagnoses.map((diagnosis) => {
        if (diagnosis.status !== "generating") return diagnosis;
        const next: XhsOpsAccountDiagnosis = {
          ...diagnosis,
          status: "failed",
          error: "controller 重启，诊断生成中断，请重新生成",
          updatedAt: this.nextUpdatedAt(diagnosis.updatedAt),
        };
        recovery.diagnoses.push(next);
        return next;
      });
      // Each failed generation hands its account back to the version it was
      // to replace (§2.3).
      let recoveredAccounts = current.accounts;
      for (const failed of recovery.diagnoses) {
        const settled = this.settleGeneration(
          { ...current, accounts: recoveredAccounts, diagnoses },
          failed,
        );
        recoveredAccounts = settled.accounts;
        diagnoses = settled.diagnoses;
      }
      const releasedOrders = new Set<string>();
      const changeOrders = current.changeOrders.map((order) => {
        if (order.status === "prechecking") {
          const next: XhsOpsChangeOrder = {
            ...order,
            status: "draft",
            precheck: null,
            updatedAt: this.nextUpdatedAt(order.updatedAt),
          };
          releasedOrders.add(order.id);
          recovery.changeOrders.push({
            order: next,
            previousStatus: "prechecking",
            taskId: order.precheckTaskId ?? order.precheck?.taskId ?? null,
          });
          return next;
        }
        if (order.status === "applying" || order.status === "verifying") {
          const next: XhsOpsChangeOrder = {
            ...order,
            status: "interrupted",
            error: "controller 重启，请补跑核验",
            updatedAt: this.nextUpdatedAt(order.updatedAt),
          };
          recovery.changeOrders.push({
            order: next,
            previousStatus: order.status,
            taskId:
              order.status === "applying"
                ? order.applyTaskId
                : order.verificationTaskId,
          });
          return next;
        }
        return order;
      });
      const accounts = recoveredAccounts.map((account) => {
        const orderId = account.takeover?.activeChangeOrderId;
        const released =
          account.takeover && orderId && releasedOrders.has(orderId)
            ? {
                ...account,
                takeover: { ...account.takeover, activeChangeOrderId: null },
              }
            : account;
        // No audit runs once the sweep is through: activeAuditId goes too.
        const next = withActiveAuditId(released, audits);
        return next === account ? account : this.stamp(account, next);
      });
      if (
        recovery.audits.length === 0 &&
        recovery.diagnoses.length === 0 &&
        recovery.changeOrders.length === 0 &&
        accounts.every((account, index) => account === current.accounts[index])
      )
        return { data: current, result: recovery };
      return {
        data: { ...current, accounts, audits, diagnoses, changeOrders },
        result: recovery,
      };
    });
  }

  // ─── Takeover audits ───────────────────────────────────────────────────────

  /** Newest first. */
  async listAudits(
    filter: { accountId?: string; projectId?: string } = {},
  ): Promise<XhsOpsAccountAudit[]> {
    return newestFirst(
      (await this.store.read()).audits.filter(
        (audit) =>
          (filter.accountId === undefined ||
            audit.accountId === filter.accountId) &&
          (filter.projectId === undefined ||
            audit.projectId === filter.projectId),
      ),
    );
  }

  async getAudit(auditId: string): Promise<XhsOpsAccountAudit | null> {
    return (
      (await this.store.read()).audits.find((audit) => audit.id === auditId) ??
      null
    );
  }

  private buildAudit(
    current: XhsOpsStoreData,
    seed: XhsOpsAuditSeed,
  ): XhsOpsAccountAudit {
    const account = current.accounts.find(
      (entry) => entry.id === seed.accountId,
    );
    if (!account || account.projectId !== seed.projectId)
      throw new XhsOpsError(404, "账号不存在或不属于该项目");
    const now = this.now();
    return xhsOpsAccountAuditSchema.parse({
      ...seed,
      id: this.genId(),
      createdAt: now,
      updatedAt: now,
    });
  }

  /**
   * `accounts` with the takeover.activeAuditId of `accountId` derived again
   * from `audits` (withActiveAuditId); a moved pointer stamps the account.
   */
  private syncActiveAudit(
    accounts: XhsOpsAccount[],
    audits: readonly XhsOpsAccountAudit[],
    accountId: string,
  ): XhsOpsAccount[] {
    const index = accounts.findIndex((account) => account.id === accountId);
    const account = accounts[index];
    if (!account) return accounts;
    const synced = withActiveAuditId(account, audits);
    if (synced === account) return accounts;
    const next = [...accounts];
    next[index] = {
      ...synced,
      updatedAt: this.nextUpdatedAt(account.updatedAt),
    };
    return next;
  }

  /** Plain insert under the retention rules; device work goes through startAudit. */
  async createAudit(
    seed: XhsOpsAuditSeed,
    options: { validate?: (current: XhsOpsStoreData) => void } = {},
  ): Promise<XhsOpsAccountAudit> {
    return this.mutate((current) => {
      options.validate?.(current);
      const audit = this.buildAudit(current, seed);
      const audits = evictAudits(
        [...current.audits, audit],
        current.accounts,
        audit.createdAt,
      );
      return {
        data: {
          ...current,
          accounts: this.syncActiveAudit(
            current.accounts,
            audits,
            audit.accountId,
          ),
          audits,
        },
        result: audit,
      };
    });
  }

  /**
   * Creates the running audit and takes the exclusive device lock in one
   * mutation (§2.5, T3), so the audit cannot block itself and nothing slips
   * in between; the takeover's activeAuditId points at it from then on.
   * `validate` runs in the same mutation before anything changes.
   */
  async startAudit(
    seed: Omit<XhsOpsAuditSeed, "status" | "startedAt">,
    options: {
      validate?: (current: XhsOpsStoreData, account: XhsOpsAccount) => void;
    } = {},
  ): Promise<{ audit: XhsOpsAccountAudit; release: () => void }> {
    const { release, result } = await this.claimExclusiveDevice(
      seed.accountId,
      seed.deviceId,
      {
        purpose: "audit",
        claim: (current, account) => {
          options.validate?.(current, account);
          const now = this.now();
          const audit = this.buildAudit(current, {
            ...seed,
            status: "running",
            startedAt: now,
          });
          const audits = evictAudits(
            [...current.audits, audit],
            current.accounts,
            now,
          );
          return {
            data: {
              ...current,
              accounts: this.syncActiveAudit(
                current.accounts,
                audits,
                audit.accountId,
              ),
              audits,
            },
            result: audit,
          };
        },
      },
    );
    return { audit: result, release };
  }

  async updateAudit(
    auditId: string,
    updater: (current: XhsOpsAccountAudit) => XhsOpsAccountAudit,
    options: XhsOpsRecordUpdateOptions = {},
  ): Promise<XhsOpsAccountAudit | null> {
    return this.mutate((current) => {
      const index = current.audits.findIndex((audit) => audit.id === auditId);
      const existing = current.audits[index];
      if (!existing) return { data: current, result: null };
      if (
        options.expectedUpdatedAt &&
        options.expectedUpdatedAt !== existing.updatedAt
      )
        throw new XhsOpsError(409, "盘点记录已更新，请重新加载后再操作");
      const next = this.stamp(existing, {
        ...updater(existing),
        id: existing.id,
        accountId: existing.accountId,
        projectId: existing.projectId,
      });
      const audits = [...current.audits];
      audits[index] = next;
      return {
        data: {
          ...current,
          accounts: this.syncActiveAudit(
            current.accounts,
            audits,
            next.accountId,
          ),
          audits,
        },
        result: next,
      };
    });
  }

  // ─── Takeover diagnoses ────────────────────────────────────────────────────

  /** Newest first. */
  async listDiagnoses(
    filter: { accountId?: string; projectId?: string } = {},
  ): Promise<XhsOpsAccountDiagnosis[]> {
    return newestFirst(
      (await this.store.read()).diagnoses.filter(
        (diagnosis) =>
          (filter.accountId === undefined ||
            diagnosis.accountId === filter.accountId) &&
          (filter.projectId === undefined ||
            diagnosis.projectId === filter.projectId),
      ),
    );
  }

  async getDiagnosis(
    diagnosisId: string,
  ): Promise<XhsOpsAccountDiagnosis | null> {
    return (
      (await this.store.read()).diagnoses.find(
        (diagnosis) => diagnosis.id === diagnosisId,
      ) ?? null
    );
  }

  /**
   * Insert a diagnosis version under the retention rules. `activate` makes it
   * the takeover's active diagnosis (§2.3). The ready version it replaces is
   * only superseded once the new one is ready (updateDiagnosis): a failed
   * generation hands the account back to it, still confirmable.
   */
  async createDiagnosis(
    seed: XhsOpsDiagnosisSeed,
    options: {
      validate?: (current: XhsOpsStoreData) => void;
      activate?: boolean;
    } = {},
  ): Promise<XhsOpsAccountDiagnosis> {
    return this.mutate((current) => {
      options.validate?.(current);
      const index = current.accounts.findIndex(
        (entry) => entry.id === seed.accountId,
      );
      const account = current.accounts[index];
      if (!account || account.projectId !== seed.projectId)
        throw new XhsOpsError(404, "账号不存在或不属于该项目");
      const now = this.now();
      const diagnosis = xhsOpsAccountDiagnosisSchema.parse({
        ...seed,
        id: this.genId(),
        createdAt: now,
        updatedAt: now,
      });
      let accounts = current.accounts;
      let previous = current.diagnoses;
      if (options.activate) {
        const takeover = requireAuthorizedTakeover(account);
        accounts = [...current.accounts];
        accounts[index] = {
          ...account,
          takeover: { ...takeover, activeDiagnosisId: diagnosis.id },
          updatedAt: this.nextUpdatedAt(account.updatedAt),
        };
        // A version that arrives already settled supersedes right away.
        if (diagnosis.status === "ready")
          previous = this.settleGeneration(
            { ...current, accounts, diagnoses: [...previous, diagnosis] },
            diagnosis,
          ).diagnoses.filter((entry) => entry.id !== diagnosis.id);
      }
      return {
        data: {
          ...current,
          accounts,
          diagnoses: evictDiagnoses([...previous, diagnosis], accounts),
        },
        result: diagnosis,
      };
    });
  }

  async updateDiagnosis(
    diagnosisId: string,
    updater: (current: XhsOpsAccountDiagnosis) => XhsOpsAccountDiagnosis,
    options: XhsOpsRecordUpdateOptions = {},
  ): Promise<XhsOpsAccountDiagnosis | null> {
    return this.mutate((current) => {
      const index = current.diagnoses.findIndex(
        (diagnosis) => diagnosis.id === diagnosisId,
      );
      const existing = current.diagnoses[index];
      if (!existing) return { data: current, result: null };
      if (
        options.expectedUpdatedAt &&
        options.expectedUpdatedAt !== existing.updatedAt
      )
        throw new XhsOpsError(409, "诊断已更新，请重新加载后再操作");
      const next = this.stamp(existing, {
        ...updater(existing),
        id: existing.id,
        accountId: existing.accountId,
        projectId: existing.projectId,
      });
      let diagnoses = [...current.diagnoses];
      diagnoses[index] = next;
      let accounts = current.accounts;
      // A generation that settles supersedes, or hands the account back (§2.3).
      if (
        existing.status === "generating" &&
        (next.status === "ready" || next.status === "failed")
      ) {
        const settled = this.settleGeneration({ ...current, diagnoses }, next);
        diagnoses = settled.diagnoses;
        accounts = settled.accounts;
      }
      return { data: { ...current, accounts, diagnoses }, result: next };
    });
  }

  /** settleDiagnosisGeneration applied to the store data, every changed record stamped. */
  private settleGeneration(
    current: XhsOpsStoreData,
    settled: XhsOpsAccountDiagnosis,
  ): { accounts: XhsOpsAccount[]; diagnoses: XhsOpsAccountDiagnosis[] } {
    const account = current.accounts.find(
      (entry) => entry.id === settled.accountId,
    );
    if (!account)
      return { accounts: current.accounts, diagnoses: current.diagnoses };
    const outcome = settleDiagnosisGeneration(
      account,
      current.diagnoses,
      settled,
    );
    const superseded = new Map(
      outcome.superseded.map((entry) => [entry.id, entry]),
    );
    return {
      accounts:
        outcome.account === account
          ? current.accounts
          : current.accounts.map((entry) =>
              entry.id === account.id
                ? this.stamp(entry, outcome.account)
                : entry,
            ),
      diagnoses: current.diagnoses.map((entry) => {
        const next = superseded.get(entry.id);
        return next ? this.stamp(entry, next) : entry;
      }),
    };
  }

  // ─── Takeover change orders ────────────────────────────────────────────────

  /** Newest first. */
  async listChangeOrders(
    filter: { accountId?: string; projectId?: string } = {},
  ): Promise<XhsOpsChangeOrder[]> {
    return newestFirst(
      (await this.store.read()).changeOrders.filter(
        (order) =>
          (filter.accountId === undefined ||
            order.accountId === filter.accountId) &&
          (filter.projectId === undefined ||
            order.projectId === filter.projectId),
      ),
    );
  }

  async getChangeOrder(orderId: string): Promise<XhsOpsChangeOrder | null> {
    return (
      (await this.store.read()).changeOrders.find(
        (order) => order.id === orderId,
      ) ?? null
    );
  }

  /**
   * Rollback and manual orders (§5.2 step 7); plan drafts come from
   * confirmTakeoverPlan. A field the plan confirmation skipped leaves
   * takeover.skippedFields once an order for it exists.
   */
  async createChangeOrder(
    seed: XhsOpsChangeOrderSeed,
    options: { validate?: (current: XhsOpsStoreData) => void } = {},
  ): Promise<XhsOpsChangeOrder> {
    return this.mutate((current) => {
      options.validate?.(current);
      const index = current.accounts.findIndex(
        (entry) => entry.id === seed.accountId,
      );
      const account = current.accounts[index];
      if (!account || account.projectId !== seed.projectId)
        throw new XhsOpsError(404, "账号不存在或不属于该项目");
      const now = this.now();
      const order = xhsOpsChangeOrderSchema.parse({
        ...seed,
        id: this.genId(),
        createdAt: now,
        updatedAt: now,
      });
      let accounts = current.accounts;
      const skipped = account.takeover?.skippedFields ?? [];
      const kept = skipped.filter(
        (entry) => !order.fields.some((field) => field.field === entry.field),
      );
      if (account.takeover && kept.length !== skipped.length) {
        accounts = [...current.accounts];
        accounts[index] = {
          ...account,
          takeover: { ...account.takeover, skippedFields: kept },
          updatedAt: this.nextUpdatedAt(account.updatedAt),
        };
      }
      return {
        data: {
          ...current,
          accounts,
          changeOrders: evictChangeOrders(
            [...current.changeOrders, order],
            now,
          ),
        },
        result: order,
      };
    });
  }

  /** Field-level update; transitions that move account pointers go through mutateTakeover. */
  async updateChangeOrder(
    orderId: string,
    updater: (current: XhsOpsChangeOrder) => XhsOpsChangeOrder,
    options: XhsOpsRecordUpdateOptions = {},
  ): Promise<XhsOpsChangeOrder | null> {
    return this.mutate((current) => {
      const index = current.changeOrders.findIndex(
        (order) => order.id === orderId,
      );
      const existing = current.changeOrders[index];
      if (!existing) return { data: current, result: null };
      if (
        options.expectedUpdatedAt &&
        options.expectedUpdatedAt !== existing.updatedAt
      )
        throw new XhsOpsError(409, "变更单已更新，请重新加载后再操作");
      const next = this.stamp(existing, {
        ...updater(existing),
        id: existing.id,
        accountId: existing.accountId,
        projectId: existing.projectId,
      });
      const changeOrders = [...current.changeOrders];
      changeOrders[index] = next;
      return { data: { ...current, changeOrders }, result: next };
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
