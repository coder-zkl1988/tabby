import type {
  XhsOpsAccount,
  XhsOpsCommentDraft,
  XhsOpsCommentQuota,
  XhsOpsCommentReviewBody,
  XhsOpsProject,
  XhsOpsRun,
  XhsOpsRunPost,
} from "@nexu/shared";
import { logger } from "../lib/logger.js";
import { XhsOpsError, localDateString } from "../lib/xhs-ops-common.js";
import type { XhsOpsStore } from "../store/xhs-ops-store.js";
import { formatPersona } from "./xhs-ops-task-builder.js";

/**
 * P3-1 D1 评论桌面基建：候选生成 + 配额 + 人工审核状态机。
 *
 * 不碰手机。手机在浏览 run 的 RECORD_JSON.posts 里标注 `commentWorthy` 和一句
 * `summary`（D3），桌面用文本模型给每篇生成 1–3 条候选，进入审核队列；运营在
 * `XhsOpsCommentReview` 里批准/改写/拒绝。批准受配额约束（评审拍板：默认 2、
 * 硬上限 5、每 8 篇浏览最多 1 条）。发出（D2 评论 run + TaskPolicy 白名单）
 * 之前，这里的 `approved` 记录及其 `text` 就是唯一合法来源。
 */

export const XHS_COMMENT_MAX_CHARS = 10;
export const XHS_COMMENT_MIN_CHARS = 2;
export const XHS_COMMENT_HARD_CAP = 5;
export const XHS_COMMENT_POSTS_PER_COMMENT = 8;
export const XHS_COMMENT_CANDIDATES = 3;
/** 与最近多少天已批准/已发出的文案去重。 */
export const XHS_COMMENT_DEDUPE_DAYS = 30;

/** 营销/引流/交易痕迹——出现即不合规（评审：无营销、链接、联系方式、品牌、价格）。 */
export const XHS_COMMENT_BLOCKLIST: readonly string[] = [
  "加微",
  "微信",
  "vx",
  "v信",
  "威信",
  "私信",
  "私我",
  "链接",
  "http",
  "www",
  "优惠",
  "折扣",
  "团购",
  "代理",
  "免费",
  "关注我",
  "主页",
  "看我",
  "¥",
  "￥",
  "电话",
  "手机号",
  "客服",
  "下单",
  "购买",
  "价格",
  "多少钱",
];

const EMOJI_RE = /\p{Extended_Pictographic}/gu;

/** 返回不合规原因；null = 合规。 */
export function validateCommentText(
  raw: string,
  forbiddenTopics: readonly string[] = [],
): string | null {
  const text = raw.trim();
  const length = [...text].length;
  if (length < XHS_COMMENT_MIN_CHARS) return "太短";
  if (length > XHS_COMMENT_MAX_CHARS) return `超过 ${XHS_COMMENT_MAX_CHARS} 字`;
  if (/[\r\n]/.test(text)) return "不能换行";
  const lower = text.toLowerCase();
  const hit = XHS_COMMENT_BLOCKLIST.find((w) =>
    lower.includes(w.toLowerCase()),
  );
  if (hit) return `含营销/引流词「${hit}」`;
  const topic = forbiddenTopics
    .map((t) => t.trim())
    .filter(Boolean)
    .find((t) => text.includes(t));
  if (topic) return `涉及禁忌方向「${topic}」`;
  if ((text.match(EMOJI_RE) ?? []).length > 1) return "表情最多 1 个";
  if (/^[\p{P}\p{S}\s]+$/u.test(text)) return "只有符号";
  return null;
}

export function buildCommentPrompt(input: {
  project: XhsOpsProject;
  account: XhsOpsAccount;
  post: { title: string; author: string; summary: string };
}): string {
  const { project, account, post } = input;
  const persona = formatPersona(account.persona);
  return [
    `为一个小红书 KOC 账号给下面这篇笔记写 ${XHS_COMMENT_CANDIDATES} 条候选评论。只输出一行紧凑 JSON：{"candidates":["…","…","…"]}，不要解释。`,
    `账号定位：${account.label}｜${account.positioning}`,
    persona ? `人设：${persona}` : "",
    `笔记标题：${post.title}`,
    post.author ? `作者：${post.author}` : "",
    post.summary ? `正文摘要：${post.summary}` : "",
    `规则：每条 ≤${XHS_COMMENT_MAX_CHARS} 字；正向认同、针对这篇内容本身（提到帖子里的具体点）；像真人随手评，口语化；三条角度不同。`,
    "禁止：营销话术、引流、联系方式、链接、品牌名、价格、问价、表情堆叠（最多 1 个表情）、空泛套话（如「太棒了」「学到了」）、反问/质疑作者。",
    project.opsNotes.forbiddenTopics.length > 0
      ? `禁忌方向（不得涉及）：${project.opsNotes.forbiddenTopics.join("、")}`
      : "",
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** 从模型输出里抠候选：优先 JSON，退回按行；去重、去引号。 */
export function parseCandidates(text: string): string[] {
  const out: string[] = [];
  const push = (v: unknown) => {
    if (typeof v !== "string") return;
    const t = v
      .trim()
      .replace(/^["'“”‘’]+|["'“”‘’]+$/g, "")
      .trim();
    if (t && !out.includes(t)) out.push(t);
  };
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as Record<string, unknown>;
      const arr = obj.candidates;
      if (Array.isArray(arr)) {
        for (const v of arr) push(v);
        if (out.length > 0) return out;
      }
    } catch {
      // fall through to line mode
    }
  }
  for (const line of text.split(/\r?\n/)) {
    const cleaned = line.replace(
      /^\s*(?:[-*•]|\d+[.、)]|候选\s*\d*[:：])\s*/,
      "",
    );
    if (cleaned.trim()) push(cleaned);
  }
  return out;
}

export interface XhsOpsCommentMedia {
  generateText(input: { prompt: string }): Promise<{ text: string }>;
}

export interface XhsOpsCommentServiceDeps {
  store: XhsOpsStore;
  media: XhsOpsCommentMedia;
  now?: () => number;
}

function localDateOf(iso: string): string {
  return localDateString(new Date(iso));
}

/** 纯函数，便于测试：今日配额。 */
export function computeCommentQuota(input: {
  account: XhsOpsAccount;
  date: string;
  runs: readonly XhsOpsRun[];
  drafts: readonly XhsOpsCommentDraft[];
}): XhsOpsCommentQuota {
  const { account, date } = input;
  const todayBrowsed = input.runs
    .filter((r) => r.accountId === account.id && r.date === date)
    .reduce((n, r) => n + (r.summary?.browsedTotal ?? 0), 0);
  const byBrowse = Math.floor(todayBrowsed / XHS_COMMENT_POSTS_PER_COMMENT);
  const rule = account.interaction.comment;
  const cap = rule.enabled
    ? Math.min(rule.dailyCap, XHS_COMMENT_HARD_CAP, byBrowse)
    : 0;
  const mine = input.drafts.filter((d) => d.accountId === account.id);
  const sentToday = mine.filter(
    (d) => d.status === "sent" && d.sentAt && localDateOf(d.sentAt) === date,
  ).length;
  const approvedPending = mine.filter((d) => d.status === "approved").length;
  return {
    accountId: account.id,
    accountLabel: account.label,
    date,
    enabled: rule.enabled,
    dailyCap: rule.dailyCap,
    todayBrowsed,
    byBrowse,
    cap,
    sentToday,
    approvedPending,
    remaining: Math.max(0, cap - sentToday - approvedPending),
  };
}

export class XhsOpsCommentService {
  private readonly store: XhsOpsStore;
  private readonly media: XhsOpsCommentMedia;
  private readonly now: () => number;
  private readonly approvalLocks = new Map<string, Promise<void>>();

  constructor(deps: XhsOpsCommentServiceDeps) {
    this.store = deps.store;
    this.media = deps.media;
    this.now = deps.now ?? (() => Date.now());
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private today(): string {
    return localDateString(new Date(this.now()));
  }

  private async withAccountApprovalLock<T>(
    accountId: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = this.approvalLocks.get(accountId);
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.approvalLocks.set(accountId, current);
    if (previous) await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.approvalLocks.get(accountId) === current) {
        this.approvalLocks.delete(accountId);
      }
    }
  }

  /**
   * 为一次浏览 run 里的帖子生成评论候选草稿。省略 `posts` 时取所有
   * `commentWorthy` 的帖子；同一帖子不重复建草稿；`skip` 的帖子（没看完）不评。
   * 候选全部不合规时仍建草稿（空候选 + 备注），让运营手写。
   */
  async generateForRun(
    runId: string,
    posts?: Array<{ chunkIndex: number; postIndex: number }>,
  ): Promise<{ drafts: XhsOpsCommentDraft[]; skipped: string[] }> {
    const run = await this.store.getRun(runId);
    if (!run) throw new XhsOpsError(404, "运行记录不存在");
    const account = await this.store.getAccount(run.accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
    const project = await this.store.getProject(run.projectId);
    if (!project) throw new XhsOpsError(404, "项目不存在");

    const targets: Array<{
      chunkIndex: number;
      postIndex: number;
      post: XhsOpsRunPost;
    }> = [];
    const skipped: string[] = [];
    if (posts && posts.length > 0) {
      for (const p of posts) {
        const chunk = run.chunks.find((c) => c.index === p.chunkIndex);
        const post = chunk?.posts[p.postIndex];
        if (!chunk || !post) {
          throw new XhsOpsError(
            400,
            `帖子不存在：chunk ${p.chunkIndex} / post ${p.postIndex}`,
          );
        }
        if (!post.commentWorthy) {
          skipped.push(
            `${post.title.slice(0, 20) || `chunk ${p.chunkIndex}#${p.postIndex}`}：不适合评论`,
          );
          continue;
        }
        targets.push({
          chunkIndex: p.chunkIndex,
          postIndex: p.postIndex,
          post,
        });
      }
    } else {
      for (const chunk of run.chunks) {
        chunk.posts.forEach((post, postIndex) => {
          if (post.commentWorthy) {
            targets.push({ chunkIndex: chunk.index, postIndex, post });
          }
        });
      }
    }

    const existing = await this.store.listComments({ accountId: account.id });
    const recentTexts = new Set(
      existing
        .filter(
          (d) =>
            (d.status === "approved" || d.status === "sent") &&
            d.text &&
            this.now() - Date.parse(d.createdAt) <=
              XHS_COMMENT_DEDUPE_DAYS * 86_400_000,
        )
        .map((d) => d.text as string),
    );

    const drafts: XhsOpsCommentDraft[] = [];
    for (const t of targets) {
      const label =
        t.post.title.slice(0, 20) || `chunk ${t.chunkIndex}#${t.postIndex}`;
      if (t.post.action === "skip") {
        skipped.push(`${label}：没看完的帖子不评`);
        continue;
      }
      if (
        existing.some(
          (d) =>
            d.sourceRunId === run.id &&
            d.sourceChunkIndex === t.chunkIndex &&
            d.sourcePostIndex === t.postIndex,
        )
      ) {
        skipped.push(`${label}：已有草稿`);
        continue;
      }
      const post = {
        title: t.post.title.slice(0, 60),
        author: t.post.author.slice(0, 40),
        summary: t.post.summary.slice(0, 120),
      };
      let candidates: string[] = [];
      let note = "";
      try {
        const { text } = await this.media.generateText({
          prompt: buildCommentPrompt({ project, account, post }),
        });
        const rejected: string[] = [];
        for (const c of parseCandidates(text)) {
          const reason = validateCommentText(
            c,
            project.opsNotes.forbiddenTopics,
          );
          if (reason) rejected.push(`「${c}」${reason}`);
          else if (recentTexts.has(c)) rejected.push(`「${c}」近 30 天已用过`);
          else if (!candidates.includes(c)) candidates.push(c);
        }
        candidates = candidates.slice(0, 5);
        if (candidates.length === 0) {
          note = `AI 候选全部不合规，请手写（${rejected.slice(0, 3).join("；")}）`;
        }
      } catch (error: unknown) {
        note = `候选生成失败：${error instanceof Error ? error.message : String(error)}`;
        logger.warn(
          { runId, chunk: t.chunkIndex, post: t.postIndex, error: note },
          "xhs-ops: comment candidate generation failed",
        );
      }
      const draft = await this.store.createComment({
        projectId: project.id,
        accountId: account.id,
        deviceId: account.deviceId,
        sourceRunId: run.id,
        sourceChunkIndex: t.chunkIndex,
        sourcePostIndex: t.postIndex,
        post,
        candidates,
        text: null,
        status: "pending",
        reviewedAt: null,
        reviewNote: note,
        sentRunId: null,
        sentAt: null,
        sendResult: null,
      });
      drafts.push(draft);
    }
    logger.info(
      { runId, created: drafts.length, skipped: skipped.length },
      "xhs-ops: comment candidates generated",
    );
    return { drafts, skipped };
  }

  /** 过期：不是今天建的 approved 草稿标 expired（帖子时效，评审拍板）。 */
  async expireStale(): Promise<number> {
    const today = this.today();
    const approved = await this.store.listComments({ status: "approved" });
    let expired = 0;
    for (const d of approved) {
      if (localDateOf(d.createdAt) < today) {
        await this.store.updateComment(d.id, (cur) => ({
          ...cur,
          status: "expired",
          updatedAt: this.nowIso(),
        }));
        expired += 1;
      }
    }
    return expired;
  }

  async quotaFor(accountId: string): Promise<XhsOpsCommentQuota> {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
    const date = this.today();
    const [runs, drafts] = await Promise.all([
      this.store.listRuns({ accountId, date }),
      this.store.listComments({ accountId }),
    ]);
    return computeCommentQuota({ account, date, runs, drafts });
  }

  /** 队列 + 每个账号的今日配额（先做一次过期清理）。 */
  async listForProject(
    projectId: string,
    filter: { status?: XhsOpsCommentDraft["status"]; accountId?: string } = {},
  ): Promise<{ drafts: XhsOpsCommentDraft[]; quotas: XhsOpsCommentQuota[] }> {
    const project = await this.store.getProject(projectId);
    if (!project) throw new XhsOpsError(404, "项目不存在");
    await this.expireStale();
    const drafts = await this.store.listComments({ projectId, ...filter });
    const accounts = (await this.store.listAccountsByProject(projectId)).filter(
      (a) => !filter.accountId || a.id === filter.accountId,
    );
    const date = this.today();
    const quotas: XhsOpsCommentQuota[] = [];
    for (const account of accounts) {
      const [runs, mine] = await Promise.all([
        this.store.listRuns({ accountId: account.id, date }),
        this.store.listComments({ accountId: account.id }),
      ]);
      quotas.push(computeCommentQuota({ account, date, runs, drafts: mine }));
    }
    return { drafts, quotas };
  }

  /** 人工审核：批准要过文案硬校验 + 配额；只有 pending 能审。 */
  async review(
    commentId: string,
    body: XhsOpsCommentReviewBody,
  ): Promise<XhsOpsCommentDraft> {
    const draft = await this.store.getComment(commentId);
    if (!draft) throw new XhsOpsError(404, "评论草稿不存在");
    if (draft.status !== "pending") {
      throw new XhsOpsError(409, `草稿已是 ${draft.status}，不能重复审核`);
    }
    const now = this.nowIso();
    if (body.decision === "rejected") {
      const rejected = await this.store.updateComment(commentId, (cur) => ({
        ...cur,
        status: "rejected",
        reviewedAt: now,
        reviewNote: body.note ?? cur.reviewNote,
        updatedAt: now,
      }));
      if (!rejected) throw new XhsOpsError(404, "评论草稿不存在");
      return rejected;
    }
    return this.withAccountApprovalLock(draft.accountId, async () => {
      const current = await this.store.getComment(commentId);
      if (!current) throw new XhsOpsError(404, "评论草稿不存在");
      if (current.status !== "pending") {
        throw new XhsOpsError(409, `草稿已是 ${current.status}，不能重复审核`);
      }
      const text = (body.text ?? current.candidates[0] ?? "").trim();
      if (!text)
        throw new XhsOpsError(400, "批准需要最终文案（没有候选时请手写）");
      const project = await this.store.getProject(current.projectId);
      const reason = validateCommentText(
        text,
        project?.opsNotes.forbiddenTopics ?? [],
      );
      if (reason) throw new XhsOpsError(400, `文案不合规：${reason}`);
      const quota = await this.quotaFor(current.accountId);
      if (!quota.enabled) {
        throw new XhsOpsError(
          409,
          "该账号的评论开关未开启（账号配置 → 互动配置）",
        );
      }
      if (quota.remaining <= 0) {
        throw new XhsOpsError(
          409,
          `今日评论配额已用完（上限 ${quota.cap}：min(每日 ${quota.dailyCap}, 硬上限 ${XHS_COMMENT_HARD_CAP}, 今日浏览 ${quota.todayBrowsed} 篇 ÷ ${XHS_COMMENT_POSTS_PER_COMMENT}=${quota.byBrowse}）`,
        );
      }
      const approved = await this.store.updateComment(commentId, (cur) => ({
        ...cur,
        status: "approved",
        text,
        reviewedAt: this.nowIso(),
        reviewNote: body.note ?? cur.reviewNote,
        updatedAt: this.nowIso(),
      }));
      if (!approved) throw new XhsOpsError(404, "评论草稿不存在");
      logger.info(
        {
          commentId,
          accountId: current.accountId,
          remaining: quota.remaining - 1,
        },
        "xhs-ops: comment approved",
      );
      return approved;
    });
  }
}
