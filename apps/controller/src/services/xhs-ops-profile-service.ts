import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DeviceExecuteTaskBody,
  DevicePushMediaBody,
  DevicePushMediaResponse,
  TaskResult,
  XhsOpsAccount,
  XhsOpsAccountIdentity,
  XhsOpsChangeOrder,
  XhsOpsProfileApplyOperation,
  XhsOpsProfileApplyStatus,
  XhsOpsProfileDraft,
  XhsOpsProfileField,
  XhsOpsProfileFieldDiff,
  XhsOpsProfilePart,
  XhsOpsProfileReadback,
  XhsOpsProject,
  XhsOpsTakeoverProfileField,
} from "@nexu/shared";
import {
  XHS_PROFILE_CANDIDATES,
  XHS_PROFILE_FIELD_LABEL,
  xhsOpsIsTakeoverImageField,
  xhsOpsProfileCandidatePlan,
  xhsOpsProfileDraftReady,
} from "@nexu/shared";
import { logger } from "../lib/logger.js";
import type {
  XhsOpsProfileApplyCompletion,
  XhsOpsStore,
} from "../store/xhs-ops-store.js";
import {
  type DeviceControlService,
  DeviceControlTimeoutError,
  dispatchRejectionReason,
} from "./device-control-service.js";
import type { XhsOpsAuditService } from "./xhs-ops-audit-service.js";
import {
  XHS_CHANGE_ORDER_TASK_PENDING,
  type XhsOpsChangeOrderApplyOutcome,
  settleChangeOrderApply,
  takeoverProfileField,
} from "./xhs-ops-change-order-rules.js";
import {
  buildPreparationRequest,
  buildPreparationVerificationRequest,
  interpretPreparationResult,
  preparationReason,
} from "./xhs-ops-preparation.js";
import {
  XHS_OPS_DEFAULT_OFFLINE_AFTER_MS,
  XHS_PACKAGE,
  XHS_TAKEOVER_APPLY_TASK_POLICY,
  XHS_TASK_POLICY,
  XhsOpsError,
} from "./xhs-ops-run-service.js";
import {
  XHS_TAKEOVER_UNKNOWN_TASK_ID,
  describeError,
  runTakeoverPhoneTask,
  stopTakeoverPhoneTask,
} from "./xhs-ops-takeover-phone.js";
import {
  XHS_TAKEOVER_TASK_LIMITS,
  type XhsOpsProfileJson,
  type XhsOpsTakeoverApplyField,
  buildAccountIdentityTask,
  buildProfileApplyTask,
  buildProfileReadbackTask,
  buildProfileVerificationTask,
  buildTakeoverProfileApplyTask,
  formatPersona,
  parseAccountIdentityJson,
  parseProfileJson,
  parseProfileReadbackJson,
  parseProfileVerificationJson,
  parseTakeoverProfileJson,
} from "./xhs-ops-task-builder.js";

/**
 * 账号基础资料：服务端生成（昵称/简介走文本生成；头像/背景各 3 张备选走图片
 * 生成）+ 应用到手机（把选中的图推到「Tabby」相册，再下发资料维护任务）。
 * 生成不经过聊天 agent——MediaGenerationService 的 utility lane 已经够用，
 * 且结果直接落库，运营在组件里点选。
 */

export interface XhsOpsProfileMedia {
  generateImage(input: {
    prompt: string;
    count?: number;
    aspectRatio?: string;
    quality?: "auto" | "high" | "medium" | "low";
  }): Promise<{ path: string; items: Array<{ path: string }> }>;
  generateText(input: { prompt: string }): Promise<{ text: string }>;
}

export type XhsOpsProfileDeviceControl = Pick<
  DeviceControlService,
  "getDevice" | "executeTask" | "pushMedia"
> &
  Partial<Pick<DeviceControlService, "cancelTask" | "getTaskResults">>;

export interface XhsOpsProfileServiceDeps {
  store: XhsOpsStore;
  media: XhsOpsProfileMedia;
  deviceControl: XhsOpsProfileDeviceControl;
  /** OpenClaw 媒体根目录（openclawStateDir/media），推送前校验路径不越界。 */
  mediaRoot: string;
  /**
   * Identity reads of existing accounts (takeover N9): the read-only variant
   * under the audit policy, the exclusive lock and the idle check. Without it
   * readIdentity refuses existing accounts.
   */
  takeoverIdentity?: Pick<XhsOpsAuditService, "readTakeoverIdentity">;
  /**
   * How often a change order's running apply task is looked up on the device
   * to persist its id as applyTaskId, so a restart can stop that task by id.
   */
  taskIdPollIntervalMs?: number;
  readFile?: (filePath: string) => Promise<Buffer>;
  now?: () => number;
}

/**
 * Applying a full profile is a long run: eight writable fields, two wheel pickers and a
 * 200+ entry region list. Measured 2026-09-20 — 60 steps ran out mid-region and
 * the 5-minute deadline expired while the phone kept working for 18 minutes,
 * so the desktop reported failure for a task that was still going. The phone's
 * own ceiling is 100 steps; budget to it and give the deadline room to outlast
 * a real run instead of racing it.
 */
/**
 * How far back to look for a receipt the desktop never received. A phone runs
 * one xhs-ops task at a time, so the run being reconciled is within the last
 * few — preparation, apply, and whatever the previous account left behind.
 */
const XHS_RECOVERABLE_RECEIPT_LOOKBACK = 10;

export const XHS_PROFILE_APPLY_TIMEOUT_MS = 1_500_000;
export const XHS_PROFILE_APPLY_MAX_STEPS = 100;
export const XHS_PROFILE_VERIFY_TIMEOUT_MS = 180_000;
export const XHS_PROFILE_VERIFY_MAX_STEPS = 40;
export const XHS_IDENTITY_TIMEOUT_MS = 120_000;
export const XHS_IDENTITY_MAX_STEPS = 20;
export const XHS_READBACK_TIMEOUT_MS = 180_000;
export const XHS_READBACK_MAX_STEPS = 40;

type ProfilePreparationOutcome = {
  reason: string;
  cancellationUnconfirmed: boolean;
};

/** What gateNewAccount hands executeApply. */
interface NewAccountApplyContext {
  account: XhsOpsAccount;
  project: XhsOpsProject;
  deviceId: string;
}

/** A confirmed change order the takeover path may apply (gateChangeOrder). */
interface ChangeOrderApplyContext {
  account: XhsOpsAccount;
  order: XhsOpsChangeOrder;
  operation: XhsOpsProfileApplyOperation;
  deviceId: string;
}

/** The order and account after applyChangeOrder settled the apply step. */
export interface XhsOpsChangeOrderApplyResult {
  order: XhsOpsChangeOrder;
  account: XhsOpsAccount;
  /** A stop went unconfirmed: takeover.deviceHold keeps the device lock. */
  held: boolean;
}

const CHANGE_ORDER_STOP_UNCONFIRMED =
  "手机修改任务停止未确认；本单字段可能已改。请到手机上确认任务已结束，在接管卡片解除后补跑核验";
const CHANGE_ORDER_TASK_ID_POLL_MS = 2_000;

/** The card's receipt box is small; the controller log keeps the full text. */
const MAX_APPLY_RESULT_ERROR_CHARS = 200;

/**
 * A dispatch tabby-control refused outright never reached the phone, so it is
 * neither uncertain nor a lost result: say so, and hand the operator the
 * reason instead of letting reconcile() bury it under the generic "no task
 * result" fallback (which cost hours on 2026-09-20).
 */
function dispatchRejectedResult(reason: string): string {
  return `任务未下发到手机，手机控制端拒绝了本次下发：${reason.slice(
    0,
    MAX_APPLY_RESULT_ERROR_CHARS,
  )}`;
}

const MIME_BY_EXT: Record<string, string> = {
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
};

export function buildProfileTextPrompt(
  project: XhsOpsProject,
  account: XhsOpsAccount,
  /** Today in YYYY-MM-DD; the model needs it to place the birth year. */
  today: string,
): string {
  const persona = formatPersona(account.persona);
  const pool = account.interestPool;
  const profile = project.profile;
  return [
    '为一个小红书 KOC 账号生成公开资料。只输出一行紧凑 JSON：{"nickname":"…","bio":"…","occupation":"…","gender":"…","birthday":"…","region":"…","interestTags":["…"]}，不要解释。',
    `账号定位：${account.label}｜${account.positioning}`,
    persona ? `人设：${persona}` : "",
    `核心兴趣：${pool.core.join("、")}；扩展：${pool.extended.join("、")}；日常：${pool.general.join("、")}`,
    profile ? `目标人群画像：${profile.summary}` : "",
    project.opsNotes.forbiddenTopics.length > 0
      ? `禁忌方向（简介不得涉及）：${project.opsNotes.forbiddenTopics.join("、")}`
      : "",
    "昵称：≤12 字，像真人随手起的，可含表情或小符号，不要「XX官方」「XX团队」模板感，不与定位名完全相同。",
    // The star sign has to survive intact: the birthday is derived from it, so a
    // stray ♎ next to 巨蟹 makes the finished profile contradict itself.
    "简介：三段合一、总长 ≤100 字：①星座+MBTI（自拟，符合人设；星座只写中文名如「巨蟹座」，不要 ♈♉♊ 这类星座符号或 emoji）②一句自我介绍（年龄段/身份/所在地，口语化）③一句兴趣介绍（围绕核心兴趣但像日常分享）。禁止营销话术、联系方式、引流、品牌名。",
    "occupation：必须从人设中的职业/身份原样生成，不能改成泛化或相近职业；如果人设职业为空，留空等待人工选择。",
    'gender：必须是 "男"、"女"、"不展示" 三者之一，与人设一致。',
    "region：人设所在城市，只写城市名（如「上海」「北京」），不带省份或区县。",
    "interestTags：3-5 个小红书兴趣标签，取自上面的核心/扩展兴趣，每个 ≤10 字，不重复、不带井号。",
    `birthday：YYYY-MM-DD，月日必须与简介里写的星座一致；年份按人设年龄推算（今天是 ${today}）。`,
  ]
    .filter((line) => line.length > 0)
    .join("\n");
}

/** First integer in a free-text age such as "27岁" or "28-32岁". */
function parsePersonaAge(age: string): number | null {
  const m = age.match(/\d{1,3}/);
  if (!m) return null;
  const years = Number(m[0]);
  return years >= 10 && years <= 99 ? years : null;
}

/**
 * Build the stored birthday from the model's month/day and the persona age.
 *
 * The month/day comes from the model because the bio states a 星座 and the two
 * must agree, otherwise the profile contradicts itself. The year is always
 * recomputed here: models are unreliable at date arithmetic, and the age the
 * persona claims is the thing that has to hold. Returns "" when there is
 * nothing usable, leaving the field for the operator rather than inventing one.
 */
export function resolveBirthday(
  raw: string,
  personaAge: string,
  nowMs: number,
): string {
  const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return "";
  const month = Number(m[2]);
  const day = Number(m[3]);
  const age = parsePersonaAge(personaAge);
  const now = new Date(nowMs);
  let year = age === null ? Number(m[1]) : now.getUTCFullYear() - age;
  if (age !== null) {
    // A birthday later in the year than today has not happened yet, so the
    // person would still be age-1 this year — shift the birth year back.
    const md = month * 100 + day;
    const todayMd = (now.getUTCMonth() + 1) * 100 + now.getUTCDate();
    if (md > todayMd) year -= 1;
  }
  const iso = `${String(year).padStart(4, "0")}-${m[2]}-${m[3]}`;
  const date = new Date(`${iso}T00:00:00.000Z`);
  // Reject 02-30 and friends, and anything not already in the past.
  if (
    !Number.isFinite(date.getTime()) ||
    date.toISOString().slice(0, 10) !== iso ||
    date.getTime() >= nowMs
  )
    return "";
  return iso;
}

/** Tag lists compare as sets — the phone's ordering is not meaningful. */

/**
 * Compare the phone's current profile against the draft, one field at a time.
 *
 * 头像/背景图 are reported as non-comparable rather than omitted: the operator
 * still has to decide whether to push them, and pretending an image diff exists
 * would be worse than saying plainly that we cannot tell.
 */
export function diffProfileFields(
  draft: XhsOpsProfileDraft,
  phone: {
    nickname: string;
    bio: string;
    occupation?: string;
    gender: string;
    birthday: string;
    region: string;
  },
): XhsOpsProfileFieldDiff[] {
  const text = (
    field: XhsOpsProfileField,
    phoneValue: string | undefined,
    draftValue: string,
  ): XhsOpsProfileFieldDiff => ({
    field,
    comparable: true,
    phone: (phoneValue ?? "").trim(),
    draft: (draftValue ?? "").trim(),
    differs: (phoneValue ?? "").trim() !== (draftValue ?? "").trim(),
  });
  const image = (
    field: XhsOpsProfileField,
    selected: string | null,
  ): XhsOpsProfileFieldDiff => ({
    field,
    comparable: false,
    phone: "",
    draft: selected ? path.basename(selected) : "",
    // Cannot be compared, so it counts as a change whenever there is one to push.
    differs: Boolean(selected),
  });
  return [
    text("nickname", phone.nickname, draft.nickname),
    text("bio", phone.bio, draft.bio),
    text("occupation", phone.occupation, draft.occupation),
    image("avatar", draft.avatarPath),
    image("cover", draft.coverPath),
    text("gender", phone.gender, draft.gender),
    text("birthday", phone.birthday, draft.birthday),
    text("region", phone.region, draft.region),
  ];
}

/**
 * Append the operator's own direction after the built prompt so it wins on
 * conflict, while the baseline framing and the no-text/no-watermark guards stay.
 */
function withPromptHint(prompt: string, hint?: string): string {
  const extra = hint?.trim();
  return extra ? `${prompt}\n补充要求（优先满足）：${extra}` : prompt;
}

export function buildAvatarPrompt(
  account: XhsOpsAccount,
  hint?: string,
): string {
  const p = account.persona;
  const who =
    [p.gender, p.age, p.lifeStatus].filter((x) => x.trim()).join("，") ||
    "一位年轻人";
  return withPromptHint(
    `真实感人像半身照：${who}，自然表情、看向镜头或微侧，自然环境背景（公园/咖啡馆/海边/街道任选），自然光，手机随手拍质感，不要文字、水印、品牌 logo、夸张滤镜。`,
    hint,
  );
}

export function buildCoverPrompt(
  account: XhsOpsAccount,
  hint?: string,
): string {
  const p = account.persona;
  const place = p.region.trim()
    ? `${p.region.trim()}或附近知名景点`
    : "国内知名风景地";
  const who =
    [p.gender, p.age].filter((x) => x.trim()).join("，") || "一位旅行者";
  return withPromptHint(
    `${place}的资料背景风景照，横构图，画面中远处有一位${who}背身望向远方，旅行随拍质感，自然光。背景图只用于个人主页展示，必须是城市或自然风景；不要出现羽毛球场、球拍、运动员、训练场、比赛或其他运动器材，不要把业务兴趣画成内容配图。无文字、无水印、无品牌 logo。`,
    hint,
  );
}

export type ParsedProfileText = {
  nickname: string;
  bio: string;
  occupation?: string;
  /** "" when the model returned nothing usable — the operator still picks. */
  gender: XhsOpsProfileDraft["gender"];
  region: string;
  interestTags: string[];
  /** Raw YYYY-MM-DD from the model; the year is re-derived before it is stored. */
  birthday: string;
};

const PROFILE_GENDERS: ReadonlyArray<XhsOpsProfileDraft["gender"]> = [
  "男",
  "女",
  "不展示",
];

function readGender(value: unknown): XhsOpsProfileDraft["gender"] {
  if (typeof value !== "string") return "";
  const trimmed = value.trim();
  return PROFILE_GENDERS.includes(trimmed as XhsOpsProfileDraft["gender"])
    ? (trimmed as XhsOpsProfileDraft["gender"])
    : "";
}

function readInterestTags(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(/[,，、]/)
      : [];
  const tags: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const tag = entry.trim().slice(0, 20);
    if (tag && !tags.includes(tag)) tags.push(tag);
  }
  return tags.slice(0, 8);
}

export function parseProfileText(text: string): ParsedProfileText {
  const empty = {
    gender: "" as const,
    region: "",
    interestTags: [],
    birthday: "",
  };
  const m = text.match(/\{[\s\S]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as Record<string, unknown>;
      const nickname =
        typeof obj.nickname === "string" ? obj.nickname.trim() : "";
      const bio = typeof obj.bio === "string" ? obj.bio.trim() : "";
      if (nickname || bio)
        return {
          nickname: nickname.slice(0, 20),
          bio: bio.slice(0, 200),
          ...(typeof obj.occupation === "string" && obj.occupation.trim()
            ? { occupation: obj.occupation.trim().slice(0, 80) }
            : {}),
          gender: readGender(obj.gender),
          region:
            typeof obj.region === "string"
              ? obj.region.trim().slice(0, 40)
              : "",
          interestTags: readInterestTags(obj.interestTags),
          birthday: typeof obj.birthday === "string" ? obj.birthday.trim() : "",
        };
    } catch {
      // fall through
    }
  }
  const lines = text
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  return {
    nickname: (lines[0] ?? "").slice(0, 20),
    bio: lines.slice(1).join("\n").slice(0, 200),
    ...empty,
  };
}

/**
 * One rendering for both the live receipt and a recovered one, so an operator
 * cannot tell from the card which path produced it.
 *
 * note carries the phone's own explanation — 「头像因平台 7 天内 3 次修改限制
 * 未能修改」, 「兴趣标签入口未找到」 — and dropping it left every failure
 * looking identical (2026-09-20). The task prompt bars 小红书号 and 生日 from
 * the receipt, and parseProfileJson caps it at 200 chars.
 */
function renderProfileSummary(parsed: XhsOpsProfileJson): string {
  const fields = `昵称=${parsed.nickname} 简介=${parsed.bio} 职业=${parsed.occupation ?? "skipped"} 头像=${parsed.avatar} 背景=${parsed.cover} 性别=${parsed.gender} 生日=${parsed.birthday} 地区=${parsed.region}`;
  const note = parsed.note.trim();
  return note ? `${fields}｜手机说明：${note}` : fields;
}

/**
 * Status from the receipt alone. The phone writes skipped for fields the task
 * never asked about, so the receipt already encodes what was requested — which
 * is what makes it readable without the caller's original field selection.
 */
function applyStatusFromReceipt(
  parsed: XhsOpsProfileJson,
): XhsOpsProfileApplyStatus {
  const outcomes = [
    parsed.nickname,
    parsed.bio,
    ...(parsed.occupation ? [parsed.occupation] : []),
    parsed.avatar,
    parsed.cover,
    parsed.gender,
    parsed.birthday,
    parsed.region,
  ].filter((o) => o !== "skipped");
  const done = outcomes.filter((o) => o === "done").length;
  if (outcomes.length > 0 && done === outcomes.length) return "applied";
  return done > 0 ? "partial" : "failed";
}

export class XhsOpsProfileService {
  private readonly store: XhsOpsStore;
  private readonly media: XhsOpsProfileMedia;
  private readonly deviceControl: XhsOpsProfileDeviceControl;
  private readonly mediaRoot: string;
  private readonly takeoverIdentity: XhsOpsProfileServiceDeps["takeoverIdentity"];
  private readonly taskIdPollIntervalMs: number;
  private readonly readFile: (filePath: string) => Promise<Buffer>;
  private readonly now: () => number;

  constructor(deps: XhsOpsProfileServiceDeps) {
    this.store = deps.store;
    this.media = deps.media;
    this.deviceControl = deps.deviceControl;
    this.mediaRoot = path.resolve(deps.mediaRoot);
    this.takeoverIdentity = deps.takeoverIdentity;
    this.taskIdPollIntervalMs =
      deps.taskIdPollIntervalMs ?? CHANGE_ORDER_TASK_ID_POLL_MS;
    this.readFile = deps.readFile ?? ((p) => fs.readFile(p));
    this.now = deps.now ?? (() => Date.now());
  }

  private nowIso(): string {
    return new Date(this.now()).toISOString();
  }

  private async loadAccount(
    accountId: string,
  ): Promise<{ account: XhsOpsAccount; project: XhsOpsProject }> {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
    const project = await this.store.getProject(account.projectId);
    if (!project) throw new XhsOpsError(404, "项目不存在");
    return { account, project };
  }

  async generate(
    accountId: string,
    parts: XhsOpsProfilePart[],
    /** Operator direction appended to the built image prompts. */
    hints: { avatarPrompt?: string; coverPrompt?: string } = {},
  ): Promise<XhsOpsAccount> {
    const { account, project } = await this.loadAccount(accountId);
    const wanted = new Set(parts);
    let current = account;

    // Persist after every part instead of once at the end. Generation is slow
    // and each part can fail independently upstream; a failure on the cover
    // must not throw away a nickname and three avatars that already succeeded.
    const persist = async (
      mutate: (draft: XhsOpsProfileDraft) => void,
    ): Promise<void> => {
      const draft: XhsOpsProfileDraft = { ...current.profileDraft };
      mutate(draft);
      draft.generatedAt = this.nowIso();
      const updated = await this.store.updateAccount(
        current.id,
        { profileDraft: draft, expectedUpdatedAt: current.updatedAt },
        { invalidateProfileReview: true },
      );
      if (!updated) throw new XhsOpsError(404, "账号不存在");
      current = updated;
    };

    if (wanted.has("text")) {
      const { text } = await this.media.generateText({
        prompt: buildProfileTextPrompt(
          project,
          current,
          this.nowIso().slice(0, 10),
        ),
      });
      const parsed = parseProfileText(text);
      if (!parsed.nickname && !parsed.bio)
        throw new XhsOpsError(409, "文本生成结果无法解析，请重试");
      await persist((draft) => {
        if (parsed.nickname) draft.nickname = parsed.nickname;
        if (parsed.bio) draft.bio = parsed.bio;
        if (parsed.occupation) draft.occupation = parsed.occupation;
        else if (!draft.occupation.trim() && current.persona.occupation.trim())
          draft.occupation = current.persona.occupation.trim();
        // Only fill what the operator has not already decided; anything they
        // already typed wins over the generated value.
        if (parsed.gender && !draft.gender) draft.gender = parsed.gender;
        if (parsed.region && !draft.region.trim()) draft.region = parsed.region;
        if (parsed.interestTags.length > 0 && draft.interestTags.length === 0)
          draft.interestTags = parsed.interestTags;
        if (!draft.birthday.trim()) {
          const birthday = resolveBirthday(
            parsed.birthday,
            current.persona.age,
            this.now(),
          );
          if (birthday) draft.birthday = birthday;
        }
      });
    }
    if (wanted.has("avatar")) {
      const plan = xhsOpsProfileCandidatePlan({
        existing: current.profileDraft.avatarCandidates,
        selected: current.profileDraft.avatarPath,
        reviewedAt: current.profileDraft.reviewedAt,
      });
      const r = await this.media.generateImage({
        prompt: buildAvatarPrompt(current, hints.avatarPrompt),
        count: plan.count,
        aspectRatio: "1:1",
      });
      const produced = (
        r.items.length > 0 ? r.items.map((i) => i.path) : [r.path]
      ).filter(Boolean);
      await persist((draft) => {
        draft.avatarCandidates = [...plan.keep, ...produced].slice(
          0,
          XHS_PROFILE_CANDIDATES,
        );
        if (
          draft.avatarPath &&
          !draft.avatarCandidates.includes(draft.avatarPath)
        )
          draft.avatarPath = null;
      });
    }
    if (wanted.has("cover")) {
      const plan = xhsOpsProfileCandidatePlan({
        existing: current.profileDraft.coverCandidates,
        selected: current.profileDraft.coverPath,
        reviewedAt: current.profileDraft.reviewedAt,
      });
      const r = await this.media.generateImage({
        prompt: buildCoverPrompt(current, hints.coverPrompt),
        count: plan.count,
        aspectRatio: "16:9",
      });
      const produced = (
        r.items.length > 0 ? r.items.map((i) => i.path) : [r.path]
      ).filter(Boolean);
      await persist((draft) => {
        draft.coverCandidates = [...plan.keep, ...produced].slice(
          0,
          XHS_PROFILE_CANDIDATES,
        );
        if (draft.coverPath && !draft.coverCandidates.includes(draft.coverPath))
          draft.coverPath = null;
      });
    }
    return current;
  }

  private async readMediaForPush(
    filePath: string,
    filename: string,
  ): Promise<DevicePushMediaBody["images"][number]> {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(this.mediaRoot + path.sep)) {
      throw new XhsOpsError(400, "图片不在媒体目录内，拒绝推送");
    }
    const ext = path.extname(resolved).toLowerCase();
    const mimeType = MIME_BY_EXT[ext] ?? "image/jpeg";
    const bytes = await this.readFile(resolved);
    return { filename, mimeType, dataBase64: bytes.toString("base64") };
  }

  /**
   * @param fields Restrict the write to these fields. Omitted means every field
   * the draft has filled in — the original behaviour, kept for callers that
   * never diffed. The card always sends an explicit list so the operator's
   * per-field choice is what reaches the phone.
   */
  async apply(
    accountId: string,
    fields?: readonly XhsOpsProfileField[],
  ): Promise<XhsOpsAccount> {
    const ctx = await this.gateNewAccount(accountId);
    return this.executeApply(ctx, fields);
  }

  /**
   * apply() serves new accounts only (takeover §2.5, §5.3 #7). An existing
   * account's public profile changes only through applyChangeOrder: this path
   * runs the login preparation (TYPE, SMS) under XHS_TASK_POLICY, authorizes
   * every photo and pushes generated portraits, none of which may touch a
   * real account.
   */
  private async gateNewAccount(
    accountId: string,
  ): Promise<NewAccountApplyContext> {
    const { account, project } = await this.loadAccount(accountId);
    if (account.entryMode !== "new")
      throw new XhsOpsError(409, "已有账号请先开始接管，资料修改走变更单");
    if (!account.deviceId)
      throw new XhsOpsError(400, "账号未绑定设备，无法应用资料");
    if (!project.profile?.confirmedAt) {
      throw new XhsOpsError(409, "请先确认目标用户画像");
    }
    if (!account.personaReviewedAt) {
      throw new XhsOpsError(409, "请先确认账号人设");
    }
    if (!account.platformAccountId.trim()) {
      throw new XhsOpsError(409, "请先填写并确认目标小红书号");
    }
    if (!xhsOpsProfileDraftReady(account.profileDraft)) {
      throw new XhsOpsError(409, "请先完成账号资料并人工校验确认");
    }
    return { account, project, deviceId: account.deviceId };
  }

  /** The new-account apply: login preparation, apply task, then all-field verification. */
  private async executeApply(
    ctx: NewAccountApplyContext,
    fields?: readonly XhsOpsProfileField[],
  ): Promise<XhsOpsAccount> {
    let account = ctx.account;
    const { project, deviceId } = ctx;
    const accountId = account.id;
    const claimed = await this.store.beginProfileApply(
      account.id,
      account.updatedAt,
      deviceId,
    );
    const operationId = claimed.profileDraft.applyOperation?.operationId;
    if (!operationId)
      throw new XhsOpsError(409, "资料应用任务无法建立操作记录");
    account = claimed;
    let releaseBinding: () => void = () => undefined;
    let completed = false;
    const complete = async (
      completion: XhsOpsProfileApplyCompletion,
    ): Promise<XhsOpsAccount> => {
      const result = await this.store.completeProfileApply(
        accountId,
        operationId,
        completion,
      );
      if (!result) throw new XhsOpsError(404, "账号不存在");
      completed = true;
      return result;
    };
    let operationUncertain = false;
    try {
      releaseBinding = await this.store.acquireDeviceBinding(
        account.id,
        deviceId,
      );
      const draft = account.profileDraft;
      const wanted = fields ? new Set(fields) : null;
      const picked = (field: XhsOpsProfileField) =>
        wanted === null || wanted.has(field);
      const wantNickname =
        picked("nickname") && draft.nickname.trim().length > 0;
      const wantBio = picked("bio") && draft.bio.trim().length > 0;
      const wantOccupation =
        picked("occupation") && draft.occupation.trim().length > 0;
      const wantAvatar = picked("avatar") && Boolean(draft.avatarPath);
      const wantCover = picked("cover") && Boolean(draft.coverPath);
      const wantGender = picked("gender") && Boolean(draft.gender);
      const wantBirthday =
        picked("birthday") && draft.birthday.trim().length > 0;
      const wantRegion = picked("region") && draft.region.trim().length > 0;
      if (
        !wantNickname &&
        !wantBio &&
        !wantOccupation &&
        !wantAvatar &&
        !wantCover &&
        !wantGender &&
        !wantBirthday &&
        !wantRegion
      ) {
        throw new XhsOpsError(
          400,
          fields
            ? "勾选的字段里没有可应用的内容，请重新选择"
            : "没有可应用的资料：先生成/填写昵称、简介或选择头像、背景图",
        );
      }
      const device = await this.deviceControl.getDevice(deviceId);
      if (!device) throw new XhsOpsError(404, "设备不在线");
      if (device.status !== "idle")
        throw new XhsOpsError(409, "设备正在执行其他任务，请稍后再试");

      const preparation = await this.prepareAccount(
        deviceId,
        account.platformAccountId,
      );
      if (preparation !== null) {
        operationUncertain = preparation.cancellationUnconfirmed;
        if (!operationUncertain) {
          await complete({
            applyStatus: "failed",
            applyResult: preparation.reason,
            appliedAt: null,
          });
        }
        throw new XhsOpsError(409, preparation.reason);
      }
      const latestProject = await this.store.getProject(project.id);
      if (!latestProject || latestProject.updatedAt !== project.updatedAt) {
        throw new XhsOpsError(
          409,
          "项目资料已更新，请重新核对目标画像后再应用到手机",
        );
      }

      const short = account.id.slice(0, 8);
      const mediaAlbum = `Tabby/${short}-${operationId.slice(0, 8)}`;
      const images: DevicePushMediaBody["images"] = [];
      let avatarFilename: string | null = null;
      let coverFilename: string | null = null;
      if (wantAvatar && draft.avatarPath) {
        avatarFilename = `tabby-avatar-${short}${path.extname(draft.avatarPath).toLowerCase() || ".jpg"}`;
        images.push(
          await this.readMediaForPush(draft.avatarPath, avatarFilename),
        );
      }
      if (wantCover && draft.coverPath) {
        coverFilename = `tabby-cover-${short}${path.extname(draft.coverPath).toLowerCase() || ".jpg"}`;
        images.push(
          await this.readMediaForPush(draft.coverPath, coverFilename),
        );
      }
      if (images.length > 0) {
        operationUncertain = true;
        const pushed: DevicePushMediaResponse =
          await this.deviceControl.pushMedia(deviceId, {
            album: mediaAlbum,
            images,
          });
        const failed = pushed.results.filter((r) => !r.success);
        operationUncertain = failed.length > 0;
        if (failed.length > 0) {
          throw new XhsOpsError(
            409,
            `图片推送到手机失败：${failed.map((f) => f.error ?? f.mediaId).join("；")}`,
          );
        }
      }

      const task = buildProfileApplyTask({
        label: account.label,
        platformAccountId: account.platformAccountId,
        nickname: wantNickname ? draft.nickname : null,
        bio: wantBio ? draft.bio : null,
        occupation: wantOccupation ? draft.occupation : null,
        avatarFilename,
        coverFilename,
        mediaAlbum,
        gender: (picked("gender") && draft.gender) || null,
        birthday: (picked("birthday") && draft.birthday) || null,
        region: (picked("region") && draft.region) || null,
      });
      const body: DeviceExecuteTaskBody = {
        task,
        allowedApps: [XHS_PACKAGE],
        taskPolicy: XHS_TASK_POLICY,
        maxSteps: XHS_PROFILE_APPLY_MAX_STEPS,
        timeout: XHS_PROFILE_APPLY_TIMEOUT_MS,
      };
      operationUncertain = true;
      const { result } = await this.deviceControl.executeTask(deviceId, body);
      operationUncertain = false;
      const outcome = this.interpret(result, {
        wantNickname,
        wantBio,
        wantOccupation,
        wantAvatar: !!avatarFilename,
        wantCover: !!coverFilename,
        wantGender,
        wantBirthday,
        wantRegion,
      });
      if (outcome.status !== "applied") {
        return await complete({
          taskId: result.taskId,
          appliedAt: outcome.status === "partial" ? this.nowIso() : null,
          applyStatus: outcome.status,
          applyResult: outcome.summary,
        });
      }

      const verificationRequest = buildPreparationVerificationRequest(
        XHS_PACKAGE,
        account.platformAccountId,
      );
      operationUncertain = true;
      const { result: verificationResult } =
        await this.deviceControl.executeTask(deviceId, {
          ...verificationRequest,
          task: buildProfileVerificationTask({
            label: account.label,
            platformAccountId: account.platformAccountId,
            nickname: draft.nickname,
            bio: draft.bio,
            occupation: draft.occupation || null,
            avatarFilename,
            coverFilename,
            gender: draft.gender || null,
            birthday: draft.birthday || null,
            region: draft.region || null,
          }),
          maxSteps: XHS_PROFILE_VERIFY_MAX_STEPS,
          timeout: XHS_PROFILE_VERIFY_TIMEOUT_MS,
        });
      operationUncertain = false;
      const verification = parseProfileVerificationJson(
        verificationResult.message,
        { requireOccupation: wantOccupation },
      );
      const verified =
        verificationResult.success &&
        !verificationResult.needsInteraction &&
        verification?.status === "verified" &&
        hasProfileVerificationEvidence(verificationResult);
      const verificationTaskId = verificationResult.taskId;
      return await complete({
        taskId: verificationTaskId,
        appliedAt: this.nowIso(),
        applyStatus: verified ? "applied" : "partial",
        applyResult: verified
          ? `${wantOccupation ? "八" : "七"}项资料与目标账号已完成只读核验`
          : "资料应用任务已结束，但独立只读核验未通过，请人工检查后重试",
        verifiedAt: verified ? this.nowIso() : null,
        verifiedAccountId: verified ? account.platformAccountId : null,
        verificationTaskId: verified ? verificationTaskId : null,
      });
    } catch (error) {
      // operationUncertain is armed before a dispatch because a task the phone
      // has taken must not be written off. A dispatch the control plane itself
      // refused never got that far, so it is safe to settle here — and the
      // reason is the only place the operator will ever see it.
      const rejected = dispatchRejectionReason(error);
      if (rejected) operationUncertain = false;
      if (
        !completed &&
        !operationUncertain &&
        !(error instanceof DeviceControlTimeoutError)
      ) {
        try {
          await complete({
            applyStatus: "failed",
            applyResult: rejected
              ? dispatchRejectedResult(rejected)
              : "资料应用任务异常结束，请检查手机状态后重试",
            appliedAt: null,
          });
        } catch {
          // Preserve the original error; the operation remains recoverable via its running ledger.
        }
      }
      throw error;
    } finally {
      if (operationUncertain) {
        this.store.markDeviceBindingSettled(account.id, deviceId);
      } else {
        releaseBinding();
      }
    }
  }

  /**
   * Apply a confirmed change order of a taken-over account (§5.2 step 4) —
   * the only way an existing account's public profile changes. The caller
   * (the change-order service) confirmed digest and acks, moved the order to
   * applying with its ledger and albums, and holds the exclusive device lock;
   * it keeps the lock when the result says `held`.
   *
   * No preparation task runs: identity is checked three times without it
   * (precheck readback, the apply task's own 号码比对, the verification). So
   * this path never dispatches account.login with TYPE or the default_sms
   * role, whatever a policy would allow.
   */
  async applyChangeOrder(
    orderId: string,
  ): Promise<XhsOpsChangeOrderApplyResult> {
    const ctx = await this.gateChangeOrder(orderId);
    return this.executeChangeOrderApply(ctx);
  }

  /** Not xhsOpsProfileDraftReady: an order checks its own fields, not nine materials (§5.3 #2). */
  private async gateChangeOrder(
    orderId: string,
  ): Promise<ChangeOrderApplyContext> {
    const order = await this.store.getChangeOrder(orderId);
    if (!order) throw new XhsOpsError(404, "变更单不存在");
    const account = await this.store.getAccount(order.accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
    const takeover = account.takeover;
    if (account.entryMode !== "existing" || !takeover?.authorizedAt)
      throw new XhsOpsError(409, "请先在接管卡片上授权接管该账号");
    if (order.status !== "applying")
      throw new XhsOpsError(409, "变更单不在执行状态");
    const operation = account.profileDraft.applyOperation;
    if (
      !operation ||
      operation.status !== "running" ||
      operation.changeOrderId !== order.id ||
      operation.taskId !== null
    )
      throw new XhsOpsError(409, "变更单的执行记录已变化，请刷新后重试");
    if (
      !takeover.identityConfirmedAt ||
      account.platformAccountId !== order.platformAccountId ||
      !account.deviceId ||
      account.deviceId !== order.deviceId
    )
      throw new XhsOpsError(409, "小红书号或设备已变化，请重新锁定身份");
    if (order.fields.some((entry) => !takeoverProfileField(entry.field)))
      throw new XhsOpsError(409, "变更单含有接管不修改的字段");
    return { account, order, operation, deviceId: account.deviceId };
  }

  /**
   * Push each picture into its own flat album, dispatch the takeover apply
   * task under XHS_TAKEOVER_APPLY_TASK_POLICY and write the receipt back to
   * the order and the ledger in one mutation (settleChangeOrderApply). A
   * CALL_USER or a lost answer stops the phone task by id first — the phone
   * resumes by itself after 60 s otherwise — and an unconfirmed stop holds
   * the device. An aborted or blocked task is still searched for its
   * PROFILE_JSON; without one every field is uncertain.
   */
  private async executeChangeOrderApply(
    ctx: ChangeOrderApplyContext,
  ): Promise<XhsOpsChangeOrderApplyResult> {
    const { order, deviceId } = ctx;
    const applyFields: XhsOpsTakeoverApplyField[] = [];
    // Albums of this attempt that may hold a picture on the phone: one that
    // reported success, and one whose push call itself failed — the picture
    // may have landed before the answer was lost (order.pushedAlbums).
    const pushedAlbums: string[] = [];
    const notDispatched = (reason: string, mayHaveLanded?: string) =>
      this.settleChangeOrder(ctx, {
        kind: "not_dispatched",
        reason,
        pushedAlbums: mayHaveLanded
          ? [...pushedAlbums, mayHaveLanded]
          : pushedAlbums,
      });
    for (const entry of order.fields) {
      const field = takeoverProfileField(entry.field);
      if (!field) continue;
      if (!xhsOpsIsTakeoverImageField(field)) {
        applyFields.push({ field, after: entry.after });
        continue;
      }
      const label = XHS_PROFILE_FIELD_LABEL[field];
      if (!entry.imagePath || !entry.imageSha256 || !entry.mediaAlbum)
        return notDispatched(`${label}的图片或专用相册缺失，请重新上传后预检`);
      const filename = `tabby-${field}-${order.id.slice(0, 8)}${
        path.extname(entry.imagePath).toLowerCase() || ".jpg"
      }`;
      let image: DevicePushMediaBody["images"][number];
      try {
        image = await this.readMediaForPush(entry.imagePath, filename);
      } catch {
        return notDispatched(`${label}的图片读不到了，请重新上传后预检`);
      }
      const sha256 = createHash("sha256")
        .update(Buffer.from(image.dataBase64, "base64"))
        .digest("hex");
      if (sha256 !== entry.imageSha256)
        return notDispatched(`${label}的图片在预检之后被替换，请重新预检`);
      // A push changes no profile field: whatever it threw, no apply task
      // went out, so the order goes back to draft rather than "maybe changed".
      let pushed: DevicePushMediaResponse;
      try {
        pushed = await this.deviceControl.pushMedia(deviceId, {
          album: entry.mediaAlbum,
          images: [image],
        });
      } catch (error) {
        return notDispatched(
          `${label}推送到手机失败：${describeError(error).slice(0, 120)}`,
          entry.mediaAlbum,
        );
      }
      const failed = pushed.results.filter((result) => !result.success);
      if (failed.length > 0 || pushed.results.length === 0)
        return notDispatched(
          `${label}推送到手机失败：${failed
            .map((result) => result.error ?? result.mediaId)
            .join("；")
            .slice(0, 120)}`,
        );
      pushedAlbums.push(entry.mediaAlbum);
      applyFields.push({ field, mediaAlbum: entry.mediaAlbum });
    }
    const fields = applyFields.map((entry) => entry.field);
    const limits = fields.some(xhsOpsIsTakeoverImageField)
      ? XHS_TAKEOVER_TASK_LIMITS.applyImage
      : XHS_TAKEOVER_TASK_LIMITS.applyText;
    const outcome = await runTakeoverPhoneTask(this.deviceControl, {
      deviceId,
      body: {
        task: buildTakeoverProfileApplyTask({
          platformAccountId: order.platformAccountId,
          fields: applyFields,
        }),
        maxSteps: limits.maxSteps,
        timeout: limits.timeoutMs,
        allowedApps: [XHS_PACKAGE],
        taskPolicy: XHS_TAKEOVER_APPLY_TASK_POLICY,
      },
      // The id replaces the "pending" placeholder while the task runs: a
      // restart then stops or reconciles exactly this task (§3.1 表二).
      pollIntervalMs: this.taskIdPollIntervalMs,
      onTaskId: async (taskId) => {
        await this.store.updateChangeOrder(order.id, (current) =>
          current.status === "applying" &&
          current.applyTaskId === XHS_CHANGE_ORDER_TASK_PENDING
            ? { ...current, applyTaskId: taskId }
            : current,
        );
      },
      // §5.2 前提: a phone that is not enforce gets the task stopped at once.
      onPolicyBreach: async (breach) => {
        await this.store.pauseTakeover(ctx.account.id, {
          code: "manual",
          reason: breach.reason,
          sourceRef: order.id,
        });
      },
    });
    if (outcome.kind === "rejected")
      return notDispatched(dispatchRejectedResult(outcome.reason));
    if (outcome.kind === "policy") {
      // Stopped mid-way: every field may have changed (§5.2 step 4).
      const { breach } = outcome;
      const taskId = breach.taskId ?? outcome.result?.taskId ?? null;
      const reason = `${breach.reason}；本单字段可能已改，换用 enforce 构建后请补跑核验`;
      if (!breach.stopped)
        return this.stopChangeOrderTask(ctx, taskId, {
          message: outcome.result?.message,
          reason,
        });
      return this.settleChangeOrder(ctx, {
        kind: "ended",
        taskId,
        receipt: parseTakeoverProfileJson(outcome.result?.message, fields),
        completed: false,
        reason,
      });
    }
    if (outcome.kind === "lost") {
      const taskId = outcome.taskId ?? (await this.currentTaskOf(deviceId));
      return this.stopChangeOrderTask(ctx, taskId, {
        message: undefined,
        reason: outcome.timedOut
          ? "手机修改任务超时，已停止；本单字段可能已改，请补跑核验"
          : "与手机的连接中断，修改任务已停止；本单字段可能已改，请补跑核验",
      });
    }
    const result = outcome.result;
    if (result.needsInteraction)
      return this.stopChangeOrderTask(ctx, result.taskId, {
        message: result.message,
        reason:
          "手机修改任务请求人工处理，已停止；本单字段可能已改，请补跑核验",
      });
    return this.settleChangeOrder(ctx, {
      kind: "ended",
      taskId: result.taskId,
      receipt: parseTakeoverProfileJson(result.message, fields),
      completed: true,
      reason: result.success
        ? null
        : `手机修改任务没有正常结束（${result.status ?? "failed"}）`,
    });
  }

  /** A task that may still run: stop it by id; unconfirmed, hold the device and keep the ledger running. */
  private async stopChangeOrderTask(
    ctx: ChangeOrderApplyContext,
    taskId: string | null,
    input: { message: string | undefined; reason: string },
  ): Promise<XhsOpsChangeOrderApplyResult> {
    const fields = ctx.order.fields.flatMap((entry) => {
      const field = takeoverProfileField(entry.field);
      return field ? [field] : [];
    });
    if (await stopTakeoverPhoneTask(this.deviceControl, ctx.deviceId, taskId))
      return this.settleChangeOrder(ctx, {
        kind: "ended",
        taskId,
        receipt: parseTakeoverProfileJson(input.message, fields),
        completed: false,
        reason: input.reason,
      });
    try {
      await this.store.holdTakeoverDevice(ctx.account.id, {
        taskId: taskId ?? XHS_TAKEOVER_UNKNOWN_TASK_ID,
        sourceRef: ctx.order.id,
      });
    } catch (error) {
      // The device lock still stays with this account (held below).
      logger.warn(
        { orderId: ctx.order.id, error: describeError(error) },
        "xhs-ops: change order device hold failed",
      );
    }
    // The reconcile sweep may fetch the receipt once the phone is idle.
    this.store.markDeviceBindingSettled(ctx.account.id, ctx.deviceId);
    logger.warn(
      { orderId: ctx.order.id, deviceId: ctx.deviceId, taskId },
      "xhs-ops: change order apply stop unconfirmed, device held",
    );
    const settled = await this.settleChangeOrder(ctx, {
      kind: "unconfirmed",
      taskId,
      reason: CHANGE_ORDER_STOP_UNCONFIRMED,
    });
    return { ...settled, held: true };
  }

  private async currentTaskOf(deviceId: string): Promise<string | null> {
    try {
      const device = await this.deviceControl.getDevice(deviceId);
      return device?.status === "busy" ? (device.currentTaskId ?? null) : null;
    } catch {
      return null;
    }
  }

  private async settleChangeOrder(
    ctx: ChangeOrderApplyContext,
    outcome: XhsOpsChangeOrderApplyOutcome,
  ): Promise<XhsOpsChangeOrderApplyResult> {
    const settled = await this.store.mutateTakeover(
      ctx.account.id,
      (snapshot) => {
        const order = snapshot.changeOrders.find(
          (entry) => entry.id === ctx.order.id,
        );
        if (!order) return { result: null };
        const next = settleChangeOrderApply({
          account: snapshot.account,
          order,
          outcome,
          now: snapshot.now,
          mode: "live",
        });
        return {
          account: next.account,
          changeOrders: [next.order],
          result: next.order,
        };
      },
    );
    const order = settled.result ?? ctx.order;
    logger.info(
      {
        orderId: order.id,
        accountId: settled.account.id,
        outcome: outcome.kind,
        status: order.status,
        fields: order.fields.map((entry) => `${entry.field}:${entry.outcome}`),
      },
      "xhs-ops: change order apply settled",
    );
    return { order, account: settled.account, held: false };
  }

  /**
   * Restart reconcile of a change order's ledger (§2.6, §5.2 状态表): the
   * receipt tabby-control kept — by applyTaskId once known, otherwise the
   * newest PROFILE_JSON since the ledger started — is written back to the
   * order, which stays interrupted for verify. Without one every unsettled
   * field becomes uncertain.
   */
  private async reconcileChangeOrder(
    account: XhsOpsAccount,
    operation: XhsOpsProfileApplyOperation,
  ): Promise<XhsOpsAccount | null> {
    const orderId = operation.changeOrderId;
    const order = orderId ? await this.store.getChangeOrder(orderId) : null;
    const recovered = order
      ? await this.recoverChangeOrderReceipt(order, operation)
      : null;
    try {
      const fields = (order?.fields ?? []).flatMap((entry) => {
        const field = takeoverProfileField(entry.field);
        return field ? [field] : [];
      });
      const settled = await this.store.mutateTakeover(
        account.id,
        (snapshot) => {
          const ledger = snapshot.account.profileDraft.applyOperation;
          if (
            !ledger ||
            ledger.operationId !== operation.operationId ||
            ledger.status !== "running"
          )
            return { result: null };
          const current = snapshot.changeOrders.find(
            (entry) => entry.id === orderId,
          );
          if (!current)
            return {
              account: {
                ...snapshot.account,
                profileDraft: {
                  ...snapshot.account.profileDraft,
                  applyOperation: {
                    ...ledger,
                    status: "completed",
                    completedAt: snapshot.now,
                  },
                },
              },
              result: null,
            };
          // A task stopped after the restart is recovered too, but its
          // result carries no PROFILE_JSON: say so rather than "recovered".
          const receipt = parseTakeoverProfileJson(recovered?.message, fields);
          const next = settleChangeOrderApply({
            account: snapshot.account,
            order: current,
            outcome: {
              kind: "ended",
              taskId: recovered?.taskId ?? null,
              receipt,
              completed: recovered !== null,
              reason: receipt.extracted
                ? "桌面端当时已断开，已事后取回修改回执"
                : "桌面端未收到手机修改任务的回执，设备已空闲；本单字段可能已改，请补跑核验",
            },
            now: snapshot.now,
            mode: "recovered",
          });
          return {
            account: next.account,
            changeOrders: [next.order],
            result: null,
          };
        },
      );
      return settled.account;
    } finally {
      this.store.releaseDeviceBinding(account.id, operation.deviceId);
    }
  }

  private async recoverChangeOrderReceipt(
    order: XhsOpsChangeOrder,
    operation: XhsOpsProfileApplyOperation,
  ): Promise<{ taskId: string; message: string | undefined } | null> {
    const fetch = this.deviceControl.getTaskResults;
    if (!fetch) return null;
    const startedAt = Date.parse(operation.startedAt);
    const taskId =
      order.applyTaskId && order.applyTaskId !== XHS_CHANGE_ORDER_TASK_PENDING
        ? order.applyTaskId
        : null;
    const fields: XhsOpsTakeoverProfileField[] = order.fields.flatMap(
      (entry) => {
        const field = takeoverProfileField(entry.field);
        return field ? [field] : [];
      },
    );
    try {
      const entries = await fetch.call(
        this.deviceControl,
        taskId
          ? { taskId, deviceId: operation.deviceId }
          : {
              deviceId: operation.deviceId,
              limit: XHS_RECOVERABLE_RECEIPT_LOOKBACK,
            },
      );
      const mine = entries
        .filter((entry) =>
          taskId
            ? entry.taskId === taskId
            : Number.isFinite(startedAt) &&
              entry.completedAt >= startedAt &&
              parseTakeoverProfileJson(entry.result.message, fields).extracted,
        )
        .sort((a, b) => b.completedAt - a.completedAt)[0];
      return mine
        ? { taskId: mine.result.taskId, message: mine.result.message }
        : null;
    } catch (error) {
      logger.warn(
        { orderId: order.id, error: describeError(error) },
        "xhs-ops: change order receipt recovery failed",
      );
      return null;
    }
  }

  /**
   * Park the bound phone on 编辑主页 and hand the operator the screenshot, so
   * they can see which account is actually signed in before pinning it.
   *
   * Strictly read-only, and the id is never echoed into the receipt — only the
   * screenshot carries it. See buildAccountIdentityTask for why.
   */
  async readIdentity(accountId: string): Promise<XhsOpsAccountIdentity> {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
    // An existing account's phone holds a real account: never the
    // new-account task under XHS_TASK_POLICY (TYPE, login not forbidden).
    if (account.entryMode === "existing") {
      if (!this.takeoverIdentity)
        throw new XhsOpsError(409, "已有账号请在接管卡片上读取手机当前账号");
      return (await this.takeoverIdentity.readTakeoverIdentity(accountId))
        .identity;
    }
    if (account.profileDraft.applyOperation?.status === "running") {
      throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
    }
    const deviceId = account.deviceId;
    if (!deviceId) {
      throw new XhsOpsError(
        409,
        "该账号未绑定设备，绑定后才能读取手机上的账号",
      );
    }

    let result: TaskResult;
    try {
      ({ result } = await this.deviceControl.executeTask(deviceId, {
        task: buildAccountIdentityTask(),
        maxSteps: XHS_IDENTITY_MAX_STEPS,
        timeout: XHS_IDENTITY_TIMEOUT_MS,
        allowedApps: [XHS_PACKAGE],
        taskPolicy: XHS_TASK_POLICY,
      }));
    } catch (error) {
      return {
        status: "unavailable",
        screenshotUrl: null,
        taskId: "",
        accountId: "",
        reason:
          error instanceof DeviceControlTimeoutError
            ? "读取超时，请确认手机在线且当前没有其他任务后重试"
            : "读取执行失败，请检查手机状态后重试",
      };
    }

    const screenshot = result.finalScreenshot?.trim();
    if (!result.success || result.needsInteraction || !screenshot) {
      return {
        status: "unavailable",
        screenshotUrl: null,
        accountId: "",
        taskId: result.taskId,
        reason: result.needsInteraction
          ? "手机上还需要人工处理（例如登录或验证），处理后再试"
          : "没有取到编辑主页截图；请确认手机已登录小红书后重试",
      };
    }
    const identity = parseAccountIdentityJson(result.message);
    const readId = identity?.status === "visible" ? identity.accountId : "";
    return {
      status: "visible",
      screenshotUrl: `/api/v1/media/screenshots/${path.basename(screenshot)}`,
      accountId: readId,
      taskId: result.taskId,
      reason: readId
        ? "已读到手机上的小红书号并填入；请对照截图确认是你要养的号，不对可直接改"
        : "已停在编辑主页，但没读出小红书号；请对照截图手动填写",
    };
  }

  /**
   * Read the phone's current profile and diff it against the draft.
   *
   * Without this, 「应用」 rewrites every filled draft field unconditionally, so
   * anything the operator had tuned by hand on the phone disappeared with no
   * warning. 头像/背景图 come back as non-comparable: an image cannot be
   * matched as text, so they stay an explicit overwrite.
   */
  async readbackProfile(accountId: string): Promise<XhsOpsProfileReadback> {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
    if (account.profileDraft.applyOperation?.status === "running") {
      throw new XhsOpsError(409, "账号资料正在应用到手机，请等待任务结束");
    }
    const deviceId = account.deviceId;
    if (!deviceId) {
      throw new XhsOpsError(409, "该账号未绑定设备，绑定后才能回读手机资料");
    }

    let result: TaskResult;
    try {
      ({ result } = await this.deviceControl.executeTask(deviceId, {
        task: buildProfileReadbackTask(),
        maxSteps: XHS_READBACK_MAX_STEPS,
        timeout: XHS_READBACK_TIMEOUT_MS,
        allowedApps: [XHS_PACKAGE],
        taskPolicy: XHS_TASK_POLICY,
      }));
    } catch (error) {
      return {
        status: "unavailable",
        taskId: "",
        screenshotUrl: null,
        reason:
          error instanceof DeviceControlTimeoutError
            ? "回读超时，请确认手机在线且当前没有其他任务后重试"
            : "回读执行失败，请检查手机状态后重试",
        fields: [],
      };
    }

    const screenshot = result.finalScreenshot?.trim();
    const screenshotUrl = screenshot
      ? `/api/v1/media/screenshots/${path.basename(screenshot)}`
      : null;
    const values = parseProfileReadbackJson(result.message);
    if (
      !result.success ||
      result.needsInteraction ||
      !values ||
      values.status !== "read"
    ) {
      return {
        status: "unavailable",
        taskId: result.taskId,
        screenshotUrl,
        reason: result.needsInteraction
          ? "手机上还需要人工处理（例如登录或验证），处理后再试"
          : "没有读到手机上的资料；请确认已登录小红书并能打开编辑资料页",
        fields: [],
      };
    }

    return {
      status: "read",
      taskId: result.taskId,
      screenshotUrl,
      reason: "已读取手机当前资料；勾选要覆盖的字段后再应用",
      fields: diffProfileFields(account.profileDraft, values),
    };
  }

  /**
   * Resolve a profile operation left running after a controller/RPC failure.
   *
   * The phone keeps working when the desktop's RPC dies, and tabby-control
   * retains the result it could not deliver — so ask for it before declaring
   * anything lost. On 2026-09-20 a controller restart mid-apply cost a 21
   * minute run that had in fact succeeded on six of eight fields; the receipt
   * was sitting in the plugin the whole time and had to be fetched by hand.
   *
   * Only when no receipt can be recovered does an idle device become the
   * terminal signal, recorded as failed and kept behind manual review.
   */
  async reconcile(accountId: string): Promise<XhsOpsAccount | null> {
    const account = await this.store.getAccount(accountId);
    if (!account) return null;
    const operation = account.profileDraft.applyOperation;
    if (!operation || operation.status !== "running") return account;
    if (this.store.isDeviceBindingActive(account.id, operation.deviceId))
      return account;
    const device = await this.deviceControl.getDevice(operation.deviceId);
    if (
      !device ||
      device.status !== "idle" ||
      device.currentTaskId ||
      !Number.isFinite(device.lastSeen) ||
      this.now() - device.lastSeen > XHS_OPS_DEFAULT_OFFLINE_AFTER_MS
    ) {
      return account;
    }
    if (operation.changeOrderId !== null)
      return this.reconcileChangeOrder(account, operation);
    const recovered = await this.recoverApplyReceipt(operation);
    try {
      return await this.store.completeProfileApply(
        account.id,
        operation.operationId,
        recovered ?? {
          applyStatus: "failed",
          applyResult:
            "桌面端未收到手机任务结果，当前设备已空闲；请人工检查资料是否生效后重试",
          appliedAt: null,
        },
      );
    } finally {
      this.store.releaseDeviceBinding(account.id, operation.deviceId);
    }
  }

  /**
   * Ask tabby-control for the receipt this operation never received.
   *
   * Guarded on the operation's own start time: one phone runs one account at a
   * time under the device binding, so a PROFILE_JSON receipt that landed after
   * this operation began is this operation's. Anything older belongs to an
   * earlier run and is ignored.
   *
   * Best-effort by design — an older plugin without the call, or a plugin that
   * errors, simply leaves the caller on the original "no result" path.
   */
  private async recoverApplyReceipt(operation: {
    deviceId: string;
    startedAt: string;
  }): Promise<XhsOpsProfileApplyCompletion | null> {
    const fetch = this.deviceControl.getTaskResults;
    if (!fetch) return null;
    const startedAt = Date.parse(operation.startedAt);
    if (!Number.isFinite(startedAt)) return null;
    let retained: Awaited<ReturnType<DeviceControlService["getTaskResults"]>>;
    try {
      retained = await fetch.call(this.deviceControl, {
        deviceId: operation.deviceId,
        limit: XHS_RECOVERABLE_RECEIPT_LOOKBACK,
      });
    } catch {
      return null;
    }
    const mine = retained
      .filter((entry) => entry.completedAt >= startedAt)
      .sort((a, b) => b.completedAt - a.completedAt);
    for (const entry of mine) {
      const parsed = parseProfileJson(entry.result.message);
      if (!parsed) continue;
      const status = applyStatusFromReceipt(parsed);
      return {
        taskId: entry.result.taskId,
        applyStatus: status,
        // Only the apply ran; the independent read-only check never got its
        // turn, so this must not look verified however well the fields went.
        applyResult: `${renderProfileSummary(parsed)}（桌面端当时已断开，结果为事后补记；独立核验未执行）`,
        appliedAt: status === "failed" ? null : this.nowIso(),
      };
    }
    return null;
  }

  /** Sweep persisted operations after a controller restart and at intervals. */
  async reconcileRunningOperations(): Promise<void> {
    const projects = await this.store.listProjects();
    for (const project of projects) {
      const accounts = await this.store.listAccountsByProject(project.id);
      for (const account of accounts) {
        if (account.profileDraft.applyOperation?.status !== "running") continue;
        try {
          await this.reconcile(account.id);
        } catch {
          // A phone that is offline remains running until a later sweep can prove it is idle.
        }
      }
    }
  }

  private interpret(
    result: TaskResult,
    want: {
      wantNickname: boolean;
      wantBio: boolean;
      wantOccupation: boolean;
      wantAvatar: boolean;
      wantCover: boolean;
      wantGender: boolean;
      wantBirthday: boolean;
      wantRegion: boolean;
    },
  ): { status: XhsOpsProfileApplyStatus; summary: string } {
    const parsed = parseProfileJson(result.message);
    if (!result.success || result.needsInteraction || !parsed) {
      return {
        status: "failed",
        summary: "手机未返回可信的资料应用结果，请人工检查后重试",
      };
    }
    const requested: Array<[keyof typeof want, keyof typeof parsed]> = [
      ["wantNickname", "nickname"],
      ["wantBio", "bio"],
      ["wantOccupation", "occupation"],
      ["wantAvatar", "avatar"],
      ["wantCover", "cover"],
      ["wantGender", "gender"],
      ["wantBirthday", "birthday"],
      ["wantRegion", "region"],
    ];
    const outcomes = requested
      .filter(([w]) => want[w])
      .map(([, k]) => parsed[k] as string);
    const done = outcomes.filter((o) => o === "done").length;
    const status: XhsOpsProfileApplyStatus =
      outcomes.length > 0 && done === outcomes.length
        ? "applied"
        : done > 0
          ? "partial"
          : "failed";
    // The phone explains itself in note, and dropping it cost an afternoon:
    // 「头像因平台 7 天内 3 次修改限制未能修改」 and 「兴趣标签入口未找到」 were
    // both sitting in there while the card showed nothing but failed=failed
    // and the reason had to be dug out of a retained task result by hand
    // (2026-09-20). The prompt already bars 小红书号 and 生日 from the receipt.
    return { status, summary: renderProfileSummary(parsed) };
  }

  private async prepareAccount(
    deviceId: string,
    platformAccountId: string,
  ): Promise<ProfilePreparationOutcome | null> {
    let result: TaskResult;
    try {
      ({ result } = await this.deviceControl.executeTask(
        deviceId,
        buildPreparationRequest(XHS_PACKAGE, platformAccountId),
      ));
      if (
        result.success &&
        !result.needsInteraction &&
        interpretPreparationResult(result).reasonCode === "invalid_result"
      ) {
        ({ result } = await this.deviceControl.executeTask(
          deviceId,
          buildPreparationVerificationRequest(XHS_PACKAGE, platformAccountId),
        ));
      }
    } catch (error) {
      const rejected = dispatchRejectionReason(error);
      return rejected
        ? {
            reason: dispatchRejectedResult(rejected),
            cancellationUnconfirmed: false,
          }
        : {
            reason: "安装、登录或目标账号核验执行失败，请检查手机后重试",
            cancellationUnconfirmed: true,
          };
    }
    const preparation = interpretPreparationResult(result);
    if (result.needsInteraction) {
      const cancelled = this.deviceControl.cancelTask
        ? await this.deviceControl
            .cancelTask(deviceId, { taskId: result.taskId })
            .then((response) => response.cancelled)
            .catch(() => false)
        : false;
      if (!cancelled) {
        return {
          reason: "手机登录任务停止未确认，请确认任务结束后重启桌面端再试",
          cancellationUnconfirmed: true,
        };
      }
    }
    return preparation.status === "ready"
      ? null
      : {
          reason: preparation.reason ?? preparationReason("invalid_result"),
          cancellationUnconfirmed: false,
        };
  }
}

export function hasProfileVerificationEvidence(result: TaskResult): boolean {
  if (!result.taskId.trim()) return false;
  if (result.finalScreenshot?.trim()) return true;
  const successful = (result.steps ?? []).filter((step) => step.success);
  return (
    successful.some((step) => step.action.toUpperCase() === "AWAKE") &&
    successful.some((step) => step.action.toUpperCase() === "CLICK")
  );
}
