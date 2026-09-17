import { useCallback, useEffect, useMemo, useState } from "react";
import type { CustomComponentProps } from "../registry";
import {
  XhsOpsPreparationStatus,
  getRunPreparation,
} from "./XhsOpsPreparationStatus";
import { describeXhsOpsError, xhsOpsApi } from "./xhs-ops-api";
import {
  DASHBOARD_DAY_OPTIONS,
  DASHBOARD_MAX_DAYS,
  type DashboardCell,
  type DashboardRow,
  KEYWORD_VERDICT_LABEL,
  type KeywordStat,
  type ObservationEntry,
  buildRunMatrix,
  chunkTitle,
  collectObservations,
  keywordStats,
  lastNDates,
  shortDate,
  sumTotals,
  summarizeAnomalies,
} from "./xhs-ops-dashboard-data";
import {
  ProjectPicker,
  pickProjectByName,
  useProjectResolution,
} from "./xhs-ops-project-picker";
import {
  type XhsOpsAccount,
  type XhsOpsProject,
  type XhsOpsRun,
  asInt,
  asString,
  isRunActive,
  segmentLabel,
} from "./xhs-ops-types";
import {
  CardShell,
  EmptyState,
  ErrorLine,
  SecondaryButton,
  SectionTitle,
  Skeleton,
  StatusDot,
  StatusMark,
  anomalyLabel,
  chunkStatusLabel,
  formatClock,
  formatDurationMs,
  readProp,
  runStatusLabel,
  runStatusTextClass,
  textareaClass,
} from "./xhs-ops-ui";

const ACTIVE_POLL_MS = 5_000;
const OBSERVATION_PREVIEW = 8;

/**
 * P2-2 复盘看板：只读地把一个项目在最近 N 天的运行记录摊开成
 * 「账号 × 日期」矩阵 + 关键词表现 + 异常汇总 + 观察时间线，让运营不看聊天
 * 记录就能判断推荐流是否在靠近目标兴趣、该不该改兴趣池。唯一的写操作是给
 * 选中的运行补「运营备注」（PATCH notes），保存后上报
 * `xhs_ops_dashboard_note_saved`。数据全部来自 GET /runs，不派发任何任务。
 */
export function XhsOpsDashboard({
  comp,
  resolve,
  onAction,
}: CustomComponentProps) {
  const propProjectId = asString(readProp(comp, resolve, "projectId"));
  const projectName = asString(readProp(comp, resolve, "projectName")).trim();
  const onlyAccountId = asString(readProp(comp, resolve, "accountId")) || null;
  const initialDays = asInt(
    readProp(comp, resolve, "days"),
    7,
    1,
    DASHBOARD_MAX_DAYS,
  );

  // Agent 在新会话里通常拿不到 projectId：按 projectName 匹配或让用户点选。
  const resolution = useProjectResolution(propProjectId, projectName);
  const projectId = resolution.projectId;

  const [days, setDays] = useState(initialDays);
  const [project, setProject] = useState<XhsOpsProject | null>(null);
  const [accounts, setAccounts] = useState<XhsOpsAccount[] | null>(null);
  const [runs, setRuns] = useState<XhsOpsRun[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selected, setSelected] = useState<{
    accountId: string;
    date: string;
  } | null>(null);
  const [showAllObservations, setShowAllObservations] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) {
      setProject(null);
      setAccounts(null);
      setRuns(null);
      return;
    }
    try {
      const [p, a, r] = await Promise.all([
        xhsOpsApi.getProject(projectId).catch(() => null),
        xhsOpsApi.listAccounts(projectId),
        xhsOpsApi.listRuns({ projectId }),
      ]);
      setProject(p);
      setAccounts(onlyAccountId ? a.filter((x) => x.id === onlyAccountId) : a);
      setRuns(
        onlyAccountId ? r.filter((x) => x.accountId === onlyAccountId) : r,
      );
      setLoadError(null);
    } catch (err) {
      setAccounts((prev) => prev ?? []);
      setRuns((prev) => prev ?? []);
      setLoadError(describeXhsOpsError(err, "运行记录加载失败"));
    }
  }, [projectId, onlyAccountId]);

  useEffect(() => {
    void load();
  }, [load]);

  // 有执行中的 run 时轻量轮询，让看板跟着当日进度走。
  const hasActive = (runs ?? []).some((r) => isRunActive(r.status));
  useEffect(() => {
    if (!hasActive) return;
    const timer = setInterval(() => void load(), ACTIVE_POLL_MS);
    return () => clearInterval(timer);
  }, [hasActive, load]);

  const dates = useMemo(() => lastNDates(days), [days]);
  const runsInRange = useMemo(() => {
    const set = new Set(dates);
    return (runs ?? []).filter((r) => set.has(r.date));
  }, [runs, dates]);
  const rows = useMemo(
    () => buildRunMatrix(accounts ?? [], runs ?? [], dates),
    [accounts, runs, dates],
  );
  const totals = useMemo(() => sumTotals(rows), [rows]);
  const anomalies = useMemo(
    () => summarizeAnomalies(runsInRange),
    [runsInRange],
  );
  const observations = useMemo(
    () => collectObservations(runsInRange),
    [runsInRange],
  );
  const { keywords, home } = useMemo(
    () => keywordStats(runsInRange, accounts ?? []),
    [runsInRange, accounts],
  );

  const selectedCell: DashboardCell | null = useMemo(() => {
    if (!selected) return null;
    const row = rows.find((r) => r.accountId === selected.accountId);
    return row?.cells.find((c) => c.date === selected.date) ?? null;
  }, [rows, selected]);

  const toggleSelected = (accountId: string, date: string) =>
    setSelected((prev) =>
      prev && prev.accountId === accountId && prev.date === date
        ? null
        : { accountId, date },
    );

  const replaceRun = (next: XhsOpsRun) =>
    setRuns((prev) =>
      prev ? prev.map((r) => (r.id === next.id ? next : r)) : prev,
    );

  const loading = accounts === null || runs === null;
  const rangeLabel = `${shortDate(dates[0] ?? "")} ~ ${shortDate(dates[dates.length - 1] ?? "")}`;

  return (
    <CardShell
      testId="dashboard"
      title="养号复盘看板"
      subtitle={
        project
          ? `${project.name} · 最近 ${days} 天（${rangeLabel}）`
          : `最近 ${days} 天（${rangeLabel}）`
      }
      actions={
        <div className="flex items-center gap-1">
          {DASHBOARD_DAY_OPTIONS.map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => setDays(d)}
              className={`h-7 rounded-md border px-3 text-[12px] ${
                days === d
                  ? "border-[var(--color-brand-primary)] bg-[var(--color-brand-wash)] font-medium text-[var(--color-brand-ink)]"
                  : "border-border-strong bg-surface-1 text-text-secondary hover:border-[var(--color-accent)]"
              }`}
            >
              {d} 天
            </button>
          ))}
        </div>
      }
    >
      <ErrorLine message={loadError ?? resolution.error} />
      {!projectId ? (
        <ProjectPicker
          resolution={{
            ...resolution,
            pick: (id) => {
              resolution.pick(id);
              setSelected(null);
            },
          }}
          wanted={projectName}
          purpose="复盘"
        />
      ) : loading ? (
        <Skeleton rows={3} label="正在加载运行记录" />
      ) : null}

      {projectId && !loading ? (
        <div className="@container flex flex-col gap-4">
          {/* 达成率 leads at 1.4fr: it is the one number that answers "is
              the plan being met", and five equal tiles made 异常 read as
              exactly as important as 运行次数. All five stay — the ratio
              carries the ranking, not omission. Under 480px the row breaks
              to 达成率 + a 2×2 block instead of five ~50px columns. */}
          <div className="grid grid-cols-2 gap-2 @min-[480px]:grid-cols-[1.4fr_1fr_1fr_1fr_1fr] @min-[480px]:gap-3">
            <div className="col-span-2 flex flex-col gap-2 rounded-[10px] border border-border-subtle bg-surface-1 px-3.5 py-3 @min-[480px]:col-span-1">
              <span className="text-[12px] text-text-secondary">达成率</span>
              <div className="flex items-baseline gap-1.5">
                <span className="font-mono text-[24px] font-bold leading-none text-text-heading">
                  {totals.planned > 0
                    ? `${Math.round((totals.browsed / totals.planned) * 100)}%`
                    : "—"}
                </span>
                <span className="text-[12px] text-text-secondary">
                  {totals.browsed} / {totals.planned}
                </span>
              </div>
              <span className="h-1 overflow-hidden rounded-sm bg-surface-3">
                <span
                  className="block h-1 bg-[var(--color-brand-primary)]"
                  style={{
                    width: `${
                      totals.planned > 0
                        ? Math.min(
                            100,
                            Math.round((totals.browsed / totals.planned) * 100),
                          )
                        : 0
                    }%`,
                  }}
                />
              </span>
            </div>
            <Stat label="运行次数" value={String(totals.runs)} />
            <Stat label="首页推荐" value={String(totals.home)} />
            <Stat label="互动" value={String(totals.interactions)} />
            <Stat
              label="异常"
              value={String(totals.anomalies)}
              tone={totals.anomalies > 0 ? "warn" : undefined}
            />
          </div>

          <div className="flex flex-col gap-2">
            <SectionTitle hint="实际/计划 与首页推荐数；点格子看当日明细">
              账号 × 日期
            </SectionTitle>
            {rows.length === 0 ? (
              <EmptyState>
                {runsInRange.length === 0
                  ? "所选范围内没有运行记录；先在「今日浏览计划」里执行一次。"
                  : "没有可展示的账号。"}
              </EmptyState>
            ) : (
              <>
                {/* Two layouts, one data set. Narrow drops the table (its
                    min-w-max scroll hides today's column in a sidebar) for
                    per-account day strips that always fit. */}
                <div className="@min-[480px]:hidden">
                  <MatrixStrips
                    rows={rows}
                    selected={selected}
                    onSelect={toggleSelected}
                  />
                </div>
                <div className="hidden @min-[480px]:block">
                  <MatrixTable
                    rows={rows}
                    dates={dates}
                    selected={selected}
                    onSelect={toggleSelected}
                  />
                </div>
              </>
            )}
          </div>

          {selectedCell && selected ? (
            <CellDetail
              accountLabel={
                rows.find((r) => r.accountId === selected.accountId)?.label ??
                selected.accountId
              }
              cell={selectedCell}
              onRunChange={replaceRun}
              onAction={onAction}
            />
          ) : null}

          <KeywordTable keywords={keywords} home={home} />

          {anomalies.length > 0 ? (
            <div className="flex flex-col gap-1">
              <SectionTitle hint="按类型汇总，附最近一次出现的位置">
                异常汇总
              </SectionTitle>
              <ul className="flex flex-col gap-0.5 text-[12px]">
                {anomalies.map((a) => (
                  <li key={a.type} className="flex items-start gap-2">
                    <span className="shrink-0 rounded-full bg-[var(--color-warning-wash)] px-1.5 text-[12px] text-[var(--color-warning-ink)]">
                      {anomalyLabel(a.type)} × {a.count}
                    </span>
                    {a.latest ? (
                      <span className="min-w-0 text-text-secondary">
                        最近 {shortDate(a.latest.date)} ·{" "}
                        {a.latest.accountLabel} · {a.latest.chunk}
                        {a.latest.detail ? ` · ${a.latest.detail}` : ""}
                      </span>
                    ) : null}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}

          <ObservationTimeline
            entries={observations}
            showAll={showAllObservations}
            onToggle={() => setShowAllObservations((v) => !v)}
          />
        </div>
      ) : null}
    </CardShell>
  );
}

// Re-exported so existing imports/tests keep working.
export { pickProjectByName };

// ── Matrix ────────────────────────────────────────────────────

/** Beyond this many accounts the roomy row stops fitting on one screen. */
const MATRIX_COMPACT_ABOVE_ROWS = 6;

/**
 * Attainment answers "did the day hit its plan", but a failed run that
 * still met the number is not a green day — `cell.status` is the
 * severity-ranked worst status of the day, so failure outranks the count.
 */
function cellBarClass(cell: DashboardCell): string {
  if (cell.status === "failed") return "bg-[var(--color-error)]";
  if (cell.status === "running") {
    return "bg-[var(--color-brand-primary)] animate-pulse";
  }
  if (cell.status === "cancelled" || cell.status === "interrupted") {
    return "bg-[var(--color-warning-ink)]";
  }
  if (cell.planned > 0 && cell.browsed >= cell.planned) {
    return "bg-[var(--color-success)]";
  }
  return "bg-[var(--color-warning-ink)]";
}

/** The day's status name, back in the tooltip the StatusDot used to carry. */
function cellTitle(cell: DashboardCell): string {
  if (cell.runs.length === 0) return "无运行";
  const status = cell.status ? `${runStatusLabel(cell.status)} · ` : "";
  return `${status}${cell.browsed}/${cell.planned} · 首页 ${cell.home} · 互动 ${cell.interactions} · 异常 ${cell.anomalies}`;
}

/**
 * Narrow layout (< 480px container: a dragged-down sidebar, a canvas node).
 * The wide table's `min-w-max` scroll puts today's column and 合计 outside
 * the viewport exactly when the sidebar is narrow, so here each account
 * becomes a row of day cells that always fit: totals move up to the
 * account line, and 首 N per day moves behind the tap.
 */
function MatrixStrips({
  rows,
  selected,
  onSelect,
}: {
  rows: DashboardRow[];
  selected: { accountId: string; date: string } | null;
  onSelect: (accountId: string, date: string) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      {rows.map((row) => (
        <div key={row.accountId} className="flex flex-col gap-2">
          <div className="flex items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-2">
              <StatusMark
                tone={row.bound && row.exists ? "done" : "idle"}
                title={!row.exists ? "已删除" : row.bound ? "已绑定" : "未绑定"}
              />
              <span
                className="truncate text-[13px] font-medium text-text-primary"
                title={row.label}
              >
                {row.label}
              </span>
            </div>
            <span className="shrink-0 font-mono text-[12px] text-text-secondary">
              {row.totals.browsed}/{row.totals.planned} · 首 {row.totals.home} ·
              互 {row.totals.interactions}
            </span>
          </div>
          <div
            className="grid gap-1"
            style={{
              gridTemplateColumns: `repeat(${row.cells.length}, minmax(0, 1fr))`,
            }}
          >
            {row.cells.map((cell) => {
              const isSel =
                selected?.accountId === row.accountId &&
                selected?.date === cell.date;
              const empty = cell.runs.length === 0;
              const pct =
                cell.planned > 0
                  ? Math.min(
                      100,
                      Math.round((cell.browsed / cell.planned) * 100),
                    )
                  : 0;
              return (
                <button
                  key={cell.date}
                  type="button"
                  disabled={empty}
                  onClick={() => onSelect(row.accountId, cell.date)}
                  title={cellTitle(cell)}
                  className={`flex flex-col items-center gap-[3px] rounded ${
                    isSel ? "bg-[var(--color-brand-subtle)]" : ""
                  }`}
                >
                  <span className="font-mono text-[12px] font-medium text-text-primary">
                    {empty ? (
                      <span className="text-text-secondary">—</span>
                    ) : (
                      cell.browsed
                    )}
                  </span>
                  <span className="h-[3px] w-full overflow-hidden rounded-sm bg-surface-3">
                    {empty ? null : (
                      <span
                        className={`block h-[3px] ${cellBarClass(cell)}`}
                        style={{ width: `${pct}%` }}
                      />
                    )}
                  </span>
                  <span
                    className={`font-mono text-[12px] ${
                      cell.anomalies > 0
                        ? "text-[var(--color-warning-ink)]"
                        : "text-text-secondary"
                    }`}
                  >
                    {shortDate(cell.date).slice(-2)}
                    {cell.anomalies > 0 ? " 异" : ""}
                  </span>
                </button>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * The question this grid answers is "is the recommend feed drifting toward
 * the target interests", so 首页推荐数 has to stay visible in the cell —
 * it cannot move behind a click. 互动 does move out (the keyword table
 * already sums it), which buys the room for the completion bar.
 *
 * Rows run ~56px so a day is scannable; past six accounts that no longer
 * fits a screen, and the grid falls back to a 36px compact row.
 */
function MatrixTable({
  rows,
  dates,
  selected,
  onSelect,
}: {
  rows: DashboardRow[];
  dates: string[];
  selected: { accountId: string; date: string } | null;
  onSelect: (accountId: string, date: string) => void;
}) {
  const compact = rows.length > MATRIX_COMPACT_ABOVE_ROWS;
  const cellPad = compact ? "px-2 py-1.5" : "px-2.5 py-2";
  const edgePad = compact ? "px-2.5 py-1.5" : "px-3 py-2";

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-[13px]">
          <thead>
            <tr className="bg-surface-0 text-text-secondary">
              <th
                className={`sticky left-0 z-10 bg-surface-0 text-left text-[12px] font-medium ${edgePad}`}
              >
                账号
              </th>
              {dates.map((d) => (
                <th
                  key={d}
                  className={`text-center font-mono text-[12px] font-medium ${cellPad}`}
                >
                  {shortDate(d)}
                </th>
              ))}
              <th className={`text-right text-[12px] font-medium ${edgePad}`}>
                合计
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.accountId} className="border-t border-border-subtle">
                <td
                  className={`sticky left-0 z-10 max-w-[180px] bg-surface-1 ${edgePad}`}
                >
                  <div className="flex items-center gap-2">
                    <StatusMark
                      tone={row.bound && row.exists ? "done" : "idle"}
                      title={
                        !row.exists ? "已删除" : row.bound ? "已绑定" : "未绑定"
                      }
                    />
                    <span
                      className="min-w-0 truncate text-text-primary"
                      title={row.label}
                    >
                      {row.label}
                    </span>
                    {row.exists && !row.bound ? (
                      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[12px] text-text-secondary">
                        未绑定
                      </span>
                    ) : null}
                    {!row.exists ? (
                      <span className="shrink-0 rounded-full bg-surface-2 px-2 py-0.5 text-[12px] text-text-secondary">
                        已删除
                      </span>
                    ) : null}
                  </div>
                </td>
                {row.cells.map((cell) => {
                  const isSel =
                    selected?.accountId === row.accountId &&
                    selected?.date === cell.date;
                  const empty = cell.runs.length === 0;
                  const pct =
                    cell.planned > 0
                      ? Math.min(
                          100,
                          Math.round((cell.browsed / cell.planned) * 100),
                        )
                      : 0;
                  return (
                    <td
                      key={cell.date}
                      className={`${cellPad} ${isSel ? "bg-[var(--color-brand-subtle)]" : ""}`}
                    >
                      <button
                        type="button"
                        disabled={empty}
                        onClick={() => onSelect(row.accountId, cell.date)}
                        title={cellTitle(cell)}
                        className={`flex w-full min-w-[62px] flex-col items-center gap-1 rounded-md ${
                          empty
                            ? "text-text-secondary"
                            : isSel
                              ? "text-text-primary"
                              : "text-text-primary hover:bg-surface-2"
                        }`}
                      >
                        {empty ? (
                          <span className="text-text-secondary">—</span>
                        ) : (
                          <>
                            <span className="font-mono text-[13px] font-medium">
                              {cell.browsed}
                              <span className="font-normal text-text-secondary">
                                /{cell.planned}
                              </span>
                            </span>
                            <span className="h-[3px] w-full overflow-hidden rounded-sm bg-surface-3">
                              <span
                                className={`block h-[3px] ${cellBarClass(cell)}`}
                                style={{ width: `${pct}%` }}
                              />
                            </span>
                            {compact ? null : (
                              <span className="font-mono text-[12px] text-text-secondary">
                                首 {cell.home}
                                {cell.anomalies > 0 ? (
                                  <span className="text-[var(--color-warning-ink)]">
                                    {" "}
                                    异 {cell.anomalies}
                                  </span>
                                ) : null}
                              </span>
                            )}
                          </>
                        )}
                      </button>
                    </td>
                  );
                })}
                <td className={`text-right ${edgePad}`}>
                  <div className="font-mono text-[13px] font-medium text-text-primary">
                    {row.totals.browsed}
                    <span className="font-normal text-text-secondary">
                      /{row.totals.planned}
                    </span>
                  </div>
                  <div className="font-mono text-[12px] text-text-secondary">
                    首 {row.totals.home} · 互 {row.totals.interactions}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center gap-4 border-t border-border-subtle bg-surface-0 px-3 py-2.5 text-[12px] text-text-secondary">
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[3px] w-4 rounded-sm bg-[var(--color-success)]" />
          达成
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[3px] w-4 rounded-sm bg-[var(--color-brand-primary)]" />
          执行中
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[3px] w-4 rounded-sm bg-[var(--color-warning-ink)]" />
          未达成
        </span>
        <span className="inline-flex items-center gap-1.5">
          <span className="h-[3px] w-4 rounded-sm bg-[var(--color-error)]" />
          失败
        </span>
        <span>首 = 首页推荐流浏览数 · 异 = 异常次数</span>
      </div>
    </div>
  );
}

// ── Selected day detail + notes ───────────────────────────────

function CellDetail({
  accountLabel,
  cell,
  onRunChange,
  onAction,
}: {
  accountLabel: string;
  cell: DashboardCell;
  onRunChange: (run: XhsOpsRun) => void;
  onAction?: CustomComponentProps["onAction"];
}) {
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-2/40 p-2">
      <SectionTitle hint={`${accountLabel} · ${cell.date}`}>
        当日明细
      </SectionTitle>
      {cell.runs.map((run) => (
        <RunDetail
          key={run.id}
          run={run}
          onRunChange={onRunChange}
          onAction={onAction}
        />
      ))}
    </div>
  );
}

function RunDetail({
  run,
  onRunChange,
  onAction,
}: {
  run: XhsOpsRun;
  onRunChange: (run: XhsOpsRun) => void;
  onAction?: CustomComponentProps["onAction"];
}) {
  const [notes, setNotes] = useState(run.notes ?? "");
  const [state, setState] = useState<"idle" | "saving" | "saved" | "error">(
    "idle",
  );
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setNotes(run.notes ?? "");
  }, [run.notes]);

  const save = async () => {
    setState("saving");
    setError(null);
    try {
      const next = await xhsOpsApi.updateRunNotes(run.id, notes.trim());
      onRunChange({ ...run, notes: next.notes });
      setState("saved");
      onAction?.("xhs_ops_dashboard_note_saved", {
        runId: run.id,
        accountLabel: run.accountLabel,
        date: run.date,
        notes: next.notes,
        agentInstruction:
          "运营已在复盘看板为这次运行记录了观察。不要重新派发任务，也不要逐字复述记录；如果观察里提到关键词/兴趣不匹配，给出一两条兴趣池调整建议即可。",
      });
    } catch (err) {
      setState("error");
      setError(describeXhsOpsError(err, "备注保存失败"));
    }
  };

  const chunks = [...(run.chunks ?? [])].sort((a, b) => a.index - b.index);
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-1 p-2 text-[12px]">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className={`font-medium ${runStatusTextClass(run.status)}`}>
          {runStatusLabel(run.status)}
        </span>
        {run.segment && run.segment.count > 1 ? (
          <span className="rounded-full bg-surface-2 px-1.5 text-[12px] text-text-secondary">
            {segmentLabel(run.segment)}
          </span>
        ) : null}
        <span className="text-text-secondary">
          {formatClock(run.startedAt ?? run.createdAt)}
          {run.completedAt ? ` → ${formatClock(run.completedAt)}` : ""} ·{" "}
          {formatDurationMs(run.summary?.durationMs)}
        </span>
        <span className="text-text-secondary">
          计划 {run.summary?.plannedTotal ?? 0} / 实际{" "}
          {run.summary?.browsedTotal ?? 0} · 赞{" "}
          {run.summary?.interactions?.like ?? 0} 藏{" "}
          {run.summary?.interactions?.collect ?? 0} 关{" "}
          {run.summary?.interactions?.follow ?? 0}
          {(run.summary?.interactions?.comment ?? 0) > 0
            ? ` 评 ${run.summary?.interactions?.comment}`
            : ""}
        </span>
      </div>
      <XhsOpsPreparationStatus preparation={getRunPreparation(run)} />
      {run.error ? <ErrorLine message={run.error} /> : null}
      <div className="overflow-x-auto">
        <table className="w-full min-w-max border-collapse text-[12px]">
          <thead>
            <tr className="text-text-secondary">
              <th className="px-1.5 py-0.5 text-left font-medium">环节</th>
              <th className="px-1.5 py-0.5 text-right font-medium">
                实际/计划
              </th>
              <th className="px-1.5 py-0.5 text-right font-medium">跳过</th>
              <th className="px-1.5 py-0.5 text-right font-medium">赞/藏/关</th>
              <th className="px-1.5 py-0.5 text-left font-medium">
                状态 · 异常
              </th>
              <th className="px-1.5 py-0.5 text-left font-medium">
                手机端观察
              </th>
            </tr>
          </thead>
          <tbody>
            {chunks.map((c) => (
              <tr key={c.index} className="border-t border-border/60">
                <td className="px-1.5 py-0.5 text-text-primary">
                  {chunkTitle(c)}
                </td>
                <td className="px-1.5 py-0.5 text-right">
                  {c.browsed}/{c.plannedCount}
                </td>
                <td className="px-1.5 py-0.5 text-right text-text-secondary">
                  {c.skipped}
                </td>
                <td className="px-1.5 py-0.5 text-right text-text-secondary">
                  {c.interactions?.like ?? 0}/{c.interactions?.collect ?? 0}/
                  {c.interactions?.follow ?? 0}
                </td>
                <td className="px-1.5 py-0.5">
                  <span className="mr-1 inline-flex items-center gap-1">
                    <StatusDot status={c.status} />
                    {chunkStatusLabel(c.status)}
                  </span>
                  {(c.anomalies ?? []).map((a, i) => (
                    <span
                      // biome-ignore lint/suspicious/noArrayIndexKey: display-only list
                      key={i}
                      title={a.detail}
                      className="mr-1 rounded-full bg-[var(--color-warning-wash)] px-1.5 text-[12px] text-[var(--color-warning-ink)]"
                    >
                      {anomalyLabel(a.type)}
                    </span>
                  ))}
                </td>
                <td className="max-w-[260px] px-1.5 py-0.5 text-text-secondary">
                  {c.observation?.trim() || "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-col gap-1">
        <SectionTitle hint="人工判断写在这里，保存到这次运行记录">
          运营备注
        </SectionTitle>
        <textarea
          className={textareaClass}
          rows={2}
          value={notes}
          placeholder="如：首页推荐流开始出现亲子酒店，下周核心池加「室内乐园」"
          onChange={(e) => {
            setNotes(e.target.value);
            if (state !== "idle") setState("idle");
          }}
        />
        <ErrorLine message={error} />
        <div className="flex items-center justify-end gap-2">
          {state === "saved" ? (
            <span className="text-[12px] text-text-secondary">已保存</span>
          ) : null}
          <SecondaryButton onClick={save} disabled={state === "saving"}>
            {state === "saving" ? "保存中…" : "保存备注"}
          </SecondaryButton>
        </div>
      </div>
    </div>
  );
}

// ── Keywords ──────────────────────────────────────────────────

function verdictClass(v: KeywordStat["verdict"]): string {
  switch (v) {
    case "adjust":
      return "bg-[var(--color-error-wash)] text-[var(--color-error-ink)]";
    case "watch":
      return "bg-[var(--color-warning-wash)] text-[var(--color-warning-ink)]";
    default:
      return "bg-[var(--color-success-muted)] text-[var(--color-success-ink)]";
  }
}

function KeywordTable({
  keywords,
  home,
}: {
  keywords: KeywordStat[];
  home: ReturnType<typeof keywordStats>["home"];
}) {
  if (keywords.length === 0 && home.runs === 0) return null;
  return (
    <div className="flex flex-col gap-1">
      <SectionTitle hint="按搜索关键词汇总；「建议调整」= 出现过无结果/内容不匹配">
        关键词表现
      </SectionTitle>
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full min-w-max border-collapse text-[12px]">
          <thead>
            <tr className="bg-surface-2/60 text-text-secondary">
              <th className="px-2 py-1 text-left font-medium">关键词</th>
              <th className="px-2 py-1 text-left font-medium">核心池账号</th>
              <th className="px-2 py-1 text-right font-medium">次数</th>
              <th className="px-2 py-1 text-right font-medium">实际/计划</th>
              <th className="px-2 py-1 text-right font-medium">互动</th>
              <th className="px-2 py-1 text-right font-medium">异常</th>
              <th className="px-2 py-1 text-left font-medium">判断</th>
            </tr>
          </thead>
          <tbody>
            {keywords.map((k) => (
              <tr key={k.keyword} className="border-t border-border">
                <td className="px-2 py-1 text-text-primary">{k.keyword}</td>
                <td
                  className="max-w-[180px] truncate px-2 py-1 text-text-secondary"
                  title={k.coreOf.join("、")}
                >
                  {k.coreOf.length > 0 ? k.coreOf.join("、") : "—"}
                </td>
                <td className="px-2 py-1 text-right">{k.runs}</td>
                <td className="px-2 py-1 text-right">
                  {k.browsed}/{k.planned}
                </td>
                <td className="px-2 py-1 text-right">{k.interactions}</td>
                <td
                  className={`px-2 py-1 text-right ${k.anomalies > 0 ? "text-[var(--color-warning-ink)]" : ""}`}
                >
                  {k.anomalies}
                </td>
                <td className="px-2 py-1">
                  <span
                    className={`rounded-full px-1.5 text-[12px] ${verdictClass(k.verdict)}`}
                  >
                    {KEYWORD_VERDICT_LABEL[k.verdict]}
                  </span>
                  <span className="ml-1 text-text-secondary">{k.hint}</span>
                </td>
              </tr>
            ))}
            {home.runs > 0 ? (
              <tr className="border-t border-border bg-surface-2/30">
                <td className="px-2 py-1 text-text-primary">首页推荐流</td>
                <td className="px-2 py-1 text-text-secondary">—</td>
                <td className="px-2 py-1 text-right">{home.runs}</td>
                <td className="px-2 py-1 text-right">
                  {home.browsed}/{home.planned}
                </td>
                <td className="px-2 py-1 text-right">{home.interactions}</td>
                <td className="px-2 py-1 text-right">—</td>
                <td className="px-2 py-1 text-text-secondary">
                  {home.observations}{" "}
                  条手机端观察——推荐流是否靠近目标兴趣看下方时间线
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Observations ──────────────────────────────────────────────

function ObservationTimeline({
  entries,
  showAll,
  onToggle,
}: {
  entries: ObservationEntry[];
  showAll: boolean;
  onToggle: () => void;
}) {
  if (entries.length === 0) return null;
  const visible = showAll ? entries : entries.slice(0, OBSERVATION_PREVIEW);
  return (
    <div className="flex flex-col gap-1">
      <SectionTitle hint="手机端每个环节的观察 + 运营备注，按日期倒序">
        观察时间线
      </SectionTitle>
      <ul className="flex flex-col gap-1 text-[12px]">
        {visible.map((o, i) => (
          <li
            key={`${o.runId}-${o.chunk}-${i}`}
            className="flex items-start gap-2"
          >
            <span className="shrink-0 font-mono text-[12px] text-text-secondary">
              {shortDate(o.date)}
            </span>
            <span
              className={`shrink-0 rounded-full px-1.5 text-[12px] ${
                o.source === "ops"
                  ? "bg-[var(--color-brand-wash)] text-[var(--color-brand-ink)]"
                  : "bg-surface-2 text-text-secondary"
              }`}
            >
              {o.source === "ops" ? "运营" : "手机"}
            </span>
            <span className="min-w-0 text-text-secondary">
              <span className="text-text-primary">
                {o.accountLabel} · {o.chunk}
              </span>{" "}
              · {o.text}
            </span>
          </li>
        ))}
      </ul>
      {entries.length > OBSERVATION_PREVIEW ? (
        <div>
          <SecondaryButton onClick={onToggle}>
            {showAll ? "收起" : `展开全部 ${entries.length} 条`}
          </SecondaryButton>
        </div>
      ) : null}
    </div>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "warn";
}) {
  const warn = tone === "warn";
  return (
    <div
      className={`flex items-baseline justify-between gap-2 rounded-[10px] px-3 py-2.5 @min-[480px]:flex-col @min-[480px]:items-stretch @min-[480px]:gap-1 @min-[480px]:px-3.5 @min-[480px]:py-3 ${
        warn ? "bg-[var(--color-warning-ink)]/[8%]" : "bg-surface-2"
      }`}
    >
      <div
        className={`text-[12px] ${warn ? "text-[var(--color-warning-ink)]" : "text-text-secondary"}`}
      >
        {label}
      </div>
      <div
        className={`font-mono text-[15px] font-semibold @min-[480px]:text-[18px] ${warn ? "text-[var(--color-warning-ink)]" : "text-text-primary"}`}
      >
        {value}
      </div>
    </div>
  );
}
