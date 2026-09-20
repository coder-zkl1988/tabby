import { request as httpRequest } from "node:http";
import type {
  CancelTaskBody,
  DeviceExecuteTaskBody,
  DeviceInfo,
  DeviceListResponse,
  DevicePushMediaBody,
  DevicePushMediaResponse,
  TaskResult,
} from "@nexu/shared";
import { logger } from "../lib/logger.js";
import type { DeviceTaskHistoryStore } from "../store/device-task-history-store.js";
import type { NexuConfigStore } from "../store/nexu-config-store.js";

interface RpcErrorDetail {
  code: string;
  message: string;
}

type RpcResponse<T> =
  | { result: T; error?: undefined }
  | { error: RpcErrorDetail; result?: undefined };

const DEFAULT_RPC_TIMEOUT_MS = 10_000;
const DEFAULT_LIST_TIMEOUT_MS = 5_000;
const DEFAULT_HEALTH_TIMEOUT_MS = 5_000;

/**
 * Backstop for a device task, expressed against the caller's *idle* timeout.
 *
 * The phone's own limit is progress-based: the plugin re-arms `timeoutMs` on
 * every heartbeat, so a task that keeps working runs as long as it needs. This
 * ceiling therefore only has to outlast any legitimate run and catch a wedged
 * RPC — it must never be the thing that ends healthy work, which is why it is a
 * large multiple of the idle window rather than a duration of its own.
 */
const MIN_DEVICE_TASK_HARD_TIMEOUT_MS = 30 * 60_000;
const MAX_DEVICE_TASK_HARD_TIMEOUT_MS = 24 * 60 * 60_000;
const DEVICE_TASK_HARD_TIMEOUT_FACTOR = 6;
const LOGIN_TASK_HISTORY_SUMMARY =
  "Account login preparation (sensitive details redacted)";
const LOGIN_TASK_RESULT_SUMMARY =
  "Account login preparation result (sensitive details redacted)";
const LOGIN_TASK_ERROR_SUMMARY =
  "Account login preparation failed (sensitive details redacted)";
const LOGIN_TASK_RESULT_STATUSES = new Set([
  "completed",
  "aborted",
  "stuck",
  "needs_takeover",
  "blocked",
  "error",
]);
const LOGIN_TASK_RESULT_ERROR_CODES = new Set([
  "CALLER_DISCONNECTED",
  "USER_CANCELLED",
  "IDENTITY_BLOCKED",
  "POLICY_BROWSER_INSTALL_FORBIDDEN",
  "WECOM_AUDIT_INCOMPLETE",
]);

function isLoginTask(body: DeviceExecuteTaskBody): boolean {
  return body.taskPolicy?.operationClass === "account.login";
}

function redactLoginTaskResult(result: TaskResult): TaskResult {
  const status =
    result.status && LOGIN_TASK_RESULT_STATUSES.has(result.status)
      ? result.status
      : undefined;
  const errorCode =
    result.errorCode && LOGIN_TASK_RESULT_ERROR_CODES.has(result.errorCode)
      ? result.errorCode
      : undefined;
  return {
    taskId: result.taskId,
    success: result.success,
    ...(status ? { status } : {}),
    ...(errorCode ? { errorCode } : {}),
    needsInteraction: result.needsInteraction,
    totalSteps: result.totalSteps,
    message: LOGIN_TASK_RESULT_SUMMARY,
  };
}

export function deviceTaskHardTimeoutMs(idleTimeoutMs: number): number {
  return Math.min(
    MAX_DEVICE_TASK_HARD_TIMEOUT_MS,
    Math.max(
      MIN_DEVICE_TASK_HARD_TIMEOUT_MS,
      idleTimeoutMs * DEVICE_TASK_HARD_TIMEOUT_FACTOR,
    ),
  );
}

/** A device task outlived the transport, not the device. */
export class DeviceControlTimeoutError extends Error {
  constructor(
    message: string,
    readonly timeoutMs: number,
  ) {
    super(message);
    this.name = "DeviceControlTimeoutError";
  }
}

/**
 * POST JSON over `node:http` rather than `fetch`.
 *
 * `fetch` is undici, whose headersTimeout defaults to 300s and silently
 * outranked the ceiling computed above: a phone still working at five minutes
 * had its call killed with a bare "fetch failed", the caller marked the work
 * failed, and the device's real result arrived minutes later with nobody left
 * to receive it. Node's client applies no timeout of its own, so the only
 * deadline here is the one we pass in.
 */
export function postJson(
  port: number,
  payload: unknown,
  timeoutMs: number,
): Promise<{ status: number; body: string }> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path: "/rpc",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(body),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
        res.on("error", reject);
      },
    );
    req.setTimeout(timeoutMs, () => {
      req.destroy(
        new DeviceControlTimeoutError(
          `device control RPC exceeded ${timeoutMs}ms without a response`,
          timeoutMs,
        ),
      );
    });
    req.on("error", reject);
    req.end(body);
  });
}

export class DeviceControlRpcError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DeviceControlRpcError";
  }
}

/**
 * Markers tabby-control raises from execute_task before the task goes on the
 * wire: an unknown device, one already busy, a whitelist naming an action the
 * phone never declared, or a WebSocket send that failed outright. All of them
 * are thrown ahead of the send, and tabby-control leaves the device's own
 * state alone for them, so the phone provably never saw the task.
 *
 * Deliberately an allowlist and not "any RPC error": TIMEOUT and NO_FIRST_STEP
 * come back through the same channel and both mean the phone *did* take the
 * task, so reading them as never-dispatched would write off work that may
 * still be running.
 */
const DISPATCH_REJECTION_MARKERS = [
  "UNKNOWN_PHONE_ACTION",
  "DEVICE_NOT_FOUND",
  "TASK_ALREADY_RUNNING",
  "DEVICE_OFFLINE",
];

/**
 * Why a task never reached the phone, or null when the error proves no such
 * thing. Only a structured RPC error can qualify: a transport failure means
 * the answer was lost, not that the dispatch was refused.
 */
export function dispatchRejectionReason(error: unknown): string | null {
  if (!(error instanceof DeviceControlRpcError)) return null;
  return DISPATCH_REJECTION_MARKERS.some((marker) =>
    error.message.includes(marker),
  )
    ? error.message
    : null;
}

export class DeviceControlService {
  constructor(
    private readonly configStore: NexuConfigStore,
    private readonly taskHistoryStore: DeviceTaskHistoryStore,
  ) {}

  private async getRpcPort(): Promise<number> {
    const config = await this.configStore.getConfig();
    return config.deviceControl.rpcPort;
  }

  private async rpc<T>(
    method: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  ): Promise<T> {
    const port = await this.getRpcPort();
    const response = await postJson(port, { method, params }, timeoutMs);

    if (response.status < 200 || response.status >= 300) {
      throw new Error(`Device control RPC failed: ${response.status}`);
    }

    const data = JSON.parse(response.body) as RpcResponse<T>;

    if (data.error !== undefined) {
      throw new DeviceControlRpcError(data.error.code, data.error.message);
    }

    return data.result as T;
  }

  /**
   * Push the signed-in user's VLM gateway credential to the tabby-control plugin
   * so it's handed to phones on connect. Called on startup and whenever the
   * cloud login state changes. Best-effort: if the plugin isn't up, ignore.
   */
  async pushVlmCredential(): Promise<void> {
    // Full credential shape (model + reasoningEffort + sampling overrides)
    // comes from the store; forwarded verbatim over RPC to tabby-control.
    let credential: Awaited<
      ReturnType<NexuConfigStore["getVlmGatewayCredential"]>
    >;
    try {
      credential = await this.configStore.getVlmGatewayCredential();
    } catch (err) {
      // A read failure is NOT a logout: pushing null here would wipe a good
      // credential from the plugin. Keep the plugin's current state and let
      // the next push (reconcile loop / login change) retry.
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        "device-control: VLM credential read failed, skipping push",
      );
      return;
    }
    try {
      await this.rpc("device_set_vlm_credential", { credential });
    } catch {
      // Plugin not running / RPC unavailable — phones will fall back to local
      // VLM settings until the next push succeeds.
    }
  }

  /**
   * Push the desktop "crash reports" consent to the tabby-control plugin so
   * it's handed to phones (gating their Sentry reporting). Called on startup
   * and whenever the toggle changes. Best-effort: if the plugin isn't up,
   * ignore — phones keep their cached consent until the next push succeeds.
   */
  async pushTelemetryConsent(): Promise<void> {
    let enabled = true;
    try {
      enabled = await this.configStore.getDesktopCrashReportsEnabled();
    } catch {
      enabled = true;
    }
    try {
      await this.rpc("device_set_telemetry_consent", { enabled });
    } catch {
      // Plugin not running / RPC unavailable — phones keep their cached
      // consent until the next push succeeds.
    }
  }

  /**
   * Push the desktop-owned state (VLM credential + telemetry consent) once the
   * tabby-control RPC is reachable. The plugin comes up with no state after
   * every OpenClaw (re)start, so this polls `isAvailable()` and pushes on first
   * success. Best-effort: gives up silently after `maxAttempts`. Used by cold
   * start and after every gateway restart.
   */
  async pushDesktopStateWhenReady(
    maxAttempts = 10,
    intervalMs = 2000,
  ): Promise<void> {
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const up = await this.isAvailable().catch(() => false);
      if (up) {
        await this.pushVlmCredential();
        await this.pushTelemetryConsent();
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }

  async isAvailable(): Promise<boolean> {
    try {
      const port = await this.getRpcPort();
      const response = await fetch(`http://127.0.0.1:${port}/health`, {
        // Availability is queried by polling and multiple API routes. Each
        // caller needs an independent timeout; cancelling an earlier probe can
        // otherwise turn a healthy concurrent media request into a false 503.
        signal: AbortSignal.timeout(DEFAULT_HEALTH_TIMEOUT_MS),
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  async listDevices(): Promise<DeviceListResponse> {
    const port = await this.getRpcPort();
    const response = await fetch(`http://127.0.0.1:${port}/devices`, {
      signal: AbortSignal.timeout(DEFAULT_LIST_TIMEOUT_MS),
    });

    if (!response.ok) {
      throw new Error(
        `Failed to list devices: ${response.status} ${response.statusText}`,
      );
    }

    return (await response.json()) as DeviceListResponse;
  }

  async getDevice(deviceId: string): Promise<DeviceInfo | null> {
    return this.rpc<DeviceInfo | null>("device.get_status", { deviceId });
  }

  /**
   * Results tabby-control kept after its RPC caller went away — a controller
   * restart, a dropped socket. The phone finishes either way and the plugin
   * retains what it could not deliver ("RPC caller disconnected before
   * response; task result remains available for recovery"), so a caller that
   * lost its answer can still come back for it instead of reporting a task it
   * never heard about as lost (2026-09-20).
   *
   * Newest first. `completedAt` is epoch ms, which is what lets a caller tell
   * its own run's result from an earlier one on the same phone.
   */
  async getTaskResults(query: {
    deviceId?: string;
    taskId?: string;
    limit?: number;
  }): Promise<
    Array<{
      taskId: string;
      deviceId: string;
      result: TaskResult;
      completedAt: number;
      orphaned?: boolean;
    }>
  > {
    return this.rpc("device.get_task_results", query);
  }

  async executeTask(
    deviceId: string,
    body: DeviceExecuteTaskBody,
  ): Promise<{ result: TaskResult }> {
    const taskTimeout = body.timeout ?? 120_000;
    const dispatchedAt = new Date().toISOString();
    let result: TaskResult;
    try {
      result = await this.rpc<TaskResult>(
        "device.execute_task",
        {
          deviceId,
          task: body.task,
          timeoutMs: taskTimeout,
          guidance: body.guidance,
          sessionId: body.sessionId,
          maxSteps: body.maxSteps,
          allowedActions: body.allowedActions,
          allowedApps: body.allowedApps,
          taskPolicy: body.taskPolicy,
        },
        // The plugin treats timeoutMs as an idle timeout and re-arms it on every
        // phone progress heartbeat. Keep a much larger independent ceiling so a
        // wedged RPC cannot leave the request and publishing UI pending forever.
        deviceTaskHardTimeoutMs(taskTimeout),
      );
    } catch (error: unknown) {
      // Record the attempt before rethrowing. History used to be written only
      // after a successful RPC, so precisely the runs worth investigating —
      // the ones that errored or timed out — left nothing behind, and the only
      // trace was whatever happened to be in the gateway log.
      await this.appendHistory({
        deviceId,
        taskId: `failed-${dispatchedAt}`,
        task: isLoginTask(body) ? LOGIN_TASK_HISTORY_SUMMARY : body.task,
        maxSteps: body.maxSteps,
        dispatchedAt,
        completedAt: new Date().toISOString(),
        result: {
          taskId: `failed-${dispatchedAt}`,
          success: false,
          message: isLoginTask(body)
            ? LOGIN_TASK_ERROR_SUMMARY
            : error instanceof DeviceControlTimeoutError
              ? `transport timeout after ${error.timeoutMs}ms — the device may still be working: ${error.message}`
              : error instanceof Error
                ? error.message
                : String(error),
        },
      });
      throw error;
    }
    await this.appendHistory({
      deviceId,
      taskId: result.taskId,
      task: isLoginTask(body) ? LOGIN_TASK_HISTORY_SUMMARY : body.task,
      maxSteps: body.maxSteps,
      dispatchedAt,
      completedAt: new Date().toISOString(),
      result: isLoginTask(body) ? redactLoginTaskResult(result) : result,
    });
    return { result };
  }

  /** History persistence is best-effort; never fail the user's task over it. */
  private async appendHistory(
    entry: Parameters<DeviceTaskHistoryStore["append"]>[0],
  ): Promise<void> {
    try {
      await this.taskHistoryStore.append(entry);
    } catch (err) {
      logger.warn(
        {
          error: err instanceof Error ? err.message : String(err),
          deviceId: entry.deviceId,
          taskId: entry.taskId,
        },
        "failed to persist device task history",
      );
    }
  }

  async cancelTask(
    deviceId: string,
    body: CancelTaskBody,
  ): Promise<{ cancelled: boolean; message?: string }> {
    return this.rpc<{ cancelled: boolean; message?: string }>(
      "device.cancel_task",
      { deviceId, taskId: body.taskId },
      // Leave transport headroom while the plugin waits for a terminal receipt.
      35_000,
    );
  }

  /**
   * Push images into the device gallery one at a time. Each image is sent over
   * the device WS and confirmed independently so one failure doesn't abort the
   * batch; returns a per-image result for the caller to act on.
   */
  async pushMedia(
    deviceId: string,
    body: DevicePushMediaBody,
  ): Promise<DevicePushMediaResponse> {
    const results: DevicePushMediaResponse["results"] = [];
    for (const image of body.images) {
      try {
        const result = await this.rpc<
          DevicePushMediaResponse["results"][number]
        >(
          "device.push_media",
          {
            deviceId,
            filename: image.filename,
            mimeType: image.mimeType,
            dataBase64: image.dataBase64,
          },
          35_000,
        );
        results.push(result);
      } catch (err) {
        results.push({
          mediaId: "",
          success: false,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return { results };
  }
}
