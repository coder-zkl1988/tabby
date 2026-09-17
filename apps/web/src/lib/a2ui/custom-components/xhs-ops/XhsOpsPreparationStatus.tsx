import type { XhsOpsRun } from "./xhs-ops-types";

export type XhsOpsPreparation = NonNullable<XhsOpsRun["preparation"]>;

const PREPARATION_LABEL: Record<XhsOpsPreparation["status"], string> = {
  running: "检查安装与登录",
  ready: "已就绪",
  blocked: "待人工处理",
  failed: "失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

const PREPARATION_CLASS: Record<XhsOpsPreparation["status"], string> = {
  running:
    "border-[var(--color-brand-primary)]/[20%] bg-[var(--color-brand-primary)]/[6%] text-[var(--color-brand-ink)]",
  ready:
    "border-[var(--color-success)]/[20%] bg-[var(--color-success)]/[6%] text-[var(--color-success-ink)]",
  blocked:
    "border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-ink)]/[6%] text-[var(--color-warning-ink)]",
  failed:
    "border-[var(--color-error)]/[20%] bg-[var(--color-error)]/[6%] text-[var(--color-error-ink)]",
  cancelled: "border-border bg-surface-2/60 text-text-secondary",
  interrupted:
    "border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-ink)]/[6%] text-[var(--color-warning-ink)]",
};

export function getRunPreparation(run: XhsOpsRun): XhsOpsPreparation | null {
  return run.preparation ?? null;
}

export function XhsOpsPreparationStatus({
  preparation,
}: {
  preparation: XhsOpsPreparation | null | undefined;
}) {
  if (!preparation) return null;
  return (
    <div
      data-testid="xhs-ops-preparation-status"
      className={`rounded-md border px-2.5 py-1.5 text-[12px] ${PREPARATION_CLASS[preparation.status]}`}
    >
      <span className="font-medium">
        启动检查：{PREPARATION_LABEL[preparation.status]}
      </span>
      {preparation.reason ? <span> · {preparation.reason}</span> : null}
    </div>
  );
}
