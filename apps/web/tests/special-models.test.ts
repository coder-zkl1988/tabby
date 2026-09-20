import { getSpecialModelLabelKey } from "@/lib/special-models";
import { describe, expect, it } from "vitest";

describe("special-purpose models", () => {
  it.each(["tabby-image-pro", "tabby-image-flash"])(
    "marks %s as image-generation only",
    (modelId) => {
      expect(getSpecialModelLabelKey(modelId)).toBe("models.special.image");
    },
  );

  it.each(["tabby-image", "tabby-image-free"])(
    "keeps the legacy %s alias disabled while stale model caches drain",
    (modelId) => {
      expect(getSpecialModelLabelKey(modelId)).toBe("models.special.image");
    },
  );

  it("marks tabby-audio as voice-only", () => {
    // Realtime voice runs over a WebSocket session and cannot answer a chat
    // completion, so picking it as a bot model would fail at send time.
    expect(getSpecialModelLabelKey("tabby-audio")).toBe("models.special.voice");
  });

  it("keeps general chat models selectable", () => {
    expect(getSpecialModelLabelKey("tabby-ultra")).toBeNull();
  });
});
