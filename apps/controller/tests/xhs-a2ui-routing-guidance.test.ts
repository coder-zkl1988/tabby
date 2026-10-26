import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/** What this file reads from the runtime plugins: plain JS without declarations. */
type A2uiPluginModule = {
  default: {
    register: (api: {
      registerTool: (tool: RegisteredTool) => void;
    }) => void;
  };
  RENDER_A2UI_DESCRIPTION: string;
};
type CanvasPluginModule = { CANVAS_OP_DESCRIPTION: string };

const pluginUrl = (name: string) =>
  new URL(`../static/runtime-plugins/${name}/index.js`, import.meta.url).href;
const { default: a2uiPlugin, RENDER_A2UI_DESCRIPTION }: A2uiPluginModule =
  await import(pluginUrl("nexu-a2ui"));
const { CANVAS_OP_DESCRIPTION }: CanvasPluginModule = await import(
  pluginUrl("nexu-canvas")
);

const toolsTemplate = readFileSync(
  new URL("../static/platform-templates/en/TOOLS.md", import.meta.url),
  "utf8",
);

/** Both places the agent reads its xhs-ops routing from. */
const GUIDANCE = [
  ["render_a2ui description", RENDER_A2UI_DESCRIPTION],
  ["TOOLS.md template", toolsTemplate],
] as const;

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
    for (const [, guidance] of GUIDANCE) {
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
    for (const [, guidance] of GUIDANCE) {
      expect(guidance).toContain("xhs_ops_profile_material_confirmed");
      expect(guidance).toContain("Do not proceed");
      expect(guidance).not.toContain(
        "XhsOpsProfileMaterial** (optional, after personas are saved)",
      );
    }
  });
});

// Takeover design (docs/plans/2026-10-14-xhs-account-takeover-design.md) §9
// "TOOLS existing 段落的替换要点" and §1.2 T1–T8: the agent explains and asks,
// the XhsOpsTakeover card does every write, and both sources say the same.
describe("XHS takeover (老号接管) routing guidance", () => {
  it("routes takeover rows to XhsOpsTakeover instead of the new-account material step", () => {
    expect(toolsTemplate).toContain("1 → 2 → 3 → XhsOpsTakeover → 4");
    expect(RENDER_A2UI_DESCRIPTION).toContain(
      "XhsOpsAccountPlanner → XhsOpsTakeover → XhsOpsRunPlanner",
    );
    for (const [source, guidance] of GUIDANCE) {
      expect(guidance, source).toContain(
        "Takeover rows always go to XhsOpsTakeover",
      );
      expect(guidance, source).toContain(
        "Render one XhsOpsTakeover per takeover account",
      );
      expect(guidance, source).toContain("no XhsOpsProfileMaterial");
    }
    expect(toolsTemplate).toContain(
      "3b. **XhsOpsProfileMaterial** (new accounts only",
    );
  });

  it("splits a mixed new + takeover selection between the two flows", () => {
    // Before the split, a mixed selection sent takeover rows through
    // confirmPersonas, where two empty-persona rows were judged duplicates
    // (design §5.3 #10).
    for (const [source, guidance] of GUIDANCE) {
      const mixed = guidance.slice(
        guidance.indexOf(
          "A selection that mixes new and takeover rows is split by the card",
        ),
      );
      expect(mixed.length, source).toBeLessThan(guidance.length);
      const takeoverEvent = mixed.indexOf("xhs_ops_existing_accounts_selected");
      const newRowsEvent = mixed.indexOf("xhs_ops_personas_confirmed");
      expect(takeoverEvent, source).toBeGreaterThan(0);
      expect(newRowsEvent, source).toBeGreaterThan(takeoverEvent);
      expect(mixed, source).toMatch(
        /the new rows go on to persona confirmation \(`?xhs_ops_personas_confirmed`?\) and XhsOpsProfileMaterial/,
      );
    }
  });

  it("re-renders the card with feedbackDraft and lets the user submit it", () => {
    for (const [source, guidance] of GUIDANCE) {
      expect(guidance, source).toMatch(
        /re-render the same surfaceId with `?feedbackDraft`?/,
      );
      expect(guidance, source).toContain(
        "nothing is submitted until the user clicks 「按意见生成诊断」",
      );
      for (const event of [
        "xhs_ops_takeover_identity_locked",
        "xhs_ops_account_audited",
        "xhs_ops_account_diagnosed",
        "xhs_ops_takeover_plan_confirmed",
        "xhs_ops_change_order_finished",
      ]) {
        expect(guidance, `${source}: ${event}`).toContain(event);
      }
    }
  });

  it("never lets the agent confirm a change order or claim a profile change", () => {
    for (const [source, guidance] of GUIDANCE) {
      expect(guidance, source).toContain(
        "Never write a field, dispatch a phone task, log in, log out or switch accounts",
      );
      expect(guidance, source).toContain(
        "precheck or confirm a change order for the user",
      );
      expect(guidance, source).toContain(
        "never promise when a change takes effect",
      );
      expect(guidance, source).toContain(
        "never claim a profile field was changed",
      );
      // §7: the editors' publish path skips the takeover identity gate.
      expect(guidance, source).toContain(
        "publish button of XHSEditor or XHSBatchTable",
      );
      expect(guidance, source).toContain(
        "carried out by the user on the phone",
      );
    }
  });

  it("unlocks nurturing on identity, baseline and plan, without a profile rewrite", () => {
    for (const [source, guidance] of GUIDANCE) {
      expect(guidance, source).toContain(
        "unlocks once the identity is locked, the baseline is confirmed and the plan is confirmed",
      );
      expect(guidance, source).toContain(
        "「全部保留，只做维护」 is a valid plan",
      );
      expect(guidance, source).toContain("「确认优化方案」");
      expect(guidance, source).toContain("is for people to follow");
      expect(guidance, source).toContain("the tone of comment candidates");
    }
  });

  it("drops the wording that contradicted the takeover flow (design §5.4 N5)", () => {
    for (const [source, guidance] of GUIDANCE) {
      // The old existing branch unlocked nurturing on the new-account
      // eight-field readback and forbade the 方案 wording the cards use.
      expect(guidance, source).not.toContain("verified readback");
      expect(guidance, source).not.toContain("养号方案 language");
      expect(guidance, source).not.toContain("已有账号优化");
    }
    expect(toolsTemplate).not.toContain("3b → 4");
    expect(toolsTemplate).not.toContain(
      "immediately after `xhs_ops_existing_accounts_selected`",
    );
    expect(RENDER_A2UI_DESCRIPTION).not.toContain(
      "XhsOpsAccountPlanner → XhsOpsProfileMaterial",
    );
  });
});

type JsonSchema = {
  type?: string;
  const?: string;
  description?: string;
  required?: string[];
  properties?: Record<string, JsonSchema>;
  items?: { oneOf?: JsonSchema[] };
};

type RegisteredTool = { name: string; parameters: JsonSchema };

describe("XhsOpsTakeover component schema", () => {
  function componentSchema(type: string): JsonSchema | undefined {
    const tools: RegisteredTool[] = [];
    a2uiPlugin.register({
      registerTool: (tool: RegisteredTool) => {
        tools.push(tool);
      },
    });
    const render = tools.find((tool) => tool.name === "render_a2ui");
    return render?.parameters.properties?.components?.items?.oneOf?.find(
      (schema) => schema.properties?.type?.const === type,
    );
  }

  it("declares the props the takeover card reads", () => {
    const takeover = componentSchema("XhsOpsTakeover");
    expect(takeover?.required).toEqual(["id", "type"]);
    expect(Object.keys(takeover?.properties ?? {})).toEqual([
      "id",
      "type",
      "projectId",
      "projectName",
      "accountId",
      "feedbackDraft",
    ]);
    for (const prop of [
      "projectId",
      "projectName",
      "accountId",
      "feedbackDraft",
    ])
      expect(takeover?.properties?.[prop]?.type, prop).toBe("string");
    expect(takeover?.properties?.accountId?.description).toContain(
      "xhs_ops_existing_accounts_selected",
    );
    // feedbackDraft prefills only; the user still submits (design T4).
    expect(takeover?.properties?.feedbackDraft?.description).toContain(
      "PREFILLS",
    );
    expect(takeover?.properties?.feedbackDraft?.description).toContain(
      "「按意见生成诊断」",
    );
  });

  it("lists the card among the custom components and catalog users", () => {
    expect(RENDER_A2UI_DESCRIPTION).toContain("- XhsOpsTakeover:");
    expect(RENDER_A2UI_DESCRIPTION).toMatch(
      /Use catalogId: "https:\/\/nexu\.app\/a2ui\/custom-catalog\.json" when using [^\n]*XhsOpsTakeover/,
    );
  });
});
