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

  it("ignores an empty audio string rather than queueing silence", () => {
    expect(extractTalkAudio({ type: "audio", audio: "" }).audioBase64).toBe(
      undefined,
    );
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
