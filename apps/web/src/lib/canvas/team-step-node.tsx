import { topologicalWaves } from "@/components/teams/workflow-dag-canvas";
import {
  useApproveWorkflowStep,
  useWorkflowApprovals,
} from "@/hooks/use-team-workflows";
import { useTeamBoard } from "@/hooks/use-teams";
import type { TeamRunInfo } from "@/lib/a2ui/custom-components/TeamRunPanel";
import { useState } from "react";
import {
  type CanvasNode,
  addNode,
  connectNodes,
  getCanvasState,
  setPanelOpen,
} from "./canvas-store";

/**
 * Team runs on the canvas (design doc §v2 follow-up): every step of a run is
 * its OWN canvas node and step dependencies are real canvas connections —
 * the run graph becomes first-class workbench material instead of a single
 * embedded panel. Node ids derive from card ids, so re-opening the same run
 * is idempotent.
 */

const WAVE_X_GAP = 340;
const WAVE_Y_GAP = 230;

export function stepNodeId(cardId: string): string {
  return `step-${cardId}`;
}

/** Expand a run into per-step nodes + dependency connections. Idempotent. */
export function pinTeamRunToCanvas(run: TeamRunInfo): void {
  const waves = topologicalWaves(
    run.steps.map((step) => ({
      id: step.id,
      name: step.name,
      assigneeSlug: step.assigneeName,
      dependsOn: step.dependsOn,
    })),
  );
  const columnByStepId = new Map<string, { col: number; row: number }>();
  waves.forEach((wave, col) => {
    wave.forEach((step, row) => {
      columnByStepId.set(step.id, { col, row });
    });
  });

  const existing = new Set(getCanvasState().nodes.map((node) => node.id));
  const cardByStepId = new Map(run.steps.map((step) => [step.id, step.cardId]));

  for (const step of run.steps) {
    const nodeId = stepNodeId(step.cardId);
    if (existing.has(nodeId)) continue;
    const slot = columnByStepId.get(step.id) ?? { col: 0, row: 0 };
    addNode({
      id: nodeId,
      type: "team-step",
      title: step.name,
      position: {
        x: 40 + slot.col * WAVE_X_GAP,
        y: 40 + slot.row * WAVE_Y_GAP,
      },
      metadata: {
        step: {
          teamId: run.teamId,
          cardId: step.cardId,
          stepId: step.id,
          runId: run.runId,
          workflowId: run.workflowId,
          assigneeName: step.assigneeName,
          isApproval: step.type === "approval",
        },
      },
    });
  }

  // Dependency edges (connectNodes dedupes, so this is idempotent too).
  for (const step of run.steps) {
    for (const upstream of step.dependsOn) {
      const fromCard = cardByStepId.get(upstream);
      if (!fromCard) continue;
      connectNodes(stepNodeId(fromCard), stepNodeId(step.cardId));
    }
  }
  setPanelOpen(true);
}

function statusLabel(status: string | undefined): string {
  switch (status) {
    case "done":
      return "✅ 已完成";
    case "running":
      return "⏳ 执行中";
    case "blocked":
      return "⚠️ 受阻";
    default:
      return "待开始";
  }
}

/** Live content of one team-step node: board card is the source of truth. */
export function TeamStepNodeContent({ node }: { node: CanvasNode }) {
  const step = node.metadata.step;
  const [settled, setSettled] = useState(false);
  const { data: board } = useTeamBoard(step ? step.teamId : null, {
    live: !settled,
  });
  const card = board?.cards.find((candidate) => candidate.id === step?.cardId);
  const { data: approvalsData } = useWorkflowApprovals(
    step?.workflowId ? step.teamId : null,
    !settled,
  );
  const approve = useApproveWorkflowStep();

  if (!step) return null;
  if (card?.status === "done" && !settled) {
    setSettled(true);
  }

  const pending = (approvalsData?.approvals ?? []).find(
    (approval) =>
      approval.runId === step.runId && approval.stepId === step.stepId,
  );

  return (
    <div className="flex h-full flex-col gap-2 text-xs">
      <div className="flex items-center justify-between gap-2">
        <span
          className="font-medium"
          data-step-node-status={card?.status ?? "pending"}
        >
          {statusLabel(card?.status)}
        </span>
        <span className="truncate text-text-tertiary">
          {step.isApproval ? "⏸ 审批" : step.assigneeName}
        </span>
      </div>

      {pending ? (
        <div className="flex items-center gap-2 rounded-md border border-[var(--color-warning-ink)]/[20%] bg-[var(--color-warning-ink)]/[6%] px-2 py-1.5">
          <span className="min-w-0 flex-1 truncate text-[11px]">
            {pending.prompt.slice(0, 50)}
          </span>
          <button
            type="button"
            disabled={approve.isPending}
            onClick={() =>
              approve.mutate({
                teamId: pending.teamId,
                workflowId: pending.workflowId,
                runId: pending.runId,
                stepId: pending.stepId,
              })
            }
            className="shrink-0 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-2 py-0.5 text-[11px] font-bold text-[var(--color-accent-fg)] hover:opacity-90 disabled:opacity-50"
          >
            {approve.isPending ? "批准中…" : "批准"}
          </button>
        </div>
      ) : null}

      <pre className="min-h-0 flex-1 overflow-y-auto whitespace-pre-wrap text-[11px] text-text-secondary">
        {card?.output ?? "（暂无产出）"}
      </pre>
    </div>
  );
}
