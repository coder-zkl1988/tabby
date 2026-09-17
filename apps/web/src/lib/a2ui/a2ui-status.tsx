/**
 * A2UI status / feedback primitives, shared by the built-in components and
 * the custom cards (TeamRunCard, the xhs-ops family).
 *
 * These exist because status used to be spelled with emoji — "⏳ 团队执行中…",
 * "✅ 已完成", "⚠️ 有步骤受阻", "⏸ 等待审批" — which put four different
 * typefaces on screen, left colour out of the meaning, and rendered
 * differently per platform. Here each meaning is a shape *and* a colour, so
 * it survives greyscale and colour-blindness, and the same marks reuse in
 * table status columns and DAG step rows.
 *
 * The styling lives in a2ui.css (.a2ui-status-pill / .a2ui-mark / …); this
 * file is only the vocabulary.
 */
import type { ReactNode } from "react";

/**
 * solid circle = done · pulsing circle = running · diamond = blocked ·
 * double bar = waiting on something outside this card (an approval, a
 * device queue) · square = failed · hollow = not started
 */
export type StatusTone =
  | "running"
  | "done"
  | "blocked"
  | "waiting"
  | "failed"
  | "idle";

/** The bare mark, for step rows and table cells where a pill is too heavy. */
export function StatusMark({
  tone,
  title,
}: {
  tone: StatusTone;
  title?: string;
}) {
  return <span title={title} className={`a2ui-mark a2ui-mark--${tone}`} />;
}

/** Mark + label in one tinted pill. */
export function StatusPill({
  tone,
  children,
  title,
  className,
}: {
  tone: StatusTone;
  children: ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={`a2ui-status-pill a2ui-status-pill--${tone} ${className ?? ""}`}
    >
      <span className={`a2ui-mark a2ui-mark--${tone}`} />
      {children}
    </span>
  );
}

/**
 * Loading placeholder that keeps the shape of what is coming.
 *
 * `label` is what the old "正在加载…" text line used to say. It rides along
 * as sr-only text *inside* the region, not as an aria-label: <output> is a
 * live region, and a live region announces its content — an aria-label only
 * names it, so a region whose children are all aria-hidden says nothing.
 */
export function Skeleton({
  rows = 2,
  label,
}: { rows?: number; label: string }) {
  return (
    // <output> carries role="status" natively, so the label is announced
    // without an explicit role.
    <output className="flex flex-col gap-2" data-loading={label}>
      <span className="sr-only">{label}</span>
      <span className="a2ui-skeleton a2ui-skeleton--label" aria-hidden />
      {Array.from({ length: rows }, (_, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder rows, no identity
          key={i}
          className="a2ui-skeleton a2ui-skeleton--row"
          aria-hidden
        />
      ))}
    </output>
  );
}

/** In-button progress mark; replaces the "保存中…" text ellipsis. */
export function Spinner() {
  return <span className="a2ui-spinner" aria-hidden />;
}

/**
 * "Nothing here yet." Deliberately has no icon and no button: these sit
 * inside cards that already carry the next action right below them, so a
 * second call-to-action would only compete. What it buys is legibility —
 * 13px on a wash, instead of an 11px grey line that reads as forgotten.
 */
export function EmptyState({ children }: { children: ReactNode }) {
  return <div className="a2ui-empty">{children}</div>;
}
