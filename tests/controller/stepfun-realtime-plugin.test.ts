import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- runtime plugin ships as plain ESM JS without types.
import {
  buildSessionUpdate,
  handleServerEvent,
  toStepfunTools,
} from "../../apps/controller/static/runtime-plugins/nexu-stepfun-realtime/index.js";

describe("stepfun realtime plugin", () => {
  describe("buildSessionUpdate", () => {
    it("always pins pcm16 in both directions", () => {
      const update = buildSessionUpdate({});
      expect(update.type).toBe("session.update");
      expect(update.session.input_audio_format).toBe("pcm16");
      expect(update.session.output_audio_format).toBe("pcm16");
      expect(update.session.modalities).toEqual(["text", "audio"]);
    });

    it("enables server VAD by default so barge-in can work", () => {
      const update = buildSessionUpdate({});
      expect(update.session.turn_detection).toEqual({ type: "server_vad" });
    });

    it("omits turn_detection when server VAD is explicitly disabled", () => {
      const update = buildSessionUpdate({ serverVad: false });
      expect(update.session.turn_detection).toBeUndefined();
    });

    it("passes through the StepFun-specific VAD knobs", () => {
      const update = buildSessionUpdate({
        prefixPaddingMs: 300,
        silenceDurationMs: 120,
        energyAwakenessThreshold: 1800,
      });
      expect(update.session.turn_detection).toEqual({
        type: "server_vad",
        prefix_padding_ms: 300,
        silence_duration_ms: 120,
        energy_awakeness_threshold: 1800,
      });
    });

    it("only sends voice and instructions when set", () => {
      expect(buildSessionUpdate({}).session.voice).toBeUndefined();
      const configured = buildSessionUpdate({
        voice: "qingchunshaonv",
        instructions: "请简短回答",
      });
      expect(configured.session.voice).toBe("qingchunshaonv");
      expect(configured.session.instructions).toBe("请简短回答");
    });

    // The host composes instructions that teach the model to delegate to the
    // Nexu agent. A local override winning would silently disable the brain.
    it("prefers the host's instructions over configured ones", () => {
      const update = buildSessionUpdate(
        { instructions: "local" },
        { instructions: "consult the agent" },
      );
      expect(update.session.instructions).toBe("consult the agent");
    });

    it("falls back to configured instructions when the host sends none", () => {
      const update = buildSessionUpdate({ instructions: "local" }, {});
      expect(update.session.instructions).toBe("local");
    });

    // Without the host's tools the `agent-consult` brain has no channel back to
    // Nexu, and StepFun answers from its own weights instead.
    it("forwards the host's tools and opts into tool calling", () => {
      const update = buildSessionUpdate(
        {},
        {
          tools: [
            {
              type: "function",
              name: "openclaw_agent_consult",
              description: "Ask the agent",
              parameters: {
                type: "object",
                properties: { prompt: { type: "string" } },
                required: ["prompt"],
              },
            },
          ],
        },
      );
      expect(update.session.tools).toEqual([
        {
          type: "function",
          name: "openclaw_agent_consult",
          description: "Ask the agent",
          parameters: {
            type: "object",
            properties: { prompt: { type: "string" } },
            required: ["prompt"],
          },
        },
      ]);
      expect(update.session.tool_choice).toBe("auto");
    });

    it("omits the tools key entirely when the host sends none", () => {
      const update = buildSessionUpdate({}, {});
      expect(update.session.tools).toBeUndefined();
      expect(update.session.tool_choice).toBeUndefined();
    });
  });

  describe("toStepfunTools", () => {
    it("keeps function fields flat, as the realtime API expects", () => {
      expect(toStepfunTools([{ type: "function", name: "ping" }])).toEqual([
        {
          type: "function",
          name: "ping",
          description: "",
          parameters: { type: "object", properties: {} },
        },
      ]);
    });

    it("drops non-function tools and anything unnamed", () => {
      expect(
        toStepfunTools([
          { type: "retrieval" },
          { type: "function" },
          null,
          "nope",
        ]),
      ).toEqual([]);
      expect(toStepfunTools(undefined)).toEqual([]);
    });
  });

  describe("handleServerEvent", () => {
    it("decodes base64 audio deltas into PCM buffers", () => {
      const onAudio = vi.fn();
      const pcm = Buffer.from([0x01, 0x02, 0x03, 0x04]);
      const action = handleServerEvent(
        {
          type: "response.audio.delta",
          delta: pcm.toString("base64"),
          item_id: "msg_1",
        },
        { onAudio },
      );
      expect(action).toBe("audio");
      expect(onAudio).toHaveBeenCalledWith(pcm, { itemId: "msg_1" });
    });

    it("ignores an empty audio delta instead of emitting a zero-length buffer", () => {
      const onAudio = vi.fn();
      expect(
        handleServerEvent(
          { type: "response.audio.delta", delta: "" },
          { onAudio },
        ),
      ).toBe("ignored");
      expect(onAudio).not.toHaveBeenCalled();
    });

    // The contract is `onTranscript(role, text, isFinal)` — one callback for
    // both sides. Calling it with a bare string puts the sentence in the role
    // slot, which drops the transcript on the floor.
    it("reports both transcript sides through onTranscript with a role", () => {
      const onTranscript = vi.fn();
      handleServerEvent(
        { type: "response.audio_transcript.done", transcript: "你好" },
        { onTranscript },
      );
      handleServerEvent(
        {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "在吗",
        },
        { onTranscript },
      );
      expect(onTranscript).toHaveBeenNthCalledWith(
        1,
        "assistant",
        "你好",
        true,
      );
      expect(onTranscript).toHaveBeenNthCalledWith(2, "user", "在吗", true);
    });

    it("turns a finished function call into onToolCall with parsed args", () => {
      const onToolCall = vi.fn();
      const action = handleServerEvent(
        {
          type: "response.function_call_arguments.done",
          call_id: "call_1",
          item_id: "item_1",
          name: "openclaw_agent_consult",
          arguments: '{"prompt":"天气"}',
        },
        { onToolCall },
      );
      expect(action).toBe("tool-call");
      expect(onToolCall).toHaveBeenCalledWith({
        itemId: "item_1",
        callId: "call_1",
        name: "openclaw_agent_consult",
        args: { prompt: "天气" },
      });
    });

    it("still surfaces a tool call whose arguments are not valid JSON", () => {
      const onToolCall = vi.fn();
      handleServerEvent(
        {
          type: "response.function_call_arguments.done",
          call_id: "call_2",
          name: "ping",
          arguments: "{oops",
        },
        { onToolCall },
      );
      expect(onToolCall.mock.calls[0]?.[0]).toMatchObject({
        callId: "call_2",
        itemId: "call_2",
        args: "{oops",
      });
    });

    it("ignores a function call that is missing its call id", () => {
      const onToolCall = vi.fn();
      expect(
        handleServerEvent(
          { type: "response.function_call_arguments.done", name: "ping" },
          { onToolCall },
        ),
      ).toBe("ignored");
      expect(onToolCall).not.toHaveBeenCalled();
    });

    it("turns server-VAD speech_started into a barge-in clear", () => {
      const onClearAudio = vi.fn();
      const action = handleServerEvent(
        { type: "input_audio_buffer.speech_started", item_id: "msg_3" },
        { onClearAudio },
      );
      expect(action).toBe("barge-in");
      expect(onClearAudio).toHaveBeenCalledWith("barge-in");
    });

    it("surfaces errors with the provider message", () => {
      const onError = vi.fn();
      handleServerEvent(
        { type: "error", error: { message: "音频内容不完整" } },
        { onError },
      );
      expect(onError).toHaveBeenCalledWith(expect.any(Error));
      expect(onError.mock.calls[0]?.[0]?.message).toBe("音频内容不完整");
    });

    it("treats StepFun's thinking stream as non-spoken", () => {
      const onAudio = vi.fn();
      const onTranscript = vi.fn();
      // `response.thinking.*` has no OpenAI counterpart; it must never reach
      // playback or be mistaken for the spoken reply.
      expect(
        handleServerEvent(
          { type: "response.thinking.delta", delta: "让我想想" },
          { onAudio, onTranscript },
        ),
      ).toBe("ignored");
      expect(onAudio).not.toHaveBeenCalled();
      expect(onTranscript).not.toHaveBeenCalled();
    });
  });
});
