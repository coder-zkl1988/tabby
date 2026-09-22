import type { SessionResponse } from "@nexu/shared";
import { describe, expect, it, vi } from "vitest";
import type { SessionsRuntime } from "../src/runtime/sessions-runtime.js";
import type { OpenClawGatewayService } from "../src/services/openclaw-gateway-service.js";
import { SessionService } from "../src/services/session-service.js";

const session: SessionResponse = {
  id: "session-1.jsonl",
  botId: "bot-1",
  sessionKey: "agent:bot-1:conversation",
  title: "Conversation",
  status: "active",
  channelId: null,
  channelType: "webchat",
  messageCount: 2,
  lastMessageAt: null,
  metadata: null,
  createdAt: "2026-09-21T00:00:00.000Z",
  updatedAt: "2026-09-21T00:00:00.000Z",
};

describe("SessionService gateway persistence", () => {
  it("opens checkpoint recovery by gateway identity without materializing a SQLite URI", async () => {
    const runtime = {
      usesGatewayPersistence: () => true,
      getSession: vi.fn(async () => session),
      materializeSessionFile: vi.fn(),
      invalidateSessionsCache: vi.fn(),
    } as unknown as SessionsRuntime;
    const gateway = {
      isConnected: () => true,
      sessionsCompactionBranch: vi.fn(async () => ({
        key: "agent:bot-1:recovery",
        sessionId: "recovery-session",
        entry: {
          sessionFile:
            "sqlite:bot-1:recovery-session:/runtime/openclaw-agent.sqlite",
        },
        checkpoint: {
          checkpointId: "checkpoint-1",
          createdAt: 1780000000000,
          reason: "manual",
        },
      })),
      sessionsPatch: vi.fn(async () => ({ ok: true })),
    } as unknown as OpenClawGatewayService;
    const service = new SessionService(runtime, gateway);
    expect(
      await service.branchFromCheckpoint(session.id, "checkpoint-1"),
    ).toMatchObject({
      id: "recovery-session.jsonl",
      sessionKey: "agent:bot-1:recovery",
    });
    expect(runtime.materializeSessionFile).not.toHaveBeenCalled();
    expect(gateway.sessionsPatch).toHaveBeenCalledWith({
      key: "agent:bot-1:recovery",
      agentId: "bot-1",
      label: "Conversation · recovery",
    });
  });
  it("does not repeat a rename already persisted by the runtime", async () => {
    const runtime = {
      usesGatewayPersistence: () => true,
      updateSession: vi.fn(async () => ({ ...session, title: "Renamed" })),
    } as unknown as SessionsRuntime;
    const gateway = {
      isConnected: () => true,
      sessionsPatch: vi.fn(),
    } as unknown as OpenClawGatewayService;
    const service = new SessionService(runtime, gateway);
    expect(
      await service.updateSession(session.id, { title: "Renamed" }),
    ).toMatchObject({ title: "Renamed" });
    expect(runtime.updateSession).toHaveBeenCalledWith(session.id, {
      title: "Renamed",
    });
    expect(gateway.sessionsPatch).not.toHaveBeenCalled();
  });

  it("opens a fork from its gateway identity without creating legacy transcript files", async () => {
    const runtime = {
      usesGatewayPersistence: () => true,
      getSession: vi.fn(async () => session),
      materializeSessionFile: vi.fn(),
      invalidateSessionsCache: vi.fn(),
    } as unknown as SessionsRuntime;
    const gateway = {
      isConnected: () => true,
      sessionsCreate: vi.fn(async () => ({
        key: "agent:bot-1:forked",
        sessionId: "forked-session",
        entry: { sessionId: "forked-session" },
      })),
      sessionsPatch: vi.fn(async () => ({ ok: true })),
    } as unknown as OpenClawGatewayService;
    const service = new SessionService(runtime, gateway);
    expect(await service.forkSession(session.id)).toMatchObject({
      id: "forked-session.jsonl",
      sessionKey: "agent:bot-1:forked",
      title: "Conversation · fork",
    });
    expect(runtime.materializeSessionFile).not.toHaveBeenCalled();
    expect(gateway.sessionsPatch).toHaveBeenCalledWith({
      key: "agent:bot-1:forked",
      agentId: "bot-1",
      label: "Conversation · fork",
    });
    expect(runtime.invalidateSessionsCache).toHaveBeenCalled();
  });
});
