import { describe, expect, it, vi } from "vitest";
// @ts-expect-error -- runtime plugin ships as plain ESM JS without types.
import {
  buildSessionUpdate,
  handleServerEvent,
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

    it("routes assistant transcript and user transcript to different callbacks", () => {
      const onTranscript = vi.fn();
      const onInputTranscript = vi.fn();
      handleServerEvent(
        { type: "response.audio_transcript.done", transcript: "你好" },
        { onTranscript, onInputTranscript },
      );
      handleServerEvent(
        {
          type: "conversation.item.input_audio_transcription.completed",
          transcript: "在吗",
        },
        { onTranscript, onInputTranscript },
      );
      expect(onTranscript).toHaveBeenCalledWith("你好");
      expect(onInputTranscript).toHaveBeenCalledWith("在吗");
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
