import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { type DeviceTaskPolicy, xhsOpsMaturityTierSchema } from "@nexu/shared";
import { describe, expect, it } from "vitest";
import { buildTakeoverIdentityGateRequest } from "../src/services/xhs-ops-preparation.js";
import {
  XHS_AUDIT_TASK_POLICY,
  XHS_TAKEOVER_APPLY_TASK_POLICY,
  chunkTaskPolicy,
} from "../src/services/xhs-ops-run-service.js";
import {
  XHS_AUDIT_UNFOLD_HINT,
  XHS_ME_TAB_UNFOLD_HINT,
  type XhsOpsChunkTaskBase,
  buildAccountAuditCreatorTask,
  buildAccountAuditHomeTask,
  buildCommentChunkTask,
  buildHomeChunkTask,
  buildSearchChunkTask,
  buildTakeoverIdentityTask,
  buildTakeoverProfileApplyTask,
  buildTakeoverProfileReadbackTask,
  buildTakeoverProfileVerificationTask,
  existingAccountStageLines,
} from "../src/services/xhs-ops-task-builder.js";

// Takeover §3.4 rule 6: the phone picks xhs subskills by substring over the
// task text (plus the last four action summaries), per keyword, id and name,
// and a hit is negated only by a marker inside its own clause. Takeover task
// texts must not load anything beyond what each task needs, so this suite
// re-runs the phone's matcher over every static takeover text.

// ─── Port of TabbyApp SkillSelector ─────────────────────────────────────────
// TabbyApp/app/src/main/kotlin/com/tabby/agent/agent/AppSkillRegistry.kt,
// containsPositiveIntent / isNegatedIntent. The three tables are copied
// verbatim; keep them in step with the phone.

const clauseBoundaries = new Set([
  "。",
  "！",
  "？",
  "；",
  "，",
  ".",
  "!",
  "?",
  ";",
  ",",
  "\n",
]);
const intentResetMarkers = [
  "但是",
  "但",
  "而是",
  "只需",
  "只要",
  "only",
  "instead",
  "but",
];
const negationMarkers = [
  "不要",
  "不需要",
  "不必",
  "无需",
  "禁止",
  "不得",
  "避免",
  "不允许",
  "不进行",
  "不执行",
  "do not",
  "don't",
  "dont",
  "without",
  "never",
];

function isNegatedIntent(text: string, intentIndex: number): boolean {
  let clauseStart = 0;
  for (let i = intentIndex - 1; i >= 0; i -= 1) {
    if (clauseBoundaries.has(text.charAt(i))) {
      clauseStart = i + 1;
      break;
    }
  }
  let prefix = text.substring(clauseStart, intentIndex);
  // Kotlin maxByOrNull keeps the first marker among equal indices.
  let reset: { index: number; length: number } | null = null;
  for (const marker of intentResetMarkers) {
    const index = prefix.lastIndexOf(marker);
    if (index >= 0 && (reset === null || index > reset.index)) {
      reset = { index, length: marker.length };
    }
  }
  if (reset !== null) prefix = prefix.substring(reset.index + reset.length);
  const normalized = prefix.trimEnd();
  return (
    negationMarkers.some((marker) => normalized.includes(marker)) ||
    normalized.endsWith("不") ||
    normalized.endsWith("不再")
  );
}

function containsPositiveIntent(text: string, rawIntent: string): boolean {
  const intent = rawIntent.trim().toLowerCase();
  if (intent.length === 0) return false;
  let searchFrom = 0;
  while (searchFrom < text.length) {
    const index = text.indexOf(intent, searchFrom);
    if (index < 0) return false;
    if (!isNegatedIntent(text, index)) return true;
    searchFrom = index + intent.length;
  }
  return false;
}

// ─── Skill tables ───────────────────────────────────────────────────────────
// Read from a tabby-control/phone-skills checkout next to this repo when there
// is one (apps/xhs/skill.json subskills; every system skill in manifest.json),
// and otherwise from the embedded copies below — apps/xhs version 39, bundle
// 66. A test further down fails when the two drift apart.

interface XhsSubskill {
  id: string;
  name: string;
  keywords: readonly string[];
}

/** A system skill's activation, as LayeredSkillSelector.matchesTask reads it. */
interface SystemSkill {
  /** The skill's directory under phone-skills/system, used as its name here. */
  dir: string;
  id: string;
  taskScoped: boolean;
  intents: readonly string[];
  taskKeywords: readonly string[];
  targetPackages: readonly string[];
}

const EMBEDDED_XHS_SUBSKILLS: readonly XhsSubskill[] = [
  {
    id: "login",
    name: "安装与自动登录",
    keywords: [
      "登录",
      "自动登录",
      "手机号登录",
      "验证码登录",
      "安装小红书",
      "下载小红书",
      "本机手机号",
      "短信验证码",
    ],
  },
  {
    id: "profile",
    name: "我与资料维护",
    keywords: [
      "我的主页",
      "我tab",
      "个人资料",
      "编辑资料",
      "编辑主页",
      "修改名字",
      "修改昵称",
      "改昵称",
      "修改头像",
      "换头像",
      "修改背景图",
      "个人简介",
      "修改简介",
      "修改性别",
      "修改生日",
      "修改地区",
      "修改职业",
      "修改学校",
      "小红书号",
      "实名认证",
      "原创信息",
    ],
  },
  {
    id: "profile-notes",
    name: "自有笔记维护",
    keywords: [
      "删除",
      "删掉",
      "删了",
      "删除笔记",
      "删除帖子",
      "删除作品",
      "管理笔记",
      "编辑笔记",
      "权限设置",
      "置顶笔记",
      "取消置顶",
      "推广笔记",
      "薯条推广",
      "合作码",
      "复制链接",
      "生成分享图",
      "建群分享",
      "保存图片",
    ],
  },
  {
    id: "research",
    name: "内容研究浏览",
    keywords: [
      "内容研究",
      "研究任务",
      "RECORD_JSON",
      "关键词浏览",
      "互动配置",
      "首页自然浏览",
      "逐篇浏览",
    ],
  },
  {
    id: "comment",
    name: "评论任务",
    keywords: [
      "评论任务",
      "小红书评论任务",
      "COMMENT_JSON",
      "审核通过的评论",
      "审核原文",
      "发一条评论",
    ],
  },
  {
    id: "nurture",
    name: "养号互动",
    keywords: [
      "养号",
      "养",
      "涨粉",
      "日常互动",
      "互动",
      "随手赞",
      "边看边赞",
      "感兴趣的赞",
      "搜索后点赞",
      "浏览并互动",
    ],
  },
  {
    id: "search",
    name: "搜索笔记",
    keywords: ["搜索", "搜", "搜一下", "搜搜", "查", "查找", "找", "关键词"],
  },
  {
    id: "hotsearch",
    name: "热搜与热帖采集",
    keywords: [
      "热搜",
      "热点",
      "热门话题",
      "当前热门",
      "趋势",
      "爆款",
      "热帖",
      "高赞笔记",
      "扒文案",
      "提取文案",
      "采集帖子",
      "收集素材",
    ],
  },
  {
    id: "browse",
    name: "浏览推荐",
    keywords: ["浏览", "看看", "推荐", "刷", "逛", "随便看看", "首页", "分类"],
  },
  {
    id: "interact",
    name: "互动操作",
    keywords: [
      "点赞",
      "收藏",
      "评论",
      "关注",
      "分享",
      "赞",
      "心",
      "星",
      "转发",
    ],
  },
  {
    id: "post",
    name: "发布笔记",
    keywords: [
      "发笔记",
      "发布",
      "写笔记",
      "发帖子",
      "发一条",
      "写一条",
      "图文",
      "发小红书",
      "纯文字",
      "写文字",
      "无图",
      "没有图片",
      "文字图片",
      "生成封面",
    ],
  },
  {
    id: "message",
    name: "回复消息",
    keywords: [
      "私信",
      "回消息",
      "聊天",
      "发消息",
      "回复",
      "回信",
      "消息",
      "回复评论",
      "回评论",
      "回复@",
      "评论和@",
      "回粉丝",
    ],
  },
  {
    id: "creator",
    name: "创作者与本地内容管理",
    keywords: [
      "创作者中心",
      "创作数据",
      "作品数据",
      "近7日数据",
      "成长中心",
      "创作学院",
      "我的草稿",
      "本地草稿",
      "草稿箱",
      "我的浏览记录",
      "观看记录",
      "我的下载",
      "下载内容",
      "作者邀约",
      "主播中心",
    ],
  },
  {
    id: "commerce",
    name: "市集与交易",
    keywords: [
      "市集",
      "商品",
      "购物",
      "买东西",
      "订单",
      "购物车",
      "优惠券",
      "客服消息",
      "商品足迹",
      "直播购物",
      "店铺",
      "钱包",
      "退款",
      "售后",
    ],
  },
];

const EMBEDDED_SYSTEM_SKILLS: readonly SystemSkill[] = [
  {
    dir: "android-core",
    id: "android-core-v1",
    taskScoped: true,
    intents: [],
    taskKeywords: [],
    targetPackages: [],
  },
  {
    dir: "app-install",
    id: "android-app-install-v1",
    taskScoped: true,
    intents: ["app.install", "app.update"],
    taskKeywords: ["安装", "下载应用", "更新应用", "应用市场", "应用商店"],
    targetPackages: [],
  },
  {
    dir: "permissions-accessibility",
    id: "android-permissions-accessibility-v1",
    taskScoped: true,
    intents: [
      "permission.manage",
      "accessibility.enable",
      "battery.background",
    ],
    taskKeywords: [
      "权限",
      "无障碍",
      "辅助功能",
      "后台运行",
      "省电",
      "电池限制",
      "自启动",
    ],
    targetPackages: [],
  },
  {
    dir: "text-input",
    id: "android-text-input-v1",
    taskScoped: true,
    intents: [
      "text.input",
      "content.search",
      "content.publish",
      "message.reply",
    ],
    taskKeywords: [
      "输入",
      "填写",
      "搜索",
      "评论",
      "回复",
      "发布",
      "标题",
      "正文",
    ],
    targetPackages: [],
  },
  {
    dir: "media-picker",
    id: "android-media-picker-v1",
    taskScoped: true,
    intents: ["media.select", "content.publish"],
    taskKeywords: [
      "相册",
      "图片",
      "照片",
      "选图",
      "上传图片",
      "从相册选择",
      "图文",
    ],
    targetPackages: [],
  },
  {
    dir: "system-dialogs",
    id: "android-system-dialogs-v1",
    taskScoped: false,
    intents: ["system.dialog"],
    taskKeywords: ["权限弹窗", "系统弹窗", "确认弹窗", "打开方式", "风险提示"],
    targetPackages: [],
  },
  {
    dir: "sms-verification",
    id: "android-sms-verification-v1",
    taskScoped: true,
    intents: ["sms.verify", "account.login"],
    taskKeywords: ["验证码", "短信验证", "手机号登录", "自动登录"],
    targetPackages: [],
  },
];

const PHONE_SKILLS_DIR = fileURLToPath(
  new URL("../../../../tabby-control/phone-skills/", import.meta.url),
);

const stringList = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];

function readJson(file: string): Record<string, unknown> {
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return value as Record<string, unknown>;
}

const field = (value: unknown, key: string): unknown =>
  typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)[key]
    : undefined;

/** The live tables, or null when there is no phone-skills checkout. */
function loadPhoneSkills(): {
  xhs: XhsSubskill[];
  system: SystemSkill[];
} | null {
  const manifestFile = path.join(PHONE_SKILLS_DIR, "manifest.json");
  if (!existsSync(manifestFile)) return null;
  const xhsSkill = readJson(path.join(PHONE_SKILLS_DIR, "apps/xhs/skill.json"));
  const subskills = Array.isArray(xhsSkill.subskills) ? xhsSkill.subskills : [];
  const xhs = subskills.map((entry: unknown) => ({
    id: String(field(entry, "id")),
    name: String(field(entry, "name")),
    keywords: stringList(field(entry, "keywords")),
  }));
  const entries = field(readJson(manifestFile), "skills");
  const system = (Array.isArray(entries) ? entries : []).flatMap(
    (entry: unknown) => {
      const dir = field(entry, "dir");
      if (typeof dir !== "string" || !dir.startsWith("system/")) return [];
      const skill = readJson(path.join(PHONE_SKILLS_DIR, dir, "skill.json"));
      return [
        {
          dir: dir.slice("system/".length),
          id: String(skill.id),
          taskScoped: field(skill.activation, "taskScoped") === true,
          intents: stringList(field(skill.activation, "intents")),
          taskKeywords: stringList(field(skill.activation, "taskKeywords")),
          targetPackages: stringList(skill.targetPackages),
        },
      ];
    },
  );
  return { xhs, system };
}

const LIVE_PHONE_SKILLS = loadPhoneSkills();
const XHS_SUBSKILLS = LIVE_PHONE_SKILLS?.xhs ?? EMBEDDED_XHS_SUBSKILLS;
const SYSTEM_SKILLS = LIVE_PHONE_SKILLS?.system ?? EMBEDDED_SYSTEM_SKILLS;

/** Every takeover task sends its class: the read-only and chunk policies app.use.xhs, the identity gate account.login. */
const XHS_OPERATION_CLASS = XHS_AUDIT_TASK_POLICY.operationClass ?? "";

/**
 * Skills a text selects, as SkillSelector.selectSubskills (task text plus the
 * last action summaries) and LayeredSkillSelector.matchesTask (task text
 * only: the operation class among the intents, a positive task keyword, a
 * target package by substring) would see it. Only task-scoped system skills
 * count, and one without criteria (android-core) loads on every task, so it
 * is no hit. Each hit names what matched, for readable failures.
 */
function skillHits(
  task: string,
  history: readonly string[] = [],
  operationClass: string = XHS_OPERATION_CLASS,
): string[] {
  const text = [task, ...history, ""].join("\n").toLowerCase();
  const hits: string[] = [];
  for (const subskill of XHS_SUBSKILLS) {
    const via = [
      ...subskill.keywords.filter((k) => containsPositiveIntent(text, k)),
      ...(containsPositiveIntent(text, subskill.id)
        ? [`id:${subskill.id}`]
        : []),
      ...(containsPositiveIntent(text, subskill.name)
        ? [`name:${subskill.name}`]
        : []),
    ];
    if (via.length > 0) hits.push(`${subskill.id}(${via.join("|")})`);
  }
  const taskText = task.toLowerCase();
  for (const skill of SYSTEM_SKILLS) {
    if (!skill.taskScoped) continue;
    if (skill.intents.length === 0 && skill.taskKeywords.length === 0) continue;
    const via = [
      ...(skill.intents.includes(operationClass)
        ? [`intent:${operationClass}`]
        : []),
      ...skill.taskKeywords.filter((k) => containsPositiveIntent(taskText, k)),
      ...skill.targetPackages
        .filter((pkg) => taskText.includes(pkg.toLowerCase()))
        .map((pkg) => `package:${pkg}`),
    ];
    if (via.length > 0) hits.push(`${skill.dir}(${via.join("|")})`);
  }
  return hits;
}

const skillIds = (hits: readonly string[]) =>
  hits.map((hit) => hit.slice(0, hit.indexOf("(")));

// ─── The port itself ────────────────────────────────────────────────────────

describe("TabbyApp negation port", () => {
  const positive = (text: string, keyword: string) =>
    containsPositiveIntent(text.toLowerCase(), keyword);

  it("reads the cases §3.4 rule 6 calls out the way the phone does", () => {
    // 「不点」 is not a negation: the prefix must contain a marker or end in 不.
    // 点赞 itself is negated (its prefix is 不), its 赞 is not.
    expect(positive("不点赞", "点赞")).toBe(false);
    expect(positive("不点赞", "赞")).toBe(true);
    expect(positive("不进入发布页", "发布")).toBe(true);
    expect(positive("未登录", "登录")).toBe(true);
    expect(positive("不登录", "登录")).toBe(false);
    // 、 is no clause boundary, so one 禁止 covers the whole list.
    for (const keyword of ["点赞", "收藏", "关注"]) {
      expect(positive("禁止点赞、收藏、关注", keyword)).toBe(false);
    }
    // ，is one, and the next clause starts unprotected.
    expect(positive("禁止点赞，收藏", "收藏")).toBe(true);
    // A reset word drops everything before it.
    expect(positive("禁止评论但可以点赞", "点赞")).toBe(true);
    expect(positive("禁止评论只需点赞", "点赞")).toBe(true);
    expect(positive("do not like or share", "share")).toBe(false);
    // Every occurrence counts: one positive one is enough.
    expect(positive("禁止点赞。然后点赞", "点赞")).toBe(true);
  });
});

// ─── Takeover task texts ────────────────────────────────────────────────────

// Placeholders free of subskill words; real values are recorded below, not gated.
const ACCOUNT = "12345678";
const ALBUM_A = "Tabby-1a2b3c4d-a";
const ALBUM_C = "Tabby-1a2b3c4d-c";

const TEXT_FIELDS = [
  { field: "nickname", after: "目标值甲" },
  { field: "bio", after: "目标值乙" },
  { field: "occupation", after: "目标值丙" },
  { field: "region", after: "目标值丁" },
] as const;

const PROFILE = "profile";
const CREATOR = "creator";
const LOGIN = "login";
const COMMENT = "comment";
const RESEARCH = "research";
const NURTURE = "nurture";
const SEARCH = "search";
const BROWSE = "browse";
const INTERACT = "interact";
const MEDIA_PICKER = "media-picker";
const TEXT_INPUT = "text-input";
const SMS_VERIFICATION = "sms-verification";

const gate = buildTakeoverIdentityGateRequest("com.xingin.xhs", ACCOUNT);
const GATE_POLICY = gate.taskPolicy ?? {};
const EXISTING_CHUNK_POLICY = chunkTaskPolicy("existing", null);
const EXISTING_COMMENT_POLICY = chunkTaskPolicy("existing", "原文甲");

/**
 * System skills a text may load because its own policy leaves them nothing
 * to do: text-input only teaches TYPE, sms-verification only works with TYPE
 * in the SMS app. Their hits come from page words the read-only tasks must
 * name (手机号输入页, the hint's 标题栏 and 正文, the cards' 标题) and, for
 * the gate and the verification it carries, from the account.login class the
 * gate keeps for the phone's receipt contract (xhs-ops-preparation.ts). The
 * rule reads the dispatched policy, so granting TYPE or the SMS role to one
 * of these tasks turns the hit into a failure.
 */
function inertSystemSkills(policy: DeviceTaskPolicy): string[] {
  const typing = policy.allowedActions?.includes("TYPE") ?? true;
  const sms = policy.allowedAppRoles?.includes("default_sms") ?? true;
  return [
    ...(typing ? [] : [TEXT_INPUT]),
    ...(typing || sms ? [] : [SMS_VERIFICATION]),
  ];
}

// Neutral stand-ins for what the operator types (label, keyword, title …):
// those take part in matching too, but they are not the builder's words.
const CHUNK_BASE: XhsOpsChunkTaskBase = {
  label: "账号甲",
  positioning: "定位甲",
  persona: "",
  dwellSecMin: 12,
  dwellSecMax: 30,
  quota: {
    like: { enabled: true, max: 2 },
    collect: { enabled: true, max: 1 },
    follow: { enabled: true, max: 1, targetTypes: ["对象甲"] },
  },
};
const COMMENT_INPUT = {
  label: "账号甲",
  positioning: "定位甲",
  persona: "",
  postTitle: "目标甲",
  postAuthor: "作者甲",
  text: "原文甲",
};

/**
 * What an existing account's chunk legitimately loads: research carries the
 * RECORD_JSON format, nurture and interact the interaction rules, search and
 * browse the two ways in. text-input comes with them — a chunk allows TYPE
 * (the search chunk types its keyword), and its own words (评论区, 正文, the
 * ledger's 标题) are text-input keywords — and only describes typing, which
 * the policy allows anyway; it pulls in no other skill.
 */
const EXISTING_CHUNK_SKILLS = [
  RESEARCH,
  NURTURE,
  SEARCH,
  BROWSE,
  INTERACT,
  TEXT_INPUT,
];

/** Every static takeover text, the policy it is dispatched with and the skills §3.4 rule 6 expects it to load. */
const TAKEOVER_TEXTS: ReadonlyArray<{
  name: string;
  text: string;
  policy: DeviceTaskPolicy;
  allowed: readonly string[];
}> = [
  {
    name: "identity variant",
    text: buildTakeoverIdentityTask(),
    policy: XHS_AUDIT_TASK_POLICY,
    allowed: [PROFILE],
  },
  {
    name: "profile archive",
    text: buildTakeoverProfileReadbackTask(ACCOUNT),
    policy: XHS_AUDIT_TASK_POLICY,
    allowed: [PROFILE],
  },
  {
    name: "precheck readback, text fields",
    text: buildTakeoverProfileReadbackTask(ACCOUNT, ["bio", "occupation"]),
    policy: XHS_AUDIT_TASK_POLICY,
    allowed: [PROFILE],
  },
  {
    name: "precheck readback, image fields",
    text: buildTakeoverProfileReadbackTask(ACCOUNT, ["avatar", "cover"]),
    policy: XHS_AUDIT_TASK_POLICY,
    allowed: [PROFILE],
  },
  {
    name: "audit part A",
    text: buildAccountAuditHomeTask(20),
    policy: XHS_AUDIT_TASK_POLICY,
    allowed: [],
  },
  {
    name: "audit part B",
    text: buildAccountAuditCreatorTask(),
    policy: XHS_AUDIT_TASK_POLICY,
    allowed: [CREATOR],
  },
  {
    // login_failed stays: the phone's preparation contract hard-codes it (§3.2).
    name: "identity gate",
    text: gate.task,
    policy: GATE_POLICY,
    allowed: [PROFILE, LOGIN],
  },
  {
    name: "identity gate without an id",
    text: buildTakeoverIdentityGateRequest("com.xingin.xhs").task,
    policy: GATE_POLICY,
    allowed: [PROFILE, LOGIN],
  },
  ...[...xhsOpsMaturityTierSchema.options, null].map((tier) => ({
    name: `existing-account chunk header, tier ${tier ?? "unset"}`,
    text: existingAccountStageLines(tier).join("\n"),
    policy: EXISTING_CHUNK_POLICY,
    allowed: [],
  })),
  ...[...xhsOpsMaturityTierSchema.options, null].flatMap((maturity) => {
    const base = { ...CHUNK_BASE, existingAccount: { maturity } };
    return [
      {
        name: `existing-account search chunk, tier ${maturity ?? "unset"}`,
        text: buildSearchChunkTask({ ...base, keyword: "词甲", count: 5 }),
        policy: EXISTING_CHUNK_POLICY,
        allowed: EXISTING_CHUNK_SKILLS,
      },
      {
        name: `existing-account home chunk, tier ${maturity ?? "unset"}`,
        text: buildHomeChunkTask({ ...base, count: 5 }),
        policy: EXISTING_CHUNK_POLICY,
        allowed: EXISTING_CHUNK_SKILLS,
      },
    ];
  }),
  {
    name: "existing-account search chunk, interactions off",
    text: buildSearchChunkTask({
      ...CHUNK_BASE,
      quota: {
        like: { enabled: false, max: 0 },
        collect: { enabled: false, max: 0 },
        follow: { enabled: false, max: 0 },
      },
      existingAccount: { maturity: null },
      keyword: "词甲",
      count: 5,
    }),
    policy: EXISTING_CHUNK_POLICY,
    allowed: EXISTING_CHUNK_SKILLS,
  },
  {
    // The comment task itself: comment carries COMMENT_JSON and the steps,
    // text-input the one TYPE of the approved text.
    name: "existing-account comment chunk",
    text: buildCommentChunkTask({ ...COMMENT_INPUT, existingAccount: true }),
    policy: EXISTING_COMMENT_POLICY,
    allowed: [COMMENT, SEARCH, BROWSE, INTERACT, TEXT_INPUT],
  },
  {
    name: "existing-account comment chunk without an author",
    text: buildCommentChunkTask({
      ...COMMENT_INPUT,
      postAuthor: "",
      existingAccount: true,
    }),
    policy: EXISTING_COMMENT_POLICY,
    allowed: [COMMENT, SEARCH, BROWSE, INTERACT, TEXT_INPUT],
  },
  {
    name: "apply variant, text fields",
    text: buildTakeoverProfileApplyTask({
      platformAccountId: ACCOUNT,
      fields: TEXT_FIELDS,
    }),
    policy: XHS_TAKEOVER_APPLY_TASK_POLICY,
    allowed: [PROFILE, MEDIA_PICKER, TEXT_INPUT],
  },
  {
    name: "apply variant, image fields",
    text: buildTakeoverProfileApplyTask({
      platformAccountId: ACCOUNT,
      fields: [
        { field: "avatar", mediaAlbum: ALBUM_A },
        { field: "cover", mediaAlbum: ALBUM_C },
      ],
    }),
    policy: XHS_TAKEOVER_APPLY_TASK_POLICY,
    allowed: [PROFILE, MEDIA_PICKER, TEXT_INPUT],
  },
  {
    // Dispatched on the gate's read-only policy (change-order service).
    name: "verification variant, text fields",
    text: buildTakeoverProfileVerificationTask({
      platformAccountId: ACCOUNT,
      fields: TEXT_FIELDS,
    }),
    policy: GATE_POLICY,
    allowed: [PROFILE, MEDIA_PICKER],
  },
  {
    name: "verification variant, image fields",
    text: buildTakeoverProfileVerificationTask({
      platformAccountId: ACCOUNT,
      fields: [{ field: "avatar" }, { field: "cover" }],
    }),
    policy: GATE_POLICY,
    allowed: [PROFILE, MEDIA_PICKER],
  },
];

const hitsUnder = (text: string, policy: DeviceTaskPolicy) =>
  skillHits(text, [], policy.operationClass ?? "");

describe("takeover task texts load only the expected skills (§3.4 rule 6)", () => {
  for (const { name, text, policy, allowed } of TAKEOVER_TEXTS) {
    it(name, () => {
      const permitted = [...allowed, ...inertSystemSkills(policy)];
      const unexpected = hitsUnder(text, policy).filter(
        (hit) => !permitted.includes(skillIds([hit])[0] ?? ""),
      );
      expect(unexpected).toEqual([]);
    });
  }

  it("the system-skill check sees every task-scoped system skill with criteria", () => {
    const checked = SYSTEM_SKILLS.filter(
      (skill) =>
        skill.taskScoped &&
        (skill.intents.length > 0 || skill.taskKeywords.length > 0),
    ).map((skill) => skill.dir);
    expect(checked).toEqual(
      expect.arrayContaining([
        "app-install",
        "permissions-accessibility",
        "text-input",
        "media-picker",
        "sms-verification",
      ]),
    );
  });

  it("expected loads do happen: B needs creator, the gate's contract code loads login", () => {
    expect(skillIds(skillHits(buildAccountAuditCreatorTask()))).toContain(
      CREATOR,
    );
    expect(skillIds(hitsUnder(gate.task, GATE_POLICY))).toEqual(
      expect.arrayContaining([PROFILE, LOGIN]),
    );
  });

  it("an existing account's chunks still load the format they report in", () => {
    const base = { ...CHUNK_BASE, existingAccount: { maturity: null } };
    for (const text of [
      buildSearchChunkTask({ ...base, keyword: "词甲", count: 5 }),
      buildHomeChunkTask({ ...base, count: 5 }),
    ]) {
      expect(skillIds(hitsUnder(text, EXISTING_CHUNK_POLICY))).toEqual(
        expect.arrayContaining([RESEARCH, INTERACT]),
      );
    }
    expect(
      skillIds(
        hitsUnder(
          buildCommentChunkTask({ ...COMMENT_INPUT, existingAccount: true }),
          EXISTING_COMMENT_POLICY,
        ),
      ),
    ).toContain(COMMENT);
  });

  it("the new-account wording an existing account's chunk avoids would load login and post", () => {
    // Why the existing-account variants exist: the new-account texts stay as
    // they were (§9 #6) and keep these hits.
    const newSearch = skillIds(
      skillHits(
        buildSearchChunkTask({ ...CHUNK_BASE, keyword: "词甲", count: 5 }),
      ),
    );
    expect(newSearch).toEqual(expect.arrayContaining([LOGIN, "post"]));
    const newComment = skillIds(
      skillHits(buildCommentChunkTask(COMMENT_INPUT)),
    );
    expect(newComment).toEqual(expect.arrayContaining([LOGIN, "post"]));
  });

  it("the apply text names no permission keyword (A2)", () => {
    const text = buildTakeoverProfileApplyTask({
      platformAccountId: ACCOUNT,
      fields: [{ field: "avatar", mediaAlbum: ALBUM_A }],
    });
    expect(
      skillIds(hitsUnder(text, XHS_TAKEOVER_APPLY_TASK_POLICY)),
    ).not.toContain("permissions-accessibility");
    expect(text).toContain("照片访问授权弹窗");
  });

  it("the audit unfold hint loads no subskill, where the new-account hint loads interact (N4)", () => {
    // Its 标题栏 and 正文 are text-input words, inert on the read-only policy.
    expect(skillIds(skillHits(XHS_AUDIT_UNFOLD_HINT))).toEqual([TEXT_INPUT]);
    expect(inertSystemSkills(XHS_AUDIT_TASK_POLICY)).toContain(TEXT_INPUT);
    expect(skillIds(skillHits(XHS_ME_TAB_UNFOLD_HINT))).toContain("interact");
  });
});

describe("the embedded skill tables", () => {
  it.skipIf(LIVE_PHONE_SKILLS === null)(
    "equal the phone-skills checkout next to this repo",
    () => {
      expect(EMBEDDED_XHS_SUBSKILLS).toEqual(LIVE_PHONE_SKILLS?.xhs);
      expect(EMBEDDED_SYSTEM_SKILLS).toEqual(LIVE_PHONE_SKILLS?.system);
    },
  );
});

describe("matching the phone cannot be kept from (documented, not gated)", () => {
  it("a real header action summary loads interact mid-task", () => {
    // Part A copies 关注 / 粉丝 / 获赞与收藏 off the screen, and the phone
    // matches the last four action summaries too, so interact loads there
    // whatever the task text says. The mechanical policy (no TYPE, no long
    // press) and the header-count diff are the defences (§3.4 rule 6).
    const history = [
      "读取头部：关注 12 粉丝 1.2万 获赞与收藏 8.9万",
      "已读取头部三项计数",
    ];
    expect(skillIds(skillHits(buildAccountAuditHomeTask(20)))).toEqual([
      TEXT_INPUT,
    ]);
    expect(
      skillIds(skillHits(buildAccountAuditHomeTask(20), history)),
    ).toContain("interact");
    // B's screen always shows 创作者中心, and 心 is an interact keyword.
    expect(
      skillIds(
        skillHits(buildAccountAuditCreatorTask(), ["点击「创作者中心」"]),
      ),
    ).toContain("interact");
  });

  it("new values take part in matching too", () => {
    // A new 简介 or 名字 is matched like any other task text; it cannot be
    // reworded, so the hits are recorded here instead of asserted away.
    const text = buildTakeoverProfileApplyTask({
      platformAccountId: ACCOUNT,
      fields: [{ field: "bio", after: "分享通勤穿搭和护肤日常" }],
    });
    expect(skillIds(skillHits(text))).toContain("interact");
  });
});
