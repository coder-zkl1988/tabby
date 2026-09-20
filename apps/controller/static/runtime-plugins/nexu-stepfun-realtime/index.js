// nexu-stepfun-realtime: register StepFun's StepAudio 3 Realtime as an OpenClaw
// realtime voice provider.
//
// StepFun's realtime API is event-compatible with OpenAI's — their own console
// (stepfun-ai/Step-Realtime-Console) ships `openai-realtime-api-beta` verbatim —
// so this bridge is mostly endpoint + auth + model naming. The wire format is
// therefore the same pcm16 @ 24 kHz mono OpenClaw already advertises for OpenAI.
//
// StepFun-specific bits that are NOT in the OpenAI protocol:
//   - `response.thinking.delta` / `.done`: the model's "think while speaking"
//     trace. Surfaced as transcript-ish diagnostics, never as spoken text.
//   - `turn_detection.energy_awakeness_threshold`: extra server-VAD knob.
//   - tools may be `{type:"retrieval"}` for vector stores, alongside functions.
//
// Docs: https://platform.stepfun.com/docs/zh/api-reference/realtime/chat

import { createRequire } from "node:module";

/**
 * `ws`, resolved from openclaw's own node_modules.
 *
 * Plugins are materialized into `<state>/extensions/<id>/`, which has no
 * node_modules of its own, so a bare `import ... from "ws"` fails with
 * "Cannot find package 'ws'" at load time (verified against a live gateway).
 * The global WebSocket cannot be used instead: StepFun authenticates with an
 * `Authorization` header, which the WHATWG constructor does not accept.
 * Anchoring a CJS resolver at an openclaw module reaches the runtime's own
 * copy. Resolved lazily so a load-time failure cannot take the plugin down.
 */
let cachedWebSocket = null;
function resolveWebSocket() {
  if (cachedWebSocket) return cachedWebSocket;
  const anchor = import.meta.resolve("openclaw/plugin-sdk/core");
  const nodeRequire = createRequire(anchor);
  const mod = nodeRequire("ws");
  cachedWebSocket = mod.WebSocket ?? mod.default?.WebSocket ?? mod;
  return cachedWebSocket;
}

const DEFAULT_URL = "wss://api.stepfun.com/v1/realtime";
const DEFAULT_MODEL = "stepaudio-3-realtime-preview";
// StepFun documents pcm16 only; their console drives it through OpenAI's client,
// which is 24 kHz mono. Keep these in sync with `capabilities` below.
const SAMPLE_RATE_HZ = 24000;

/**
 * Build the `session.update` payload from plugin config.
 *
 * Split out from the socket so the mapping is unit-testable without a network.
 */
export function buildSessionUpdate(config) {
  const session = {
    modalities: ["text", "audio"],
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
  };
  if (typeof config?.instructions === "string" && config.instructions) {
    session.instructions = config.instructions;
  }
  if (typeof config?.voice === "string" && config.voice) {
    session.voice = config.voice;
  }
  // Server VAD is what lets StepFun detect a real interruption; without it the
  // model cannot be barged into and `speech_started` never arrives.
  if (config?.serverVad !== false) {
    const turnDetection = { type: "server_vad" };
    if (Number.isInteger(config?.prefixPaddingMs)) {
      turnDetection.prefix_padding_ms = config.prefixPaddingMs;
    }
    if (Number.isInteger(config?.silenceDurationMs)) {
      turnDetection.silence_duration_ms = config.silenceDurationMs;
    }
    if (Number.isInteger(config?.energyAwakenessThreshold)) {
      turnDetection.energy_awakeness_threshold = config.energyAwakenessThreshold;
    }
    session.turn_detection = turnDetection;
  }
  return { type: "session.update", session };
}

/**
 * Map one inbound StepFun event onto OpenClaw bridge callbacks.
 *
 * Returns the action taken so tests can assert routing without a live socket.
 */
export function handleServerEvent(event, callbacks) {
  const type = event?.type;
  switch (type) {
    case "response.audio.delta": {
      if (typeof event.delta !== "string" || event.delta.length === 0) {
        return "ignored";
      }
      callbacks.onAudio?.(Buffer.from(event.delta, "base64"), {
        itemId: event.item_id,
      });
      return "audio";
    }
    case "response.audio_transcript.done": {
      if (typeof event.transcript === "string" && event.transcript) {
        callbacks.onTranscript?.(event.transcript);
        return "transcript";
      }
      return "ignored";
    }
    case "conversation.item.input_audio_transcription.completed": {
      // What the *user* said. Reported separately so the session can show both
      // sides; StepFun delivers it asynchronously from the response.
      if (typeof event.transcript === "string" && event.transcript) {
        callbacks.onInputTranscript?.(event.transcript);
        return "input-transcript";
      }
      return "ignored";
    }
    case "input_audio_buffer.speech_started": {
      // Server VAD confirmed a human started talking over the assistant. This
      // is the signal OpenClaw needs for `handlesInputAudioBargeIn`.
      callbacks.onClearAudio?.("barge-in");
      return "barge-in";
    }
    case "error": {
      const message =
        event.error?.message ?? "StepFun realtime reported an error";
      callbacks.onError?.(new Error(message));
      return "error";
    }
    case "session.created":
      return "ready";
    default:
      return "ignored";
  }
}

function resolveConfig(req, pluginConfig) {
  const providerConfig = req?.providerConfig ?? {};
  const pick = (key) => {
    const fromProvider = providerConfig[key];
    if (typeof fromProvider === "string" && fromProvider) return fromProvider;
    const fromPlugin = pluginConfig?.[key];
    if (typeof fromPlugin === "string" && fromPlugin) return fromPlugin;
    return undefined;
  };
  return {
    apiKey: pick("apiKey") ?? req?.apiKey,
    model: pick("model") ?? DEFAULT_MODEL,
    url: pick("url") ?? DEFAULT_URL,
    voice: pick("voice"),
    instructions: pick("instructions"),
    serverVad: pluginConfig?.serverVad,
    prefixPaddingMs: pluginConfig?.prefixPaddingMs,
    silenceDurationMs: pluginConfig?.silenceDurationMs,
    energyAwakenessThreshold: pluginConfig?.energyAwakenessThreshold,
  };
}

function createStepfunBridge(req, pluginConfig) {
  const config = resolveConfig(req, pluginConfig);
  let socket = null;
  let ready = false;

  const send = (payload) => {
    if (socket?.readyState === socket?.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  return {
    // StepFun answers a tool call with one result; there is no "working then
    // final" continuation like some providers expose.
    supportsToolResultContinuation: false,

    connect: async () => {
      if (!config.apiKey) {
        throw new Error("StepFun realtime requires an API key");
      }
      const WebSocketImpl = resolveWebSocket();
      const target = `${config.url}?model=${encodeURIComponent(config.model)}`;
      socket = new WebSocketImpl(target, {
        headers: { Authorization: `Bearer ${config.apiKey}` },
      });

      await new Promise((resolve, reject) => {
        const failOpen = (error) => reject(error ?? new Error("socket closed"));
        socket.once("open", resolve);
        socket.once("error", failOpen);
        socket.once("close", failOpen);
      });
      socket.removeAllListeners("error");
      socket.removeAllListeners("close");

      socket.on("message", (raw) => {
        let event;
        try {
          event = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (event?.type === "session.created" && !ready) {
          ready = true;
          send(buildSessionUpdate(config));
        }
        handleServerEvent(event, req);
      });
      socket.on("error", (error) => req.onError?.(error));
      socket.on("close", () => {
        ready = false;
        req.onClose?.();
      });
    },

    sendAudio: (audio) => {
      send({
        type: "input_audio_buffer.append",
        audio: Buffer.from(audio).toString("base64"),
      });
    },

    // OpenClaw drives playback timing; StepFun tracks it server-side, so there
    // is nothing to forward here.
    setMediaTimestamp: () => {},

    handleBargeIn: () => {
      send({ type: "response.cancel" });
    },

    submitToolResult: (toolCallId, result) => {
      send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: toolCallId,
          output: typeof result === "string" ? result : JSON.stringify(result),
        },
      });
      send({ type: "response.create" });
    },

    acknowledgeMark: () => {},

    close: () => {
      ready = false;
      try {
        socket?.close();
      } catch {
        // Closing a already-dead socket must not surface as a session error.
      }
      socket = null;
    },

    isConnected: () => socket !== null && socket.readyState === socket.OPEN,
  };
}

const plugin = {
  id: "nexu-stepfun-realtime",
  name: "Nexu StepFun Realtime Voice",
  description:
    "Registers StepFun StepAudio 3 Realtime as an OpenClaw realtime voice provider.",
  register(api) {
    const pluginConfig = api?.pluginConfig ?? {};

    api.registerRealtimeVoiceProvider({
      id: "stepfun",
      label: "StepFun Realtime Voice (StepAudio 3)",
      capabilities: {
        // Gateway relay only: Nexu's web UI talks to the controller, not
        // straight to StepFun, so there is no client-owned WebRTC peer.
        transports: ["gateway-relay"],
        inputAudioFormats: [
          { encoding: "pcm16", sampleRateHz: SAMPLE_RATE_HZ, channels: 1 },
        ],
        outputAudioFormats: [
          { encoding: "pcm16", sampleRateHz: SAMPLE_RATE_HZ, channels: 1 },
        ],
        supportsBargeIn: true,
        // StepFun server VAD emits `input_audio_buffer.speech_started`, so the
        // provider — not OpenClaw's local fallback — confirms interruptions.
        handlesInputAudioBargeIn: true,
        supportsToolCalls: true,
      },
      isConfigured: ({ providerConfig }) =>
        Boolean(providerConfig?.apiKey ?? pluginConfig.apiKey),
      createBridge: (req) => createStepfunBridge(req, pluginConfig),
    });
  },
};

export default plugin;
