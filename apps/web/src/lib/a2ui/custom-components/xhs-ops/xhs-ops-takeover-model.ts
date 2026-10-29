/**
 * Pure helpers and the Chinese vocabulary of the takeover card (老号接管,
 * docs/plans/2026-10-14-xhs-account-takeover-design.md). Every rule the
 * controller enforces comes from @nexu/shared; what lives here is display
 * wording and the few derivations the card needs on top of those rules.
 */
import {
  PHONE_SKILLS_BUNDLE,
  XHS_OPS_PLAYBOOK_CATEGORY,
  XHS_PROFILE_FIELD_LABEL,
  XHS_TAKEOVER_CHANGE_BUDGET,
  XHS_TAKEOVER_IMAGE_MAX_BYTES,
  type XhsOpsAccount,
  type XhsOpsAccountDiagnosis,
  type XhsOpsAuditComparison,
  type XhsOpsAuditFlag,
  type XhsOpsAuditPartStatus,
  type XhsOpsChangeOrder,
  type XhsOpsChangeOrderAckKey,
  type XhsOpsChangeOrderField,
  type XhsOpsChangeOrderFlag,
  type XhsOpsChangeOrderStatus,
  type XhsOpsCount,
  type XhsOpsFinding,
  type XhsOpsPlaybookRule,
  type XhsOpsProfileField,
  type XhsOpsProposalKind,
  type XhsOpsSafetyPause,
  type XhsOpsTakeoverEvent,
  type XhsOpsTakeoverParamConflictCode,
  type XhsOpsTakeoverPlanIssue,
  type XhsOpsTakeoverProfileField,
  type XhsOpsTakeoverStage,
  type XhsOpsToneGuide,
  xhsOpsAccountConflictResponseSchema,
  xhsOpsCommentRunConflictResponseSchema,
  xhsOpsDevicePolicyModeIssue,
  xhsOpsIsTakeoverImageField,
  xhsOpsPlaybookConfidenceSchema,
  xhsOpsProfileFieldLabels,
  xhsOpsTakeoverFieldBudgetState,
  xhsOpsTakeoverProfileFieldSchema,
  xhsOpsTakeoverStage,
} from "@nexu/shared";
import type { StatusTone } from "../../a2ui-status";
import { mediaFileUrl } from "./xhs-ops-types";
import type { XhsOpsDevice } from "./xhs-ops-ui";

// ── Fixed wording the design spells out (§1.2, §4.5, §5.2, §8.1) ──────────

export const TAKEOVER_AUTHORIZATION_STATEMENT =
  "我确认该账号归我方/客户所有，授权桌面只读盘点；任何公开修改都会逐项征求我的确认。";

export const TAKEOVER_READ_ONLY_EXPECTATION =
  "接管会先只读地看一遍这个号，不改任何资料。";

export const TAKEOVER_AUDIT_RESIDUAL_NOTICE =
  "误赞、误收藏他人内容无法事后检出。";

export const TAKEOVER_TONE_GUIDE_NOTICE =
  "调性指南是给人执行的指南。P0 里它只会自动作用到两处：内容支柱映射成兴趣词，评论候选的语气。它不会改已有笔记，也不会自动发帖。";

/** §5.3 #9, verbatim. */
export const TAKEOVER_BUDGET_HISTORY_NOTE =
  "接管前的历史改动桌面不知道，平台实际剩余以手机提示为准";

export const TAKEOVER_ORDER_MANUAL_CHECK_NOTICE =
  "执行期间关注数或获赞与收藏数有变化，请到手机上检查是否误关注或误点";

/** Shown while the takeover routes answer 503 after a controller restart (§2.6). */
export const TAKEOVER_RECOVERING_HINT =
  "控制端刚重启，正在收口上次未完成的接管任务；卡片几秒后自动重新读取，之后再继续操作。";

/**
 * Where the audits, change orders and diagnosis go while those reads answer
 * 503 on a freshly mounted card; the header (「暂停接管」 included) already works.
 */
export const TAKEOVER_DETAILS_RECOVERING = "控制端刚重启，正在恢复…";

/** The diagnosis feedback limit (xhsOpsDiagnosisGenerateBodySchema). */
export const TAKEOVER_FEEDBACK_MAX = 300;

// ── Stage ───────────────────────────────────────────────────────────────────

export const TAKEOVER_STAGE_LABEL: Record<XhsOpsTakeoverStage, string> = {
  bound: "待授权",
  authorized: "待锁定身份",
  identity_locked: "待只读盘点",
  baselined: "待生成诊断",
  diagnosed: "待确认方案",
  plan_confirmed: "变更单进行中，养号暂停",
  maintaining: "日常维护",
  observing: "观察期",
  paused: "已暂停",
  device_hold: "手机任务待确认",
};

export function takeoverStageTone(stage: XhsOpsTakeoverStage): StatusTone {
  switch (stage) {
    case "maintaining":
      return "done";
    case "observing":
    case "plan_confirmed":
      return "waiting";
    case "paused":
    case "device_hold":
      return "blocked";
    default:
      return "idle";
  }
}

/**
 * Lifecycle progress with a pause or a device hold set aside: the shared
 * stage lets both outrank everything (§1.1), but the card still has to know
 * which sections the account already reached. 0 = bound … 5 = plan confirmed.
 */
export function takeoverStep(account: XhsOpsAccount, now: number): number {
  const takeover = account.takeover;
  const stage = xhsOpsTakeoverStage(
    takeover
      ? {
          ...account,
          takeover: { ...takeover, safetyPause: null, deviceHold: null },
        }
      : account,
    now,
  );
  switch (stage) {
    case "authorized":
      return 1;
    case "identity_locked":
      return 2;
    case "baselined":
      return 3;
    case "diagnosed":
      return 4;
    case "plan_confirmed":
    case "maintaining":
    case "observing":
      return 5;
    default:
      return 0;
  }
}

// ── Pause and resume (§6.5) ─────────────────────────────────────────────────

export const PAUSE_CODE_LABEL: Record<XhsOpsSafetyPause["code"], string> = {
  rate_limited: "操作频繁",
  account_restricted: "账号受限",
  login_required: "需要账号本人登录",
  account_mismatch: "手机上的账号不符",
  observation_failed: "观察期复查未通过",
  manual: "手动暂停",
};

// ── Audit (T3) ──────────────────────────────────────────────────────────────

export const AUDIT_PARTS = [
  { key: "profile", title: "P0 资料存档与号码核对" },
  { key: "home", title: "A 主页与笔记" },
  { key: "creator", title: "B 创作者数据" },
] as const;

export const AUDIT_STATUS_LABEL: Record<
  "running" | "completed" | "partial" | "failed" | "interrupted" | "cancelled",
  string
> = {
  running: "盘点中",
  completed: "已完成",
  partial: "部分完成",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已取消",
};

export const AUDIT_PART_STATUS_LABEL: Record<XhsOpsAuditPartStatus, string> = {
  pending: "待执行",
  running: "进行中",
  read: "已读取",
  partial: "部分读取",
  unavailable: "不可用",
  failed: "失败",
  interrupted: "已中断",
  cancelled: "已取消",
  skipped: "已跳过",
};

export function auditPartTone(status: XhsOpsAuditPartStatus): StatusTone {
  switch (status) {
    case "running":
      return "running";
    case "read":
      return "done";
    case "failed":
      return "failed";
    case "partial":
    case "unavailable":
    case "interrupted":
    case "cancelled":
      return "blocked";
    default:
      return "idle";
  }
}

export const AUDIT_FLAG_LABEL: Record<XhsOpsAuditFlag, string> = {
  nicknameInconsistent: "主页或创作者页读到的名字与资料存档不一致",
  identityStale: "盘点之后小红书号或设备已变化，这次盘点已失效",
  unexpectedClicks: "点击数超出预期路径",
  countsChanged: "同一次盘点里关注数前后不一致，可能误关注",
  possibleSelfLike:
    "获赞与收藏小幅增加（1–3），可能误点了自己的笔记，也可能是自然增长",
  profileDrift: "资料现值与上次盘点不一致",
  creatorUnavailable: "创作者数据不可用（新号或未开通属正常）",
  cancellationUnconfirmed: "手机任务停止未确认",
};

/**
 * §7.1: notes that gained or lost 置顶 between two audits
 * (compareXhsOpsAudits' pins) as one line, e.g. 「置顶变化：新置顶《A》；取消置顶
 * 《B》」. null when nothing moved or either note grid was not read.
 */
export function takeoverPinChangesText(
  pins: XhsOpsAuditComparison["pins"],
): string | null {
  if (!pins) return null;
  const titles = (list: readonly string[]) =>
    list.map((title) => `《${title}》`).join("、");
  const parts = [
    pins.pinned.length > 0 ? `新置顶${titles(pins.pinned)}` : null,
    pins.unpinned.length > 0 ? `取消置顶${titles(pins.unpinned)}` : null,
  ].filter((part): part is string => part !== null);
  return parts.length > 0 ? `置顶变化：${parts.join("；")}` : null;
}

/** A count as the page printed it plus its parsed value: 「1.2万 → 约 12,000」. */
export function countDisplay(count: XhsOpsCount | null | undefined): string {
  if (!count) return "未读到";
  if (count.value === null) return `${count.text}（无法解析）`;
  const parsed = count.value.toLocaleString("zh-CN");
  if (
    !count.approx &&
    (count.text === String(count.value) || count.text === parsed)
  )
    return count.text;
  return `${count.text} → ${count.approx ? "约 " : ""}${parsed}`;
}

// ── Diagnosis (T5) ──────────────────────────────────────────────────────────

export const SEVERITY_LABEL: Record<XhsOpsFinding["severity"], string> = {
  info: "提示",
  low: "低",
  medium: "中",
  high: "高",
};

export function severityTone(severity: XhsOpsFinding["severity"]): StatusTone {
  switch (severity) {
    case "high":
      return "failed";
    case "medium":
      return "blocked";
    case "low":
      return "waiting";
    default:
      return "idle";
  }
}

export const DIMENSION_LABEL: Record<string, string> = {
  identity: "身份一致性",
  persona_fit: "人设匹配",
  verticality: "垂直度",
  tone: "调性",
  activity: "活跃度",
  performance: "互动表现",
  risk: "风险合规",
  compliance: "合规",
};

export const RATING_LABEL: Record<
  "good" | "fair" | "poor" | "unknown",
  string
> = {
  good: "好",
  fair: "一般",
  poor: "需调整",
  unknown: "未知",
};

export function ratingTone(rating: "good" | "fair" | "poor" | "unknown") {
  const tones: Record<typeof rating, StatusTone> = {
    good: "done",
    fair: "waiting",
    poor: "blocked",
    unknown: "idle",
  };
  return tones[rating];
}

export const CONFIDENCE_LABEL: Record<"low" | "medium" | "high", string> = {
  low: "低",
  medium: "中",
  high: "高",
};

const EVIDENCE_FIELD_LABEL: Record<string, string> = {
  nickname: "名字",
  bio: "简介",
  occupation: "职业",
  gender: "性别",
  birthdayFilled: "生日",
  region: "地区",
  following: "关注数",
  followers: "粉丝数",
  likesCollects: "获赞与收藏",
  periodLabel: "近 7 日周期",
  views: "近 7 日观看",
  interactions: "近 7 日互动",
  newFollowers: "近 7 日新增关注",
  profileVisitors: "近 7 日主页访客",
  accountStatus: "账号状态",
};

/**
 * The audit row an evidence path points at, or null when it names facts or
 * the project rather than something the audit read. `home.notes[n]` and
 * `notes[n]` are the note card numbered i = n (the controller's rule).
 */
export function evidenceRowKey(ref: string): string | null {
  const note = /^(?:home\.)?notes\[(\d+)\]/.exec(ref);
  if (note) return `notes[${note[1]}]`;
  if (/^(?:home\.)?notes(?:End)?$/.test(ref)) return "notes";
  const header =
    /^(?:home|creator)\.header(?:End)?\.(following|followers|likesCollects)$/.exec(
      ref,
    );
  if (header) return `header.${header[1]}`;
  const profile =
    /^profile\.(nickname|bio|occupation|gender|birthdayFilled|region)$/.exec(
      ref,
    );
  if (profile) return `profile.${profile[1]}`;
  if (ref === "home.nickname" || ref === "creator.nickname")
    return "profile.nickname";
  const creator =
    /^creator\.(periodLabel|views|interactions|newFollowers|profileVisitors|accountStatus)$/.exec(
      ref,
    );
  if (creator) return `creator.${creator[1]}`;
  return null;
}

/** Readable label of an evidence path; unknown shapes show the path itself. */
export function evidenceLabel(ref: string): string {
  const note = /^(?:home\.)?notes\[(\d+)\]/.exec(ref);
  if (note) return `笔记第 ${note[1]} 篇`;
  const key = evidenceRowKey(ref);
  const field = key?.split(".")[1];
  if (key && field && EVIDENCE_FIELD_LABEL[field])
    return EVIDENCE_FIELD_LABEL[field];
  if (key === "notes") return "笔记列表";
  return ref;
}

export type RuleChipCategory = "skill_doc" | "design" | "reference" | "unknown";

export type RuleChip = {
  id: string;
  category: RuleChipCategory;
  text: string;
  source: string;
  /** A design rule nobody signed off yet (D8): shown as 「待确认」. */
  pendingSignOff: boolean;
};

/**
 * One experience chip (§4.5): the diagnosis' own snapshot of the rule first,
 * then the current playbook. A rule id neither knows is 「无经验依据」.
 */
export function resolveRuleChip(
  id: string,
  citedRules: XhsOpsAccountDiagnosis["citedRules"],
  playbook: readonly XhsOpsPlaybookRule[],
): RuleChip {
  const cited = citedRules.find((rule) => rule.id === id);
  const rule = playbook.find((entry) => entry.id === id);
  if (!cited && !rule)
    return {
      id,
      category: "unknown",
      text: "",
      source: "",
      pendingSignOff: false,
    };
  const confidence = xhsOpsPlaybookConfidenceSchema.safeParse(
    cited?.confidence ?? rule?.confidence,
  );
  const category = confidence.success
    ? XHS_OPS_PLAYBOOK_CATEGORY[confidence.data]
    : "reference";
  return {
    id,
    category,
    text: cited?.text ?? rule?.text ?? "",
    source: cited?.source ?? rule?.source ?? "",
    pendingSignOff:
      category === "design" &&
      (cited ? !cited.signedOff : rule?.signedOffAt === null),
  };
}

export const TAKEOVER_SKILL_BUNDLE_NOTICE =
  "技能文档已更新，doc 类规则出处可能已变";

const SKILL_SYNC_STATUS_LABEL: Record<
  NonNullable<XhsOpsDevice["skillSyncStatus"]>,
  string
> = {
  unknown: "同步状态未知",
  syncing: "正在同步",
  current: "已是最新",
  error: "同步出错",
  incompatible: "与桌面版本不兼容",
};

/** The softer note: the phone's skill sync has not settled on the shipped bundle. */
export function takeoverSkillSyncNotice(
  status: NonNullable<XhsOpsDevice["skillSyncStatus"]>,
): string {
  return `手机技能文档${SKILL_SYNC_STATUS_LABEL[status]}，doc 类规则的出处可能与手机上的文档对不上`;
}

/** The clearer second line when the phone's bundle is the older one. */
export function takeoverSkillPhoneOlderNotice(
  phoneBundle: number,
  playbookBundle: number,
): string {
  return `手机还没同步到新的技能文档（手机是第 ${phoneBundle} 版，经验库按第 ${playbookBundle} 版核对）；同步完成之前，手机按旧版文档执行。`;
}

/**
 * §4.5: how the bound phone's skill docs stand against the bundle the
 * playbook's doc rules were checked against (the playbook's bundleVersion,
 * else PHONE_SKILLS_BUNDLE). "bundle_mismatch": the phone reports another
 * bundle, older or newer, so a 技能文档 citation may point at text that
 * moved; "unsynced": same bundle, but its last skill sync is not "current".
 * Fields the phone has not reported yet — briefly absent between connect and
 * skill.hello — say nothing.
 */
export type TakeoverSkillDocsState =
  | { kind: "bundle_mismatch"; phoneBundle: number; playbookBundle: number }
  | {
      kind: "unsynced";
      status: NonNullable<XhsOpsDevice["skillSyncStatus"]>;
    }
  | null;

export function takeoverSkillDocsState(
  device:
    | Pick<XhsOpsDevice, "skillBundleVersion" | "skillSyncStatus">
    | null
    | undefined,
  playbookBundleVersion: number = PHONE_SKILLS_BUNDLE,
): TakeoverSkillDocsState {
  const version = device?.skillBundleVersion;
  if (version !== undefined && version !== playbookBundleVersion)
    return {
      kind: "bundle_mismatch",
      phoneBundle: version,
      playbookBundle: playbookBundleVersion,
    };
  const status = device?.skillSyncStatus;
  if (status !== undefined && status !== "current")
    return { kind: "unsynced", status };
  return null;
}

// ── Device policy mode (§5.2) ───────────────────────────────────────────────

export const TAKEOVER_POLICY_MODE_UNKNOWN_NOTICE =
  "手机自上次连接以来还没跑过任务，策略模式暂未上报；第一个任务开始时会核对，不是 enforce 会立即停止并暂停这个号。";

/**
 * The phone's devicePolicyMode as the card shows it: "blocked" (audit or
 * off — the controller refuses every takeover task, with the shared refusal
 * text), "unknown" (not reported since the phone last connected; tasks go
 * out and the first progress report is checked), null (enforce, or the phone
 * is not connected so there is nothing to say).
 */
export function takeoverPolicyModeState(
  device: Pick<XhsOpsDevice, "devicePolicyMode"> | null | undefined,
): { kind: "blocked"; message: string } | { kind: "unknown" } | null {
  if (!device) return null;
  if (device.devicePolicyMode === undefined) return { kind: "unknown" };
  const issue = xhsOpsDevicePolicyModeIssue(device);
  return issue ? { kind: "blocked", message: issue } : null;
}

export function hasUnknownRule(
  ruleIds: readonly string[],
  citedRules: XhsOpsAccountDiagnosis["citedRules"],
  playbook: readonly XhsOpsPlaybookRule[],
): boolean {
  return ruleIds.some(
    (id) => resolveRuleChip(id, citedRules, playbook).category === "unknown",
  );
}

// ── Plan (T6) ───────────────────────────────────────────────────────────────

export const PLAN_GROUPS: ReadonlyArray<{
  key: "A" | "B" | "C" | "D" | "E" | "F" | "G";
  title: string;
  /** null: group C, the parameters the code derives from the tier. */
  kind: XhsOpsProposalKind | null;
}> = [
  { key: "A", title: "A 定位与人设", kind: "positioning" },
  { key: "B", title: "B 兴趣池", kind: "interestPool" },
  { key: "C", title: "C 养号参数（代码按档位给出）", kind: null },
  { key: "D", title: "D 调性指南（含选题方向）", kind: "toneGuide" },
  { key: "E", title: "E 主页资料（公开）", kind: "profileField" },
  { key: "F", title: "F 旧笔记处理（人工清单）", kind: "noteAction" },
  { key: "G", title: "G 保留项", kind: "keep" },
];

export const DECISION_LABEL: Record<
  "adopt" | "edit" | "reject" | "defer",
  string
> = {
  adopt: "采纳",
  edit: "改后采纳",
  reject: "拒绝",
  defer: "暂缓",
};

export const NOTE_ACTION_LABEL: Record<
  "keep" | "pin" | "unpin" | "consider_private",
  string
> = {
  keep: "保留",
  pin: "置顶",
  unpin: "取消置顶",
  consider_private: "考虑设为仅自己可见",
};

type ToneGuideContent = Omit<
  XhsOpsToneGuide,
  "sourceDiagnosisId" | "confirmedAt" | "ruleIds"
>;

/** §7.1: the tone guide as labelled lines, empty parts left out. */
export function toneGuideLines(
  guide: ToneGuideContent,
): Array<{ label: string; value: string }> {
  const list = (values: readonly string[]) => values.join("、");
  return [
    { label: "整体语气", value: guide.summary },
    {
      label: "内容支柱",
      value: guide.pillars
        .map((pillar) => `${pillar.name} ${pillar.sharePercent}%`)
        .join("、"),
    },
    { label: "选题方向", value: list(guide.topicDirections) },
    { label: "标题句式", value: list(guide.titlePatterns) },
    { label: "封面风格", value: guide.coverStyle },
    { label: "正文风格", value: guide.bodyStyle },
    { label: "标签提示", value: list(guide.tagHints) },
    { label: "保留特色", value: list(guide.keep) },
    { label: "回避方向", value: list(guide.avoid) },
    { label: "评论语气", value: guide.commentStyle },
    { label: "发帖节奏（人工执行）", value: guide.cadenceHint },
  ].filter((line) => line.value.trim() !== "");
}

// ── Change orders (T8, §5.2) ────────────────────────────────────────────────

export function changeOrderTone(status: XhsOpsChangeOrderStatus): StatusTone {
  switch (status) {
    case "prechecking":
    case "applying":
    case "verifying":
      return "running";
    case "awaiting_confirm":
    case "awaiting_visual_check":
    case "awaiting_manual_check":
    case "observing":
      return "waiting";
    case "completed":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "blocked";
    default:
      return "idle";
  }
}

export const FIELD_OUTCOME_LABEL: Record<
  XhsOpsChangeOrderField["outcome"],
  string
> = {
  pending: "待执行",
  done: "已改，待核验",
  failed: "没有改成",
  skipped: "未改",
  uncertain: "可能已改，待核验",
  verified: "已核验",
  mismatch: "与目标不一致",
};

export const FIELD_CODE_LABEL: Record<string, string> = {
  album_not_found: "没找到名字逐字一致的专用相册，或相册里不止一张图",
  permission_required: "小红书没有『所有照片』访问权限",
  picker_unsupported: "出现了系统照片选择器或文件管理器",
  step_limit: "选图步数超过上限",
  platform_limit: "平台修改次数限制",
};

export const CHANGE_ORDER_FLAG_LABEL: Record<XhsOpsChangeOrderFlag, string> = {
  countsChanged: "执行期间关注数有变化",
  possibleSelfLike: "执行期间获赞与收藏小幅增加",
  permissionRequired:
    "小红书没有『所有照片』访问权限：请账号本人在手机上授权后再预检重试",
  albumNotFound:
    "手机上没找到名字逐字一致的专用相册：请先删掉旧的 Tabby- 相册再重试",
  pickerUnsupported: "选图时出现了系统照片选择器，任务已返回",
};

export const OBSERVATION_VERDICT_LABEL: Record<
  "pending" | "pass" | "warn" | "fail" | "inconclusive",
  string
> = {
  pending: "待复查",
  pass: "通过",
  warn: "有提醒",
  fail: "未通过",
  inconclusive: "无法判定",
};

export function verdictTone(
  verdict: "pending" | "pass" | "warn" | "fail" | "inconclusive",
): StatusTone {
  const tones: Record<typeof verdict, StatusTone> = {
    pending: "idle",
    pass: "done",
    warn: "blocked",
    fail: "failed",
    inconclusive: "waiting",
  };
  return tones[verdict];
}

export const TAKEOVER_FIELDS: readonly XhsOpsTakeoverProfileField[] = [
  "bio",
  "occupation",
  "nickname",
  "region",
  "avatar",
  "cover",
];

function takeoverField(
  field: XhsOpsProfileField,
): XhsOpsTakeoverProfileField | null {
  const parsed = xhsOpsTakeoverProfileFieldSchema.safeParse(field);
  return parsed.success ? parsed.data : null;
}

/** Wording of each confirmation box (§5.2 step 3; image texts verbatim). */
export function changeOrderAckText(
  key: XhsOpsChangeOrderAckKey,
  fields: readonly XhsOpsProfileField[],
): string {
  switch (key) {
    case "photoPermission":
      return "小红书需要已有『所有照片』访问权限。手机任务不会替你授权；没有权限时任务会停下，请你自己在手机上授权后重试。";
    case "screenshotPrivacy":
      return "每张图选图时，手机截图会经过小红书选图页的『全部』照片和相册列表，相册列表可能显示你各个相册的封面。每张图最多十余张截图，这些截图会发给模型服务，也会显示在桌面的任务进度里。";
    case "cleanup":
      return "推进手机相册的图片不会自动删除，换好后请自己在手机相册里删除。";
    case "l2SecondCheck":
      return `我再次确认要修改${xhsOpsProfileFieldLabels(
        fields.filter((field) => field === "nickname" || field === "region"),
      )}：这类修改平台有次数限制，公开且不可撤销，改后老粉可能认不出这个号。`;
    case "warnAcknowledged":
      return "上一张变更单的观察期复查结果是 warn（见那张单的复查说明），我已了解，仍要执行这一批。";
  }
}

export function rollbackCostText(field: XhsOpsProfileField): string {
  const label = XHS_PROFILE_FIELD_LABEL[field];
  return xhsOpsIsTakeoverImageField(field)
    ? `${label}无法恢复原图；回滚时需要你重新提供一张图`
    : `回滚同样消耗一次${label}修改次数`;
}

export type TakeoverBudgetRow = {
  field: XhsOpsTakeoverProfileField;
  risk: "L1" | "L2";
  windowDays: number;
  maxChanges: number;
  used: number;
  blockedUntil: string | null;
};

/**
 * §8.1 budget of `fields` over the ledger of one 小红书号, through the shared
 * xhsOpsTakeoverFieldBudgetState. `excludeOrderId` leaves out the order a
 * dialog is about to confirm, as the server does.
 */
export function takeoverBudgetRows(input: {
  account: Pick<XhsOpsAccount, "id" | "takeover">;
  platformAccountId: string;
  orders: readonly XhsOpsChangeOrder[];
  now: number;
  fields?: readonly XhsOpsTakeoverProfileField[];
  excludeOrderId?: string;
  rollback?: boolean;
}): TakeoverBudgetRow[] {
  const ledger = input.orders.filter(
    (order) =>
      order.accountId === input.account.id &&
      order.platformAccountId === input.platformAccountId &&
      order.id !== input.excludeOrderId,
  );
  const notices = input.account.takeover?.platformLimitNotices ?? [];
  return (input.fields ?? TAKEOVER_FIELDS).map((field) => {
    const budget = XHS_TAKEOVER_CHANGE_BUDGET[field];
    const state = xhsOpsTakeoverFieldBudgetState(
      field,
      { orders: ledger, notices },
      input.now,
      { rollback: input.rollback },
    );
    return {
      field,
      risk: budget.risk,
      windowDays: budget.windowDays,
      maxChanges: budget.maxChanges,
      used: state.used,
      blockedUntil: state.blockedUntil,
    };
  });
}

export function orderTakeoverFields(
  order: Pick<XhsOpsChangeOrder, "fields">,
): XhsOpsTakeoverProfileField[] {
  return order.fields.flatMap((entry) => {
    const field = takeoverField(entry.field);
    return field ? [field] : [];
  });
}

/** A phone step of the order runs in the background: the card polls it. */
export function changeOrderInFlight(order: XhsOpsChangeOrder): boolean {
  return (
    order.status === "prechecking" ||
    order.status === "applying" ||
    order.status === "verifying" ||
    (order.status === "observing" &&
      Boolean(order.observation?.auditId) &&
      order.observation?.verdict === "pending")
  );
}

/**
 * The order has not reached the state xhs_ops_change_order_finished reports
 * yet: whatever this card sees it reach from here on is worth announcing.
 */
export function changeOrderAwaitingFinish(order: XhsOpsChangeOrder): boolean {
  if (
    order.status === "completed" ||
    order.status === "failed" ||
    order.status === "cancelled"
  )
    return false;
  if (order.status === "observing") return changeOrderInFlight(order);
  return true;
}

/** Preview URL of an uploaded picture; the sha256 busts the hour-long cache. */
export function takeoverImageUrl(
  field: Pick<XhsOpsChangeOrderField, "imagePath" | "imageSha256">,
): string | null {
  if (!field.imagePath) return null;
  const url = mediaFileUrl(field.imagePath);
  return field.imageSha256
    ? `${url}&v=${encodeURIComponent(field.imageSha256)}`
    : url;
}

export const TAKEOVER_IMAGE_TYPES: readonly string[] = [
  "image/png",
  "image/jpeg",
  "image/webp",
];

/** Client-side check before a picture is read and uploaded (§5.2 step 1). */
export function takeoverImageProblem(file: {
  type: string;
  size: number;
}): string | null {
  if (!TAKEOVER_IMAGE_TYPES.includes(file.type))
    return "只支持 png、jpeg 或 webp 图片";
  if (file.size > XHS_TAKEOVER_IMAGE_MAX_BYTES) return "图片不能超过 10MB";
  if (file.size === 0) return "图片内容为空";
  return null;
}

// ── Responses ───────────────────────────────────────────────────────────────

function errorStatus(err: unknown): number | null {
  if (typeof err !== "object" || err === null || !("status" in err))
    return null;
  return typeof err.status === "number" ? err.status : null;
}

/**
 * The takeover routes answer 503 until the controller's startup recovery
 * settled (§2.6): a reason to wait and retry, not a failure.
 */
export function isTakeoverRecovering(err: unknown): boolean {
  return errorStatus(err) === 503;
}

/** A 409: a stale revision or a rule the current records break. */
export function isTakeoverConflict(err: unknown): boolean {
  return errorStatus(err) === 409;
}

export type TakeoverParamConflict = {
  /**
   * takeover_override_reason_required: every issue lifts with an
   * overrideReason; takeover_param_hard_limit: at least one is a hard limit,
   * so the values have to change.
   */
  code: XhsOpsTakeoverParamConflictCode;
  message: string;
  issues: XhsOpsTakeoverPlanIssue[];
};

/**
 * The structured 409 (xhsOpsAccountConflictResponseSchema) of a takeover
 * account PATCH or device transfer whose interaction / browseDefaults go past
 * a limit (§2.5, §6.3), or null for any other error — a 409 without `code`
 * (a stale revision, a binding conflict) included. Reads the error body
 * XhsOpsApiError keeps.
 */
export function takeoverParamConflict(
  err: unknown,
): TakeoverParamConflict | null {
  if (errorStatus(err) !== 409) return null;
  if (typeof err !== "object" || err === null || !("body" in err)) return null;
  const parsed = xhsOpsAccountConflictResponseSchema.safeParse(err.body);
  if (!parsed.success || !parsed.data.code) return null;
  return {
    code: parsed.data.code,
    message: parsed.data.message,
    issues: parsed.data.issues ?? [],
  };
}

/** What the comment review adds to the controller's pause message (§6.5). */
export const TAKEOVER_COMMENT_RUN_PAUSED_HINT =
  "评论没有派发：请先在这个账号的接管卡片上处理暂停并点「恢复」，恢复后再派发。";

/**
 * The controller's message when a comment run was refused because the
 * account's takeover is paused — the 409 of xhsOpsCommentRunConflictResponseSchema
 * with code "takeover_paused" — or null for any other error, a 409 without
 * that code included. Reads the error body XhsOpsApiError keeps.
 */
export function takeoverCommentRunPaused(err: unknown): string | null {
  if (errorStatus(err) !== 409) return null;
  if (typeof err !== "object" || err === null || !("body" in err)) return null;
  const parsed = xhsOpsCommentRunConflictResponseSchema.safeParse(err.body);
  return parsed.success && parsed.data.code === "takeover_paused"
    ? parsed.data.message
    : null;
}

type Revisioned = { id: string; updatedAt: string };

/** The controller stamps updatedAt with toISOString(). */
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;

function revisionTime(updatedAt: string): number {
  // Date.parse alone is lenient enough to read "rev-1" as a date.
  return ISO_TIMESTAMP.test(updatedAt) ? Date.parse(updatedAt) : Number.NaN;
}

/**
 * `next` is an older revision of `current`: a read that started before a
 * newer write landed. The controller's updatedAt only ever moves forward.
 */
export function olderRevision(
  next: Revisioned,
  current: Revisioned | null | undefined,
): boolean {
  if (!current || current.id !== next.id) return false;
  const nextAt = revisionTime(next.updatedAt);
  const currentAt = revisionTime(current.updatedAt);
  return (
    Number.isFinite(nextAt) && Number.isFinite(currentAt) && nextAt < currentAt
  );
}

/** A freshly read list, keeping any record the card already holds a newer revision of. */
export function mergeRevisions<T extends Revisioned>(
  current: readonly T[],
  incoming: readonly T[],
): T[] {
  return incoming.map((record) => {
    const known = current.find((entry) => entry.id === record.id);
    return known && olderRevision(record, known) ? known : record;
  });
}

// ── Events (dedupe) ─────────────────────────────────────────────────────────

const FORWARDED_STORAGE_KEY = "nexu:xhs-ops:takeover-events-forwarded:v1";
const FORWARDED_STORAGE_CAP = 300;

function payloadText(value: unknown): string | null {
  return typeof value === "string" && value ? value : null;
}

/**
 * Dedupe key of a takeover event: name, the record it is about (order,
 * diagnosis, audit, else account) and its status. Events without a status
 * (identity locked, plan confirmed) pass the revision that produced them; a
 * baseline audit event never collides with the earlier non-baseline one.
 */
export function takeoverEventKey(
  event: XhsOpsTakeoverEvent,
  revision?: string | null,
): string {
  const payload = event.payload;
  const id =
    payloadText(payload.orderId) ??
    payloadText(payload.diagnosisId) ??
    payloadText(payload.auditId) ??
    payloadText(payload.accountId) ??
    "";
  const status = payloadText(payload.status) ?? revision ?? "";
  return `${event.name}:${id}:${status}${payload.baseline === true ? ":baseline" : ""}`;
}

function storedForwardedKeys(): string[] {
  try {
    const raw = sessionStorage.getItem(FORWARDED_STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((value): value is string => typeof value === "string")
      : [];
  } catch {
    return [];
  }
}

/** Keys already forwarded in this browser session (a remount must not repeat them). */
export function loadForwardedTakeoverEvents(): Set<string> {
  return new Set(storedForwardedKeys());
}

/** Merges with what is stored, so two cards never drop each other's keys. */
export function rememberForwardedTakeoverEvent(key: string): void {
  try {
    const keys = [...new Set([...storedForwardedKeys(), key])].slice(
      -FORWARDED_STORAGE_CAP,
    );
    sessionStorage.setItem(FORWARDED_STORAGE_KEY, JSON.stringify(keys));
  } catch {
    // Storage unavailable: the in-memory guard still holds for this mount.
  }
}

export function forwardedTakeoverEventStored(key: string): boolean {
  return storedForwardedKeys().includes(key);
}

// ── Time ────────────────────────────────────────────────────────────────────

/** Local 「MM-DD HH:mm」. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** 「2 天 3 小时」/「5 小时 10 分」/「12 分钟」. */
export function formatRemaining(ms: number): string {
  const minutes = Math.max(0, Math.ceil(ms / 60_000));
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  if (days > 0) return hours > 0 ? `${days} 天 ${hours} 小时` : `${days} 天`;
  if (hours > 0) return rest > 0 ? `${hours} 小时 ${rest} 分` : `${hours} 小时`;
  return `${rest} 分钟`;
}
