import type { OpenClawConfig } from "@nexu/shared";
import { describe, expect, it, vi } from "vitest";
import { OpenClawGatewayService } from "../src/services/openclaw-gateway-service.js";

function makeConfig(overrides: Partial<OpenClawConfig> = {}): OpenClawConfig {
  return {
    gateway: { port: 18789, mode: "local", bind: "127.0.0.1" },
    agents: { entries: {}, defaults: {} },
    channels: {},
    bindings: [],
    plugins: { load: { paths: [] }, entries: {} },
    skills: { load: { watch: true } },
    commands: { native: "auto" },
    ...overrides,
  } as OpenClawConfig;
}

describe("OpenClawGatewayService", () => {
  it("sends captured voice frames using the 9.4 audioBase64 wire field", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const service = new OpenClawGatewayService({ request } as never);

    await service.appendTalkAudio({ sessionId: "voice-1", audio: "QUJD" });

    expect(request).toHaveBeenCalledWith("talk.session.appendAudio", {
      sessionId: "voice-1",
      audioBase64: "QUJD",
    });
  });

  it("acknowledges completed voice playback marks", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const service = new OpenClawGatewayService({ request } as never);

    await service.acknowledgeTalkPlayback({
      sessionId: "voice-1",
      markName: "output-1",
    });

    expect(request).toHaveBeenCalledWith("talk.session.acknowledgeMark", {
      sessionId: "voice-1",
      markName: "output-1",
    });
  });

  it("reads every runtime session page, including archived sessions", async () => {
    const first = { key: "agent:bot:one", sessionId: "one" };
    const archived = { key: "agent:bot:two", sessionId: "two", archived: true };
    const request = vi
      .fn()
      .mockResolvedValueOnce({
        sessions: [first],
        hasMore: true,
        nextOffset: 1,
      })
      .mockResolvedValueOnce({ sessions: [archived], hasMore: false });
    const service = new OpenClawGatewayService({ request } as never);
    await expect(service.listStoredSessions()).resolves.toEqual({
      sessions: [first, archived],
    });
    expect(request).toHaveBeenNthCalledWith(2, "sessions.list", {
      limit: 200,
      offset: 1,
      includeDerivedTitles: true,
      configuredAgentsOnly: true,
      archived: "all",
    });
  });

  it("rejects an invalid session page instead of silently losing history", async () => {
    const request = vi
      .fn()
      .mockResolvedValue({ sessions: [], hasMore: true, nextOffset: 0 });
    const service = new OpenClawGatewayService({ request } as never);
    await expect(service.listStoredSessions()).rejects.toThrow(
      "pagination did not advance",
    );
    expect(request).toHaveBeenCalledTimes(1);
  });

  it("preserves transcript IDs and scopes historical reads to their session ID", async () => {
    const messages = [
      { role: "assistant", content: "reply", __openclaw: { id: "entry-1" } },
    ];
    const request = vi.fn().mockResolvedValue({ messages });
    const service = new OpenClawGatewayService({ request } as never);
    await expect(
      service.getStoredChatHistory("agent:bot:one", 2000, "old-run"),
    ).resolves.toEqual({ messages });
    expect(request).toHaveBeenCalledWith("chat.history", {
      sessionKey: "agent:bot:one",
      limit: 1000,
      sessionId: "old-run",
    });
  });

  it("leaves SQLite session mutations with the gateway", async () => {
    const request = vi.fn().mockResolvedValue({ ok: true });
    const service = new OpenClawGatewayService({ request } as never);
    const target = { key: "agent:bot:one", agentId: "bot" };
    await service.sessionsReset(target);
    await service.sessionsDelete(target);
    expect(request).toHaveBeenNthCalledWith(1, "sessions.reset", target);
    expect(request).toHaveBeenNthCalledWith(2, "sessions.delete", target);
  });

  it("treats semantically identical configs as unchanged despite key reorder", async () => {
    const service = new OpenClawGatewayService({
      isConnected: () => true,
    } as never);

    const configA = makeConfig({
      plugins: {
        entries: {
          zed: { enabled: true },
          alpha: { enabled: true },
        },
        load: { paths: [] },
      },
    });
    const configB = makeConfig({
      plugins: {
        load: { paths: [] },
        entries: {
          alpha: { enabled: true },
          zed: { enabled: true },
        },
      },
    });

    service.noteConfigWritten(configA);

    await expect(service.shouldPushConfig(configB)).resolves.toBe(false);
  });

  describe("getAllChannelsLiveStatus gateway-offline reporting", () => {
    const channels = [
      { id: "ch1", channelType: "feishu", accountId: "feishu-acct" },
      { id: "ch2", channelType: "slack", accountId: "T0001" },
    ];

    it("reports connecting + configured when WS is not connected", async () => {
      const service = new OpenClawGatewayService({
        isConnected: () => false,
        request: vi.fn(),
      } as never);

      const result = await service.getAllChannelsLiveStatus(channels);

      expect(result.gatewayConnected).toBe(false);
      for (const entry of result.channels) {
        expect(entry.status).toBe("connecting");
        expect(entry.configured).toBe(true);
        expect(entry.connected).toBe(false);
        expect(entry.running).toBe(false);
        expect(entry.lastError).toBeNull();
      }
    });

    it("reports connecting + configured when the channels.status RPC throws", async () => {
      const service = new OpenClawGatewayService({
        isConnected: () => true,
        request: vi.fn(async () => {
          throw new Error("openclaw gateway not connected");
        }),
      } as never);

      const result = await service.getAllChannelsLiveStatus(channels);

      expect(result.gatewayConnected).toBe(false);
      for (const entry of result.channels) {
        expect(entry.status).toBe("connecting");
        expect(entry.configured).toBe(true);
        expect(entry.connected).toBe(false);
        expect(entry.running).toBe(false);
        expect(entry.lastError).toBeNull();
      }
    });
  });

  it("sends side questions through OpenClaw's isolated BTW lane", async () => {
    const request = vi.fn(async () => ({ runId: "side-run-1" }));
    const service = new OpenClawGatewayService({ request } as never);

    await expect(
      service.sendSideQuestion("agent:bot-1:main", "what is still running?"),
    ).resolves.toEqual({ runId: "side-run-1" });
    expect(request).toHaveBeenCalledWith(
      "chat.send",
      expect.objectContaining({
        sessionKey: "agent:bot-1:main",
        message: "/btw what is still running?",
        deliver: false,
        idempotencyKey: expect.any(String),
      }),
      { timeoutMs: 130_000 },
    );
  });

  it("queries the runtime-authenticated model catalog", async () => {
    const request = vi.fn(async () => ({
      models: [
        {
          id: "tabby-ultra",
          name: "tabby-ultra",
          provider: "link",
          api: "openai-completions",
          available: true,
          contextWindow: 258_000,
          reasoning: false,
          input: ["text", "image"],
          compat: { supportsStore: false },
        },
      ],
    }));
    const service = new OpenClawGatewayService({ request } as never);

    await expect(service.listModels("all")).resolves.toEqual({
      models: [
        expect.objectContaining({
          id: "tabby-ultra",
          provider: "link",
          available: true,
          contextWindow: 258_000,
        }),
      ],
    });
    expect(request).toHaveBeenCalledWith("models.list", { view: "all" });
  });

  it("rejects the obsolete key-based model catalog contract", async () => {
    const request = vi.fn(async () => ({
      models: [{ key: "link/tabby-ultra", available: true }],
    }));
    const service = new OpenClawGatewayService({ request } as never);

    await expect(service.listModels("configured")).rejects.toThrow();
  });

  it("replaces the active run through OpenClaw's sessions.steer RPC", async () => {
    const request = vi.fn(async () => ({
      runId: "steer-command-1",
      interruptedActiveRun: true,
    }));
    const service = new OpenClawGatewayService({ request } as never);

    await expect(
      service.steerChatSession("agent:bot-1:main", "summarize findings now"),
    ).resolves.toEqual({
      runId: "steer-command-1",
      interruptedActiveRun: true,
    });

    expect(request).toHaveBeenCalledWith(
      "sessions.steer",
      expect.objectContaining({
        key: "agent:bot-1:main",
        message: "summarize findings now",
        idempotencyKey: expect.any(String),
      }),
      { timeoutMs: 130_000 },
    );
  });

  it("uses the OpenClaw operator RPCs for desktop operations", async () => {
    const request = vi.fn(async () => ({}));
    const service = new OpenClawGatewayService({ request } as never);

    await service.listExecApprovals();
    await service.listPluginApprovals();
    await service.resolveApproval({
      id: "approval-1",
      kind: "exec",
      decision: "allow-once",
    });
    await service.listTasks({ sessionKey: "agent:bot-1:main", limit: 20 });
    await service.cancelTask({ taskId: "task-1", reason: "Stopped by user" });
    await service.getSessionUsage({
      key: "agent:bot-1:main",
      includeContextWeight: true,
    });
    await service.getProviderUsage();
    await service.getMemoryStatus("bot-1");

    expect(request.mock.calls).toEqual([
      ["exec.approval.list", {}],
      ["plugin.approval.list", {}],
      ["exec.approval.resolve", { id: "approval-1", decision: "allow-once" }],
      ["tasks.list", { sessionKey: "agent:bot-1:main", limit: 20 }],
      ["tasks.cancel", { taskId: "task-1", reason: "Stopped by user" }],
      [
        "sessions.usage",
        {
          key: "agent:bot-1:main",
          includeContextWeight: true,
          groupBy: "instance",
          limit: 1,
        },
      ],
      ["usage.status", {}],
      ["doctor.memory.status", { agentId: "bot-1" }],
    ]);
  });
});
