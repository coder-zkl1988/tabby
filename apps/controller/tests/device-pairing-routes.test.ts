import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { OpenAPIHono } from "@hono/zod-openapi";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDeviceControlRoutes } from "../src/routes/device-control-routes.js";
import { DeviceControlService } from "../src/services/device-control-service.js";
import type { DeviceTaskHistoryStore } from "../src/store/device-task-history-store.js";
import type { NexuConfigStore } from "../src/store/nexu-config-store.js";
import type { ControllerBindings } from "../src/types.js";

const PENDING = {
  requestId: "pr_1",
  code: "482913",
  deviceId: "24094RAD4C-8a1f",
  model: "24094RAD4C",
  manufacturer: "Xiaomi",
  createdAt: 1,
  expiresAt: 120_001,
};

type RpcCall = { method: string; params: Record<string, unknown> };

/** Stand-in for tabby-control's RPC port, answering pairing methods. */
async function startPlugin(
  answer: (call: RpcCall) => { result?: unknown; error?: unknown },
  status = 200,
) {
  const calls: RpcCall[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const call = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      calls.push(call);
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(answer(call)));
    });
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  return { server, calls, port: (server.address() as AddressInfo).port };
}

function makeApp(rpcPort: number) {
  const configStore = {
    getConfig: vi
      .fn()
      .mockResolvedValue({ deviceControl: { rpcPort, wsPort: 18790 } }),
  } as unknown as NexuConfigStore;
  const deviceControlService = new DeviceControlService(configStore, {
    append: vi.fn(),
  } as unknown as DeviceTaskHistoryStore);
  const app = new OpenAPIHono<ControllerBindings>();
  registerDeviceControlRoutes(app, {
    deviceControlService,
    deviceNameStore: { get: vi.fn(), set: vi.fn() },
  } as never);
  return app;
}

describe("device pairing routes", () => {
  let close: (() => void) | null = null;
  afterEach(() => {
    close?.();
    close = null;
  });

  it("lists pending requests from the plugin", async () => {
    const plugin = await startPlugin(() => ({
      result: { enabled: true, requests: [PENDING] },
    }));
    close = () => plugin.server.close();
    const res = await makeApp(plugin.port).request(
      "/api/v1/devices/pairing/requests",
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: true, requests: [PENDING] });
    expect(plugin.calls[0]?.method).toBe("device_pairing_list");
  });

  it("reports nothing pending when the plugin is not running", async () => {
    const plugin = await startPlugin(() => ({ result: null }));
    const port = plugin.port;
    await new Promise((resolve) => plugin.server.close(resolve));
    const res = await makeApp(port).request("/api/v1/devices/pairing/requests");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ enabled: false, requests: [] });
  });

  it("approves with this machine's LAN address as the fallback host", async () => {
    const plugin = await startPlugin(() => ({ result: { ok: true } }));
    close = () => plugin.server.close();
    const res = await makeApp(plugin.port).request(
      "/api/v1/devices/pairing/requests/pr_1/approve",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(plugin.calls[0]?.method).toBe("device_pairing_approve");
    expect(plugin.calls[0]?.params.requestId).toBe("pr_1");
    expect(typeof plugin.calls[0]?.params.host).toBe("string");
  });

  it("maps a request that is no longer pending to 404", async () => {
    const plugin = await startPlugin(() => ({
      error: {
        code: "PAIRING_NOT_FOUND",
        message: "PAIRING_NOT_FOUND: request is no longer pending",
      },
    }));
    close = () => plugin.server.close();
    const res = await makeApp(plugin.port).request(
      "/api/v1/devices/pairing/requests/pr_gone/reject",
      { method: "POST" },
    );
    expect(res.status).toBe(404);
    expect(plugin.calls[0]?.method).toBe("device_pairing_reject");
  });

  it("returns the plugin's keyed QR URL, and 503 when the plugin is down", async () => {
    const wsUrl = "ws://192.168.1.20:18790/phone?key=abc";
    const plugin = await startPlugin(() => ({
      result: { wsUrl, expiresInSec: 600 },
    }));
    const app = makeApp(plugin.port);
    const ok = await app.request("/api/v1/devices/pairing/qr", {
      method: "POST",
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ wsUrl, expiresInSec: 600 });
    expect(plugin.calls[0]?.method).toBe("device_pairing_create_qr");

    await new Promise((resolve) => plugin.server.close(resolve));
    const down = await app.request("/api/v1/devices/pairing/qr", {
      method: "POST",
    });
    expect(down.status).toBe(503);
  });

  it("falls back to the keyless URL for a plugin without device keys", async () => {
    const plugin = await startPlugin(
      () => ({ error: { code: "UNKNOWN_METHOD", message: "Unknown method" } }),
      400,
    );
    close = () => plugin.server.close();
    const res = await makeApp(plugin.port).request(
      "/api/v1/devices/pairing/qr",
      { method: "POST" },
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { wsUrl: string; expiresInSec: number };
    expect(body.wsUrl).toMatch(/^ws:\/\/[0-9.]+:18790\/phone$/);
    expect(body.expiresInSec).toBe(0);
  });
});
