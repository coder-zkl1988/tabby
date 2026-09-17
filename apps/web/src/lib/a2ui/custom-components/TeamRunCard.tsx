import { pinTeamRunToCanvas } from "@/lib/canvas/team-step-node";
import {
  Spinner,
  StatusMark,
  StatusPill,
  type StatusTone,
} from "../a2ui-status";
import {
  exportRunMarkdown,
  parseTeamRunInfo,
  useRunApprovals,
  useTeamRunStatus,
} from "./TeamRunPanel";
import type { CustomComponentProps } from "./registry";

/**
 * `waiting` means "this row is asking you for something right now", so it
 * comes from the live approvals set — not from `step.type === "approval"`,
 * which is a static DAG property and would mark every gate in the run even
 * though only one of them can be acted on.
 */
function stepTone(
  status: string | undefined,
  awaitingApproval: boolean,
): StatusTone {
  if (awaitingApproval) return "waiting";
  switch (status) {
    case "done":
      return "done";
    case "running":
      return "running";
    case "blocked":
      return "blocked";
    default:
      return "idle";
  }
}

/**
 * In-chat run snapshot card. Rendered from a team_run_auto /
 * team_run_workflow tool result; polls the board itself for step lighting,
 * shows approval buttons inline (straight REST — the model is not involved),
 * and opens the full DAG panel in the workspace sidebar.
 */
export function TeamRunCard({ comp, resolve }: CustomComponentProps) {
  const run = parseTeamRunInfo(resolve((comp as { run?: unknown }).run));
  const { cardsById, statusByStepId, allDone, anyBlocked } =
    useTeamRunStatus(run);
  const { pending, approve } = useRunApprovals(run, !allDone);

  if (!run) return null;

  const lastStep = run.steps[run.steps.length - 1];
  const finalOutput = lastStep ? cardsById.get(lastStep.cardId)?.output : null;

  const pendingStepIds = new Set(pending.map((a) => a.stepId));

  const [runTone, runLabel]: [StatusTone, string] = allDone
    ? ["done", "已完成"]
    : anyBlocked && pending.length === 0
      ? ["blocked", "有步骤受阻"]
      : pending.length > 0
        ? ["waiting", "等待审批"]
        : ["running", "团队执行中"];

  return (
    // 360 is the *ceiling*, not a fixed width: the inline host floors at
    // min-w-[20rem] (320), so a fixed w-[360px] silently loses 40px —
    // "查看详情" and the assignee names go first.
    //
    // Deliberately NOT `a2ui-framed`: that marker promises the card fills
    // the host, and this one caps at 360 inside a bubble up to 704 wide.
    // Marking it made the host drop its padding and left 343px of empty
    // bordered white beside the card.
    <div
      className="flex w-full max-w-[360px] flex-col overflow-hidden rounded-xl border border-border bg-surface-1"
      data-team-run-card={run.parentCardId}
    >
      <div className="flex items-start justify-between gap-3 border-b border-border-subtle px-4 py-3.5">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="truncate text-[15px] font-semibold leading-[1.4] text-text-heading">
            {run.title}
          </div>
          <StatusPill tone={runTone} className="self-start">
            {runLabel}
          </StatusPill>
        </div>
        <button
          type="button"
          onClick={() => pinTeamRunToCanvas(run)}
          className="inline-flex h-7 shrink-0 items-center rounded-md border border-border-strong px-2.5 text-[12px] font-medium text-text-primary transition-colors hover:border-[var(--color-accent)]"
        >
          查看详情
        </button>
      </div>

      <div className="flex flex-col px-4 py-2">
        {run.steps.map((step) => (
          <div
            key={step.id}
            data-run-step={step.id}
            data-run-step-status={statusByStepId[step.id] ?? "pending"}
            className="flex h-7 items-center gap-2.5 text-[13px]"
          >
            <StatusMark
              tone={stepTone(
                statusByStepId[step.id],
                pendingStepIds.has(step.id),
              )}
            />
            <span className="min-w-0 flex-1 truncate text-text-primary">
              {step.name}
            </span>
            <span className="shrink-0 text-[12px] text-text-secondary">
              {step.assigneeName}
            </span>
          </div>
        ))}
      </div>

      {pending.map((approval) => (
        <div
          key={`${approval.runId}:${approval.stepId}`}
          className="flex flex-col gap-3 border-t border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-ink)]/[6%] px-4 py-3.5"
        >
          <span className="text-[13px] leading-[1.55] text-text-primary">
            {approval.prompt.slice(0, 60)}
          </span>
          {/* 36px, not the 20px this used to be: approving a step is the
              least reversible thing this card can do. */}
          <button
            type="button"
            disabled={approve.isPending}
            onClick={() =>
              approve.mutate({
                teamId: approval.teamId,
                workflowId: approval.workflowId,
                runId: approval.runId,
                stepId: approval.stepId,
              })
            }
            className="inline-flex h-9 shrink-0 items-center justify-center gap-2 self-start rounded-lg bg-[var(--color-accent)] px-5 text-[13px] font-semibold text-[var(--color-accent-fg)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
          >
            {approve.isPending ? <Spinner /> : null}
            {approve.isPending ? "批准中" : "批准"}
          </button>
        </div>
      ))}

      {allDone && finalOutput ? (
        <div className="flex flex-col gap-2 border-t border-border-subtle px-4 py-3.5">
          <pre className="max-h-24 overflow-hidden whitespace-pre-wrap text-[12px] leading-[1.5] text-text-secondary">
            {finalOutput.slice(0, 160)}
            {finalOutput.length > 160 ? "…" : ""}
          </pre>
          <button
            type="button"
            onClick={() => exportRunMarkdown(run, cardsById)}
            className="inline-flex h-7 items-center self-start rounded-md border border-border-strong px-2.5 text-[12px] font-medium text-text-primary transition-colors hover:border-[var(--color-accent)]"
          >
            导出 Markdown
          </button>
        </div>
      ) : null}
    </div>
  );
}
