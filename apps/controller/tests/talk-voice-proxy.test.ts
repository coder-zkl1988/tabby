import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { TalkVoiceProxy } from "../src/services/talk-voice-proxy.js";

describe("TalkVoiceProxy", () => {
  it("forwards browser playback acknowledgements to the owning gateway session", async () => {
    const acknowledgeTalkPlayback = vi.fn();
    const acknowledged = new Promise<void>((resolve) => {
      acknowledgeTalkPlayback.mockImplementation(async () => {
        resolve();
      });
    });
    const proxy = new TalkVoiceProxy({
      isConnected: () => true,
      onTalkEvent: () => () => {},
      closeTalkSession: vi.fn().mockResolvedValue(undefined),
      acknowledgeTalkPlayback,
    } as never);
    const server = createServer();
    server.on("upgrade", (request, socket, head) => {
      proxy.handleUpgrade(request, socket, head);
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string")
      throw new Error("No test port");
    const client = new WebSocket(
      `ws://127.0.0.1:${address.port}/api/v1/talk/stream?sessionId=voice-1`,
    );
    try {
      await once(client, "open");
      client.send(
        JSON.stringify({ type: "acknowledgeMark", markName: "output-1" }),
      );
      await acknowledged;
      expect(acknowledgeTalkPlayback).toHaveBeenCalledExactlyOnceWith({
        sessionId: "voice-1",
        markName: "output-1",
      });
    } finally {
      client.terminate();
      proxy.close();
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });
});
