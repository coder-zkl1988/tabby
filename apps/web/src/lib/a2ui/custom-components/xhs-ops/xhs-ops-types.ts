/**
 * Runtime and request types come from the shared Zod schemas. The API adapter
 * uses the generated OpenAPI functions, so this file only owns UI helpers.
 */
import {
  XHS_OCCUPATION_GROUPS,
  XHS_PROFILE_CANDIDATES,
  XHS_PROFILE_FIELD_LABEL,
  xhsOpsProfileCandidatePlan,
  xhsOpsProfileDraftMissingFields,
  xhsOpsProfileDraftReady,
} from "@nexu/shared";
import type {
  XhsOpsAccount,
  XhsOpsAccountCreateInput,
  XhsOpsAccountIdentity,
  XhsOpsAccountUpdateInput,
  XhsOpsAnomaly,
  XhsOpsAnomalyType,
  XhsOpsProjectAudience as XhsOpsAudience,
  XhsOpsBrowseDefaults,
  XhsOpsProjectBusiness as XhsOpsBusiness,
  XhsOpsRunChunkMode as XhsOpsChunkMode,
  XhsOpsRunChunkStatus as XhsOpsChunkStatus,
  XhsOpsCommentDraft,
  XhsOpsCommentQuota,
  XhsOpsCommentRule,
  XhsOpsCommentStatus,
  XhsOpsInteractionConfig,
  XhsOpsInteractionCounts,
  XhsOpsInteractionRule,
  XhsOpsInterestPool,
  XhsOpsProjectOpsNotes as XhsOpsOpsNotes,
  XhsOpsPersonaSuggestion,
  XhsOpsPersonaTags,
  XhsOpsPlanSuggestion,
  XhsOpsProfile,
  XhsOpsProfileApplyOperation,
  XhsOpsProfileApplyStatus,
  XhsOpsProfileDraft,
  XhsOpsProfileDraftRequiredField,
  XhsOpsProfileField,
  XhsOpsProfileFieldDiff,
  XhsOpsProfilePart,
  XhsOpsProfileReadback,
  XhsOpsProject,
  XhsOpsProjectCreateInput,
  XhsOpsProjectUpdateInput,
  XhsOpsRun,
  XhsOpsRunChunk,
  XhsOpsRunPost as XhsOpsRunChunkPost,
  XhsOpsRunCreateInput,
  XhsOpsRunPlanKeyword as XhsOpsRunKeyword,
  XhsOpsRunListQuery as XhsOpsRunListFilter,
  XhsOpsRunPlan,
  XhsOpsRunPlanComment,
  XhsOpsRunSegment,
  XhsOpsRunStatus,
  XhsOpsRunSummary,
  XhsOpsRunUpdate,
  XhsOpsSchedule,
} from "@nexu/shared";

export {
  XHS_OCCUPATION_GROUPS,
  XHS_PROFILE_CANDIDATES,
  XHS_PROFILE_FIELD_LABEL,
  xhsOpsProfileCandidatePlan,
  xhsOpsProfileDraftMissingFields,
  xhsOpsProfileDraftReady,
};

export type {
  XhsOpsAccount,
  XhsOpsAccountIdentity,
  XhsOpsProfileField,
  XhsOpsProfileFieldDiff,
  XhsOpsProfileReadback,
  XhsOpsAccountCreateInput,
  XhsOpsAccountUpdateInput,
  XhsOpsAnomaly,
  XhsOpsAnomalyType,
  XhsOpsAudience,
  XhsOpsBrowseDefaults,
  XhsOpsBusiness,
  XhsOpsChunkMode,
  XhsOpsChunkStatus,
  XhsOpsCommentDraft,
  XhsOpsCommentQuota,
  XhsOpsCommentRule,
  XhsOpsCommentStatus,
  XhsOpsInteractionConfig,
  XhsOpsInteractionCounts,
  XhsOpsInteractionRule,
  XhsOpsInterestPool,
  XhsOpsOpsNotes,
  XhsOpsPlanSuggestion,
  XhsOpsPersonaSuggestion,
  XhsOpsPersonaTags,
  XhsOpsProfile,
  XhsOpsProfileApplyStatus,
  XhsOpsProfileDraft,
  XhsOpsProfileDraftRequiredField,
  XhsOpsProfilePart,
  XhsOpsProject,
  XhsOpsProjectCreateInput,
  XhsOpsProjectUpdateInput,
  XhsOpsRun,
  XhsOpsRunCreateInput,
  XhsOpsRunChunk,
  XhsOpsRunChunkPost,
  XhsOpsRunKeyword,
  XhsOpsRunPlan,
  XhsOpsRunPlanComment,
  XhsOpsRunSegment,
  XhsOpsRunListFilter,
  XhsOpsRunStatus,
  XhsOpsRunSummary,
  XhsOpsSchedule,
};

export type XhsOpsProfileBase = XhsOpsProfile["base"];
export type XhsOpsPersona = XhsOpsAccount["persona"];
/** Local form value: shared output shape, before the server stamps updatedAt. */
export type XhsOpsProfileInput = Omit<XhsOpsProfile, "updatedAt"> & {
  updatedAt?: string;
};
export type XhsOpsRunUpdateInput = XhsOpsRunUpdate;

// ── Defaults (mirror the zod .default() values) ───────────────

export function defaultInteractionConfig(): XhsOpsInteractionConfig {
  return {
    like: { enabled: true, dailyCap: 5, ratioPercent: 10 },
    collect: { enabled: false, dailyCap: 2, ratioPercent: 3 },
    follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
    comment: { enabled: false, dailyCap: 2 },
  };
}

export function defaultBrowseDefaults(): XhsOpsBrowseDefaults {
  return {
    dwellSecMin: 11,
    dwellSecMax: 25,
    searchRatioPercent: 80,
    postsPerKeyword: 5,
    homeFeedCount: 6,
    dailyTargetPosts: 90,
    dailySegments: 2,
  };
}

export function emptyBusiness(): XhsOpsBusiness {
  return {
    industry: "",
    product: "",
    regions: [],
    sellingPoints: [],
    priceBand: "",
    scene: "",
  };
}

export function emptyAudience(): XhsOpsAudience {
  return {
    ageRange: "",
    genderRatio: "",
    regions: [],
    occupations: [],
    spendingPower: "",
    knownInterests: [],
    painPoints: [],
  };
}

export function emptyOpsNotes(): XhsOpsOpsNotes {
  return { forbiddenTopics: [], boostKeywords: [], avoidContentTypes: [] };
}

export function emptyInterestPool(): XhsOpsInterestPool {
  return { core: [], extended: [], general: [] };
}

export function emptyPersonaTags(): XhsOpsPersonaTags {
  return { vertical: [], general: [] };
}

export function emptyInteractionCounts(): XhsOpsInteractionCounts {
  return { like: 0, collect: 0, follow: 0 };
}

/** A run that is still owned by the executor (progress may still change). */
export function isRunActive(status: XhsOpsRunStatus | undefined): boolean {
  return status === "planned" || status === "running";
}

// ── Loose-input normalizers ───────────────────────────────────
// A2UI props arrive from the model: strings may be missing, arrays may be
// strings, numbers may be strings. These coerce to the contract shapes so the
// components never throw on a partially-filled payload.

export function asString(value: unknown, fallback = ""): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return fallback;
}

export function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .map((item) => asString(item).trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string") {
    return value
      .split(/[,，、\n]/)
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  return [];
}

export function asInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, Math.round(n)));
}

export function asBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === "boolean") return value;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function normalizeBusiness(value: unknown): XhsOpsBusiness {
  const v = asRecord(value);
  return {
    industry: asString(v.industry),
    product: asString(v.product),
    regions: asStringArray(v.regions),
    sellingPoints: asStringArray(v.sellingPoints),
    priceBand: asString(v.priceBand),
    scene: asString(v.scene),
  };
}

export function normalizeAudience(value: unknown): XhsOpsAudience {
  const v = asRecord(value);
  return {
    ageRange: asString(v.ageRange),
    genderRatio: asString(v.genderRatio),
    regions: asStringArray(v.regions),
    occupations: asStringArray(v.occupations),
    spendingPower: asString(v.spendingPower),
    knownInterests: asStringArray(v.knownInterests),
    painPoints: asStringArray(v.painPoints),
  };
}

export function normalizeOpsNotes(value: unknown): XhsOpsOpsNotes {
  const v = asRecord(value);
  return {
    forbiddenTopics: asStringArray(v.forbiddenTopics),
    boostKeywords: asStringArray(v.boostKeywords),
    avoidContentTypes: asStringArray(v.avoidContentTypes),
  };
}

export function normalizeProfileInput(value: unknown): XhsOpsProfileInput {
  const v = asRecord(value);
  const base = asRecord(v.base);
  return {
    summary: asString(v.summary),
    base: {
      ageRange: asString(base.ageRange),
      genderRatio: asString(base.genderRatio),
      regions: asStringArray(base.regions),
    },
    verticalInterests: asStringArray(v.verticalInterests),
    generalInterests: asStringArray(v.generalInterests),
    confirmedAt:
      typeof v.confirmedAt === "string" ? (v.confirmedAt as string) : null,
  };
}

export function normalizeInterestPool(value: unknown): XhsOpsInterestPool {
  const v = asRecord(value);
  return {
    core: asStringArray(v.core),
    extended: asStringArray(v.extended),
    general: asStringArray(v.general),
  };
}

export function normalizePersonaTags(value: unknown): XhsOpsPersonaTags {
  const v = asRecord(value);
  return {
    vertical: asStringArray(v.vertical),
    general: asStringArray(v.general),
  };
}

function normalizeRule(
  value: unknown,
  fallback: XhsOpsInteractionRule,
): XhsOpsInteractionRule {
  const v = asRecord(value);
  return {
    enabled: asBoolean(v.enabled, fallback.enabled),
    dailyCap: asInt(v.dailyCap, fallback.dailyCap, 0, 50),
    ratioPercent: asInt(v.ratioPercent, fallback.ratioPercent, 0, 100),
    targetTypes: asStringArray(v.targetTypes ?? fallback.targetTypes),
  };
}

export function normalizeInteractionConfig(
  value: unknown,
): XhsOpsInteractionConfig {
  const v = asRecord(value);
  const d = defaultInteractionConfig();
  return {
    like: normalizeRule(v.like, d.like),
    collect: normalizeRule(v.collect, d.collect),
    follow: normalizeRule(v.follow, d.follow),
    comment: normalizeCommentRule(v.comment, d.comment),
  };
}

export function normalizeCommentRule(
  value: unknown,
  fallback: XhsOpsCommentRule = { enabled: false, dailyCap: 2 },
): XhsOpsCommentRule {
  const v = asRecord(value);
  return {
    enabled: asBoolean(v.enabled, fallback.enabled),
    dailyCap: asInt(v.dailyCap, fallback.dailyCap, 0, 5),
  };
}

export function normalizeBrowseDefaults(value: unknown): XhsOpsBrowseDefaults {
  const v = asRecord(value);
  const d = defaultBrowseDefaults();
  const dwellSecMin = asInt(v.dwellSecMin, d.dwellSecMin, 5, 60);
  const dwellSecMax = Math.max(
    dwellSecMin,
    asInt(v.dwellSecMax, d.dwellSecMax, 5, 120),
  );
  return {
    dwellSecMin,
    dwellSecMax,
    searchRatioPercent: asInt(
      v.searchRatioPercent,
      d.searchRatioPercent,
      0,
      100,
    ),
    postsPerKeyword: asInt(v.postsPerKeyword, d.postsPerKeyword, 1, 8),
    homeFeedCount: asInt(v.homeFeedCount, d.homeFeedCount, 0, 12),
    dailyTargetPosts: asInt(v.dailyTargetPosts, d.dailyTargetPosts, 0, 150),
    dailySegments: asInt(v.dailySegments, d.dailySegments, 1, 3),
  };
}

export function defaultSchedule(): XhsOpsSchedule {
  return {
    enabled: false,
    time: "10:00",
    lastTriggeredDate: null,
    lastResult: null,
  };
}

export function normalizeSchedule(value: unknown): XhsOpsSchedule {
  const v = asRecord(value);
  const d = defaultSchedule();
  const time = asString(v.time).trim();
  return {
    enabled: asBoolean(v.enabled, d.enabled),
    time: /^([01]\d|2[0-3]):[0-5]\d$/.test(time) ? time : d.time,
    lastTriggeredDate:
      typeof v.lastTriggeredDate === "string" ? v.lastTriggeredDate : null,
    lastResult: typeof v.lastResult === "string" ? v.lastResult : null,
  };
}

/** 排队中的 run：planned 且记着排在谁后面。 */
export function isRunQueued(
  run: Pick<XhsOpsRun, "status" | "queuedBehindRunId"> | null | undefined,
): boolean {
  return Boolean(run && run.status === "planned" && run.queuedBehindRunId);
}

export function normalizeRunSegment(value: unknown): XhsOpsRunSegment | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  const count = asInt(v.count, 0, 0, 3);
  const index = asInt(v.index, 0, 0, 3);
  if (count < 1 || index < 1 || index > count) return null;
  return { index, count };
}

export function segmentLabel(
  segment: XhsOpsRunSegment | null | undefined,
): string {
  return segment && segment.count > 1
    ? `第 ${segment.index}/${segment.count} 段`
    : "";
}

export function emptyPersona(): XhsOpsPersona {
  return { age: "", gender: "", region: "", occupation: "", lifeStatus: "" };
}

export function normalizePersona(value: unknown): XhsOpsPersona {
  const v = asRecord(value);
  return {
    age: asString(v.age).trim().slice(0, 20),
    gender: asString(v.gender).trim().slice(0, 10),
    region: asString(v.region).trim().slice(0, 40),
    occupation: asString(v.occupation).trim().slice(0, 40),
    lifeStatus: asString(v.lifeStatus).trim().slice(0, 60),
  };
}

/** "32岁·女·北京海淀·互联网产品经理·2岁娃新手妈妈"；全空返回 ""。 */
export function personaSummary(p: XhsOpsPersona | null | undefined): string {
  if (!p) return "";
  return [p.age, p.gender, p.region, p.occupation, p.lifeStatus]
    .map((x) => (x ?? "").trim())
    .filter((x) => x.length > 0)
    .join("·");
}

// ─── 人设差异检查（P1-3）────────────────────────────────────────────────────

export interface PersonaOverlapInput {
  key: string;
  label: string;
  persona: XhsOpsPersona;
  personaTags?: XhsOpsPersonaTags;
  interestPool: XhsOpsInterestPool;
}

export function personaArchiveIssues(input: {
  persona: XhsOpsPersona;
  personaTags: XhsOpsPersonaTags;
}): string[] {
  const missing = [
    { label: "年龄", value: input.persona.age },
    { label: "性别", value: input.persona.gender },
    { label: "地区", value: input.persona.region },
    { label: "职业/身份", value: input.persona.occupation },
    { label: "生活状态", value: input.persona.lifeStatus },
  ]
    .filter(({ value }) => !value?.trim())
    .map(({ label }) => label);
  const issues: string[] = [];
  if (missing.length > 0) issues.push(`缺少${missing.join("、")}`);
  if (
    input.personaTags.vertical.length < 1 ||
    input.personaTags.vertical.length > 2
  ) {
    issues.push("垂直兴趣档案标签需 1–2 个");
  }
  if (
    input.personaTags.general.length < 2 ||
    input.personaTags.general.length > 3
  ) {
    issues.push("泛兴趣档案标签需 2–3 个");
  }
  return issues;
}

export function personaDistributionSummary(
  rows: Array<Pick<PersonaOverlapInput, "persona">>,
): string {
  const summarize = (values: string[]) => {
    const counts = new Map<string, number>();
    for (const raw of values) {
      const value = raw.trim() || "未填写";
      counts.set(value, (counts.get(value) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], "zh-CN"))
      .map(([value, count]) => `${value} ${count}`)
      .join("、");
  };
  return [
    `年龄：${summarize(rows.map((row) => row.persona.age))}`,
    `性别：${summarize(rows.map((row) => row.persona.gender))}`,
    `地区：${summarize(rows.map((row) => row.persona.region))}`,
  ].join("；");
}

/** 核心兴趣集合重叠到这个比例（Jaccard）即视为"同一类账号"。 */
export const PERSONA_CORE_OVERLAP_THRESHOLD = 0.6;

function normKey(s: string): string {
  return s.trim().toLowerCase().replace(/\s+/g, "");
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a.map(normKey).filter(Boolean));
  const sb = new Set(b.map(normKey).filter(Boolean));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const x of sa) if (sb.has(x)) inter += 1;
  return inter / (sa.size + sb.size - inter);
}

/**
 * 运营验收「人设有差异」的机械兜底：同项目内两两比对，命中任一规则就给
 * 双方各一条告警（不阻断保存，由运营决定重生成还是接受）：
 *  1. 账号定位名相同；
 *  2. 地区 + 职业完全相同（两项都非空）；
 *  3. 年龄 + 性别 + 生活状态完全相同（三项都非空）；
 *  4. 核心兴趣 Jaccard ≥ 0.6。
 * 返回 key → 告警文案列表；没有告警的 key 不出现。
 */
export function findPersonaOverlaps(
  rows: PersonaOverlapInput[],
): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const push = (key: string, msg: string) => {
    const list = out.get(key) ?? [];
    if (!list.includes(msg)) list.push(msg);
    out.set(key, list);
  };
  for (let i = 0; i < rows.length; i++) {
    for (let j = i + 1; j < rows.length; j++) {
      const a = rows[i];
      const b = rows[j];
      if (!a || !b) continue;
      const nameA = a.label.trim() || `账号${i + 1}`;
      const nameB = b.label.trim() || `账号${j + 1}`;
      if (a.label.trim() && normKey(a.label) === normKey(b.label)) {
        push(a.key, `账号定位名与「${nameB}」重复`);
        push(b.key, `账号定位名与「${nameA}」重复`);
      }
      const pa = a.persona;
      const pb = b.persona;
      if (
        pa.region.trim() &&
        pa.occupation.trim() &&
        normKey(pa.region) === normKey(pb.region) &&
        normKey(pa.occupation) === normKey(pb.occupation)
      ) {
        push(
          a.key,
          `地区+职业与「${nameB}」相同（${pa.region.trim()}·${pa.occupation.trim()}）`,
        );
        push(
          b.key,
          `地区+职业与「${nameA}」相同（${pb.region.trim()}·${pb.occupation.trim()}）`,
        );
      }
      if (
        pa.age.trim() &&
        pa.gender.trim() &&
        pa.lifeStatus.trim() &&
        normKey(pa.age) === normKey(pb.age) &&
        normKey(pa.gender) === normKey(pb.gender) &&
        normKey(pa.lifeStatus) === normKey(pb.lifeStatus)
      ) {
        push(a.key, `年龄/性别/生活状态与「${nameB}」完全相同`);
        push(b.key, `年龄/性别/生活状态与「${nameA}」完全相同`);
      }
      const overlap = jaccard(
        a.personaTags?.vertical.length
          ? a.personaTags.vertical
          : a.interestPool.core,
        b.personaTags?.vertical.length
          ? b.personaTags.vertical
          : b.interestPool.core,
      );
      if (overlap >= PERSONA_CORE_OVERLAP_THRESHOLD) {
        const pct = Math.round(overlap * 100);
        push(a.key, `核心兴趣与「${nameB}」重叠 ${pct}%`);
        push(b.key, `核心兴趣与「${nameA}」重叠 ${pct}%`);
      }
    }
  }
  return out;
}

export function emptyProfileDraft(): XhsOpsProfileDraft {
  return {
    nickname: "",
    bio: "",
    occupation: "",
    gender: "",
    birthday: "",
    region: "",
    interestTags: [],
    avatarCandidates: [],
    coverCandidates: [],
    avatarPath: null,
    coverPath: null,
    generatedAt: null,
    reviewedAt: null,
    appliedAt: null,
    applyStatus: null,
    applyResult: null,
    applyOperation: null,
    verifiedAt: null,
    verifiedAccountId: null,
    verificationTaskId: null,
  };
}

export function normalizeProfileDraft(value: unknown): XhsOpsProfileDraft {
  const v = asRecord(value);
  const status = asString(v.applyStatus);
  const operation = asRecord(v.applyOperation);
  const operationStatus = asString(operation.status);
  const applyOperation: XhsOpsProfileApplyOperation | null =
    (operationStatus === "running" || operationStatus === "completed") &&
    asString(operation.operationId) &&
    asString(operation.deviceId) &&
    asString(operation.accountUpdatedAt) &&
    asString(operation.startedAt)
      ? {
          operationId: asString(operation.operationId),
          status: operationStatus,
          deviceId: asString(operation.deviceId),
          taskId:
            typeof operation.taskId === "string" ? operation.taskId : null,
          accountUpdatedAt: asString(operation.accountUpdatedAt),
          startedAt: asString(operation.startedAt),
          completedAt:
            typeof operation.completedAt === "string"
              ? operation.completedAt
              : null,
        }
      : null;
  return {
    nickname: asString(v.nickname).slice(0, 20),
    bio: asString(v.bio).slice(0, 200),
    occupation: asString(v.occupation).slice(0, 80),
    gender:
      v.gender === "男" || v.gender === "女" || v.gender === "不展示"
        ? v.gender
        : "",
    birthday: asString(v.birthday),
    region: asString(v.region),
    interestTags: asStringArray(v.interestTags),
    avatarCandidates: asStringArray(v.avatarCandidates),
    coverCandidates: asStringArray(v.coverCandidates),
    avatarPath:
      typeof v.avatarPath === "string" && v.avatarPath ? v.avatarPath : null,
    coverPath:
      typeof v.coverPath === "string" && v.coverPath ? v.coverPath : null,
    generatedAt: typeof v.generatedAt === "string" ? v.generatedAt : null,
    reviewedAt: typeof v.reviewedAt === "string" ? v.reviewedAt : null,
    appliedAt: typeof v.appliedAt === "string" ? v.appliedAt : null,
    applyStatus:
      status === "applied" || status === "partial" || status === "failed"
        ? status
        : null,
    applyResult: typeof v.applyResult === "string" ? v.applyResult : null,
    applyOperation,
    verifiedAt: typeof v.verifiedAt === "string" ? v.verifiedAt : null,
    verifiedAccountId:
      typeof v.verifiedAccountId === "string" ? v.verifiedAccountId : null,
    verificationTaskId:
      typeof v.verificationTaskId === "string" ? v.verificationTaskId : null,
  };
}

/** media 目录绝对路径 → 桌面可显示的 URL（controller 的 state-file 端点）。 */
export function mediaFileUrl(absPath: string): string {
  return `/api/v1/media/state-file?path=${encodeURIComponent(absPath)}`;
}

export const COMMENT_STATUS_LABEL: Record<XhsOpsCommentStatus, string> = {
  pending: "待审核",
  approved: "已批准",
  rejected: "已拒绝",
  sent: "已发出",
  failed: "发送失败",
  expired: "已过期",
};

/** 与服务端一致的评论文案硬校验（≤10 字、非空、不换行）；营销词由服务端兜底。 */
export const COMMENT_MAX_CHARS = 10;
export function commentTextProblem(text: string): string | null {
  const t = text.trim();
  const len = [...t].length;
  if (len < 2) return "至少 2 个字";
  if (len > COMMENT_MAX_CHARS) return `超过 ${COMMENT_MAX_CHARS} 字（${len}）`;
  if (/[\r\n]/.test(t)) return "不能换行";
  return null;
}
