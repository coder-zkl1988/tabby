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

/**
 * OpenClaw's own provider WebSocket opener.
 *
 * Plugins are materialized into `<state>/extensions/<id>/`, which has no
 * node_modules of its own, so a bare `import ... from "ws"` fails at load time
 * with "Cannot find package 'ws'" (verified against a live gateway). The host's
 * `plugin-sdk` subpaths *do* resolve from there, and this one does what a raw
 * socket cannot: it applies the runtime's proxy dispatcher (desktop propagates
 * `HTTP_PROXY`/`HTTPS_PROXY` into the OpenClaw child), the SSRF and TLS policy,
 * and a connect timeout — without it a blackholed endpoint hangs `connect()`
 * until the OS TCP timeout. Imported lazily so the unit tests can load this
 * module with no openclaw runtime on the resolution path.
 */
let cachedSocketOpener = null;
async function resolveSocketOpener() {
  if (!cachedSocketOpener) {
    const sdk = await import("openclaw/plugin-sdk/provider-http");
    cachedSocketOpener = sdk.openProviderWebSocket;
  }
  return cachedSocketOpener;
}

const DEFAULT_URL = "wss://api.stepfun.com/v1/realtime";
const DEFAULT_MODEL = "stepaudio-3-realtime-preview";
// StepFun documents pcm16 only; their console drives it through OpenAI's client,
// which is 24 kHz mono. Keep these in sync with `capabilities` below.
const SAMPLE_RATE_HZ = 24000;
const CONNECT_TIMEOUT_MS = 15_000;

/**
 * Translate OpenClaw's tool descriptors into StepFun's realtime shape.
 *
 * OpenClaw hands `{type, name, description, parameters}`; StepFun follows the
 * OpenAI *realtime* flattening, where a function tool keeps those at the top
 * level rather than nesting them under `function` the way chat completions do.
 */
export function toStepfunTools(tools) {
  if (!Array.isArray(tools)) return [];
  return tools
    .filter(
      (tool) => tool?.type === "function" && typeof tool?.name === "string",
    )
    .map((tool) => ({
      type: "function",
      name: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      parameters: tool.parameters ?? { type: "object", properties: {} },
    }));
}

/**
 * Build the `session.update` payload.
 *
 * `req` is the host's bridge request: it carries the instructions and tools
 * that implement the selected brain (`agent-consult` composes a tool the model
 * must call to reach the Nexu agent). Dropping them leaves StepFun answering
 * from its own weights, so host-supplied values win over local config.
 *
 * Split out from the socket so the mapping is unit-testable without a network.
 */
export function buildSessionUpdate(config, req) {
  const session = {
    modalities: ["text", "audio"],
    input_audio_format: "pcm16",
    output_audio_format: "pcm16",
  };
  const instructions =
    typeof req?.instructions === "string" && req.instructions
      ? req.instructions
      : config?.instructions;
  if (typeof instructions === "string" && instructions) {
    session.instructions = instructions;
  }
  const tools = toStepfunTools(req?.tools);
  if (tools.length > 0) {
    session.tools = tools;
    session.tool_choice = "auto";
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

function parseToolArgs(raw) {
  if (typeof raw !== "string" || raw.length === 0) return {};
  try {
    return JSON.parse(raw);
  } catch {
    // `args` is `unknown` in the contract, so hand the blob over unparsed
    // rather than dropping a tool call the model did ask for.
    return raw;
  }
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
        callbacks.onTranscript?.("assistant", event.transcript, true);
        return "transcript";
      }
      return "ignored";
    }
    case "conversation.item.input_audio_transcription.completed": {
      // What the *user* said. Both sides travel through the one `onTranscript`
      // callback in the contract, told apart by role.
      if (typeof event.transcript === "string" && event.transcript) {
        callbacks.onTranscript?.("user", event.transcript, true);
        return "input-transcript";
      }
      return "ignored";
    }
    case "response.function_call_arguments.done": {
      // The model asked to call a host tool. This is the only path back to the
      // Nexu agent under the `agent-consult` brain.
      if (typeof event.call_id !== "string" || typeof event.name !== "string") {
        return "ignored";
      }
      callbacks.onToolCall?.({
        itemId: typeof event.item_id === "string" ? event.item_id : event.call_id,
        callId: event.call_id,
        name: event.name,
        args: parseToolArgs(event.arguments),
      });
      return "tool-call";
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
    // `socket?.readyState === socket?.OPEN` would compare undefined to
    // undefined once the socket is nulled, pass, and then dereference null.
    if (socket !== null && socket.readyState === socket.OPEN) {
      socket.send(JSON.stringify(payload));
    }
  };

  return {
    // StepFun answers a tool call with one result; there is no "working then
    // final" continuation like some providers expose.
    supportsToolResultContinuation: false,
    // `response.create` is a separate frame, so a result can be handed back
    // without asking StepFun to speak again.
    supportsToolResultSuppression: true,

    connect: async () => {
      if (!config.apiKey) {
        throw new Error("StepFun realtime requires an API key");
      }
      const openSocket = await resolveSocketOpener();
      const target = `${config.url}?model=${encodeURIComponent(config.model)}`;
      socket = await openSocket({
        url: target,
        baseUrl: config.url,
        headers: { Authorization: `Bearer ${config.apiKey}` },
        timeoutMs: CONNECT_TIMEOUT_MS,
      });

      // The opener returns a socket that is still connecting, and registers its
      // own `close` listener to release the dispatcher agent — so detach only
      // the three listeners below, never `removeAllListeners`.
      await new Promise((resolve, reject) => {
        const detach = () => {
          socket.off("open", onOpen);
          socket.off("error", onFail);
          socket.off("close", onFail);
        };
        const onOpen = () => {
          detach();
          resolve();
        };
        const onFail = (error) => {
          detach();
          reject(
            error instanceof Error
              ? error
              : new Error("StepFun realtime socket closed before it opened"),
          );
        };
        socket.on("open", onOpen);
        socket.on("error", onFail);
        socket.on("close", onFail);
      });

      socket.on("message", (raw) => {
        let event;
        try {
          event = JSON.parse(String(raw));
        } catch {
          return;
        }
        if (event?.type === "session.created" && !ready) {
          ready = true;
          send(buildSessionUpdate(config, req));
          // The relay gates its own readiness on this callback. Without it no
          // `session.ready` is broadcast, provider errors are attributed to the
          // connect phase, and every normal hang-up reports "closed before the
          // session became ready" after a conversation that worked.
          req.onReady?.();
        }
        handleServerEvent(event, req);
      });
      socket.on("error", (error) => req.onError?.(error));
      socket.on("close", (code) => {
        ready = false;
        // 1000/1005 are the normal-closure codes; anything else — including the
        // 1006 a timeout abort produces — did not finish cleanly.
        req.onClose?.(code === 1000 || code === 1005 ? "completed" : "error");
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

    submitToolResult: (callId, result, options) => {
      send({
        type: "conversation.item.create",
        item: {
          type: "function_call_output",
          call_id: callId,
          output: typeof result === "string" ? result : JSON.stringify(result),
        },
      });
      // The host suppresses the follow-up when another channel already spoke
      // the answer; asking for a response anyway would answer twice.
      if (!options?.suppressResponse) {
        send({ type: "response.create" });
      }
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
