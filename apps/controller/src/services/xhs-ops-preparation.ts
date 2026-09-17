import type {
  DeviceExecuteTaskBody,
  TaskResult,
  XhsOpsPreparation,
  XhsOpsPreparationCode,
} from "@nexu/shared";
import { z } from "zod";

export const XHS_PREPARATION_TIMEOUT_MS = 600_000;
export const XHS_PREPARATION_MARKER = "PREPARATION_JSON:";
// PhoneAgentRunner appends this machine receipt after the model's last line.
const ACTION_RECEIPT_LINE =
  /^\[回执\] 各应用生效点击: (?:[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+|unknown)=[1-9]\d*(?:, (?:[A-Za-z0-9_]+(?:\.[A-Za-z0-9_]+)+|unknown)=[1-9]\d*)*$/;

const preparationReceiptSchema = z.discriminatedUnion("status", [
  z
    .object({
      v: z.literal(1),
      status: z.literal("ready"),
      code: z.literal("ready"),
      profileVerified: z.literal(true),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      status: z.literal("blocked"),
      code: z.enum([
        "phone_required",
        "verification_required",
        "sms_unavailable",
        "account_mismatch",
        "store_unavailable",
        "account_restricted",
        "rate_limited",
      ]),
      profileVerified: z.literal(false),
    })
    .strict(),
  z
    .object({
      v: z.literal(1),
      status: z.literal("failed"),
      code: z.enum(["install_failed", "login_failed"]),
      profileVerified: z.literal(false),
    })
    .strict(),
]);

const REASONS: Record<XhsOpsPreparationCode, string> = {
  ready: "小红书已安装，已验证登录后的个人主页",
  phone_required: "需要在手机上确认或填写本次登录手机号，处理后重新启动养号",
  verification_required:
    "需要在手机上完成登录确认或身份验证，处理后重新启动养号",
  sms_unavailable: "未能取得本次验证码，请在手机上完成登录后重新启动养号",
  account_mismatch: "手机上出现其他账号，请确认账号后重新启动养号",
  store_unavailable:
    "官方应用市场不可用或需要人工处理，请安装小红书后重新启动养号",
  install_failed: "小红书安装未完成，养号未开始",
  login_failed: "小红书登录未完成，养号未开始",
  account_restricted: "账号受限，今日后续任务已暂停",
  rate_limited: "操作过于频繁，今日后续任务已暂停",
  invalid_result: "启动检查未返回有效的登录验证结果，养号未开始",
  device_unavailable: "设备不可用或等待空闲超时，启动检查未完成",
  dispatch_failed:
    "启动检查执行失败、超时或未确认停止，请先在手机上确认当前任务已结束，再重新启动养号",
  interrupted: "控制器重启，启动检查已中断，请检查手机状态后重新启动养号",
  cancelled: "启动检查已取消，养号未开始",
};

export function preparationReason(code: XhsOpsPreparationCode): string {
  return REASONS[code];
}

export function isPreparationSafetyStop(
  code: string | null | undefined,
): code is "account_restricted" | "rate_limited" {
  return code === "account_restricted" || code === "rate_limited";
}

export function interruptPreparation(
  preparation: XhsOpsPreparation,
  completedAt: string,
): XhsOpsPreparation {
  const code = isPreparationSafetyStop(preparation.reasonCode)
    ? preparation.reasonCode
    : "interrupted";
  return {
    ...preparation,
    status: "interrupted",
    reasonCode: code,
    reason: REASONS[code],
    completedAt,
  };
}

export function buildPreparationRequest(
  packageName: string,
  expectedPlatformAccountId = "",
): DeviceExecuteTaskBody {
  const expectedId = expectedPlatformAccountId.trim();
  const identityInstruction = expectedId
    ? `进入“我”后打开编辑主页，只读取并逐字比较“小红书号”是否为任务指定值「${expectedId}」。完全一致才可继续；不一致返回 account_mismatch，不得退出、切换或修改账号。回执和过程记录不得复述该号码。`
    : "本次未提供目标小红书号，只能验证存在已登录个人主页；不得据此声称已核对具体账号身份。";
  return {
    task: [
      "养号启动检查：仅完成小红书安装与手机号验证码登录准备，不执行浏览、点赞、收藏、关注、评论、发布、私信或资料修改。",
      '先用 LOAD_SKILL value:"login" 加载小红书安装与自动登录子技能；需要安装时使用 app.install.official_store，需要验证码时使用 sms.verification。不要加载 research 或 nurture 子技能。',
      `先 AWAKE 打开 ${packageName}；只有明确报告未安装才通过 AWAKE store:${packageName} 进入官方应用市场下载安装。不得通过浏览器或第三方 APK 下载，商店登录/付款/无法确认安装目标时停止并请求人工处理。安装后必须再次打开目标 App。`,
      "进入小红书底部“我”检查登录状态。已登录并看到个人主页、昵称和作品区就结束准备；禁止退出已有账号或切换账号。检测到其他账号时返回 account_mismatch。",
      identityInstruction,
      "未登录时按 login 子技能使用手机号验证码登录。手机号只能来自本次任务明确提供或页面已显示且用户已确认的号码；没有可靠号码就停止，返回 phone_required 并请用户在手机上确认或填写，不能猜测本机号码。",
      "验证码只使用本次小红书登录请求的系统自动填充、新通知或默认短信 App 的最新匹配短信，读取后立即回到小红书填写，错误或过期最多重发一次。不得读取无关短信、回显手机号或验证码，也不得将它们写入动作说明、进度、日志或结果。",
      "需要登录确认、滑块、图形验证码、实名、人脸或其他人工验证时停止并返回 verification_required；不要绕过。验证码不可得返回 sms_unavailable；账号受限返回 account_restricted；频率限制返回 rate_limited。",
      "只有进入“我”并确认个人主页而非登录入口，才可报告 ready 和 profileVerified:true。安装或登录失败分别返回 install_failed/login_failed，官方市场需要处理返回 store_unavailable。每次检查只走一轮准备，不能反复登录。",
      `结束时 return 最后一行必须是 ${XHS_PREPARATION_MARKER}{"v":1,"status":"ready","code":"ready","profileVerified":true}。未完成时 status 使用 blocked（需人工处理）或 failed（安装/登录失败），code 使用上述原因码，profileVerified 必须为 false。只返回这四个字段，不得附带手机号、验证码、短信、个人主页内容或其他账号资料。`,
    ].join("\n"),
    maxSteps: 100,
    timeout: XHS_PREPARATION_TIMEOUT_MS,
    allowedApps: [packageName],
    taskPolicy: {
      operationClass: "account.login",
      targetPackages: [packageName],
      allowedAppRoles: [
        "target_app",
        "official_store",
        "system_installer",
        "default_sms",
        "system_dialog",
      ],
      installSourcePolicy: "official_store_only",
      allowBrowserDownload: false,
      allowedApps: [packageName],
      allowedActions: [
        "AWAKE",
        "CLICK",
        "TYPE",
        "ENTER",
        "WAIT",
        "BACK",
        "HOME",
        "SLIDE",
        "SCROLL",
        "LOAD_SKILL",
        "CALL_USER",
        "COMPLETE",
        "ABORT",
        "INFO",
      ],
      confirmationPolicy: {
        login: "required",
        publish: "forbidden",
        payment: "forbidden",
        comment: "forbidden",
      },
    },
  };
}

/** Retry a missing receipt once without repeating installation or login. */
export function buildPreparationVerificationRequest(
  packageName: string,
  expectedPlatformAccountId = "",
): DeviceExecuteTaskBody {
  const request = buildPreparationRequest(
    packageName,
    expectedPlatformAccountId,
  );
  const expectedId = expectedPlatformAccountId.trim();
  return {
    ...request,
    task: [
      "只复核小红书登录状态并返回机器回执，不执行养号。上一任务没有返回约定格式；不要复述个人资料。",
      `AWAKE 打开 ${packageName}，进入底部“我”；看到已登录个人主页、昵称和作品区才算验证成功。`,
      expectedId
        ? `打开编辑主页，只读取并核对“小红书号”与任务指定值「${expectedId}」完全一致；不一致返回 blocked/account_mismatch。不得在回执或过程记录中复述该号码。`
        : "本次未提供目标小红书号，不执行具体账号身份比对。",
      "禁止安装、请求验证码、填写手机号、登录、退出或切换账号、资料修改、浏览笔记及任何互动。不要加载 login/research/nurture 子技能。",
      "未登录返回 blocked/phone_required；需人工验证返回 blocked/verification_required；账号受限返回 blocked/account_restricted；操作频繁返回 blocked/rate_limited；无法判断返回 failed/login_failed。",
      `最后使用 COMPLETE，其 return 只能为 ${XHS_PREPARATION_MARKER}{"v":1,"status":"ready","code":"ready","profileVerified":true}；未完成时替换 status/code，profileVerified:false。不得省略 PREPARATION_JSON 前缀，不得输出个人主页内容、手机号、验证码或其他字段。`,
    ].join("\n"),
    maxSteps: 15,
    timeout: 120_000,
    taskPolicy: {
      ...request.taskPolicy,
      allowedAppRoles: ["target_app", "system_dialog"],
      allowedActions: [
        "AWAKE",
        "CLICK",
        "WAIT",
        "BACK",
        "HOME",
        "COMPLETE",
        "ABORT",
        "INFO",
      ],
    },
  };
}

/** Only the fixed receipt is persisted; raw login output/screenshots are not. */
export function interpretPreparationResult(
  result: TaskResult,
): Pick<XhsOpsPreparation, "status" | "reasonCode" | "reason"> {
  const fallback = result.needsInteraction
    ? ({
        status: "blocked",
        reasonCode: "verification_required",
        reason: REASONS.verification_required,
      } as const)
    : {
        status: "failed" as const,
        reasonCode: "invalid_result" as const,
        reason: REASONS.invalid_result,
      };
  const lines = (result.message ?? "")
    .replace(/\\n/g, "\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let index = lines.length - 1;
  while (index >= 0 && !lines[index]?.startsWith(XHS_PREPARATION_MARKER))
    index -= 1;
  if (index < 0) return fallback;
  try {
    const line = lines[index]?.slice(XHS_PREPARATION_MARKER.length) ?? "";
    const value: unknown = JSON.parse(line);
    const receipt = preparationReceiptSchema.safeParse(value);
    if (!receipt.success) return fallback;
    const outcome = {
      status: receipt.data.status,
      reasonCode: receipt.data.code,
      reason: REASONS[receipt.data.code],
    };
    // A human-intervention or cancellation result must never erase a valid
    // restriction/rate-limit report, even when other output is inconsistent.
    if (isPreparationSafetyStop(receipt.data.code)) return outcome;
    const tail = lines.slice(index + 1);
    if (
      tail.length > 1 ||
      (tail.length === 1 && !ACTION_RECEIPT_LINE.test(tail[0] ?? ""))
    )
      return fallback;
    if (
      receipt.data.status === "ready" &&
      (!result.success || result.needsInteraction)
    )
      return fallback;
    return outcome;
  } catch {
    return fallback;
  }
}
