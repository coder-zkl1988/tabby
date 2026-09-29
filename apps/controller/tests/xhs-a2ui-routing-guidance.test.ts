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

  it("offers the existing-account entry, not just the build-from-scratch one", () => {
    // Both sources described a single pipeline starting at XhsOpsProjectForm,
    // so "手机已经登录了小红书，帮我优化账号" opened an empty project form and
    // promised 账号人设/养号方案 — the readback the product already ships was
    // unreachable because nothing told the agent entryMode "existing" exists.
    const toolsTemplate = readFileSync(
      new URL("../static/platform-templates/en/TOOLS.md", import.meta.url),
      "utf8",
    );
    for (const guidance of [RENDER_A2UI_DESCRIPTION, toolsTemplate]) {
      expect(guidance).toContain("已有账号");
      expect(guidance).toContain("xhs_ops_existing_accounts_selected");
      // The planner carries the next step in the event payload; an agent that
      // does not know to follow it falls back to the new-account script.
      expect(guidance).toContain("agentInstruction");
      expect(guidance).toContain(
        "target-user profile still requires HUMAN confirmation",
      );
      expect(guidance).toContain("not target-profile confirmation");
    }
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
