import { promises as fs } from "node:fs";
import path from "node:path";
import type {
  DeviceExecuteTaskBody,
  DevicePushMediaBody,
  DevicePushMediaResponse,
  TaskResult,
  XhsOpsAccount,
  XhsOpsAccountIdentity,
  XhsOpsProfileApplyStatus,
  XhsOpsProfileDraft,
  XhsOpsProfileField,
  XhsOpsProfileFieldDiff,
  XhsOpsProfilePart,
  XhsOpsProfileReadback,
  XhsOpsProject,
} from "@nexu/shared";
import {
  XHS_PROFILE_CANDIDATES,
  xhsOpsProfileCandidatePlan,
  xhsOpsProfileDraftReady,
} from "@nexu/shared";
import type {
  XhsOpsProfileApplyCompletion,
  XhsOpsStore,
} from "../store/xhs-ops-store.js";
import {
  type DeviceControlService,
  DeviceControlTimeoutError,
  dispatchRejectionReason,
} from "./device-control-service.js";
import {
  buildPreparationRequest,
  buildPreparationVerificationRequest,
  interpretPreparationResult,
  preparationReason,
} from "./xhs-ops-preparation.js";
import {
  XHS_OPS_DEFAULT_OFFLINE_AFTER_MS,
  XHS_PACKAGE,
  XHS_TASK_POLICY,
  XhsOpsError,
} from "./xhs-ops-run-service.js";
import {
  buildAccountIdentityTask,
  buildProfileApplyTask,
  buildProfileReadbackTask,
  buildProfileVerificationTask,
  formatPersona,
  parseAccountIdentityJson,
  parseProfileJson,
  parseProfileReadbackJson,
  parseProfileVerificationJson,
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
  Partial<Pick<DeviceControlService, "cancelTask">>;

export interface XhsOpsProfileServiceDeps {
  store: XhsOpsStore;
  media: XhsOpsProfileMedia;
  deviceControl: XhsOpsProfileDeviceControl;
  /** OpenClaw 媒体根目录（openclawStateDir/media），推送前校验路径不越界。 */
  mediaRoot: string;
  readFile?: (filePath: string) => Promise<Buffer>;
  now?: () => number;
}

/**
 * Applying a full profile is a long run: eight fields, two wheel pickers and a
 * 200+ entry region list. Measured 2026-09-20 — 60 steps ran out mid-region and
 * the 5-minute deadline expired while the phone kept working for 18 minutes,
 * so the desktop reported failure for a task that was still going. The phone's
 * own ceiling is 100 steps; budget to it and give the deadline room to outlast
 * a real run instead of racing it.
 */
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
    '为一个小红书 KOC 账号生成公开资料。只输出一行紧凑 JSON：{"nickname":"…","bio":"…","gender":"…","birthday":"…","region":"…","interestTags":["…"]}，不要解释。',
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
    gender: string;
    birthday: string;
    region: string;
  },
): XhsOpsProfileFieldDiff[] {
  const text = (
    field: XhsOpsProfileField,
    phoneValue: string,
    draftValue: string,
  ): XhsOpsProfileFieldDiff => ({
    field,
    comparable: true,
    phone: phoneValue.trim(),
    draft: draftValue.trim(),
    differs: phoneValue.trim() !== draftValue.trim(),
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
    `${place}的风景照，横构图，画面中远处有一位${who}背身望向远方，旅行随拍质感，自然光，无文字、无水印、无品牌 logo。`,
    hint,
  );
}

export type ParsedProfileText = {
  nickname: string;
  bio: string;
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

export class XhsOpsProfileService {
  private readonly store: XhsOpsStore;
  private readonly media: XhsOpsProfileMedia;
  private readonly deviceControl: XhsOpsProfileDeviceControl;
  private readonly mediaRoot: string;
  private readonly readFile: (filePath: string) => Promise<Buffer>;
  private readonly now: () => number;

  constructor(deps: XhsOpsProfileServiceDeps) {
    this.store = deps.store;
    this.media = deps.media;
    this.deviceControl = deps.deviceControl;
    this.mediaRoot = path.resolve(deps.mediaRoot);
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
    let { account, project } = await this.loadAccount(accountId);
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
      throw new XhsOpsError(409, "请先完成八项账号资料并人工校验确认");
    }
    const deviceId = account.deviceId;
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
      const wantAvatar = picked("avatar") && Boolean(draft.avatarPath);
      const wantCover = picked("cover") && Boolean(draft.coverPath);
      const wantGender = picked("gender") && Boolean(draft.gender);
      const wantBirthday =
        picked("birthday") && draft.birthday.trim().length > 0;
      const wantRegion = picked("region") && draft.region.trim().length > 0;
      if (
        !wantNickname &&
        !wantBio &&
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
          await this.deviceControl.pushMedia(deviceId, { images });
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
        avatarFilename,
        coverFilename,
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
          ? "七项资料与目标账号已完成只读核验"
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
   * Park the bound phone on 编辑主页 and hand the operator the screenshot, so
   * they can see which account is actually signed in before pinning it.
   *
   * Strictly read-only, and the id is never echoed into the receipt — only the
   * screenshot carries it. See buildAccountIdentityTask for why.
   */
  async readIdentity(accountId: string): Promise<XhsOpsAccountIdentity> {
    const account = await this.store.getAccount(accountId);
    if (!account) throw new XhsOpsError(404, "账号不存在");
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
   * An idle device is the only terminal signal we can trust without a task
   * receipt; it is therefore recorded as failed and kept behind manual review.
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
    try {
      return await this.store.completeProfileApply(
        account.id,
        operation.operationId,
        {
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
    const summary = `昵称=${parsed.nickname} 简介=${parsed.bio} 头像=${parsed.avatar} 背景=${parsed.cover} 性别=${parsed.gender} 生日=${parsed.birthday} 地区=${parsed.region}`;
    return { status, summary };
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
