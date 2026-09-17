import { useCallback, useEffect, useMemo, useState } from "react";
import type { CustomComponentProps } from "../registry";
import { describeXhsOpsError, xhsOpsApi } from "./xhs-ops-api";
import { localDateString } from "./xhs-ops-dashboard-data";
import { ProjectPicker, useProjectResolution } from "./xhs-ops-project-picker";
import {
  COMMENT_MAX_CHARS,
  COMMENT_STATUS_LABEL,
  type XhsOpsAccount,
  type XhsOpsCommentDraft,
  type XhsOpsCommentQuota,
  type XhsOpsRun,
  asString,
  commentTextProblem,
} from "./xhs-ops-types";
import {
  CardShell,
  EmptyState,
  ErrorLine,
  HintLine,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  Skeleton,
  Spinner,
  StatusPill,
  formatClock,
  inputClass,
  readProp,
  runStatusLabel,
} from "./xhs-ops-ui";

const RECENT_RUN_DAYS = 3;
const HISTORY_LIMIT = 20;

/**
 * P3-1 D1 评论审核队列。人是唯一的放行者：桌面生成候选 → 运营点选/改写 →
 * 批准/拒绝；配额（min(每日上限, 5, 今日浏览÷8) − 已发 − 已批未发）在批准时
 * 硬校验。没有「自动批准」。发出由 D2 的评论 run 负责，这里只产出 approved
 * 记录。上报 `xhs_ops_comments_reviewed`。
 */
export function XhsOpsCommentReview({
  comp,
  resolve,
  onAction,
}: CustomComponentProps) {
  const propProjectId = asString(readProp(comp, resolve, "projectId"));
  const projectName = asString(readProp(comp, resolve, "projectName")).trim();
  const onlyAccountId = asString(readProp(comp, resolve, "accountId")) || null;
  const resolution = useProjectResolution(propProjectId, projectName);
  const projectId = resolution.projectId;

  const [drafts, setDrafts] = useState<XhsOpsCommentDraft[] | null>(null);
  const [quotas, setQuotas] = useState<XhsOpsCommentQuota[]>([]);
  const [accounts, setAccounts] = useState<XhsOpsAccount[]>([]);
  const [recentRuns, setRecentRuns] = useState<XhsOpsRun[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const [showPicker, setShowPicker] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    try {
      const [list, accts, runs] = await Promise.all([
        xhsOpsApi.listComments(
          projectId,
          onlyAccountId ? { accountId: onlyAccountId } : {},
        ),
        xhsOpsApi.listAccounts(projectId),
        xhsOpsApi.listRuns({ projectId }),
      ]);
      const since = localDateString(
        new Date(Date.now() - RECENT_RUN_DAYS * 86_400_000),
      );
      setDrafts(list.drafts);
      setQuotas(list.quotas);
      setAccounts(
        onlyAccountId ? accts.filter((a) => a.id === onlyAccountId) : accts,
      );
      setRecentRuns(
        runs.filter(
          (r) =>
            r.date >= since &&
            (!onlyAccountId || r.accountId === onlyAccountId) &&
            r.chunks.some((c) => c.posts.some((p) => p.action !== "skip")),
        ),
      );
      setLoadError(null);
    } catch (err) {
      setDrafts((prev) => prev ?? []);
      setLoadError(describeXhsOpsError(err, "评论队列加载失败"));
    }
  }, [projectId, onlyAccountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const pending = useMemo(
    () => (drafts ?? []).filter((d) => d.status === "pending"),
    [drafts],
  );
  const history = useMemo(
    () =>
      (drafts ?? [])
        .filter((d) => d.status !== "pending")
        .slice(0, HISTORY_LIMIT),
    [drafts],
  );
  const accountLabel = (accountId: string) =>
    accounts.find((a) => a.id === accountId)?.label ??
    quotas.find((q) => q.accountId === accountId)?.accountLabel ??
    accountId;

  const approvedUnclaimed = (accountId: string) =>
    (drafts ?? []).filter(
      (d) =>
        d.accountId === accountId && d.status === "approved" && !d.sentRunId,
    ).length;

  const replaceDraft = (next: XhsOpsCommentDraft) => {
    setDrafts((prev) =>
      prev ? prev.map((d) => (d.id === next.id ? next : d)) : prev,
    );
    void load(); // 配额随批准变化
  };

  const report = (decision: "approved" | "rejected", d: XhsOpsCommentDraft) =>
    onAction?.("xhs_ops_comments_reviewed", {
      commentId: d.id,
      decision,
      accountLabel: accountLabel(d.accountId),
      postTitle: d.post.title,
      text: d.text,
      pendingLeft: Math.max(0, pending.length - 1),
      agentInstruction:
        "运营在评论审核队列里做了一次审核。不要生成或发送评论，也不要下发手机任务——发出由桌面的评论任务在后续阶段执行。如需回应，简短确认即可。",
    });

  return (
    <CardShell
      testId="comment-review"
      title="评论审核队列"
      subtitle="桌面按帖子生成候选，每条评论都要人工批准；配额 = min(每日上限, 5, 今日浏览÷8)"
      actions={
        projectId ? (
          <SecondaryButton onClick={() => void load()}>刷新</SecondaryButton>
        ) : null
      }
    >
      <ErrorLine message={loadError ?? resolution.error} />
      {!projectId ? (
        <ProjectPicker
          resolution={resolution}
          wanted={projectName}
          purpose="审核评论"
        />
      ) : drafts === null ? (
        <Skeleton rows={3} label="正在加载评论队列" />
      ) : (
        <>
          <QuotaStrip
            quotas={quotas}
            approvedUnclaimed={approvedUnclaimed}
            onDispatch={
              projectId
                ? async (accountId) => {
                    const run = await xhsOpsApi.createCommentRun(
                      projectId,
                      accountId,
                    );
                    onAction?.("xhs_ops_comment_run_started", {
                      runId: run.id,
                      accountLabel: accountLabel(accountId),
                      comments: run.plan.comments?.length ?? 0,
                      queued: run.status === "planned",
                      agentInstruction:
                        "运营已把已批准的评论派发给手机（桌面评论任务，同一手机排队串行）。不要再派任何手机任务，也不要生成评论；结果会回写到评论队列和看板。",
                    });
                    await load();
                    return run;
                  }
                : undefined
            }
          />

          <div className="flex flex-col gap-3">
            <SectionTitle hint={`${pending.length} 条待审核`}>
              待审核
            </SectionTitle>
            {pending.length === 0 ? (
              <EmptyState>
                队列为空。从下方最近的浏览记录里挑帖子生成候选，或等手机在浏览时标注「值得评」的帖子。
              </EmptyState>
            ) : (
              pending.map((d) => (
                <DraftCard
                  key={d.id}
                  draft={d}
                  accountLabel={accountLabel(d.accountId)}
                  quota={quotas.find((q) => q.accountId === d.accountId)}
                  onReviewed={(decision, next) => {
                    replaceDraft(next);
                    report(decision, next);
                  }}
                />
              ))
            )}
          </div>

          <div className="flex flex-col gap-1.5">
            <button
              type="button"
              className="self-start text-[12px] font-semibold text-text-primary"
              onClick={() => setShowPicker((v) => !v)}
            >
              {showPicker ? "▾" : "▸"} 从最近 {RECENT_RUN_DAYS}{" "}
              天的浏览记录挑帖子生成候选（
              {recentRuns.length} 次运行）
            </button>
            {showPicker ? (
              <RunPostPicker
                runs={recentRuns}
                accountLabel={accountLabel}
                existing={drafts}
                onGenerated={() => void load()}
              />
            ) : null}
          </div>

          {history.length > 0 ? (
            <div className="flex flex-col gap-1">
              <button
                type="button"
                className="self-start text-[12px] font-semibold text-text-primary"
                onClick={() => setShowHistory((v) => !v)}
              >
                {showHistory ? "▾" : "▸"} 已处理（最近 {history.length} 条）
              </button>
              {showHistory ? (
                <ul className="flex flex-col gap-0.5 text-[12px]">
                  {history.map((d) => (
                    <li key={d.id} className="flex items-start gap-2">
                      <span
                        className={`shrink-0 rounded-full px-1.5 text-[12px] ${statusClass(d.status)}`}
                      >
                        {COMMENT_STATUS_LABEL[d.status]}
                      </span>
                      <span className="min-w-0 text-text-secondary">
                        {accountLabel(d.accountId)} · {d.post.title}
                        {d.text ? ` · 「${d.text}」` : ""}
                        {d.reviewNote ? ` · ${d.reviewNote}` : ""}
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
          ) : null}
        </>
      )}
    </CardShell>
  );
}

function statusClass(status: XhsOpsCommentDraft["status"]): string {
  switch (status) {
    case "approved":
    case "sent":
      return "bg-[var(--color-success-muted)] text-[var(--color-success-ink)]";
    case "rejected":
    case "failed":
      return "bg-[var(--color-error-wash)] text-[var(--color-error-ink)]";
    case "expired":
      return "bg-surface-2 text-text-secondary";
    default:
      return "bg-[var(--color-warning-wash)] text-[var(--color-warning-ink)]";
  }
}

function QuotaStrip({
  quotas,
  approvedUnclaimed,
  onDispatch,
}: {
  quotas: XhsOpsCommentQuota[];
  approvedUnclaimed: (accountId: string) => number;
  onDispatch?: (accountId: string) => Promise<XhsOpsRun>;
}) {
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (quotas.length === 0) return null;
  const dispatch = async (accountId: string, label: string) => {
    if (!onDispatch) return;
    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `将把「${label}」已批准的 ${approvedUnclaimed(accountId)} 条评论派发到手机发送（08:00–23:00，距浏览结束 ≥10 分钟）。确认派发？`,
      )
    ) {
      return;
    }
    setBusy(accountId);
    setError(null);
    setNotice(null);
    try {
      const run = await onDispatch(accountId);
      setNotice(
        `${label}：评论任务已${run.status === "planned" ? "排队（等同一手机上的任务结束）" : "开始执行"}，${run.plan.comments?.length ?? 0} 条；结果会回写到队列。`,
      );
    } catch (err) {
      setError(describeXhsOpsError(err, "派发失败"));
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="flex flex-col gap-1">
      <SectionTitle hint="今日 · 每账号；已批准的评论由你手动派发到手机">
        配额
      </SectionTitle>
      <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-2">
        {quotas.map((q) => {
          const ready = approvedUnclaimed(q.accountId);
          return (
            <div
              key={q.accountId}
              className="rounded-md bg-surface-2/60 px-2 py-1.5 text-[12px]"
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-medium text-text-primary">
                  {q.accountLabel}
                </span>
                <span
                  className={`shrink-0 text-[12px] ${q.enabled ? "text-text-secondary" : "text-[var(--color-warning-ink)]"}`}
                >
                  {q.enabled
                    ? `剩余 ${q.remaining} / 上限 ${q.cap}`
                    : "评论开关未开"}
                </span>
              </div>
              <div className="text-[12px] text-text-secondary">
                今日浏览 {q.todayBrowsed} 篇 → 按 8 篇 1 条可评 {q.byBrowse}
                ；每日上限 {q.dailyCap}；已发 {q.sentToday}，已批未发{" "}
                {q.approvedPending}
              </div>
              {onDispatch ? (
                <div className="mt-1 flex items-center justify-end">
                  <PrimaryButton
                    onClick={() => void dispatch(q.accountId, q.accountLabel)}
                    disabled={ready === 0 || busy !== null}
                    title={ready === 0 ? "没有已批准且未派发的评论" : undefined}
                  >
                    {busy === q.accountId
                      ? "派发中…"
                      : `派发已批准的评论（${ready}）`}
                  </PrimaryButton>
                </div>
              ) : null}
            </div>
          );
        })}
      </div>
      {notice ? <HintLine>{notice}</HintLine> : null}
      <ErrorLine message={error} />
    </div>
  );
}

function DraftCard({
  draft,
  accountLabel,
  quota,
  onReviewed,
}: {
  draft: XhsOpsCommentDraft;
  accountLabel: string;
  quota: XhsOpsCommentQuota | undefined;
  onReviewed: (
    decision: "approved" | "rejected",
    next: XhsOpsCommentDraft,
  ) => void;
}) {
  const [text, setText] = useState(draft.candidates[0] ?? "");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState<"approve" | "reject" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const problem = commentTextProblem(text);
  const quotaBlocked = quota ? !quota.enabled || quota.remaining <= 0 : false;

  const review = async (decision: "approved" | "rejected") => {
    setBusy(decision === "approved" ? "approve" : "reject");
    setError(null);
    try {
      const next = await xhsOpsApi.reviewComment(draft.id, {
        decision,
        text: decision === "approved" ? text.trim() : undefined,
        note: note.trim() || undefined,
      });
      onReviewed(decision, next);
    } catch (err) {
      setError(describeXhsOpsError(err, "审核失败"));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface-1 p-3.5 text-[13px]">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-[14px] font-medium text-text-primary">
          {draft.post.title}
        </span>
        <span className="text-[12px] text-text-secondary">
          {draft.post.author ? `@${draft.post.author} · ` : ""}
          {accountLabel} · {formatClock(draft.createdAt)}
        </span>
      </div>
      {draft.post.summary ? (
        <div className="text-[12px] text-text-secondary">
          {draft.post.summary}
        </div>
      ) : null}
      {draft.reviewNote ? <HintLine>{draft.reviewNote}</HintLine> : null}
      {draft.candidates.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {draft.candidates.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setText(c)}
              className={`rounded-full border px-2.5 py-1 text-[12px] ${
                text === c
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)]/10 text-text-primary"
                  : "border-border text-text-secondary hover:bg-surface-2"
              }`}
            >
              {c}
            </button>
          ))}
        </div>
      ) : null}
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2">
        <input
          className={inputClass}
          value={text}
          maxLength={COMMENT_MAX_CHARS + 4}
          placeholder="最终文案（≤10 字，正向、针对帖子内容）"
          aria-label="评论文案"
          onChange={(e) => setText(e.target.value)}
        />
        <span
          className={`text-[12px] ${problem ? "text-[var(--color-warning-ink)]" : "text-text-secondary"}`}
        >
          {[...text.trim()].length}/{COMMENT_MAX_CHARS}
          {problem ? ` · ${problem}` : ""}
        </span>
      </div>
      <input
        className={inputClass}
        value={note}
        placeholder="备注（可选，如：换成更口语的说法）"
        aria-label="审核备注"
        onChange={(e) => setNote(e.target.value)}
      />
      <ErrorLine message={error} />
      {/* 批准 leads: it is the action the queue exists for. Both sit at
          36px — approving posts a comment from a real account, which is
          the least reversible thing on this card. */}
      <div className="flex flex-wrap items-center gap-2">
        <PrimaryButton
          onClick={() => void review("approved")}
          disabled={busy !== null || Boolean(problem) || quotaBlocked}
          title={problem ?? undefined}
        >
          {busy === "approve" ? <Spinner /> : null}
          {busy === "approve" ? "批准中" : "批准"}
        </PrimaryButton>
        <SecondaryButton
          onClick={() => void review("rejected")}
          disabled={busy !== null}
          danger
        >
          {busy === "reject" ? <Spinner /> : null}
          {busy === "reject" ? "拒绝中" : "拒绝"}
        </SecondaryButton>
        {quotaBlocked ? (
          <StatusPill tone="blocked">
            {quota && !quota.enabled ? "该账号评论开关未开" : "今日配额已用完"}
          </StatusPill>
        ) : (
          <span className="ml-auto text-[12px] text-text-secondary">
            批准后由你手动派发
          </span>
        )}
      </div>
    </div>
  );
}

function RunPostPicker({
  runs,
  accountLabel,
  existing,
  onGenerated,
}: {
  runs: XhsOpsRun[];
  accountLabel: (accountId: string) => string;
  existing: XhsOpsCommentDraft[] | null;
  onGenerated: () => void;
}) {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const hasDraft = (runId: string, chunkIndex: number, postIndex: number) =>
    (existing ?? []).some(
      (d) =>
        d.sourceRunId === runId &&
        d.sourceChunkIndex === chunkIndex &&
        d.sourcePostIndex === postIndex,
    );
  if (runs.length === 0) {
    return (
      <EmptyState>最近 {RECENT_RUN_DAYS} 天没有带帖子记录的运行。</EmptyState>
    );
  }
  const generate = async (
    runId: string,
    chunkIndex: number,
    postIndex: number,
  ) => {
    const key = `${runId}:${chunkIndex}:${postIndex}`;
    setBusyKey(key);
    setError(null);
    setNotice(null);
    try {
      const result = await xhsOpsApi.generateComments(runId, [
        { chunkIndex, postIndex },
      ]);
      setNotice(
        result.drafts.length > 0
          ? `已生成 ${result.drafts[0]?.candidates.length ?? 0} 条候选，见上方待审核`
          : (result.skipped[0] ?? "没有生成"),
      );
      onGenerated();
    } catch (err) {
      setError(describeXhsOpsError(err, "生成失败"));
    } finally {
      setBusyKey(null);
    }
  };
  return (
    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-2/40 p-2 text-[12px]">
      <ErrorLine message={error} />
      {notice ? <HintLine>{notice}</HintLine> : null}
      {runs.map((run) => (
        <div key={run.id} className="flex flex-col gap-1">
          <div className="text-[12px] text-text-secondary">
            {run.date} · {accountLabel(run.accountId)} ·{" "}
            {runStatusLabel(run.status)}
          </div>
          <ul className="flex flex-col gap-0.5">
            {run.chunks.flatMap((chunk) =>
              chunk.posts.map((post, postIndex) => {
                if (post.action === "skip") return null;
                const done = hasDraft(run.id, chunk.index, postIndex);
                const key = `${run.id}:${chunk.index}:${postIndex}`;
                return (
                  <li
                    key={key}
                    className="flex items-center justify-between gap-2"
                  >
                    <span className="min-w-0 truncate text-text-secondary">
                      {post.commentWorthy ? "★ " : ""}
                      {post.title}
                      {post.author ? ` @${post.author}` : ""}
                      {post.summary ? ` · ${post.summary}` : ""}
                    </span>
                    <SecondaryButton
                      onClick={() =>
                        void generate(run.id, chunk.index, postIndex)
                      }
                      disabled={done || busyKey !== null}
                      title={done ? "已有草稿" : undefined}
                    >
                      {done
                        ? "已有草稿"
                        : busyKey === key
                          ? "生成中…"
                          : "生成候选"}
                    </SecondaryButton>
                  </li>
                );
              }),
            )}
          </ul>
        </div>
      ))}
    </div>
  );
}
