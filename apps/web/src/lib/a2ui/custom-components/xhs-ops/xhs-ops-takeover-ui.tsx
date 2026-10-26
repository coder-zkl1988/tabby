/**
 * Shared pieces of the takeover card (老号接管): the data and operations every
 * section receives, the per-section action hook, and the small chips and
 * notices the sections have in common.
 */
import {
  XHS_OCCUPATION_GROUPS,
  XHS_OCCUPATION_OPTIONS,
  XHS_PROFILE_FIELD_LABEL,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsAccountDiagnosis,
  type XhsOpsChangeOrder,
  type XhsOpsPlaybookRule,
  type XhsOpsProject,
  type XhsOpsTakeoverEvent,
  type XhsOpsTakeoverProfileField,
} from "@nexu/shared";
import { type ReactNode, useCallback, useRef, useState } from "react";
import type { CustomComponentProps } from "../registry";
import { describeXhsOpsError } from "./xhs-ops-api";
import {
  type RuleChipCategory,
  type TakeoverSkillDocsState,
  evidenceLabel,
  evidenceRowKey,
  isTakeoverConflict,
  resolveRuleChip,
} from "./xhs-ops-takeover-model";
import {
  SectionTitle,
  inputClass,
  selectClass,
  textareaClass,
} from "./xhs-ops-ui";

/** What the card has loaded for one takeover account. */
export type TakeoverData = {
  account: XhsOpsAccount;
  project: XhsOpsProject | null;
  /** Newest first, as the controller lists them. */
  audits: XhsOpsAccountAudit[];
  /** The account's active diagnosis. */
  diagnosis: XhsOpsAccountDiagnosis | null;
  /** Newest first. */
  orders: XhsOpsChangeOrder[];
  playbook: XhsOpsPlaybookRule[];
  /** The bound phone's skill docs against the bundle the doc rules were checked against (§4.5). */
  skillDocs: TakeoverSkillDocsState;
  /** Ticks every 30s so countdowns and the observation window move. */
  now: number;
};

export type TakeoverOps = {
  setAccount: (account: XhsOpsAccount) => void;
  upsertAudit: (audit: XhsOpsAccountAudit) => void;
  setDiagnosis: (diagnosis: XhsOpsAccountDiagnosis | null) => void;
  upsertOrder: (order: XhsOpsChangeOrder) => void;
  setOrders: (orders: XhsOpsChangeOrder[]) => void;
  /** Re-reads the account, its audits, change orders and active diagnosis. */
  refresh: () => Promise<void>;
  /** Hands an event to the agent once: polls and remounts repeat them. */
  forward: (
    event: XhsOpsTakeoverEvent | null | undefined,
    revision?: string | null,
  ) => void;
  /** This card saw the record before its event-worthy state; announce it later. */
  track: (id: string) => void;
  /** Highlight the audit row an evidence chip points at. */
  focusEvidence: (rowKey: string) => void;
  onAction?: CustomComponentProps["onAction"];
};

export type TakeoverSectionProps = {
  data: TakeoverData;
  ops: TakeoverOps;
};

/**
 * Busy key and error of one section's actions. `onConflict` runs after a
 * 409: the records usually moved on (another card, a background step), and
 * when nothing polls, the next try would send the same stale revision again.
 */
export function useTakeoverAction(onConflict?: () => Promise<void>) {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conflictRef = useRef(onConflict);
  conflictRef.current = onConflict;
  const run = useCallback(
    async <T,>(
      key: string,
      fallback: string,
      fn: () => Promise<T>,
    ): Promise<T | null> => {
      setBusy(key);
      setError(null);
      try {
        return await fn();
      } catch (err) {
        setError(describeXhsOpsError(err, fallback));
        if (isTakeoverConflict(err)) void conflictRef.current?.();
        return null;
      } finally {
        setBusy(null);
      }
    },
    [],
  );
  return { busy, error, setError, run };
}

/** One numbered step of the card, ① to ⑦. */
export function TakeoverSection({
  index,
  title,
  hint,
  testId,
  children,
}: {
  index: string;
  title: string;
  hint?: ReactNode;
  testId: string;
  children: ReactNode;
}) {
  return (
    <section
      data-takeover-section={testId}
      className="flex flex-col gap-2.5 rounded-lg border border-border bg-surface-0/40 p-3"
    >
      <SectionTitle hint={hint}>
        {index} {title}
      </SectionTitle>
      {children}
    </section>
  );
}

const NOTICE_CLASS: Record<"warning" | "error" | "info", string> = {
  warning:
    "border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-ink)]/[6%] text-[var(--color-warning-ink)]",
  error:
    "border-[var(--color-error-ink)]/[25%] bg-[var(--color-error-wash)] text-[var(--color-error-ink)]",
  info: "border-border bg-surface-1 text-text-secondary",
};

export function Notice({
  tone,
  children,
  testId,
}: {
  tone: "warning" | "error" | "info";
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId}
      className={`flex flex-col gap-1.5 rounded-md border px-2.5 py-2 text-[12px] leading-[1.55] ${NOTICE_CLASS[tone]}`}
    >
      {children}
    </div>
  );
}

/** A checkbox whose whole sentence is its label. */
export function CheckLine({
  checked,
  onChange,
  disabled,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <label className="flex items-start gap-2 text-[12px] leading-[1.55] text-text-primary">
      <input
        type="checkbox"
        className="mt-0.5 shrink-0"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{children}</span>
    </label>
  );
}

const CHIP_CLASS: Record<RuleChipCategory, string> = {
  skill_doc:
    "border-[var(--color-info)]/[30%] bg-[var(--color-info-subtle)] text-[var(--color-info)]",
  design: "border-border-strong bg-surface-2 text-text-primary",
  reference: "border-border bg-surface-1 text-text-tertiary",
  unknown:
    "border-[var(--color-warning-ink)]/[30%] bg-[var(--color-warning-ink)]/[6%] text-[var(--color-warning-ink)]",
};

const CHIP_TAG: Record<RuleChipCategory, string> = {
  skill_doc: "技能文档",
  design: "本方案",
  reference: "参考",
  unknown: "无经验依据",
};

/**
 * Experience chips (§4.5), split by where a rule comes from so nobody takes
 * a design rule or a community tip for distilled skill knowledge. Hovering
 * shows the rule text and its source.
 */
export function RuleChips({
  ruleIds,
  data,
}: {
  ruleIds: readonly string[];
  data: Pick<TakeoverData, "diagnosis" | "playbook">;
}) {
  if (ruleIds.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[11px] text-text-secondary">经验</span>
      {ruleIds.map((id) => {
        const chip = resolveRuleChip(
          id,
          data.diagnosis?.citedRules ?? [],
          data.playbook,
        );
        const title =
          chip.category === "unknown"
            ? `${id}：经验库里没有这条规则`
            : `${id} ${chip.text}\n出处：${chip.source}${chip.pendingSignOff ? "\n（尚未签字确认）" : ""}`;
        return (
          <span
            key={id}
            data-rule-category={chip.category}
            title={title}
            className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] ${CHIP_CLASS[chip.category]}`}
          >
            <span className="font-medium">{id}</span>
            <span>{CHIP_TAG[chip.category]}</span>
            {chip.pendingSignOff ? <span>待确认</span> : null}
            {/* The hover text is mouse-only; screen readers get it inline. */}
            <span className="sr-only">
              {chip.category === "unknown"
                ? "：经验库里没有这条规则"
                : `：${chip.text}（出处：${chip.source}）`}
            </span>
          </span>
        );
      })}
    </div>
  );
}

/**
 * Evidence chips: a path into the audit the diagnosis read. Paths the audit
 * section shows as a row become buttons that highlight it.
 */
export function EvidenceChips({
  refs,
  ops,
  focusable,
}: {
  refs: readonly string[];
  ops: Pick<TakeoverOps, "focusEvidence">;
  /** The audit section shows the audit these paths point into. */
  focusable: boolean;
}) {
  if (refs.length === 0) return null;
  return (
    <div className="flex flex-wrap items-center gap-1">
      <span className="text-[11px] text-text-secondary">证据</span>
      {refs.map((ref) => {
        const rowKey = focusable ? evidenceRowKey(ref) : null;
        const label = evidenceLabel(ref);
        return rowKey ? (
          <button
            key={ref}
            type="button"
            title={`${ref}：点击高亮盘点里的对应行`}
            onClick={() => ops.focusEvidence(rowKey)}
            className="rounded-full border border-[var(--color-brand-primary)]/[35%] bg-[var(--color-brand-subtle)] px-2 py-0.5 text-[11px] text-text-primary hover:border-[var(--color-brand-primary)]"
          >
            {label}
          </button>
        ) : (
          <span
            key={ref}
            title={ref}
            className="rounded-full border border-border bg-surface-1 px-2 py-0.5 text-[11px] text-text-secondary"
          >
            {label}
          </span>
        );
      })}
    </div>
  );
}

/** What a new value may be (§4.4 #6); the controller re-checks every rule. */
const FIELD_VALUE_MAX: Record<XhsOpsTakeoverProfileField, number> = {
  nickname: 20,
  bio: 100,
  occupation: 120,
  region: 120,
  avatar: 120,
  cover: 120,
};

/**
 * The new value of one public field: the occupation from the picker's exact
 * second-level items, the region in its picker hierarchy, a picture as the
 * direction note (the picture itself is uploaded on the order).
 */
export function TakeoverFieldValueInput({
  field,
  value,
  onChange,
  disabled,
}: {
  field: XhsOpsTakeoverProfileField;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const label = XHS_PROFILE_FIELD_LABEL[field];
  if (field === "occupation")
    return (
      <select
        className={selectClass}
        value={value}
        disabled={disabled}
        aria-label={`新的${label}`}
        onChange={(event) => onChange(event.target.value)}
      >
        <option value="">请选择职业</option>
        {value &&
        !XHS_OCCUPATION_OPTIONS.includes(
          value as (typeof XHS_OCCUPATION_OPTIONS)[number],
        ) ? (
          <option value={value}>{value}（不在选择器里）</option>
        ) : null}
        {XHS_OCCUPATION_GROUPS.map((group) => (
          <optgroup key={group.category} label={group.category}>
            {group.options.map((option) => (
              <option key={option} value={option}>
                {option}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
    );
  if (field === "bio")
    return (
      <textarea
        className={textareaClass}
        rows={2}
        value={value}
        maxLength={FIELD_VALUE_MAX.bio}
        disabled={disabled}
        aria-label={`新的${label}`}
        onChange={(event) => onChange(event.target.value)}
      />
    );
  const image = field === "avatar" || field === "cover";
  return (
    <input
      className={inputClass}
      value={value}
      maxLength={FIELD_VALUE_MAX[field]}
      disabled={disabled}
      aria-label={image ? `${label}图片方向` : `新的${label}`}
      placeholder={
        field === "region"
          ? "按选择器层级写：中国 省或直辖市 市"
          : image
            ? "如：户外自然光半身照（图片在变更单上上传）"
            : undefined
      }
      onChange={(event) => onChange(event.target.value)}
    />
  );
}

/** A labelled value line used across the result blocks. */
export function ValueRow({
  label,
  children,
  rowKey,
  highlighted,
}: {
  label: ReactNode;
  children: ReactNode;
  /** evidenceRowKey of the row, so evidence chips can find it. */
  rowKey?: string;
  highlighted?: boolean;
}) {
  return (
    <div
      data-evidence-row={rowKey}
      className={`grid grid-cols-[6.5rem_minmax(0,1fr)] gap-2 rounded px-1.5 py-1 text-[12px] ${
        highlighted
          ? "bg-[var(--color-warning-ink)]/[10%] ring-1 ring-[var(--color-warning-ink)]/[40%]"
          : ""
      }`}
    >
      <span className="text-text-secondary">{label}</span>
      <span className="min-w-0 whitespace-pre-wrap break-words text-text-primary">
        {children}
      </span>
    </div>
  );
}
