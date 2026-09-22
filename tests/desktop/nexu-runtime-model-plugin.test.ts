import { readFile, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const testDir = path.dirname(fileURLToPath(import.meta.url));
const pluginModulePath = path.resolve(
  testDir,
  "../../apps/controller/static/runtime-plugins/nexu-runtime-model/index.js",
);
const stateModulePath = path.resolve(
  testDir,
  "../../apps/controller/static/nexu-runtime-model.json",
);

const configModulePath = path.resolve(
  testDir,
  "../../apps/controller/static/openclaw.json",
);

async function writeState(selectedModelRef: string, promptNotice?: string) {
  await writeFile(
    stateModulePath,
    `${JSON.stringify(
      {
        selectedModelRef,
        promptNotice:
          promptNotice ??
          `Authoritative runtime model for this turn: ${selectedModelRef}.`,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("nexu-runtime-model plugin", () => {
  let beforeState: string | null = null;
  let beforeConfig: string | null = null;

  beforeEach(async () => {
    beforeConfig = await readFile(configModulePath, "utf8").catch(() => null);
    try {
      beforeState = await readFile(stateModulePath, "utf8");
    } catch {
      beforeState = null;
    }
  });

  afterEach(async () => {
    if (beforeConfig === null) {
      await unlink(configModulePath).catch(() => undefined);
    } else {
      await writeFile(configModulePath, beforeConfig, "utf8");
    }
    if (beforeState === null) {
      await unlink(stateModulePath).catch(() => undefined);
      return;
    }
    await writeFile(stateModulePath, beforeState, "utf8");
  });

  it("preserves provider overrides for Link and proxied BYOK providers", async () => {
    const { default: plugin } = await import(
      `${pluginModulePath}?t=${Date.now()}`
    );

    await writeState("link/claude-sonnet-4");
    let linkHandler:
      | (() => Promise<Record<string, string> | undefined>)
      | undefined;
    plugin.register({
      on(event, handler) {
        if (event === "before_model_resolve") {
          linkHandler = handler;
        }
      },
    });
    expect(await linkHandler?.()).toEqual({
      providerOverride: "link",
      modelOverride: "claude-sonnet-4",
    });

    await writeState("byok_openai/openai/gpt-4.1");
    let byokHandler:
      | (() => Promise<Record<string, string> | undefined>)
      | undefined;
    plugin.register({
      on(event, handler) {
        if (event === "before_model_resolve") {
          byokHandler = handler;
        }
      },
    });
    expect(await byokHandler?.()).toEqual({
      providerOverride: "byok_openai",
      modelOverride: "openai/gpt-4.1",
    });
  });

  it("preserves per-agent model pins in keyed 2026.9.4 entries", async () => {
    const { default: plugin } = await import(
      `${pluginModulePath}?t=${Date.now()}`
    );
    await writeState("global-model");
    await writeFile(
      configModulePath,
      JSON.stringify({
        agents: {
          entries: {
            pinned: { model: { primary: "provider/pinned-model" } },
            stringPinned: { model: "provider/string-model" },
            followsDefault: {},
          },
        },
      }),
    );
    type Handler = (
      event: Record<string, unknown>,
      ctx: { agentId: string },
    ) => Promise<Record<string, string> | undefined>;
    const handlers = new Map<string, Handler>();
    plugin.register({
      on(event: string, handler: Handler) {
        handlers.set(event, handler);
      },
    });

    for (const agentId of ["pinned", "stringPinned"]) {
      await expect(
        handlers.get("before_model_resolve")?.({}, { agentId }),
      ).resolves.toBeUndefined();
      await expect(
        handlers.get("before_prompt_build")?.({}, { agentId }),
      ).resolves.toBeUndefined();
    }
    await expect(
      handlers.get("before_model_resolve")?.({}, { agentId: "followsDefault" }),
    ).resolves.toEqual({ modelOverride: "global-model" });
    await expect(
      handlers.get("before_prompt_build")?.({}, { agentId: "followsDefault" }),
    ).resolves.toMatchObject({
      prependSystemContext: expect.stringContaining("global-model"),
    });
  });

  it("ignores empty runtime-model state", async () => {
    const { default: plugin } = await import(
      `${pluginModulePath}?t=${Date.now()}`
    );

    await writeState("", "");
    let beforeModelResolveHandler:
      | (() => Promise<Record<string, string> | undefined>)
      | undefined;
    let beforePromptBuildHandler:
      | (() => Promise<Record<string, string> | undefined>)
      | undefined;
    plugin.register({
      on(event, handler) {
        if (event === "before_model_resolve") {
          beforeModelResolveHandler = handler;
        }
        if (event === "before_prompt_build") {
          beforePromptBuildHandler = handler;
        }
      },
    });

    await expect(beforeModelResolveHandler?.()).resolves.toBeUndefined();
    await expect(beforePromptBuildHandler?.()).resolves.toBeUndefined();
  });
});
