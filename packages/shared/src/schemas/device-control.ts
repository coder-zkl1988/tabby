import { z } from "zod";

// ─── Primitives ───────────────────────────────────────────────────────────────

export const deviceCapabilitiesSchema = z.object({
  model: z.string().optional(),
  osVersion: z.union([z.number(), z.string()]).optional(),
  screenWidth: z.number().optional(),
  screenHeight: z.number().optional(),
  manufacturer: z.string().optional(),
  currentApp: z.string().optional(),
  batteryLevel: z.number().optional(),
  batteryStatus: z.string().optional(),
  totalRam: z.number().optional(),
  availableRam: z.number().optional(),
  totalStorage: z.number().optional(),
  availableStorage: z.number().optional(),
  wifiSsid: z.string().optional(),
  isWifiConnected: z.boolean().optional(),
  isCharging: z.boolean().optional(),
});

export const deviceStatusSchema = z.enum(["idle", "busy", "error"]);

export const deviceInfoSchema = z.object({
  deviceId: z.string().min(1),
  name: z.string().optional(),
  model: z.string().optional(),
  osVersion: z.union([z.number(), z.string()]).optional(),
  screenWidth: z.number().optional(),
  screenHeight: z.number().optional(),
  status: deviceStatusSchema,
  currentApp: z.string().optional(),
  currentTaskId: z.string().min(1).optional(),
  connectedAt: z.number().int().positive(),
  lastSeen: z.number().int().positive(),
  manufacturer: z.string().optional(),
  batteryLevel: z.number().optional(),
  batteryStatus: z.string().optional(),
  totalRam: z.union([z.number(), z.string()]).optional(),
  availableRam: z.union([z.number(), z.string()]).optional(),
  totalStorage: z.union([z.number(), z.string()]).optional(),
  availableStorage: z.union([z.number(), z.string()]).optional(),
  wifiSsid: z.string().optional(),
  isWifiConnected: z.boolean().optional(),
  isCharging: z.boolean().optional(),
});

export const deviceListResponseSchema = z.object({
  devices: z.array(deviceInfoSchema),
});

export const deviceRenameBodySchema = z.object({
  name: z.string().min(1).max(64),
});

export const deviceAppRoleSchema = z.enum([
  "target_app",
  "official_store",
  "system_installer",
  "system_settings",
  "default_sms",
  "gallery",
  "file_picker",
  "browser",
  "system_dialog",
  "other",
]);

export const deviceTaskConfirmationPolicySchema = z.object({
  login: z.enum(["required", "forbidden"]).optional(),
  publish: z.enum(["required", "forbidden"]).optional(),
  payment: z.literal("forbidden").optional(),
  /** xhs-ops P3-1：默认 forbidden；评论任务传 allowed 且必须带 commentAllowlist。 */
  comment: z.enum(["forbidden", "allowed"]).optional(),
});

export const deviceTaskPolicySchema = z.object({
  operationClass: z.string().min(1).optional(),
  targetPackages: z.array(z.string().min(1)).optional(),
  allowedAppRoles: z.array(deviceAppRoleSchema).optional(),
  installSourcePolicy: z.literal("official_store_only").optional(),
  allowBrowserDownload: z.boolean().optional(),
  allowedActions: z.array(z.string().min(1)).optional(),
  allowedApps: z.array(z.string().min(1)).optional(),
  confirmationPolicy: deviceTaskConfirmationPolicySchema.optional(),
  /** 人工审核通过、允许手机逐字 TYPE 的评论原文（≤5 条，每条 ≤30 字）。 */
  commentAllowlist: z.array(z.string().min(1).max(30)).max(5).optional(),
});

export const deviceExecuteTaskBodySchema = z.object({
  task: z.string().min(1),
  maxSteps: z.number().int().min(1).max(100).optional().default(30),
  guidance: z.string().optional(),
  sessionId: z.string().optional(),
  allowedActions: z.array(z.string()).optional(),
  allowedApps: z.array(z.string()).optional(),
  taskPolicy: deviceTaskPolicySchema.optional(),
  timeout: z.number().int().positive().optional().default(120000),
});

/** One image pushed to the device gallery (base64, no data: prefix). */
export const devicePushMediaItemSchema = z.object({
  filename: z.string().min(1).max(128),
  mimeType: z.string().min(1),
  dataBase64: z.string().min(1),
});
export type DevicePushMediaItem = z.infer<typeof devicePushMediaItemSchema>;

export const devicePushMediaBodySchema = z.object({
  /** Relative Pictures subdirectory. Omitted for legacy callers -> Tabby. */
  album: z.string().min(1).max(128).optional(),
  images: z.array(devicePushMediaItemSchema).min(1).max(9),
});
export type DevicePushMediaBody = z.infer<typeof devicePushMediaBodySchema>;

export const devicePushMediaResultSchema = z.object({
  mediaId: z.string(),
  success: z.boolean(),
  savedUri: z.string().optional(),
  error: z.string().optional(),
});

export const devicePushMediaResponseSchema = z.object({
  results: z.array(devicePushMediaResultSchema),
});
export type DevicePushMediaResponse = z.infer<
  typeof devicePushMediaResponseSchema
>;

export const stepRecordSchema = z.object({
  step: z.number().int().min(1),
  action: z.string(),
  target: z.string().optional(),
  success: z.boolean(),
  error: z.string().optional(),
});

export const deviceTaskArtifactSchema = z.object({
  artifactId: z.string().min(1),
  name: z.string().min(1),
  mimeType: z.string().min(1),
  path: z.string().min(1),
});

export const taskResultSchema = z.object({
  taskId: z.string().min(1),
  success: z.boolean(),
  /** Final phone status/reason, retained to distinguish cancellation from failure. */
  status: z.string().optional(),
  errorCode: z.string().optional(),
  needsInteraction: z.boolean().optional(),
  message: z.string().optional(),
  totalSteps: z.number().int().min(0).optional(),
  steps: z.array(stepRecordSchema).optional(),
  failedAtStep: z.number().int().min(1).optional(),
  finalScreenshot: z.string().optional(),
  duration: z.number().int().nonnegative().optional(),
  artifacts: z.array(deviceTaskArtifactSchema).optional(),
});

export const deviceExecuteTaskResponseSchema = z.object({
  result: taskResultSchema,
});

export const cancelTaskBodySchema = z.object({
  taskId: z.string().min(1),
});

export const cancelTaskResponseSchema = z.object({
  cancelled: z.boolean(),
  message: z.string().optional(),
});

export const deviceErrorCodeSchema = z.enum([
  "DEVICE_OFFLINE",
  "PERMISSION_DENIED",
  "TIMEOUT",
  "INVALID_PARAMS",
  "SHELL_DENIED",
  "OPERATION_FAILED",
  "DEVICE_NOT_FOUND",
  "TASK_NOT_FOUND",
  "TASK_ALREADY_RUNNING",
  "MAX_DEVICES_REACHED",
]);

export type DeviceCapabilities = z.infer<typeof deviceCapabilitiesSchema>;
export type DeviceStatus = z.infer<typeof deviceStatusSchema>;
export type DeviceInfo = z.infer<typeof deviceInfoSchema>;
export type DeviceListResponse = z.infer<typeof deviceListResponseSchema>;
export type DeviceAppRole = z.infer<typeof deviceAppRoleSchema>;
export type DeviceTaskConfirmationPolicy = z.infer<
  typeof deviceTaskConfirmationPolicySchema
>;
export type DeviceTaskPolicy = z.infer<typeof deviceTaskPolicySchema>;
export type DeviceExecuteTaskBody = z.infer<typeof deviceExecuteTaskBodySchema>;
export type StepRecord = z.infer<typeof stepRecordSchema>;
export type DeviceTaskArtifact = z.infer<typeof deviceTaskArtifactSchema>;
export type TaskResult = z.infer<typeof taskResultSchema>;
export type CancelTaskBody = z.infer<typeof cancelTaskBodySchema>;
export type DeviceErrorCode = z.infer<typeof deviceErrorCodeSchema>;
