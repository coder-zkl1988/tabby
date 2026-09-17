/**
 * Small UI vocabulary shared by the four xhs-ops A2UI components: card shell,
 * fields, chip editor, buttons, status dots, Chinese label maps and the device
 * list hook. Styling follows XHSBatchTable / TeamRunCard (CSS variables +
 * Tailwind utility classes) so the cards sit naturally in the chat thread.
 */
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { type ReactNode, useState } from "react";
import { getApiV1Devices } from "../../../../../lib/api/sdk.gen";
import { StatusMark, StatusPill, type StatusTone } from "../../a2ui-status";
import type {
  XhsOpsAnomalyType,
  XhsOpsChunkStatus,
  XhsOpsRunStatus,
} from "./xhs-ops-types";

// Re-exported so the eight xhs-ops cards keep a single import site.
export {
  EmptyState,
  Skeleton,
  Spinner,
  StatusMark,
  StatusPill,
} from "../../a2ui-status";
export type { StatusTone } from "../../a2ui-status";

// ── Class name constants ───────────────────────────────────────
//
// Every size here comes off the three ladders documented at the top of
// a2ui.css: type 24/18/15/14/13/12, space 4/8/12/16/24/32, control
// 28 (in-table) / 36 (form default) / 44 (irreversible). Forms and the
// approve/reject pair sit at 36 — the smallest height an action that
// cannot be undone is allowed to have. `h-7` (28) stays for controls
// that live inside a table row or a card header.

export const inputClass =
  "h-9 w-full min-w-0 rounded-lg border border-border bg-surface-1 px-3 text-[13px] text-text-primary outline-none placeholder:text-text-secondary focus:border-[var(--color-brand-primary)] focus:shadow-[var(--shadow-focus)] disabled:opacity-60";

export const textareaClass =
  "w-full min-w-0 resize-y rounded-lg border border-border bg-surface-1 px-3 py-2.5 text-[13px] leading-[1.55] text-text-primary outline-none placeholder:text-text-secondary focus:border-[var(--color-brand-primary)] focus:shadow-[var(--shadow-focus)] disabled:opacity-60";

export const selectClass =
  "h-9 w-full min-w-0 rounded-lg border border-border bg-surface-1 px-2.5 text-[13px] text-text-primary outline-none focus:border-[var(--color-brand-primary)] focus:shadow-[var(--shadow-focus)] disabled:opacity-60";

const primaryButtonClass =
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-[var(--color-accent)] bg-[var(--color-accent)] px-5 text-[13px] font-semibold text-[var(--color-accent-fg)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40";

const secondaryButtonClass =
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface-1 px-4 text-[13px] font-medium text-text-secondary transition-colors hover:border-[var(--color-accent)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40";

// Danger keeps a neutral border and white fill so it never outshouts the
// primary next to it; the error meaning lives in the label colour, and
// hover escalates the border.
const dangerButtonClass =
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-lg border border-border-strong bg-surface-1 px-4 text-[13px] font-medium text-[var(--color-error-ink)] transition-colors hover:border-[var(--color-error)] disabled:cursor-not-allowed disabled:opacity-40";

// ── Layout primitives ─────────────────────────────────────────

export function CardShell({
  title,
  subtitle,
  actions,
  children,
  footer,
  testId,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  testId?: string;
}) {
  return (
    // `a2ui-framed` tells the inline chat host this card brings its own
    // border, so the host drops its padding instead of double-framing it
    // (see .a2ui-inline-host in a2ui.css).
    <div
      data-xhs-ops-card={testId}
      className="a2ui-framed flex w-full max-w-[720px] flex-col overflow-hidden rounded-xl border border-border bg-surface-1 text-text-primary"
    >
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-5 py-3.5">
        <div className="min-w-0">
          <div className="truncate text-[15px] font-semibold leading-[1.4] text-text-heading">
            {title}
          </div>
          {subtitle ? (
            <div className="mt-1 text-[12px] leading-[1.5] text-text-secondary">
              {subtitle}
            </div>
          ) : null}
        </div>
        {actions ? (
          <div className="flex shrink-0 items-center gap-2">{actions}</div>
        ) : null}
      </div>
      <div className="flex flex-col gap-4 px-5 py-4">{children}</div>
      {footer ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border-subtle px-5 py-3.5">
          {footer}
        </div>
      ) : null}
    </div>
  );
}

export function SectionTitle({
  children,
  hint,
}: {
  children: ReactNode;
  hint?: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
      <span className="shrink-0 text-[15px] font-semibold text-text-heading">
        {children}
      </span>
      {hint ? (
        <span className="text-[12px] text-text-secondary">{hint}</span>
      ) : null}
    </div>
  );
}

export function Field({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: wraps its control as a child
    <label className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <span className="text-[12px] font-medium text-text-secondary">
        {label}
      </span>
      {children}
    </label>
  );
}

export function ErrorLine({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <div role="alert" className="a2ui-error">
      {message}
    </div>
  );
}

/** A one-line aside next to something else. Not for "there is nothing
 *  here" — that is EmptyState, which has to be readable on its own. */
export function HintLine({ children }: { children: ReactNode }) {
  return <div className="text-[12px] text-text-secondary">{children}</div>;
}

export function PrimaryButton({
  children,
  onClick,
  disabled,
  title,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      className={primaryButtonClass}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

export function SecondaryButton({
  children,
  onClick,
  disabled,
  title,
  danger,
}: {
  children: ReactNode;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
  danger?: boolean;
}) {
  return (
    <button
      type="button"
      className={danger ? dangerButtonClass : secondaryButtonClass}
      onClick={onClick}
      disabled={disabled}
      title={title}
    >
      {children}
    </button>
  );
}

/**
 * Confirmation dialog with Tabby's own chrome, for the handful of xhs-ops
 * actions that are consequential enough to double-check (they drive a real
 * phone, or delete a record) but too frequent to make the operator navigate
 * away for. Built on the app's Radix Dialog primitive rather than
 * `window.confirm` — the browser's own dialog can't be styled, carries no
 * branding, and freezes the whole tab (including this card's other rows)
 * while it's open.
 *
 * Deliberately synchronous to close: `onConfirm` fires and the dialog closes
 * immediately, exactly like the `window.confirm` call it replaces — any async
 * work it kicks off is tracked by the caller's own busy state, not by this
 * dialog staying open.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "确认",
  cancelLabel = "取消",
  onConfirm,
  danger,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  onConfirm: () => void;
  /** Style the confirm action as destructive (matches SecondaryButton's danger look). */
  danger?: boolean;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[420px]">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          {/* asChild swaps Radix's default <p> for a <div>: the description is
              often multiple <p> paragraphs, and <p> can't nest inside <p>. */}
          <DialogDescription asChild>
            <div className="text-[13px] leading-[1.6] text-text-secondary">
              {description}
            </div>
          </DialogDescription>
        </DialogBody>
        <DialogFooter>
          <SecondaryButton onClick={() => onOpenChange(false)}>
            {cancelLabel}
          </SecondaryButton>
          {danger ? (
            <SecondaryButton
              danger
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </SecondaryButton>
          ) : (
            <PrimaryButton
              onClick={() => {
                onOpenChange(false);
                onConfirm();
              }}
            >
              {confirmLabel}
            </PrimaryButton>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function NumberInput({
  value,
  onChange,
  min,
  max,
  disabled,
  ariaLabel,
  className,
}: {
  value: number;
  onChange: (next: number) => void;
  min: number;
  max: number;
  disabled?: boolean;
  ariaLabel?: string;
  className?: string;
}) {
  return (
    <input
      type="number"
      inputMode="numeric"
      className={`${inputClass} ${className ?? ""}`}
      value={Number.isFinite(value) ? value : ""}
      min={min}
      max={max}
      disabled={disabled}
      aria-label={ariaLabel}
      onChange={(e) => {
        const n = Number(e.target.value);
        if (e.target.value === "" || !Number.isFinite(n)) {
          onChange(min);
          return;
        }
        onChange(Math.min(max, Math.max(min, Math.round(n))));
      }}
    />
  );
}

/**
 * Chip list editor: shows the current values as removable chips; typing then
 * Enter / comma / blur adds one or more values (split on , ， 、 and newlines).
 */
export function ChipInput({
  value,
  onChange,
  placeholder,
  disabled,
  ariaLabel,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const [draft, setDraft] = useState("");

  const commit = () => {
    const parts = draft
      .split(/[,，、\n]/)
      .map((p) => p.trim())
      .filter((p) => p.length > 0 && !value.includes(p));
    if (parts.length > 0) onChange([...value, ...parts]);
    setDraft("");
  };

  return (
    <div
      className={`flex min-h-9 w-full flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-2 py-1.5 ${disabled ? "opacity-60" : ""}`}
    >
      {value.map((chip) => (
        <span
          key={chip}
          className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-surface-2 px-2.5 py-1 text-[12px] text-text-primary"
        >
          <span className="truncate">{chip}</span>
          {!disabled ? (
            <button
              type="button"
              aria-label={`移除 ${chip}`}
              className="shrink-0 rounded-full text-text-secondary hover:text-text-primary"
              onClick={() => onChange(value.filter((v) => v !== chip))}
            >
              <X size={12} />
            </button>
          ) : null}
        </span>
      ))}
      <input
        className="h-6 min-w-[80px] flex-1 bg-transparent text-[13px] text-text-primary outline-none placeholder:text-text-secondary"
        value={draft}
        placeholder={value.length === 0 ? placeholder : ""}
        disabled={disabled}
        aria-label={ariaLabel}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === ",") {
            e.preventDefault();
            commit();
          } else if (
            e.key === "Backspace" &&
            draft === "" &&
            value.length > 0
          ) {
            onChange(value.slice(0, -1));
          }
        }}
      />
    </div>
  );
}

// ── Status vocabulary ─────────────────────────────────────────

export const RUN_STATUS_LABEL: Record<XhsOpsRunStatus, string> = {
  planned: "已计划",
  running: "执行中",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

export const CHUNK_STATUS_LABEL: Record<XhsOpsChunkStatus, string> = {
  pending: "待执行",
  running: "执行中",
  completed: "完成",
  failed: "失败",
  skipped: "跳过",
  cancelled: "取消",
};

export const ANOMALY_LABEL: Record<XhsOpsAnomalyType, string> = {
  no_results: "无搜索结果",
  load_failed: "加载失败",
  login_required: "需要登录",
  account_restricted: "账号受限",
  rate_limited: "操作频繁",
  content_mismatch: "内容不匹配",
  interrupted: "执行中断",
  other: "其他",
};

export function runStatusLabel(status: string): string {
  return (RUN_STATUS_LABEL as Record<string, string>)[status] ?? status;
}

export function chunkStatusLabel(status: string): string {
  return (CHUNK_STATUS_LABEL as Record<string, string>)[status] ?? status;
}

export function anomalyLabel(type: string): string {
  return (ANOMALY_LABEL as Record<string, string>)[type] ?? type;
}

/** Map the xhs-ops status enums onto the shared A2UI status vocabulary. */
export function chunkStatusTone(
  status: XhsOpsChunkStatus | string,
): StatusTone {
  switch (status) {
    case "completed":
      return "done";
    case "running":
      return "running";
    case "failed":
      return "failed";
    case "skipped":
    case "cancelled":
      return "blocked";
    default:
      return "idle";
  }
}

export function runStatusTone(status: XhsOpsRunStatus | string): StatusTone {
  switch (status) {
    case "completed":
      return "done";
    case "running":
      return "running";
    case "failed":
      return "failed";
    // `planned` is queued-and-live (isRunActive counts it), so it must not
    // read the same as a run that will never start; `cancelled` matches
    // chunkStatusTone above rather than contradicting it in the same card.
    case "planned":
      return "waiting";
    case "cancelled":
    case "interrupted":
      return "blocked";
    default:
      return "idle";
  }
}

export function chunkDotClass(status: XhsOpsChunkStatus | string): string {
  return `a2ui-mark a2ui-mark--${chunkStatusTone(status)}`;
}

/** Status colour used as *text* is always the readable -ink variant. */
export function runStatusTextClass(status: XhsOpsRunStatus | string): string {
  switch (runStatusTone(status)) {
    case "done":
      return "text-[var(--color-success-ink)]";
    case "running":
      return "text-[var(--color-brand-ink)]";
    case "failed":
      return "text-[var(--color-error-ink)]";
    case "blocked":
      return "text-[var(--color-warning-ink)]";
    default:
      return "text-text-secondary";
  }
}

export function StatusDot({
  status,
  title,
}: {
  status: XhsOpsChunkStatus | string;
  title?: string;
}) {
  return <StatusMark tone={chunkStatusTone(status)} title={title} />;
}

/** Chunk / run status as a pill, label included. */
export function RunStatusPill({
  status,
  label,
}: {
  status: XhsOpsRunStatus | string;
  label: ReactNode;
}) {
  return <StatusPill tone={runStatusTone(status)}>{label}</StatusPill>;
}

// ── Time helpers ─────────────────────────────────────────────

export function formatClock(iso: string | number | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

export function formatDurationMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "—";
  if (ms < 60_000) return `${Math.round(ms / 1000)} 秒`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes} 分 ${seconds} 秒` : `${minutes} 分`;
}

// ── Devices ──────────────────────────────────────────────────

export interface XhsOpsDevice {
  deviceId: string;
  name?: string;
  model?: string;
  status: "idle" | "busy" | "error";
  lastSeen: number;
}

/** A phone that has not reported in for this long is shown as offline. */
const DEVICE_OFFLINE_AFTER_MS = 90_000;

export type DeviceOnlineState = "online" | "busy" | "offline";

export function deviceOnlineState(device: XhsOpsDevice): DeviceOnlineState {
  if (Date.now() - device.lastSeen > DEVICE_OFFLINE_AFTER_MS) return "offline";
  if (device.status === "busy") return "busy";
  return "online";
}

export const DEVICE_STATE_LABEL: Record<DeviceOnlineState, string> = {
  online: "在线",
  busy: "忙碌",
  offline: "离线",
};

export function deviceDisplayName(device: XhsOpsDevice): string {
  return device.name?.trim() || device.model?.trim() || device.deviceId;
}

/** Connected phones, refreshed every 10s (same cadence as XHSBatchTable). */
export function useXhsOpsDevices(): {
  devices: XhsOpsDevice[];
  error: string | null;
} {
  const { data, error } = useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const { data: d, error: e } = await getApiV1Devices();
      if (e || !d) throw new Error("设备列表加载失败");
      return d;
    },
    refetchInterval: 10_000,
  });
  return {
    devices: (data?.devices ?? []) as XhsOpsDevice[],
    error: error ? "设备列表加载失败，稍后自动重试" : null,
  };
}

// ── Prop access ───────────────────────────────────────────────

/**
 * Read one top-level prop off the A2UI component, resolving `{path}` data
 * bindings the same way built-in components do.
 */
export function readProp<T = unknown>(
  comp: unknown,
  resolve: <V>(val: V) => unknown,
  key: string,
): T | undefined {
  const raw = (comp as Record<string, unknown>)[key];
  if (raw === undefined || raw === null) return undefined;
  return resolve(raw) as T;
}
