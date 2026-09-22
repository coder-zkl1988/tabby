import { describe, expect, it } from "vitest";
import { extractTalkAudio } from "#web/lib/talk-voice";

/**
 * `talk.event` envelopes nest their payload differently depending on which
 * part of the Gateway emitted them. Extraction is deliberately shape-tolerant,
 * so these cases pin the tolerance rather than one blessed layout — a missed
 * match means a silent assistant, which is hard to debug from the UI.
 */
describe("extractTalkAudio", () => {
  it("returns nothing for non-objects", () => {
    expect(extractTalkAudio(null)).toEqual({});
    expect(extractTalkAudio("nope")).toEqual({});
  });

  it("reads audio from a flat envelope", () => {
    expect(
      extractTalkAudio({ type: "audio", audio: "QUJD", turnId: "t1" }),
    ).toMatchObject({ audioBase64: "QUJD", turnId: "t1" });
  });

  it("reads audio nested under payload", () => {
    expect(
      extractTalkAudio({ type: "audio", payload: { delta: "REVG" } }),
    ).toMatchObject({ audioBase64: "REVG" });
  });

  it("reads audio from a node-style talkEvent wrapper", () => {
    expect(
      extractTalkAudio({ talkEvent: { type: "audio", audio: "R0hJ" } }),
    ).toMatchObject({ audioBase64: "R0hJ" });
  });

  it("reads 9.4 relay audio outside its metadata-only talk event", () => {
    expect(
      extractTalkAudio({
        relaySessionId: "voice-1",
        type: "audio",
        audioBase64: "QUJD",
        talkEvent: {
          type: "output.audio.delta",
          turnId: "turn-1",
          payload: { byteLength: 3 },
        },
      }),
    ).toMatchObject({ audioBase64: "QUJD", turnId: "turn-1" });
  });

  it("uses the explicit user role from a finalized relay transcript", () => {
    expect(
      extractTalkAudio({
        relaySessionId: "voice-1",
        type: "transcript",
        role: "user",
        text: "你好",
        final: true,
        talkEvent: {
          type: "transcript.done",
          payload: { role: "user", text: "你好" },
          final: true,
        },
      }).transcript,
    ).toEqual({ text: "你好", role: "user", final: true });
  });

  it("does not commit a relay transcript whose explicit final flag is false", () => {
    expect(
      extractTalkAudio({
        type: "transcript",
        role: "user",
        text: "尚未说完",
        final: false,
      }).transcript,
    ).toEqual({ text: "尚未说完", role: "user", final: false });
  });

  it("ignores malformed nested event data", () => {
    expect(extractTalkAudio({ talkEvent: { payload: null } })).toEqual({
      audioBase64: undefined,
      turnId: undefined,
      transcript: undefined,
    });
  });

  it("ignores an empty audio string rather than queueing silence", () => {
    expect(extractTalkAudio({ type: "audio", audio: "" }).audioBase64).toBe(
      undefined,
    );
  });

  // `delta` holds base64 audio on audio events and plain text on transcript
  // events. Probing it blind sent sentences to `atob`, which throws on the
  // first space and took the whole message handler down with it.
  it("does not mistake a transcript delta's text for audio", () => {
    const result = extractTalkAudio({
      type: "response.audio_transcript.delta",
      delta: "Hello there",
    });
    expect(result.audioBase64).toBe(undefined);
  });

  it("marks a delta transcript as non-final so it is not committed", () => {
    const result = extractTalkAudio({
      type: "transcript.delta",
      transcript: "你好",
    });
    expect(result.transcript).toEqual({
      text: "你好",
      role: "assistant",
      final: false,
    });
  });

  it("marks a done transcript as final", () => {
    expect(
      extractTalkAudio({ type: "transcript.done", transcript: "你好" })
        .transcript?.final,
    ).toBe(true);
  });

  it("attributes input transcription to the user", () => {
    expect(
      extractTalkAudio({
        type: "conversation.item.input_audio_transcription.completed",
        transcript: "在吗",
      }).transcript,
    ).toEqual({ text: "在吗", role: "user", final: true });
  });
});
