import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { type WebSocket, WebSocketServer } from "ws";
import { logger } from "../lib/logger.js";
import type { OpenClawGatewayService } from "./openclaw-gateway-service.js";

/**
 * Bridges the desktop web app to an OpenClaw realtime voice session.
 *
 * The web app has no route to the Gateway, so audio is proxied in both
 * directions over one WebSocket:
 *
 *   browser mic  --binary PCM16-->  proxy  --talk.session.appendAudio-->  Gateway
 *   browser spk  <--JSON events---  proxy  <--talk.event broadcast------  Gateway
 *
 * Downstream frames are forwarded verbatim. The proxy deliberately does not
 * parse the audio envelope: OpenClaw owns that shape, and re-encoding it here
 * would add a second place to keep in sync for no benefit.
 *
 * Binary client frames are audio; text frames are control ("cancel", "close").
 */

const PATH_PREFIX = "/api/v1/talk/stream";

function parseSessionId(url: string): string | null {
  const [path, query] = url.split("?");
  if (path !== PATH_PREFIX) return null;
  const sessionId = new URLSearchParams(query ?? "").get("sessionId");
  return sessionId && sessionId.length > 0 ? sessionId : null;
}

export class TalkVoiceProxy {
  private readonly wss: WebSocketServer;

  constructor(private readonly gateway: OpenClawGatewayService) {
    this.wss = new WebSocketServer({ noServer: true });
  }

  /**
   * Returns true when the URL belongs to this proxy (whether or not the
   * upgrade then succeeds), so the caller can stop offering it to others.
   */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    const sessionId = parseSessionId(req.url ?? "");
    if (sessionId === null) return false;

    this.wss.handleUpgrade(req, socket, head, (clientWs) => {
      this.bridge(clientWs, sessionId);
    });
    return true;
  }

  private bridge(clientWs: WebSocket, sessionId: string): void {
    if (!this.gateway.isConnected()) {
      clientWs.close(4404, "OpenClaw gateway is not connected");
      return;
    }

    // Only forward events for this session; a Gateway may run several.
    const unsubscribe = this.gateway.onTalkEvent((payload) => {
      if (!belongsToSession(payload, sessionId)) return;
      if (clientWs.readyState !== clientWs.OPEN) return;
      try {
        clientWs.send(JSON.stringify(payload));
      } catch {
        // A dead client is torn down by its own close handler.
      }
    });

    let closed = false;
    const teardown = (reason: string) => {
      if (closed) return;
      closed = true;
      unsubscribe();
      void this.gateway.closeTalkSession(sessionId).catch(() => {
        // The Gateway may have already expired the session.
      });
      logger.info({ sessionId, reason }, "talk_voice_proxy_closed");
    };

    clientWs.on("message", (data, isBinary) => {
      if (isBinary) {
        // Audio frames are the hot path: forward and move on. Failures are
        // dropped rather than queued — stale microphone audio is worse than a
        // gap, and the Gateway reports session death through talk.event.
        const audio = Buffer.isBuffer(data)
          ? data
          : Buffer.from(data as ArrayBuffer);
        void this.gateway
          .appendTalkAudio({ sessionId, audio: audio.toString("base64") })
          .catch((error: unknown) => {
            logger.debug(
              { sessionId, error: errorMessage(error) },
              "talk_voice_append_failed",
            );
          });
        return;
      }

      let control: { type?: string; turnId?: string };
      try {
        control = JSON.parse(String(data)) as typeof control;
      } catch {
        return;
      }
      if (control.type === "cancel") {
        void this.gateway
          .cancelTalkOutput({ sessionId, turnId: control.turnId })
          .catch(() => {
            // Cancelling a finished turn is a no-op, not an error.
          });
        return;
      }
      if (control.type === "close") {
        teardown("client-close");
        clientWs.close(1000, "closed by client");
      }
    });

    clientWs.on("close", () => teardown("socket-close"));
    clientWs.on("error", () => teardown("socket-error"));
  }

  close(): void {
    this.wss.close();
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown error";
}

/**
 * `talk.event` broadcasts carry the session id at one of a couple of depths
 * depending on the emitter, and node-originated envelopes nest it under
 * `talkEvent`. Match defensively rather than pinning one shape: a missed match
 * would silently mute the assistant.
 */
function belongsToSession(payload: unknown, sessionId: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  const record = payload as Record<string, unknown>;
  const candidates = [
    record.sessionId,
    record.voiceSessionId,
    record.relaySessionId,
    (record.talkEvent as Record<string, unknown> | undefined)?.sessionId,
  ];
  if (candidates.some((value) => value === sessionId)) return true;
  // An envelope with no session id at all is session-wide telemetry; passing it
  // through is safer than dropping a terminal event.
  return candidates.every((value) => value === undefined);
}
