/**
 * canvas-video-frame.test.ts
 *
 * Video still capture (reference v0.17). Only `frameTimeOf` is testable in the
 * plain Node env — the decode path needs a real <video> and canvas, the same
 * convention canvas-image-ops.ts follows for its offscreen draws.
 */

import { describe, expect, it } from "vitest";
import { frameTimeOf } from "../src/lib/canvas/canvas-video-frame";

describe("frameTimeOf", () => {
  it("first frame is time 0 regardless of playback position", () => {
    expect(frameTimeOf("first", 12, 7.5)).toBe(0);
  });

  it("last frame stops just short of the duration", () => {
    // Seeking exactly to `duration` lands past the final sample and decodes
    // blank, so the capture backs off by one epsilon.
    expect(frameTimeOf("last", 12, 0)).toBeCloseTo(11.95);
  });

  it("current frame uses the playback position", () => {
    expect(frameTimeOf("current", 12, 7.5)).toBe(7.5);
  });

  it("clamps a playback position past the end", () => {
    expect(frameTimeOf("current", 12, 99)).toBeCloseTo(11.95);
  });

  it("clamps a negative playback position", () => {
    expect(frameTimeOf("current", 12, -3)).toBe(0);
  });

  it("falls back to 0 when the duration is unknown or open-ended", () => {
    // NaN before metadata loads, Infinity for a live stream — both would make
    // a seek never resolve.
    expect(frameTimeOf("last", Number.NaN, 5)).toBe(0);
    expect(frameTimeOf("last", Number.POSITIVE_INFINITY, 5)).toBe(0);
    expect(frameTimeOf("current", Number.NaN, 5)).toBe(0);
  });

  it("a clip shorter than the epsilon still yields a valid time", () => {
    expect(frameTimeOf("last", 0.02, 0)).toBe(0);
  });
});
