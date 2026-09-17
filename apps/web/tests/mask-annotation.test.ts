/**
 * mask-annotation.test.ts
 *
 * Local mask edit as a reference-image flow (reference v0.17). The composite
 * needs a real canvas, so only the prompt composer runs here.
 */

import { describe, expect, it } from "vitest";
import { composeMaskEditPrompt } from "../src/lib/canvas/mask-annotation";

describe("composeMaskEditPrompt", () => {
  it("names both reference images by the order they are connected", () => {
    const prompt = composeMaskEditPrompt("把选区改成金属材质");
    expect(prompt).toContain("参考图1 是原图");
    expect(prompt).toContain("参考图2");
  });

  it("tells the model not to keep the overlay — the whole point of the flow", () => {
    expect(composeMaskEditPrompt("x")).toContain("不得残留任何蓝色覆盖");
  });

  it("carries the instruction through, trimmed", () => {
    expect(composeMaskEditPrompt("  换成夜景  ")).toContain(
      "修改要求：换成夜景",
    );
  });
});
