import { OpenAPIHono } from "@hono/zod-openapi";
import { describe, expect, it, vi } from "vitest";
import type { ControllerContainer } from "../src/app/container.js";
import type { ControllerEnv } from "../src/app/env.js";
import { registerMemoryRoutes } from "../src/routes/memory-routes.js";
import { nexuConfigSchema } from "../src/store/schemas.js";
import type { ControllerBindings } from "../src/types.js";

function createApp(options: {
  enabled?: boolean;
  rebuildIndex?: (env: ControllerEnv, agentId?: string) => Promise<void>;
  runCommand?: (
    env: ControllerEnv,
    args: string[],
    options?: { timeoutMs?: number },
  ) => Promise<string>;
  readStatus?: () => Promise<{
    indexedItems?: number;
    lastSyncAtMs?: number;
    dirty: boolean;
  }>;
  syncAll?: () => Promise<{
    configPushed: boolean;
    configChanged: boolean;
  }>;
}) {
  const app = new OpenAPIHono<ControllerBindings>();
  const memory = {
    enabled: options.enabled ?? true,
    sources: ["memory"] as Array<"memory" | "sessions">,
    extraPaths: [] as string[],
    syncIntervalMinutes: 5,
    provider: "none",
    model: undefined as string | undefined,
  };
  const getMemoryConfig = vi.fn(async () => memory);
  const setMemoryConfig = vi.fn(async (patch: Partial<typeof memory>) => ({
    ...memory,
    ...patch,
  }));
  const syncAll = vi.fn(
    options.syncAll ??
      (async () => ({ configPushed: true, configChanged: true })),
  );
  const env = {
    openclawStateDir: "/tmp/openclaw",
    openclawConfigPath: "/tmp/openclaw/openclaw.json",
  } as ControllerEnv;

  registerMemoryRoutes(
    app,
    {
      env,
      configStore: { getMemoryConfig, setMemoryConfig },
      openclawSyncService: { syncAll },
    } as unknown as ControllerContainer,
    {
      ...(options.rebuildIndex ? { rebuildIndex: options.rebuildIndex } : {}),
      ...(options.runCommand ? { runCommand: options.runCommand } : {}),
      ...(options.readStatus ? { readStatus: options.readStatus } : {}),
      now: () => new Date("2026-08-04T00:00:00.000Z"),
    },
  );

  return { app, env, getMemoryConfig, setMemoryConfig, syncAll };
}

describe("memory routes", () => {
  it("defaults legacy configs to private workspace memory", () => {
    const parsed = nexuConfigSchema.parse({
      $schema: "https://tabby.happywork.today/config.json",
      schemaVersion: 2,
      runtime: {
        gateway: { port: 18789, bind: "loopback", authMode: "none" },
        defaultModelId: "test/model",
      },
    });

    expect(parsed.memory).toEqual({
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      syncIntervalMinutes: 5,
      provider: "none",
      // Legacy configs gain the schema-defaulted recall floor on read; this
      // is the value the settings UI shows and the compiler emits.
      minScore: 0.2,
    });
  });

  it("normalizes settings and syncs the OpenClaw config", async () => {
    const { app, setMemoryConfig, syncAll } = createApp({});
    const response = await app.request("/api/v1/memory/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        sources: ["memory", "sessions", "sessions"],
        extraPaths: [" docs ", "docs", "notes"],
        syncIntervalMinutes: 15,
        provider: "link",
        model: "Qwen/Qwen3-Embedding-4B",
      }),
    });

    expect(response.status).toBe(200);
    expect(setMemoryConfig).toHaveBeenCalledWith({
      sources: ["memory", "sessions"],
      extraPaths: ["docs", "notes"],
      syncIntervalMinutes: 15,
      provider: "link",
      model: "Qwen/Qwen3-Embedding-4B",
    });
    expect(syncAll).toHaveBeenCalledOnce();
  });

  it("returns index files and the latest database sync time", async () => {
    const readStatus = vi.fn(async () => ({
      indexedItems: 42,
      lastSyncAtMs: 1_754_275_600_000,
      dirty: false,
    }));
    const { app } = createApp({ readStatus });
    const response = await app.request("/api/v1/memory/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connected: true,
      available: true,
      enabled: true,
      indexedItems: 42,
      lastSyncAtMs: 1_754_275_600_000,
      status: "ready",
    });
  });

  it("probes the configured embedding provider before reporting ready", async () => {
    const runCommand = vi.fn(async () =>
      JSON.stringify([
        {
          status: { files: 42, dirty: false },
          embeddingProbe: { ok: true },
        },
      ]),
    );
    const { app, env } = createApp({ runCommand });
    const response = await app.request("/api/v1/memory/status?agentId=bot-1");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      connected: true,
      available: true,
      enabled: true,
      indexedItems: 42,
      mode: "semantic",
      status: "ready",
    });
    expect(runCommand).toHaveBeenCalledWith(
      env,
      ["memory", "status", "--json", "--deep", "--agent", "bot-1"],
      { timeoutMs: 30_000 },
    );
  });

  it("reports FTS-only memory as available without an embedding provider", async () => {
    const runCommand = vi.fn(async () =>
      JSON.stringify([
        {
          status: {
            files: 2,
            dirty: false,
            provider: "none",
            fts: { enabled: true, available: true },
            vector: { enabled: false },
          },
          embeddingProbe: {
            ok: false,
            error: "No embedding provider available (FTS-only mode)",
          },
        },
      ]),
    );
    const { app } = createApp({ runCommand });
    const response = await app.request("/api/v1/memory/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connected: true,
      available: true,
      enabled: true,
      indexedItems: 2,
      mode: "fts-only",
      status: "ready",
    });
  });

  it("aggregates memory status across all agents", async () => {
    const runCommand = vi.fn(async () =>
      JSON.stringify([
        {
          status: { files: 2, dirty: false },
          embeddingProbe: { ok: true },
        },
        {
          status: { files: 5, dirty: true },
          embeddingProbe: { ok: true },
        },
      ]),
    );
    const { app } = createApp({ runCommand });
    const response = await app.request("/api/v1/memory/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      available: true,
      indexedItems: 7,
      mode: "semantic",
      status: "sync-needed",
    });
  });

  it("reports unavailable when the live embedding probe fails", async () => {
    const runCommand = vi.fn(async () =>
      JSON.stringify([
        {
          status: { files: 42, dirty: false },
          embeddingProbe: {
            ok: false,
            error: "provider rejected a revoked credential",
          },
        },
      ]),
    );
    const { app } = createApp({ runCommand });
    const response = await app.request("/api/v1/memory/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connected: true,
      available: false,
      enabled: true,
      reasonCode: "embedding-provider-unavailable",
      status: "unavailable",
    });
  });

  it("reports unavailable when the live embedding probe times out", async () => {
    const runCommand = vi.fn(async () => {
      throw new Error("probe timeout with provider details");
    });
    const { app } = createApp({ runCommand });
    const response = await app.request("/api/v1/memory/status");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      connected: false,
      available: false,
      enabled: true,
      reasonCode: "probe-timeout",
      status: "unavailable",
    });
  });

  it("rolls settings back when OpenClaw rejects the compiled config", async () => {
    let attempts = 0;
    const syncAll = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("apply failed");
      return { configPushed: true, configChanged: true };
    });
    const { app, setMemoryConfig } = createApp({ syncAll });
    const response = await app.request("/api/v1/memory/settings", {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(409);
    expect(setMemoryConfig).toHaveBeenNthCalledWith(1, { enabled: false });
    expect(setMemoryConfig).toHaveBeenNthCalledWith(2, {
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      syncIntervalMinutes: 5,
      provider: "none",
      model: undefined,
    });
    expect(syncAll).toHaveBeenCalledTimes(2);
  });

  it("rebuilds the selected agent memory index", async () => {
    const rebuildIndex = vi.fn(async () => {});
    const { app, env, syncAll } = createApp({ rebuildIndex });
    const response = await app.request("/api/v1/memory/rebuild", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agentId: "bot-1" }),
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      ok: true,
      rebuiltAt: "2026-08-04T00:00:00.000Z",
    });
    expect(syncAll).toHaveBeenCalledOnce();
    expect(rebuildIndex).toHaveBeenCalledWith(env, "bot-1");
  });

  it("does not rebuild while memory is disabled", async () => {
    const rebuildIndex = vi.fn(async () => {});
    const { app } = createApp({ enabled: false, rebuildIndex });
    const response = await app.request("/api/v1/memory/rebuild", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });

    expect(response.status).toBe(409);
    expect(rebuildIndex).not.toHaveBeenCalled();
  });
});
