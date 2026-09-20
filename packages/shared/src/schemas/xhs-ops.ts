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
});

export const xhsOpsProfileDraftSchema = z.object({
  nickname: text(),
  /** 星座+MBTI / 自我介绍 / 兴趣介绍 三段，≤100 字 */
  bio: text(),
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
  avatar: "头像",
  cover: "背景图",
  gender: "性别",
  birthday: "生日",
  region: "地区",
};

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
  fields: z.array(xhsOpsProfileFieldSchema).min(1).max(7).optional(),
});

export const xhsOpsProfileGenerateBodySchema = z.object({
  parts: z.array(xhsOpsProfilePartSchema).min(1).max(3),
  /** Operator direction appended to the built avatar prompt. */
  avatarPrompt: z.string().trim().max(200).optional(),
  /** Operator direction appended to the built cover prompt. */
  coverPrompt: z.string().trim().max(200).optional(),
});

export const xhsOpsAccountSchema = z.object({
  id: z.string(),
  projectId: z.string(),
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
  })
  .extend({ profileDraft: xhsOpsProfileDraftWriteSchema.default({}) });

/** An account never moves between projects, so `projectId` is not patchable. */
export const xhsOpsAccountUpdateSchema = xhsOpsAccountCreateSchema
  .omit({ projectId: true })
  .partial()
  .extend({
    profileDraft: xhsOpsProfileDraftWriteSchema.optional(),
    expectedUpdatedAt: z.string().optional(),
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

/** Checked again immediately before dispatch; draft confirmation alone is not a phone setup receipt. */
export function xhsOpsAccountNurtureIssues(
  account: z.infer<typeof xhsOpsAccountSchema>,
  project: z.infer<typeof xhsOpsProjectSchema> | null,
): string[] {
  const issues = xhsOpsPersonaIssues(account);
  if (!project?.profile?.confirmedAt) issues.unshift("请先确认目标用户画像");
  if (!account.personaReviewedAt)
    issues.push("人设或目标画像已变化，请重新核对并确认人设");
  if (!xhsOpsProfileDraftReady(account.profileDraft))
    issues.push("请先完成八项账号资料与素材并校验确认");
  const draft = account.profileDraft;
  if (draft.applyOperation?.status === "running")
    issues.push("资料应用任务仍在执行或等待手机状态核验");
  if (
    !account.platformAccountId.trim() ||
    draft.applyStatus !== "applied" ||
    !draft.appliedAt ||
    !draft.verifiedAt ||
    !draft.verificationTaskId ||
    draft.verifiedAccountId !== account.platformAccountId
  )
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

export const xhsOpsPlanSuggestResponseSchema = z.object({
  plans: z.array(xhsOpsPlanSuggestionSchema),
});

export const xhsOpsRunListQuerySchema = z.object({
  projectId: z.string().optional(),
  accountId: z.string().optional(),
  date: xhsOpsDateSchema.optional(),
});

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
export type XhsOpsProfileDraft = z.infer<typeof xhsOpsProfileDraftSchema>;
export type XhsOpsProfilePart = z.infer<typeof xhsOpsProfilePartSchema>;
export type XhsOpsProfileApplyStatus = z.infer<
  typeof xhsOpsProfileApplyStatusSchema
>;
export type XhsOpsProfileApplyOperation = z.infer<
  typeof xhsOpsProfileApplyOperationSchema
>;
