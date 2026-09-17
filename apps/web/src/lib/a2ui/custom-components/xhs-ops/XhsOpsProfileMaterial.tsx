import { type ReactNode, useEffect, useState } from "react";
import { ZoomableImage } from "../../components/zoomable-image";
import type { CustomComponentProps } from "../registry";
import { describeXhsOpsError, xhsOpsApi } from "./xhs-ops-api";
import { ProjectPicker, useProjectResolution } from "./xhs-ops-project-picker";
import {
  XHS_PROFILE_CANDIDATES,
  XHS_PROFILE_FIELD_LABEL,
  type XhsOpsAccount,
  type XhsOpsAccountIdentity,
  type XhsOpsProfileDraft,
  type XhsOpsProfileDraftRequiredField,
  type XhsOpsProfileField,
  type XhsOpsProfilePart,
  type XhsOpsProfileReadback,
  asString,
  mediaFileUrl,
  normalizeProfileDraft,
  xhsOpsProfileCandidatePlan,
  xhsOpsProfileDraftMissingFields,
  xhsOpsProfileDraftReady,
} from "./xhs-ops-types";
import {
  CardShell,
  ConfirmDialog,
  EmptyState,
  ErrorLine,
  Field,
  HintLine,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  Skeleton,
  formatClock,
  inputClass,
  readProp,
  textareaClass,
} from "./xhs-ops-ui";

/**
 * Step 3b (P2-1): 账号基础资料与素材。昵称/简介由服务端文本生成，头像/背景各
 * 生成 3 张备选，运营点选并补齐性别、生日、地区和兴趣标签。手机操作先核对
 * 目标账号，再应用八项资料并独立只读验收。上报 `xhs_ops_profile_applied`。
 */
export function XhsOpsProfileMaterial({
  comp,
  resolve,
  onAction,
}: CustomComponentProps) {
  const propProjectId = asString(readProp(comp, resolve, "projectId"));
  const projectName = asString(readProp(comp, resolve, "projectName")).trim();
  const resolution = useProjectResolution(propProjectId, projectName);
  const projectId = resolution.projectId;
  const onlyAccountId = asString(readProp(comp, resolve, "accountId")) || null;

  return (
    <CardShell
      testId="profile-material"
      title="账号资料与素材"
      subtitle="确认目标账号与八项资料；手机应用并完成只读生效核验后才能开始养号"
    >
      <ErrorLine message={resolution.error} />
      {!projectId ? (
        <ProjectPicker
          resolution={resolution}
          wanted={projectName}
          purpose="生成资料"
        />
      ) : null}
      {projectId ? (
        <XhsOpsProfileMaterialContent
          projectId={projectId}
          accountIds={onlyAccountId ? [onlyAccountId] : undefined}
          onAction={onAction}
        />
      ) : null}
    </CardShell>
  );
}

export function XhsOpsProfileMaterialContent({
  projectId,
  accountIds,
  onAction,
  onAccountChange,
}: {
  projectId: string;
  accountIds?: string[];
  onAction?: CustomComponentProps["onAction"];
  onAccountChange?: (account: XhsOpsAccount) => void;
}) {
  const [accounts, setAccounts] = useState<XhsOpsAccount[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const accountIdsKey = accountIds?.join("\u0000") ?? "";

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    const wantedIds = accountIdsKey
      ? new Set(accountIdsKey.split("\u0000"))
      : null;
    xhsOpsApi
      .listAccounts(projectId)
      .then((list) => {
        if (cancelled) return;
        setAccounts(
          list.filter((account) =>
            wantedIds ? wantedIds.has(account.id) : true,
          ),
        );
        setLoadError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setAccounts([]);
        setLoadError(describeXhsOpsError(err, "账号列表加载失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, accountIdsKey]);

  const replaceAccount = (updated: XhsOpsAccount) => {
    setAccounts((prev) =>
      prev ? prev.map((a) => (a.id === updated.id ? updated : a)) : prev,
    );
    onAccountChange?.(updated);
  };

  return (
    <div className="flex flex-col gap-3">
      <ErrorLine message={loadError} />
      {accounts === null ? <Skeleton rows={2} label="正在加载账号" /> : null}
      {accounts && accounts.length === 0 && !loadError ? (
        <EmptyState>暂无可生成资料的账号；先在账号配置里创建账号。</EmptyState>
      ) : null}
      <AccountTabs
        accounts={accounts ?? []}
        renderAccount={(account) => (
          <ProfileMaterialRow
            account={account}
            onChange={replaceAccount}
            onAction={onAction}
          />
        )}
      />
    </div>
  );
}

/**
 * One account at a time, because each account's card is a screenful of its own.
 *
 * Every panel stays mounted and inactive ones are hidden with CSS: the rows
 * hold unsaved local state (draft edits, prompt hints, the identity/readback
 * results), and unmounting on tab switch would quietly throw that away. A
 * single account renders bare — tab chrome over one item is just noise.
 */
function AccountTabs({
  accounts,
  renderAccount,
}: {
  accounts: XhsOpsAccount[];
  renderAccount: (account: XhsOpsAccount) => ReactNode;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const active =
    accounts.find((a) => a.id === activeId)?.id ?? accounts[0]?.id ?? null;

  if (accounts.length === 0) return null;
  if (accounts.length === 1) {
    const only = accounts[0] as XhsOpsAccount;
    return <div className="flex flex-col gap-3">{renderAccount(only)}</div>;
  }

  return (
    <div className="flex flex-col gap-2">
      <div
        role="tablist"
        aria-label="账号"
        className="flex flex-wrap items-center gap-1 border-b border-border"
      >
        {accounts.map((account) => {
          const selected = account.id === active;
          return (
            <button
              key={account.id}
              type="button"
              role="tab"
              id={`xhs-account-tab-${account.id}`}
              aria-selected={selected}
              aria-controls={`xhs-account-panel-${account.id}`}
              onClick={() => setActiveId(account.id)}
              className={`-mb-px max-w-[14rem] truncate border-b-2 px-2.5 py-1.5 text-[12px] ${
                selected
                  ? "border-[var(--color-accent)] font-medium text-text-primary"
                  : "border-transparent text-text-secondary hover:text-text-primary"
              }`}
              title={account.deviceName ?? account.deviceId ?? account.label}
            >
              {account.label}
            </button>
          );
        })}
      </div>
      {accounts.map((account) => (
        <div
          key={account.id}
          role="tabpanel"
          id={`xhs-account-panel-${account.id}`}
          aria-labelledby={`xhs-account-tab-${account.id}`}
          className={account.id === active ? "flex flex-col gap-3" : "hidden"}
        >
          {renderAccount(account)}
        </div>
      ))}
    </div>
  );
}

type Busy =
  | XhsOpsProfilePart
  | "all"
  | "identity"
  | "readback"
  | "save"
  | "confirm"
  | "apply"
  | "refresh"
  | null;

function ProfileMaterialRow({
  account,
  onChange,
  onAction,
}: {
  account: XhsOpsAccount;
  onChange: (updated: XhsOpsAccount) => void;
  onAction?: CustomComponentProps["onAction"];
}) {
  const [draft, setDraft] = useState<XhsOpsProfileDraft>(() =>
    normalizeProfileDraft(account.profileDraft),
  );
  const [platformAccountId, setPlatformAccountId] = useState(
    account.platformAccountId,
  );
  const [busy, setBusy] = useState<Busy>(null);
  const [error, setError] = useState<string | null>(null);
  const [avatarPrompt, setAvatarPrompt] = useState("");
  const [coverPrompt, setCoverPrompt] = useState("");
  const [identity, setIdentity] = useState<XhsOpsAccountIdentity | null>(null);
  const [readback, setReadback] = useState<XhsOpsProfileReadback | null>(null);
  const [applyFields, setApplyFields] = useState<Set<XhsOpsProfileField>>(
    new Set(),
  );
  const [applyConfirmOpen, setApplyConfirmOpen] = useState(false);
  const operationRunning = draft.applyOperation?.status === "running";
  const disabled = busy !== null || operationRunning;
  const missingFields = xhsOpsProfileDraftMissingFields(draft);
  const ready = xhsOpsProfileDraftReady(draft);
  const verified =
    draft.applyStatus === "applied" &&
    Boolean(draft.verifiedAt) &&
    Boolean(draft.verificationTaskId) &&
    draft.verifiedAccountId === platformAccountId.trim();

  const draftForWrite = (value: XhsOpsProfileDraft) => {
    const {
      reviewedAt: _reviewedAt,
      appliedAt: _appliedAt,
      applyStatus: _applyStatus,
      applyResult: _applyResult,
      applyOperation: _applyOperation,
      verifiedAt: _verifiedAt,
      verifiedAccountId: _verifiedAccountId,
      verificationTaskId: _verificationTaskId,
      ...editable
    } = value;
    return editable;
  };

  const invalidateReview = (value: XhsOpsProfileDraft): XhsOpsProfileDraft => ({
    ...value,
    reviewedAt: null,
    appliedAt: null,
    applyStatus: null,
    applyResult: null,
    applyOperation: null,
    verifiedAt: null,
    verifiedAccountId: null,
    verificationTaskId: null,
  });

  const editDraft = (patch: Partial<XhsOpsProfileDraft>) =>
    setDraft((current) => invalidateReview({ ...current, ...patch }));

  const refresh = async () => {
    await run("refresh", () => xhsOpsApi.reconcileProfileDraft(account.id));
  };

  const runReadback = async () => {
    setBusy("readback");
    setError(null);
    try {
      const result = await xhsOpsApi.readbackProfile(account.id);
      setReadback(result);
      // Pre-select what actually changes, so a blank phone still applies in one
      // click while an already-tuned one starts from "only the real diffs".
      setApplyFields(
        new Set(result.fields.filter((f) => f.differs).map((f) => f.field)),
      );
    } catch (err) {
      setReadback(null);
      setError(describeXhsOpsError(err, "回读手机资料失败"));
    } finally {
      setBusy(null);
    }
  };

  const readIdentity = async () => {
    setBusy("identity");
    setError(null);
    try {
      const result = await xhsOpsApi.readAccountIdentity(account.id);
      setIdentity(result);
      if (result.accountId) {
        // Prefill, but say so when it replaces something different — silently
        // swapping the id the operator typed would hide a real mismatch.
        const previous = platformAccountId.trim();
        if (previous && previous !== result.accountId) {
          setError(
            `手机上的小红书号是 ${result.accountId}，与原先填的 ${previous} 不一致，已按手机上的填入；请核对截图确认`,
          );
        }
        setPlatformAccountId(result.accountId);
        setDraft((current) => invalidateReview(current));
      }
    } catch (err) {
      setIdentity(null);
      setError(describeXhsOpsError(err, "读取手机当前账号失败"));
    } finally {
      setBusy(null);
    }
  };

  const run = async (kind: Busy, fn: () => Promise<XhsOpsAccount>) => {
    setBusy(kind);
    setError(null);
    try {
      const updated = await fn();
      setDraft(normalizeProfileDraft(updated.profileDraft));
      setPlatformAccountId(updated.platformAccountId);
      onChange(updated);
      return updated;
    } catch (err) {
      setError(describeXhsOpsError(err, "操作失败"));
      if (kind === "apply") {
        try {
          const latest = await xhsOpsApi.reconcileProfileDraft(account.id);
          setDraft(normalizeProfileDraft(latest.profileDraft));
          setPlatformAccountId(latest.platformAccountId);
          onChange(latest);
        } catch {
          // Keep the original apply error visible when the recovery request also fails.
        }
      }
      return null;
    } finally {
      setBusy(null);
    }
  };

  const generate = async (part: XhsOpsProfilePart | "all") => {
    setBusy(part);
    setError(null);
    try {
      const parts: XhsOpsProfilePart[] =
        part === "all" ? ["text", "avatar", "cover"] : [part];
      const updated = await xhsOpsApi.generateProfileDraft(account.id, parts, {
        ...(avatarPrompt.trim() ? { avatarPrompt: avatarPrompt.trim() } : {}),
        ...(coverPrompt.trim() ? { coverPrompt: coverPrompt.trim() } : {}),
      });
      const generated = normalizeProfileDraft(updated.profileDraft);
      setDraft((current) => {
        if (part === "all") return generated;
        const editable = invalidateReview(current);
        switch (part) {
          case "text":
            return {
              ...editable,
              nickname: generated.nickname,
              bio: generated.bio,
              gender: generated.gender,
              region: generated.region,
              interestTags: generated.interestTags,
              generatedAt: generated.generatedAt,
            };
          case "avatar":
            return {
              ...editable,
              avatarCandidates: generated.avatarCandidates,
              avatarPath: generated.avatarPath,
              generatedAt: generated.generatedAt,
            };
          case "cover":
            return {
              ...editable,
              coverCandidates: generated.coverCandidates,
              coverPath: generated.coverPath,
              generatedAt: generated.generatedAt,
            };
        }
      });
      onChange(updated);
    } catch (err) {
      setError(describeXhsOpsError(err, "操作失败"));
    } finally {
      setBusy(null);
    }
  };

  const save = () =>
    run("save", () =>
      xhsOpsApi.updateAccount(account.id, {
        expectedUpdatedAt: account.updatedAt,
        platformAccountId: platformAccountId.trim(),
        profileDraft: draftForWrite(draft),
      }),
    );

  const confirm = async () => {
    if (!platformAccountId.trim()) {
      setError("请填写目标小红书号，用于登录与资料生效核验");
      return;
    }
    if (missingFields.length > 0) {
      setError(
        `资料尚未完整：${missingFields.map((field) => MATERIAL_FIELD_LABEL[field]).join("、")}`,
      );
      return;
    }
    const saved = await run("save", () =>
      xhsOpsApi.updateAccount(account.id, {
        expectedUpdatedAt: account.updatedAt,
        platformAccountId: platformAccountId.trim(),
        profileDraft: draftForWrite(draft),
      }),
    );
    if (!saved) return;
    const confirmed = await run("confirm", () =>
      xhsOpsApi.confirmProfileDraft(account.id, saved.updatedAt),
    );
    if (!confirmed) return;
    onAction?.("xhs_ops_profile_material_confirmed", {
      accountId: confirmed.id,
      label: confirmed.label,
      agentInstruction:
        "八项账号资料与素材已由用户校验确认，可以执行手机安装登录、资料应用与只读生效核验；尚未解锁养号。",
    });
  };

  const apply = () => {
    if (!platformAccountId.trim()) {
      setError("请先填写并确认目标小红书号");
      return;
    }
    if (!ready) {
      setError("请先完成八项资料与素材并人工校验确认");
      return;
    }
    if (readback && applyFields.size === 0) {
      setError("已回读手机资料，但没有勾选任何要写入的字段");
      return;
    }
    setError(null);
    setApplyConfirmOpen(true);
  };

  const runApply = async () => {
    // 先持久化当前编辑与点选，再让手机按落库内容执行
    const saved = await run("save", () =>
      xhsOpsApi.updateAccount(account.id, {
        expectedUpdatedAt: account.updatedAt,
        platformAccountId: platformAccountId.trim(),
        profileDraft: draftForWrite(draft),
      }),
    );
    if (!saved) return;
    const applied = await run("apply", () =>
      // Only send a list once the operator has actually seen a diff; without a
      // readback there is nothing to choose from and the old behaviour stands.
      xhsOpsApi.applyProfileDraft(
        account.id,
        readback ? [...applyFields] : undefined,
      ),
    );
    if (applied) {
      const d = normalizeProfileDraft(applied.profileDraft);
      onAction?.("xhs_ops_profile_applied", {
        accountId: account.id,
        label: account.label,
        status: d.applyStatus,
        result: d.applyResult,
        agentInstruction:
          d.applyStatus === "applied" && d.verifiedAt
            ? "目标账号身份与八项资料已在手机上完成独立只读核验，可以进入养号计划。"
            : "资料应用或独立只读核验未完成（见 result）；只提示用户检查后重新执行，不得声称资料已生效或已解锁养号。",
      });
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-0/40 p-2.5">
      <div className="flex items-center justify-between gap-2">
        <SectionTitle>{account.label}</SectionTitle>
        <span className="text-[12px] text-text-secondary">
          {account.deviceName ?? account.deviceId ?? "未绑定设备"}
        </span>
      </div>

      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Field label="目标小红书号">
          <div className="flex items-center gap-1.5">
            <input
              className={inputClass}
              value={platformAccountId}
              maxLength={80}
              disabled={disabled}
              placeholder="对照截图确认后填写"
              onChange={(e) => {
                setPlatformAccountId(e.target.value);
                setDraft((current) => invalidateReview(current));
              }}
            />
            <SecondaryButton
              onClick={() => void readIdentity()}
              disabled={disabled || !account.deviceId}
              title={
                account.deviceId
                  ? "在手机上打开小红书编辑主页并截图，供你核对当前登录的是哪个号"
                  : "该账号未绑定设备"
              }
            >
              {busy === "identity" ? "读取中…" : "读取手机"}
            </SecondaryButton>
          </div>
        </Field>
        <Field label="昵称">
          {/* Caps at 20 chars, so a full-width control just looks empty. */}
          <input
            className={`${inputClass} sm:max-w-[15rem]`}
            value={draft.nickname}
            maxLength={20}
            disabled={disabled}
            placeholder="点右侧「生成」由 AI 起名"
            onChange={(e) => editDraft({ nickname: e.target.value })}
          />
        </Field>
        <Field
          label="简介（星座+MBTI / 自我介绍 / 兴趣介绍）"
          className="sm:col-span-2"
        >
          <textarea
            className={textareaClass}
            rows={3}
            value={draft.bio}
            maxLength={100}
            disabled={disabled}
            onChange={(e) => editDraft({ bio: e.target.value })}
          />
        </Field>
      </div>
      {identity ? (
        <div
          data-testid="identity-readout"
          className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-2"
        >
          <span className="text-[12px] text-text-secondary">
            {identity.reason}
          </span>
          {identity.screenshotUrl ? (
            <ZoomableImage
              src={identity.screenshotUrl}
              alt="手机上的小红书编辑主页"
              className="self-start"
              imgClassName="max-h-64 w-auto rounded-md border border-border"
            />
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="性别">
          <select
            className={inputClass}
            value={draft.gender}
            disabled={disabled}
            onChange={(e) =>
              editDraft({
                gender: e.target.value as XhsOpsProfileDraft["gender"],
              })
            }
          >
            <option value="">请选择</option>
            <option value="女">女</option>
            <option value="男">男</option>
            <option value="不展示">不展示</option>
          </select>
        </Field>
        <Field label="生日">
          <input
            className={inputClass}
            type="date"
            value={draft.birthday}
            disabled={disabled}
            onChange={(e) => editDraft({ birthday: e.target.value })}
          />
        </Field>
        <Field label="地区">
          <input
            className={inputClass}
            value={draft.region}
            disabled={disabled}
            placeholder="例如 北京"
            onChange={(e) => editDraft({ region: e.target.value })}
          />
        </Field>
        <Field label="兴趣标签">
          <input
            className={inputClass}
            value={draft.interestTags.join("、")}
            disabled={disabled}
            placeholder="多个标签用逗号分隔"
            onChange={(e) =>
              editDraft({
                interestTags: e.target.value
                  .split(/[,，、]/)
                  .map((tag) => tag.trim())
                  .filter(Boolean),
              })
            }
          />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton onClick={() => void generate("all")} disabled={disabled}>
          {busy === "all" ? "完整资料生成中…" : "一键生成完整资料"}
        </PrimaryButton>
        <SecondaryButton
          onClick={() => void generate("text")}
          disabled={disabled}
        >
          {busy === "text" ? "生成中…" : "生成昵称与简介"}
        </SecondaryButton>
        <HintLine>生成后仍需人工核对；不会自动修改手机公开资料。</HintLine>
      </div>

      <MaterialChecklist draft={draft} missingFields={missingFields} />

      <CandidateRow
        title="头像（人物半身照 + 自然环境背景）"
        candidates={draft.avatarCandidates}
        selected={draft.avatarPath}
        reviewedAt={draft.reviewedAt}
        square
        busy={busy === "avatar"}
        disabled={disabled}
        promptHint={avatarPrompt}
        promptPlaceholder="补充要求，例如：戴眼镜、球场边、傍晚光线（留空用默认提示词）"
        onPromptHintChange={setAvatarPrompt}
        onGenerate={() => void generate("avatar")}
        onSelect={(p) => editDraft({ avatarPath: p })}
      />
      <CandidateRow
        title="背景图（知名地区风景 + 人物背身）"
        candidates={draft.coverCandidates}
        selected={draft.coverPath}
        reviewedAt={draft.reviewedAt}
        busy={busy === "cover"}
        disabled={disabled}
        promptHint={coverPrompt}
        promptPlaceholder="补充要求，例如：外滩天际线、清晨、冷色调（留空用默认提示词）"
        onPromptHintChange={setCoverPrompt}
        onGenerate={() => void generate("cover")}
        onSelect={(p) => editDraft({ coverPath: p })}
      />

      <div className="flex flex-wrap items-center gap-2">
        <SecondaryButton
          onClick={() => void runReadback()}
          disabled={disabled || !account.deviceId}
          title={
            account.deviceId
              ? "读回手机上现有的资料，逐项对比后再决定覆盖哪些"
              : "该账号未绑定设备"
          }
        >
          {busy === "readback" ? "回读中…" : "对比手机现有资料"}
        </SecondaryButton>
        <HintLine>
          {readback
            ? `已勾选 ${applyFields.size} 项将写入手机`
            : "不对比就直接应用，会覆盖手机上已有的同名字段。"}
        </HintLine>
      </div>
      {readback ? (
        <ProfileDiffTable
          readback={readback}
          selected={applyFields}
          disabled={disabled}
          onToggle={(field) =>
            setApplyFields((current) => {
              const next = new Set(current);
              if (next.has(field)) next.delete(field);
              else next.add(field);
              return next;
            })
          }
        />
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2 pt-1">
        <div className="text-[12px] text-text-secondary">
          {draft.generatedAt ? (
            <span>生成 {formatClock(Date.parse(draft.generatedAt))}</span>
          ) : null}
          {draft.appliedAt ? (
            <span className="ml-2">
              应用 {formatClock(Date.parse(draft.appliedAt))}
              {draft.applyStatus ? `（${APPLY_LABEL[draft.applyStatus]}）` : ""}
            </span>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          <SecondaryButton onClick={() => void save()} disabled={disabled}>
            {busy === "save" ? "保存中…" : "保存草稿"}
          </SecondaryButton>
          {operationRunning ? (
            <SecondaryButton
              onClick={() => void refresh()}
              disabled={busy !== null}
            >
              {busy === "refresh" ? "刷新中…" : "刷新应用状态"}
            </SecondaryButton>
          ) : null}
          <PrimaryButton
            onClick={() => void confirm()}
            disabled={disabled || missingFields.length > 0 || ready}
          >
            {busy === "confirm"
              ? "确认中…"
              : ready
                ? "已校验确认"
                : "校验确认资料"}
          </PrimaryButton>
          <PrimaryButton
            onClick={apply}
            disabled={disabled || !account.deviceId || !ready || verified}
            title={
              account.deviceId
                ? undefined
                : "该账号未绑定设备，绑定后才能应用到手机"
            }
          >
            {busy === "apply"
              ? "手机配置与核验中…"
              : verified
                ? "已应用并核验"
                : "安装登录、应用并核验"}
          </PrimaryButton>
        </div>
      </div>
      {!account.deviceId ? (
        <HintLine>
          未绑定设备：可以先生成、选择并保存素材，绑定设备后才能应用到手机。
        </HintLine>
      ) : null}
      {ready ? (
        verified ? (
          <HintLine>目标账号与八项资料已核验生效，可以进入养号计划。</HintLine>
        ) : (
          <HintLine>
            资料已人工确认；完成手机应用与独立只读核验后才能进入养号。
          </HintLine>
        )
      ) : (
        <HintLine>保存草稿不会解锁养号；请核对清单后单独确认。</HintLine>
      )}
      {draft.applyResult ? (
        <div
          data-testid="profile-apply-result"
          className="rounded-md border border-border bg-surface-1 px-2.5 py-1.5 text-[12px] text-text-secondary"
        >
          手机回报：{draft.applyResult}
        </div>
      ) : null}
      {operationRunning ? (
        <div
          data-testid="profile-apply-running"
          className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[12px] text-text-secondary"
        >
          资料应用任务仍在执行或等待手机状态核验；请刷新状态后再继续编辑或启动养号。
        </div>
      ) : null}
      <ErrorLine message={error} />
      <ConfirmDialog
        open={applyConfirmOpen}
        onOpenChange={setApplyConfirmOpen}
        title="确认应用到手机？"
        confirmLabel="确认执行"
        onConfirm={() => void runApply()}
        description={
          <>
            <p>
              将先核对「{account.label}
              」绑定手机当前登录的小红书号，再应用公开资料并独立回读核验，手机将自动操作约
              2–5 分钟。
            </p>
            <p className="mt-2">
              {readback
                ? `本次只写入勾选的 ${applyFields.size} 项。`
                : "本次将写入草稿里所有已填字段（未回读手机现有资料，可能覆盖手机上已有内容）。"}
            </p>
          </>
        }
      />
    </div>
  );
}

/**
 * Pre-apply comparison. Rows the phone already has content in are the dangerous
 * ones, so they are called out as 覆盖 rather than blending in with the empty
 * fields that are merely being filled.
 */
function ProfileDiffTable({
  readback,
  selected,
  disabled,
  onToggle,
}: {
  readback: XhsOpsProfileReadback;
  selected: Set<XhsOpsProfileField>;
  disabled: boolean;
  onToggle: (field: XhsOpsProfileField) => void;
}) {
  if (readback.status !== "read") {
    return (
      <div
        data-testid="readback-unavailable"
        className="rounded-lg border border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-ink)]/[6%] px-3 py-2 text-[12px] text-text-secondary"
      >
        {readback.reason}
      </div>
    );
  }
  return (
    <div
      data-testid="readback-diff"
      className="flex flex-col gap-1 rounded-lg border border-border bg-surface-1 px-3 py-2 text-[12px]"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="text-text-secondary">{readback.reason}</span>
        {readback.screenshotUrl ? (
          <ZoomableImage
            src={readback.screenshotUrl}
            alt="手机上的小红书编辑资料页"
            className="h-12 w-12 shrink-0 overflow-hidden rounded-md border border-border"
            imgClassName="h-full w-full object-cover object-top"
            title="放大查看回读截图"
          />
        ) : null}
      </div>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[32rem] border-collapse">
          <thead className="text-text-secondary">
            <tr>
              <th className="w-8 py-1 text-left font-normal">写入</th>
              <th className="py-1 text-left font-normal">字段</th>
              <th className="py-1 text-left font-normal">手机现有</th>
              <th className="py-1 text-left font-normal">将写入</th>
            </tr>
          </thead>
          <tbody>
            {readback.fields.map((row) => {
              const overwrite =
                row.comparable && row.phone !== "" && row.differs;
              return (
                <tr key={row.field} className="border-t border-border">
                  <td className="py-1 align-top">
                    <input
                      type="checkbox"
                      aria-label={XHS_PROFILE_FIELD_LABEL[row.field]}
                      checked={selected.has(row.field)}
                      disabled={disabled || row.draft === ""}
                      onChange={() => onToggle(row.field)}
                    />
                  </td>
                  <td className="py-1 align-top">
                    {XHS_PROFILE_FIELD_LABEL[row.field]}
                    {overwrite ? (
                      <span className="ml-1 font-medium text-[var(--color-warning-ink)]">
                        覆盖
                      </span>
                    ) : null}
                    {!row.comparable ? (
                      <span className="ml-1 text-text-secondary">无法比对</span>
                    ) : null}
                  </td>
                  <td className="py-1 align-top text-text-secondary">
                    {row.comparable ? row.phone || "空" : "—"}
                  </td>
                  <td className="py-1 align-top text-text-secondary">
                    {row.draft || "不写入"}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

const MATERIAL_FIELD_LABEL: Record<XhsOpsProfileDraftRequiredField, string> = {
  nickname: "昵称",
  bio: "简介（100 字内）",
  avatarPath: "头像",
  coverPath: "背景图",
  gender: "性别",
  birthday: "生日",
  region: "地区",
  interestTags: "兴趣标签",
};

function MaterialChecklist({
  draft,
  missingFields,
}: {
  draft: XhsOpsProfileDraft;
  missingFields: XhsOpsProfileDraftRequiredField[];
}) {
  const missing = new Set(missingFields);
  const items: Array<{
    field: XhsOpsProfileDraftRequiredField;
    label: string;
  }> = [
    { field: "nickname", label: "昵称" },
    {
      field: "bio",
      label: `简介 ${draft.bio.trim().length}/100（人工核对：星座 MBTI + 自我介绍 + 兴趣介绍）`,
    },
    { field: "avatarPath", label: "已选择头像" },
    { field: "coverPath", label: "已选择背景图" },
    { field: "gender", label: "性别" },
    { field: "birthday", label: "明确生日" },
    { field: "region", label: "地区" },
    { field: "interestTags", label: "至少一个兴趣标签" },
  ];
  return (
    <div className="grid grid-cols-1 gap-1 rounded-md border border-border bg-surface-1 px-2.5 py-2 text-[12px] sm:grid-cols-2">
      {items.map((item) => {
        const complete = !missing.has(item.field);
        return (
          <span
            key={item.field}
            className={
              complete
                ? "text-[var(--color-success-ink)]"
                : "text-text-secondary"
            }
          >
            {complete ? "已完成" : "待完成"} · {item.label}
          </span>
        );
      })}
    </div>
  );
}

const APPLY_LABEL: Record<"applied" | "partial" | "failed", string> = {
  applied: "全部完成",
  partial: "部分完成",
  failed: "失败",
};

function CandidateRow({
  title,
  candidates,
  selected,
  reviewedAt,
  square,
  busy,
  disabled,
  promptHint,
  promptPlaceholder,
  onPromptHintChange,
  onGenerate,
  onSelect,
}: {
  title: string;
  candidates: string[];
  selected: string | null;
  reviewedAt: string | null;
  square?: boolean;
  busy: boolean;
  disabled: boolean;
  promptHint: string;
  promptPlaceholder: string;
  onPromptHintChange: (value: string) => void;
  onGenerate: () => void;
  onSelect: (path: string) => void;
}) {
  // Same rule the controller applies, so the button never promises a count it
  // will not request.
  const plan = xhsOpsProfileCandidatePlan({
    existing: candidates,
    selected,
    reviewedAt,
  });
  const short =
    candidates.length > 0 && candidates.length < XHS_PROFILE_CANDIDATES;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[12px] font-medium">{title}</span>
        <SecondaryButton onClick={onGenerate} disabled={disabled}>
          {busy
            ? "生成中（约 1 分钟）…"
            : plan.toppingUp
              ? `补齐剩余 ${plan.count} 张`
              : candidates.length
                ? `重新生成 ${XHS_PROFILE_CANDIDATES} 张备选`
                : `生成 ${XHS_PROFILE_CANDIDATES} 张备选`}
        </SecondaryButton>
      </div>
      <input
        className={inputClass}
        value={promptHint}
        maxLength={200}
        disabled={disabled}
        placeholder={promptPlaceholder}
        onChange={(e) => onPromptHintChange(e.target.value)}
      />
      {short ? (
        <div
          data-testid="candidate-partial"
          className="rounded-md border border-warning/40 bg-warning/10 px-2.5 py-1.5 text-[12px] text-text-secondary"
        >
          只成功生成 {candidates.length}/{XHS_PROFILE_CANDIDATES} 张（上游超时，
          已保留成功的）。
          {plan.toppingUp
            ? `点「补齐剩余 ${plan.count} 张」继续。`
            : "取消选择后再生成即可补齐。"}
        </div>
      ) : null}
      {candidates.length === 0 ? (
        <HintLine>还没有备选图。</HintLine>
      ) : (
        <div className="flex flex-wrap gap-2">
          {candidates.map((p) => {
            const isSelected = selected === p;
            return (
              <div
                key={p}
                className={`relative ${square ? "h-20 w-20" : "h-20 w-36"}`}
              >
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onSelect(p)}
                  aria-pressed={isSelected}
                  className={`h-full w-full overflow-hidden rounded-md border-2 ${
                    isSelected ? "border-accent" : "border-transparent"
                  } bg-surface-1`}
                >
                  <img
                    src={mediaFileUrl(p)}
                    alt=""
                    className="h-full w-full object-cover"
                  />
                </button>
                {/* Sibling, not child: clicking the thumbnail itself has to
                    keep meaning "pick this one". */}
                <ZoomableImage
                  src={mediaFileUrl(p)}
                  alt="备选图"
                  overlay
                  title="放大查看这张备选图"
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
