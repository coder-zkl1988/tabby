import { Switch } from "@/components/ui/switch";
import {
  XHS_OCCUPATION_GROUPS,
  XHS_OCCUPATION_OPTIONS,
  type XhsOpsDeviceBinding,
} from "@nexu/shared";
import { ChevronDown, ChevronUp, Plus, Trash2 } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import type { CustomComponentProps } from "../registry";
import { describeXhsOpsError, xhsOpsApi } from "./xhs-ops-api";
import {
  type XhsOpsAccount,
  type XhsOpsBrowseDefaults,
  type XhsOpsInteractionConfig,
  type XhsOpsInteractionRule,
  type XhsOpsInterestPool,
  type XhsOpsPersona,
  type XhsOpsPersonaSuggestion,
  type XhsOpsPersonaTags,
  type XhsOpsProject,
  asString,
  defaultBrowseDefaults,
  defaultInteractionConfig,
  emptyInterestPool,
  emptyPersona,
  emptyPersonaTags,
  findPersonaOverlaps,
  normalizeBrowseDefaults,
  normalizeInteractionConfig,
  normalizeInterestPool,
  normalizePersona,
  normalizePersonaTags,
  personaArchiveIssues,
  personaDistributionSummary,
  personaSummary,
} from "./xhs-ops-types";
import {
  CardShell,
  ChipInput,
  DEVICE_STATE_LABEL,
  ErrorLine,
  Field,
  HintLine,
  NumberInput,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  type XhsOpsDevice,
  deviceDisplayName,
  deviceOnlineState,
  formatClock,
  inputClass,
  readProp,
  selectClass,
  useXhsOpsDevices,
} from "./xhs-ops-ui";

type Suggestion = XhsOpsPersonaSuggestion;

interface AccountRow {
  /** Stable local key (server id is null until the first save). */
  key: string;
  id: string | null;
  entryMode: "new" | "existing";
  label: string;
  positioning: string;
  persona: XhsOpsPersona;
  personaTags: XhsOpsPersonaTags;
  personaReviewedAt: string | null;
  updatedAt: string | null;
  deviceId: string;
  interestPool: XhsOpsInterestPool;
  interaction: XhsOpsInteractionConfig;
  browseDefaults: XhsOpsBrowseDefaults;
  expanded: boolean;
  error: string | null;
  savedAt: number | null;
  dirty: boolean;
}

let rowSeq = 0;
function nextKey(): string {
  rowSeq += 1;
  return `row-${Date.now()}-${rowSeq}`;
}

function normalizeSuggestions(raw: unknown): Suggestion[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const s =
        item && typeof item === "object"
          ? (item as Record<string, unknown>)
          : {};
      return {
        label: asString(s.label).trim().slice(0, 40),
        positioning: asString(s.positioning).trim(),
        persona: normalizePersona(s.persona),
        personaTags: normalizePersonaTags(s.personaTags),
        interestPool: normalizeInterestPool(s.interestPool),
      };
    })
    .filter((s) => s.label.length > 0);
}

function rowFromAccount(account: XhsOpsAccount): AccountRow {
  return {
    key: `acct-${account.id}`,
    id: account.id,
    entryMode: account.entryMode ?? "new",
    label: account.label ?? "",
    positioning: account.positioning ?? "",
    persona: normalizePersona(account.persona),
    personaTags: normalizePersonaTags(account.personaTags),
    personaReviewedAt: account.personaReviewedAt ?? null,
    updatedAt: account.updatedAt,
    deviceId: account.deviceId ?? "",
    interestPool: normalizeInterestPool(account.interestPool),
    interaction: normalizeInteractionConfig(account.interaction),
    browseDefaults: normalizeBrowseDefaults(account.browseDefaults),
    expanded: false,
    error: null,
    savedAt: null,
    dirty: false,
  };
}

function rowFromSuggestion(s: Suggestion): AccountRow {
  return {
    key: nextKey(),
    id: null,
    entryMode: "new",
    label: s.label,
    positioning: s.positioning,
    persona: s.persona,
    personaTags: s.personaTags,
    personaReviewedAt: null,
    updatedAt: null,
    deviceId: "",
    interestPool: s.interestPool,
    interaction: defaultInteractionConfig(),
    browseDefaults: defaultBrowseDefaults(),
    expanded: true,
    error: null,
    savedAt: null,
    dirty: true,
  };
}

function blankRow(): AccountRow {
  return rowFromSuggestion({
    label: "",
    positioning: "",
    persona: emptyPersona(),
    personaTags: emptyPersonaTags(),
    interestPool: emptyInterestPool(),
  });
}

const RULE_LABEL: Record<"like" | "collect" | "follow", string> = {
  like: "点赞",
  collect: "收藏",
  follow: "关注",
};

/**
 * Step 3: per-account configuration. Lists the project's existing accounts
 * plus the agent's positioning suggestions (one-click add); each row edits
 * label / positioning / target phone / three-tier interest pool / interaction
 * caps / browse defaults. 「保存账号配置」POSTs new rows and PATCHes existing
 * ones, then reports `xhs_ops_accounts_saved`.
 */
export function XhsOpsAccountPlanner({
  comp,
  resolve,
  onAction,
}: CustomComponentProps) {
  const projectId = asString(readProp(comp, resolve, "projectId"));
  const rawSuggestions = readProp(comp, resolve, "suggestions");
  const suggestionsKey = JSON.stringify(rawSuggestions ?? []);
  const suggestions = useMemo(
    () => normalizeSuggestions(JSON.parse(suggestionsKey)),
    [suggestionsKey],
  );

  const { devices, error: devicesError } = useXhsOpsDevices();

  const [rows, setRows] = useState<AccountRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [reportedAt, setReportedAt] = useState<number | null>(null);
  const [accountsReload, setAccountsReload] = useState(0);
  const [bindings, setBindings] = useState<XhsOpsDeviceBinding[]>([]);
  const [bindingsLoading, setBindingsLoading] = useState(true);
  const [bindingsError, setBindingsError] = useState<string | null>(null);
  const [bindingsReload, setBindingsReload] = useState(0);
  const [transferringKey, setTransferringKey] = useState<string | null>(null);
  const [project, setProject] = useState<XhsOpsProject | null>(null);
  const [projectError, setProjectError] = useState<string | null>(null);
  const [projectReload, setProjectReload] = useState(0);
  const [personaCount, setPersonaCount] = useState(10);
  const [generatedSuggestions, setGeneratedSuggestions] = useState<
    Suggestion[] | null
  >(null);
  const [generatedDistribution, setGeneratedDistribution] = useState("");
  const [generating, setGenerating] = useState(false);
  const [distributionReviewed, setDistributionReviewed] = useState(false);
  const [reviewNote, setReviewNote] = useState("");
  const [selectedKeys, setSelectedKeys] = useState<Set<string>>(
    () => new Set(),
  );

  useEffect(() => {
    void accountsReload;
    if (!projectId) {
      setLoading(false);
      setLoadError("缺少 projectId，无法加载账号");
      return;
    }
    let cancelled = false;
    setRows([]);
    setSelectedKeys(new Set());
    setDistributionReviewed(false);
    setReviewNote("");
    setGeneratedSuggestions(null);
    setGeneratedDistribution("");
    setLoading(true);
    setLoadError(null);
    setReportedAt(null);
    xhsOpsApi
      .listAccounts(projectId)
      .then((accounts) => {
        if (cancelled) return;
        setRows(accounts.map(rowFromAccount));
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setLoadError(describeXhsOpsError(err, "账号列表加载失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, accountsReload]);

  useEffect(() => {
    void bindingsReload;
    let cancelled = false;
    setBindingsLoading(true);
    setBindingsError(null);
    xhsOpsApi
      .listDeviceBindings()
      .then((nextBindings) => {
        if (cancelled) return;
        setBindings(nextBindings);
      })
      .catch((err) => {
        if (cancelled) return;
        setBindings([]);
        setBindingsError(describeXhsOpsError(err, "设备绑定信息加载失败"));
      })
      .finally(() => {
        if (!cancelled) setBindingsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [bindingsReload]);

  useEffect(() => {
    void projectReload;
    if (!projectId) return;
    let cancelled = false;
    setProjectError(null);
    xhsOpsApi
      .getProject(projectId)
      .then((next) => {
        if (cancelled) return;
        setProject(next);
        setPersonaCount(next.personaCount ?? 10);
      })
      .catch((err) => {
        if (cancelled) return;
        setProject(null);
        setProjectError(describeXhsOpsError(err, "项目画像加载失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, projectReload]);

  const patchRow = (key: string, patch: Partial<AccountRow>) =>
    setRows((prev) =>
      prev.map((r) => (r.key === key ? { ...r, ...patch } : r)),
    );

  const editRow = (key: string, patch: Partial<AccountRow>) => {
    const changesPersona =
      "label" in patch ||
      "positioning" in patch ||
      "persona" in patch ||
      "personaTags" in patch ||
      "entryMode" in patch;
    patchRow(key, {
      ...patch,
      ...(changesPersona ? { personaReviewedAt: null } : {}),
      error: null,
      savedAt: null,
      dirty: true,
    });
    setReportedAt(null);
    setFormError(null);
  };

  const addSuggestion = (s: Suggestion) => {
    const row = rowFromSuggestion(s);
    setRows((prev) => [...prev, row]);
    setSelectedKeys((prev) => new Set(prev).add(row.key));
    setReportedAt(null);
    setFormError(null);
  };

  const addedLabels = new Set(rows.map((r) => r.label.trim()));
  const activeSuggestions = generatedSuggestions ?? suggestions;
  const pendingSuggestions = activeSuggestions.filter(
    (s) => !addedLabels.has(s.label),
  );

  const removeRow = async (row: AccountRow) => {
    if (row.id === null) {
      setRows((prev) => prev.filter((r) => r.key !== row.key));
      setReportedAt(null);
      setFormError(null);
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(`删除账号「${row.label || row.id}」及其运行记录？`)
    ) {
      return;
    }
    try {
      await xhsOpsApi.deleteAccount(row.id);
      setRows((prev) => prev.filter((r) => r.key !== row.key));
      setReportedAt(null);
      setFormError(null);
      setBindingsReload((value) => value + 1);
    } catch (err) {
      patchRow(row.key, { error: describeXhsOpsError(err, "删除失败") });
    }
  };

  const deviceById = new Map(devices.map((d) => [d.deviceId, d]));
  const bindingByDeviceId = new Map(bindings.map((b) => [b.deviceId, b]));
  // P1-3 人设差异检查：两两比对，告警只提示不阻断，随保存动作一并回传给 agent。
  const overlapWarnings = useMemo(
    () =>
      findPersonaOverlaps(
        rows.map((r) => ({
          key: r.key,
          label: r.label,
          persona: r.persona,
          personaTags: r.personaTags,
          interestPool: r.interestPool,
        })),
      ),
    [rows],
  );
  const overlapCount = overlapWarnings.size;
  const archiveIssueCount = rows.filter(
    (row) =>
      personaArchiveIssues({
        persona: row.persona,
        personaTags: row.personaTags,
      }).length > 0,
  ).length;
  const selectedRows = rows.filter((row) => selectedKeys.has(row.key));
  const actualDistribution = personaDistributionSummary(
    selectedRows.length > 0 ? selectedRows : rows,
  );

  const generatePersonas = async () => {
    if (!projectId || !project) {
      setFormError("项目画像尚未加载，无法生成人设");
      return;
    }
    if (!project.profile?.confirmedAt) {
      setFormError("请先人工确认目标用户画像，再批量生成人设");
      return;
    }
    setGenerating(true);
    setFormError(null);
    try {
      const result = await xhsOpsApi.generatePersonas(projectId, {
        count: personaCount,
        expectedUpdatedAt: project.updatedAt,
      });
      setProject(result.project);
      setPersonaCount(result.project.personaCount);
      setGeneratedSuggestions(result.suggestions);
      setGeneratedDistribution(result.distribution);
      setDistributionReviewed(false);
      setReviewNote("");
    } catch (err) {
      setFormError(describeXhsOpsError(err, "人设生成失败"));
      setProjectReload((value) => value + 1);
    } finally {
      setGenerating(false);
    }
  };

  const saveAll = async () => {
    if (!projectId) {
      setFormError("缺少 projectId，无法保存");
      return;
    }
    if (rows.length === 0) {
      setFormError("请先添加至少一个账号");
      return;
    }
    const deviceOwners = new Map<string, AccountRow[]>();
    for (const row of rows) {
      if (!row.deviceId) continue;
      const owners = deviceOwners.get(row.deviceId) ?? [];
      owners.push(row);
      deviceOwners.set(row.deviceId, owners);
    }
    const duplicateRows = [...deviceOwners.values()].filter(
      (owners) => owners.length > 1,
    );
    if (duplicateRows.length > 0) {
      for (const owners of duplicateRows) {
        for (const row of owners) {
          patchRow(row.key, { error: "该设备已绑定到同项目的其他账号" });
        }
      }
      setFormError("同一台设备只能绑定一个账号，请调整重复绑定后再保存");
      return;
    }
    setSaving(true);
    setFormError(null);
    const saved: Array<{
      id: string;
      label: string;
      deviceId: string | null;
      deviceName: string | null;
      warnings: string[];
    }> = [];
    let failed = 0;

    for (const row of rows) {
      const label = row.label.trim();
      if (!label) {
        patchRow(row.key, { error: "请填写账号定位名" });
        failed += 1;
        continue;
      }
      if (
        row.interaction.follow.enabled &&
        (row.interaction.follow.targetTypes ?? []).length === 0
      ) {
        patchRow(row.key, {
          error: "开启关注时，请填写允许关注的目标账号类型",
        });
        failed += 1;
        continue;
      }
      if (row.deviceId && bindingsError) {
        patchRow(row.key, {
          error: "设备绑定信息不可用，请重试加载后再保存绑定设备的账号",
        });
        failed += 1;
        continue;
      }
      const existingBinding = row.deviceId
        ? bindingByDeviceId.get(row.deviceId)
        : undefined;
      if (existingBinding && existingBinding.accountId !== row.id) {
        patchRow(row.key, {
          error: `设备已绑定至「${existingBinding.projectName} / ${existingBinding.accountLabel}」，请先使用下方转移按钮`,
        });
        failed += 1;
        continue;
      }
      const device = row.deviceId ? deviceById.get(row.deviceId) : undefined;
      const deviceName = device ? deviceDisplayName(device) : null;
      const body = {
        entryMode: row.entryMode,
        label: label.slice(0, 40),
        positioning: row.positioning.trim(),
        persona: row.persona,
        personaTags: row.personaTags,
        deviceId: row.deviceId || null,
        deviceName: row.deviceId ? deviceName : null,
        interestPool: row.interestPool,
        // 评论开关按运营设置保存；发出仍需逐条人工批准（P3-1）
        interaction: row.interaction,
        browseDefaults: row.browseDefaults,
      };
      try {
        const account = row.id
          ? await xhsOpsApi.updateAccount(row.id, {
              ...body,
              expectedUpdatedAt: row.updatedAt ?? undefined,
            })
          : await xhsOpsApi.createAccount(projectId, { projectId, ...body });
        patchRow(row.key, {
          id: account.id,
          error: null,
          savedAt: Date.now(),
          updatedAt: account.updatedAt,
          personaReviewedAt: account.personaReviewedAt ?? null,
          dirty: false,
        });
        saved.push({
          id: account.id,
          label: account.label,
          deviceId: account.deviceId ?? null,
          deviceName: account.deviceName ?? null,
          warnings: overlapWarnings.get(row.key) ?? [],
        });
      } catch (err) {
        patchRow(row.key, { error: describeXhsOpsError(err, "保存失败") });
        failed += 1;
      }
    }

    if (saved.length > 0) {
      setBindingsReload((value) => value + 1);
    }
    setSaving(false);
    if (failed > 0) {
      setFormError(
        `${failed} 个账号保存失败，请修正后再点「保存账号配置」（已保存的账号会按更新处理）`,
      );
      return;
    }
    setReportedAt(Date.now());
    const overlapReport = saved
      .filter((a) => a.warnings.length > 0)
      .map((a) => ({ id: a.id, label: a.label, warnings: a.warnings }));
    onAction?.("xhs_ops_accounts_saved", {
      projectId,
      accounts: saved,
      overlapWarnings: overlapReport,
      agentInstruction:
        overlapReport.length > 0
          ? "部分人设相似度过高（见 overlapWarnings）。请指出哪些账号相似、建议如何拉开差异，并询问是否对这些账号重新生成人设；不要自动改动已保存账号。"
          : saved.some(
                (account) =>
                  rows.find((row) => row.id === account.id)?.entryMode ===
                  "existing",
              )
            ? "已有账号已保存并绑定手机。请直接渲染 XhsOpsProfileMaterial，先读取手机账号和现有资料，生成并人工确认优化方案；不要执行登录、退出或切换账号。"
            : "账号草稿已保存，仍需运营在卡片中勾选目标分布并确认人设；收到 xhs_ops_personas_confirmed 前不要进入素材或养号。",
    });
  };

  const confirmSelectedPersonas = async () => {
    if (!projectId || !project) {
      setFormError("项目画像尚未加载，无法确认人设");
      return;
    }
    const selected = rows.filter((row) => selectedKeys.has(row.key));
    if (selected.length === 0) {
      setFormError("请至少选择一个要进入素材阶段的人设");
      return;
    }
    const existingSelected = selected.filter(
      (row) => row.entryMode === "existing",
    );
    if (
      existingSelected.length > 0 &&
      existingSelected.length === selected.length
    ) {
      if (
        selected.some(
          (row) => row.dirty || !row.id || !row.updatedAt || !row.deviceId,
        )
      ) {
        setFormError("请先保存已有账号并绑定手机，再进入优化");
        return;
      }
      onAction?.("xhs_ops_existing_accounts_selected", {
        projectId,
        accountIds: selected.map((row) => row.id as string),
        agentInstruction:
          "已有账号已绑定手机。直接渲染 XhsOpsProfileMaterial：先读取手机账号身份和现有资料，再生成人工确认的优化方案；禁止登录、退出或切换账号。资料核验通过后再渲染养号计划。",
      });
      return;
    }
    const invalid = selected.filter(
      (row) =>
        row.entryMode !== "existing" &&
        personaArchiveIssues({
          persona: row.persona,
          personaTags: row.personaTags,
        }).length > 0,
    );
    if (invalid.length > 0) {
      setFormError("选定人设的人口学字段和档案标签尚未补全");
      return;
    }
    if (selected.some((row) => row.dirty || !row.id || !row.updatedAt)) {
      setFormError("请先保存选定人设的最新草稿，再进行人工确认");
      return;
    }
    if (!distributionReviewed) {
      setFormError("请先核对目标画像与实际分布");
      return;
    }
    const note = reviewNote.trim();
    if (!note) {
      setFormError("请填写本次人设与分布复核说明");
      return;
    }
    setSaving(true);
    setFormError(null);
    try {
      const confirmed = await xhsOpsApi.confirmPersonas(projectId, {
        accounts: selected.map((row) => ({
          accountId: row.id as string,
          expectedUpdatedAt: row.updatedAt as string,
        })),
        expectedUpdatedAt: project.updatedAt,
        distributionReviewed: true,
        reviewNote: note,
      });
      const byId = new Map(confirmed.map((account) => [account.id, account]));
      setRows((current) =>
        current.map((row) => {
          const account = row.id ? byId.get(row.id) : undefined;
          return account
            ? {
                ...row,
                personaReviewedAt: account.personaReviewedAt,
                updatedAt: account.updatedAt,
                dirty: false,
              }
            : row;
        }),
      );
      onAction?.("xhs_ops_personas_confirmed", {
        projectId,
        accountIds: confirmed.map((account) => account.id),
        reviewNote: note,
        agentInstruction:
          "选定人设已由运营确认。下一步渲染 XhsOpsProfileMaterial；不要自动应用公开资料或启动养号。",
      });
    } catch (err) {
      setFormError(describeXhsOpsError(err, "人设确认失败"));
      setProjectReload((value) => value + 1);
      setAccountsReload((value) => value + 1);
    } finally {
      setSaving(false);
    }
  };

  const transferSelectedDevice = async (
    row: AccountRow,
    binding: XhsOpsDeviceBinding,
  ) => {
    const label = row.label.trim();
    if (!label) {
      patchRow(row.key, { error: "请先填写账号定位名" });
      return;
    }
    if (!binding.canTransfer) {
      patchRow(row.key, {
        error: binding.blockingReason ?? "该设备当前无法转移",
      });
      return;
    }
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `将设备从「${binding.projectName} / ${binding.accountLabel}」转移到当前账号「${label}」？旧账号及历史记录会保留，但旧账号将解除设备绑定。`,
      )
    ) {
      return;
    }
    const device = deviceById.get(row.deviceId);
    setTransferringKey(row.key);
    patchRow(row.key, { error: null });
    try {
      const account = await xhsOpsApi.transferDevice(projectId, {
        fromAccountId: binding.accountId,
        ...(row.id ? { toAccountId: row.id } : {}),
        account: {
          entryMode: row.entryMode,
          label: label.slice(0, 40),
          positioning: row.positioning.trim(),
          persona: row.persona,
          personaTags: row.personaTags,
          deviceId: row.deviceId,
          deviceName: device ? deviceDisplayName(device) : null,
          interestPool: row.interestPool,
          interaction: row.interaction,
          browseDefaults: row.browseDefaults,
        },
      });
      patchRow(row.key, {
        id: account.id,
        error: null,
        savedAt: Date.now(),
        updatedAt: account.updatedAt,
        personaReviewedAt: account.personaReviewedAt ?? null,
        dirty: false,
      });
      setReportedAt(null);
      setFormError(null);
      setBindingsReload((value) => value + 1);
    } catch (err) {
      patchRow(row.key, {
        error: describeXhsOpsError(err, "设备转移失败"),
      });
      setBindingsReload((value) => value + 1);
    } finally {
      setTransferringKey(null);
    }
  };

  const disabled =
    saving ||
    loading ||
    bindingsLoading ||
    Boolean(loadError) ||
    transferringKey !== null;
  const missingDeviceCount = rows.filter((r) => !r.deviceId).length;

  return (
    <CardShell
      testId="account-planner"
      title={`账号配置 · ${rows.length} 个账号`}
      subtitle="账号定位只描述内容方向与风格；每个账号绑定一台手机执行浏览任务"
      actions={
        <SecondaryButton
          onClick={() => {
            setRows((prev) => [...prev, blankRow()]);
            setReportedAt(null);
            setFormError(null);
          }}
          disabled={disabled}
        >
          <Plus size={12} /> 新增账号
        </SecondaryButton>
      }
      footer={
        <>
          <div className="min-w-0 text-[12px] text-text-secondary">
            {reportedAt
              ? `草稿已保存 ${formatClock(reportedAt)} · 人工确认后进入素材阶段`
              : missingDeviceCount > 0
                ? `${missingDeviceCount} 个账号未绑定设备，未绑定的账号无法执行任务`
                : "保存草稿不会解锁素材或养号"}
          </div>
          <SecondaryButton onClick={() => void saveAll()} disabled={disabled}>
            {saving ? "保存中…" : "保存账号配置"}
          </SecondaryButton>
          <PrimaryButton
            onClick={() => void confirmSelectedPersonas()}
            disabled={
              disabled ||
              generating ||
              rows.length === 0 ||
              selectedRows.length === 0
            }
          >
            {selectedRows.length > 0 &&
            selectedRows.every((row) => row.entryMode === "existing")
              ? "进入已有账号优化"
              : "确认选定人设，进入素材"}
          </PrimaryButton>
        </>
      }
    >
      {loading ? <HintLine>正在加载已有账号…</HintLine> : null}
      <ErrorLine message={loadError} />
      {loadError ? (
        <SecondaryButton
          onClick={() => setAccountsReload((value) => value + 1)}
        >
          重新加载账号
        </SecondaryButton>
      ) : null}
      <ErrorLine message={formError} />
      <ErrorLine message={projectError} />
      {projectError ? (
        <SecondaryButton onClick={() => setProjectReload((value) => value + 1)}>
          重新加载项目画像
        </SecondaryButton>
      ) : null}
      <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
        <div className="flex flex-wrap items-end gap-2">
          <Field label="批量生成人设数量（1–30）">
            <NumberInput
              value={personaCount}
              min={1}
              max={30}
              disabled={disabled || generating || !project}
              ariaLabel="批量生成人设数量"
              onChange={setPersonaCount}
            />
          </Field>
          <PrimaryButton
            onClick={() => void generatePersonas()}
            disabled={disabled || generating || !project}
          >
            {generating
              ? "生成中…"
              : generatedSuggestions
                ? "按此数量重新生成"
                : "批量生成人设"}
          </PrimaryButton>
        </div>
        <HintLine>
          生成只产生候选，不会创建账号；默认 10 个，可按项目需要调整。
        </HintLine>
      </div>
      {devicesError ? <HintLine>{devicesError}</HintLine> : null}
      <div className="flex items-center justify-between gap-2">
        {bindingsLoading ? <HintLine>正在加载设备绑定信息…</HintLine> : null}
        <div className="ml-auto">
          <SecondaryButton
            disabled={bindingsLoading || transferringKey !== null}
            onClick={() => setBindingsReload((value) => value + 1)}
          >
            {bindingsLoading ? "刷新中…" : "刷新设备绑定"}
          </SecondaryButton>
        </div>
      </div>
      {bindingsError ? (
        <div className="rounded-md border border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-ink)]/[6%] px-2.5 py-1.5 text-[12px] text-[var(--color-warning-ink)]">
          <span>{bindingsError}，绑定设备的账号暂不能保存</span>
        </div>
      ) : null}

      {pendingSuggestions.length > 0 ? (
        <div className="flex flex-col gap-1.5 rounded-lg border border-dashed border-border p-2.5">
          <div className="flex items-center justify-between gap-2">
            <SectionTitle hint="点「加入」变成可编辑的账号行">
              AI 建议的账号定位
            </SectionTitle>
            <SecondaryButton
              onClick={() => {
                for (const s of pendingSuggestions) addSuggestion(s);
              }}
              disabled={disabled}
            >
              全部加入
            </SecondaryButton>
          </div>
          {pendingSuggestions.map((s) => (
            <div key={s.label} className="flex items-center gap-2 text-[12px]">
              <div className="min-w-0 flex-1">
                <span className="font-medium">{s.label}</span>
                {personaSummary(s.persona) ? (
                  <span className="ml-1.5 text-text-secondary">
                    {personaSummary(s.persona)}
                  </span>
                ) : null}
                {s.positioning ? (
                  <span className="ml-1.5 text-text-secondary">
                    {s.positioning}
                  </span>
                ) : null}
              </div>
              <SecondaryButton
                onClick={() => addSuggestion(s)}
                disabled={disabled}
              >
                加入
              </SecondaryButton>
            </div>
          ))}
        </div>
      ) : null}

      {rows.length === 0 && !loading ? (
        <HintLine>还没有账号。加入 AI 建议或点「新增账号」。</HintLine>
      ) : null}
      {overlapCount > 0 ? (
        <HintLine>
          {overlapCount} 个账号存在人设相似告警（不影响保存；保存后 AI
          会给出拉开差异的建议）。
        </HintLine>
      ) : null}
      {archiveIssueCount > 0 ? (
        <HintLine>
          {archiveIssueCount}{" "}
          个账号的人口学字段或档案标签待补全；草稿可保存，不能人工确认。
        </HintLine>
      ) : null}

      {rows.length > 0 ? (
        <div className="flex flex-col gap-2 rounded-md border border-border p-2.5 text-[12px]">
          <SectionTitle hint="对照已确认画像，人工核对选定账号的整体年龄、性别和地区分布">
            目标与实际分布复核
          </SectionTitle>
          <div className="text-text-secondary">
            目标：年龄 {project?.profile?.base.ageRange || "未填写"} · 性别{" "}
            {project?.profile?.base.genderRatio || "未填写"} · 地区{" "}
            {project?.profile?.base.regions.join("、") || "未填写"}
          </div>
          {generatedDistribution ? (
            <div className="text-text-secondary">
              生成服务汇总：{generatedDistribution}
            </div>
          ) : null}
          <div className="text-text-secondary">
            {selectedRows.length > 0
              ? `已选 ${selectedRows.length} 个`
              : "尚未选择，预览全部账号"}
            ：{actualDistribution}
          </div>
          <label className="flex items-start gap-2 text-text-primary">
            <input
              type="checkbox"
              checked={distributionReviewed}
              disabled={disabled}
              onChange={(event) =>
                setDistributionReviewed(event.target.checked)
              }
            />
            <span>我已核对选定人设的差异及整体分布符合目标画像</span>
          </label>
          <Field label="复核说明 *">
            <textarea
              className={inputClass}
              value={reviewNote}
              maxLength={1000}
              disabled={disabled}
              aria-label="人设分布复核说明"
              placeholder="如：选定10个账号，女性7、男性3，年龄和地区覆盖符合目标"
              onChange={(event) => setReviewNote(event.target.value)}
            />
          </Field>
        </div>
      ) : null}

      <div className="flex flex-col gap-2">
        {rows.map((row) => (
          <AccountRowEditor
            key={row.key}
            row={row}
            devices={devices}
            disabled={disabled}
            unavailableDeviceIds={
              new Set(
                rows
                  .filter((other) => other.key !== row.key)
                  .map((other) => other.deviceId)
                  .filter(Boolean),
              )
            }
            selectedBinding={
              row.deviceId ? bindingByDeviceId.get(row.deviceId) : undefined
            }
            bindingByDeviceId={bindingByDeviceId}
            transferring={transferringKey === row.key}
            selectedForReview={selectedKeys.has(row.key)}
            onSelectedForReview={(selected) =>
              setSelectedKeys((current) => {
                const next = new Set(current);
                if (selected) next.add(row.key);
                else next.delete(row.key);
                return next;
              })
            }
            onPatch={(patch) => editRow(row.key, patch)}
            onRemove={() => void removeRow(row)}
            onTransfer={(binding) => void transferSelectedDevice(row, binding)}
            warnings={overlapWarnings.get(row.key) ?? []}
          />
        ))}
      </div>
    </CardShell>
  );
}

function AccountRowEditor({
  row,
  devices,
  disabled,
  unavailableDeviceIds,
  selectedBinding,
  bindingByDeviceId,
  transferring,
  selectedForReview,
  onSelectedForReview,
  onPatch,
  onRemove,
  onTransfer,
  warnings,
}: {
  row: AccountRow;
  devices: XhsOpsDevice[];
  disabled: boolean;
  unavailableDeviceIds: Set<string>;
  selectedBinding: XhsOpsDeviceBinding | undefined;
  bindingByDeviceId: Map<string, XhsOpsDeviceBinding>;
  transferring: boolean;
  selectedForReview: boolean;
  onSelectedForReview: (selected: boolean) => void;
  onPatch: (patch: Partial<AccountRow>) => void;
  onRemove: () => void;
  onTransfer: (binding: XhsOpsDeviceBinding) => void;
  warnings: string[];
}) {
  const sortedDevices = [...devices].sort((a, b) => {
    const order: Record<string, number> = { online: 0, busy: 1, offline: 2 };
    return (
      (order[deviceOnlineState(a)] ?? 3) - (order[deviceOnlineState(b)] ?? 3)
    );
  });
  const selectedKnown = devices.some((d) => d.deviceId === row.deviceId);
  const selected = devices.find((d) => d.deviceId === row.deviceId);

  const patchRule = (
    name: "like" | "collect" | "follow",
    patch: Partial<XhsOpsInteractionRule>,
  ) =>
    onPatch({
      interaction: {
        ...row.interaction,
        [name]: { ...row.interaction[name], ...patch },
      },
    });

  const patchBrowse = (patch: Partial<XhsOpsBrowseDefaults>) =>
    onPatch({ browseDefaults: { ...row.browseDefaults, ...patch } });

  const patchPool = (patch: Partial<XhsOpsInterestPool>) =>
    onPatch({ interestPool: { ...row.interestPool, ...patch } });
  const patchPersona = (patch: Partial<XhsOpsPersona>) =>
    onPatch({ persona: { ...row.persona, ...patch } });
  const PERSONA_FIELDS: Array<[keyof XhsOpsPersona, string, string]> = [
    ["age", "年龄", "32岁"],
    ["gender", "性别", "女"],
    ["region", "地区", "北京海淀"],
    ["occupation", "职业/身份", "互联网产品经理"],
    ["lifeStatus", "生活状态", "2岁娃新手妈妈"],
  ];

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-0/40 p-2.5">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(130px,0.8fr)_minmax(0,1fr)_minmax(0,1.4fr)_minmax(120px,0.9fr)_auto] sm:items-end">
        <Field label="账号模式">
          <select
            className={selectClass}
            value={row.entryMode}
            disabled={disabled}
            onChange={(event) =>
              onPatch({
                entryMode: event.target.value as AccountRow["entryMode"],
              })
            }
          >
            <option value="new">新建账号</option>
            <option value="existing">已有账号优化</option>
          </select>
        </Field>
        <Field label="账号定位名 *">
          <input
            className={inputClass}
            value={row.label}
            maxLength={40}
            disabled={disabled}
            placeholder="如：北京亲子周末号"
            onChange={(e) => onPatch({ label: e.target.value })}
          />
        </Field>
        <Field label="内容方向与风格">
          <input
            className={inputClass}
            value={row.positioning}
            disabled={disabled}
            placeholder="一句话，如：周末亲子酒店实测，轻松口语风"
            onChange={(e) => onPatch({ positioning: e.target.value })}
          />
        </Field>
        <Field label="执行设备">
          <select
            className={selectClass}
            value={
              selectedKnown ? row.deviceId : row.deviceId ? "__unknown" : ""
            }
            disabled={disabled}
            onChange={(e) => {
              const value = e.target.value;
              if (value === "__unknown") return;
              onPatch({ deviceId: value });
            }}
          >
            <option value="">未绑定</option>
            {!selectedKnown && row.deviceId ? (
              <option value="__unknown">{row.deviceId}（未连接）</option>
            ) : null}
            {sortedDevices.map((d) => (
              <DeviceOption
                key={d.deviceId}
                device={d}
                row={row}
                unavailable={
                  d.deviceId !== row.deviceId &&
                  unavailableDeviceIds.has(d.deviceId)
                }
                binding={bindingByDeviceId.get(d.deviceId)}
              />
            ))}
          </select>
        </Field>
        <div className="flex items-center gap-1 pb-0.5">
          <button
            type="button"
            aria-label={row.expanded ? "收起详细配置" : "展开详细配置"}
            className="grid h-7 w-7 place-items-center rounded-md border border-border text-text-secondary hover:bg-surface-2"
            onClick={() => onPatch({ expanded: !row.expanded })}
          >
            {row.expanded ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
          </button>
          <button
            type="button"
            aria-label="删除账号"
            className="grid h-7 w-7 place-items-center rounded-md border border-border text-text-secondary hover:bg-[var(--color-error-wash)] hover:text-[var(--color-error-ink)]"
            disabled={disabled}
            onClick={onRemove}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-text-secondary">
        <span>
          {row.entryMode === "existing" ? "已有账号优化" : "新建账号"}
        </span>
        <label className="flex items-center gap-1 text-text-primary">
          <input
            type="checkbox"
            checked={selectedForReview}
            disabled={disabled}
            aria-label={`选择人设 ${row.label || "未命名账号"}`}
            onChange={(event) => onSelectedForReview(event.target.checked)}
          />
          选入本批确认
        </label>
        <span>
          {row.personaReviewedAt ? "已人工确认" : "待人工确认 / 复核"}
        </span>
        <span>
          兴趣池 核心 {row.interestPool.core.length} · 相邻{" "}
          {row.interestPool.extended.length} · 泛{" "}
          {row.interestPool.general.length}
        </span>
        <span>
          互动{" "}
          {(["like", "collect", "follow"] as const)
            .filter((k) => row.interaction[k].enabled)
            .map((k) => `${RULE_LABEL[k]}≤${row.interaction[k].dailyCap}`)
            .join(" ") || "关闭"}
        </span>
        {selected ? (
          <span>设备 {DEVICE_STATE_LABEL[deviceOnlineState(selected)]}</span>
        ) : null}
        {row.savedAt ? <span>已保存 {formatClock(row.savedAt)}</span> : null}
      </div>
      {selectedBinding && selectedBinding.accountId !== row.id ? (
        <div
          data-testid="device-binding-conflict"
          className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-ink)]/[6%] px-2.5 py-2 text-[12px] text-[var(--color-warning-ink)]"
        >
          <span>
            当前设备已绑定「{selectedBinding.projectName} /{" "}
            {selectedBinding.accountLabel}」
            {selectedBinding.blockingReason
              ? `：${selectedBinding.blockingReason}`
              : ""}
          </span>
          <SecondaryButton
            disabled={disabled || transferring || !selectedBinding.canTransfer}
            onClick={() => onTransfer(selectedBinding)}
          >
            {transferring ? "转移中…" : "转移设备并保存此账号"}
          </SecondaryButton>
        </div>
      ) : null}
      {warnings.length > 0 ? (
        <div
          data-testid="persona-overlap"
          className="rounded-md border border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-ink)]/[6%] px-2.5 py-1.5 text-[12px] text-[var(--color-warning-ink)]"
        >
          人设相似：{warnings.join("；")}
        </div>
      ) : null}
      <ErrorLine message={row.error} />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
        {PERSONA_FIELDS.map(([key, label, placeholder]) => (
          <Field key={key} label={label}>
            {key === "occupation" ? (
              <select
                className={selectClass}
                value={row.persona[key]}
                disabled={disabled}
                onChange={(e) => patchPersona({ [key]: e.target.value })}
              >
                <option value="">请选择职业</option>
                {row.persona[key] &&
                !XHS_OCCUPATION_OPTIONS.includes(
                  row.persona[key] as (typeof XHS_OCCUPATION_OPTIONS)[number],
                ) ? (
                  <option value={row.persona[key]}>
                    {row.persona[key]}（历史值）
                  </option>
                ) : null}
                {XHS_OCCUPATION_GROUPS.map((group) => (
                  <optgroup key={group.category} label={group.category}>
                    {group.options.map((occupation) => (
                      <option key={occupation} value={occupation}>
                        {occupation}
                      </option>
                    ))}
                  </optgroup>
                ))}
              </select>
            ) : (
              <input
                className={inputClass}
                value={row.persona[key]}
                disabled={disabled}
                placeholder={placeholder}
                onChange={(e) => patchPersona({ [key]: e.target.value })}
              />
            )}
          </Field>
        ))}
      </div>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="垂直兴趣档案标签（1–2 个）">
          <ChipInput
            value={row.personaTags.vertical}
            disabled={disabled}
            placeholder="回车添加，如：羽毛球装备"
            ariaLabel="垂直兴趣档案标签"
            onChange={(vertical) =>
              onPatch({
                personaTags: { ...row.personaTags, vertical },
              })
            }
          />
        </Field>
        <Field label="泛兴趣档案标签（2–3 个）">
          <ChipInput
            value={row.personaTags.general}
            disabled={disabled}
            placeholder="回车添加，如：咖啡、城市漫游"
            ariaLabel="泛兴趣档案标签"
            onChange={(general) =>
              onPatch({ personaTags: { ...row.personaTags, general } })
            }
          />
        </Field>
      </div>
      {personaArchiveIssues({
        persona: row.persona,
        personaTags: row.personaTags,
      }).length > 0 ? (
        <HintLine>
          {personaArchiveIssues({
            persona: row.persona,
            personaTags: row.personaTags,
          }).join("；")}
        </HintLine>
      ) : null}
      {row.expanded ? (
        <div className="flex flex-col gap-3 border-t border-border pt-2">
          <div className="flex flex-col gap-1.5">
            <SectionTitle hint="长期任务兴趣池不限长度，与上方人设档案标签分别保存">
              三层兴趣池
            </SectionTitle>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <Field label="核心（core）">
                <ChipInput
                  value={row.interestPool.core}
                  disabled={disabled}
                  placeholder="回车添加"
                  onChange={(core) => patchPool({ core })}
                />
              </Field>
              <Field label="相邻（extended）">
                <ChipInput
                  value={row.interestPool.extended}
                  disabled={disabled}
                  placeholder="回车添加"
                  onChange={(extended) => patchPool({ extended })}
                />
              </Field>
              <Field label="泛兴趣（general）">
                <ChipInput
                  value={row.interestPool.general}
                  disabled={disabled}
                  placeholder="回车添加"
                  onChange={(general) => patchPool({ general })}
                />
              </Field>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <SectionTitle hint="每日上限为 0–50 次；比例为互动帖子占浏览数的百分比">
              互动配置
            </SectionTitle>
            <div className="flex flex-col gap-1.5">
              {(["like", "collect", "follow"] as const).map((name) => {
                const rule = row.interaction[name];
                return (
                  <div
                    key={name}
                    className="grid grid-cols-[48px_auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-[12px]"
                  >
                    <span>{RULE_LABEL[name]}</span>
                    <Switch
                      size="xs"
                      checked={rule.enabled}
                      disabled={disabled}
                      aria-label={`${RULE_LABEL[name]}开关`}
                      onCheckedChange={(enabled) =>
                        patchRule(name, { enabled })
                      }
                    />
                    <div className="flex items-center gap-1 text-[12px] text-text-secondary">
                      每日上限
                      <NumberInput
                        value={rule.dailyCap}
                        min={0}
                        max={50}
                        disabled={disabled || !rule.enabled}
                        ariaLabel={`${RULE_LABEL[name]}每日上限`}
                        className="w-16"
                        onChange={(dailyCap) => patchRule(name, { dailyCap })}
                      />
                    </div>
                    <div className="flex items-center gap-1 text-[12px] text-text-secondary">
                      比例 %
                      <NumberInput
                        value={rule.ratioPercent}
                        min={0}
                        max={100}
                        disabled={disabled || !rule.enabled}
                        ariaLabel={`${RULE_LABEL[name]}比例`}
                        className="w-16"
                        onChange={(ratioPercent) =>
                          patchRule(name, { ratioPercent })
                        }
                      />
                    </div>
                  </div>
                );
              })}
              {row.interaction.follow.enabled ? (
                <Field label="关注目标账号类型 *">
                  <ChipInput
                    value={row.interaction.follow.targetTypes ?? []}
                    disabled={disabled}
                    placeholder="回车添加，如：羽毛球教练、运动爱好者"
                    ariaLabel="关注目标账号类型"
                    onChange={(targetTypes) =>
                      patchRule("follow", { targetTypes })
                    }
                  />
                </Field>
              ) : null}
              <div className="grid grid-cols-[48px_auto_minmax(0,1fr)_minmax(0,1fr)] items-center gap-2 text-[12px]">
                <span>评论</span>
                <Switch
                  size="xs"
                  checked={row.interaction.comment.enabled}
                  disabled={disabled}
                  aria-label="评论开关"
                  onCheckedChange={(enabled) =>
                    onPatch({
                      interaction: {
                        ...row.interaction,
                        comment: { ...row.interaction.comment, enabled },
                      },
                    })
                  }
                />
                <div className="flex items-center gap-1 text-[12px] text-text-secondary">
                  <span>每日上限</span>
                  <NumberInput
                    value={row.interaction.comment.dailyCap}
                    min={0}
                    max={5}
                    disabled={disabled || !row.interaction.comment.enabled}
                    ariaLabel="评论每日上限"
                    className="w-16"
                    onChange={(dailyCap) =>
                      onPatch({
                        interaction: {
                          ...row.interaction,
                          comment: { ...row.interaction.comment, dailyCap },
                        },
                      })
                    }
                  />
                </div>
                <span className="text-[12px] text-text-secondary">
                  开启只表示允许进审核队列；每条评论仍需人工批准，每浏览 8
                  篇最多 1 条
                </span>
              </div>
              <div className="text-[12px] text-text-secondary">
                发布、私信、分享一律不做。
              </div>
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <SectionTitle hint="日目标 0 = 不设；分段 >1 时当日拆成几段串行执行（一期建议 30–50 篇/天观察）">
              浏览默认值
            </SectionTitle>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Field label="最短停留（秒）">
                <NumberInput
                  value={row.browseDefaults.dwellSecMin}
                  min={11}
                  max={60}
                  disabled={disabled}
                  onChange={(dwellSecMin) =>
                    patchBrowse({
                      dwellSecMin,
                      dwellSecMax: Math.max(
                        dwellSecMin,
                        row.browseDefaults.dwellSecMax,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="最长停留（秒）">
                <NumberInput
                  value={row.browseDefaults.dwellSecMax}
                  min={5}
                  max={120}
                  disabled={disabled}
                  onChange={(dwellSecMax) =>
                    patchBrowse({
                      dwellSecMax: Math.max(
                        dwellSecMax,
                        row.browseDefaults.dwellSecMin,
                      ),
                    })
                  }
                />
              </Field>
              <Field label="搜索占比 %">
                <NumberInput
                  value={row.browseDefaults.searchRatioPercent}
                  min={0}
                  max={100}
                  disabled={disabled}
                  onChange={(searchRatioPercent) =>
                    patchBrowse({ searchRatioPercent })
                  }
                />
              </Field>
              <Field label="每关键词篇数">
                <NumberInput
                  value={row.browseDefaults.postsPerKeyword}
                  min={1}
                  max={8}
                  disabled={disabled}
                  onChange={(postsPerKeyword) =>
                    patchBrowse({ postsPerKeyword })
                  }
                />
              </Field>
              <Field label="首页篇数">
                <NumberInput
                  value={row.browseDefaults.homeFeedCount}
                  min={0}
                  max={12}
                  disabled={disabled}
                  onChange={(homeFeedCount) => patchBrowse({ homeFeedCount })}
                />
              </Field>
              <Field label="日目标篇数（0=不设）">
                <NumberInput
                  value={row.browseDefaults.dailyTargetPosts}
                  min={0}
                  max={150}
                  disabled={disabled}
                  onChange={(dailyTargetPosts) =>
                    patchBrowse({ dailyTargetPosts })
                  }
                />
              </Field>
              <Field label="当日分段数（1=单次）">
                <NumberInput
                  value={row.browseDefaults.dailySegments}
                  min={1}
                  max={3}
                  disabled={disabled}
                  onChange={(dailySegments) => patchBrowse({ dailySegments })}
                />
              </Field>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function DeviceOption({
  device,
  row,
  unavailable,
  binding,
}: {
  device: XhsOpsDevice;
  row: AccountRow;
  unavailable: boolean;
  binding: XhsOpsDeviceBinding | undefined;
}) {
  const bindingLabel = binding
    ? binding.accountId === row.id
      ? " · 已绑定当前账号"
      : ` · 已绑定 ${binding.projectName} / ${binding.accountLabel}`
    : "";
  return (
    <option value={device.deviceId} disabled={unavailable}>
      {deviceDisplayName(device)} ·{" "}
      {DEVICE_STATE_LABEL[deviceOnlineState(device)]}
      {bindingLabel}
      {unavailable ? " · 已绑定其他账号（本卡片已选择）" : ""}
    </option>
  );
}
