import { z } from "zod";

// ─── xhs-ops: 小红书账号运营 · 内容研究闭环（Phase 1）───────────────────────
// Contract: scratchpad xhs-ops-spec.md §1. Every string field defaults to ""
// and every array to [] so partially filled forms validate.

const text = () => z.string().default("");
const textList = () => z.array(z.string()).default([]);
const count = () => z.number().int().min(0).default(0);

export const xhsOpsDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "date must be YYYY-MM-DD");

// ─── Interaction / browse config ─────────────────────────────────────────────

export const xhsOpsInteractionRuleSchema = z.object({
  enabled: z.boolean(),
  dailyCap: z.number().int().min(0).max(50),
  ratioPercent: z.number().int().min(0).max(100),
  /** Only used by follow: the kinds of accounts the operator permits. */
  targetTypes: z.array(z.string().trim().min(1).max(80)).max(10).optional(),
});

export const xhsOpsCommentRuleSchema = z.object({
  enabled: z.boolean().default(false),
  dailyCap: z.number().int().min(0).max(5).default(2),
});

export const xhsOpsInteractionConfigSchema = z.object({
  like: xhsOpsInteractionRuleSchema.default({
    enabled: true,
    dailyCap: 5,
    ratioPercent: 10,
  }),
  collect: xhsOpsInteractionRuleSchema.default({
    enabled: false,
    dailyCap: 2,
    ratioPercent: 3,
  }),
  follow: xhsOpsInteractionRuleSchema.default({
    enabled: false,
    dailyCap: 0,
    ratioPercent: 0,
  }),
  /**
   * 评论（P3-1，评审 2026-09-06）：默认关；开启后也只是允许进入审核队列，
   * 每一条都要人工批准，由独立的评论任务发出。硬上限 5，默认 2。
   */
  comment: xhsOpsCommentRuleSchema.default({}),
});

export const xhsOpsBrowseDefaultsSchema = z.object({
  dwellSecMin: z.number().int().min(5).max(60).default(11),
  dwellSecMax: z.number().int().min(5).max(120).default(25),
  searchRatioPercent: z.number().int().min(0).max(100).default(80),
  postsPerKeyword: z.number().int().min(1).max(8).default(5),
  homeFeedCount: z.number().int().min(0).max(12).default(6),
  /**
   * 日目标篇数（P2-3，可选）。0 = 不设目标，按 每词篇数 × 词数 走；>0 时当日
   * 计划按 dailySegments 拆成几段，每段总量 ≈ 目标 ÷ 段数。默认每日 90 篇。
   */
  dailyTargetPosts: z.number().int().min(0).max(150).default(90),
  /** 当日拆成几个 run 串行执行；默认两段，1 表示单段。 */
  dailySegments: z.number().int().min(1).max(3).default(2),
});

// ─── Project ─────────────────────────────────────────────────────────────────

export const xhsOpsProjectBusinessSchema = z.object({
  industry: text(),
  product: text(),
  regions: textList(),
  sellingPoints: textList(),
  priceBand: text(),
  scene: text(),
});

export const xhsOpsProjectAudienceSchema = z.object({
  ageRange: text(),
  genderRatio: text(),
  regions: textList(),
  occupations: textList(),
  spendingPower: text(),
  knownInterests: textList(),
  painPoints: textList(),
});

export const xhsOpsProjectOpsNotesSchema = z.object({
  forbiddenTopics: textList(),
  boostKeywords: textList(),
  avoidContentTypes: textList(),
});

export const xhsOpsProfileSchema = z.object({
  summary: text(),
  base: z
    .object({
      ageRange: text(),
      genderRatio: text(),
      regions: textList(),
    })
    .default({}),
  verticalInterests: textList(),
  generalInterests: textList(),
  confirmedAt: z.string().nullable().default(null),
  updatedAt: z.string(),
});

/** Profile as accepted on write: `updatedAt` is filled server-side when absent. */
export const xhsOpsProfileInputSchema = xhsOpsProfileSchema.extend({
  updatedAt: z.string().optional(),
});

/**
 * 每日自动执行（P2-4）。controller 内的 XhsOpsScheduler 每分钟检查：启用且本地
 * 时间 ≥ `time` 且今天还没触发 → 对项目下每个已绑设备的账号 plan-suggest →
 * createRun → startRun（同一手机的 run 由设备队列串行）。OpenClaw cron 只能投递
 * agentTurn、带不了账目，所以这里自己做胶水。
 */
export const xhsOpsScheduleSchema = z.object({
  enabled: z.boolean().default(false),
  /** 本地时间 HH:mm */
  time: z
    .string()
    .regex(/^([01]\d|2[0-3]):[0-5]\d$/)
    .default("10:00"),
  /** 最近一次触发的本地日期 YYYY-MM-DD；一天只触发一次。 */
  lastTriggeredDate: z.string().nullable().default(null),
  /** 最近一次触发的结果摘要（给运营看）。 */
  lastResult: z.string().nullable().default(null),
});

export const xhsOpsProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1).max(80),
  business: xhsOpsProjectBusinessSchema.default({}),
  audience: xhsOpsProjectAudienceSchema.default({}),
  opsNotes: xhsOpsProjectOpsNotesSchema.default({}),
  profile: xhsOpsProfileSchema.nullable().default(null),
  personaCount: z.number().int().min(1).max(30).default(10),
  schedule: xhsOpsScheduleSchema.default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const xhsOpsProjectCreateSchema = xhsOpsProjectSchema
  .omit({ id: true, createdAt: true, updatedAt: true, profile: true })
  .extend({ profile: xhsOpsProfileInputSchema.nullable().optional() });

export const xhsOpsProjectUpdateSchema = xhsOpsProjectCreateSchema
  .partial()
  .extend({
    expectedUpdatedAt: z.string().optional(),
  });

export const xhsOpsProfileConfirmBodySchema = z.object({
  profile: xhsOpsProfileInputSchema.omit({
    confirmedAt: true,
    updatedAt: true,
  }),
  expectedUpdatedAt: z.string(),
});

export const xhsOpsPersonaGenerateBodySchema = z.object({
  count: z.number().int().min(1).max(30).default(10),
  expectedUpdatedAt: z.string(),
});

export const xhsOpsPersonasConfirmBodySchema = z.object({
  accounts: z
    .array(z.object({ accountId: z.string(), expectedUpdatedAt: z.string() }))
    .min(1)
    .max(30),
  expectedUpdatedAt: z.string(),
  distributionReviewed: z.literal(true),
  reviewNote: z.string().trim().min(1).max(1000),
});

// ─── Account ─────────────────────────────────────────────────────────────────

export const xhsOpsInterestPoolSchema = z.object({
  core: textList(),
  extended: textList(),
  general: textList(),
});

/**
 * 人设人口学字段（运营文档：每个人设应含年龄、性别、地区、职业/身份、生活状态）。
 * 结构化后才能核对"整体分布贴合目标消费者"和人设差异；全部可空，兼容旧数据。
 */
export const xhsOpsPersonaSchema = z.object({
  age: text(),
  gender: text(),
  region: text(),
  occupation: text(),
  lifeStatus: text(),
});

/** First-level occupation categories exposed by the Xiaohongshu picker. */
export const XHS_OCCUPATION_CATEGORIES = [
  "时尚",
  "美妆",
  "潮流",
  "影视娱乐",
  "音乐",
  "游戏",
  "文化",
  "教育",
  "广告营销",
  "咨询服务",
  "科技数码",
  "互联网",
  "美食",
  "情感",
  "兴趣爱好",
  "运动健身",
  "生活服务",
  "出行",
  "交通运输",
  "地产建筑",
  "生产物流",
  "农林牧渔",
  "宠物",
  "搞笑",
  "家居家装",
  "母婴",
  "婚嫁",
  "职能",
  "AI创作者",
  "技能服务",
  "其他",
] as const;

/** Every first-level category and its second-level identities, enumerated from the phone picker. */
export const XHS_OCCUPATION_GROUPS = [
  {
    category: "时尚",
    options: [
      "时尚博主",
      "设计师",
      "服装设计师",
      "品牌创始人",
      "品牌主理人",
      "模特",
      "造型师",
      "时尚买手",
      "时尚编辑",
      "珠宝设计师",
    ],
  },
  {
    category: "美妆",
    options: [
      "美妆博主",
      "美容师",
      "美甲师",
      "化妆师",
      "发型师",
      "护肤博主",
      "纹身师",
      "香水博主",
    ],
  },
  {
    category: "潮流",
    options: [
      "潮流博主",
      "潮流买手",
      "潮流音乐人",
      "潮玩博主",
      "潮玩设计师",
      "潮鞋博主",
    ],
  },
  {
    category: "影视娱乐",
    options: [
      "漫画博主",
      "动漫博主",
      "coser",
      "影视博主",
      "娱乐博主",
      "演员",
      "导演",
      "编剧",
      "编导",
      "舞者",
      "舞蹈博主",
      "灯光师",
      "导播",
      "影视后期",
      "经纪人",
      "艺人",
      "音效师",
      "虚拟偶像",
      "相声演员",
      "脱口秀演员",
      "魔术师",
      "体育明星",
      "绘画博主",
    ],
  },
  {
    category: "音乐",
    options: [
      "音乐博主",
      "乐评人",
      "乐队",
      "音乐人",
      "歌手",
      "演奏者",
      "吉他手",
      "贝斯手",
      "鼓手",
      "音乐指挥",
      "调音师",
      "合唱团",
      "组合",
    ],
  },
  {
    category: "游戏",
    options: [
      "游戏博主",
      "电竞教练",
      "电竞选手",
      "电竞主持人",
      "电竞赛事解说",
      "游戏策划",
      "游戏制作人",
    ],
  },
  {
    category: "文化",
    options: [
      "文化博主",
      "作家",
      "撰稿人",
      "漫画家",
      "画家",
      "艺术创作者",
      "诗歌博主",
      "雕塑家",
      "戏曲演员",
      "非遗传承人",
    ],
  },
  {
    category: "教育",
    options: ["教育博主", "学者", "留学顾问", "职业顾问", "职场博主"],
  },
  {
    category: "广告营销",
    options: [
      "市场营销",
      "市场策划",
      "市场拓展",
      "市场调研",
      "品牌公关",
      "品牌策划",
      "媒介投放",
      "广告创意",
      "会展策划",
    ],
  },
  {
    category: "咨询服务",
    options: ["管理咨询", "战略咨询", "IT咨询", "猎头顾问"],
  },
  { category: "科技数码", options: ["数码博主", "摄影师", "摄影博主"] },
  {
    category: "互联网",
    options: [
      "互联网从业者",
      "互联网运营",
      "产品经理",
      "交互设计师",
      "前端开发工程师",
      "后端开发工程师",
      "数据分析师",
      "测试开发工程师",
      "用户研究员",
      "程序员",
      "算法工程师",
      "软件工程师",
      "项目经理",
      "视觉设计师",
      "硬件工程师",
    ],
  },
  {
    category: "美食",
    options: [
      "美食博主",
      "料理博主",
      "厨师",
      "咖啡师",
      "烘焙师",
      "茶艺师",
      "调酒师",
      "面点师",
      "餐饮店主",
    ],
  },
  { category: "情感", options: ["情感博主", "心理博主"] },
  {
    category: "兴趣爱好",
    options: [
      "vlog博主",
      "手工博主",
      "手帐博主",
      "插画师",
      "模型博主",
      "花艺师",
      "鲜花博主",
    ],
  },
  {
    category: "运动健身",
    options: [
      "健身博主",
      "运动博主",
      "运动员",
      "户外博主",
      "户外运动教练",
      "教练",
      "裁判",
    ],
  },
  { category: "生活服务", options: ["服务人员", "家政从业者", "导购", "保安"] },
  {
    category: "出行",
    options: [
      "旅行博主",
      "探店博主",
      "导游",
      "民宿主理人",
      "民宿博主",
      "营地主理人",
      "讲解员",
      "酒店博主",
      "露营博主",
    ],
  },
  {
    category: "交通运输",
    options: [
      "司机",
      "汽车博主",
      "汽车工程师",
      "汽车改装师",
      "汽车维修",
      "列车车长",
      "安检员",
      "航天员",
      "航空乘务员",
      "船员",
      "船长",
      "飞机机长",
      "飞行员",
    ],
  },
  {
    category: "地产建筑",
    options: [
      "建筑工人",
      "建筑工程师",
      "建筑设计师",
      "城市规划师",
      "工程造价师",
      "建造师",
      "房产评估师",
      "景观设计师",
      "物业人员",
    ],
  },
  { category: "生产物流", options: ["物流从业者", "生产工人"] },
  { category: "农林牧渔", options: ["饲养员"] },
  { category: "宠物", options: ["宠物博主", "宠物美容师"] },
  { category: "搞笑", options: ["搞笑博主"] },
  { category: "家居家装", options: ["家居博主", "室内设计师"] },
  { category: "母婴", options: ["母婴博主", "育儿博主"] },
  { category: "婚嫁", options: ["司仪", "婚礼主持人", "婚礼策划师"] },
  { category: "职能", options: ["HR", "行政", "采购", "销售", "客服"] },
  { category: "AI创作者", options: ["AI虚拟人"] },
  {
    category: "技能服务",
    options: [
      "书法定制师",
      "修图师",
      "刺绣行家",
      "剪辑师",
      "化妆师",
      "妆娘",
      "平面设计师",
      "形象设计师",
      "手工培训师",
      "手工艺人",
      "拼豆行家",
      "摄影培训师",
      "摄影师",
      "毛娘",
      "画师",
      "粘土行家",
      "美甲师",
      "自由模特",
      "花艺师",
      "设计师",
      "造型师",
      "钩织行家",
      "陶艺行家",
    ],
  },
  { category: "其他", options: ["翻译"] },
] as const;

/** Flattened compatibility list for callers that do not render grouped options. */
export const XHS_OCCUPATION_OPTIONS = XHS_OCCUPATION_GROUPS.flatMap(
  (group) => group.options,
);
export const XHS_OCCUPATION_IDENTITIES = XHS_OCCUPATION_OPTIONS;

/** Compact persona tags are distinct from the larger, rotating interest pool. */
export const xhsOpsPersonaTagsSchema = z.object({
  vertical: textList(),
  general: textList(),
});

export const xhsOpsPersonaSuggestionSchema = z.object({
  label: z.string().trim().min(1).max(40),
  positioning: z.string().trim().min(1),
  persona: xhsOpsPersonaSchema,
  personaTags: xhsOpsPersonaTagsSchema.default({}),
  interestPool: xhsOpsInterestPoolSchema,
});

export const xhsOpsPersonaGenerateResponseSchema = z.object({
  suggestions: z.array(xhsOpsPersonaSuggestionSchema).min(1).max(30),
  distribution: z.string(),
  project: xhsOpsProjectSchema,
});

/**
 * 账号基础资料草稿（运营文档 §四「账号基础资料」+ 脑图「素材生成/账号创建」）：
 * 昵称/简介由服务端文本生成；头像/背景图各生成 3 张备选（已拍板：AI 生成备选、
 * 人工上传仅兜底），运营点选后「应用到手机」走 xhs profile 子技能改资料。
 */
export const xhsOpsProfileApplyStatusSchema = z.enum([
  "applied",
  "partial",
  "failed",
]);

/** Durable controller-side operation state for profile application. */
export const xhsOpsProfileApplyOperationSchema = z.object({
  operationId: z.string(),
  status: z.enum(["running", "completed"]),
  deviceId: z.string(),
  taskId: z.string().nullable().default(null),
  accountUpdatedAt: z.string(),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  /** Takeover change order this apply belongs to; reconcile writes back to it. */
  changeOrderId: z.string().nullable().default(null),
});

export const xhsOpsProfileDraftSchema = z.object({
  nickname: text(),
  /** 星座+MBTI / 自我介绍 / 兴趣介绍 三段，≤100 字 */
  bio: text(),
  /** Generated from the reviewed persona and optionally applied to the phone. */
  occupation: text(),
  gender: z.enum(["", "男", "女", "不展示"]).default(""),
  /**
   * Exact date, and it must still be confirmed by the operator. Generation
   * proposes one derived from the persona age, with the month/day matching
   * the 星座 the bio states.
   */
  birthday: text(),
  region: text(),
  /**
   * Persona content only. 编辑主页 exposes no 兴趣标签 entry on the versions we
   * have verified, so this never travels to the phone — it is deliberately
   * absent from xhsOpsProfileFieldSchema, which lists the writable fields.
   */
  interestTags: textList(),
  /** media 目录下的绝对路径 */
  avatarCandidates: textList(),
  coverCandidates: textList(),
  avatarPath: z.string().nullable().default(null),
  coverPath: z.string().nullable().default(null),
  generatedAt: z.string().nullable().default(null),
  appliedAt: z.string().nullable().default(null),
  applyStatus: xhsOpsProfileApplyStatusSchema.nullable().default(null),
  /** 手机回报摘要（各字段 done/failed/skipped + 一句话），不含资料具体值 */
  applyResult: z.string().nullable().default(null),
  /** Durable operation ledger used to reconcile a task across controller restarts. */
  applyOperation: xhsOpsProfileApplyOperationSchema.nullable().default(null),
  /** 运营人工核对四项资料后的服务端时间戳；资料编辑后自动失效。 */
  reviewedAt: z.string().nullable().default(null),
  verifiedAt: z.string().nullable().default(null),
  verifiedAccountId: z.string().nullable().default(null),
  verificationTaskId: z.string().nullable().default(null),
});

const xhsOpsProfileDraftWriteSchema = xhsOpsProfileDraftSchema.omit({
  reviewedAt: true,
  appliedAt: true,
  applyStatus: true,
  applyResult: true,
  applyOperation: true,
  verifiedAt: true,
  verifiedAccountId: true,
  verificationTaskId: true,
});

export type XhsOpsProfileDraftRequiredField =
  | "nickname"
  | "bio"
  | "avatarPath"
  | "coverPath"
  | "gender"
  | "birthday"
  | "region"
  | "interestTags";

export function xhsOpsProfileDraftMissingFields(
  draft: z.input<typeof xhsOpsProfileDraftSchema>,
): XhsOpsProfileDraftRequiredField[] {
  const missing: XhsOpsProfileDraftRequiredField[] = [];
  const nickname = draft.nickname?.trim() ?? "";
  const bio = draft.bio?.trim() ?? "";
  if (!nickname || nickname.length > 20) missing.push("nickname");
  if (!bio || bio.length > 100) missing.push("bio");
  if (!draft.avatarPath?.trim()) missing.push("avatarPath");
  if (!draft.coverPath?.trim()) missing.push("coverPath");
  if (!draft.gender) missing.push("gender");
  const birthday = draft.birthday?.trim() ?? "";
  const date = new Date(`${birthday}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(birthday) ||
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== birthday ||
    date.getTime() >= Date.now()
  )
    missing.push("birthday");
  if (!draft.region?.trim()) missing.push("region");
  if (!draft.interestTags?.some((tag) => tag.trim()))
    missing.push("interestTags");
  return missing;
}

export function xhsOpsProfileDraftReady(
  draft: z.input<typeof xhsOpsProfileDraftSchema>,
): boolean {
  if (xhsOpsProfileDraftMissingFields(draft).length > 0) return false;
  return Boolean(draft.reviewedAt);
}

export const xhsOpsProfilePartSchema = z.enum(["text", "avatar", "cover"]);

/** How many candidate images each image slot offers the operator. */
export const XHS_PROFILE_CANDIDATES = 3;

/**
 * Decide how many candidates to ask the model for and which existing ones to
 * keep. A run the upstream killed part-way leaves an incomplete set that nobody
 * has picked from and whose review was invalidated — that one is topped up so
 * the operator keeps the images already paid for. Any other incomplete set is
 * deliberate (the operator selected one, or a reviewer signed it off), so
 * regenerating it yields a fresh set.
 *
 * Lives in shared because the card labels its button from the same rule; a
 * second copy in the web app would drift from what the controller actually does.
 */
export function xhsOpsProfileCandidatePlan(input: {
  existing: readonly string[];
  selected: string | null;
  reviewedAt: string | null;
}): { count: number; keep: readonly string[]; toppingUp: boolean } {
  const toppingUp =
    input.existing.length > 0 &&
    input.existing.length < XHS_PROFILE_CANDIDATES &&
    input.selected === null &&
    input.reviewedAt === null;
  return toppingUp
    ? {
        count: XHS_PROFILE_CANDIDATES - input.existing.length,
        keep: input.existing,
        toppingUp,
      }
    : { count: XHS_PROFILE_CANDIDATES, keep: [], toppingUp };
}

/**
 * Result of reading which account the bound phone is currently signed into.
 *
 * Carries the id so the card can prefill it — transcribing it off the
 * screenshot was the step operators got wrong. The screenshot is returned
 * alongside so the value can still be eyeballed, and the field stays editable.
 * The id travels only in the task's structured receipt, never in its narrative
 * trail (key_process / progress / logs).
 */
export const xhsOpsAccountIdentityResponseSchema = z.object({
  status: z.enum(["visible", "unavailable"]),
  /** Controller URL of the 编辑主页 screenshot, null when the task produced none. */
  screenshotUrl: z.string().nullable(),
  /** 小红书号 read off the phone, "" when it could not be read. */
  accountId: z.string(),
  taskId: z.string(),
  /** Operator-facing sentence; never contains the account id. */
  reason: z.string(),
});
export type XhsOpsAccountIdentity = z.infer<
  typeof xhsOpsAccountIdentityResponseSchema
>;

/** The eight fields the phone task can write, addressed individually. */
export const xhsOpsProfileFieldSchema = z.enum([
  "nickname",
  "bio",
  "occupation",
  "avatar",
  "cover",
  "gender",
  "birthday",
  "region",
]);
export type XhsOpsProfileField = z.infer<typeof xhsOpsProfileFieldSchema>;

export const XHS_PROFILE_FIELD_LABEL: Record<XhsOpsProfileField, string> = {
  nickname: "名字",
  bio: "简介",
  occupation: "职业",
  avatar: "头像",
  cover: "背景图",
  gender: "性别",
  birthday: "生日",
  region: "地区",
};

/** The fields' Chinese names joined by 「、」, e.g. 「简介、职业」. */
export function xhsOpsProfileFieldLabels(
  fields: readonly XhsOpsProfileField[],
): string {
  return fields.map((field) => XHS_PROFILE_FIELD_LABEL[field]).join("、");
}

/**
 * One row of the pre-apply comparison between the phone and the draft.
 *
 * `comparable` is false for 头像/背景图: the phone can report text but not
 * whether an existing picture is "the same" as the one about to be pushed, so
 * those rows are shown as an unconditional overwrite rather than a diff.
 */
export const xhsOpsProfileFieldDiffSchema = z.object({
  field: xhsOpsProfileFieldSchema,
  comparable: z.boolean(),
  /** Current value on the phone; "" when the field is empty there. */
  phone: z.string(),
  /** Value the draft would write; "" when the draft has nothing for it. */
  draft: z.string(),
  differs: z.boolean(),
});
export type XhsOpsProfileFieldDiff = z.infer<
  typeof xhsOpsProfileFieldDiffSchema
>;

/**
 * Result of reading the phone's current profile before applying.
 *
 * Unlike the identity check, this one does carry field values back: comparing
 * them is the whole point, and without them "apply" silently overwrites
 * whatever the operator had already set up by hand. The 小红书号 is still
 * excluded — identity is gated separately and does not need to travel.
 */
export const xhsOpsProfileReadbackResponseSchema = z.object({
  status: z.enum(["read", "unavailable"]),
  taskId: z.string(),
  reason: z.string(),
  screenshotUrl: z.string().nullable(),
  fields: z.array(xhsOpsProfileFieldDiffSchema),
});
export type XhsOpsProfileReadback = z.infer<
  typeof xhsOpsProfileReadbackResponseSchema
>;

/** Apply body: omit `fields` to write every field the draft has filled in. */
export const xhsOpsProfileApplyBodySchema = z.object({
  fields: z.array(xhsOpsProfileFieldSchema).min(1).max(8).optional(),
});

export const xhsOpsProfileGenerateBodySchema = z.object({
  parts: z.array(xhsOpsProfilePartSchema).min(1).max(3),
  /** Operator direction appended to the built avatar prompt. */
  avatarPrompt: z.string().trim().max(200).optional(),
  /** Operator direction appended to the built cover prompt. */
  coverPrompt: z.string().trim().max(200).optional(),
});

// ─── Takeover of an existing account (老号接管) ─────────────────────────────
// Design: docs/plans/2026-10-14-xhs-account-takeover-design.md §2. Everything
// under `account.takeover` is written by the controller only; the create and
// update schemas omit it the same way they omit `personaReviewedAt`.

/** A count as the page shows it, plus its parsed lower bound. */
export const xhsOpsCountSchema = z.object({
  /** Verbatim page text, e.g. "1.2万" or "999+". */
  text: z.string().max(12),
  /** Lower bound of the range the text stands for; null when unparseable. */
  value: z.number().int().nonnegative().nullable(),
  approx: z.boolean(),
});

export const xhsOpsMaturityTierSchema = z.enum([
  "starter",
  "growing",
  "established",
  "dormant",
]);

export const xhsOpsSafetyPauseSchema = z.object({
  // Desktop-side pause codes. Phone receipts keep their own codes
  // (phone_required, …); login_required is only the mapped pause reason.
  code: z.enum([
    "rate_limited",
    "account_restricted",
    "login_required",
    "account_mismatch",
    "observation_failed",
    "manual",
  ]),
  reason: z.string().max(200),
  /** runId / auditId / changeOrderId that raised it. */
  sourceRef: z.string().max(80).default(""),
  since: z.string(),
  // Only rate_limited / account_restricted get a cooldown; the rest resume
  // once the identity gate reports ready after a human fixed the phone.
  resumableAfter: z.string().nullable().default(null),
});

/** Pause codes whose 「恢复」 needs a written reason (§2.5 TakeoverResumeBody, §6.5). */
export const XHS_TAKEOVER_RESUME_REASON_CODES: ReadonlySet<
  XhsOpsSafetyPause["code"]
> = new Set(["rate_limited", "account_restricted", "observation_failed"]);

/** A platform limit quoted verbatim from a PROFILE_JSON note. */
export const xhsOpsPlatformLimitNoticeSchema = z.object({
  field: xhsOpsProfileFieldSchema,
  text: z.string().max(120),
  observedAt: z.string(),
  blockedUntil: z.string(),
  sourceTaskId: z.string().nullable().default(null),
});

export const xhsOpsToneGuideSchema = z.object({
  summary: z.string().max(200).default(""),
  pillars: z
    .array(
      z.object({
        name: z.string().max(16),
        sharePercent: z.number().int().min(0).max(100),
      }),
    )
    .max(5)
    .default([]),
  /** 选题方向, for a human to act on. */
  topicDirections: z.array(z.string().max(30)).max(6).default([]),
  titlePatterns: z.array(z.string().max(40)).max(4).default([]),
  coverStyle: z.string().max(80).default(""),
  bodyStyle: z.string().max(80).default(""),
  tagHints: z.array(z.string().max(20)).max(8).default([]),
  /** Existing traits to keep. */
  keep: z.array(z.string().max(30)).max(6).default([]),
  avoid: z.array(z.string().max(30)).max(8).default([]),
  /** Injected into the comment-candidate prompt (P0). */
  commentStyle: z.string().max(80).default(""),
  /** Posting cadence advice, executed by a human. */
  cadenceHint: z.string().max(60).default(""),
  ruleIds: z.array(z.string()).max(8).default([]),
  sourceDiagnosisId: z.string().nullable().default(null),
  confirmedAt: z.string().nullable().default(null),
});

/**
 * The account fields a confirmed takeover plan overwrites, captured before the
 * first confirmation so 「撤销方案」 can restore them in one step. Each field
 * reuses the schema the account itself uses.
 */
export const xhsOpsTakeoverPlanSnapshotSchema = z.object({
  label: z.string().min(1).max(40),
  positioning: text(),
  persona: xhsOpsPersonaSchema.default({}),
  personaTags: xhsOpsPersonaTagsSchema.default({}),
  interestPool: xhsOpsInterestPoolSchema.default({}),
  interaction: xhsOpsInteractionConfigSchema.default({}),
  browseDefaults: xhsOpsBrowseDefaultsSchema.default({}),
  toneGuide: xhsOpsToneGuideSchema.default({}),
});

/** Fields a diagnosis may propose changing; never 小红书号, birthday or gender. */
export const xhsOpsTakeoverProfileFieldSchema = z.enum([
  "nickname",
  "bio",
  "occupation",
  "region",
  "avatar",
  "cover",
]);

/** An adopted profile field the plan confirmation did not draft, and why. */
export const xhsOpsTakeoverSkippedFieldSchema = z.object({
  proposalId: z.string(),
  field: xhsOpsTakeoverProfileFieldSchema,
  reason: z.string().max(200),
});

/** How long a pendingIdentity read can still be confirmed (§2.1). */
export const XHS_TAKEOVER_IDENTITY_READ_TTL_MS = 30 * 60_000;

/** takeover.resumeHistory keeps the newest lifts, at most this many (§6.5). */
export const XHS_TAKEOVER_RESUME_HISTORY_LIMIT = 20;

export const xhsOpsTakeoverSchema = z.object({
  authorizedAt: z.string().nullable().default(null),
  authorizationNote: z.string().max(200).default(""),
  identityConfirmedAt: z.string().nullable().default(null),
  /** legacy = the old profile-verification record was carried over at authorization. */
  identitySource: z.enum(["takeover", "legacy"]).nullable().default(null),
  identityTaskId: z.string().nullable().default(null),
  identityScreenshotUrl: z.string().nullable().default(null),
  /**
   * Result of /takeover/identity/read, kept server-side only. Confirm requires
   * its taskId, an unchanged deviceId, and a readAt after authorizedAt and
   * within 30 minutes; the screenshot URL is taken from here. A body id that
   * differs from readAccountId needs overrideRead:true. readAccountId never
   * goes into an event. Cleared on confirm; a new read overwrites it.
   */
  pendingIdentity: z
    .object({
      taskId: z.string(),
      deviceId: z.string(),
      readAt: z.string(),
      screenshotUrl: z.string().nullable(),
      readAccountId: z.string(),
    })
    .nullable()
    .default(null),
  baselineAuditId: z.string().nullable().default(null),
  latestAuditId: z.string().nullable().default(null),
  /**
   * The audit running for this account, null when none runs: set when an
   * audit starts, cleared once it completes, fails, is cancelled or is
   * interrupted (the startup recovery included). The nurture gate and the
   * card read it instead of listing audits.
   */
  activeAuditId: z.string().nullable().default(null),
  maturity: xhsOpsMaturityTierSchema.nullable().default(null),
  activeDiagnosisId: z.string().nullable().default(null),
  planConfirmedAt: z.string().nullable().default(null),
  keepAllPublic: z.boolean().default(false),
  /**
   * The confirmed plan's adopted profile fields that got no change-order
   * draft, and why (the confirm response's skippedFields). A new
   * confirmation replaces the list, reverting the plan or an identity change
   * empties it, and creating a change order for a field drops its entry.
   */
  skippedFields: z.array(xhsOpsTakeoverSkippedFieldSchema).max(6).default([]),
  safetyPause: xhsOpsSafetyPauseSchema.nullable().default(null),
  /**
   * An observation_failed pause that is not the one in force because a
   * stronger pause (rate_limited, account_restricted) masks it — raised while
   * that pause stood, or replaced by it (§6.5). Resuming the stronger pause
   * raises it again instead of lifting the takeover, so the failed review
   * still needs its own 「恢复」 with a written reason and the identity gate.
   * The newest one is kept.
   */
  pendingObservationFailure: z
    .object({
      reason: z.string().max(200),
      /** The change order whose review failed. */
      sourceRef: z.string().max(80).default(""),
      since: z.string(),
    })
    .nullable()
    .default(null),
  /**
   * Every 「恢复」 that lifted a pause (§6.5), oldest first, the last 20 kept:
   * the pause as it stood (code, since, sourceRef, its reason), the
   * operator's written reason and the identity-gate task that reported
   * ready, if one ran. Lifting clears safetyPause; this is the trail.
   */
  resumeHistory: z
    .array(
      z.object({
        at: z.string(),
        code: xhsOpsSafetyPauseSchema.shape.code,
        since: z.string(),
        sourceRef: z.string().max(80).default(""),
        pauseReason: z.string().max(200).default(""),
        reason: z.string().max(200).default(""),
        gateTaskId: z.string().nullable().default(null),
      }),
    )
    .max(XHS_TAKEOVER_RESUME_HISTORY_LIMIT)
    .default([]),
  /** Set at authorization when the old flow had verified the account: it keeps nurturing until the plan is confirmed (D5). */
  legacyVerified: z.boolean().default(false),
  /** Pre-plan values of the eight plan-owned fields, restored by 「撤销方案」. */
  prePlanSnapshot: xhsOpsTakeoverPlanSnapshotSchema.nullable().default(null),
  /** Manual parameter changes beyond the tier caps (§6.3). */
  paramOverrides: z
    .array(
      z.object({
        at: z.string(),
        reason: z.string().max(200),
        fields: z.array(z.string().max(40)).max(8),
      }),
    )
    .max(20)
    .default([]),
  /** A phone task whose stop was never confirmed: nothing is dispatched until a human releases it on the card. */
  deviceHold: z
    .object({
      taskId: z.string(),
      sourceRef: z.string().max(80),
      since: z.string(),
    })
    .nullable()
    .default(null),
  // ── Change orders and observation ──
  activeChangeOrderId: z.string().nullable().default(null),
  observationUntil: z.string().nullable().default(null),
  noNurtureDates: z.array(xhsOpsDateSchema).max(14).default([]),
  platformLimitNotices: z
    .array(xhsOpsPlatformLimitNoticeSchema)
    .max(20)
    .default([]),
});

export const xhsOpsAccountSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  /** Whether this workflow creates a new account or optimizes an existing phone account. */
  entryMode: z.enum(["new", "existing"]).default("new"),
  /** 账号定位名，如"北京亲子周末号" */
  label: z.string().min(1).max(40),
  /** 一句话内容方向与风格 */
  positioning: text(),
  persona: xhsOpsPersonaSchema.default({}),
  personaTags: xhsOpsPersonaTagsSchema.default({}),
  personaReviewedAt: z.string().nullable().default(null),
  personaReviewNote: z.string().nullable().default(null),
  platformAccountId: z.string().trim().max(80).default(""),
  profileDraft: xhsOpsProfileDraftSchema.default({}),
  deviceId: z.string().nullable().default(null),
  deviceName: z.string().nullable().default(null),
  interestPool: xhsOpsInterestPoolSchema.default({}),
  interaction: xhsOpsInteractionConfigSchema.default({}),
  browseDefaults: xhsOpsBrowseDefaultsSchema.default({}),
  /** null = a new account, or an existing row whose takeover has not started. */
  takeover: xhsOpsTakeoverSchema.nullable().default(null),
  toneGuide: xhsOpsToneGuideSchema.default({}),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const xhsOpsAccountCreateSchema = xhsOpsAccountSchema
  .omit({
    id: true,
    createdAt: true,
    updatedAt: true,
    personaReviewedAt: true,
    personaReviewNote: true,
    takeover: true,
    toneGuide: true,
  })
  .extend({ profileDraft: xhsOpsProfileDraftWriteSchema.default({}) });

/** An account never moves between projects, so `projectId` is not patchable. */
export const xhsOpsAccountUpdateSchema = xhsOpsAccountCreateSchema
  .omit({ projectId: true })
  .partial()
  .extend({
    profileDraft: xhsOpsProfileDraftWriteSchema.optional(),
    expectedUpdatedAt: z.string().optional(),
    /**
     * Required when a takeover account's interaction / browseDefaults go past
     * the tier caps (§6.3); recorded in takeover.paramOverrides.
     */
    overrideReason: z.string().trim().min(1).max(200).optional(),
  });

export function xhsOpsProjectInputIssues(
  project: Pick<z.infer<typeof xhsOpsProjectSchema>, "business" | "audience">,
): string[] {
  const issues: string[] = [];
  if (!project.business.industry.trim()) issues.push("请填写所属行业");
  if (!project.business.product.trim()) issues.push("请填写产品或服务");
  if (!project.audience.ageRange.trim()) issues.push("请填写目标年龄范围");
  if (!project.audience.genderRatio.trim()) issues.push("请填写目标性别比例");
  if (!project.audience.regions.some((value) => value.trim()))
    issues.push("请填写目标地区");
  return issues;
}

export function xhsOpsProfileIssues(
  profile: z.input<typeof xhsOpsProfileInputSchema>,
): string[] {
  const issues: string[] = [];
  if (!profile.summary?.trim()) issues.push("请补充画像概述");
  if (!profile.base?.ageRange?.trim()) issues.push("请补充画像年龄范围");
  if (!profile.base?.genderRatio?.trim()) issues.push("请补充画像性别比例");
  if (!profile.base?.regions?.some((value) => value.trim()))
    issues.push("请补充画像地区");
  if (!profile.verticalInterests?.some((value) => value.trim()))
    issues.push("请补充垂直兴趣");
  if (!profile.generalInterests?.some((value) => value.trim()))
    issues.push("请补充泛兴趣");
  return issues;
}

export function xhsOpsPersonaIssues(
  account: Pick<
    z.infer<typeof xhsOpsAccountSchema>,
    "label" | "positioning" | "persona" | "personaTags" | "interestPool"
  >,
): string[] {
  const issues: string[] = [];
  if (!account.label.trim() || !account.positioning.trim())
    issues.push("请补充账号定位名与内容方向");
  const labels = {
    age: "年龄",
    gender: "性别",
    region: "地区",
    occupation: "职业/身份",
    lifeStatus: "生活状态",
  };
  for (const key of Object.keys(labels) as Array<keyof typeof labels>) {
    if (!account.persona[key].trim()) issues.push(`请补充${labels[key]}`);
  }
  const vertical = new Set(
    account.personaTags.vertical.map((value) => value.trim()).filter(Boolean),
  );
  const general = new Set(
    account.personaTags.general.map((value) => value.trim()).filter(Boolean),
  );
  if (vertical.size < 1 || vertical.size > 2)
    issues.push("号设档案需要 1–2 个不同的垂直标签");
  if (general.size < 2 || general.size > 3)
    issues.push("号设档案需要 2–3 个不同的泛兴趣标签");
  if (
    ["core", "extended", "general"].some(
      (key) =>
        !account.interestPool[key as keyof typeof account.interestPool].some(
          (value) => value.trim(),
        ),
    )
  )
    issues.push("请补齐核心、扩展和泛内容兴趣池");
  return issues;
}

// ─── Plan budget (shared by plan-suggest, the takeover plan and the gate) ───

/** Mirrors xhs-ops-plan-suggest: at most this many keywords per plan. */
export const XHS_OPS_PLAN_MAX_KEYWORDS = 8;
/** Mirrors xhs-ops-plan-suggest and the run plan schema: home feed cap per run. */
export const XHS_OPS_PLAN_MAX_HOME_FEED = 12;
/** Mirrors xhsOpsRunPlanKeywordSchema: posts per keyword cap. */
export const XHS_OPS_PLAN_MAX_POSTS_PER_KEYWORD = 8;

/**
 * Keywords a plan can draw on: core, extended and general trimmed, deduped
 * across the three layers and capped at XHS_OPS_PLAN_MAX_KEYWORDS — the same
 * `availableWords` plan-suggest builds.
 */
export function xhsOpsInterestWordCount(
  pool: Pick<XhsOpsInterestPool, "core" | "extended" | "general">,
): number {
  const words = new Set<string>();
  for (const raw of [...pool.core, ...pool.extended, ...pool.general]) {
    const word = raw.trim();
    if (word) words.add(word);
  }
  return Math.min(words.size, XHS_OPS_PLAN_MAX_KEYWORDS);
}

type PlanBudgetCheck = { kind: "words" | "home"; message: string };

function segmentBudgetChecks(
  segmentTarget: number,
  searchRatioPercent: number,
  wordCount: number,
): PlanBudgetCheck[] {
  const r = Math.max(0, Math.min(100, searchRatioPercent)) / 100;
  const searchBudget = Math.round(segmentTarget * r);
  const homeBudget = segmentTarget - searchBudget;
  const requiredWordCount = Math.ceil(
    searchBudget / XHS_OPS_PLAN_MAX_POSTS_PER_KEYWORD,
  );
  const checks: PlanBudgetCheck[] = [];
  if (requiredWordCount > wordCount) {
    checks.push({
      kind: "words",
      message: `本段搜索目标 ${searchBudget} 篇至少需要 ${requiredWordCount} 个兴趣词，当前只有 ${wordCount} 个，请补充兴趣池或增加每日分段`,
    });
  }
  if (homeBudget > XHS_OPS_PLAN_MAX_HOME_FEED) {
    checks.push({
      kind: "home",
      message: `本段首页目标 ${homeBudget} 篇超过上限 ${XHS_OPS_PLAN_MAX_HOME_FEED}，请提高搜索占比或增加每日分段`,
    });
  }
  return checks;
}

function planBudgetChecks(
  browseDefaults: Pick<
    XhsOpsBrowseDefaults,
    "dailyTargetPosts" | "dailySegments" | "searchRatioPercent"
  >,
  wordCount: number,
): PlanBudgetCheck[] {
  const target = browseDefaults.dailyTargetPosts ?? 0;
  if (target <= 0) return [];
  const segments = Math.max(1, Math.min(3, browseDefaults.dailySegments ?? 1));
  // The remainder goes to the first segments, and both checks are monotone
  // non-decreasing in the segment target, so the largest segment passing
  // means every segment passes.
  return segmentBudgetChecks(
    Math.ceil(target / segments),
    browseDefaults.searchRatioPercent,
    wordCount,
  );
}

/**
 * The two 409s plan-suggest raises for one segment, with its exact wording.
 * `wordCount` is xhsOpsInterestWordCount of the pool.
 */
export function xhsOpsSegmentBudgetIssues(
  segmentTarget: number,
  searchRatioPercent: number,
  wordCount: number,
): string[] {
  return segmentBudgetChecks(segmentTarget, searchRatioPercent, wordCount).map(
    (check) => check.message,
  );
}

/**
 * Whether every daily segment of this browse config can be planned from
 * `wordCount` keywords. Empty means plan-suggest will not 409; checked on the
 * largest segment, ceil(target / segments).
 */
export function xhsOpsPlanBudgetIssues(
  browseDefaults: Pick<
    XhsOpsBrowseDefaults,
    "dailyTargetPosts" | "dailySegments" | "searchRatioPercent"
  >,
  wordCount: number,
): string[] {
  return planBudgetChecks(browseDefaults, wordCount).map(
    (check) => check.message,
  );
}

// ─── Takeover maintenance parameters ────────────────────────────────────────

/**
 * Static per-tier cadence (§6.3, D3: heuristic starting values, only ever at
 * or below the new-account defaults). Each passes both plan-budget checks:
 * per segment starter 36 search / 9 home / 5 words, growing 21 / 9 / 3,
 * established 12 / 8 / 2, dormant 24 / 6 / 3. Collect, follow and comment stay
 * off in every tier.
 */
export const XHS_TAKEOVER_TIER_CADENCE: Record<
  XhsOpsMaturityTier,
  {
    dailyTargetPosts: number;
    dailySegments: number;
    searchRatioPercent: number;
    likeDailyCap: number;
    likeRatioPercent: number;
  }
> = {
  starter: {
    dailyTargetPosts: 90,
    dailySegments: 2,
    searchRatioPercent: 80,
    likeDailyCap: 5,
    likeRatioPercent: 10,
  },
  growing: {
    dailyTargetPosts: 60,
    dailySegments: 2,
    searchRatioPercent: 70,
    likeDailyCap: 5,
    likeRatioPercent: 8,
  },
  established: {
    dailyTargetPosts: 40,
    dailySegments: 2,
    searchRatioPercent: 60,
    likeDailyCap: 4,
    likeRatioPercent: 8,
  },
  dormant: {
    dailyTargetPosts: 30,
    dailySegments: 1,
    searchRatioPercent: 80,
    likeDailyCap: 2,
    likeRatioPercent: 5,
  },
};

export const XHS_TAKEOVER_TIER_LABEL: Record<XhsOpsMaturityTier, string> = {
  starter: "起步档",
  growing: "成长档",
  established: "成熟档",
  dormant: "沉寂档",
};

/** A dormant account is offered its step up once it has nurtured this many days (§6.3). */
export const XHS_TAKEOVER_DORMANT_REVIEW_DAYS = 7;

/**
 * The browseDefaults a dormant account is offered after a full week (§6.3):
 * 60 / 2 / 80%, per segment 24 search / 6 home / 3 words — both plan-budget
 * checks pass. The like caps stay. Above the dormant tier's own cap, so the
 * PATCH that writes it carries an overrideReason and lands in paramOverrides.
 */
export const XHS_TAKEOVER_DORMANT_REVIEW_BROWSE = {
  dailyTargetPosts: 60,
  dailySegments: 2,
  searchRatioPercent: 80,
} as const;

/** What the card says when xhsOpsTakeoverDormantReviewDue (§6.3, verbatim). */
export const XHS_TAKEOVER_DORMANT_REVIEW_MESSAGE =
  "建议调整到 60 / 2 / 80%（每段 24 / 6 / 3），之后按体量定档";

/** overrideReason the card sends with the suggestion once a human confirmed it. */
export const XHS_TAKEOVER_DORMANT_REVIEW_OVERRIDE_REASON =
  "沉寂档已跑满一周，按建议调整到 60 / 2 / 80%";

/**
 * Whether a dormant takeover account is due its one-week review (§6.3): the
 * plan was confirmed, its first nurture run since then completed at least
 * XHS_TAKEOVER_DORMANT_REVIEW_DAYS ago, and the daily target is still below
 * the suggestion's. Nothing changes by itself: a human confirms the
 * suggestion, written through the PATCH with an overrideReason. Comment runs
 * do not count as nurture.
 */
export function xhsOpsTakeoverDormantReviewDue(
  account: Pick<
    XhsOpsAccount,
    "id" | "entryMode" | "takeover" | "browseDefaults"
  >,
  runs: ReadonlyArray<
    Pick<XhsOpsRun, "accountId" | "status" | "plan" | "startedAt">
  >,
  now: number = Date.now(),
): boolean {
  const takeover = account.takeover;
  if (
    account.entryMode !== "existing" ||
    takeover?.maturity !== "dormant" ||
    !takeover.planConfirmedAt ||
    account.browseDefaults.dailyTargetPosts >=
      XHS_TAKEOVER_DORMANT_REVIEW_BROWSE.dailyTargetPosts
  )
    return false;
  const confirmedAt = Date.parse(takeover.planConfirmedAt);
  const starts = runs.flatMap((run) => {
    if (
      run.accountId !== account.id ||
      run.status !== "completed" ||
      run.plan.kind === "comment" ||
      !run.startedAt
    )
      return [];
    const at = Date.parse(run.startedAt);
    return Number.isFinite(at) && at >= confirmedAt ? [at] : [];
  });
  if (starts.length === 0) return false;
  return now - Math.min(...starts) >= XHS_TAKEOVER_DORMANT_REVIEW_DAYS * DAY_MS;
}

/** Same floor as the run service's MIN_NURTURE_DWELL_SECONDS. */
const TAKEOVER_MIN_DWELL_SECONDS = 11;
const DEFAULT_INTERACTION = xhsOpsInteractionConfigSchema.parse({});
const DEFAULT_BROWSE = xhsOpsBrowseDefaultsSchema.parse({});

export const xhsOpsTakeoverPlanIssueSchema = z.object({
  /** Path of the offending parameter; an approved override records it in paramOverrides.fields. */
  field: z.string(),
  message: z.string(),
  /**
   * true = beyond the tier or the schema default, allowed with an
   * overrideReason; false = a hard limit the run itself would reject.
   */
  overridable: z.boolean(),
});
export type XhsOpsTakeoverPlanIssue = z.infer<
  typeof xhsOpsTakeoverPlanIssueSchema
>;

/**
 * Stable code of a 409 that refuses a takeover account's interaction /
 * browseDefaults (§2.5, §6.3): takeover_override_reason_required — every
 * new issue is overridable, so the same request with an overrideReason
 * passes; takeover_param_hard_limit — at least one is a hard limit no
 * reason lifts, so the values have to change.
 */
export const xhsOpsTakeoverParamConflictCodeSchema = z.enum([
  "takeover_override_reason_required",
  "takeover_param_hard_limit",
]);
export type XhsOpsTakeoverParamConflictCode = z.infer<
  typeof xhsOpsTakeoverParamConflictCodeSchema
>;

/**
 * 409 body of the account PATCH and the device transfer. A takeover
 * parameter conflict adds `code` and `issues` — every parameter this change
 * newly puts past a limit, from xhsOpsTakeoverPlanIssues; any other conflict
 * carries `message` only. `message` keeps the wording it always had.
 */
export const xhsOpsAccountConflictResponseSchema = z.object({
  message: z.string(),
  code: xhsOpsTakeoverParamConflictCodeSchema.optional(),
  issues: z.array(xhsOpsTakeoverPlanIssueSchema).optional(),
});

/** Why a comment run was refused, where the card acts on it: the takeover is paused (§6.5). */
export const xhsOpsCommentRunConflictCodeSchema = z.enum(["takeover_paused"]);
export type XhsOpsCommentRunConflictCode = z.infer<
  typeof xhsOpsCommentRunConflictCodeSchema
>;

/**
 * 409 body of the comment-run route: a paused takeover adds `code`
 * ("takeover_paused") next to the unchanged message; any other conflict
 * carries `message` only.
 */
export const xhsOpsCommentRunConflictResponseSchema = z.object({
  message: z.string(),
  code: xhsOpsCommentRunConflictCodeSchema.optional(),
});

/**
 * Server-side re-check of a takeover account's maintenance parameters, at
 * plan confirmation and on every later interaction / browseDefaults PATCH
 * (§5.1 step 2, §6.3). `maturity` null applies the schema defaults only.
 */
export function xhsOpsTakeoverPlanIssues(
  plan: Pick<XhsOpsAccount, "browseDefaults" | "interaction" | "interestPool">,
  maturity: XhsOpsMaturityTier | null,
): XhsOpsTakeoverPlanIssue[] {
  const tier = maturity ? XHS_TAKEOVER_TIER_CADENCE[maturity] : null;
  const scope = maturity
    ? `接管档位（${XHS_TAKEOVER_TIER_LABEL[maturity]}）`
    : "新号默认值";
  const issues: XhsOpsTakeoverPlanIssue[] = [];
  for (const check of planBudgetChecks(
    plan.browseDefaults,
    xhsOpsInterestWordCount(plan.interestPool),
  )) {
    issues.push({
      field:
        check.kind === "words"
          ? "interestPool"
          : "browseDefaults.searchRatioPercent",
      message: check.message,
      overridable: false,
    });
  }
  if (plan.browseDefaults.dwellSecMin < TAKEOVER_MIN_DWELL_SECONDS) {
    issues.push({
      field: "browseDefaults.dwellSecMin",
      message: `单篇最短停留必须至少 ${TAKEOVER_MIN_DWELL_SECONDS} 秒`,
      overridable: false,
    });
  }
  const targetCap = Math.min(
    DEFAULT_BROWSE.dailyTargetPosts,
    tier?.dailyTargetPosts ?? Number.POSITIVE_INFINITY,
  );
  const target = plan.browseDefaults.dailyTargetPosts;
  if (target <= 0) {
    issues.push({
      field: "browseDefaults.dailyTargetPosts",
      message: `接管账号必须设日目标（0 表示按每词篇数走，不受${scope}约束）`,
      overridable: true,
    });
  } else if (target > targetCap) {
    issues.push({
      field: "browseDefaults.dailyTargetPosts",
      message: `日目标 ${target} 篇超过${scope}上限 ${targetCap} 篇`,
      overridable: true,
    });
  }
  const like = plan.interaction.like;
  if (like.enabled) {
    const capLimit = Math.min(
      DEFAULT_INTERACTION.like.dailyCap,
      tier?.likeDailyCap ?? Number.POSITIVE_INFINITY,
    );
    if (like.dailyCap > capLimit) {
      issues.push({
        field: "interaction.like.dailyCap",
        message: `点赞每日上限 ${like.dailyCap} 超过${scope}上限 ${capLimit}`,
        overridable: true,
      });
    }
    const ratioLimit = Math.min(
      DEFAULT_INTERACTION.like.ratioPercent,
      tier?.likeRatioPercent ?? Number.POSITIVE_INFINITY,
    );
    if (like.ratioPercent > ratioLimit) {
      issues.push({
        field: "interaction.like.ratioPercent",
        message: `点赞比例 ${like.ratioPercent}% 超过${scope}上限 ${ratioLimit}%`,
        overridable: true,
      });
    }
  }
  if (
    plan.interaction.collect.enabled &&
    !DEFAULT_INTERACTION.collect.enabled
  ) {
    issues.push({
      field: "interaction.collect.enabled",
      message: `开启收藏超出${scope}（默认关闭）`,
      overridable: true,
    });
  }
  if (plan.interaction.follow.enabled && !DEFAULT_INTERACTION.follow.enabled) {
    issues.push({
      field: "interaction.follow.enabled",
      message: `开启关注超出${scope}（默认关闭：关注列表公开，老粉看得到）`,
      overridable: true,
    });
  }
  if (
    plan.interaction.comment.enabled &&
    !DEFAULT_INTERACTION.comment.enabled
  ) {
    issues.push({
      field: "interaction.comment.enabled",
      message: `开启评论超出${scope}（默认关闭）`,
      overridable: true,
    });
  }
  return issues;
}

/** Derived lifecycle stage of a takeover (§1.1); never stored. */
export const xhsOpsTakeoverStageSchema = z.enum([
  "bound",
  "authorized",
  "identity_locked",
  "baselined",
  "diagnosed",
  /** Plan confirmed and a public change order is between precheck and manual check; nurture is held. */
  "plan_confirmed",
  "maintaining",
  "observing",
  "paused",
  "device_hold",
]);

/**
 * Stage of an existing account's takeover; null for a new account. A held
 * device outranks a pause, which outranks every lifecycle stage. `now` only
 * decides whether an observation window is still open.
 */
export function xhsOpsTakeoverStage(
  account: Pick<XhsOpsAccount, "entryMode" | "platformAccountId" | "takeover">,
  now: number = Date.now(),
): XhsOpsTakeoverStage | null {
  if (account.entryMode !== "existing") return null;
  const t = account.takeover;
  if (!t?.authorizedAt) return "bound";
  if (t.deviceHold) return "device_hold";
  if (t.safetyPause) return "paused";
  if (!t.identityConfirmedAt || !account.platformAccountId.trim())
    return "authorized";
  if (t.planConfirmedAt) {
    if (t.activeChangeOrderId) return "plan_confirmed";
    const until = t.observationUntil
      ? Date.parse(t.observationUntil)
      : Number.NaN;
    return Number.isFinite(until) && until > now ? "observing" : "maintaining";
  }
  if (!t.baselineAuditId) return "identity_locked";
  if (!t.activeDiagnosisId) return "baselined";
  return "diagnosed";
}

export const XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE =
  "已有账号已开始接管或已锁定小红书号，不能切换为新号流程";

/**
 * 409 of the profile-draft generate / confirm / apply / readback routes for
 * every existing account, a takeover === null legacy row included (§2.5): an
 * existing account's public profile only changes through change orders.
 */
export const XHS_TAKEOVER_PROFILE_DRAFT_LOCKED_MESSAGE =
  "已有账号请先开始接管，资料修改走变更单";

/**
 * Whether entryMode may no longer change (§2.5): once a takeover started, or
 * once an existing row has a 小红书号 on record. Switching such a row to "new"
 * would send a real account through the new-account material flow and around
 * every takeover safeguard, so updateAccount answers 409 and the planner card
 * disables its mode select.
 */
export function xhsOpsAccountEntryModeLocked(
  account: Pick<XhsOpsAccount, "entryMode" | "platformAccountId" | "takeover">,
): boolean {
  if (account.takeover) return true;
  return (
    account.entryMode === "existing" && account.platformAccountId.trim() !== ""
  );
}

// ─── Nurture gate ───────────────────────────────────────────────────────────

function profileVerifiedOnPhone(account: XhsOpsAccount): boolean {
  const draft = account.profileDraft;
  return Boolean(
    account.platformAccountId.trim() &&
      draft.applyStatus === "applied" &&
      draft.appliedAt &&
      draft.verifiedAt &&
      draft.verificationTaskId &&
      draft.verifiedAccountId === account.platformAccountId,
  );
}

/**
 * An existing account the pre-takeover flow had already applied and verified
 * on the phone. Such rows keep nurturing without a takeover, and authorizing
 * one carries the record over as identitySource "legacy" (D5).
 */
export function xhsOpsLegacyExistingVerified(account: XhsOpsAccount): boolean {
  return account.entryMode === "existing" && profileVerifiedOnPhone(account);
}

// The takeover gate's wording (§6.1), shared by the nurture gate below, the
// scheduler's skips, the store's device-work 409s and the change-order
// refusals, so every surface names one blocker the same way.

/** A phone task whose stop was never confirmed holds the device (§3.1 表二). */
export const XHS_TAKEOVER_DEVICE_HOLD_MESSAGE =
  "手机上的任务停止未确认，请到手机上确认后在接管卡片解除";
export const XHS_TAKEOVER_AUDIT_RUNNING_MESSAGE = "只读盘点进行中";
export const XHS_TAKEOVER_CHANGE_ORDER_ACTIVE_MESSAGE =
  "有资料变更单正在执行或待核验";
/** MT-03: a day with a public-profile change is no nurture day. */
export const XHS_TAKEOVER_NO_NURTURE_TODAY_MESSAGE =
  "今天改过公开资料，按规则当天不养号";

/** A takeover's safety pause as the gate names it, with the pause's own reason. */
export function xhsOpsTakeoverPausedMessage(reason: string): string {
  return `账号暂停中：${reason}`;
}

/** Unfinished work on an account or device that keeps a takeover step off the phone, most severe first. */
export type XhsOpsDeviceWorkKind =
  | "device_hold"
  | "run"
  | "audit"
  | "change_order";

/**
 * What a device-exclusive takeover step is for. It changes the 409 wording,
 * and an identity read is not blocked by a change order parked between phone
 * steps (interrupted, awaiting a human): such an order waits for that re-lock.
 */
export type XhsOpsDeviceWorkPurpose = "identity" | "audit" | "change_order";

/** The 409 of one kind of unfinished device work (§2.5, N3); `purpose` words the run case for the step that asked. */
export function xhsOpsDeviceWorkMessage(
  kind: XhsOpsDeviceWorkKind,
  purpose?: XhsOpsDeviceWorkPurpose,
): string {
  switch (kind) {
    case "device_hold":
      return XHS_TAKEOVER_DEVICE_HOLD_MESSAGE;
    case "audit":
      return `${XHS_TAKEOVER_AUDIT_RUNNING_MESSAGE}，请等它结束或先取消`;
    case "change_order":
      return `${XHS_TAKEOVER_CHANGE_ORDER_ACTIVE_MESSAGE}，请先处理完`;
    case "run":
      if (purpose === "change_order")
        return "今天还有待执行的养号或评论任务；要今天改资料请先取消它，否则改到明天";
      if (purpose) return "今天还有待执行的养号或评论任务，请先取消或等它结束";
      return "账号或设备还有待执行任务，请先取消任务";
  }
}

/** 409 of a PATCH or transfer that would clear or replace a locked 小红书号 (§2.5). */
export const XHS_ACCOUNT_IDENTITY_LOCKED_MESSAGE =
  "已有账号已开始接管或已记录小红书号，不能在这里修改或清空；请在接管的身份核对中重新读取手机上的账号";

/** Facts the gate needs that live outside the account row. */
export type XhsOpsNurtureContext = {
  /**
   * A running read-only audit exists for this account. takeover.activeAuditId
   * already says so; a caller that looked the audits up may still pass it.
   */
  auditRunning?: boolean;
  /** Local YYYY-MM-DD; when given, a takeover's noNurtureDates is honoured (MT-03). */
  today?: string;
};

function existingAccountNurtureIssues(
  account: XhsOpsAccount,
  project: XhsOpsProject | null,
  context: XhsOpsNurtureContext,
): string[] {
  const t = account.takeover;
  const draft = account.profileDraft;
  const issues: string[] = [];
  if (!project?.profile?.confirmedAt) issues.push("请先确认目标用户画像");
  if (!t) {
    // An existing row whose takeover has not started: the old flow's
    // verification still lets it run (D5); anything else starts a takeover.
    if (!xhsOpsLegacyExistingVerified(account))
      issues.push("请先开始接管：授权、锁定身份并完成只读盘点");
    if (draft.applyOperation?.status === "running")
      issues.push("资料应用任务仍在执行");
    return issues;
  }
  // A legacyVerified account got identityConfirmedAt preset at authorization.
  if (!account.platformAccountId.trim() || !t.identityConfirmedAt)
    issues.push("请先读取并锁定手机上的小红书号");
  if (!t.legacyVerified || t.planConfirmedAt) {
    if (!t.baselineAuditId) issues.push("请先完成只读盘点并确认基线");
    if (!t.planConfirmedAt)
      issues.push("请先确认接管方案（至少兴趣池与养号参数）");
  }
  issues.push(
    ...xhsOpsPlanBudgetIssues(
      account.browseDefaults,
      xhsOpsInterestWordCount(account.interestPool),
    ),
  );
  if (t.safetyPause)
    issues.push(xhsOpsTakeoverPausedMessage(t.safetyPause.reason));
  if (t.deviceHold) issues.push(XHS_TAKEOVER_DEVICE_HOLD_MESSAGE);
  if (context.auditRunning || t.activeAuditId)
    issues.push(XHS_TAKEOVER_AUDIT_RUNNING_MESSAGE);
  if (t.activeChangeOrderId)
    issues.push(XHS_TAKEOVER_CHANGE_ORDER_ACTIVE_MESSAGE);
  if (context.today && t.noNurtureDates.includes(context.today))
    issues.push(XHS_TAKEOVER_NO_NURTURE_TODAY_MESSAGE);
  if (draft.applyOperation?.status === "running")
    issues.push("资料应用任务仍在执行");
  return issues;
}

/**
 * A new account's nurture issue while its material is not complete and
 * confirmed: nine items, the platform interest tags included (the phone
 * applies eight of them). The run planner embeds the material card on
 * exactly this text.
 */
export const XHS_ACCOUNT_PROFILE_MATERIAL_REQUIRED_MESSAGE =
  "请先完成九项账号资料与素材并校验确认";

/** Checked again immediately before dispatch; draft confirmation alone is not a phone setup receipt. */
export function xhsOpsAccountNurtureIssues(
  account: z.infer<typeof xhsOpsAccountSchema>,
  project: z.infer<typeof xhsOpsProjectSchema> | null,
  context: XhsOpsNurtureContext = {},
): string[] {
  if (account.entryMode === "existing")
    return existingAccountNurtureIssues(account, project, context);
  const issues = xhsOpsPersonaIssues(account);
  if (!project?.profile?.confirmedAt) issues.unshift("请先确认目标用户画像");
  if (!account.personaReviewedAt)
    issues.push("人设或目标画像已变化，请重新核对并确认人设");
  if (!xhsOpsProfileDraftReady(account.profileDraft))
    issues.push(XHS_ACCOUNT_PROFILE_MATERIAL_REQUIRED_MESSAGE);
  if (account.profileDraft.applyOperation?.status === "running")
    issues.push("资料应用任务仍在执行或等待手机状态核验");
  if (!profileVerifiedOnPhone(account))
    issues.push("请先完成手机账号配置及资料生效核验");
  return issues;
}

export const xhsOpsDeviceBindingSchema = z.object({
  deviceId: z.string(),
  accountId: z.string(),
  accountLabel: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  canTransfer: z.boolean(),
  blockingReason: z.string().nullable(),
});

export const xhsOpsDeviceBindingListResponseSchema = z.object({
  bindings: z.array(xhsOpsDeviceBindingSchema),
});

export const xhsOpsAccountTransferSchema = z.object({
  fromAccountId: z.string().min(1),
  toAccountId: z.string().min(1).optional(),
  account: xhsOpsAccountCreateSchema
    .omit({ projectId: true, profileDraft: true })
    .extend({ deviceId: z.string().trim().min(1) }),
  /**
   * As on the account PATCH: required when the transfer puts a takeover
   * target's interaction / browseDefaults past the tier caps (§6.3);
   * recorded in takeover.paramOverrides.
   */
  overrideReason: z.string().trim().min(1).max(200).optional(),
});

// ─── Run ─────────────────────────────────────────────────────────────────────

export const xhsOpsAnomalyTypeSchema = z.enum([
  "no_results",
  "load_failed",
  "login_required",
  "account_restricted",
  "rate_limited",
  "content_mismatch",
  "interrupted",
  "other",
]);

export const xhsOpsAnomalySchema = z.object({
  type: xhsOpsAnomalyTypeSchema,
  detail: text(),
});

export const xhsOpsInteractionCountsSchema = z.object({
  like: count(),
  collect: count(),
  follow: count(),
  /** P3-1 D2：评论 run 里成功发出的评论数；浏览 run 不带此字段。 */
  comment: z.number().int().min(0).optional(),
});

export const xhsOpsRunChunkModeSchema = z.enum(["search", "home", "comment"]);

export const xhsOpsRunChunkStatusSchema = z.enum([
  "pending",
  "running",
  "completed",
  "failed",
  "skipped",
  "cancelled",
]);

export const xhsOpsRunPostActionSchema = z.enum([
  "like",
  "collect",
  "follow",
  "none",
  /** 点进去但没计数（评论不足/广告）——手机实际会报，保留而不是抹成 none。 */
  "skip",
]);

export const xhsOpsRunPostSchema = z.object({
  title: z.string(),
  author: z.string(),
  action: xhsOpsRunPostActionSchema,
  commentsRead: count(),
  /** Phone-reported seconds; cross-check with task elapsed time, not a host timer. */
  dwellSeconds: count(),
  commentsComplete: z.boolean().default(false),
  /** P3-1 D3：手机只标注"这帖值不值得评"，不写评论。 */
  commentWorthy: z.boolean().default(false),
  /** 正文一句话摘要（a11y 文本），给桌面生成评论候选用。 */
  summary: z.string().max(120).default(""),
});

export const xhsOpsRunChunkSchema = z.object({
  index: z.number().int().min(0),
  mode: xhsOpsRunChunkModeSchema,
  keyword: z.string().nullable(),
  plannedCount: z.number().int().min(0),
  status: xhsOpsRunChunkStatusSchema,
  taskId: z.string().nullable().default(null),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  browsed: count(),
  skipped: count(),
  refreshCount: count(),
  interactions: xhsOpsInteractionCountsSchema.default({}),
  /**
   * Existing accounts only (§6.3, NU-04): notes the phone did not like
   * because the account had already liked them. Absent for a new account,
   * whose chunk never asks.
   */
  alreadyLikedSkipped: z.number().int().min(0).optional(),
  anomalies: z.array(xhsOpsAnomalySchema).default([]),
  observation: z.string().nullable().default(null),
  posts: z.array(xhsOpsRunPostSchema).default([]),
  /** mode=comment 时：本 chunk 要发的评论草稿 id（一条评论一个 chunk）。 */
  commentDraftId: z.string().nullable().optional(),
  /** Raw phone message, truncated to 4000 chars. */
  message: z.string().nullable().default(null),
  totalSteps: z.number().int().nullable().default(null),
  finalScreenshot: z.string().nullable().default(null),
  error: z.string().nullable().default(null),
});

export const xhsOpsRunPlanKeywordSchema = z.object({
  keyword: z.string().min(1).max(40),
  count: z.number().int().min(1).max(8),
});

/** 评论 run 的一条待发评论（来自 approved 草稿的快照）。 */
export const xhsOpsRunPlanCommentSchema = z.object({
  draftId: z.string(),
  postTitle: z.string().max(60),
  postAuthor: z.string().max(40),
  text: z.string().min(1).max(30),
});

export const xhsOpsRunPlanSchema = z.object({
  /** 省略/browse = 搜索/首页浏览；comment = 发人工审核通过的评论（P3-1 D2）。 */
  kind: z.enum(["browse", "comment"]).optional(),
  /** browse 至少 1 个关键词（由服务校验）；comment 为空。 */
  keywords: z.array(xhsOpsRunPlanKeywordSchema).max(8),
  homeFeedCount: z.number().int().min(0).max(12),
  dwellSecMin: z.number().int().min(1),
  dwellSecMax: z.number().int().min(1),
  interaction: xhsOpsInteractionConfigSchema,
  comments: z.array(xhsOpsRunPlanCommentSchema).max(5).optional(),
});

export const xhsOpsRunSummarySchema = z.object({
  plannedTotal: count(),
  browsedTotal: count(),
  searchBrowsed: count(),
  homeBrowsed: count(),
  interactions: xhsOpsInteractionCountsSchema.default({}),
  /** 「已赞跳过 k 篇」 (§6.3): the chunks' alreadyLikedSkipped summed; absent when none was reported. */
  alreadyLikedSkipped: z.number().int().min(0).optional(),
  anomalyCount: count(),
  durationMs: z.number().int().nullable().default(null),
});

/** 当日多段执行时本 run 是第几段（P2-3）；单 run 为 null。 */
export const xhsOpsRunSegmentSchema = z.object({
  index: z.number().int().min(1).max(3),
  count: z.number().int().min(1).max(3),
});

export const xhsOpsRunStatusSchema = z.enum([
  "planned",
  "running",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

/** Installation/login preparation is separate from browsing and its quotas. */
export const xhsOpsPreparationCodeSchema = z.enum([
  "ready",
  "phone_required",
  "verification_required",
  "sms_unavailable",
  "account_mismatch",
  "store_unavailable",
  "install_failed",
  "login_failed",
  "account_restricted",
  "rate_limited",
  "invalid_result",
  "device_unavailable",
  /** Another takeover step, a device hold or a profile apply kept the phone past the wait (N3). */
  "device_busy",
  /** The phone's last reported policy mode is not enforce (§5.2 前提). */
  "policy_not_enforce",
  "dispatch_failed",
  "interrupted",
  "cancelled",
]);

export const xhsOpsPreparationSchema = z.object({
  status: z.enum([
    "running",
    "ready",
    "blocked",
    "failed",
    "cancelled",
    "interrupted",
  ]),
  reasonCode: xhsOpsPreparationCodeSchema.nullable(),
  /** Fixed controller text only; never phone messages, numbers, or codes. */
  reason: z.string().nullable(),
  /**
   * Non-blocking notes on a ready identity gate (§3.2 点击对账): more clicks
   * than its expected navigation, or a report the phone's completion gate
   * contradicted. Fixed controller text plus the click counts; the run went
   * ahead all the same.
   */
  warnings: z.array(z.string().max(120)).max(4).optional(),
  taskId: z.string().nullable(),
  startedAt: z.string(),
  completedAt: z.string().nullable(),
});

export const xhsOpsRunSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  accountId: z.string(),
  deviceId: z.string(),
  /** Snapshot of the account label at plan time. */
  accountLabel: z.string(),
  date: xhsOpsDateSchema,
  status: xhsOpsRunStatusSchema,
  plan: xhsOpsRunPlanSchema,
  segment: xhsOpsRunSegmentSchema.nullable().default(null),
  /**
   * 设备队列（P2-4）：startRun 时同一手机上已有 xhs-ops run 在跑，本 run 保持
   * `planned` 并记下排在谁后面；前一个结束后由服务自动启动并清空此字段。
   */
  queuedBehindRunId: z.string().nullable().default(null),
  preparation: xhsOpsPreparationSchema.optional(),
  chunks: z.array(xhsOpsRunChunkSchema).default([]),
  summary: xhsOpsRunSummarySchema.default({}),
  /** 运营观察（人工填写） */
  notes: text(),
  error: z.string().nullable().default(null),
  createdAt: z.string(),
  startedAt: z.string().nullable().default(null),
  completedAt: z.string().nullable().default(null),
  updatedAt: z.string(),
});

export const xhsOpsRunCreateSchema = z.object({
  projectId: z.string().min(1),
  accountId: z.string().min(1),
  /** Manual start and scheduling share an unfinished account/day/segment run. */
  reuseActive: z.boolean().optional(),
  /** Defaults to today in the controller's local time zone. */
  date: xhsOpsDateSchema.optional(),
  plan: xhsOpsRunPlanSchema,
  segment: xhsOpsRunSegmentSchema.nullable().optional(),
});

export const xhsOpsRunUpdateSchema = z.object({
  notes: z.string().max(4000).optional(),
});

/** 桌面按兴趣池生成的当日计划建议（GET /projects/{id}/plan-suggest）。 */
export const xhsOpsPlanSuggestionSchema = z.object({
  accountId: z.string(),
  accountLabel: z.string(),
  keywords: z.array(xhsOpsRunPlanKeywordSchema),
  homeFeedCount: z.number().int().min(0).max(12),
  dwellSecMin: z.number().int().min(1),
  dwellSecMax: z.number().int().min(1),
  interaction: xhsOpsInteractionConfigSchema,
  /** 生成依据，给运营看：轮换第几轮、避开了什么、比例怎么算的。 */
  rationale: z.array(z.string()),
  /** 多段执行时的段序（P2-3）；单 run 为 null。 */
  segment: xhsOpsRunSegmentSchema.nullable().default(null),
});

/** An account left out of today's suggestions, with the 409 plan-suggest raised for it. */
export const xhsOpsPlanSkipSchema = z.object({
  accountId: z.string(),
  accountLabel: z.string(),
  reason: z.string(),
});

export const xhsOpsPlanSuggestResponseSchema = z.object({
  plans: z.array(xhsOpsPlanSuggestionSchema),
  /** One account's 409 no longer fails the project's suggestions (§5.3 #5). */
  skipped: z.array(xhsOpsPlanSkipSchema).default([]),
});

export const xhsOpsRunListQuerySchema = z.object({
  projectId: z.string().optional(),
  accountId: z.string().optional(),
  date: xhsOpsDateSchema.optional(),
});

/**
 * 「已赞跳过 k 篇」 per day (§6.3, NU-04): each date's runs' summary
 * alreadyLikedSkipped summed, for one account or all of them. Dates with
 * nothing skipped are left out. An old account liked much of its feed in the
 * past, so a like count below the quota is normal; this says how much.
 */
export function xhsOpsAlreadyLikedSkippedByDate(
  runs: ReadonlyArray<Pick<XhsOpsRun, "accountId" | "date" | "summary">>,
  accountId?: string,
): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const run of runs) {
    if (accountId !== undefined && run.accountId !== accountId) continue;
    const skipped = run.summary.alreadyLikedSkipped ?? 0;
    if (skipped > 0) totals[run.date] = (totals[run.date] ?? 0) + skipped;
  }
  return totals;
}

// ─── Comment drafts (P3-1 D1) ───────────────────────────────────────────────

/**
 * 评论草稿状态机：pending → approved | rejected；approved → sent | failed；
 * 当天未执行的 approved 次日 expired（帖子时效）。任何一条发出去的评论都必须
 * 先有 approved 记录，且 text 与手机 TYPE 的文字逐字一致（D2 的策略白名单）。
 */
export const xhsOpsCommentStatusSchema = z.enum([
  "pending",
  "approved",
  "rejected",
  "sent",
  "failed",
  "expired",
]);

export const xhsOpsCommentPostSchema = z.object({
  title: z.string().max(60),
  author: z.string().max(40),
  summary: z.string().max(120).default(""),
});

export const xhsOpsCommentDraftSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  accountId: z.string(),
  deviceId: z.string().nullable().default(null),
  /** 候选来自哪次浏览 run 的哪篇帖子。 */
  sourceRunId: z.string(),
  sourceChunkIndex: z.number().int().min(0),
  sourcePostIndex: z.number().int().min(0),
  post: xhsOpsCommentPostSchema,
  /** 桌面生成的候选（已过硬校验），运营点选或改写。 */
  candidates: z.array(z.string().max(30)).max(5).default([]),
  /** 审核后的最终文案；批准前为 null。 */
  text: z.string().max(30).nullable().default(null),
  status: xhsOpsCommentStatusSchema.default("pending"),
  reviewedAt: z.string().nullable().default(null),
  reviewNote: text(),
  sentRunId: z.string().nullable().default(null),
  sentAt: z.string().nullable().default(null),
  sendResult: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const xhsOpsCommentGenerateBodySchema = z.object({
  /** 省略 = 该 run 里所有 commentWorthy 的帖子。 */
  posts: z
    .array(
      z.object({
        chunkIndex: z.number().int().min(0),
        postIndex: z.number().int().min(0),
      }),
    )
    .min(1)
    .max(10)
    .optional(),
});

export const xhsOpsCommentReviewBodySchema = z.object({
  decision: z.enum(["approved", "rejected"]),
  /** 批准时的最终文案；省略则取第一条候选。 */
  text: z.string().max(30).optional(),
  note: z.string().max(200).optional(),
});

export const xhsOpsCommentListQuerySchema = z.object({
  status: xhsOpsCommentStatusSchema.optional(),
  accountId: z.string().optional(),
});

/** 桌面配额：cap = min(dailyCap, 5, floor(今日浏览/8))；remaining = cap − 今日已发 − 已批未发。 */
export const xhsOpsCommentQuotaSchema = z.object({
  accountId: z.string(),
  accountLabel: z.string(),
  date: xhsOpsDateSchema,
  enabled: z.boolean(),
  dailyCap: z.number().int(),
  todayBrowsed: z.number().int(),
  byBrowse: z.number().int(),
  cap: z.number().int(),
  sentToday: z.number().int(),
  approvedPending: z.number().int(),
  remaining: z.number().int(),
});

export const xhsOpsCommentListResponseSchema = z.object({
  drafts: z.array(xhsOpsCommentDraftSchema),
  quotas: z.array(xhsOpsCommentQuotaSchema),
});
export const xhsOpsCommentResponseSchema = z.object({
  draft: xhsOpsCommentDraftSchema,
});
export const xhsOpsCommentGenerateResponseSchema = z.object({
  drafts: z.array(xhsOpsCommentDraftSchema),
  skipped: z.array(z.string()),
});
export const xhsOpsCommentQuotaResponseSchema = z.object({
  quota: xhsOpsCommentQuotaSchema,
});

// ─── Takeover: counts ───────────────────────────────────────────────────────

const COUNT_UNITS: Record<string, number> = {
  万: 10_000,
  w: 10_000,
  W: 10_000,
  亿: 100_000_000,
};
const COUNT_PATTERN = /^(\d+)(?:\.(\d+))?(万|w|W|亿)?(\+)?$/;

/**
 * Parse a count exactly as the page printed it (§3.4 rule 5). "1.2万" →
 * 12000 approx, "999+" → 999 approx, "356" → 356 exact; anything else keeps
 * its text with value null. Blank or missing text is null: nothing was read.
 */
export function xhsOpsParseCount(
  raw: string | null | undefined,
): XhsOpsCount | null {
  const trimmed = raw?.trim() ?? "";
  if (!trimmed) return null;
  const text = trimmed.slice(0, 12);
  const match = COUNT_PATTERN.exec(trimmed.replace(/[,，\s]/g, ""));
  if (!match) return { text, value: null, approx: false };
  const [, whole = "", fraction = "", unit, plus] = match;
  // A decimal point only makes sense in an abbreviated count.
  if (fraction && !unit) return { text, value: null, approx: false };
  const value = Math.round(
    Number(`${whole}.${fraction || "0"}`) *
      (unit ? (COUNT_UNITS[unit] ?? 1) : 1),
  );
  if (!Number.isSafeInteger(value)) return { text, value: null, approx: false };
  return { text, value, approx: Boolean(unit || plus) };
}

/** Inclusive integer range a count stands for; max null = no upper bound. */
export type XhsOpsCountRange = { min: number; max: number | null };

/**
 * Range behind a parsed count: exact counts are a point, "1.2万" is
 * 12000–12999 (the page truncates to the shown precision), "999+" is 999 and
 * up. Null when the count is missing or unparseable.
 */
export function xhsOpsCountRange(
  count: XhsOpsCount | null | undefined,
): XhsOpsCountRange | null {
  if (!count || count.value === null) return null;
  if (!count.approx) return { min: count.value, max: count.value };
  const match = COUNT_PATTERN.exec(count.text.replace(/[,，\s]/g, ""));
  if (!match || match[4]) return { min: count.value, max: null };
  const unit = match[3] ? (COUNT_UNITS[match[3]] ?? 1) : 1;
  const step = Math.max(1, Math.round(unit / 10 ** (match[2]?.length ?? 0)));
  return { min: count.value, max: count.value + step - 1 };
}

export const xhsOpsHeaderCountsSchema = z.object({
  following: xhsOpsCountSchema.nullable(),
  followers: xhsOpsCountSchema.nullable(),
  likesCollects: xhsOpsCountSchema.nullable(),
});

export type XhsOpsHeaderCountFlag = "countsChanged" | "possibleSelfLike";

/**
 * Graded diff of two header reads (§3.2 状态差分): any change of an exact
 * following count is countsChanged; an exact likes+collects rise of 1–3 is
 * possibleSelfLike. Followers grow on their own and are never flagged.
 */
export function xhsOpsHeaderCountFlags(
  before: XhsOpsHeaderCounts | null | undefined,
  after: XhsOpsHeaderCounts | null | undefined,
): XhsOpsHeaderCountFlag[] {
  const exactDelta = (
    from: XhsOpsCount | null | undefined,
    to: XhsOpsCount | null | undefined,
  ): number | null =>
    from &&
    to &&
    !from.approx &&
    !to.approx &&
    from.value !== null &&
    to.value !== null
      ? to.value - from.value
      : null;
  const flags: XhsOpsHeaderCountFlag[] = [];
  const following = exactDelta(before?.following, after?.following);
  if (following !== null && following !== 0) flags.push("countsChanged");
  const likes = exactDelta(before?.likesCollects, after?.likesCollects);
  if (likes !== null && likes >= 1 && likes <= 3)
    flags.push("possibleSelfLike");
  return flags;
}

// ─── Takeover: audits (read-only snapshots) ─────────────────────────────────

export const xhsOpsAuditEvidenceSchema = z.object({
  taskId: z.string(),
  finishedAt: z.string().nullable(),
  /** URL only; the screenshot directory may be cleaned. */
  screenshotUrl: z.string().nullable(),
  /** parseReceiptClicks; null always means trusted:false. */
  receiptClicks: z.number().int().nullable(),
  trusted: z.boolean(),
  warnings: z.array(z.string().max(200)).max(10).default([]),
});

export const xhsOpsAuditPartStatusSchema = z.enum([
  "pending",
  "running",
  "read",
  "partial",
  "unavailable",
  "failed",
  "interrupted",
  "cancelled",
  "skipped",
]);

export const xhsOpsAuditNoteCardSchema = z.object({
  i: z.number().int().min(1).max(20),
  /** Untrusted and possibly truncated; never a key. */
  title: z.string().max(20),
  likes: xhsOpsCountSchema.nullable(),
  video: z.boolean(),
  pinned: z.boolean(),
});

export const xhsOpsAuditFlagSchema = z.enum([
  "nicknameInconsistent",
  "identityStale",
  "unexpectedClicks",
  "countsChanged",
  "possibleSelfLike",
  "profileDrift",
  "creatorUnavailable",
  "cancellationUnconfirmed",
]);

/**
 * Audit flags that need 「已人工检查」 before the audit becomes the baseline
 * (§1.2 T3), each with the short name the baseline refusal lists it by.
 */
export const XHS_TAKEOVER_MANUAL_CHECK_AUDIT_FLAGS: ReadonlyMap<
  XhsOpsAuditFlag,
  string
> = new Map([
  ["unexpectedClicks", "点击数超出预期路径"],
  ["countsChanged", "关注数前后不一致"],
  ["possibleSelfLike", "获赞与收藏小幅增加"],
  ["profileDrift", "资料与上次盘点不一致"],
]);

/** The flags of an audit that need 「已人工检查」 before a baseline confirm, in their order. */
export function xhsOpsAuditManualCheckFlags(
  flags: readonly XhsOpsAuditFlag[],
): XhsOpsAuditFlag[] {
  return flags.filter((flag) =>
    XHS_TAKEOVER_MANUAL_CHECK_AUDIT_FLAGS.has(flag),
  );
}

export const xhsOpsAccountAuditSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  accountId: z.string(),
  deviceId: z.string(),
  /** Expected id, taken from the account and never from a receipt. */
  platformAccountId: z.string(),
  trigger: z
    .enum(["takeover", "observation", "periodic", "manual"])
    .default("manual"),
  changeOrderId: z.string().nullable().default(null),
  status: z.enum([
    "running",
    "completed",
    "partial",
    "failed",
    "interrupted",
    "cancelled",
  ]),
  reason: z.string().max(200).default(""),
  /** Persisted before dispatch; a restart reconciles or stops it (§3.1 表二). */
  activeTaskId: z.string().nullable().default(null),
  /** Part one: identity check + profile archive; the authoritative "before" values (PF-07). */
  profile: z
    .object({
      status: xhsOpsAuditPartStatusSchema,
      /** e.g. device_unavailable, policy_blocked (§3.1 表二). */
      code: z.string().max(24),
      evidence: xhsOpsAuditEvidenceSchema.nullable(),
      accountMatched: z.boolean(),
      values: z
        .object({
          nickname: z.string(),
          bio: z.string(),
          occupation: z.string(),
          gender: z.string(),
          birthdayFilled: z.boolean(),
          region: z.string(),
        })
        .nullable(),
    })
    .nullable()
    .default(null),
  home: z
    .object({
      status: xhsOpsAuditPartStatusSchema,
      code: z.string().max(24),
      evidence: xhsOpsAuditEvidenceSchema.nullable(),
      /** Compared on the desktop with profile.values.nickname. */
      nickname: z.string().max(24),
      /** Read at the start and again at the end of part A. */
      header: xhsOpsHeaderCountsSchema.nullable(),
      headerEnd: xhsOpsHeaderCountsSchema.nullable(),
      notesEnd: z.boolean(),
      notes: z.array(xhsOpsAuditNoteCardSchema).max(20),
    })
    .nullable()
    .default(null),
  creator: z
    .object({
      status: xhsOpsAuditPartStatusSchema,
      code: z.string().max(24),
      evidence: xhsOpsAuditEvidenceSchema.nullable(),
      /** Compared on the desktop; never embedded in a phone task. */
      nickname: z.string().max(24),
      /** Read again on entering 「我」, for the diff. */
      header: xhsOpsHeaderCountsSchema.nullable(),
      periodLabel: z.string().max(24),
      views: xhsOpsCountSchema.nullable(),
      interactions: xhsOpsCountSchema.nullable(),
      newFollowers: xhsOpsCountSchema.nullable(),
      profileVisitors: xhsOpsCountSchema.nullable(),
      accountStatus: z.string().max(20),
    })
    .nullable()
    .default(null),
  /** P1: part C note sampling (at most 3 notes). */
  noteDetails: z.object({}).nullable().default(null),
  flags: z.array(xhsOpsAuditFlagSchema).default([]),
  /** With warnings, 「已人工检查」 must be ticked before this becomes the baseline. */
  manualCheckAt: z.string().nullable().default(null),
  startedAt: z.string(),
  completedAt: z.string().nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

// ─── Takeover: audit comparison ─────────────────────────────────────────────

/** Interval-aware difference of one count between two audits. */
export type XhsOpsCountComparison = {
  base: XhsOpsCount | null;
  target: XhsOpsCount | null;
  /** target − base as a range; null when either side is unreadable, bounds null when open. */
  delta: { min: number | null; max: number | null } | null;
  /** Both sides exact, so delta is a single number. */
  exact: boolean;
  /** "uncertain" = the change is smaller than the shown precision, or a side is missing. */
  direction: "up" | "down" | "same" | "uncertain";
};

export type XhsOpsAuditProfileValueKey =
  | "nickname"
  | "bio"
  | "occupation"
  | "gender"
  | "birthdayFilled"
  | "region";

export type XhsOpsAuditComparison = {
  baseAuditId: string;
  targetAuditId: string;
  /** Days between the two audits' startedAt; NaN-free, negative when target is older. */
  daysApart: number;
  header: Record<
    "following" | "followers" | "likesCollects",
    XhsOpsCountComparison
  >;
  /** 近 7 日 figures only compare when both were read and the audits are ≥ 7 days apart. */
  weekly:
    | {
        comparable: true;
        views: XhsOpsCountComparison;
        interactions: XhsOpsCountComparison;
        newFollowers: XhsOpsCountComparison;
        profileVisitors: XhsOpsCountComparison;
      }
    | { comparable: false; reason: "creator_unavailable" | "interval_lt_7d" };
  /** Set difference by title prefix; null when either note grid was not read. */
  notes: {
    added: string[];
    removed: string[];
    /**
     * The target grid reached its end, so every "removed" title really left
     * the account; otherwise it may only have been pushed past the cards read.
     */
    complete: boolean;
  } | null;
  /**
   * Cards in both grids whose 置顶 flag changed (§7.1: the next audit checks
   * the pin advice a human acted on), matched by title prefix like `notes`;
   * the target's titles. null when either note grid was not read.
   */
  pins: {
    /** Pinned now, not pinned in the base audit. */
    pinned: string[];
    /** Pinned in the base audit, no longer pinned now. */
    unpinned: string[];
  } | null;
  /** Profile archive fields whose value changed; birthday only as 已填/未填. */
  profileChanges: Array<{
    field: XhsOpsAuditProfileValueKey;
    base: string;
    target: string;
  }>;
};

const DAY_MS = 86_400_000;
const WEEKLY_MIN_DAYS = 7;
const NOTE_TITLE_PREFIX = 8;
const READ_PART_STATUSES: ReadonlySet<string> = new Set(["read", "partial"]);

function compareCount(
  base: XhsOpsCount | null,
  target: XhsOpsCount | null,
): XhsOpsCountComparison {
  const from = xhsOpsCountRange(base);
  const to = xhsOpsCountRange(target);
  if (!from || !to)
    return { base, target, delta: null, exact: false, direction: "uncertain" };
  const delta = {
    min: from.max === null ? null : to.min - from.max,
    max: to.max === null ? null : to.max - from.min,
  };
  const direction =
    delta.min !== null &&
    delta.max !== null &&
    delta.min === 0 &&
    delta.max === 0
      ? "same"
      : delta.min !== null && delta.min > 0
        ? "up"
        : delta.max !== null && delta.max < 0
          ? "down"
          : "uncertain";
  return {
    base,
    target,
    delta,
    exact: from.max === from.min && to.max === to.min,
    direction,
  };
}

/** First readable header value: start of part A, end of part A, then part B. */
function auditHeaderCount(
  audit: XhsOpsAccountAudit,
  key: keyof XhsOpsHeaderCounts,
): XhsOpsCount | null {
  return (
    audit.home?.header?.[key] ??
    audit.home?.headerEnd?.[key] ??
    audit.creator?.header?.[key] ??
    null
  );
}

function noteTitleKey(title: string): string {
  return title
    .replace(/\s+/g, "")
    .replace(/(…|\.{3})+$/, "")
    .slice(0, NOTE_TITLE_PREFIX);
}

function noteTitleDiff(
  from: readonly XhsOpsAuditNoteCard[],
  to: readonly XhsOpsAuditNoteCard[],
): string[] {
  const seen = new Set(from.map((note) => noteTitleKey(note.title)));
  return to
    .filter((note) => {
      const key = noteTitleKey(note.title);
      return key !== "" && !seen.has(key);
    })
    .map((note) => note.title);
}

/** Cards present in both grids whose pinned flag moved, by title prefix (first card per prefix). */
function notePinDiff(
  from: readonly XhsOpsAuditNoteCard[],
  to: readonly XhsOpsAuditNoteCard[],
): { pinned: string[]; unpinned: string[] } {
  const before = new Map<string, boolean>();
  for (const note of from) {
    const key = noteTitleKey(note.title);
    if (key !== "" && !before.has(key)) before.set(key, note.pinned);
  }
  const pinned: string[] = [];
  const unpinned: string[] = [];
  const seen = new Set<string>();
  for (const note of to) {
    const key = noteTitleKey(note.title);
    if (key === "" || seen.has(key)) continue;
    seen.add(key);
    const was = before.get(key);
    if (was === undefined || was === note.pinned) continue;
    (note.pinned ? pinned : unpinned).push(note.title);
  }
  return { pinned, unpinned };
}

/**
 * Compare two audits of the same account (§6.4). Abbreviated counts subtract
 * as ranges, 近 7 日 data compares only ≥ 7 days apart (creator.md:21 forbids
 * extrapolating), new notes are a set difference on title prefixes and pin
 * changes are read on the cards both grids hold (§7.1).
 */
export function compareXhsOpsAudits(
  base: XhsOpsAccountAudit,
  target: XhsOpsAccountAudit,
): XhsOpsAuditComparison {
  const span =
    (Date.parse(target.startedAt) - Date.parse(base.startedAt)) / DAY_MS;
  const daysApart = Number.isFinite(span) ? span : 0;
  const header = {
    following: compareCount(
      auditHeaderCount(base, "following"),
      auditHeaderCount(target, "following"),
    ),
    followers: compareCount(
      auditHeaderCount(base, "followers"),
      auditHeaderCount(target, "followers"),
    ),
    likesCollects: compareCount(
      auditHeaderCount(base, "likesCollects"),
      auditHeaderCount(target, "likesCollects"),
    ),
  };
  const baseCreator = base.creator;
  const targetCreator = target.creator;
  let weekly: XhsOpsAuditComparison["weekly"];
  if (
    !baseCreator ||
    !targetCreator ||
    !READ_PART_STATUSES.has(baseCreator.status) ||
    !READ_PART_STATUSES.has(targetCreator.status)
  ) {
    weekly = { comparable: false, reason: "creator_unavailable" };
  } else if (!Number.isFinite(span) || span < WEEKLY_MIN_DAYS) {
    weekly = { comparable: false, reason: "interval_lt_7d" };
  } else {
    weekly = {
      comparable: true,
      views: compareCount(baseCreator.views, targetCreator.views),
      interactions: compareCount(
        baseCreator.interactions,
        targetCreator.interactions,
      ),
      newFollowers: compareCount(
        baseCreator.newFollowers,
        targetCreator.newFollowers,
      ),
      profileVisitors: compareCount(
        baseCreator.profileVisitors,
        targetCreator.profileVisitors,
      ),
    };
  }
  const baseHome = base.home;
  const targetHome = target.home;
  const gridsRead =
    baseHome &&
    targetHome &&
    READ_PART_STATUSES.has(baseHome.status) &&
    READ_PART_STATUSES.has(targetHome.status)
      ? { base: baseHome.notes, target: targetHome.notes }
      : null;
  const notes =
    gridsRead && targetHome
      ? {
          added: noteTitleDiff(gridsRead.base, gridsRead.target),
          removed: noteTitleDiff(gridsRead.target, gridsRead.base),
          complete: targetHome.notesEnd,
        }
      : null;
  const pins = gridsRead ? notePinDiff(gridsRead.base, gridsRead.target) : null;
  const profileChanges: XhsOpsAuditComparison["profileChanges"] = [];
  const from = base.profile?.values;
  const to = target.profile?.values;
  if (from && to) {
    const show = (value: string | boolean): string =>
      typeof value === "boolean" ? (value ? "已填" : "未填") : value;
    for (const field of [
      "nickname",
      "bio",
      "occupation",
      "gender",
      "birthdayFilled",
      "region",
    ] as const) {
      if (from[field] !== to[field])
        profileChanges.push({
          field,
          base: show(from[field]),
          target: show(to[field]),
        });
    }
  }
  return {
    baseAuditId: base.id,
    targetAuditId: target.id,
    daysApart,
    header,
    weekly,
    notes,
    pins,
    profileChanges,
  };
}

// ─── Takeover: observation verdict ──────────────────────────────────────────

/** Safety signals that fail an observation window outright (§6.4). */
export type XhsOpsObservationSignal =
  | "rate_limited"
  | "account_restricted"
  | "login_required";

const OBSERVATION_SIGNAL_LABEL: Record<XhsOpsObservationSignal, string> = {
  rate_limited: "操作频繁",
  account_restricted: "账号受限",
  login_required: "需要登录",
};

export type XhsOpsObservationInput = {
  risk: "L1" | "L2";
  /**
   * compareXhsOpsAudits(base, review): base is observation.baseAuditId, review
   * the audit the observation review ran; null without a base audit.
   */
  comparison: XhsOpsAuditComparison | null;
  /** The review's 号码核对 matched the order's platformAccountId. */
  accountMatched: boolean;
  /** Signals any run, audit or gate of this account raised inside the window. */
  signals: readonly XhsOpsObservationSignal[];
  /**
   * Text fields the order changed whose review readback differs from `after`.
   * Never an image field: the readback has no image (§6.4).
   */
  fieldMismatches: readonly XhsOpsProfileField[];
  /** Image fields the order changed, with the post-review human comparison once submitted. */
  images: ReadonlyArray<{
    field: "avatar" | "cover";
    result: "match" | "mismatch" | null;
  }>;
};

export type XhsOpsObservationResult = {
  verdict: "pass" | "warn" | "fail" | "inconclusive";
  /** An image still waits for its human comparison, so the order stays observing. */
  awaitingVisualCheck: boolean;
  /** Operator-facing reasons, at most six (observation.notes). */
  notes: string[];
};

/** An exact followers drop warns at ≥ 3 % and ≥ 20 (thresholds uncalibrated, §6.4). */
const OBSERVATION_FOLLOWERS_DROP_PERCENT = 3;
const OBSERVATION_FOLLOWERS_DROP_MIN = 20;
/** An L2 order warns when 近 7 日 views fall by ≥ 50 %. */
const OBSERVATION_VIEWS_DROP_PERCENT = 50;

/**
 * Whether `target` is at least `percent` below `base` for every value the two
 * ranges allow (true), for none of them (false), or only for some (null).
 */
function droppedBy(
  base: XhsOpsCountRange,
  target: XhsOpsCountRange,
  percent: number,
): boolean | null {
  const keep = 100 - percent;
  if (
    target.max !== null &&
    base.min > 0 &&
    target.max * 100 <= base.min * keep
  )
    return true;
  if (
    base.max !== null &&
    (base.max === 0 || target.min * 100 > base.max * keep)
  )
    return false;
  return null;
}

function fieldLabels(fields: readonly XhsOpsProfileField[]): string {
  return fields.map((field) => XHS_PROFILE_FIELD_LABEL[field]).join("、");
}

/**
 * Verdict of an observation review (§6.4): fail on a risk signal, a readback
 * that is not `after`, a 号码 mismatch or an image a human marked mismatched;
 * otherwise inconclusive while an image waits for its comparison. warn on an
 * exact followers drop of ≥ 3 % and ≥ 20, or — L2 only, audits ≥ 7 days
 * apart — 近 7 日 views down ≥ 50 %. Approximate followers (≥ 1 万 shows
 * 「1.2万」) and changes smaller than the shown precision are inconclusive;
 * anything else passes. L1 therefore only looks at signals, readback,
 * identity and exact counts, and a mature account mostly gets pass or
 * inconclusive — not evidence that its metrics held up.
 */
export function xhsOpsObservationVerdict(
  input: XhsOpsObservationInput,
): XhsOpsObservationResult {
  const failures: string[] = [];
  if (!input.accountMatched) failures.push("复查时号码核对不一致");
  const signals = [...new Set(input.signals)];
  if (signals.length > 0)
    failures.push(
      `观察期内出现风控信号：${signals.map((code) => OBSERVATION_SIGNAL_LABEL[code]).join("、")}`,
    );
  if (input.fieldMismatches.length > 0)
    failures.push(
      `复查回读与目标值不一致：${fieldLabels(input.fieldMismatches)}`,
    );
  const mismatched = input.images.filter(
    (image) => image.result === "mismatch",
  );
  if (mismatched.length > 0)
    failures.push(
      `图片与原图不一致：${fieldLabels(mismatched.map((image) => image.field))}`,
    );
  if (failures.length > 0)
    return { verdict: "fail", awaitingVisualCheck: false, notes: failures };

  const pending = input.images.filter((image) => image.result === null);
  if (pending.length > 0)
    return {
      verdict: "inconclusive",
      awaitingVisualCheck: true,
      notes: [
        `等待人工对照图片：${fieldLabels(pending.map((image) => image.field))}`,
      ],
    };

  const comparison = input.comparison;
  if (!comparison)
    return {
      verdict: "inconclusive",
      awaitingVisualCheck: false,
      notes: ["没有可对比的基准盘点"],
    };
  const warnings: string[] = [];
  const unsure: string[] = [];
  const followers = comparison.header.followers;
  const followersBase = followers.base?.value ?? null;
  const followersTarget = followers.target?.value ?? null;
  if (!followers.exact || followersBase === null || followersTarget === null) {
    unsure.push(
      followers.base && followers.target
        ? "粉丝数只显示约数，这一条不作判定"
        : "粉丝数没有读到",
    );
  } else {
    const drop = followersBase - followersTarget;
    if (
      drop >= OBSERVATION_FOLLOWERS_DROP_MIN &&
      drop * 100 >= followersBase * OBSERVATION_FOLLOWERS_DROP_PERCENT
    )
      warnings.push(
        `粉丝从 ${followersBase} 降到 ${followersTarget}，减少 ${drop}`,
      );
  }
  if (input.risk === "L2" && comparison.weekly.comparable) {
    const views = comparison.weekly.views;
    const from = xhsOpsCountRange(views.base);
    const to = xhsOpsCountRange(views.target);
    const dropped =
      from && to ? droppedBy(from, to, OBSERVATION_VIEWS_DROP_PERCENT) : null;
    if (dropped === true)
      warnings.push(
        `近 7 日观看从 ${views.base?.text ?? ""} 降到 ${views.target?.text ?? ""}，降幅不低于 ${OBSERVATION_VIEWS_DROP_PERCENT}%`,
      );
    else if (dropped === null)
      unsure.push(
        from && to
          ? "近 7 日观看是近似值，变化小于页面精度"
          : "近 7 日观看没有读到",
      );
  }
  if (warnings.length > 0)
    return {
      verdict: "warn",
      awaitingVisualCheck: false,
      notes: [...warnings, ...unsure],
    };
  if (unsure.length > 0)
    return {
      verdict: "inconclusive",
      awaitingVisualCheck: false,
      notes: unsure,
    };
  return { verdict: "pass", awaitingVisualCheck: false, notes: [] };
}

// ─── Takeover: diagnoses ────────────────────────────────────────────────────

export const xhsOpsCountRangeSchema = z.object({
  min: z.number().int().nonnegative(),
  /** null = no upper bound (e.g. "999+"). */
  max: z.number().int().nonnegative().nullable(),
});

/** Deterministic facts computed by the controller from one audit (§4.2). */
export const xhsOpsAccountFactsSchema = z.object({
  following: xhsOpsCountRangeSchema.nullable().default(null),
  followers: xhsOpsCountRangeSchema.nullable().default(null),
  likesCollects: xhsOpsCountRangeSchema.nullable().default(null),
  notesSeen: z.number().int().min(0).max(20).default(0),
  notesEnd: z.boolean().default(false),
  videoSharePercent: z.number().int().min(0).max(100).nullable().default(null),
  pinnedCount: z.number().int().min(0).max(20).default(0),
  /** Median of the note cards' like counts (lower bounds). */
  medianNoteLikes: z.number().int().nonnegative().nullable().default(null),
  /** Indexes of the top three note cards by likes. */
  topNoteIndexes: z.array(z.number().int().min(1).max(20)).max(3).default([]),
  /** false is normal for new or never-activated creator accounts. */
  creatorAvailable: z.boolean().default(false),
  weekly: z
    .object({
      periodLabel: z.string().max(24),
      views: xhsOpsCountRangeSchema.nullable(),
      interactions: xhsOpsCountRangeSchema.nullable(),
      newFollowers: xhsOpsCountRangeSchema.nullable(),
      profileVisitors: xhsOpsCountRangeSchema.nullable(),
    })
    .nullable()
    .default(null),
  /** 推荐流匹配度 from recent home-feed chunk observations. */
  feedMatch: z.enum(["high", "medium", "low", "unknown"]).default("unknown"),
  tier: xhsOpsMaturityTierSchema,
  /** Which tier conditions decided it, e.g. "粉丝下界 1200 ≥ 1000". */
  tierReasons: z.array(z.string().max(80)).max(3).default([]),
  budget: z
    .array(
      z.object({
        field: xhsOpsTakeoverProfileFieldSchema,
        blockedUntil: z.string().nullable(),
      }),
    )
    .max(6)
    .default([]),
  recentSafetyStops: z.number().int().min(0).default(0),
});

/** A path into the audit, facts or project that the server resolves to a non-empty value. */
const xhsOpsEvidenceRefSchema = z
  .string()
  .max(40)
  .regex(
    /^(profile|home|creator|notes|facts|project)(\.[A-Za-z0-9]+|\[\d+\])*$/,
  );
const xhsOpsRuleRefsSchema = z
  .array(z.string().regex(/^[A-Z]{2,4}-\d{2}$/))
  .min(1)
  .max(3);

export const xhsOpsFindingSchema = z.object({
  id: z.string().regex(/^F\d{1,2}$/),
  dimension: z.enum([
    "identity",
    "persona_fit",
    "verticality",
    "tone",
    "activity",
    "performance",
    "risk",
    "compliance",
  ]),
  severity: z.enum(["info", "low", "medium", "high"]),
  summary: z.string().max(120),
  evidence: z.array(xhsOpsEvidenceRefSchema).min(1).max(2),
  ruleIds: xhsOpsRuleRefsSchema,
});

const proposalBase = {
  id: z.string().regex(/^P\d{1,2}$/),
  rationale: z.string().max(160),
  findingIds: z.array(z.string()).max(3).default([]),
  evidence: z.array(xhsOpsEvidenceRefSchema).max(2).default([]),
  ruleIds: xhsOpsRuleRefsSchema,
};

export const xhsOpsProposalSchema = z.discriminatedUnion("kind", [
  z.object({
    ...proposalBase,
    kind: z.literal("positioning"),
    label: z.string().min(1).max(40),
    positioning: z.string().max(200),
    persona: xhsOpsPersonaSchema,
    personaTags: xhsOpsPersonaTagsSchema,
  }),
  z.object({
    ...proposalBase,
    kind: z.literal("interestPool"),
    core: z.array(z.string().max(40)).min(3).max(12),
    extended: z.array(z.string().max(40)).max(8),
    general: z.array(z.string().max(40)).max(8),
  }),
  z.object({
    ...proposalBase,
    kind: z.literal("toneGuide"),
    guide: xhsOpsToneGuideSchema.omit({
      sourceDiagnosisId: true,
      confirmedAt: true,
      ruleIds: true,
    }),
  }),
  z.object({
    ...proposalBase,
    kind: z.literal("profileField"),
    field: xhsOpsTakeoverProfileFieldSchema,
    // from, risk, batch and budgetBlockedUntil are filled in by code, never trusted from the LLM.
    to: z.string().max(120),
  }),
  z.object({
    ...proposalBase,
    kind: z.literal("noteAction"),
    noteIndex: z.number().int().min(1).max(20),
    /** Shown to a human only; the system never executes it. */
    action: z.enum(["keep", "pin", "unpin", "consider_private"]),
  }),
  z.object({
    ...proposalBase,
    kind: z.literal("keep"),
    field: z.string().max(20),
  }),
]);

export const xhsOpsProposalRiskSchema = z.enum(["L0", "L1", "L2", "L3"]);

/** A proposal plus the fields the controller assigns after the LLM returns. */
export const xhsOpsDiagnosisProposalSchema = xhsOpsProposalSchema.and(
  z.object({
    risk: xhsOpsProposalRiskSchema,
    batch: z.number().int().min(0).max(4),
    from: z.string().max(120).default(""),
    budgetBlockedUntil: z.string().nullable().default(null),
  }),
);

export const xhsOpsDiagnosisDecisionSchema = z.object({
  decision: z.enum(["adopt", "edit", "reject", "defer"]),
  /** Re-validated against the proposal's kind. */
  edited: z.unknown().optional(),
  decidedAt: z.string(),
});

export const xhsOpsAccountDiagnosisSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  accountId: z.string(),
  auditId: z.string(),
  version: z.number().int().min(1),
  parentId: z.string().nullable().default(null),
  status: z.enum(["generating", "ready", "failed", "superseded", "confirmed"]),
  playbookVersion: z.string(),
  /** Snapshot of the cited playbook rules, filled by code (not LLM output). */
  citedRules: z
    .array(
      z.object({
        id: z.string(),
        text: z.string(),
        source: z.string(),
        confidence: z.string(),
        signedOff: z.boolean(),
      }),
    )
    .max(30)
    .default([]),
  facts: xhsOpsAccountFactsSchema,
  /** Computed by code from the tier. */
  cadence: z.object({
    browseDefaults: xhsOpsBrowseDefaultsSchema,
    interaction: xhsOpsInteractionConfigSchema,
    rationale: z.array(z.string().max(120)).max(6),
  }),
  summary: z.string().max(300).default(""),
  inferredPersona: z
    .object({
      persona: xhsOpsPersonaSchema,
      contentLine: z.string().max(80),
      confidence: z.enum(["low", "medium", "high"]),
    })
    .nullable()
    .default(null),
  dimensions: z
    .array(
      z.object({
        dimension: z.string(),
        rating: z.enum(["good", "fair", "poor", "unknown"]),
        note: z.string().max(60),
      }),
    )
    .max(7)
    .default([]),
  findings: z.array(xhsOpsFindingSchema).max(5).default([]),
  questions: z
    .array(
      z.object({
        id: z.string(),
        text: z.string().max(60),
        options: z.array(z.string().max(20)).max(4),
        answer: z.string().max(60).nullable().default(null),
      }),
    )
    .max(3)
    .default([]),
  proposals: z.array(xhsOpsDiagnosisProposalSchema).max(8).default([]),
  dropped: z
    .array(z.object({ ref: z.string().max(12), reason: z.string().max(120) }))
    .max(20)
    .default([]),
  decisions: z.record(z.string(), xhsOpsDiagnosisDecisionSchema).default({}),
  feedback: z
    .array(z.object({ at: z.string(), text: z.string().max(300) }))
    .max(10)
    .default([]),
  generator: z.object({ botId: z.string(), model: z.string().nullable() }),
  confirmedAt: z.string().nullable().default(null),
  error: z.string().max(200).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/**
 * 内容支柱 → 兴趣词 (§6.2, T6): the interest words each tone-guide pillar
 * maps to — a word that contains the pillar name or is contained in it. The
 * diagnosis adds an unmapped pillar's name to the pool it proposes, and the
 * card shows this mapping once the plan is confirmed. Shared so both agree.
 */
export function xhsOpsTonePillarKeywords(
  pillars: readonly { name: string }[],
  pool: Pick<XhsOpsInterestPool, "core" | "extended" | "general">,
): Array<{ pillar: string; words: string[] }> {
  const words = [...pool.core, ...pool.extended, ...pool.general]
    .map((word) => word.trim())
    .filter((word, index, all) => word && all.indexOf(word) === index);
  return pillars.flatMap((entry) => {
    const pillar = entry.name.trim();
    if (!pillar) return [];
    const key = pillar.toLowerCase();
    return [
      {
        pillar,
        words: words.filter((word) => {
          const candidate = word.toLowerCase();
          return (
            candidate.includes(key) ||
            (candidate.length >= 2 && key.includes(candidate))
          );
        }),
      },
    ];
  });
}

// ─── Takeover: change orders ────────────────────────────────────────────────

export const xhsOpsChangeOrderAcksSchema = z.object({
  photoPermission: z.boolean().optional(),
  screenshotPrivacy: z.boolean().optional(),
  cleanup: z.boolean().optional(),
  l2SecondCheck: z.boolean().optional(),
  warnAcknowledged: z.boolean().optional(),
});

export const xhsOpsChangeOrderVisualCheckSchema = z.object({
  screenshotUrl: z.string().nullable(),
  result: z.enum(["match", "mismatch"]),
  at: z.string(),
});

export const xhsOpsChangeOrderFlagSchema = z.enum([
  "countsChanged",
  "possibleSelfLike",
  "permissionRequired",
  "albumNotFound",
  "pickerUnsupported",
]);

export const xhsOpsChangeOrderStatusSchema = z.enum([
  "draft",
  "prechecking",
  "awaiting_confirm",
  "applying",
  "verifying",
  /** An image field needs a human to compare the verification screenshot. */
  "awaiting_visual_check",
  /** Header counts moved; a human checks the phone before observation starts. */
  "awaiting_manual_check",
  "observing",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export const xhsOpsChangeOrderSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  accountId: z.string(),
  deviceId: z.string(),
  platformAccountId: z.string(),
  diagnosisId: z.string().nullable(),
  proposalIds: z.array(z.string()).max(2),
  batchIndex: z.number().int().min(1),
  risk: z.enum(["L1", "L2"]),
  fields: z
    .array(
      z.object({
        field: xhsOpsProfileFieldSchema,
        // Image fields keep baselineValue and before as "" (§5.2 step 1).
        baselineValue: z.string(),
        /** Phone value read at precheck (the pre-change archive). */
        before: z.string().default(""),
        /** For image fields, the direction note. */
        after: z.string(),
        /** User upload at <mediaRoot>/xhs-takeover/<orderId>/<field>.<ext>. */
        imagePath: z.string().nullable().default(null),
        /** Part of confirmDigest; re-checked before precheck and apply. */
        imageSha256: z.string().nullable().default(null),
        /** Flat album for this field only, e.g. Tabby-1a2b3c4d-a. */
        mediaAlbum: z.string().nullable().default(null),
        beforeScreenshotUrl: z.string().nullable().default(null),
        outcome: z
          .enum([
            "pending",
            "done",
            "failed",
            "skipped",
            "uncertain",
            "verified",
            "mismatch",
          ])
          .default("pending"),
        /** PROFILE_JSON fieldCodes entry. */
        code: z.string().max(32).nullable().default(null),
        /** Image fields: the human comparison after verification. */
        visualCheck: xhsOpsChangeOrderVisualCheckSchema
          .nullable()
          .default(null),
        note: z.string().max(200).default(""),
      }),
    )
    .min(1)
    .max(2),
  status: xhsOpsChangeOrderStatusSchema,
  // Precheck and verification each read the three header counts (§5.2 step 5).
  countsBefore: xhsOpsHeaderCountsSchema.nullable().default(null),
  countsAfter: xhsOpsHeaderCountsSchema.nullable().default(null),
  flags: z.array(xhsOpsChangeOrderFlagSchema).default([]),
  /**
   * Every album a picture of this order was pushed into, across its attempts,
   * oldest first (§5.2 step 4 清理). A field's mediaAlbum is reset when an
   * attempt goes back to draft, but what reached the phone stays there:
   * the cleanup reminder lists these.
   */
  pushedAlbums: z.array(z.string().max(128)).max(20).default([]),
  manualCheckAt: z.string().nullable().default(null),
  /** What the user ticked at confirmation, kept verbatim; which are required depends on the order (§2.5). */
  acks: xhsOpsChangeOrderAcksSchema.default({}),
  acksAt: z.string().nullable().default(null),
  precheck: z
    .object({
      taskId: z.string(),
      readAt: z.string(),
      accountMatched: z.boolean(),
      drift: z.array(
        z.object({
          field: xhsOpsProfileFieldSchema,
          baseline: z.string(),
          current: z.string(),
        }),
      ),
      /** sha256 over fields before/after, image sha256s, platformAccountId and the budget snapshot. */
      confirmDigest: z.string(),
      /** Valid for 30 minutes. */
      expiresAt: z.string(),
    })
    .nullable()
    .default(null),
  /**
   * The precheck's phone task while it runs: `precheck` only exists once it
   * passed, and a restart has to stop or reconcile the task (§3.1 表二).
   */
  precheckTaskId: z.string().nullable().default(null),
  confirmedAt: z.string().nullable().default(null),
  applyTaskId: z.string().nullable().default(null),
  verificationTaskId: z.string().nullable().default(null),
  /** Last screenshot of the verification, what a human compares an image with (§5.2 step 5). */
  verificationScreenshotUrl: z.string().nullable().default(null),
  observation: z
    .object({
      until: z.string(),
      auditId: z.string().nullable(),
      /** Latest completed audit before confirmedAt, the review baseline. */
      baseAuditId: z.string().nullable(),
      // Image orders: verdict stays inconclusive and the order observing until
      // every image field is compared by a human after the review.
      visualChecks: z
        .record(z.enum(["avatar", "cover"]), xhsOpsChangeOrderVisualCheckSchema)
        .default({}),
      verdict: z.enum(["pending", "pass", "warn", "fail", "inconclusive"]),
      notes: z.array(z.string().max(120)).max(6),
    })
    .nullable()
    .default(null),
  rollbackOfId: z.string().nullable().default(null),
  error: z.string().max(200).nullable().default(null),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type XhsOpsTakeoverProfileField = z.infer<
  typeof xhsOpsTakeoverProfileFieldSchema
>;

export type XhsOpsTakeoverFieldBudget = {
  risk: "L1" | "L2";
  /** Fixed batches: 简介+职业 → 昵称+地区 → 头像+背景图 (MT-02). */
  batch: 1 | 2 | 3;
  windowDays: number;
  maxChanges: number;
  /** Needs acks.l2SecondCheck at confirmation. */
  secondCheck: boolean;
  /** Not changed during the first observation window. */
  notInFirstObservation: boolean;
  /** Proposed only when the operator explicitly asked for it. */
  onlyOnRequest: boolean;
  image: boolean;
};

/**
 * Takeover self-limits per public field (§8.1), stricter than the known
 * platform limits because the previous operator's usage is unknown. Counted
 * per field from the apply task's start, whatever the order's final state;
 * platformLimitNotices add to it and rollbacks are exempt but still counted.
 */
export const XHS_TAKEOVER_CHANGE_BUDGET: Record<
  XhsOpsTakeoverProfileField,
  XhsOpsTakeoverFieldBudget
> = {
  bio: {
    risk: "L1",
    batch: 1,
    windowDays: 7,
    maxChanges: 1,
    secondCheck: false,
    notInFirstObservation: false,
    onlyOnRequest: false,
    image: false,
  },
  occupation: {
    risk: "L1",
    batch: 1,
    windowDays: 14,
    maxChanges: 1,
    secondCheck: false,
    notInFirstObservation: false,
    onlyOnRequest: false,
    image: false,
  },
  nickname: {
    risk: "L2",
    batch: 2,
    windowDays: 30,
    maxChanges: 1,
    secondCheck: true,
    notInFirstObservation: true,
    onlyOnRequest: false,
    image: false,
  },
  region: {
    risk: "L2",
    batch: 2,
    windowDays: 30,
    maxChanges: 1,
    secondCheck: true,
    notInFirstObservation: false,
    onlyOnRequest: true,
    image: false,
  },
  avatar: {
    risk: "L2",
    batch: 3,
    windowDays: 7,
    maxChanges: 1,
    secondCheck: false,
    notInFirstObservation: false,
    onlyOnRequest: false,
    image: true,
  },
  cover: {
    risk: "L2",
    batch: 3,
    windowDays: 7,
    maxChanges: 1,
    secondCheck: false,
    notInFirstObservation: false,
    onlyOnRequest: false,
    image: true,
  },
};

/** Observation window per change-order risk (D2). */
export const XHS_TAKEOVER_OBSERVATION_HOURS: Record<"L1" | "L2", number> = {
  L1: 72,
  L2: 168,
};

/** PROFILE_JSON fieldCodes meaning the phone never submitted the field: the image was never picked. */
const UNSUBMITTED_FIELD_CODES: ReadonlySet<string> = new Set([
  "album_not_found",
  "permission_required",
  "picker_unsupported",
]);

/**
 * Whether one field of an order counts as a platform change in the budget
 * ledger (§8.1): every order that dispatched an apply task counts, whatever
 * its final state, except fields PROFILE_JSON reported skipped or failed
 * before submitting. "uncertain" counts until a later precheck proves the
 * field unchanged and the order is settled.
 */
export function xhsOpsChangeOrderFieldCounted(
  order: Pick<XhsOpsChangeOrder, "applyTaskId">,
  field: Pick<XhsOpsChangeOrderField, "outcome" | "code">,
): boolean {
  if (!order.applyTaskId || field.outcome === "skipped") return false;
  return !(
    field.outcome === "failed" &&
    field.code !== null &&
    UNSUBMITTED_FIELD_CODES.has(field.code)
  );
}

export type XhsOpsTakeoverFieldBudgetState = {
  /** Counted changes inside the self-limit window (of XHS_TAKEOVER_CHANGE_BUDGET[field].maxChanges). */
  used: number;
  /** null = the field may change now. */
  blockedUntil: string | null;
};

/** An order whose observation is over: it observed and then completed, failed or was closed by its rollback. */
function observationFinished(
  order: Pick<XhsOpsChangeOrder, "status" | "observation">,
): boolean {
  return order.observation !== null && order.status !== "observing";
}

/**
 * §8.1 「第一个观察期内不改」: whether `field` still waits for the takeover's
 * first observation — no order in `ledger` (the other orders of the same
 * 小红书号) has finished an observation yet. Only fields flagged
 * notInFirstObservation (the nickname) wait, and a rollback never does.
 */
export function xhsOpsTakeoverAwaitsFirstObservation(
  field: XhsOpsTakeoverProfileField,
  ledger: readonly Pick<XhsOpsChangeOrder, "status" | "observation">[],
  options: { rollback?: boolean } = {},
): boolean {
  if (!XHS_TAKEOVER_CHANGE_BUDGET[field].notInFirstObservation) return false;
  if (options.rollback) return false;
  return !ledger.some(observationFinished);
}

/**
 * Why `order` may not run yet under 「第一个观察期内不改」 (§8.1), or null:
 * a non-rollback order with a notInFirstObservation field needs an earlier
 * order of its 小红书号 to have finished its observation first. `orders` may
 * hold anything; only the same account's and 小红书号's other orders count.
 */
export function xhsOpsTakeoverFirstObservationIssue(
  order: Pick<
    XhsOpsChangeOrder,
    "id" | "accountId" | "platformAccountId" | "fields" | "rollbackOfId"
  >,
  orders: readonly XhsOpsChangeOrder[],
): string | null {
  const ledger = orders.filter(
    (entry) =>
      entry.id !== order.id &&
      entry.accountId === order.accountId &&
      entry.platformAccountId === order.platformAccountId,
  );
  const waiting = order.fields.flatMap((entry) => {
    const parsed = xhsOpsTakeoverProfileFieldSchema.safeParse(entry.field);
    return parsed.success &&
      xhsOpsTakeoverAwaitsFirstObservation(parsed.data, ledger, {
        rollback: order.rollbackOfId !== null,
      })
      ? [parsed.data]
      : [];
  });
  if (waiting.length === 0) return null;
  const names = xhsOpsProfileFieldLabels(waiting);
  return `接管后的第一个观察期内不改${names}：请先让之前的一张变更单走完观察期并复查，再改${names}`;
}

/**
 * Budget state of one public field (§8.1), shared by the diagnosis
 * (budgetBlockedUntil), the precheck and the confirm dialog's 剩余预算. A
 * change counts at its order's confirmedAt, when the apply task is
 * dispatched. A rollback is exempt from the self-limit but not from the
 * platform notices; its own changes still count for later orders. A
 * nickname waiting for the first observation is blocked until that
 * observation's end, once one runs.
 */
export function xhsOpsTakeoverFieldBudgetState(
  field: XhsOpsTakeoverProfileField,
  ledger: {
    orders: readonly XhsOpsChangeOrder[];
    notices: readonly XhsOpsPlatformLimitNotice[];
  },
  now: number,
  options: { rollback?: boolean } = {},
): XhsOpsTakeoverFieldBudgetState {
  const budget = XHS_TAKEOVER_CHANGE_BUDGET[field];
  const windowMs = budget.windowDays * DAY_MS;
  const changes: number[] = [];
  for (const order of ledger.orders) {
    const at = Date.parse(order.confirmedAt ?? order.updatedAt);
    if (!Number.isFinite(at) || at + windowMs <= now) continue;
    for (const entry of order.fields) {
      if (entry.field === field && xhsOpsChangeOrderFieldCounted(order, entry))
        changes.push(at);
    }
  }
  changes.sort((a, b) => b - a);
  let until = Number.NEGATIVE_INFINITY;
  const freedBy = changes[budget.maxChanges - 1];
  if (!options.rollback && freedBy !== undefined) until = freedBy + windowMs;
  for (const notice of ledger.notices) {
    const at = Date.parse(notice.blockedUntil);
    if (notice.field === field && Number.isFinite(at) && at > now && at > until)
      until = at;
  }
  // 第一个观察期内不改: while that first observation runs, its end is the
  // earliest date to show. With none begun yet there is no date to give;
  // xhsOpsTakeoverFirstObservationIssue still refuses the order.
  if (xhsOpsTakeoverAwaitsFirstObservation(field, ledger.orders, options)) {
    for (const order of ledger.orders) {
      if (order.status !== "observing" || !order.observation) continue;
      const at = Date.parse(order.observation.until);
      if (Number.isFinite(at) && at > now && at > until) until = at;
    }
  }
  return {
    used: changes.length,
    blockedUntil: Number.isFinite(until) ? new Date(until).toISOString() : null,
  };
}

// ─── Takeover: device prerequisites (§5.2) ──────────────────────────────────

/** TabbyApp only sets RELATIVE_PATH from API 29, so the per-field album needs Android 10+. */
export const XHS_TAKEOVER_IMAGE_MIN_ANDROID = 10;

/** Decoded size cap of a change-order picture upload (§5.2 step 1). */
export const XHS_TAKEOVER_IMAGE_MAX_BYTES = 10 * 1024 * 1024;

/** The two public fields a change order changes with a picture the user supplies. */
export function xhsOpsIsTakeoverImageField(
  field: XhsOpsProfileField,
): field is "avatar" | "cover" {
  return field === "avatar" || field === "cover";
}

/**
 * Phone text compared as the page shows it: a 简介 comes back on one line
 * (§3.4: 字段值内不换行), and a region as 「中国 上海 上海」 or without the
 * spaces, so line breaks — real ones or a literal \n — and spacing do not
 * count.
 */
export function xhsOpsSameProfileText(left: string, right: string): boolean {
  const normalise = (text: string) =>
    text.replace(/\\n/g, "\n").replace(/\s+/g, "");
  return normalise(left) === normalise(right);
}

export const XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE =
  "这台手机系统版本过低，不支持自动换图";

/**
 * Why the plan confirmation drafted no image order when the bound phone
 * could not be asked for its version at all (offline, not queryable): not
 * the version's fault, and the order can still be created once it is back.
 */
export const XHS_TAKEOVER_IMAGE_PHONE_UNREACHABLE_MESSAGE =
  "确认方案时联系不上这台手机，无法确认系统版本是否为 Android 10 及以上，这项换图没有生成变更单；手机上线后可在接管卡片上手动新建";

/** Lowest SDK level tabby-control formats as an Android release (API 21 = Android 5). */
const ANDROID_FIRST_SDK = 21;
/** API 29 is Android 10. */
const ANDROID_10_SDK = 29;

/**
 * Whether the phone may take image fields (§5.2): its reported osVersion is
 * Android 10 or newer. tabby-control sends "Android 13" or "Android 12L"; a
 * bare number of 21 and up is an SDK level, a smaller one a release. A
 * missing or unreadable version is refused like an old one.
 */
export function xhsOpsDeviceSupportsTakeoverImages(
  device: { osVersion?: number | string } | null | undefined,
): boolean {
  const raw = device?.osVersion;
  const text = typeof raw === "number" ? String(raw) : (raw ?? "").trim();
  const match = /\d+/.exec(text);
  if (!match) return false;
  const value = Number(match[0]);
  const bareNumber = /^\d+$/.test(text);
  if (bareNumber && value >= ANDROID_FIRST_SDK) return value >= ANDROID_10_SDK;
  return value >= XHS_TAKEOVER_IMAGE_MIN_ANDROID;
}

/**
 * Why a takeover task may not go to this phone, or null (§5.2): every
 * mechanical gate of the phone needs an APK built with devicePolicyMode
 * enforce — audit only logs, off allows everything. A mode the phone has not
 * reported yet (before its first task) is unknown and let through, a known
 * residual risk.
 */
export function xhsOpsDevicePolicyModeIssue(
  device: { devicePolicyMode?: "off" | "audit" | "enforce" } | null | undefined,
): string | null {
  const mode = device?.devicePolicyMode;
  if (mode === undefined || mode === "enforce") return null;
  return `手机端策略模式是 ${mode}，不会拦截任何越界操作；接管账号的手机任务只在 enforce 模式下派发，请换用 enforce 构建的 TabbyApp`;
}

export type XhsOpsChangeOrderAckKey = keyof z.infer<
  typeof xhsOpsChangeOrderAcksSchema
>;

/**
 * Acks a confirmation must carry as true (§2.5): image fields need all three
 * photo acks, nickname or region the second check, and a previous order whose
 * review was warn needs warnAcknowledged. Shared so the card shows exactly the
 * boxes the server will demand.
 */
export function xhsOpsChangeOrderRequiredAcks(
  fields: readonly XhsOpsProfileField[],
  options: { previousWarn?: boolean } = {},
): XhsOpsChangeOrderAckKey[] {
  const required: XhsOpsChangeOrderAckKey[] = [];
  if (fields.some((field) => field === "avatar" || field === "cover"))
    required.push("photoPermission", "screenshotPrivacy", "cleanup");
  if (fields.some((field) => field === "nickname" || field === "region"))
    required.push("l2SecondCheck");
  if (options.previousWarn) required.push("warnAcknowledged");
  return required;
}

export function xhsOpsChangeOrderMissingAcks(
  fields: readonly XhsOpsProfileField[],
  acks: z.input<typeof xhsOpsChangeOrderAcksSchema>,
  options: { previousWarn?: boolean } = {},
): XhsOpsChangeOrderAckKey[] {
  return xhsOpsChangeOrderRequiredAcks(fields, options).filter(
    (key) => acks[key] !== true,
  );
}

/**
 * `previousWarn` of xhsOpsChangeOrderRequiredAcks (§2.5, §6.4): the newest
 * reviewed order — completed or failed with a verdict — of the same account
 * and 小红书号, `order` itself left out, ended with warn, so confirming
 * `order` needs warnAcknowledged.
 */
export function xhsOpsChangeOrderPreviousReviewWarned(
  orders: readonly XhsOpsChangeOrder[],
  order: Pick<XhsOpsChangeOrder, "id" | "accountId" | "platformAccountId">,
): boolean {
  const reviewed = orders
    .filter(
      (entry) =>
        entry.id !== order.id &&
        entry.accountId === order.accountId &&
        entry.platformAccountId === order.platformAccountId &&
        (entry.status === "completed" || entry.status === "failed") &&
        entry.observation !== null &&
        entry.observation.verdict !== "pending",
    )
    .sort((left, right) =>
      (right.confirmedAt ?? right.createdAt).localeCompare(
        left.confirmedAt ?? left.createdAt,
      ),
    );
  return reviewed[0]?.observation?.verdict === "warn";
}

/** Chinese name of each change-order status, as the card and the controller's refusals show it. */
export const XHS_TAKEOVER_CHANGE_ORDER_STATUS_LABEL: Record<
  XhsOpsChangeOrderStatus,
  string
> = {
  draft: "草案",
  prechecking: "预检中",
  awaiting_confirm: "待确认",
  applying: "执行中",
  verifying: "核验中",
  awaiting_visual_check: "待对照图片",
  awaiting_manual_check: "待人工检查",
  observing: "观察期",
  completed: "已完成",
  failed: "已失败",
  cancelled: "已取消",
  interrupted: "已中断",
};

/** Field outcomes that may have gone public (§5.2 step 6): done, verified, mismatch or uncertain. */
const CHANGED_FIELD_OUTCOMES: ReadonlySet<XhsOpsChangeOrderField["outcome"]> =
  new Set(["done", "verified", "mismatch", "uncertain"]);

/** The fields of `order` that may have gone public (§5.2 step 6). */
export function xhsOpsChangeOrderChangedFields(
  order: Pick<XhsOpsChangeOrder, "fields">,
): XhsOpsChangeOrderField[] {
  return order.fields.filter((entry) =>
    CHANGED_FIELD_OUTCOMES.has(entry.outcome),
  );
}

/** Statuses an order may be rolled back from: past its phone steps (§5.2 step 7). */
export const XHS_TAKEOVER_ROLLBACK_SOURCE_STATUSES: ReadonlySet<XhsOpsChangeOrderStatus> =
  new Set(["observing", "completed", "failed"]);

/**
 * Fields a rollback of `order` can take back (§5.2 step 7): an executed
 * (applyTaskId set) non-rollback order past its phone steps, and of it only
 * the fields that may have gone public. A text field also needs the before
 * the precheck archived; a picture always needs a new upload. Empty when the
 * order cannot be rolled back at all.
 */
export function xhsOpsChangeOrderRollbackFields(
  order: Pick<
    XhsOpsChangeOrder,
    "fields" | "status" | "applyTaskId" | "rollbackOfId"
  >,
): XhsOpsTakeoverProfileField[] {
  if (
    order.rollbackOfId !== null ||
    !order.applyTaskId ||
    !XHS_TAKEOVER_ROLLBACK_SOURCE_STATUSES.has(order.status)
  )
    return [];
  return xhsOpsChangeOrderChangedFields(order).flatMap((entry) => {
    const parsed = xhsOpsTakeoverProfileFieldSchema.safeParse(entry.field);
    if (!parsed.success) return [];
    return xhsOpsIsTakeoverImageField(parsed.data) || entry.before.trim()
      ? [parsed.data]
      : [];
  });
}

// ─── Takeover: playbook ─────────────────────────────────────────────────────

/** doc / device-verified = 技能文档, design = 本方案规则, community-unverified = 参考 (§4.5). */
export const xhsOpsPlaybookConfidenceSchema = z.enum([
  "doc",
  "device-verified",
  "design",
  "community-unverified",
]);

export const XHS_OPS_PLAYBOOK_CATEGORY: Record<
  z.infer<typeof xhsOpsPlaybookConfidenceSchema>,
  "skill_doc" | "design" | "reference"
> = {
  doc: "skill_doc",
  "device-verified": "skill_doc",
  design: "design",
  "community-unverified": "reference",
};

export const xhsOpsPlaybookRuleSchema = z.object({
  id: z.string().regex(/^[A-Z]{2,4}-\d{2}$/),
  topic: z.enum([
    "identity",
    "profile",
    "takeover",
    "nurture",
    "tone",
    "risk",
    "metrics",
  ]),
  text: z.string().min(1).max(120),
  /** References joined by 「；」: 本方案, xhs/references/<file>.md[:lines] or a nexu repo path, each with an optional （note）. */
  source: z.string().min(1).max(240),
  appliesTo: z.array(z.enum(["new", "existing"])).min(1),
  confidence: xhsOpsPlaybookConfidenceSchema,
  /** ≤40-char verbatim excerpt of the cited phone-skills file. */
  excerpt: z.string().min(1).max(40).optional(),
  /** phone-skills manifest bundleVersion the excerpt was checked against. */
  bundleVersion: z.number().int().positive().optional(),
  /** D8 sign-off by ops or product; null until signed. */
  signedOffAt: z.string().nullable(),
});

// ─── Takeover: request bodies ───────────────────────────────────────────────

export const xhsOpsTakeoverAuthorizeBodySchema = z.object({
  expectedUpdatedAt: z.string(),
  /** Card ① ownership/authorization statement; must be ticked. */
  ownershipConfirmed: z.literal(true),
  authorizationNote: z.string().trim().max(200).optional(),
});

export const xhsOpsTakeoverIdentityConfirmBodySchema = z.object({
  identityTaskId: z.string().min(1),
  platformAccountId: z.string().trim().min(1).max(80),
  /** Needed when platformAccountId differs from what the read returned. */
  overrideRead: z.boolean().optional(),
});

export const xhsOpsAuditStartBodySchema = z.object({
  noteLimit: z.number().int().min(1).max(20).default(20),
});

export const xhsOpsAuditBaselineConfirmBodySchema = z.object({
  /** Required when the audit carries a warning flag. */
  manualChecked: z.boolean().optional(),
});

export const xhsOpsDiagnosisAnswerSchema = z.object({
  /** Question id from diagnosis.questions. */
  id: z.string().min(1).max(12),
  answer: z.string().trim().min(1).max(60),
});

export const xhsOpsDiagnosisGenerateBodySchema = z.object({
  auditId: z.string().min(1),
  feedback: z.string().trim().min(1).max(300).optional(),
  answers: z.array(xhsOpsDiagnosisAnswerSchema).max(3).optional(),
});

/** Regenerate keeps the diagnosis' audit; decided items are carried over. */
export const xhsOpsDiagnosisRegenerateBodySchema =
  xhsOpsDiagnosisGenerateBodySchema.omit({ auditId: true });

export const xhsOpsDiagnosisDecisionsBodySchema = z.object({
  expectedUpdatedAt: z.string(),
  decisions: z.record(
    z.string().regex(/^P\d{1,2}$/),
    z.object({
      decision: xhsOpsDiagnosisDecisionSchema.shape.decision,
      /** Re-validated against the proposal's kind and the §4.4 filters. */
      edited: z.unknown().optional(),
    }),
  ),
});

export const xhsOpsTakeoverPlanConfirmBodySchema = z.object({
  expectedUpdatedAt: z.string(),
  /** 「全部保留，只做维护」: no change order is drafted. */
  keepAllPublic: z.boolean().optional(),
});

export const xhsOpsTakeoverPlanRevertBodySchema = z.object({
  expectedUpdatedAt: z.string(),
});

export const xhsOpsTakeoverPauseBodySchema = z.object({
  reason: z.string().trim().min(1).max(200),
});

export const xhsOpsTakeoverResumeBodySchema = z.object({
  /** Required to resume rate_limited, account_restricted or observation_failed. */
  reason: z.string().trim().min(1).max(200).optional(),
  expectedUpdatedAt: z.string(),
});

export const xhsOpsTakeoverDeviceHoldReleaseBodySchema = z.object({
  expectedUpdatedAt: z.string(),
  /** The operator confirmed on the phone that the task has ended. */
  stoppedOnPhone: z.literal(true),
});

export const xhsOpsChangeOrderCreateBodySchema = z.object({
  rollbackOfId: z.string().min(1).optional(),
  fields: z
    .array(
      z.object({
        field: xhsOpsTakeoverProfileFieldSchema,
        /** New value for a text field, direction note for an image; omitted on a rollback (the original's before). */
        after: z.string().trim().max(120).optional(),
      }),
    )
    .min(1)
    .max(2),
});

export const xhsOpsChangeOrderImageBodySchema = z.object({
  /** png, jpeg or webp; the server caps the decoded file at 10 MB. */
  dataUrl: z
    .string()
    .max(14_000_000)
    .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+=*$/),
  expectedUpdatedAt: z.string(),
});

export const xhsOpsChangeOrderPrecheckBodySchema = z.object({
  expectedUpdatedAt: z.string(),
});

export const xhsOpsChangeOrderConfirmBodySchema = z.object({
  confirmDigest: z.string().regex(/^[a-f0-9]{64}$/),
  expectedUpdatedAt: z.string(),
  acks: xhsOpsChangeOrderAcksSchema,
});

export const xhsOpsChangeOrderVisualCheckBodySchema = z.object({
  /** Each image field is checked on its own. */
  field: z.enum(["avatar", "cover"]),
  result: z.enum(["match", "mismatch"]),
  expectedUpdatedAt: z.string(),
});

export const xhsOpsChangeOrderManualCheckBodySchema = z.object({
  expectedUpdatedAt: z.string(),
});

export const xhsOpsChangeOrderVerifyBodySchema = z.object({
  expectedUpdatedAt: z.string(),
});

export const xhsOpsChangeOrderCancelBodySchema = z.object({
  expectedUpdatedAt: z.string(),
});

export const xhsOpsObservationReviewBodySchema = z.object({
  expectedUpdatedAt: z.string(),
});

// ─── Persistence root ────────────────────────────────────────────────────────

const xhsOpsStoredAccountSchema = xhsOpsAccountSchema.extend({
  // Storage-only defaults preserve pre-target accounts. New writes use 90/2.
  browseDefaults: xhsOpsBrowseDefaultsSchema
    .extend({
      dwellSecMin: xhsOpsBrowseDefaultsSchema.shape.dwellSecMin.default(10),
      dailyTargetPosts:
        xhsOpsBrowseDefaultsSchema.shape.dailyTargetPosts.default(0),
      dailySegments: xhsOpsBrowseDefaultsSchema.shape.dailySegments.default(1),
    })
    .default({}),
});

export const xhsOpsStoreDataSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  projects: z.array(xhsOpsProjectSchema).default([]),
  accounts: z.array(xhsOpsStoredAccountSchema).default([]),
  runs: z.array(xhsOpsRunSchema).default([]),
  comments: z.array(xhsOpsCommentDraftSchema).default([]),
  // Defaults matter: without them LowDB quarantines and resets older files.
  audits: z.array(xhsOpsAccountAuditSchema).default([]),
  diagnoses: z.array(xhsOpsAccountDiagnosisSchema).default([]),
  changeOrders: z.array(xhsOpsChangeOrderSchema).default([]),
});

// ─── REST response envelopes ─────────────────────────────────────────────────

export const xhsOpsProjectListResponseSchema = z.object({
  projects: z.array(xhsOpsProjectSchema),
});
export const xhsOpsProjectResponseSchema = z.object({
  project: xhsOpsProjectSchema,
});
export const xhsOpsAccountListResponseSchema = z.object({
  accounts: z.array(xhsOpsAccountSchema),
});
export const xhsOpsAccountResponseSchema = z.object({
  account: xhsOpsAccountSchema,
});
export const xhsOpsRunListResponseSchema = z.object({
  runs: z.array(xhsOpsRunSchema),
});
export const xhsOpsRunResponseSchema = z.object({ run: xhsOpsRunSchema });

/**
 * An event a takeover response hands the card, which forwards it to the agent
 * through onAction like every other xhs_ops_* event. The payload is built by
 * xhs-ops-takeover-events.ts and never carries the 小红书号, the birthday, the
 * region or a profile field value (D6); the card passes it on unread.
 */
export const xhsOpsTakeoverEventSchema = z.object({
  name: z.enum([
    "xhs_ops_takeover_identity_locked",
    "xhs_ops_account_audited",
    "xhs_ops_account_diagnosed",
    "xhs_ops_takeover_plan_confirmed",
    "xhs_ops_change_order_finished",
  ]),
  payload: z.record(z.string(), z.unknown()),
});

export const xhsOpsAuditResponseSchema = z.object({
  audit: xhsOpsAccountAuditSchema,
});
export const xhsOpsAuditListResponseSchema = z.object({
  audits: z.array(xhsOpsAccountAuditSchema),
});
/** Baseline confirmation also moves the account's takeover pointers. */
export const xhsOpsAuditBaselineResponseSchema = z.object({
  account: xhsOpsAccountSchema,
  audit: xhsOpsAccountAuditSchema,
  /** xhs_ops_account_audited with baseline: true (T4). */
  event: xhsOpsTakeoverEventSchema,
});
export const xhsOpsTakeoverIdentityReadResponseSchema = z.object({
  identity: xhsOpsAccountIdentityResponseSchema,
  /** pendingIdentity was written, so the card needs the new updatedAt. */
  account: xhsOpsAccountSchema,
});
export const xhsOpsTakeoverIdentityConfirmResponseSchema = z.object({
  account: xhsOpsAccountSchema,
  /** xhs_ops_takeover_identity_locked (T2), without the 小红书号. */
  event: xhsOpsTakeoverEventSchema,
});
/** Generate, regenerate and decisions: the record as stored. */
export const xhsOpsDiagnosisResponseSchema = z.object({
  diagnosis: xhsOpsAccountDiagnosisSchema,
});
/** GET of one diagnosis: plus xhs_ops_account_diagnosed once it settled at ready or failed (T5). */
export const xhsOpsDiagnosisViewResponseSchema = z.object({
  diagnosis: xhsOpsAccountDiagnosisSchema,
  event: xhsOpsTakeoverEventSchema.nullable(),
});
/** Plan confirm: the account, the diagnosis and the account's change orders afterwards. */
export const xhsOpsTakeoverPlanResponseSchema = z.object({
  account: xhsOpsAccountSchema,
  diagnosis: xhsOpsAccountDiagnosisSchema,
  changeOrders: z.array(xhsOpsChangeOrderSchema),
  skippedFields: z.array(xhsOpsTakeoverSkippedFieldSchema),
  /** xhs_ops_takeover_plan_confirmed (T6). */
  event: xhsOpsTakeoverEventSchema,
});
/** Plan revert: the active diagnosis is null when none is left. */
export const xhsOpsTakeoverPlanRevertResponseSchema = z.object({
  account: xhsOpsAccountSchema,
  diagnosis: xhsOpsAccountDiagnosisSchema.nullable(),
  changeOrders: z.array(xhsOpsChangeOrderSchema),
});
/** The identity gate 「恢复」 ran (§6.5); fixed controller text, never phone output. */
export const xhsOpsTakeoverGateResultSchema = z.object({
  status: z.enum(["ready", "blocked", "failed"]),
  code: xhsOpsPreparationCodeSchema,
  reason: z.string(),
  taskId: z.string().nullable(),
});
export const xhsOpsTakeoverResumeResponseSchema = z.object({
  account: xhsOpsAccountSchema,
  /** false: the gate did not report ready and the pause stays (gate.reason says why). */
  resumed: z.boolean(),
  /** null when the pause needed no gate (rate_limited, account_restricted). */
  gate: xhsOpsTakeoverGateResultSchema.nullable(),
});
/** GET of one change order. */
export const xhsOpsChangeOrderResponseSchema = z.object({
  order: xhsOpsChangeOrderSchema,
  /**
   * xhs_ops_change_order_finished once the order is observing (until its
   * review starts), completed, failed or cancelled (T8); null before.
   */
  event: xhsOpsTakeoverEventSchema.nullable(),
});
export const xhsOpsChangeOrderListResponseSchema = z.object({
  orders: z.array(xhsOpsChangeOrderSchema),
});
/** Change-order transitions also touch takeover fields (activeChangeOrderId, observationUntil, safetyPause). */
export const xhsOpsChangeOrderActionResponseSchema = z.object({
  order: xhsOpsChangeOrderSchema,
  account: xhsOpsAccountSchema,
  /** As in xhsOpsChangeOrderResponseSchema. */
  event: xhsOpsTakeoverEventSchema.nullable(),
});
export const xhsOpsPlaybookResponseSchema = z.object({
  version: z.string(),
  /** PHONE_SKILLS_BUNDLE: the phone-skills bundle the doc rules were checked against (§4.5). */
  bundleVersion: z.number().int().positive(),
  rules: z.array(xhsOpsPlaybookRuleSchema),
});

// ─── Types ───────────────────────────────────────────────────────────────────

export type XhsOpsInteractionRule = z.infer<typeof xhsOpsInteractionRuleSchema>;
export type XhsOpsInteractionConfig = z.infer<
  typeof xhsOpsInteractionConfigSchema
>;
export type XhsOpsBrowseDefaults = z.infer<typeof xhsOpsBrowseDefaultsSchema>;
export type XhsOpsProjectBusiness = z.infer<typeof xhsOpsProjectBusinessSchema>;
export type XhsOpsProjectAudience = z.infer<typeof xhsOpsProjectAudienceSchema>;
export type XhsOpsProjectOpsNotes = z.infer<typeof xhsOpsProjectOpsNotesSchema>;
export type XhsOpsProfile = z.infer<typeof xhsOpsProfileSchema>;
export type XhsOpsProject = z.infer<typeof xhsOpsProjectSchema>;
export type XhsOpsProjectCreate = z.infer<typeof xhsOpsProjectCreateSchema>;
export type XhsOpsProjectCreateInput = z.input<
  typeof xhsOpsProjectCreateSchema
>;
export type XhsOpsProjectUpdate = z.infer<typeof xhsOpsProjectUpdateSchema>;
export type XhsOpsProjectUpdateInput = z.input<
  typeof xhsOpsProjectUpdateSchema
>;
export type XhsOpsInterestPool = z.infer<typeof xhsOpsInterestPoolSchema>;
export type XhsOpsPersonaTags = z.infer<typeof xhsOpsPersonaTagsSchema>;
export type XhsOpsPersonaSuggestion = z.infer<
  typeof xhsOpsPersonaSuggestionSchema
>;
export type XhsOpsAccount = z.infer<typeof xhsOpsAccountSchema>;
export type XhsOpsAccountCreate = z.infer<typeof xhsOpsAccountCreateSchema>;
export type XhsOpsAccountCreateInput = z.input<
  typeof xhsOpsAccountCreateSchema
>;
export type XhsOpsAccountUpdate = z.infer<typeof xhsOpsAccountUpdateSchema>;
export type XhsOpsAccountUpdateInput = z.input<
  typeof xhsOpsAccountUpdateSchema
>;
export type XhsOpsDeviceBinding = z.infer<typeof xhsOpsDeviceBindingSchema>;
export type XhsOpsAccountTransferInput = z.input<
  typeof xhsOpsAccountTransferSchema
>;
export type XhsOpsAnomalyType = z.infer<typeof xhsOpsAnomalyTypeSchema>;
export type XhsOpsAnomaly = z.infer<typeof xhsOpsAnomalySchema>;
export type XhsOpsInteractionCounts = z.infer<
  typeof xhsOpsInteractionCountsSchema
>;
export type XhsOpsRunChunkMode = z.infer<typeof xhsOpsRunChunkModeSchema>;
export type XhsOpsRunChunkStatus = z.infer<typeof xhsOpsRunChunkStatusSchema>;
export type XhsOpsRunPostAction = z.infer<typeof xhsOpsRunPostActionSchema>;
export type XhsOpsRunPost = z.infer<typeof xhsOpsRunPostSchema>;
export type XhsOpsRunChunk = z.infer<typeof xhsOpsRunChunkSchema>;
export type XhsOpsRunPlanKeyword = z.infer<typeof xhsOpsRunPlanKeywordSchema>;
export type XhsOpsRunPlan = z.infer<typeof xhsOpsRunPlanSchema>;
export type XhsOpsRunPlanInput = z.input<typeof xhsOpsRunPlanSchema>;
export type XhsOpsRunSummary = z.infer<typeof xhsOpsRunSummarySchema>;
export type XhsOpsRunStatus = z.infer<typeof xhsOpsRunStatusSchema>;
export type XhsOpsRunSegment = z.infer<typeof xhsOpsRunSegmentSchema>;
export type XhsOpsRunPlanComment = z.infer<typeof xhsOpsRunPlanCommentSchema>;
export type XhsOpsSchedule = z.infer<typeof xhsOpsScheduleSchema>;
export type XhsOpsCommentRule = z.infer<typeof xhsOpsCommentRuleSchema>;
export type XhsOpsCommentStatus = z.infer<typeof xhsOpsCommentStatusSchema>;
export type XhsOpsCommentDraft = z.infer<typeof xhsOpsCommentDraftSchema>;
export type XhsOpsCommentGenerateBody = z.infer<
  typeof xhsOpsCommentGenerateBodySchema
>;
export type XhsOpsCommentReviewBody = z.infer<
  typeof xhsOpsCommentReviewBodySchema
>;
export type XhsOpsCommentListQuery = z.infer<
  typeof xhsOpsCommentListQuerySchema
>;
export type XhsOpsCommentQuota = z.infer<typeof xhsOpsCommentQuotaSchema>;
export type XhsOpsRun = z.infer<typeof xhsOpsRunSchema>;
export type XhsOpsPreparation = z.infer<typeof xhsOpsPreparationSchema>;
export type XhsOpsPreparationCode = z.infer<typeof xhsOpsPreparationCodeSchema>;
export type XhsOpsRunCreate = z.infer<typeof xhsOpsRunCreateSchema>;
export type XhsOpsRunCreateInput = z.input<typeof xhsOpsRunCreateSchema>;
export type XhsOpsRunUpdate = z.infer<typeof xhsOpsRunUpdateSchema>;
export type XhsOpsRunListQuery = z.infer<typeof xhsOpsRunListQuerySchema>;
export type XhsOpsStoreData = z.infer<typeof xhsOpsStoreDataSchema>;
export type XhsOpsProjectListResponse = z.infer<
  typeof xhsOpsProjectListResponseSchema
>;
export type XhsOpsProjectResponse = z.infer<typeof xhsOpsProjectResponseSchema>;
export type XhsOpsAccountListResponse = z.infer<
  typeof xhsOpsAccountListResponseSchema
>;
export type XhsOpsAccountResponse = z.infer<typeof xhsOpsAccountResponseSchema>;
export type XhsOpsRunListResponse = z.infer<typeof xhsOpsRunListResponseSchema>;
export type XhsOpsRunResponse = z.infer<typeof xhsOpsRunResponseSchema>;

export type XhsOpsPlanSuggestion = z.infer<typeof xhsOpsPlanSuggestionSchema>;
export type XhsOpsPlanSkip = z.infer<typeof xhsOpsPlanSkipSchema>;
export type XhsOpsProfileDraft = z.infer<typeof xhsOpsProfileDraftSchema>;
export type XhsOpsProfilePart = z.infer<typeof xhsOpsProfilePartSchema>;
export type XhsOpsProfileApplyStatus = z.infer<
  typeof xhsOpsProfileApplyStatusSchema
>;
export type XhsOpsProfileApplyOperation = z.infer<
  typeof xhsOpsProfileApplyOperationSchema
>;

export type XhsOpsCount = z.infer<typeof xhsOpsCountSchema>;
export type XhsOpsMaturityTier = z.infer<typeof xhsOpsMaturityTierSchema>;
export type XhsOpsSafetyPause = z.infer<typeof xhsOpsSafetyPauseSchema>;
export type XhsOpsPlatformLimitNotice = z.infer<
  typeof xhsOpsPlatformLimitNoticeSchema
>;
export type XhsOpsToneGuide = z.infer<typeof xhsOpsToneGuideSchema>;
export type XhsOpsTakeoverPlanSnapshot = z.infer<
  typeof xhsOpsTakeoverPlanSnapshotSchema
>;
export type XhsOpsTakeover = z.infer<typeof xhsOpsTakeoverSchema>;
export type XhsOpsTakeoverStage = z.infer<typeof xhsOpsTakeoverStageSchema>;
export type XhsOpsHeaderCounts = z.infer<typeof xhsOpsHeaderCountsSchema>;
export type XhsOpsAuditEvidence = z.infer<typeof xhsOpsAuditEvidenceSchema>;
export type XhsOpsAuditPartStatus = z.infer<typeof xhsOpsAuditPartStatusSchema>;
export type XhsOpsAuditNoteCard = z.infer<typeof xhsOpsAuditNoteCardSchema>;
export type XhsOpsAuditFlag = z.infer<typeof xhsOpsAuditFlagSchema>;
export type XhsOpsAccountAudit = z.infer<typeof xhsOpsAccountAuditSchema>;
export type XhsOpsAccountFacts = z.infer<typeof xhsOpsAccountFactsSchema>;
export type XhsOpsFinding = z.infer<typeof xhsOpsFindingSchema>;
export type XhsOpsProposal = z.infer<typeof xhsOpsProposalSchema>;
export type XhsOpsProposalKind = XhsOpsProposal["kind"];
export type XhsOpsProposalRisk = z.infer<typeof xhsOpsProposalRiskSchema>;
export type XhsOpsDiagnosisProposal = z.infer<
  typeof xhsOpsDiagnosisProposalSchema
>;
export type XhsOpsDiagnosisDecision = z.infer<
  typeof xhsOpsDiagnosisDecisionSchema
>;
export type XhsOpsAccountDiagnosis = z.infer<
  typeof xhsOpsAccountDiagnosisSchema
>;
export type XhsOpsChangeOrderAcks = z.infer<typeof xhsOpsChangeOrderAcksSchema>;
export type XhsOpsChangeOrderVisualCheck = z.infer<
  typeof xhsOpsChangeOrderVisualCheckSchema
>;
export type XhsOpsChangeOrderFlag = z.infer<typeof xhsOpsChangeOrderFlagSchema>;
export type XhsOpsChangeOrderStatus = z.infer<
  typeof xhsOpsChangeOrderStatusSchema
>;
export type XhsOpsChangeOrder = z.infer<typeof xhsOpsChangeOrderSchema>;
export type XhsOpsChangeOrderField = XhsOpsChangeOrder["fields"][number];
export type XhsOpsPlaybookConfidence = z.infer<
  typeof xhsOpsPlaybookConfidenceSchema
>;
export type XhsOpsPlaybookRule = z.infer<typeof xhsOpsPlaybookRuleSchema>;
export type XhsOpsTakeoverAuthorizeBody = z.infer<
  typeof xhsOpsTakeoverAuthorizeBodySchema
>;
export type XhsOpsTakeoverIdentityConfirmBody = z.infer<
  typeof xhsOpsTakeoverIdentityConfirmBodySchema
>;
export type XhsOpsAuditStartBody = z.infer<typeof xhsOpsAuditStartBodySchema>;
export type XhsOpsAuditBaselineConfirmBody = z.infer<
  typeof xhsOpsAuditBaselineConfirmBodySchema
>;
export type XhsOpsDiagnosisGenerateBody = z.infer<
  typeof xhsOpsDiagnosisGenerateBodySchema
>;
export type XhsOpsDiagnosisRegenerateBody = z.infer<
  typeof xhsOpsDiagnosisRegenerateBodySchema
>;
export type XhsOpsDiagnosisDecisionsBody = z.infer<
  typeof xhsOpsDiagnosisDecisionsBodySchema
>;
export type XhsOpsTakeoverPlanConfirmBody = z.infer<
  typeof xhsOpsTakeoverPlanConfirmBodySchema
>;
export type XhsOpsTakeoverPlanRevertBody = z.infer<
  typeof xhsOpsTakeoverPlanRevertBodySchema
>;
export type XhsOpsTakeoverPauseBody = z.infer<
  typeof xhsOpsTakeoverPauseBodySchema
>;
export type XhsOpsTakeoverResumeBody = z.infer<
  typeof xhsOpsTakeoverResumeBodySchema
>;
export type XhsOpsTakeoverDeviceHoldReleaseBody = z.infer<
  typeof xhsOpsTakeoverDeviceHoldReleaseBodySchema
>;
export type XhsOpsChangeOrderCreateBody = z.infer<
  typeof xhsOpsChangeOrderCreateBodySchema
>;
export type XhsOpsChangeOrderImageBody = z.infer<
  typeof xhsOpsChangeOrderImageBodySchema
>;
export type XhsOpsChangeOrderPrecheckBody = z.infer<
  typeof xhsOpsChangeOrderPrecheckBodySchema
>;
export type XhsOpsChangeOrderConfirmBody = z.infer<
  typeof xhsOpsChangeOrderConfirmBodySchema
>;
export type XhsOpsChangeOrderVisualCheckBody = z.infer<
  typeof xhsOpsChangeOrderVisualCheckBodySchema
>;
export type XhsOpsChangeOrderManualCheckBody = z.infer<
  typeof xhsOpsChangeOrderManualCheckBodySchema
>;
export type XhsOpsChangeOrderVerifyBody = z.infer<
  typeof xhsOpsChangeOrderVerifyBodySchema
>;
export type XhsOpsChangeOrderCancelBody = z.infer<
  typeof xhsOpsChangeOrderCancelBodySchema
>;
export type XhsOpsObservationReviewBody = z.infer<
  typeof xhsOpsObservationReviewBodySchema
>;
export type XhsOpsAuditResponse = z.infer<typeof xhsOpsAuditResponseSchema>;
export type XhsOpsAuditListResponse = z.infer<
  typeof xhsOpsAuditListResponseSchema
>;
export type XhsOpsDiagnosisResponse = z.infer<
  typeof xhsOpsDiagnosisResponseSchema
>;
export type XhsOpsTakeoverPlanResponse = z.infer<
  typeof xhsOpsTakeoverPlanResponseSchema
>;
export type XhsOpsChangeOrderResponse = z.infer<
  typeof xhsOpsChangeOrderResponseSchema
>;
export type XhsOpsChangeOrderListResponse = z.infer<
  typeof xhsOpsChangeOrderListResponseSchema
>;
export type XhsOpsChangeOrderActionResponse = z.infer<
  typeof xhsOpsChangeOrderActionResponseSchema
>;
export type XhsOpsPlaybookResponse = z.infer<
  typeof xhsOpsPlaybookResponseSchema
>;
export type XhsOpsTakeoverEvent = z.infer<typeof xhsOpsTakeoverEventSchema>;
export type XhsOpsTakeoverGateResult = z.infer<
  typeof xhsOpsTakeoverGateResultSchema
>;
export type XhsOpsTakeoverResumeResponse = z.infer<
  typeof xhsOpsTakeoverResumeResponseSchema
>;
