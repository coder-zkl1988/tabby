import {
  type TaskResult,
  XHS_TAKEOVER_TIER_LABEL,
  type XhsOpsAnomaly,
  type XhsOpsAuditNoteCard,
  type XhsOpsCount,
  type XhsOpsHeaderCounts,
  type XhsOpsInteractionCounts,
  type XhsOpsMaturityTier,
  type XhsOpsRunPost,
  type XhsOpsTakeoverProfileField,
  xhsOpsAnomalyTypeSchema,
  xhsOpsIsTakeoverImageField,
  xhsOpsParseCount,
  xhsOpsRunPostActionSchema,
} from "@nexu/shared";
import { z } from "zod";

// Phone task text for one xhs-ops chunk (spec §5) and the parser for the
// structured record the phone appends to its COMPLETE return (spec §6).

/** Per-chunk allowance handed to the phone, already reduced by used quota. */
export interface XhsOpsChunkQuotaEntry {
  enabled: boolean;
  /** "本次最多 k 次" — 0 renders the switch as 关 so the model cannot misread. */
  max: number;
  /** Only meaningful for follow. Empty means do not invent a target category. */
  targetTypes?: string[];
}

export interface XhsOpsChunkQuota {
  like: XhsOpsChunkQuotaEntry;
  collect: XhsOpsChunkQuotaEntry;
  follow: XhsOpsChunkQuotaEntry;
}

export interface XhsOpsChunkTaskBase {
  label: string;
  positioning: string;
  /** 人设一句话（formatPersona 产出），空串表示未填。 */
  persona?: string;
  dwellSecMin: number;
  dwellSecMax: number;
  quota: XhsOpsChunkQuota;
  /**
   * Set for an existing account (entryMode "existing"): the header gains the
   * 账号阶段 lines and a home chunk asks for the feed match sentence (takeover
   * §5.3 #8, §3.5). Absent for a new account, whose text stays as it was.
   */
  existingAccount?: { maturity: XhsOpsMaturityTier | null } | null;
}

export interface XhsOpsSearchChunkTaskInput extends XhsOpsChunkTaskBase {
  keyword: string;
  count: number;
}

export interface XhsOpsHomeChunkTaskInput extends XhsOpsChunkTaskBase {
  count: number;
}

function switchText(entry: XhsOpsChunkQuotaEntry): string {
  const on = entry.enabled && entry.max > 0;
  return `${on ? "开" : "关"}，本次最多 ${on ? entry.max : 0} 次`;
}

function interactionLine(scope: string, quota: XhsOpsChunkQuota): string {
  const followTargets = quota.follow.targetTypes
    ?.map((entry) => entry.trim())
    .filter(Boolean);
  const followRule =
    quota.follow.enabled && quota.follow.max > 0
      ? followTargets && followTargets.length > 0
        ? `；关注对象只限：${followTargets.join("、")}`
        : "；未指定关注对象类型，本次不得关注"
      : "";
  return `互动配置（只对与${scope}强相关且真正感兴趣的少数帖子，分散不相邻，第 1–2 篇纯浏览）：点赞 ${switchText(quota.like)}；收藏 ${switchText(quota.collect)}；关注 ${switchText(quota.follow)}${followRule}；禁止评论、禁止发布、禁止私信、禁止分享。`;
}

function dwellRange(input: XhsOpsChunkTaskBase): string {
  const low = Math.min(input.dwellSecMin, input.dwellSecMax);
  const high = Math.max(input.dwellSecMin, input.dwellSecMax);
  return `${low}–${high}`;
}

function browseStandardLine(
  input: XhsOpsChunkTaskBase,
  backTo: string,
): string {
  // An existing account's chunk names the two fields in words: the field
  // names contain the comment subskill's id (§3.4 rule 6). The research
  // subskill, which every chunk loads, spells them out.
  const record = input.existingAccount
    ? "并记下已读评论条数，评论区读完标记写 true"
    : "并记录 commentsRead 与 commentsComplete:true";
  return `浏览标准：每篇进入后第一动作 WAIT 2 秒；阅读正文并慢速滑到评论区，继续阅读直到明确到达评论区末尾或页面显示没有更多评论（0 条评论也可完成），${record}；无法确认读完时该篇不得计入 browsed。单篇总停留 ${dwellRange(input)} 秒，用 WAIT（1–4 秒、时长要变化）与慢滑组合凑够，不要连续 3 次以上只 WAIT 不滑动；看完用一次 BACK 返回${backTo}并确认。`;
}

const COMMON_ANOMALIES =
  "页面加载失败 → 等 5 秒重试一次，仍失败记录 load_failed；" +
  "出现登录页 → 记录 login_required 并立即结束；" +
  "出现账号异常/受限提示 → 记录 account_restricted 并立即结束；" +
  "出现“操作过于频繁”类提示 → 记录 rate_limited 并立即结束（不要再互动）；";

/**
 * The anomaly code an existing account's chunk records for a signed-out
 * phone. 登录 and login_required (which contains the subskill id) would load
 * the login subskill — and through its capabilities the SMS and installer
 * skills — on a task that allows TYPE (§3.4 rule 6), so the sign-in wall is
 * described instead and gets a code of its own. parseRecordJson and
 * parseCommentJson read it back as login_required, so run handling is the
 * same for both.
 */
export const XHS_EXISTING_SIGNED_OUT_CODE = "phone_required";

const EXISTING_COMMON_ANOMALIES = [
  "页面加载失败 → 等 5 秒重试一次，仍失败记录 load_failed；",
  `出现手机号输入页而不是内容页 → 记录 ${XHS_EXISTING_SIGNED_OUT_CODE} 并立即结束；`,
  "出现账号异常/受限提示 → 记录 account_restricted 并立即结束；",
  "出现“操作过于频繁”类提示 → 记录 rate_limited 并立即结束（不要再互动）；",
].join("");

function commonAnomalies(input: XhsOpsChunkTaskBase): string {
  return input.existingAccount ? EXISTING_COMMON_ANOMALIES : COMMON_ANOMALIES;
}

/**
 * How a chunk asks for image notes. 图文 is a post keyword (and a media
 * picker one), so an existing account's chunk says it without the word.
 */
function noteKindHint(input: XhsOpsChunkTaskBase): string {
  return input.existingAccount ? "优先带配图的笔记" : "图文优先";
}

/** 把结构化人设压成一句话进任务头："32岁·女·北京海淀·互联网产品经理·2岁娃新手妈妈"。 */
export function formatPersona(
  persona:
    | {
        age?: string;
        gender?: string;
        region?: string;
        occupation?: string;
        lifeStatus?: string;
      }
    | null
    | undefined,
): string {
  if (!persona) return "";
  return [
    persona.age,
    persona.gender,
    persona.region,
    persona.occupation,
    persona.lifeStatus,
  ]
    .map((x) => (x ?? "").trim())
    .filter((x) => x.length > 0)
    .join("·");
}

function headerLine(input: XhsOpsChunkTaskBase): string {
  const persona = (input.persona ?? "").trim();
  return `【小红书内容研究任务｜账号定位：${input.label}｜${persona ? `人设：${persona}｜` : ""}${input.positioning}】`;
}

/**
 * The two header lines an existing account's chunk carries (takeover §5.3
 * #8). Every prohibition sits in one 禁止 clause split only by 、: the phone
 * treats a subskill keyword as negated only when its own clause carries the
 * marker, so 「不进入发布页」 would still load the post subskill (§3.4 rule 6).
 */
export function existingAccountStageLines(
  maturity: XhsOpsMaturityTier | null,
): string[] {
  return [
    `账号阶段：已有内容的账号${maturity ? `（${XHS_TAKEOVER_TIER_LABEL[maturity]}）` : ""}。`,
    "禁止修改资料、进入发布页、进入草稿箱、点去设置、前往设置、打开应用信息页。",
  ];
}

function stageLines(input: XhsOpsChunkTaskBase): string[] {
  return input.existingAccount
    ? existingAccountStageLines(input.existingAccount.maturity)
    : [];
}

/** Opening of the first observation sentence an existing account's home chunk writes (takeover §3.5, §4.2). */
export const XHS_HOME_FEED_MATCH_PREFIX = "推荐流匹配度：";
const HOME_FEED_MATCH_PATTERN = /推荐流匹配度[:：]\s*(高|中|低)/;
const HOME_FEED_MATCH: Record<string, XhsOpsHomeFeedMatch> = {
  高: "high",
  中: "medium",
  低: "low",
};

export type XhsOpsHomeFeedMatch = "high" | "medium" | "low";

/** The 推荐流匹配度 an existing account's home chunk reported; null when absent. */
export function parseHomeFeedMatch(
  observation: string | null | undefined,
): XhsOpsHomeFeedMatch | null {
  const level = observation?.match(HOME_FEED_MATCH_PATTERN)?.[1];
  return level ? (HOME_FEED_MATCH[level] ?? null) : null;
}

function ledgerLine(count: number): string {
  return `记账：key_process 每篇更新 \`已浏览 x/${count}；已互动 赞a 藏b 关c；已处理：标题[动作]\`。`;
}

const RECORD_JSON_INSTRUCTION =
  "COMPLETE 的 return 先写 3–6 行人读汇报，最后一行必须是 RECORD_JSON: 加一行紧凑 JSON；planned 必须等于本块计划数，posts 必须逐篇记录且 posts.length 必须等于 browsed，每篇必须含实际 dwellSeconds、commentsRead 和 commentsComplete:true；缺字段或未达到要求时不得报告 completed";

/**
 * RECORD_JSON key of an existing account's chunk (§6.3, NU-04): notes it did
 * not like because the account had liked them before — an old account liked
 * much of its feed, so fewer likes than the quota is normal and the run says
 * how many. parseRecordJson reads a missing or unreadable value as 0.
 */
export const XHS_ALREADY_LIKED_SKIPPED_KEY = "alreadyLikedSkipped";

/**
 * RECORD_JSON_INSTRUCTION without the field names that contain a subskill id
 * (posts → post, commentsRead/commentsComplete → comment, §3.4 rule 6). The
 * research subskill every chunk loads gives the exact names.
 */
const EXISTING_RECORD_JSON_INSTRUCTION = `COMPLETE 的 return 先写 3–6 行人读汇报，最后一行必须是 RECORD_JSON: 加一行紧凑 JSON；planned 必须等于本块计划数，逐篇记录的数组条数必须等于 browsed，每篇必须含实际停留秒数、已读评论条数和评论区读完标记 true（字段名按 research 子技能）；顶层 ${XHS_ALREADY_LIKED_SKIPPED_KEY} 填本块因笔记之前已点过赞而没有再点的篇数，没有就填 0；缺字段或未达到要求时不得报告 completed`;

function recordJsonInstruction(input: XhsOpsChunkTaskBase): string {
  return input.existingAccount
    ? EXISTING_RECORD_JSON_INSTRUCTION
    : RECORD_JSON_INSTRUCTION;
}

export function buildSearchChunkTask(
  input: XhsOpsSearchChunkTaskInput,
): string {
  const n = input.count;
  return [
    headerLine(input),
    ...stageLines(input),
    `本次只处理一个关键词：搜索「${input.keyword}」，完整浏览 ${n} 篇与关键词直接相关的普通笔记（${noteKindHint(input)}，视频可选）。`,
    browseStandardLine(input, "结果页"),
    interactionLine("关键词", input.quota),
    `异常处理：搜索无结果 → 记录 no_results 后直接结束本关键词；${commonAnomalies(input)}结果与关键词明显不相关 → 记录 content_mismatch，可少浏览。`,
    ledgerLine(n),
    `结束：达到 ${n} 篇或无更多相关内容时，确认回到搜索结果页，按通用规则回到桌面，然后 COMPLETE。${recordJsonInstruction(input)}；每篇 dwellSeconds 必须 ≥ ${Math.min(input.dwellSecMin, input.dwellSecMax)}，顶层 refreshCount 必须为 0（格式见技能 research 子技能），不能省略。`,
  ].join("\n");
}

export function buildHomeChunkTask(input: XhsOpsHomeChunkTaskInput): string {
  const m = input.count;
  return [
    headerLine(input),
    ...stageLines(input),
    `本次不搜索：在首页推荐流自然浏览 ${m} 篇（不搜索，凭兴趣挑与账号定位相关的内容，跳过广告/直播），${noteKindHint(input)}，视频可选。`,
    browseStandardLine(input, "首页推荐流"),
    interactionLine("账号定位", input.quota),
    `异常处理：推荐流无内容或刷不出新内容 → 记录 no_results 后直接结束；${commonAnomalies(input)}推荐内容与账号定位明显不相关 → 记录 content_mismatch，可少浏览。`,
    ledgerLine(m),
    `结束：达到 ${m} 篇或无更多相关内容时，确认回到首页推荐流，按通用规则回到桌面，然后 COMPLETE。${recordJsonInstruction(input)}；每篇 dwellSeconds 必须 ≥ ${Math.min(input.dwellSecMin, input.dwellSecMax)}，顶层 refreshCount 记录本次真实首页刷新次数（格式见技能 research 子技能，mode 填 home，keyword 填 null），不能省略。`,
    // An existing account's feed is already tagged, so a mismatch is a signal
    // rather than the new-account norm; research.md:13 already allows a match
    // note in observation, so this needs no phone-skill release.
    ...(input.existingAccount
      ? [
          `observation 第一句写「${XHS_HOME_FEED_MATCH_PREFIX}高/中/低」三选一，按本次推荐内容与账号定位的重合程度判断。`,
        ]
      : []),
  ].join("\n");
}

// ─── RECORD_JSON parsing (spec §6) ───────────────────────────────────────────

export const RECORD_JSON_MARKER = "RECORD_JSON:";
const MAX_POSTS = 20;
const MAX_TITLE_CHARS = 40;
const MAX_TEXT_CHARS = 500;

/** Non-negative integer; anything unparseable becomes 0. */
const lenientCount = z.preprocess((value) => {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value)
        : Number.NaN;
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}, z.number().int().min(0));

const lenientText = (max: number) =>
  z
    .string()
    .catch("")
    .transform((s) => s.slice(0, max));

/** An anomaly code as the run reads it: an existing account's sign-in code is login_required. */
function readAnomalyType(type: unknown): unknown {
  return type === XHS_EXISTING_SIGNED_OUT_CODE ? "login_required" : type;
}

const lenientAnomaly = z.preprocess(
  (value) =>
    typeof value === "string"
      ? { type: readAnomalyType(value), detail: "" }
      : isRecord(value)
        ? { ...value, type: readAnomalyType(value.type) }
        : value,
  z.object({
    type: xhsOpsAnomalyTypeSchema.catch("other"),
    detail: lenientText(MAX_TEXT_CHARS),
  }),
);

const lenientBoolean = z.preprocess(
  (value) => value === true || value === "true" || value === 1 || value === "1",
  z.boolean(),
);

const lenientPost = z.object({
  title: lenientText(MAX_TITLE_CHARS),
  author: lenientText(MAX_TITLE_CHARS),
  action: xhsOpsRunPostActionSchema.catch("none"),
  commentsRead: lenientCount,
  dwellSeconds: lenientCount,
  commentsComplete: lenientBoolean.catch(false),
  // P3-1：手机标注"值不值得评" + 一句正文摘要；旧版技能不带这两个字段。
  commentWorthy: lenientBoolean.catch(false),
  summary: lenientText(120),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Drop list entries that cannot possibly be items (null, numbers, ...). */
const objectList = (allowStrings: boolean) =>
  z.preprocess(
    (value) =>
      Array.isArray(value)
        ? value.filter(
            (item) =>
              isRecord(item) || (allowStrings && typeof item === "string"),
          )
        : [],
    z.array(z.unknown()),
  );

const recordJsonSchema = z.object({
  mode: z.enum(["search", "home"]).nullable().catch(null),
  keyword: z.string().nullable().catch(null),
  planned: lenientCount,
  browsed: lenientCount,
  skipped: lenientCount,
  refreshCount: lenientCount,
  interactions: z
    .object({ like: lenientCount, collect: lenientCount, follow: lenientCount })
    .catch({ like: 0, collect: 0, follow: 0 }),
  anomalies: objectList(true).transform((items) =>
    items.flatMap((item) => {
      const parsed = lenientAnomaly.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  posts: objectList(false).transform((items) =>
    items.slice(0, MAX_POSTS).flatMap((item) => {
      const parsed = lenientPost.safeParse(item);
      return parsed.success ? [parsed.data] : [];
    }),
  ),
  [XHS_ALREADY_LIKED_SKIPPED_KEY]: lenientCount,
  observation: z
    .string()
    .nullable()
    .catch(null)
    .transform((s) => (s === null ? null : s.slice(0, MAX_TEXT_CHARS * 2))),
});

export interface XhsOpsRecordJson {
  mode: "search" | "home" | null;
  keyword: string | null;
  planned: number;
  browsed: number;
  skipped: number;
  interactions: XhsOpsInteractionCounts;
  anomalies: XhsOpsAnomaly[];
  refreshCount: number;
  posts: XhsOpsRunPost[];
  /** Existing accounts' chunks only ask for it; 0 when missing (XHS_ALREADY_LIKED_SKIPPED_KEY). */
  alreadyLikedSkipped: number;
  observation: string | null;
}

/** Longest lead-in a marker's line may carry before its object. */
const MAX_MARKER_LEAD_IN_CHARS = 24;

function skipBlank(text: string, from: number): number {
  let i = from;
  while (i < text.length && /\s/.test(text.charAt(i))) i += 1;
  return i;
}

/**
 * Where a marker's object opens, or -1. Between the marker and its `{` the
 * phone's model sometimes puts one short lead-in on the marker's line
 * (「结果如下：」) and/or a code fence (```json) — which main's comment parser
 * tolerated, and refusing them dropped the result of a comment that may
 * already be public. Nothing longer is skipped: the lead-in holds no brace,
 * bracket or backtick, stays under MAX_MARKER_LEAD_IN_CHARS and names no other
 * marker, so the phone's own `[设备校验]` / `[回执]` lines after an empty
 * marker can never be read as its payload.
 */
function objectStart(text: string, from: number): number {
  let i = skipBlank(text, from);
  if (text.charAt(i) !== "{" && !text.startsWith("```", i)) {
    let end = i;
    while (
      end < text.length &&
      end - i <= MAX_MARKER_LEAD_IN_CHARS &&
      !/[{}[\]`\n]/.test(text.charAt(end))
    ) {
      end += 1;
    }
    if (
      end - i > MAX_MARKER_LEAD_IN_CHARS ||
      /[A-Z]_JSON:/.test(text.slice(i, end))
    ) {
      return -1;
    }
    i = skipBlank(text, end);
  }
  if (text.startsWith("```", i)) {
    i += 3;
    while (/[A-Za-z]/.test(text.charAt(i))) i += 1;
    i = skipBlank(text, i);
  }
  return text.charAt(i) === "{" ? i : -1;
}

/**
 * The `{…}` that opens at `from` (after the lead-in objectStart allows),
 * matched brace for brace outside strings, so a `}` inside a title or a
 * trailing sentence cannot end it early. Null when nothing opens there or
 * the object never closes (a truncated reply).
 */
function balancedObject(text: string, from: number): string | null {
  const start = objectStart(text, from);
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text.charAt(i);
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function payloadAfterLastMarker(
  text: string,
  marker: string,
): Record<string, unknown> | null {
  const idx = text.lastIndexOf(marker);
  if (idx < 0) return null;
  const raw = balancedObject(text, idx + marker.length);
  if (raw === null) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * The JSON object after the LAST `marker` in a phone return (takeover §3.4
 * rule 1). It is located in the raw message first: a multi-line 简介 arrives
 * as an escaped `\n` inside a JSON string, and turning those into real line
 * breaks before cutting at a line end truncated it ("Unterminated string").
 * Only when that fails is the message retried with literal `\n` normalised,
 * for replies that used them as line breaks between tokens. Text around the
 * object is ignored: CollectedReport inserts its block before the marker
 * line, CompletionGate and the action receipt append `[设备校验]` / `[回执]`
 * lines after it (rule 2).
 */
export function extractMarkerPayload(
  message: string | null | undefined,
  marker: string,
): Record<string, unknown> | null {
  if (!message) return null;
  const direct = payloadAfterLastMarker(message, marker);
  if (direct !== null || !message.includes("\\n")) return direct;
  return payloadAfterLastMarker(message.replace(/\\n/g, "\n"), marker);
}

/**
 * Parse the payload after the LAST `RECORD_JSON:` leniently. Returns null when
 * the marker is absent or its payload is not a JSON object — callers then
 * fall back to {@link extractBrowsedFromMessage}.
 */
export function parseRecordJson(
  message: string | null | undefined,
): XhsOpsRecordJson | null {
  const payload = extractMarkerPayload(message, RECORD_JSON_MARKER);
  if (payload === null) return null;
  const parsed = recordJsonSchema.safeParse(payload);
  return parsed.success ? parsed.data : null;
}

const BROWSED_PATTERN = /已浏览\s*(\d+)\s*\/\s*(\d+)/g;

/** Fallback for messages without a usable RECORD_JSON: the last ledger line. */
export function extractBrowsedFromMessage(
  message: string | null | undefined,
): { browsed: number; planned: number } | null {
  if (!message) return null;
  let last: RegExpExecArray | null = null;
  for (const match of message.matchAll(BROWSED_PATTERN)) {
    last = match;
  }
  if (!last) return null;
  return {
    browsed: Number.parseInt(last[1] ?? "0", 10),
    planned: Number.parseInt(last[2] ?? "0", 10),
  };
}

// ─── 资料维护（P2-1 账号基础资料应用到手机）────────────────────────────────

export interface XhsOpsProfileApplyTaskInput {
  label: string;
  platformAccountId: string;
  nickname?: string | null;
  bio?: string | null;
  occupation?: string | null;
  /** 已推送到手机「Tabby」相册的文件名（不含路径） */
  avatarFilename?: string | null;
  coverFilename?: string | null;
  /** This apply operation's isolated gallery album. */
  mediaAlbum?: string | null;
  gender?: "男" | "女" | "不展示" | null;
  birthday?: string | null;
  region?: string | null;
}

export const PROFILE_JSON_MARKER = "PROFILE_JSON:";

/**
 * 「我」 remembers where it was last scrolled to. Walk back into it after a
 * previous task left the phone in the note list and the header is collapsed:
 * the profile block folds into the title bar as a bare avatar, and 昵称、
 * 关注/粉丝 and 编辑主页 are all off screen. Agents read that as "wrong page"
 * and go navigating instead of scrolling back up, so every task that has to
 * reach 编辑主页 spells out how to unfold it (reported 2026-09-20).
 */
export const XHS_ME_TAB_UNFOLD_HINT =
  '「我」页会保留上次的滚动位置：进入后正文可能已经停在笔记/收藏列表，个人信息折叠进顶部标题栏只剩一个小头像，看不到昵称、关注/粉丝和「编辑主页」。这不是走错页面，也不要退出重进——用 SCROLL direction:"up" 把页面滚回顶部（一次不够就连续几次），头像、昵称与「编辑主页」会重新展开；确认它们可见后再继续。';

/**
 * 按 xhs profile 子技能的纪律组织：每次只改一个字段、保存后回「我」页核对；
 * 头像/背景从刚推送的相册图片里按文件名选；未列出的字段一律不碰。
 * 结束时最后一行 PROFILE_JSON 给桌面回读各字段 done/failed/skipped。
 */
export function buildProfileApplyTask(
  input: XhsOpsProfileApplyTaskInput,
): string {
  const steps: string[] = [];
  let n = 1;
  if (input.nickname?.trim()) {
    steps.push(
      `${n++}) 名字：点「名字」进入编辑页，点输入框后**只执行一次 TYPE**，整体替换为「${input.nickname.trim()}」，点保存/完成；遇到修改次数、字符或敏感词限制就停止并原样记下提示。`,
    );
  }
  if (input.bio?.trim()) {
    steps.push(
      `${n++}) 简介：点「简介」，**只执行一次 TYPE**，整体替换为下面这段（原样输入，不改写、不追加）：\n${input.bio.trim()}`,
    );
  }
  if (input.occupation?.trim()) {
    steps.push(
      `${n++}) 职业：点「职业」进入「选择你的身份」，先在左侧选择与目标人设匹配的一级分类，再在右侧选择完全匹配的二级职业「${input.occupation.trim()}」；只能选择这个精确项，找不到就记 failed，不得用相近职业代替；保存后回到编辑主页核对职业已显示。`,
    );
  }
  if (input.avatarFilename) {
    steps.push(
      // The picker exposes no filename: its grid cells carry no text and no
      // content-desc, so the file name we pushed is unusable as a selector.
      // What IS visible is album, recency and the picture itself.
      `${n++}) 头像：点编辑主页顶部的圆形头像 → 进入头像预览页后点「上传新头像」（**不要**点「制作 AI 头像」或「获取头像挂件」）→ 相册选择器打开后先点顶部的相册名（默认是「全部」）→ 在下拉里选「${input.mediaAlbum ?? "Tabby"}」相册 → 目标是刚推送的那张人物半身照（方形/竖构图，画面是一个人，有自然环境背景）。`,
    );
    steps.push(
      `${n++}) 选中后进入裁剪预览：**必须确认画面确实是人物半身照**，不是风景、不是卡通、不是截图；不对就返回重选，不得将就。确认后点完成/保存。`,
    );
  }
  if (input.coverFilename) {
    steps.push(
      `${n++}) 背景图：只点「背景图」字段（不要点头像）→ 相册选择器里先切到「${input.mediaAlbum ?? "Tabby"}」相册 → 只从这个相册选择刚推送的横构图风景照（画面是城市/自然风景，远处有一个人的背影），不要选择人物半身照或其他相册图片 → 确认画面后保存。`,
    );
  }
  if (input.gender) {
    steps.push(
      `${n++}) 性别：点「性别」，只选择与目标「${input.gender}」完全一致的选项；没有精确选项就记 failed，不得代选。`,
    );
  }
  if (input.birthday?.trim()) {
    steps.push(
      // The date sheet is a custom-drawn wheel: uiautomator sees three empty
      // Views with no text, nothing scrollable and nothing clickable, so the
      // only way in is a coordinate drag read off the screenshot.
      `${n++}) 生日：点「生日」→ 底部弹出「选择你的生日」滚轮抽屉。**滚轮上的年/月/日不是可点击控件，点它们没有任何作用，只能拖动**：滚轮区域横向等分为年、月、日三列，当前选中的值在滚轮区域的垂直中心（上下有两条分隔线）。拖动用「SLIDE」：point1 放在该列中心，point2 同列、上下相距约一行高度；向下拖数值变小、向上拖数值变大，每约一行高度前进一格。SLIDE 本身就是无惯性精确拖拽，滚动距离等于手指位移，不必也无法另外指定时长。滚轮对 SLIDE 完全没反应时可以改用「LONGPRESSANDDRAG」（本任务已放行）。**禁止使用「FLING」**——惯性会把滚轮甩过目标值。默认停在今天，所以年份通常要向下拖很多格。`,
    );
    steps.push(
      `${n++}) 生日操作纪律：**一次最多拖 3 格就停下截图核对中心行的值**，据此计算还差几格；禁止快速甩动（会惯性滑过），禁止一次拖很长距离。按年→月→日的顺序逐列调到「${input.birthday.trim()}」，三列全部核对无误后再点抽屉右上角的「保存」；差一格也不得将就，调不到就记 failed。`,
    );
  }
  if (input.region?.trim()) {
    steps.push(
      `${n++}) 地区：点「地区」后第一级是 200+ 项的**全球国家/地区平铺长列表**，没有搜索框也没有 A-Z 索引，「中国」在列表**末端**（邻近项：泽西岛、智利、中国、中非共和国、赞比亚）。**必须用「FLING」而不是「SLIDE」**：SLIDE 是无惯性精确拖拽，一次只走一屏位移，这个列表要滑二十多次才到底，步数不够用（已发生过，60 步全花在这一步上）；FLING 抬指速度高，列表顺着惯性自己滑很远。point1 取列表区域底部、point2 取顶部（如「FLING point1:540,1900 point2:540,400」），连续 FLING 直到画面不再变化即为列表尽头，再在可见项里点「中国」。**这一步最多花 12 个动作**：到第 12 个还没到尽头就停下，记 failed 并在结果里写明滑到了哪个地区名，不要退出重进列表——反复重进同样会把整轮步数耗光。进入「中国」后再按页面层级选择与「${input.region.trim()}」完全一致的地区；存在同名或无法精确匹配就记 failed。`,
    );
  }
  return [
    `【小红书资料维护任务｜账号定位：${input.label}】`,
    `AWAKE 小红书 → 底部「我」→ 编辑主页，先只读核对“小红书号”与目标「${input.platformAccountId.trim()}」完全一致；不一致立即 failed，禁止修改。身份一致后按下面顺序逐项修改，**每次只改一个字段**，保存后回到「我」页核对再改下一项：`,
    XHS_ME_TAB_UNFOLD_HINT,
    ...steps,
    // Partial photo access ("仅选择照片") leaves the in-app album showing
    // 「未找到图片文件」 — the pushed pictures are on disk and in MediaStore but
    // invisible to the app, so every later "pick the right image" step is
    // guesswork. Full access is what makes the album usable at all.
    "相册权限：系统询问照片访问时选「允许访问所有照片」。若相册选择器显示「未找到图片文件」或一张图都没有，说明当前是「仅选择部分照片」权限，此时不要硬选，把头像/背景图记为 failed 并在 note 里写「相册权限受限」。",
    "禁止改动小红书号、实名认证、学校等未列出的字段；出现登录页/账号异常/验证码 → 停止并记为 failed。",
    "隐私：key_process 与汇报里不要复述名字、简介的具体内容，只记「已修改/失败/跳过」。",
    '结束：回到「我」页核对已改字段确实更新，按通用规则 HOME 回桌面后 COMPLETE。COMPLETE 的 return 先写 2–4 行人读汇报，最后一行必须是 PROFILE_JSON: 加一行紧凑 JSON：{"nickname":"done|failed|skipped","bio":"done|failed|skipped","occupation":"done|failed|skipped","avatar":"done|failed|skipped","cover":"done|failed|skipped","gender":"done|failed|skipped","birthday":"done|failed|skipped","region":"done|failed|skipped","note":"一句话"}，未要求修改的字段写 skipped。不得在回执复述小红书号或生日。',
  ].join("\n");
}

export type XhsOpsProfileFieldOutcome = "done" | "failed" | "skipped";
export interface XhsOpsProfileJson {
  nickname: XhsOpsProfileFieldOutcome;
  bio: XhsOpsProfileFieldOutcome;
  occupation?: XhsOpsProfileFieldOutcome;
  avatar: XhsOpsProfileFieldOutcome;
  cover: XhsOpsProfileFieldOutcome;
  gender: XhsOpsProfileFieldOutcome;
  birthday: XhsOpsProfileFieldOutcome;
  region: XhsOpsProfileFieldOutcome;
  note: string;
}

function outcome(v: unknown): XhsOpsProfileFieldOutcome {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "done" || s === "failed") return s;
  return "skipped";
}

/** 与 parseRecordJson 同样宽容：经 extractMarkerPayload 定位，marker 位置无关、尾随文本容忍。 */
export function parseProfileJson(
  message: string | null | undefined,
): XhsOpsProfileJson | null {
  const payload = extractMarkerPayload(message, PROFILE_JSON_MARKER);
  if (payload === null) return null;
  return {
    nickname: outcome(payload.nickname),
    bio: outcome(payload.bio),
    ...(payload.occupation !== undefined
      ? { occupation: outcome(payload.occupation) }
      : {}),
    avatar: outcome(payload.avatar),
    cover: outcome(payload.cover),
    gender: outcome(payload.gender),
    birthday: outcome(payload.birthday),
    region: outcome(payload.region),
    note: typeof payload.note === "string" ? payload.note.slice(0, 200) : "",
  };
}

export const PROFILE_VERIFICATION_JSON_MARKER = "PROFILE_VERIFICATION_JSON:";
const profileVerificationFieldsSchema = z
  .object({
    nickname: z.boolean(),
    bio: z.boolean(),
    // Older phone skills did not include occupation in the verification
    // receipt. The caller requires it explicitly when the current task asked
    // the phone to write occupation.
    occupation: z.boolean().optional(),
    avatar: z.boolean(),
    cover: z.boolean(),
    gender: z.boolean(),
    birthday: z.boolean(),
    region: z.boolean(),
  })
  .strict();

const profileVerificationSchema = z
  .object({
    v: z.literal(1),
    status: z.enum(["verified", "failed"]),
    accountMatched: z.boolean(),
    fields: profileVerificationFieldsSchema,
  })
  .strict();

export type XhsOpsProfileVerification = z.infer<
  typeof profileVerificationSchema
>;

const accountIdentitySchema = z.object({
  v: z.literal(1),
  status: z.enum(["visible", "unavailable"]),
  accountId: z.string().catch(""),
});

/** Pull the 小红书号 out of the identity receipt so the card can prefill it. */
export function parseAccountIdentityJson(
  message: string | null | undefined,
): { status: "visible" | "unavailable"; accountId: string } | null {
  const parsed = accountIdentitySchema.safeParse(
    extractMarkerPayload(message, XHS_IDENTITY_MARKER),
  );
  if (!parsed.success) return null;
  return {
    status: parsed.data.status,
    // Ids are digits; anything else is the model narrating.
    accountId: /^[A-Za-z0-9_-]{1,40}$/.test(parsed.data.accountId.trim())
      ? parsed.data.accountId.trim()
      : "",
  };
}

export const XHS_PROFILE_READBACK_MARKER = "PROFILE_READBACK_JSON:";

/**
 * Read-only task that reports the phone's CURRENT profile text, so the desktop
 * can diff it against the draft before overwriting anything.
 *
 * This one does return field values — comparing them is the point. The 小红书号
 * stays out: identity is gated by its own check and does not need to travel.
 * 头像/背景图 are not reported at all; an image cannot be compared as text.
 */
export function buildProfileReadbackTask(): string {
  return [
    "【小红书资料回读】本任务只读取，不修改、不保存、不登录、不退出、不切换账号，也不执行浏览互动。",
    "AWAKE 小红书 → 底部「我」→ 编辑资料，逐项读取当前已有内容：名字、简介、职业、性别、生日、地区。",
    XHS_ME_TAB_UNFOLD_HINT,
    "字段为空或显示为占位提示（如「介绍一下自己」「选择生日」「编辑性别」）时，该字段返回空字符串，不要把占位文案当成内容。",
    "隐私：不得读取或回传小红书号、手机号、实名信息；不要进入任何需要验证的页面。",
    '未登录、停在登录页或找不到编辑资料页时，返回 status:"unavailable" 并结束，不要尝试登录。',
    // Same reason as the identity task: the completion screenshot is part of
    // what the operator reviews, so do not go HOME first.
    `**必须停留在编辑资料页上直接 COMPLETE，不要 HOME、不要 BACK**。return 只能是一行 ${XHS_PROFILE_READBACK_MARKER}{"v":1,"status":"read|unavailable","nickname":"…","bio":"…","occupation":"…","gender":"…","birthday":"…","region":"…"}，生日用 YYYY-MM-DD，读不到的字段用空字符串，不得附带其他字段。`,
  ].join("\n");
}

export const XHS_IDENTITY_MARKER = "IDENTITY_JSON:";

/**
 * Read-only task that parks the phone on 编辑主页 so the final screenshot shows
 * which account is signed in.
 *
 * The number itself must never reach the receipt — the operator reads it off
 * the screenshot instead. That is the whole point of the step: confirming the
 * phone against what the operator *intended* is a real check, whereas typing a
 * number copied from the phone would only compare the phone with itself.
 */
export function buildAccountIdentityTask(): string {
  return [
    "【小红书当前账号识别】本任务只读取并停留，不修改、不保存、不登录、不退出、不切换账号，也不执行任何浏览、点赞、收藏、关注、评论、发布或私信。",
    "AWAKE 小红书 → 底部「我」→ 编辑主页，停在能看到“小红书号”那一屏。",
    XHS_ME_TAB_UNFOLD_HINT,
    // The id now travels, but only in the structured last line: the operator
    // wants the field auto-filled, and re-typing it off the screenshot was the
    // step people got wrong. It still stays out of the narrative trail.
    "小红书号只能出现在最后一行 JSON 的 accountId 字段里；不得写进动作说明、key_process、进度或日志。",
    "未登录、停在登录页、出现账号异常或找不到编辑主页时，不要尝试登录或切换，直接结束并返回 unavailable。",
    // Deliberately no HOME before COMPLETE: the completion screenshot is the
    // deliverable, so the phone has to still be on 编辑主页 when it is taken.
    `**必须停留在编辑主页上直接 COMPLETE，不要 HOME、不要 BACK、不要退出小红书**——完成时的截图就是给运营核对账号用的，回到桌面就废了。return 只能是一行 ${XHS_IDENTITY_MARKER}{"v":1,"status":"visible|unavailable","accountId":"页面上读到的小红书号"}，读不到时 accountId 用空字符串；不得附带昵称、简介或其他资料原文。`,
  ].join("\n");
}

export function buildProfileVerificationTask(
  input: XhsOpsProfileApplyTaskInput,
): string {
  return [
    "【小红书资料只读验收】本任务只读取并核对资料，不修改、保存、登录、退出、切换账号或执行浏览互动。",
    `AWAKE 小红书 → “我” → 编辑主页，先逐字核对“小红书号”与目标「${input.platformAccountId.trim()}」完全一致；不一致时 accountMatched=false 并结束。不得在过程或回执复述号码。`,
    XHS_ME_TAB_UNFOLD_HINT,
    `逐项读取并核对目标：昵称「${input.nickname?.trim() ?? ""}」；简介「${input.bio?.trim() ?? ""}」；职业「${input.occupation?.trim() ?? ""}」；头像为刚应用的 ${input.avatarFilename ?? "目标图片"}；背景图为刚应用的 ${input.coverFilename ?? "目标图片"}；性别「${input.gender ?? ""}」；生日「${input.birthday?.trim() ?? ""}」；地区「${input.region?.trim() ?? ""}」。`,
    "文字和选择项必须与目标精确一致；头像、背景图必须在编辑页和主页均显示为刚应用的目标图。无法进入字段、看不清、结果不确定均记 false，不得猜测 true。",
    `核对后 HOME 回桌面并 COMPLETE。return 只能是一行 ${PROFILE_VERIFICATION_JSON_MARKER}{"v":1,"status":"verified|failed","accountMatched":true|false,"fields":{"nickname":true|false,"bio":true|false,"occupation":true|false,"avatar":true|false,"cover":true|false,"gender":true|false,"birthday":true|false,"region":true|false}}。只有账号匹配且八项全部核对一致时 status=verified；不得增加字段或附带资料原文。`,
  ].join("\n");
}

const profileReadbackSchema = z.object({
  v: z.literal(1),
  status: z.enum(["read", "unavailable"]),
  nickname: z.string().catch(""),
  bio: z.string().catch(""),
  occupation: z.string().catch("").optional(),
  gender: z.string().catch(""),
  birthday: z.string().catch(""),
  region: z.string().catch(""),
});

export type XhsOpsProfileReadbackValues = z.infer<typeof profileReadbackSchema>;

/** Lenient sibling of parseProfileVerificationJson for the readback receipt. */
export function parseProfileReadbackJson(
  message: string | null | undefined,
): XhsOpsProfileReadbackValues | null {
  const parsed = profileReadbackSchema.safeParse(
    extractMarkerPayload(message, XHS_PROFILE_READBACK_MARKER),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * Strict, internally consistent verification receipt. Lines around it are
 * not held against it (takeover §3.4 rule 2): the collected block, the
 * `[设备校验]` and `[回执]` lines are appended by the phone, not the model.
 */
export function parseProfileVerificationJson(
  message: string | null | undefined,
  options: { requireOccupation?: boolean } = {},
): XhsOpsProfileVerification | null {
  const parsed = profileVerificationSchema.safeParse(
    extractMarkerPayload(message, PROFILE_VERIFICATION_JSON_MARKER),
  );
  if (!parsed.success) return null;
  if (options.requireOccupation && parsed.data.fields.occupation !== true) {
    return null;
  }
  const allFieldsMatch = Object.values(parsed.data.fields).every(Boolean);
  if (
    (parsed.data.status === "verified") !==
    (parsed.data.accountMatched && allFieldsMatch)
  ) {
    return null;
  }
  return parsed.data;
}

// ─── Comment task (P3-1 D2) ─────────────────────────────────────────────────

export interface XhsOpsCommentChunkTaskInput {
  label: string;
  positioning: string;
  persona: string;
  postTitle: string;
  postAuthor: string;
  /** 人工审核通过的原文；手机端策略白名单里也只有这一条。 */
  text: string;
  /**
   * An existing account (takeover §3.4 rule 6): the text avoids 登录,
   * 发一条 and the codes that contain a subskill id (login_required,
   * post_not_found), which load login and post on a task that allows TYPE.
   * Absent for a new account, whose text stays as it was.
   */
  existingAccount?: boolean;
}

export const COMMENT_JSON_MARKER = "COMMENT_JSON:";

/**
 * 一条评论一个任务：按标题搜帖 → 核对作者 → 慢滑看正文 → 评论框 TYPE 原文
 * （一次）→ 发送 → 确认出现 → BACK。手机端 TaskPolicy 只放行这一条原文，
 * 改写、评别的帖子、回复他人在机械层面都会被拦。
 */
export function buildCommentChunkTask(
  input: XhsOpsCommentChunkTaskInput,
): string {
  const who = input.postAuthor ? `作者「${input.postAuthor}」` : "作者不明";
  const existing = input.existingAccount === true;
  const notFound = existing ? "note_not_found" : "post_not_found";
  return [
    `【小红书评论任务｜账号定位：${input.label}${input.persona ? `｜人设：${input.persona}` : ""}${input.positioning ? `｜${input.positioning}` : ""}】`,
    `本次只做一件事：给一篇已经浏览过的笔记${existing ? "留下一条" : "发一条"}**人工审核通过的**评论。目标笔记标题：「${input.postTitle}」，${who}。`,
    `1. 首页右上角放大镜 → TYPE 输入笔记标题「${input.postTitle}」→ 搜索；在结果里找标题一致、${who}的那篇，点进去。找不到（被删/改名/搜不出）→ 记 ${notFound}，不要评其他帖子，直接进入"结束"。`,
    "2. 进入详情后先 WAIT 2 秒，慢滑看正文 5–10 秒（1–2 次 SCROLL + WAIT），像看完再评。",
    "3. 点底部评论输入框（「说点什么」）→ 用一次 TYPE 原样输入下面这段文字，一个字都不能改、不能加表情或标点：",
    `   ${input.text}`,
    "4. 点「发送」。WAIT 2 秒，确认评论区出现自己昵称 + 这段原文；出现即算 sent。若提示「评论失败」「操作频繁」「内容违规」等 → 记 comment_failed 并把提示原文写进 detail，不要重试、不要改字重发。",
    "5. 一次 BACK 回列表，按通用规则回到桌面，然后 COMPLETE。",
    existing
      ? `禁止：改写文案、评论目标以外的任何帖子、回复他人评论、连发第二条、点赞/收藏/关注（本任务不做互动）、私信、分享。出现手机号输入页/账号异常/操作频繁提示 → 分别记 ${XHS_EXISTING_SIGNED_OUT_CODE} / account_restricted / rate_limited 后立即结束。`
      : "禁止：改写文案、评论目标以外的任何帖子、回复他人评论、连发第二条、点赞/收藏/关注（本任务不做互动）、私信、分享。出现登录页/账号异常/操作频繁提示 → 分别记 login_required / account_restricted / rate_limited 后立即结束。",
    `结束：COMPLETE 的 return 先写 2–3 行人读汇报，最后一行必须是 ${COMMENT_JSON_MARKER} 加一行紧凑 JSON：{"v":1,"status":"sent|failed|skipped","detail":"一句话","anomalies":[{"type":"…","detail":"…"}]}，status 只能三选一：sent=评论已出现在评论区，failed=尝试了但没成功（含 comment_failed），skipped=没有尝试（${notFound}/异常）。之后不再写任何字。`,
  ].join("\n");
}

export interface XhsOpsCommentJson {
  status: "sent" | "failed" | "skipped";
  detail: string;
  anomalies: Array<{ type: string; detail: string }>;
}

/** 宽容解析 COMMENT_JSON（字面 \n、缺字段、非法 status 都兜住）；没有标记 → null。 */
export function parseCommentJson(message: string): XhsOpsCommentJson | null {
  const obj = extractMarkerPayload(message, COMMENT_JSON_MARKER);
  if (obj === null) return null;
  const statusRaw =
    typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  const status: XhsOpsCommentJson["status"] =
    statusRaw === "sent" || statusRaw === "failed" ? statusRaw : "skipped";
  const anomalies = Array.isArray(obj.anomalies)
    ? obj.anomalies
        .map((a) =>
          typeof a === "string"
            ? { type: String(readAnomalyType(a)), detail: "" }
            : a && typeof a === "object"
              ? {
                  type: String(
                    readAnomalyType((a as Record<string, unknown>).type) ??
                      "other",
                  ),
                  detail: String(
                    (a as Record<string, unknown>).detail ?? "",
                  ).slice(0, 200),
                }
              : null,
        )
        .filter((a): a is { type: string; detail: string } => a !== null)
    : [];
  return {
    status,
    detail: typeof obj.detail === "string" ? obj.detail.slice(0, 200) : "",
    anomalies,
  };
}

/** `[回执] 各应用生效点击: com.xingin.xhs=11` → 11；没有回执 → null。 */
export function parseReceiptClicks(
  message: string,
  pkg: string,
): number | null {
  const m = message.match(/\[回执\][^\n]*/);
  if (!m) return null;
  const entry = m[0].match(new RegExp(`${pkg.replace(/\./g, "\\.")}=(\\d+)`));
  return entry ? Number(entry[1]) : 0;
}

// ─── 老号接管：手机任务（takeover design §3）────────────────────────────────
//
// Every text here is written against TabbyApp's subskill selection: the task
// text is matched by substring against each xhs subskill's keywords, id and
// name, and a hit only counts as negated when its own clause (split on
// 。！？；，.!?;, and line breaks, never on 、) carries 禁止/不得/不要… or ends
// in 不. So prohibitions sit in one 禁止 clause split only by 、, and the body
// avoids subskill words altogether (§3.4 rule 6, guarded by
// tests/xhs-ops-skill-keywords.test.ts).

/**
 * XHS_ME_TAB_UNFOLD_HINT without 收藏、关注 or 编辑主页 — those positively load
 * interact on every task that carries the hint (§3.4 rule 6, N4). Tasks that
 * need 编辑主页 name it in their own step.
 */
export const XHS_AUDIT_UNFOLD_HINT =
  '「我」页会保留上次的滚动位置：进入后正文可能停在笔记列表，个人信息折叠进顶部标题栏只剩一个小头像。这不是走错页面，也不要退出重进——用 SCROLL direction:"up" 把页面滚回顶部（一次不够就连续几次），等头像、名字与头部计数重新展开后再继续。';

/** maxSteps / timeout per takeover phone task (§3.1); the apply values await real-device calibration. */
export const XHS_TAKEOVER_TASK_LIMITS = {
  identity: { maxSteps: 20, timeoutMs: 120_000 },
  profileArchive: { maxSteps: 40, timeoutMs: 180_000 },
  auditHome: { maxSteps: 35, timeoutMs: 240_000 },
  auditCreator: { maxSteps: 25, timeoutMs: 180_000 },
  precheck: { maxSteps: 30, timeoutMs: 180_000 },
  applyText: { maxSteps: 60, timeoutMs: 900_000 },
  applyImage: { maxSteps: 80, timeoutMs: 1_200_000 },
  verification: { maxSteps: 40, timeoutMs: 180_000 },
} as const;

/**
 * Click ceilings of the expected navigation per read-only task (§3.2 点击对账,
 * to calibrate on real phones): 资料存档 我 + 编辑主页 + one popup; A 我 +
 * popup; B 我、菜单、创作者入口、稍后再看 + one; the gate 3. Above it the
 * evidence is flagged unexpectedClicks and untrusted.
 */
export const XHS_AUDIT_CLICK_LIMITS = {
  profileArchive: 3,
  auditHome: 3,
  auditCreator: 5,
  gate: 3,
} as const;

export const XHS_AUDIT_HOME_MARKER = "AUDIT_HOME_JSON:";
export const XHS_AUDIT_CREATOR_MARKER = "AUDIT_CREATOR_JSON:";

/** tabby-control's errorCode when the phone's completion gate contradicted the report. */
export const REPORT_AUDIT_CONTRADICTED = "REPORT_AUDIT_CONTRADICTED";

const HEADER_COUNT_KEYS =
  "从左到右依次写进 followingText、followersText、likesCollectsText";
const HEADER_COUNTS_JSON =
  '{"followingText":"…","followersText":"…","likesCollectsText":"…"}';
const NOT_SIGNED_IN = "「我」页显示手机号输入页而不是个人主页";
const STAY_ON_EDIT_PAGE = "停在编辑主页上直接 COMPLETE，不要 HOME、不要 BACK。";
/**
 * Stop where both pictures are on screen, so the last screenshot shows them
 * (§5.2 steps 2 and 5). No 图片 here: it loads media-picker, and in the same
 * clause as 不要 HOME it was only negated by accident.
 */
function returnToMeTab(lead: string): string {
  return `${lead} BACK 回到「我」页，用 SCROLL direction:"up" 等头像、背景图和头部计数重新展开后直接 COMPLETE，不要 HOME。最后一张截图留给运营核对头像和背景图。`;
}

/**
 * Identity read of an existing account (§3.3 身份识别接管变体): the new-account
 * task with XHS_AUDIT_UNFOLD_HINT and without the 未登录/登录页 wording, which
 * positively loads the login subskill. Same IDENTITY_JSON receipt, read by
 * parseAccountIdentityJson.
 */
export function buildTakeoverIdentityTask(): string {
  return [
    "【小红书当前账号识别】本任务只读取并停留，不修改、不保存、不登录、不退出、不切换账号，也不执行任何浏览、点赞、收藏、关注、评论、发布或私信。",
    `AWAKE 小红书 → 底部「我」。${XHS_AUDIT_UNFOLD_HINT}`,
    "然后进入编辑主页，停在能看到“小红书号”那一屏。",
    "小红书号只能出现在最后一行 JSON 的 accountId 字段里；不得写进动作说明、key_process、进度或日志。",
    `${NOT_SIGNED_IN}、出现账号异常或打不开编辑主页时，直接结束并返回 unavailable，禁止尝试任何账号操作。`,
    // The completion screenshot is the deliverable, as in the new-account task.
    `**必须停留在编辑主页上直接 COMPLETE，不要 HOME、不要 BACK、不要退出小红书**——完成时的截图就是给运营核对账号用的，回到桌面就废了。return 只能是一行 ${XHS_IDENTITY_MARKER}{"v":1,"status":"visible|unavailable","accountId":"页面上读到的小红书号"}，读不到时 accountId 用空字符串；不得附带昵称、简介或其他资料原文。`,
  ].join("\n");
}

/**
 * Part one of an audit and the change-order precheck (§3.3 资料存档与号码核对):
 * compares the 小红书号 letter by letter like buildProfileVerificationTask —
 * never echoing it — and archives the current text fields, birthday only as
 * filled or not. Unlike buildProfileReadbackTask it carries no 「不得读取小红书号」,
 * which would contradict the comparison.
 *
 * With `fields` (a precheck) it first copies the three header counts into
 * `header`, and an order with an image ends back on 「我」 so the last
 * screenshot shows the current pictures (§5.2 step 2).
 */
export function buildTakeoverProfileReadbackTask(
  platformAccountId: string,
  fields?: readonly XhsOpsTakeoverProfileField[],
): string {
  const precheck = fields !== undefined;
  const withImage = fields?.some(xhsOpsIsTakeoverImageField) ?? false;
  return [
    "【小红书资料只读存档】禁止修改、保存、登录、退出、切换账号、点赞、收藏、关注、评论、打开笔记、进入需要验证的页面。",
    `AWAKE 小红书 → 底部「我」。${XHS_AUDIT_UNFOLD_HINT}`,
    ...(precheck
      ? [
          `先在「我」页头部按页面原样抄写头部三项计数（${HEADER_COUNT_KEYS}，写在 header 里），读不到写 null，不推算。`,
        ]
      : []),
    `进入编辑主页，先逐字核对“小红书号”与目标「${platformAccountId.trim()}」完全一致；不一致时 accountMatched=false 并立即结束。过程和回执禁止复述号码，也不得回传手机号或实名信息。`,
    "逐项读取当前内容：名字、简介、职业、性别、地区；生日只看是否已填写，禁止抄写日期。字段为空或显示为占位提示（如「介绍一下自己」「选择生日」「编辑性别」）时返回空字符串，不要把占位文案当成内容。",
    `${NOT_SIGNED_IN}，或编辑主页打不开时，返回 status:"unavailable" 并结束。`,
    withImage ? returnToMeTab("读完后") : STAY_ON_EDIT_PAGE,
    `return 只能是一行 ${XHS_PROFILE_READBACK_MARKER}{"v":1,"status":"read|unavailable","accountMatched":true|false,"nickname":"…","bio":"…","occupation":"…","gender":"…","birthdayFilled":true|false,"region":"…"${precheck ? `,"header":${HEADER_COUNTS_JSON}` : ""}}，字段值内不换行；读不到的字段用空字符串，不得附带其他字段。`,
  ].join("\n");
}

/**
 * Audit part A (§3.3 盘点 A): the 「我」 header read twice — at the start and
 * again at the end, for the follow-count diff — and up to `noteLimit` note
 * cards, without opening any of them or entering 编辑主页.
 */
export function buildAccountAuditHomeTask(noteLimit: number): string {
  const n = Math.max(1, Math.min(20, Math.floor(noteLimit)));
  return [
    "【小红书账号只读盘点】禁止点赞、收藏、关注、评论、分享、发布、私信、删除、修改或保存资料、登录、退出、切换账号、打开任何笔记卡片、长按、打开右上角菜单、进入编辑主页、切换到「笔记」以外的页签。",
    `1) AWAKE 小红书 → 底部「我」。${XHS_AUDIT_UNFOLD_HINT}`,
    `2) 在「我」页头部读取名字，以及头部三项计数（${HEADER_COUNT_KEYS}，按页面原样抄写，例如“1.2万”）。`,
    `3) 只用 SCROLL 在「笔记」页签内向下，按从上到下、从左到右最多记录 ${n} 张卡片：序号、标题（最多 20 字）、卡片右下角数字原样、是否视频、是否带置顶标记；每记一张用 collect 记一条「第i篇｜标题｜数字」。到底没有新卡片时 notesEnd=true。`,
    "4) SCROLL 回到顶部，再按第 2 步的方式抄一次头部三项计数写进 headerEnd，停在头部可见处直接 COMPLETE，保持停在小红书。",
    `${NOT_SIGNED_IN} → code=not_logged_in；账号异常 → account_restricted；出现“操作频繁/请稍后再试” → rate_limited；「笔记」页签打不开 → page_not_found；以上均 status:"unavailable" 并立即结束。页面加载失败等 5 秒重试一次，仍失败 → load_failed；已记下部分卡片后中途失败时 status:"partial"。`,
    `return 只能是一行 ${XHS_AUDIT_HOME_MARKER}{"v":1,"status":"read|partial|unavailable","code":"ok|not_logged_in|account_restricted|rate_limited|load_failed|page_not_found","nickname":"…","followingText":"…","followersText":"…","likesCollectsText":"…","headerEnd":${HEADER_COUNTS_JSON},"notesEnd":false,"notes":[{"i":1,"title":"…","likesText":"…","video":false,"pinned":false}],"note":""}。字段值内不换行、不写 \\n；禁止写“共N篇/张/条”之类总数；读不到的计数写 null；不足 ${n} 张时 note 写“只有 k 张”。`,
  ].join("\n");
}

/**
 * Audit part B (§3.3 盘点 B): header counts again on entering 「我」, then the
 * creator data card. A's nickname is never embedded here — it is untrusted
 * text that may carry subskill words or injected instructions — the desktop
 * compares the two instead.
 */
export function buildAccountAuditCreatorTask(): string {
  return [
    "【小红书创作者数据只读盘点】禁止点赞、收藏、关注、评论、分享、发布、私信、删除、修改或保存资料、登录、退出、切换账号、打开任何笔记、长按、进入编辑主页、点开数据卡里的任何条目、点任何开通或授权按钮。",
    '先 LOAD_SKILL value:"creator" 加载创作者参考文档。',
    `1) AWAKE 小红书 → 底部「我」。${XHS_AUDIT_UNFOLD_HINT}`,
    `2) 在「我」页头部按页面原样抄写名字和头部三项计数（${HEADER_COUNT_KEYS}）。`,
    "3) 点左上角菜单 → 创作者入口；遇到引导弹窗选「稍后再看」。",
    "4) 读近7日数据卡：periodLabel 抄数据卡上的时间说明；四项数据按页面顺序原样抄写，依次写进 viewsText、engagementText、newFollowersText、visitorsText；账号状态写进 accountStatus。页面没有的写 null，不推算。",
    "5) 停在数据卡上直接 COMPLETE。",
    `菜单里没有创作者入口 → status:"unavailable"、code=creator_unavailable；入口要求先开通或授权 → code=permission_required，不点开通或授权；${NOT_SIGNED_IN} → not_logged_in；账号异常 → account_restricted；出现“操作频繁/请稍后再试” → rate_limited；页面加载失败等 5 秒重试一次，仍失败 → load_failed；以上均立即结束。`,
    `return 只能是一行 ${XHS_AUDIT_CREATOR_MARKER}{"v":1,"status":"read|unavailable","code":"ok|creator_unavailable|permission_required|not_logged_in|account_restricted|rate_limited|load_failed","nickname":"…","followingText":"…","followersText":"…","likesCollectsText":"…","periodLabel":"…","viewsText":"…","engagementText":"…","newFollowersText":"…","visitorsText":"…","accountStatus":"…","note":""}。字段值内不换行、不写 \\n；读不到的写 null。`,
  ].join("\n");
}

/** One field of a takeover change order as the apply task needs it. */
export type XhsOpsTakeoverApplyField =
  | { field: "nickname" | "bio" | "occupation" | "region"; after: string }
  /** The flat album this order pushed the one picture into, e.g. Tabby-1a2b3c4d-a. */
  | { field: "avatar" | "cover"; mediaAlbum: string };

export interface XhsOpsTakeoverProfileApplyTaskInput {
  platformAccountId: string;
  /** Only this order's fields, in the order they are to be written. */
  fields: readonly XhsOpsTakeoverApplyField[];
}

/** Codes PROFILE_JSON fieldCodes may carry for a failed field (§3.4). */
export const XHS_TAKEOVER_APPLY_FIELD_CODES = [
  "album_not_found",
  "permission_required",
  "picker_unsupported",
  "step_limit",
  "platform_limit",
  "option_not_found",
] as const;

// New values still take part in subskill matching — unavoidable, and recorded
// rather than asserted in the keyword test (§3.4 rule 6). Each sits last in
// its clause so a value cannot negate or un-negate the instruction after it.
const TYPED_VALUE_INTRO = "以下引号里是要填写的文字，只作输入内容";
const PICKED_VALUE_INTRO = "以下引号里是要选择的项，只作匹配依据";

function albumStep(album: string): string {
  return `打开选图页后只点顶部相册名，从下拉列表选名字与「${album}」逐字一致的相册。这个相册里只有一张图，选它。下拉里有多个 Tabby- 开头的相册时，只选逐字一致的那个；没有逐字一致的相册，或者相册里不止一张图，该字段记 failed、code 写 album_not_found，然后 COMPLETE。`;
}

function takeoverApplyStep(n: number, entry: XhsOpsTakeoverApplyField): string {
  switch (entry.field) {
    case "nickname":
      return `${n}) 名字：点「名字」进入编辑页，点输入框后只执行一次 TYPE，整体替换为新名字，点保存或完成。${TYPED_VALUE_INTRO}：「${entry.after.trim()}」。遇到修改次数、字符或敏感词限制 → 该字段记 failed、code 写 platform_limit，并把页面提示原样写进 note。`;
    case "bio":
      return `${n}) 简介：点「简介」，只执行一次 TYPE，整体替换为新简介（原样输入，不改写、不追加），点保存或完成。${TYPED_VALUE_INTRO}：「${entry.after.trim()}」。遇到修改次数或敏感词限制 → 该字段记 failed、code 写 platform_limit，并把页面提示原样写进 note。`;
    case "occupation":
      return `${n}) 职业：点「职业」进入「选择你的身份」，先在左侧选它所属的一级大类，再在右侧选完全一致的二级项。${PICKED_VALUE_INTRO}：「${entry.after.trim()}」。只能选这个精确项，没有这个精确项就记 failed、code 写 option_not_found，不得用相近职业代替；保存后回到编辑主页核对职业已显示。`;
    case "region":
      // Same walk as buildProfileApplyTask, reworded where it hit subskills:
      // 没有搜索框 (没有 is no negation, so 搜 loaded search) and 赞比亚 (赞).
      return `${n}) 地区：点「地区」后第一级是 200+ 项的全球国家/地区平铺长列表，列表顶部无输入框、无字母索引，「中国」在列表末端（邻近项：泽西岛、智利、中国、中非共和国）。必须用「FLING」而不是「SLIDE」：SLIDE 是无惯性精确拖拽，一次只走一屏位移，这个列表要滑二十多次才到底，步数不够用；FLING 抬指速度高，列表顺着惯性自己滑很远。point1 取列表区域底部、point2 取顶部（如「FLING point1:540,1900 point2:540,400」），连续 FLING 直到画面不再变化即为列表尽头，再在可见项里点「中国」。这一步最多花 12 个动作：到第 12 个还没到尽头就停下，该字段记 failed、code 写 step_limit，并在 note 写明滑到了哪个地区名，不要退出重进列表——反复重进同样会把整轮步数耗光。进入「中国」后再按页面层级选择完全一致的地区。${PICKED_VALUE_INTRO}：「${entry.after.trim()}」。存在同名或无法精确匹配就记 failed、code 写 option_not_found。`;
    case "avatar":
      return `${n}) 头像：点编辑主页顶部的圆形头像 → 进入头像预览页后点「上传新头像」（不点「制作 AI 头像」或「获取头像挂件」）→ ${albumStep(entry.mediaAlbum)}选中后进入裁剪预览，不调整，直接点完成或保存。`;
    case "cover":
      return `${n}) 背景图：只点「背景图」字段（不点头像）→ ${albumStep(entry.mediaAlbum)}选中后直接点保存。`;
  }
}

/**
 * Profile change of a taken-over account (§3.3 资料修改接管变体, D1). Compared
 * with buildProfileApplyTask: only this order's fields; a full 禁止 clause
 * (messages, comments, publishing, sign-out, settings, every photo-access
 * option); no positive 登录/验证码; XHS_AUDIT_UNFOLD_HINT; each picture picked
 * as the only one in its own album, never by describing it, and permission
 * is never granted.
 *
 * ABORT only before anything is written. After the first write every failure
 * is COMPLETE with a PROFILE_JSON that marks the field failed with a code —
 * an aborted task returns no receipt, and the desktop then cannot tell which
 * fields already went public (§5.2 step 4).
 */
export function buildTakeoverProfileApplyTask(
  input: XhsOpsTakeoverProfileApplyTaskInput,
): string {
  const steps = input.fields.map((entry, i) => takeoverApplyStep(i + 1, entry));
  const withImage = input.fields.some((entry) =>
    xhsOpsIsTakeoverImageField(entry.field),
  );
  const receiptFields = input.fields
    .map((entry) => `"${entry.field}":"done|failed|skipped"`)
    .join(",");
  return [
    "【接管账号资料修改】只修改下面列出的字段。禁止发私信、发送消息、评论、点赞、收藏、关注、分享、发布、支付、登录、退出、切换账号、添加账号、点去设置、前往设置、打开应用信息页、更改任何权限、点任何照片授权选项（包括选择部分照片、允许访问所有照片）、删除或修改笔记、修改未列出的字段。",
    `AWAKE 小红书 → 底部「我」。${XHS_AUDIT_UNFOLD_HINT}`,
    `进入编辑主页，先只读核对“小红书号”与目标「${input.platformAccountId.trim()}」完全一致。过程和回执禁止复述号码。`,
    "写入任何字段之前遇到下列情况，立即 ABORT 并在 note 写明原因：「我」页显示手机号输入页、出现账号异常、要求输入数字码或扫码、号码比对不一致。",
    "开始写入之后，任何失败都不要 ABORT：该字段记 failed 并在 fieldCodes 写原因码，其余字段如实记 done 或 skipped，然后照常 COMPLETE 返回 PROFILE_JSON。",
    "身份一致后按下面顺序逐项修改，每次只改一个字段，改完一个字段回到「我」页核对一次再改下一项：",
    ...steps,
    ...(withImage
      ? [
          "选图规则（头像、背景图都适用）：出现照片访问授权弹窗时，按 BACK 关闭弹窗，不点其中任何选项，即使参考文档另有要求；选图页为空时同样处理；该字段记 failed、code 写 permission_required，然后 COMPLETE。不等待用户，不 CALL_USER，不 INFO。选图页不是小红书自己的页面（出现系统照片选择器或文件管理器）时，按 BACK 返回，该字段记 failed、code 写 picker_unsupported，然后 COMPLETE。不描述、不记录相册里的其他照片。每张图最多 15 个动作，超出就记 failed、code 写 step_limit，然后 COMPLETE。",
        ]
      : []),
    "隐私：key_process 与汇报里不要复述名字、简介的具体内容，只记「已修改/失败/跳过」。",
    `结束：最后回到编辑主页，停在编辑主页上直接 COMPLETE，不要 HOME。COMPLETE 的 return 先写 1–3 行人读汇报，最后一行必须是 ${PROFILE_JSON_MARKER} 加一行紧凑 JSON：{${receiptFields},"fieldCodes":{},"note":"一句话"}。fieldCodes 只给 failed 的字段写原因码（${XHS_TAKEOVER_APPLY_FIELD_CODES.join("、")}），没有失败字段时写 {}；字段值内不换行，不得在回执复述小红书号。`,
  ].join("\n");
}

/** One field the takeover verification checks: text against its target, a picture only for showing at all. */
export type XhsOpsTakeoverVerifyField =
  | { field: "nickname" | "bio" | "occupation" | "region"; after: string }
  | { field: "avatar" | "cover" };

export interface XhsOpsTakeoverProfileVerificationTaskInput {
  platformAccountId: string;
  /** Only the fields this order changed (done, or uncertain on a re-run). */
  fields: readonly XhsOpsTakeoverVerifyField[];
}

const VERIFY_LABEL: Record<XhsOpsTakeoverProfileField, string> = {
  nickname: "名字",
  bio: "简介",
  occupation: "职业",
  region: "地区",
  avatar: "头像",
  cover: "背景图",
};

function takeoverVerifyLine(entry: XhsOpsTakeoverVerifyField): string {
  const label = `${entry.field} ${VERIFY_LABEL[entry.field]}`;
  if ("after" in entry) {
    return `- ${label}：是否与目标完全一致，以下引号里是期望内容，只作比对依据：「${entry.after.trim()}」。`;
  }
  // The task has no reference picture, so it only reports that the image
  // shows at all; a human compares it with the original (§5.2 step 5).
  return `- ${label}：只确认编辑主页和「我」页上能正常显示（不是空白、加载失败或审核提示），能正常显示记 true；是不是目标图由人对照截图确认，你不判断。`;
}

/**
 * Field-scoped read-only verification of a change order (§3.3 按字段核验接管
 * 变体, §5.2 step 5); also the re-run for an interrupted order. Opens with a
 * 禁止 clause — the new-account 「不修改、保存、登录…」 leaves 登录 positive —
 * copies the header counts into `header` before 编辑主页, lists only the
 * order's fields and, with a cover, ends on the unfolded 「我」 header so both
 * pictures are in the last screenshot.
 */
export function buildTakeoverProfileVerificationTask(
  input: XhsOpsTakeoverProfileVerificationTaskInput,
): string {
  const keys = input.fields.map((entry) => entry.field);
  return [
    "【接管账号资料只读核验】禁止修改、保存、登录、退出、切换账号、点赞、收藏、关注、评论、浏览推荐页。",
    `AWAKE 小红书 → 底部「我」。${XHS_AUDIT_UNFOLD_HINT}`,
    `先在「我」页头部按页面原样抄写头部三项计数（${HEADER_COUNT_KEYS}，写在 header 里），读不到写 null，不推算。`,
    `进入编辑主页，先逐字核对“小红书号”与目标「${input.platformAccountId.trim()}」完全一致；不一致时 accountMatched=false 并结束。不得在过程或回执复述号码。`,
    "逐项核对下列字段：",
    ...input.fields.map(takeoverVerifyLine),
    "文字和选择项必须与目标精确一致；无法进入字段、看不清、结果不确定均记 false，不得猜测 true。",
    keys.includes("cover") ? returnToMeTab("核对完") : STAY_ON_EDIT_PAGE,
    `return 只能是一行 ${PROFILE_VERIFICATION_JSON_MARKER}{"v":1,"status":"verified|failed","accountMatched":true|false,"fields":{${keys.map((key) => `"${key}":true|false`).join(",")}},"header":${HEADER_COUNTS_JSON}}。fields 只允许下列字段：${keys.join("、")}；只有账号匹配且这些字段全部核对一致时 status=verified；不得附带资料原文。`,
  ].join("\n");
}

// ─── 老号接管：回执解析（takeover design §3.4）──────────────────────────────

/** Page text of one count; numbers are tolerated, "null" and blanks are nothing read. */
function countText(value: unknown): string | null {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.toLowerCase() !== "null" ? trimmed : null;
}

function parseCountField(value: unknown): XhsOpsCount | null {
  return xhsOpsParseCount(countText(value));
}

/**
 * The three header counts from `followingText`/`followersText`/
 * `likesCollectsText` keys (§3.4 rule 5). Other keys are ignored; null when
 * none of the three was read.
 */
function headerCounts(
  record: Record<string, unknown>,
): XhsOpsHeaderCounts | null {
  const counts = {
    following: parseCountField(record.followingText),
    followers: parseCountField(record.followersText),
    likesCollects: parseCountField(record.likesCollectsText),
  };
  return counts.following || counts.followers || counts.likesCollects
    ? counts
    : null;
}

/** A nested `header` object; missing, null or not an object means not read. */
function nestedHeaderCounts(value: unknown): XhsOpsHeaderCounts | null {
  return isRecord(value) ? headerCounts(value) : null;
}

const cappedText = (max: number) =>
  z
    .string()
    .catch("")
    .transform((s) => s.trim().slice(0, max));

/**
 * Downgrade a receipt that still parsed on a report the phone's completion
 * gate contradicted: it is partial, never read (§3.4 rule 4).
 */
export function auditReceiptStatus<
  S extends "read" | "partial" | "unavailable",
>(status: S, errorCode: string | null | undefined): S | "partial" {
  return status === "read" && errorCode === REPORT_AUDIT_CONTRADICTED
    ? "partial"
    : status;
}

export interface XhsOpsAuditReceiptTrust {
  /** parseReceiptClicks for the app; null when the phone appended no `[回执]` line. */
  receiptClicks: number | null;
  trusted: boolean;
  /** More clicks than the expected navigation (XHS_AUDIT_CLICK_LIMITS). */
  unexpectedClicks: boolean;
  /** errorCode REPORT_AUDIT_CONTRADICTED. */
  contradicted: boolean;
  warnings: string[];
}

/**
 * How far one read-only task's evidence can be trusted (§3.2 点击对账, §3.4
 * rule 4). A click count is only a hint — navigation clicks count too — so
 * it never proves the task stayed read-only, but a missing `[回执]` line is
 * itself abnormal: every one of these tasks taps 「我」 at least once.
 */
export function assessAuditReceipt(
  result: Pick<TaskResult, "message" | "errorCode">,
  options: { packageName: string; clickLimit: number },
): XhsOpsAuditReceiptTrust {
  const receiptClicks = parseReceiptClicks(
    result.message ?? "",
    options.packageName,
  );
  const contradicted = result.errorCode === REPORT_AUDIT_CONTRADICTED;
  const unexpectedClicks =
    receiptClicks !== null && receiptClicks > options.clickLimit;
  const warnings: string[] = [];
  if (receiptClicks === null) warnings.push("缺少点击回执，无法对账");
  else if (receiptClicks === 0) warnings.push("点击回执里没有小红书的点击");
  if (unexpectedClicks)
    warnings.push(
      `点击 ${receiptClicks} 次，超过预期路径的 ${options.clickLimit} 次`,
    );
  if (contradicted) warnings.push("手机端完成校验认为汇报与执行记录矛盾");
  return {
    receiptClicks,
    trusted:
      receiptClicks !== null &&
      receiptClicks > 0 &&
      !unexpectedClicks &&
      !contradicted,
    unexpectedClicks,
    contradicted,
    warnings,
  };
}

const takeoverProfileReadbackSchema = z.object({
  v: z.literal(1),
  status: z.enum(["read", "unavailable"]),
  // Anything but a literal true is a mismatch: the session is then dropped.
  accountMatched: z.boolean().catch(false),
  nickname: cappedText(40),
  bio: cappedText(200),
  occupation: cappedText(40),
  gender: cappedText(8),
  birthdayFilled: lenientBoolean.catch(false),
  region: cappedText(60),
  header: z.unknown().optional(),
});

export interface XhsOpsTakeoverProfileReadback {
  status: "read" | "unavailable";
  accountMatched: boolean;
  /** Same shape as an audit's profile.values; a birthday never travels, only whether it is filled. */
  values: {
    nickname: string;
    bio: string;
    occupation: string;
    gender: string;
    birthdayFilled: boolean;
    region: string;
  };
  /** Only a precheck asks for it; null when absent or nothing was read. */
  header: XhsOpsHeaderCounts | null;
}

/** PROFILE_READBACK_JSON of buildTakeoverProfileReadbackTask; null when `v:1` or the status is missing. */
export function parseTakeoverProfileReadbackJson(
  message: string | null | undefined,
): XhsOpsTakeoverProfileReadback | null {
  const parsed = takeoverProfileReadbackSchema.safeParse(
    extractMarkerPayload(message, XHS_PROFILE_READBACK_MARKER),
  );
  if (!parsed.success) return null;
  const data = parsed.data;
  return {
    status: data.status,
    accountMatched: data.accountMatched,
    values: {
      nickname: data.nickname,
      bio: data.bio,
      occupation: data.occupation,
      gender: data.gender,
      birthdayFilled: data.birthdayFilled,
      region: data.region,
    },
    header: nestedHeaderCounts(data.header),
  };
}

const auditHomeCodeSchema = z.enum([
  "ok",
  "not_logged_in",
  "account_restricted",
  "rate_limited",
  "load_failed",
  "page_not_found",
]);
export type XhsOpsAuditHomeCode = z.infer<typeof auditHomeCodeSchema>;

const auditHomeSchema = z.object({
  v: z.literal(1),
  status: z.enum(["read", "partial", "unavailable"]),
  code: z.unknown(),
  nickname: cappedText(24),
  headerEnd: z.unknown().optional(),
  notesEnd: lenientBoolean.catch(false),
  notes: z.unknown(),
  note: cappedText(200),
});

const auditNoteCardSchema = z.object({
  i: z.number().int().min(1).max(20),
  title: cappedText(20),
  likesText: z.unknown(),
  video: lenientBoolean.catch(false),
  pinned: lenientBoolean.catch(false),
});

export interface XhsOpsAuditHomeReceipt {
  status: "read" | "partial" | "unavailable";
  code: XhsOpsAuditHomeCode;
  /** Untrusted page text; the desktop compares it with the archived name. */
  nickname: string;
  header: XhsOpsHeaderCounts | null;
  headerEnd: XhsOpsHeaderCounts | null;
  notesEnd: boolean;
  notes: XhsOpsAuditNoteCard[];
  note: string;
}

/** Note cards by index, first copy of each index kept, at most `limit` of them. */
function noteCards(value: unknown, limit: number): XhsOpsAuditNoteCard[] {
  if (!Array.isArray(value)) return [];
  const byIndex = new Map<number, XhsOpsAuditNoteCard>();
  for (const item of value) {
    const parsed = auditNoteCardSchema.safeParse(item);
    if (!parsed.success || parsed.data.i > limit) continue;
    if (byIndex.has(parsed.data.i)) continue;
    byIndex.set(parsed.data.i, {
      i: parsed.data.i,
      title: parsed.data.title,
      likes: parseCountField(parsed.data.likesText),
      video: parsed.data.video,
      pinned: parsed.data.pinned,
    });
  }
  return [...byIndex.values()].sort((a, b) => a.i - b.i);
}

/** AUDIT_HOME_JSON of buildAccountAuditHomeTask; an unknown code falls back on the status. */
export function parseAuditHomeJson(
  message: string | null | undefined,
  noteLimit = 20,
): XhsOpsAuditHomeReceipt | null {
  const payload = extractMarkerPayload(message, XHS_AUDIT_HOME_MARKER);
  const parsed = auditHomeSchema.safeParse(payload);
  if (payload === null || !parsed.success) return null;
  const code = auditHomeCodeSchema.safeParse(parsed.data.code);
  return {
    status: parsed.data.status,
    code: code.success
      ? code.data
      : parsed.data.status === "unavailable"
        ? "load_failed"
        : "ok",
    nickname: parsed.data.nickname,
    header: headerCounts(payload),
    headerEnd: nestedHeaderCounts(parsed.data.headerEnd),
    notesEnd: parsed.data.notesEnd,
    notes: noteCards(parsed.data.notes, Math.min(20, noteLimit)),
    note: parsed.data.note,
  };
}

const auditCreatorCodeSchema = z.enum([
  "ok",
  "creator_unavailable",
  "permission_required",
  "not_logged_in",
  "account_restricted",
  "rate_limited",
  "load_failed",
]);
export type XhsOpsAuditCreatorCode = z.infer<typeof auditCreatorCodeSchema>;

const auditCreatorSchema = z.object({
  v: z.literal(1),
  status: z.enum(["read", "unavailable"]),
  code: z.unknown(),
  nickname: cappedText(24),
  periodLabel: cappedText(24),
  viewsText: z.unknown(),
  engagementText: z.unknown(),
  newFollowersText: z.unknown(),
  visitorsText: z.unknown(),
  accountStatus: cappedText(20),
  note: cappedText(200),
});

export interface XhsOpsAuditCreatorReceipt {
  status: "read" | "unavailable";
  code: XhsOpsAuditCreatorCode;
  nickname: string;
  header: XhsOpsHeaderCounts | null;
  periodLabel: string;
  views: XhsOpsCount | null;
  /** engagementText — renamed on the phone side so it no longer loads interact. */
  interactions: XhsOpsCount | null;
  newFollowers: XhsOpsCount | null;
  /** visitorsText — renamed on the phone side so it no longer loads profile. */
  profileVisitors: XhsOpsCount | null;
  accountStatus: string;
  note: string;
}

/** AUDIT_CREATOR_JSON of buildAccountAuditCreatorTask, mapped onto the audit's creator part. */
export function parseAuditCreatorJson(
  message: string | null | undefined,
): XhsOpsAuditCreatorReceipt | null {
  const payload = extractMarkerPayload(message, XHS_AUDIT_CREATOR_MARKER);
  const parsed = auditCreatorSchema.safeParse(payload);
  if (payload === null || !parsed.success) return null;
  const code = auditCreatorCodeSchema.safeParse(parsed.data.code);
  return {
    status: parsed.data.status,
    code: code.success
      ? code.data
      : parsed.data.status === "unavailable"
        ? "load_failed"
        : "ok",
    nickname: parsed.data.nickname,
    header: headerCounts(payload),
    periodLabel: parsed.data.periodLabel,
    views: parseCountField(parsed.data.viewsText),
    interactions: parseCountField(parsed.data.engagementText),
    newFollowers: parseCountField(parsed.data.newFollowersText),
    profileVisitors: parseCountField(parsed.data.visitorsText),
    accountStatus: parsed.data.accountStatus,
    note: parsed.data.note,
  };
}

const takeoverVerificationSchema = z
  .object({
    v: z.literal(1),
    status: z.enum(["verified", "failed"]),
    accountMatched: z.boolean(),
    fields: z.record(z.string(), z.boolean()),
    // The one key the takeover variant adds; its content is read leniently.
    header: z.unknown().optional(),
  })
  .strict();

export interface XhsOpsTakeoverProfileVerification {
  status: "verified" | "failed";
  accountMatched: boolean;
  fields: Partial<Record<XhsOpsTakeoverProfileField, boolean>>;
  header: XhsOpsHeaderCounts | null;
}

/**
 * PROFILE_VERIFICATION_JSON of buildTakeoverProfileVerificationTask (§5.2
 * step 5). Valid only when the field keys are exactly `requiredFields` and the
 * status agrees with them: verified ⇔ accountMatched and every field true.
 * Strict like parseProfileVerificationJson, except that `header` is allowed.
 */
export function parseTakeoverProfileVerificationJson(
  message: string | null | undefined,
  options: { requiredFields: readonly XhsOpsTakeoverProfileField[] },
): XhsOpsTakeoverProfileVerification | null {
  const parsed = takeoverVerificationSchema.safeParse(
    extractMarkerPayload(message, PROFILE_VERIFICATION_JSON_MARKER),
  );
  if (!parsed.success) return null;
  const required = new Set<string>(options.requiredFields);
  const keys = Object.keys(parsed.data.fields);
  if (
    required.size === 0 ||
    keys.length !== required.size ||
    keys.some((key) => !required.has(key))
  ) {
    return null;
  }
  const fields: Partial<Record<XhsOpsTakeoverProfileField, boolean>> = {};
  for (const field of options.requiredFields) {
    fields[field] = parsed.data.fields[field] === true;
  }
  const allMatch = Object.values(fields).every(Boolean);
  if (
    (parsed.data.status === "verified") !==
    (parsed.data.accountMatched && allMatch)
  ) {
    return null;
  }
  return {
    status: parsed.data.status,
    accountMatched: parsed.data.accountMatched,
    fields,
    header: nestedHeaderCounts(parsed.data.header),
  };
}

export type XhsOpsTakeoverApplyFieldCode =
  | (typeof XHS_TAKEOVER_APPLY_FIELD_CODES)[number]
  | "other";

/** uncertain = no usable receipt for the field: it may have gone public and is settled by the next precheck readback. */
export type XhsOpsTakeoverApplyOutcome =
  | "done"
  | "failed"
  | "skipped"
  | "uncertain";

export interface XhsOpsTakeoverProfileApplyReceipt {
  /** false when no PROFILE_JSON could be extracted; every field is then uncertain. */
  extracted: boolean;
  fields: Array<{
    field: XhsOpsTakeoverProfileField;
    outcome: XhsOpsTakeoverApplyOutcome;
    /** fieldCodes entry, kept for failed fields only. */
    code: XhsOpsTakeoverApplyFieldCode | null;
  }>;
  /** The phone's one-line note, where platform limits are quoted. */
  note: string;
}

const takeoverApplyFieldCodeSchema = z.enum(XHS_TAKEOVER_APPLY_FIELD_CODES);

function applyOutcome(value: unknown): XhsOpsTakeoverApplyOutcome {
  const s = typeof value === "string" ? value.trim().toLowerCase() : "";
  return s === "done" || s === "failed" || s === "skipped" ? s : "uncertain";
}

/**
 * PROFILE_JSON of buildTakeoverProfileApplyTask (§5.2 step 4). Pass the
 * message whatever the task's status: an aborted or blocked task can still
 * carry the receipt, and only without one do the fields become uncertain. A
 * requested field the receipt leaves out, or reports in a form outside
 * done/failed/skipped, is uncertain too — unlike parseProfileJson, which
 * reads that as skipped.
 */
export function parseTakeoverProfileJson(
  message: string | null | undefined,
  fields: readonly XhsOpsTakeoverProfileField[],
): XhsOpsTakeoverProfileApplyReceipt {
  const payload = extractMarkerPayload(message, PROFILE_JSON_MARKER);
  if (payload === null) {
    return {
      extracted: false,
      fields: fields.map((field) => ({
        field,
        outcome: "uncertain",
        code: null,
      })),
      note: "",
    };
  }
  const codes = isRecord(payload.fieldCodes) ? payload.fieldCodes : {};
  return {
    extracted: true,
    fields: fields.map((field) => {
      const outcome = applyOutcome(payload[field]);
      const raw = codes[field];
      const code =
        outcome !== "failed" || typeof raw !== "string" || !raw.trim()
          ? null
          : (takeoverApplyFieldCodeSchema.safeParse(raw.trim().toLowerCase())
              .data ?? "other");
      return { field, outcome, code };
    }),
    note: typeof payload.note === "string" ? payload.note.slice(0, 200) : "",
  };
}
