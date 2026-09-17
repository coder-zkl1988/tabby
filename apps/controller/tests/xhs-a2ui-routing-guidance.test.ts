import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { RENDER_A2UI_DESCRIPTION } from "../static/runtime-plugins/nexu-a2ui/index.js";
import { CANVAS_OP_DESCRIPTION } from "../static/runtime-plugins/nexu-canvas/index.js";

describe("XHS image routing guidance", () => {
  it("routes generated images back to the existing chat surface", () => {
    expect(RENDER_A2UI_DESCRIPTION).toContain("same surfaceId");
    expect(RENDER_A2UI_DESCRIPTION).toContain(
      "NEVER use canvas_read or canvas_op for a chat XHS component",
    );
    expect(RENDER_A2UI_DESCRIPTION).toContain(
      "image_generate returned a real media path",
    );
  });

  it("keeps chat XHS components outside the canvas proposal flow", () => {
    expect(CANVAS_OP_DESCRIPTION).toContain(
      "A chat XHSEditor or XHSBatchTable is NOT a canvas node",
    );
    expect(CANVAS_OP_DESCRIPTION).toContain("render_a2ui");
  });

  it("requires profile material confirmation before nurturing plans", () => {
    const toolsTemplate = readFileSync(
      new URL("../static/platform-templates/en/TOOLS.md", import.meta.url),
      "utf8",
    );
    for (const guidance of [RENDER_A2UI_DESCRIPTION, toolsTemplate]) {
      expect(guidance).toContain("xhs_ops_profile_material_confirmed");
      expect(guidance).toContain("Do not proceed");
      expect(guidance).not.toContain(
        "XhsOpsProfileMaterial** (optional, after personas are saved)",
      );
    }
  });
});
