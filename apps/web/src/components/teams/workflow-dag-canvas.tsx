import { cn } from "@/lib/utils";

/** Minimal structural step shape — wire types leave defaults optional. */
export type DagStep = {
  id: string;
  name?: string;
  type?: "task" | "approval";
  assigneeSlug: string;
  dependsOn?: string[];
};

const NODE_W = 168;
const NODE_H = 60;
const COL_GAP = 72;
const ROW_GAP = 26;
const PAD = 16;

/**
 * Hand-rolled SVG DAG view (design doc P5 v1: read-only canvas with live
 * status lighting; editing stays in the form editor). Steps are laid out in
 * topological wave columns; edges follow `dependsOn`.
 */
export function WorkflowDagCanvas({
  steps,
  statusByStepId = {},
  selectedStepId,
  onSelectStep,
}: {
  steps: DagStep[];
  /** Workboard card status per step id (todo/ready/running/blocked/done…). */
  statusByStepId?: Record<string, string | undefined>;
  selectedStepId?: string | null;
  onSelectStep?: (stepId: string) => void;
}) {
  const waves = topologicalWaves(steps);
  const position = new Map<string, { x: number; y: number }>();
  waves.forEach((wave, columnIndex) => {
    wave.forEach((step, rowIndex) => {
      position.set(step.id, {
        x: PAD + columnIndex * (NODE_W + COL_GAP),
        y: PAD + rowIndex * (NODE_H + ROW_GAP),
      });
    });
  });
  const width =
    PAD * 2 + waves.length * NODE_W + Math.max(0, waves.length - 1) * COL_GAP;
  const height =
    PAD * 2 +
    Math.max(...waves.map((wave) => wave.length), 1) * (NODE_H + ROW_GAP) -
    ROW_GAP;

  return (
    <svg
      role="img"
      aria-label="workflow dag"
      viewBox={`0 0 ${width} ${height}`}
      className="w-full"
      style={{ maxWidth: width }}
      data-workflow-dag="true"
    >
      <title>workflow dag</title>
      {steps.flatMap((step) =>
        (step.dependsOn ?? []).map((upstream) => {
          const from = position.get(upstream);
          const to = position.get(step.id);
          if (!from || !to) {
            return null;
          }
          const x1 = from.x + NODE_W;
          const y1 = from.y + NODE_H / 2;
          const x2 = to.x;
          const y2 = to.y + NODE_H / 2;
          const mid = (x1 + x2) / 2;
          return (
            <path
              key={`${upstream}->${step.id}`}
              d={`M ${x1} ${y1} C ${mid} ${y1}, ${mid} ${y2}, ${x2} ${y2}`}
              fill="none"
              className="stroke-border"
              strokeWidth={1.5}
            />
          );
        }),
      )}
      {steps.map((step) => {
        const pos = position.get(step.id);
        if (!pos) {
          return null;
        }
        const status = statusByStepId[step.id];
        return (
          <g
            key={step.id}
            tabIndex={0}
            data-dag-node={step.id}
            data-dag-status={status ?? "pending"}
            transform={`translate(${pos.x}, ${pos.y})`}
            className="cursor-pointer"
            onClick={() => onSelectStep?.(step.id)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                onSelectStep?.(step.id);
              }
            }}
          >
            <rect
              width={NODE_W}
              height={NODE_H}
              rx={10}
              className={cn(
                "fill-background stroke-border",
                status === "done" && "stroke-[var(--color-success)]",
                status === "running" && "stroke-[var(--color-brand-primary)]",
                status === "blocked" && "stroke-[var(--color-warning-ink)]",
                selectedStepId === step.id && "stroke-foreground",
              )}
              strokeWidth={selectedStepId === step.id ? 2.5 : 1.5}
            />
            <text
              x={12}
              y={24}
              className="fill-foreground text-[13px] font-medium"
            >
              {truncate(step.name ?? step.id, 12)}
            </text>
            <text x={12} y={44} className="fill-muted-foreground text-[12px]">
              {step.type === "approval"
                ? "⏸ approval"
                : truncate(step.assigneeSlug, 20)}
            </text>
            <circle
              cx={NODE_W - 14}
              cy={16}
              r={5}
              className={cn(
                "fill-muted-foreground/40",
                status === "done" && "fill-[var(--color-success)]",
                status === "running" &&
                  "fill-[var(--color-brand-primary)] animate-pulse",
                status === "blocked" && "fill-[var(--color-warning-ink)]",
              )}
            />
          </g>
        );
      })}
    </svg>
  );
}

/** Client-side Kahn waves; cycles degrade to a flat trailing wave. */
export function topologicalWaves(steps: DagStep[]): DagStep[][] {
  const placed = new Set<string>();
  const waves: DagStep[][] = [];
  let remaining = steps;
  while (remaining.length > 0) {
    const wave = remaining.filter((step) =>
      (step.dependsOn ?? []).every((dep) => placed.has(dep)),
    );
    if (wave.length === 0) {
      waves.push(remaining); // defensive: bad data — render rather than hang
      break;
    }
    for (const step of wave) {
      placed.add(step.id);
    }
    waves.push(wave);
    remaining = remaining.filter((step) => !placed.has(step.id));
  }
  return waves;
}

function truncate(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}
