import {
  type XhsOpsAnomaly,
  type XhsOpsInteractionCounts,
  type XhsOpsRunPost,
  xhsOpsAnomalyTypeSchema,
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
  return `浏览标准：每篇进入后第一动作 WAIT 2 秒；阅读正文并慢速滑到评论区，继续阅读直到明确到达评论区末尾或页面显示没有更多评论（0 条评论也可完成），并记录 commentsRead 与 commentsComplete:true；无法确认读完时该篇不得计入 browsed。单篇总停留 ${dwellRange(input)} 秒，用 WAIT（1–4 秒、时长要变化）与慢滑组合凑够，不要连续 3 次以上只 WAIT 不滑动；看完用一次 BACK 返回${backTo}并确认。`;
}

const COMMON_ANOMALIES =
  "页面加载失败 → 等 5 秒重试一次，仍失败记录 load_failed；" +
  "出现登录页 → 记录 login_required 并立即结束；" +
  "出现账号异常/受限提示 → 记录 account_restricted 并立即结束；" +
  "出现“操作过于频繁”类提示 → 记录 rate_limited 并立即结束（不要再互动）；";

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

function ledgerLine(count: number): string {
  return `记账：key_process 每篇更新 \`已浏览 x/${count}；已互动 赞a 藏b 关c；已处理：标题[动作]\`。`;
}

const RECORD_JSON_INSTRUCTION =
  "COMPLETE 的 return 先写 3–6 行人读汇报，最后一行必须是 RECORD_JSON: 加一行紧凑 JSON；planned 必须等于本块计划数，posts 必须逐篇记录且 posts.length 必须等于 browsed，每篇必须含实际 dwellSeconds、commentsRead 和 commentsComplete:true；缺字段或未达到要求时不得报告 completed";

export function buildSearchChunkTask(
  input: XhsOpsSearchChunkTaskInput,
): string {
  const n = input.count;
  return [
    headerLine(input),
    `本次只处理一个关键词：搜索「${input.keyword}」，完整浏览 ${n} 篇与关键词直接相关的普通笔记（图文优先，视频可选）。`,
    browseStandardLine(input, "结果页"),
    interactionLine("关键词", input.quota),
    `异常处理：搜索无结果 → 记录 no_results 后直接结束本关键词；${COMMON_ANOMALIES}结果与关键词明显不相关 → 记录 content_mismatch，可少浏览。`,
    ledgerLine(n),
    `结束：达到 ${n} 篇或无更多相关内容时，确认回到搜索结果页，按通用规则回到桌面，然后 COMPLETE。${RECORD_JSON_INSTRUCTION}；每篇 dwellSeconds 必须 ≥ ${Math.min(input.dwellSecMin, input.dwellSecMax)}，顶层 refreshCount 必须为 0（格式见技能 research 子技能），不能省略。`,
  ].join("\n");
}

export function buildHomeChunkTask(input: XhsOpsHomeChunkTaskInput): string {
  const m = input.count;
  return [
    headerLine(input),
    `本次不搜索：在首页推荐流自然浏览 ${m} 篇（不搜索，凭兴趣挑与账号定位相关的内容，跳过广告/直播），图文优先，视频可选。`,
    browseStandardLine(input, "首页推荐流"),
    interactionLine("账号定位", input.quota),
    `异常处理：推荐流无内容或刷不出新内容 → 记录 no_results 后直接结束；${COMMON_ANOMALIES}推荐内容与账号定位明显不相关 → 记录 content_mismatch，可少浏览。`,
    ledgerLine(m),
    `结束：达到 ${m} 篇或无更多相关内容时，确认回到首页推荐流，按通用规则回到桌面，然后 COMPLETE。${RECORD_JSON_INSTRUCTION}；每篇 dwellSeconds 必须 ≥ ${Math.min(input.dwellSecMin, input.dwellSecMax)}，顶层 refreshCount 记录本次真实首页刷新次数（格式见技能 research 子技能，mode 填 home，keyword 填 null），不能省略。`,
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

const lenientAnomaly = z.preprocess(
  (value) => (typeof value === "string" ? { type: value, detail: "" } : value),
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
  observation: string | null;
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw);
    if (isRecord(value)) return value;
  } catch {
    // fall through to the trailing-sentence tolerance below
  }
  // "…} 以上为本次记录" — a trailing sentence after the JSON on the same line is
  // accepted only when the substring up to the last `}` parses on its own.
  const end = raw.lastIndexOf("}");
  if (end < 0) return null;
  try {
    const value: unknown = JSON.parse(raw.slice(0, end + 1));
    return isRecord(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Take the LAST line starting with `RECORD_JSON:` (surrounding whitespace
 * tolerated) and parse it leniently. Returns null when the marker is absent
 * or its payload is not a JSON object — callers then fall back to
 * {@link extractBrowsedFromMessage}.
 */
export function parseRecordJson(
  message: string | null | undefined,
): XhsOpsRecordJson | null {
  if (!message) return null;
  // 手机端可能把换行写成字面 "\\n"（GLM 在 tab 分隔单行格式下的习惯），
  // 此时 RECORD_JSON: 不在真实行首；先归一化，再取最后一个 marker 出现处——
  // marker 之后到下一个真实换行为止就是载荷（尾随的 [回执] 行在下一行）。
  const normalized = message.replace(/\\n/g, "\n");
  const idx = normalized.lastIndexOf(RECORD_JSON_MARKER);
  if (idx < 0) return null;
  const rest = normalized.slice(idx + RECORD_JSON_MARKER.length);
  const lineEnd = rest.indexOf("\n");
  const payload = parseJsonObject(
    (lineEnd < 0 ? rest : rest.slice(0, lineEnd)).trim(),
  );
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
  /** 已推送到手机「Tabby」相册的文件名（不含路径） */
  avatarFilename?: string | null;
  coverFilename?: string | null;
  gender?: "男" | "女" | "不展示" | null;
  birthday?: string | null;
  region?: string | null;
  interestTags?: string[];
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
  if (input.avatarFilename) {
    steps.push(
      // The picker exposes no filename: its grid cells carry no text and no
      // content-desc, so the file name we pushed is unusable as a selector.
      // What IS visible is album, recency and the picture itself.
      `${n++}) 头像：点编辑主页顶部的圆形头像 → 进入头像预览页后点「上传新头像」（**不要**点「制作 AI 头像」或「获取头像挂件」）→ 相册选择器打开后先点顶部的相册名（默认是「全部」）→ 在下拉里选「Tabby」相册 → 目标是**最近推送的那张人物半身照**（方形/竖构图，画面是一个人，有自然环境背景）；相册按时间倒序，目标就在最前面几张里。`,
    );
    steps.push(
      `${n++}) 选中后进入裁剪预览：**必须确认画面确实是人物半身照**，不是风景、不是卡通、不是截图；不对就返回重选，不得将就。确认后点完成/保存。`,
    );
  }
  if (input.coverFilename) {
    steps.push(
      `${n++}) 背景图：只点「背景图」字段（不要点头像）→ 相册选择器里同样先切到「Tabby」相册 → 目标是**最近推送的那张横构图风景照**（画面是城市/自然风景，远处有一个人的背影），与上一步的人物半身照是不同的两张 → 确认画面后保存。`,
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
      `${n++}) 生日：点「生日」→ 底部弹出「选择你的生日」滚轮抽屉。**滚轮上的年/月/日不是可点击控件，点它们没有任何作用，只能拖动**：滚轮区域横向等分为年、月、日三列，当前选中的值在滚轮区域的垂直中心（上下有两条分隔线）。拖动用「SLIDE」：point1 放在该列中心，point2 同列、上下相距约一行高度；向下拖数值变小、向上拖数值变大，每约一行高度前进一格。SLIDE 本身就是无惯性精确拖拽，滚动距离等于手指位移，不必也无法另外指定时长。滚轮对 SLIDE 完全没反应时可以改用「LONGPRESSANDDRAG」（本任务已放行）。**禁止甩动式快滑**——惯性会把滚轮甩过目标值。默认停在今天，所以年份通常要向下拖很多格。`,
    );
    steps.push(
      `${n++}) 生日操作纪律：**一次最多拖 3 格就停下截图核对中心行的值**，据此计算还差几格；禁止快速甩动（会惯性滑过），禁止一次拖很长距离。按年→月→日的顺序逐列调到「${input.birthday.trim()}」，三列全部核对无误后再点抽屉右上角的「保存」；差一格也不得将就，调不到就记 failed。`,
    );
  }
  if (input.region?.trim()) {
    steps.push(
      `${n++}) 地区：点「地区」后第一级是 200+ 项的**全球国家/地区平铺长列表**，没有搜索框也没有 A-Z 索引，「中国」在列表**末端**（邻近项：泽西岛、智利、中国、中非共和国、赞比亚）。**每次 SLIDE 都要跨满一屏**：point1 取列表区域底部、point2 取顶部（如「SLIDE point1:540,1900 point2:540,400」），连续滑动直到画面不再变化即为列表尽头，再在可见项里点「中国」。SLIDE 是无惯性精确拖拽，一次只走一屏位移，所以到尽头要滑二十多次，这是正常的：不要因为滑得慢就换别的动作，也不要退出重进列表——反复重进会把整轮步数耗光（已发生过，60 步全花在这一步上）。**这一步最多花 28 个动作**：到第 28 个还没到尽头就停下，记 failed 并在结果里写明滑到了哪个地区名。进入「中国」后再按页面层级选择与「${input.region.trim()}」完全一致的地区；存在同名或无法精确匹配就记 failed。`,
    );
  }
  const interestTags = (input.interestTags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean);
  if (interestTags.length > 0) {
    steps.push(
      `${n++}) 兴趣标签：进入当前版本可见的兴趣选择入口，只选择以下精确标签：${interestTags.join("、")}。入口不存在或任一标签无法精确匹配就记 failed，不得用相近标签替代。`,
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
    "禁止改动小红书号、实名认证、职业、学校等未列出的字段；出现登录页/账号异常/验证码 → 停止并记为 failed。",
    "隐私：key_process 与汇报里不要复述名字、简介的具体内容，只记「已修改/失败/跳过」。",
    '结束：回到「我」页核对已改字段确实更新，按通用规则 HOME 回桌面后 COMPLETE。COMPLETE 的 return 先写 2–4 行人读汇报，最后一行必须是 PROFILE_JSON: 加一行紧凑 JSON：{"nickname":"done|failed|skipped","bio":"done|failed|skipped","avatar":"done|failed|skipped","cover":"done|failed|skipped","gender":"done|failed|skipped","birthday":"done|failed|skipped","region":"done|failed|skipped","interestTags":"done|failed|skipped","note":"一句话"}，未要求修改的字段写 skipped。不得在回执复述小红书号或生日。',
  ].join("\n");
}

export type XhsOpsProfileFieldOutcome = "done" | "failed" | "skipped";
export interface XhsOpsProfileJson {
  nickname: XhsOpsProfileFieldOutcome;
  bio: XhsOpsProfileFieldOutcome;
  avatar: XhsOpsProfileFieldOutcome;
  cover: XhsOpsProfileFieldOutcome;
  gender: XhsOpsProfileFieldOutcome;
  birthday: XhsOpsProfileFieldOutcome;
  region: XhsOpsProfileFieldOutcome;
  interestTags: XhsOpsProfileFieldOutcome;
  note: string;
}

function outcome(v: unknown): XhsOpsProfileFieldOutcome {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (s === "done" || s === "failed") return s;
  return "skipped";
}

/** 与 parseRecordJson 同样宽容：字面 \\n 归一化、marker 位置无关、尾随文本容忍。 */
export function parseProfileJson(
  message: string | null | undefined,
): XhsOpsProfileJson | null {
  if (!message) return null;
  const normalized = message.replace(/\\n/g, "\n");
  const idx = normalized.lastIndexOf(PROFILE_JSON_MARKER);
  if (idx < 0) return null;
  const rest = normalized.slice(idx + PROFILE_JSON_MARKER.length);
  const lineEnd = rest.indexOf("\n");
  const payload = parseJsonObject(
    (lineEnd < 0 ? rest : rest.slice(0, lineEnd)).trim(),
  );
  if (payload === null) return null;
  return {
    nickname: outcome(payload.nickname),
    bio: outcome(payload.bio),
    avatar: outcome(payload.avatar),
    cover: outcome(payload.cover),
    gender: outcome(payload.gender),
    birthday: outcome(payload.birthday),
    region: outcome(payload.region),
    interestTags: outcome(payload.interestTags),
    note: typeof payload.note === "string" ? payload.note.slice(0, 200) : "",
  };
}

export const PROFILE_VERIFICATION_JSON_MARKER = "PROFILE_VERIFICATION_JSON:";
const ACTION_RECEIPT_LINE =
  /^\[回执\] 各应用生效点击: (?:[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+|unknown)=[1-9]\d*(?:, (?:[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+|unknown)=[1-9]\d*)*$/;
const profileVerificationFieldsSchema = z
  .object({
    nickname: z.boolean(),
    bio: z.boolean(),
    avatar: z.boolean(),
    cover: z.boolean(),
    gender: z.boolean(),
    birthday: z.boolean(),
    region: z.boolean(),
    interestTags: z.boolean(),
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
  if (!message) return null;
  const markerLine = message
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => line.startsWith(XHS_IDENTITY_MARKER));
  if (!markerLine) return null;
  try {
    const value: unknown = JSON.parse(
      markerLine.slice(XHS_IDENTITY_MARKER.length),
    );
    const parsed = accountIdentitySchema.safeParse(value);
    if (!parsed.success) return null;
    return {
      status: parsed.data.status,
      // Ids are digits; anything else is the model narrating.
      accountId: /^[A-Za-z0-9_-]{1,40}$/.test(parsed.data.accountId.trim())
        ? parsed.data.accountId.trim()
        : "",
    };
  } catch {
    return null;
  }
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
    "AWAKE 小红书 → 底部「我」→ 编辑资料，逐项读取当前已有内容：名字、简介、性别、生日、地区、兴趣标签。",
    XHS_ME_TAB_UNFOLD_HINT,
    "字段为空或显示为占位提示（如「介绍一下自己」「选择生日」「编辑性别」）时，该字段返回空字符串，不要把占位文案当成内容。",
    "隐私：不得读取或回传小红书号、手机号、实名信息；不要进入任何需要验证的页面。",
    '未登录、停在登录页或找不到编辑资料页时，返回 status:"unavailable" 并结束，不要尝试登录。',
    // Same reason as the identity task: the completion screenshot is part of
    // what the operator reviews, so do not go HOME first.
    `**必须停留在编辑资料页上直接 COMPLETE，不要 HOME、不要 BACK**。return 只能是一行 ${XHS_PROFILE_READBACK_MARKER}{"v":1,"status":"read|unavailable","nickname":"…","bio":"…","gender":"…","birthday":"…","region":"…","interestTags":["…"]}，生日用 YYYY-MM-DD，读不到的字段用空字符串或空数组，不得附带其他字段。`,
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
  const tags = (input.interestTags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean)
    .join("、");
  return [
    "【小红书资料只读验收】本任务只读取并核对资料，不修改、保存、登录、退出、切换账号或执行浏览互动。",
    `AWAKE 小红书 → “我” → 编辑主页，先逐字核对“小红书号”与目标「${input.platformAccountId.trim()}」完全一致；不一致时 accountMatched=false 并结束。不得在过程或回执复述号码。`,
    XHS_ME_TAB_UNFOLD_HINT,
    `逐项读取并核对目标：昵称「${input.nickname?.trim() ?? ""}」；简介「${input.bio?.trim() ?? ""}」；头像为刚应用的 ${input.avatarFilename ?? "目标图片"}；背景图为刚应用的 ${input.coverFilename ?? "目标图片"}；性别「${input.gender ?? ""}」；生日「${input.birthday?.trim() ?? ""}」；地区「${input.region?.trim() ?? ""}」；兴趣标签「${tags}」。`,
    "文字和选择项必须与目标精确一致；头像、背景图必须在编辑页和主页均显示为刚应用的目标图。无法进入字段、看不清、结果不确定均记 false，不得猜测 true。",
    `核对后 HOME 回桌面并 COMPLETE。return 只能是一行 ${PROFILE_VERIFICATION_JSON_MARKER}{"v":1,"status":"verified|failed","accountMatched":true|false,"fields":{"nickname":true|false,"bio":true|false,"avatar":true|false,"cover":true|false,"gender":true|false,"birthday":true|false,"region":true|false,"interestTags":true|false}}。只有账号匹配且八项全部核对一致时 status=verified；不得增加字段或附带资料原文。`,
  ].join("\n");
}

const profileReadbackSchema = z.object({
  v: z.literal(1),
  status: z.enum(["read", "unavailable"]),
  nickname: z.string().catch(""),
  bio: z.string().catch(""),
  gender: z.string().catch(""),
  birthday: z.string().catch(""),
  region: z.string().catch(""),
  interestTags: z.array(z.string()).catch([]),
});

export type XhsOpsProfileReadbackValues = z.infer<typeof profileReadbackSchema>;

/** Lenient sibling of parseProfileVerificationJson for the readback receipt. */
export function parseProfileReadbackJson(
  message: string | null | undefined,
): XhsOpsProfileReadbackValues | null {
  if (!message) return null;
  const markerLine = message
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => line.startsWith(XHS_PROFILE_READBACK_MARKER));
  if (!markerLine) return null;
  try {
    const value: unknown = JSON.parse(
      markerLine.slice(XHS_PROFILE_READBACK_MARKER.length),
    );
    const parsed = profileReadbackSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function parseProfileVerificationJson(
  message: string | null | undefined,
): XhsOpsProfileVerification | null {
  if (!message) return null;
  const lines = message
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines.length < 1 ||
    lines.length > 2 ||
    (lines.length === 2 && !ACTION_RECEIPT_LINE.test(lines[1] ?? ""))
  ) {
    return null;
  }
  const markerLine = lines[0];
  if (!markerLine?.startsWith(PROFILE_VERIFICATION_JSON_MARKER)) return null;
  try {
    const value: unknown = JSON.parse(
      markerLine.slice(PROFILE_VERIFICATION_JSON_MARKER.length),
    );
    const parsed = profileVerificationSchema.safeParse(value);
    if (!parsed.success) return null;
    const allFieldsMatch = Object.values(parsed.data.fields).every(Boolean);
    if (
      (parsed.data.status === "verified") !==
      (parsed.data.accountMatched && allFieldsMatch)
    ) {
      return null;
    }
    return parsed.data;
  } catch {
    return null;
  }
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
  return [
    `【小红书评论任务｜账号定位：${input.label}${input.persona ? `｜人设：${input.persona}` : ""}${input.positioning ? `｜${input.positioning}` : ""}】`,
    `本次只做一件事：给一篇已经浏览过的笔记发一条**人工审核通过的**评论。目标笔记标题：「${input.postTitle}」，${who}。`,
    `1. 首页右上角放大镜 → TYPE 输入笔记标题「${input.postTitle}」→ 搜索；在结果里找标题一致、${who}的那篇，点进去。找不到（被删/改名/搜不出）→ 记 post_not_found，不要评其他帖子，直接进入"结束"。`,
    "2. 进入详情后先 WAIT 2 秒，慢滑看正文 5–10 秒（1–2 次 SCROLL + WAIT），像看完再评。",
    "3. 点底部评论输入框（「说点什么」）→ 用一次 TYPE 原样输入下面这段文字，一个字都不能改、不能加表情或标点：",
    `   ${input.text}`,
    "4. 点「发送」。WAIT 2 秒，确认评论区出现自己昵称 + 这段原文；出现即算 sent。若提示「评论失败」「操作频繁」「内容违规」等 → 记 comment_failed 并把提示原文写进 detail，不要重试、不要改字重发。",
    "5. 一次 BACK 回列表，按通用规则回到桌面，然后 COMPLETE。",
    "禁止：改写文案、评论目标以外的任何帖子、回复他人评论、连发第二条、点赞/收藏/关注（本任务不做互动）、私信、分享。出现登录页/账号异常/操作频繁提示 → 分别记 login_required / account_restricted / rate_limited 后立即结束。",
    `结束：COMPLETE 的 return 先写 2–3 行人读汇报，最后一行必须是 ${COMMENT_JSON_MARKER} 加一行紧凑 JSON：{"v":1,"status":"sent|failed|skipped","detail":"一句话","anomalies":[{"type":"…","detail":"…"}]}，status 只能三选一：sent=评论已出现在评论区，failed=尝试了但没成功（含 comment_failed），skipped=没有尝试（post_not_found/异常）。之后不再写任何字。`,
  ].join("\n");
}

export interface XhsOpsCommentJson {
  status: "sent" | "failed" | "skipped";
  detail: string;
  anomalies: Array<{ type: string; detail: string }>;
}

/** 宽容解析 COMMENT_JSON（字面 \n、缺字段、非法 status 都兜住）；没有标记 → null。 */
export function parseCommentJson(message: string): XhsOpsCommentJson | null {
  const normalized = message.replace(/\\n/g, "\n");
  const idx = normalized.lastIndexOf(COMMENT_JSON_MARKER);
  if (idx < 0) return null;
  const raw = normalized.slice(idx + COMMENT_JSON_MARKER.length);
  const end = raw.lastIndexOf("}");
  if (end < 0) return null;
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(raw.slice(raw.indexOf("{"), end + 1)) as Record<
      string,
      unknown
    >;
  } catch {
    return null;
  }
  const statusRaw =
    typeof obj.status === "string" ? obj.status.toLowerCase() : "";
  const status: XhsOpsCommentJson["status"] =
    statusRaw === "sent" || statusRaw === "failed" ? statusRaw : "skipped";
  const anomalies = Array.isArray(obj.anomalies)
    ? obj.anomalies
        .map((a) =>
          typeof a === "string"
            ? { type: a, detail: "" }
            : a && typeof a === "object"
              ? {
                  type: String((a as Record<string, unknown>).type ?? "other"),
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
