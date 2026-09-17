import { WorkflowDagCanvas } from "@/components/teams/workflow-dag-canvas";
import {
  useApproveWorkflowStep,
  useWorkflowApprovals,
} from "@/hooks/use-team-workflows";
import { useTeamBoard } from "@/hooks/use-teams";
import { rollupRunStatus } from "@/lib/team-run-status";
import { useState } from "react";
import { StatusPill, type StatusTone } from "../a2ui-status";
import type { CustomComponentProps } from "./registry";

/**
 * Static identity + step skeleton of one team run, as emitted by the
 * nexu-team runtime plugin (buildTeamRunCard). Live status (card states,
 * approvals, outputs) is polled from the controller by the components — the
 * model is never in the loop after the run starts.
 */
export type TeamRunInfo = {
  teamId: string;
  boardId: string;
  parentCardId: string;
  title: string;
  runId?: string;
  workflowId?: string;
  steps: Array<{
    id: string;
    name: string;
    assigneeName: string;
    cardId: string;
    dependsOn: string[];
    type?: string;
  }>;
};

export function parseTeamRunInfo(value: unknown): TeamRunInfo | null {
  const run = value as TeamRunInfo | null | undefined;
  if (!run || !run.teamId || !Array.isArray(run.steps)) {
    return null;
  }
  return run;
}

type BoardCard = {
  id: string;
  status: string;
  output?: string | null;
};

export function useTeamRunStatus(run: TeamRunInfo | null) {
  // Poll while the run is live; a finished (or dead) run stops polling after
  // the terminal snapshot is in cache.
  const [settled, setSettled] = useState(false);
  const { data: board } = useTeamBoard(run ? run.teamId : null, {
    live: !settled,
  });
  const cardsById = new Map<string, BoardCard>(
    (board?.cards ?? []).map((card) => [card.id, card as BoardCard]),
  );
  const statusByStepId: Record<string, string | undefined> = {};
  for (const step of run?.steps ?? []) {
    statusByStepId[step.id] = cardsById.get(step.cardId)?.status;
  }
  const steps = run?.steps ?? [];
  // Overall status is a rollup of the child step cards, NOT the parent
  // orchestration card (which the workboard marks `done` on decompose).
  const runStatus = rollupRunStatus(
    steps.map((step) => statusByStepId[step.id]),
  );
  const allDone = runStatus === "done";
  const anyBlocked = runStatus === "blocked";
  if (board && allDone && !settled) {
    setSettled(true);
  }
  return { cardsById, statusByStepId, allDone, anyBlocked };
}

export function exportRunMarkdown(
  run: TeamRunInfo,
  cardsById: Map<string, BoardCard>,
) {
  const sections = run.steps.map((step) => {
    const output = cardsById.get(step.cardId)?.output;
    return `## ${step.name}\n\n${output ?? "(无产出)"}`;
  });
  const markdown = `# ${run.title}\n\n${sections.join("\n\n")}\n`;
  const blob = new Blob([markdown], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${run.title}.md`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Approval rows for this run + the approve action (straight REST, no model). */
export function useRunApprovals(run: TeamRunInfo | null, active: boolean) {
  const { data } = useWorkflowApprovals(
    run?.workflowId ? run.teamId : null,
    active,
  );
  const approve = useApproveWorkflowStep();
  const pending = (data?.approvals ?? []).filter(
    (approval) => run && approval.runId === run.runId,
  );
  return { pending, approve };
}

/**
 * Workspace-sidebar run detail panel: full DAG with live lighting, per-step
 * outputs, approval banners and Markdown export. Opened from a TeamRunCard in
 * chat or from the team page; it lives in the A2UI sidebar (workspace-layout
 * level), so it survives route changes.
 */
export function TeamRunPanel({ comp, resolve }: CustomComponentProps) {
  const run = parseTeamRunInfo(resolve((comp as { run?: unknown }).run));
  const { cardsById, statusByStepId, allDone, anyBlocked } =
    useTeamRunStatus(run);
  const { pending, approve } = useRunApprovals(run, !allDone);
  const [selectedStepId, setSelectedStepId] = useState<string | null>(null);

  if (!run) return null;

  const selectedStep = run.steps.find((step) => step.id === selectedStepId);
  const selectedCard = selectedStep ? cardsById.get(selectedStep.cardId) : null;

  // Same four states, same order of precedence, as TeamRunCard — the two
  // render the same run and must never disagree about it.
  const [runTone, runLabel]: [StatusTone, string] = allDone
    ? ["done", "已完成"]
    : anyBlocked && pending.length === 0
      ? ["blocked", "有步骤受阻"]
      : pending.length > 0
        ? ["waiting", "等待审批"]
        : ["running", "团队执行中"];

  return (
    <div
      className="flex h-full flex-col gap-3 overflow-y-auto p-3"
      data-team-run-panel={run.parentCardId}
    >
      <div className="flex items-center justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1.5">
          <div className="truncate text-[15px] font-semibold leading-[1.4] text-text-heading">
            {run.title}
          </div>
          <StatusPill tone={runTone} className="self-start">
            {runLabel}
          </StatusPill>
        </div>
        {allDone ? (
          <button
            type="button"
            onClick={() => exportRunMarkdown(run, cardsById)}
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs font-medium hover:bg-surface-2"
          >
            导出 Markdown
          </button>
        ) : null}
      </div>

      {pending.map((approval) => (
        <div
          key={`${approval.runId}:${approval.stepId}`}
          className="flex items-center gap-2 rounded-md border border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-wash)] px-3 py-2"
        >
          <div className="min-w-0 flex-1 text-xs">
            <span className="font-medium">等待人工审批</span>
            <span className="ml-2 text-text-secondary">
              {approval.prompt.slice(0, 100)}
            </span>
          </div>
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
            className="shrink-0 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-2 py-1 text-xs font-bold text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-50"
          >
            {approve.isPending ? "批准中…" : "批准"}
          </button>
        </div>
      ))}

      <WorkflowDagCanvas
        steps={run.steps.map((step) => ({
          id: step.id,
          name: step.name,
          type: step.type === "approval" ? ("approval" as const) : undefined,
          assigneeSlug: step.assigneeName,
          dependsOn: step.dependsOn,
        }))}
        statusByStepId={statusByStepId}
        selectedStepId={selectedStepId}
        onSelectStep={setSelectedStepId}
      />

      {selectedStep ? (
        <div className="rounded-md border bg-surface-2/50 p-3">
          <div className="mb-1 text-xs font-medium text-text-secondary">
            {selectedStep.name} · {statusByStepId[selectedStep.id] ?? "pending"}
          </div>
          <pre className="max-h-72 overflow-y-auto whitespace-pre-wrap text-xs">
            {selectedCard?.output ?? "（暂无产出）"}
          </pre>
        </div>
      ) : (
        <p className="text-xs text-text-secondary">点击步骤节点查看产出。</p>
      )}
    </div>
  );
}
