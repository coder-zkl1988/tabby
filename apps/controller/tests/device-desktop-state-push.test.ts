import { createServer } from "node:http";
import type { ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DeviceControlService,
  DeviceControlTimeoutError,
  deviceTaskHardTimeoutMs,
  postJson,
} from "../src/services/device-control-service.js";
import { DevicePollingService } from "../src/services/device-polling-service.js";
import type { DeviceTaskHistoryStore } from "../src/store/device-task-history-store.js";
import type { NexuConfigStore } from "../src/store/nexu-config-store.js";

const CREDENTIAL = {
  apiUrl: "https://link.example/v1/",
  apiKey: "sk-test",
  model: "tabby-phone",
  reasoningEffort: "low",
};

/**
 * A stand-in for the tabby-control RPC server.
 *
 * These used to assert against a stubbed global `fetch`, which stopped
 * exercising the transport once the RPC moved to `node:http` — and a stub can
 * never reproduce the bug that motivated the move: undici's 300s headersTimeout
 * silently outranking the computed ceiling. A real socket can.
 */
function startRpcServer(handler: (body: unknown, res: ServerResponse) => void) {
  const received: unknown[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      received.push(body);
      handler(body, res);
    });
  });
  const ready = new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve((server.address() as AddressInfo).port);
    });
  });
  return { server, received, ready };
}

function makeService(
  getVlmGatewayCredential: () => Promise<typeof CREDENTIAL | null>,
  rpcPort = 4310,
) {
  const configStore = {
    getConfig: vi.fn().mockResolvedValue({ deviceControl: { rpcPort } }),
    getVlmGatewayCredential: vi
      .fn()
      .mockImplementation(getVlmGatewayCredential),
    getDesktopCrashReportsEnabled: vi.fn().mockResolvedValue(true),
  } as unknown as NexuConfigStore;
  return new DeviceControlService(configStore, {
    append: vi.fn(),
  } as unknown as DeviceTaskHistoryStore);
}

describe("DeviceControlService.pushVlmCredential", () => {
  let rpc: ReturnType<typeof startRpcServer>;
  let port: number;

  beforeEach(async () => {
    rpc = startRpcServer((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result: null }));
    });
    port = await rpc.ready;
  });

  afterEach(() => {
    rpc.server.close();
  });

  it("pushes the credential when the read succeeds", async () => {
    const service = makeService(async () => CREDENTIAL, port);
    await service.pushVlmCredential();

    expect(rpc.received).toEqual([
      {
        method: "device_set_vlm_credential",
        params: { credential: CREDENTIAL },
      },
    ]);
  });

  it("pushes null when the user is genuinely logged out", async () => {
    const service = makeService(async () => null, port);
    await service.pushVlmCredential();

    expect(rpc.received).toHaveLength(1);
    expect((rpc.received[0] as { params: unknown }).params).toEqual({
      credential: null,
    });
  });

  it("skips the push entirely when the credential read fails", async () => {
    // Regression: a transient config read failure must NOT clear the plugin's
    // good in-memory credential (observed as "VLM credential cleared" with no
    // login change, followed by hours of phones lacking a model credential).
    const service = makeService(async () => {
      throw new Error("config read failed");
    }, port);
    await service.pushVlmCredential();

    expect(rpc.received).toHaveLength(0);
  });
});

describe("DeviceControlService.isAvailable", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps concurrent health checks independent", async () => {
    const service = makeService(async () => CREDENTIAL);
    const resolvers: Array<(response: { ok: boolean }) => void> = [];
    const signals: AbortSignal[] = [];
    fetchMock.mockImplementation(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise((resolve, reject) => {
          const signal = init?.signal;
          if (signal) {
            signals.push(signal);
            signal.addEventListener(
              "abort",
              () => reject(signal.reason ?? new Error("health check aborted")),
              { once: true },
            );
          }
          resolvers.push(resolve);
        }),
    );

    const first = service.isAvailable();
    await vi.waitFor(() => expect(resolvers).toHaveLength(1));
    const second = service.isAvailable();
    await vi.waitFor(() => expect(resolvers).toHaveLength(2));

    expect(signals).toHaveLength(2);
    expect(signals[0]?.aborted).toBe(false);
    expect(signals[1]?.aborted).toBe(false);
    resolvers[0]?.({ ok: true });
    resolvers[1]?.({ ok: true });

    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
  });
});

describe("DeviceControlService.executeTask", () => {
  it("forwards the caller's idle timeout untouched and records the run", async () => {
    const result = { taskId: "task-1", success: true, message: "published" };
    const rpc = startRpcServer((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    });
    const port = await rpc.ready;
    const append = vi.fn();
    const configStore = {
      getConfig: vi
        .fn()
        .mockResolvedValue({ deviceControl: { rpcPort: port } }),
    } as unknown as NexuConfigStore;
    const service = new DeviceControlService(configStore, {
      append,
    } as unknown as DeviceTaskHistoryStore);

    const response = await service.executeTask("device-1", {
      task: "发布一篇小红书图文笔记",
      timeout: 120_000,
      maxSteps: 40,
    });

    // The idle window belongs to the phone (it re-arms it on every heartbeat);
    // the controller passes it through rather than substituting its own.
    expect(
      (rpc.received[0] as { params: { timeoutMs: number } }).params.timeoutMs,
    ).toBe(120_000);
    expect(append).toHaveBeenCalledTimes(1);
    expect(response.result).toEqual(result);
    expect(append.mock.calls[0]?.[0]).toMatchObject({
      task: "发布一篇小红书图文笔记",
      result,
    });
    rpc.server.close();
  });

  it("redacts login task details from history while returning the full result", async () => {
    const secret = "secretcanary-login-13800138000-654321";
    const result = {
      taskId: "login-task-1",
      success: false,
      status: "aborted",
      errorCode: "USER_CANCELLED",
      needsInteraction: true,
      message: `Enter ${secret}`,
      interactionMessage: `Manual input required for ${secret}`,
      totalSteps: 7,
      steps: [{ step: 1, action: "TYPE", target: secret, success: true }],
      finalScreenshot: `/tmp/${secret}.webp`,
      artifacts: [
        {
          artifactId: "artifact-1",
          name: secret,
          mimeType: "image/webp",
          path: `/tmp/${secret}-artifact.webp`,
        },
      ],
    };
    const rpc = startRpcServer((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    });
    const port = await rpc.ready;
    const append = vi.fn();
    const configStore = {
      getConfig: vi
        .fn()
        .mockResolvedValue({ deviceControl: { rpcPort: port } }),
    } as unknown as NexuConfigStore;
    const service = new DeviceControlService(configStore, {
      append,
    } as unknown as DeviceTaskHistoryStore);

    const response = await service.executeTask("device-1", {
      task: `Use ${secret} to log in`,
      guidance: `Continue with ${secret}`,
      timeout: 120_000,
      taskPolicy: { operationClass: "account.login" },
    });

    expect(response.result).toEqual(result);
    expect(append).toHaveBeenCalledTimes(1);
    const historyEntry = append.mock.calls[0]?.[0];
    expect(JSON.stringify(historyEntry)).not.toContain(secret);
    expect(historyEntry).toMatchObject({
      task: "Account login preparation (sensitive details redacted)",
      result: {
        taskId: "login-task-1",
        success: false,
        status: "aborted",
        errorCode: "USER_CANCELLED",
        needsInteraction: true,
        totalSteps: 7,
        message:
          "Account login preparation result (sensitive details redacted)",
      },
    });
    expect(historyEntry.result.steps).toBeUndefined();
    expect(historyEntry.result.interactionMessage).toBeUndefined();
    expect(historyEntry.result.finalScreenshot).toBeUndefined();
    expect(historyEntry.result.artifacts).toBeUndefined();
    rpc.server.close();
  });

  it("drops unrecognized login status fields from history", async () => {
    const secret = "secretcanary-login-status-13800138000";
    const result = {
      taskId: "login-task-untrusted-status",
      success: false,
      status: `blocked-${secret}`,
      errorCode: `PHONE_${secret}`,
      message: `failed with ${secret}`,
    };
    const rpc = startRpcServer((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ result }));
    });
    const port = await rpc.ready;
    const append = vi.fn();
    const configStore = {
      getConfig: vi
        .fn()
        .mockResolvedValue({ deviceControl: { rpcPort: port } }),
    } as unknown as NexuConfigStore;
    const service = new DeviceControlService(configStore, {
      append,
    } as unknown as DeviceTaskHistoryStore);

    await service.executeTask("device-1", {
      task: `Log in with ${secret}`,
      taskPolicy: { operationClass: "account.login" },
    });

    const historyEntry = append.mock.calls[0]?.[0];
    expect(JSON.stringify(historyEntry)).not.toContain(secret);
    expect(historyEntry.result.status).toBeUndefined();
    expect(historyEntry.result.errorCode).toBeUndefined();
    rpc.server.close();
  });

  it("keeps the ceiling far above the idle window it guards", () => {
    // The ceiling only has to outlast a legitimate run — it must never be what
    // ends healthy work, so it stays a large multiple of the idle window.
    expect(deviceTaskHardTimeoutMs(120_000)).toBe(30 * 60_000);
    expect(deviceTaskHardTimeoutMs(10 * 60_000)).toBe(60 * 60_000);
    expect(deviceTaskHardTimeoutMs(120_000)).toBeGreaterThan(120_000);
  });

  it("reports a stalled transport as a timeout, not a generic failure", async () => {
    // The regression this change exists for: the phone was still working when
    // the transport gave up. `fetch` hid a 300s undici headersTimeout that
    // outranked the computed ceiling and surfaced as a bare "fetch failed", so
    // the caller read it as a failed publish while the device's real result
    // arrived minutes later with nobody waiting. A stall has to be
    // recognisable as a stall — that is what lets the UI say "unconfirmed".
    const rpc = startRpcServer(() => {
      /* never responds — the phone is still working */
    });
    const port = await rpc.ready;

    await expect(postJson(port, { method: "x" }, 300)).rejects.toBeInstanceOf(
      DeviceControlTimeoutError,
    );
    rpc.server.close();
  });

  it("records the attempt even when the RPC fails", async () => {
    // History used to be written only after a successful RPC, so exactly the
    // runs worth investigating — errored or timed out — left nothing behind.
    const rpc = startRpcServer((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({ error: { code: "DEVICE_OFFLINE", message: "gone" } }),
      );
    });
    const port = await rpc.ready;
    const append = vi.fn();
    const configStore = {
      getConfig: vi
        .fn()
        .mockResolvedValue({ deviceControl: { rpcPort: port } }),
    } as unknown as NexuConfigStore;
    const service = new DeviceControlService(configStore, {
      append,
    } as unknown as DeviceTaskHistoryStore);

    await expect(
      service.executeTask("device-1", { task: "t", timeout: 120_000 }),
    ).rejects.toThrow("gone");

    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0][0].result.success).toBe(false);
    rpc.server.close();
  });

  it("redacts login task details and errors from failed history", async () => {
    const secret = "secretcanary-login-rpc-error";
    const rpc = startRpcServer((_body, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: { code: "OPERATION_FAILED", message: `failed with ${secret}` },
        }),
      );
    });
    const port = await rpc.ready;
    const append = vi.fn();
    const configStore = {
      getConfig: vi
        .fn()
        .mockResolvedValue({ deviceControl: { rpcPort: port } }),
    } as unknown as NexuConfigStore;
    const service = new DeviceControlService(configStore, {
      append,
    } as unknown as DeviceTaskHistoryStore);

    await expect(
      service.executeTask("device-1", {
        task: `Log in with ${secret}`,
        timeout: 120_000,
        taskPolicy: { operationClass: "account.login" },
      }),
    ).rejects.toThrow(secret);

    expect(append).toHaveBeenCalledTimes(1);
    const historyEntry = append.mock.calls[0]?.[0];
    expect(JSON.stringify(historyEntry)).not.toContain(secret);
    expect(historyEntry).toMatchObject({
      task: "Account login preparation (sensitive details redacted)",
      result: {
        success: false,
        message:
          "Account login preparation failed (sensitive details redacted)",
      },
    });
    rpc.server.close();
  });
});

describe("DevicePollingService desktop-state reconcile", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  function makePollingService() {
    const deviceControlService = {
      isAvailable: vi.fn().mockResolvedValue(true),
      listDevices: vi.fn().mockResolvedValue({ devices: [] }),
      pushVlmCredential: vi.fn().mockResolvedValue(undefined),
      pushTelemetryConsent: vi.fn().mockResolvedValue(undefined),
    };
    const service = new DevicePollingService(
      deviceControlService as unknown as DeviceControlService,
    );
    return { service, deviceControlService };
  }

  it("re-pushes VLM credential and telemetry consent every 60s while online", async () => {
    const { service, deviceControlService } = makePollingService();
    service.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(deviceControlService.pushVlmCredential).toHaveBeenCalledTimes(1);
    expect(deviceControlService.pushTelemetryConsent).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(60_000);
    expect(deviceControlService.pushVlmCredential).toHaveBeenCalledTimes(2);

    service.dispose();
  });

  it("re-pushes immediately when the plugin comes back online", async () => {
    const { service, deviceControlService } = makePollingService();
    // Offline long enough to trip OFFLINE_THRESHOLD (3 checks x 10s).
    deviceControlService.isAvailable.mockResolvedValue(false);
    service.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(deviceControlService.pushVlmCredential).not.toHaveBeenCalled();

    // Plugin comes back (e.g. OpenClaw restarted outside the controller) —
    // the next availability check should trigger a push without waiting for
    // the 60s reconcile tick.
    deviceControlService.isAvailable.mockResolvedValue(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(deviceControlService.pushVlmCredential).toHaveBeenCalledTimes(1);
    expect(deviceControlService.pushTelemetryConsent).toHaveBeenCalledTimes(1);

    service.dispose();
  });

  it("skips the reconcile tick while the plugin is offline", async () => {
    const { service, deviceControlService } = makePollingService();
    deviceControlService.isAvailable.mockResolvedValue(false);
    service.start();

    await vi.advanceTimersByTimeAsync(60_000);
    expect(deviceControlService.pushVlmCredential).not.toHaveBeenCalled();

    service.dispose();
  });
});
