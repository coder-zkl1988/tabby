import {
  mkdir,
  mkdtemp,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";

type HookHandler = (
  event: Record<string, unknown>,
  context: Record<string, unknown>,
) => Promise<unknown> | unknown;

type RuntimePlugin = {
  register: (api: {
    pluginConfig: Record<string, unknown>;
    logger: { info: ReturnType<typeof vi.fn>; warn: ReturnType<typeof vi.fn> };
    on: (name: string, handler: HookHandler) => void;
  }) => void;
};

async function loadHooks(
  pluginConfig: Record<string, unknown> = {},
): Promise<Map<string, HookHandler>> {
  const pluginUrl = pathToFileURL(
    path.resolve(
      process.cwd(),
      "static/runtime-plugins/nexu-toolcall-guard/index.js",
    ),
  ).href;
  const imported: unknown = await import(pluginUrl);
  if (typeof imported !== "object" || imported === null) {
    throw new Error("Tool call guard module did not load");
  }
  const plugin = Reflect.get(imported, "default") as RuntimePlugin | undefined;
  if (!plugin) {
    throw new Error("Tool call guard default export is missing");
  }

  const handlers = new Map<string, HookHandler>();
  plugin.register({
    pluginConfig,
    logger: { info: vi.fn(), warn: vi.fn() },
    on: (name, handler) => handlers.set(name, handler),
  });
  return handlers;
}

async function loadBeforeToolCallHook(
  pluginConfig: Record<string, unknown> = {},
): Promise<HookHandler> {
  const beforeToolCall = (await loadHooks(pluginConfig)).get(
    "before_tool_call",
  );
  if (!beforeToolCall)
    throw new Error("before_tool_call hook was not registered");
  return beforeToolCall;
}

// The guard module is ESM-cached, so its provenance maps are shared across
// loadHooks() calls in this file. Every case below uses a unique bot id so one
// test cannot mark a session key that another test then inherits.
describe("nexu-toolcall-guard run provenance", () => {
  async function loadProvenanceHooks() {
    const hooks = await loadHooks();
    const record = hooks.get("before_model_resolve");
    const spawned = hooks.get("subagent_spawned");
    const agentEnd = hooks.get("agent_end");
    const beforeToolCall = hooks.get("before_tool_call");
    if (!record || !spawned || !agentEnd || !beforeToolCall) {
      throw new Error("provenance hooks were not registered");
    }
    return { record, spawned, agentEnd, beforeToolCall };
  }

  // The channel fields OpenClaw hands the agent lifecycle hooks. An earlier
  // version of these tests invented a desktop context with no channelId at
  // all; the real derivation returns `channelId: "webchat"`
  // (INTERNAL_MESSAGE_CHANNEL) for every chat.send turn, which classified the
  // desktop user as a remote channel and permanently revoked their host
  // execution. A hand-made fixture cannot see that class of bug — so these are
  // the shapes the runtime actually produces, and `assertDerivationMatches`
  // below re-derives them from the runtime itself wherever it is installed.
  const DESKTOP_CHANNEL_FIELDS = {
    channel: "webchat",
    messageProvider: "webchat",
    channelId: "webchat",
    chatId: "webchat",
  };
  const SLACK_CHANNEL_FIELDS = {
    channel: "slack",
    messageProvider: "slack",
    channelId: "C123",
    chatId: "C123",
  };

  /**
   * Re-derive the fixtures from the prepared OpenClaw runtime when it is on
   * disk, so a runtime upgrade that changes the derivation fails here instead
   * of silently invalidating the premise. CI installs with
   * NEXU_SKIP_RUNTIME_POSTINSTALL=1 and has no prepared runtime, so this is a
   * drift check where it can run rather than a dependency everywhere.
   */
  async function assertDerivationMatches(
    params: Record<string, unknown>,
    expected: Record<string, string>,
  ): Promise<void> {
    const distDir = path.resolve(
      process.cwd(),
      "../../packages/slimclaw/.dist-runtime/openclaw/node_modules/openclaw/dist",
    );
    let moduleName: string | undefined;
    try {
      // Bundle filenames are content-hashed, so match the stem, never the hash.
      moduleName = (await readdir(distDir)).find(
        (entry) =>
          entry.startsWith("hook-agent-context-") && entry.endsWith(".js"),
      );
    } catch {
      return; // no prepared runtime here
    }
    if (!moduleName) return;

    const mod = (await import(
      pathToFileURL(path.join(distDir, moduleName)).href
    )) as Record<string, unknown>;
    const build = mod.t as
      | ((input: unknown) => Record<string, unknown>)
      | undefined;
    if (typeof build !== "function") return;

    expect(build(params)).toMatchObject(expected);
  }

  it("leaves the desktop user alone when the runtime labels their turn webchat", async () => {
    const { record, beforeToolCall } = await loadProvenanceHooks();
    const bot = "bot-webchat-desktop";
    const sessionKey = `agent:${bot}:main`;

    const channelFields = DESKTOP_CHANNEL_FIELDS;
    await assertDerivationMatches(
      { messageProvider: "webchat", sessionKey },
      channelFields,
    );

    for (const runId of ["run-webchat-1", "run-webchat-2"]) {
      await record(
        {},
        { ...channelFields, runId, sessionKey, agentId: bot, trigger: "user" },
      );
      await expect(
        beforeToolCall({ toolName: "exec", params: {} }, { runId, sessionKey }),
      ).resolves.toBeUndefined();
    }

    // And the second turn must not inherit anything the first one recorded.
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-webchat-3", sessionKey },
      ),
    ).resolves.toBeUndefined();
  });

  it("still restricts a real channel conversation id", async () => {
    const { record, beforeToolCall } = await loadProvenanceHooks();
    const bot = "bot-real-channel";
    const sessionKey = `agent:${bot}:slack:channel:C123`;

    const channelFields = SLACK_CHANNEL_FIELDS;
    await assertDerivationMatches(
      { messageProvider: "slack", currentChannelId: "C123", sessionKey },
      channelFields,
    );

    await record(
      {},
      {
        ...channelFields,
        runId: "run-slack-1",
        sessionKey,
        agentId: bot,
        trigger: "user",
      },
    );
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-slack-1", sessionKey },
      ),
    ).resolves.toMatchObject({ block: true });
  });

  it("forgets a run's provenance when it ends", async () => {
    const { record, agentEnd, beforeToolCall } = await loadProvenanceHooks();
    const bot = "bot-run-cleanup";
    const sessionKey = `agent:${bot}:main`;

    await record(
      {},
      { runId: "run-gone", sessionKey, agentId: bot, trigger: "heartbeat" },
    );
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-gone", sessionKey },
      ),
    ).resolves.toMatchObject({ block: true });

    await agentEnd({}, { runId: "run-gone", sessionKey });

    // Same runId, now unobserved: the entry is gone, not merely shadowed.
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-gone", sessionKey },
      ),
    ).resolves.toBeUndefined();
  });

  it("propagates a heartbeat restriction to a sub-session it spawns", async () => {
    const { record, spawned, beforeToolCall } = await loadProvenanceHooks();
    const bot = "bot-heartbeat-subagent";
    const requesterSessionKey = `agent:${bot}:main`;
    const childSessionKey = `agent:${bot}:subagent:hb-child`;

    await record(
      {},
      {
        runId: "run-hb-parent",
        sessionKey: requesterSessionKey,
        agentId: bot,
        trigger: "heartbeat",
      },
    );
    await spawned(
      { childSessionKey, agentId: bot, mode: "run", threadRequested: false },
      { runId: "run-hb-child", childSessionKey, requesterSessionKey },
    );

    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-hb-child", sessionKey: childSessionKey },
      ),
    ).resolves.toMatchObject({ block: true });
  });

  it("does not let a spawned child borrow another bot's opt-out", async () => {
    const hooks = await loadHooks({
      hostExecution: {
        "bot-generous": { channels: "host", automations: "host" },
      },
    });
    const record = hooks.get("before_model_resolve");
    const spawned = hooks.get("subagent_spawned");
    const beforeToolCall = hooks.get("before_tool_call");
    if (!record || !spawned || !beforeToolCall)
      throw new Error("hooks missing");

    const requesterSessionKey = "agent:bot-stingy:slack:channel:C7";
    const childSessionKey = "agent:bot-generous:subagent:borrowed";

    await record(
      {},
      {
        runId: "run-stingy",
        sessionKey: requesterSessionKey,
        agentId: "bot-stingy",
        trigger: "user",
        channelId: "C7",
      },
    );
    // sessions_spawn lets the restricted run pick the child's agentId.
    await spawned(
      {
        childSessionKey,
        agentId: "bot-generous",
        mode: "run",
        threadRequested: false,
      },
      { runId: "run-borrowed", childSessionKey, requesterSessionKey },
    );

    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        {
          runId: "run-borrowed",
          sessionKey: childSessionKey,
          agentId: "bot-generous",
        },
      ),
    ).resolves.toMatchObject({ block: true });
  });

  it.each(["heartbeat", "cron", "memory"])(
    "restricts host execution for an unattended %s run on the desktop main key",
    async (trigger) => {
      const { record, beforeToolCall } = await loadProvenanceHooks();
      const bot = `bot-unattended-${trigger}`;
      const sessionKey = `agent:${bot}:main`;
      const runId = `run-${trigger}`;

      // The tool context alone cannot see this: no channelId, and the key is
      // the desktop main key the user types into.
      await record({}, { runId, sessionKey, agentId: bot, trigger });

      await expect(
        beforeToolCall({ toolName: "exec", params: {} }, { runId, sessionKey }),
      ).resolves.toMatchObject({ block: true });
    },
  );

  it.each(["user", "budget", "overflow", "timeout_recovery"])(
    "leaves a %s-triggered desktop run alone",
    async (trigger) => {
      const { record, beforeToolCall } = await loadProvenanceHooks();
      const bot = `bot-attended-${trigger}`;
      const sessionKey = `agent:${bot}:main`;
      const runId = `run-${trigger}`;

      await record({}, { runId, sessionKey, agentId: bot, trigger });

      await expect(
        beforeToolCall({ toolName: "exec", params: {} }, { runId, sessionKey }),
      ).resolves.toBeUndefined();
    },
  );

  // The trap this design has to avoid: heartbeat runs on the SAME key the
  // desktop user types into. Remembering "restricted" per session key would
  // revoke the user's own host execution from their next turn on.
  it("does not let a heartbeat run poison the user's own session", async () => {
    const { record, agentEnd, beforeToolCall } = await loadProvenanceHooks();
    const bot = "bot-heartbeat-poison";
    const sessionKey = `agent:${bot}:main`;

    await record(
      {},
      {
        runId: "run-hb",
        sessionKey,
        agentId: bot,
        trigger: "heartbeat",
      },
    );
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-hb", sessionKey },
      ),
    ).resolves.toMatchObject({ block: true });
    await agentEnd({}, { runId: "run-hb", sessionKey });

    await record(
      {},
      { runId: "run-user", sessionKey, agentId: bot, trigger: "user" },
    );
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-user", sessionKey },
      ),
    ).resolves.toBeUndefined();
  });

  it("restricts a sub-session spawned by a channel run", async () => {
    const { record, spawned, beforeToolCall } = await loadProvenanceHooks();
    const bot = "bot-subagent-inherit";
    const requesterSessionKey = `agent:${bot}:slack:channel:C999`;
    const childSessionKey = `agent:${bot}:subagent:imagegen-xyz`;

    await record(
      {},
      {
        runId: "run-channel",
        sessionKey: requesterSessionKey,
        agentId: bot,
        trigger: "user",
        channelId: "C999",
      },
    );
    await spawned(
      { childSessionKey, agentId: bot, mode: "run", threadRequested: false },
      { runId: "run-child", childSessionKey, requesterSessionKey },
    );

    // The child carries no channelId of its own and its key is not automation
    // shaped, so without inheritance it would run at the host tier.
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-child", sessionKey: childSessionKey },
      ),
    ).resolves.toMatchObject({ block: true });
  });

  it("leaves a sub-session spawned by a desktop run alone", async () => {
    const { record, spawned, beforeToolCall } = await loadProvenanceHooks();
    const bot = "bot-subagent-desktop";
    const requesterSessionKey = `agent:${bot}:main`;
    const childSessionKey = `agent:${bot}:subagent:imagegen-abc`;

    await record(
      {},
      {
        runId: "run-desktop",
        sessionKey: requesterSessionKey,
        agentId: bot,
        trigger: "user",
      },
    );
    await spawned(
      { childSessionKey, agentId: bot, mode: "run", threadRequested: false },
      { runId: "run-child-2", childSessionKey, requesterSessionKey },
    );

    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-child-2", sessionKey: childSessionKey },
      ),
    ).resolves.toBeUndefined();
  });

  it("honors the per-bot channel opt-out, and only for the reason it covers", async () => {
    const bot = "bot-optout-channels";
    const beforeToolCall = await loadBeforeToolCallHook({
      hostExecution: { [bot]: { channels: "host", automations: "restricted" } },
    });

    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        {
          sessionKey: `agent:${bot}:slack:channel:C1`,
          channelId: "C1",
          agentId: bot,
        },
      ),
    ).resolves.toBeUndefined();

    // The automations switch is still closed, so a schedule run stays blocked.
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { sessionKey: `agent:${bot}:schedule-9`, agentId: bot },
      ),
    ).resolves.toMatchObject({ block: true });
  });

  it("does not let one bot's opt-out open another bot", async () => {
    const beforeToolCall = await loadBeforeToolCallHook({
      hostExecution: {
        "bot-opted-in": { channels: "host", automations: "host" },
      },
    });

    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        {
          sessionKey: "agent:bot-other:slack:channel:C1",
          channelId: "C1",
          agentId: "bot-other",
        },
      ),
    ).resolves.toMatchObject({ block: true });
  });

  it("registers every provenance hook it claims to", async () => {
    const hooks = await loadHooks();
    // session_start is deliberately absent: its context has no runId, so
    // routing it through recordRunOrigin would be dead code.
    for (const name of [
      "before_model_resolve",
      "before_prompt_build",
      "before_agent_start",
      "subagent_spawned",
      "agent_end",
    ]) {
      expect(hooks.has(name), `${name} is not registered`).toBe(true);
    }
    expect(hooks.has("session_start")).toBe(false);
  });

  it("keeps an inherited restriction alive past the eviction bound", async () => {
    const { record, spawned, beforeToolCall } = await loadProvenanceHooks();
    const bot = "bot-eviction";
    const requesterSessionKey = `agent:${bot}:slack:channel:CEVICT`;
    const childSessionKey = `agent:${bot}:subagent:evict-child`;

    await record(
      {},
      {
        runId: "run-evict-parent",
        sessionKey: requesterSessionKey,
        agentId: bot,
        trigger: "user",
        channelId: "CEVICT",
      },
    );
    await spawned(
      { childSessionKey, agentId: bot, mode: "run", threadRequested: false },
      { runId: "run-evict-child", childSessionKey, requesterSessionKey },
    );

    // Flood with unrelated channel sessions. FIFO eviction of a still-live
    // restriction would silently un-restrict the child.
    for (let index = 0; index < 600; index += 1) {
      await record(
        {},
        {
          runId: `run-flood-${index}`,
          sessionKey: `agent:${bot}:slack:channel:FLOOD${index}`,
          agentId: bot,
          trigger: "user",
          channelId: `FLOOD${index}`,
        },
      );
      // Touch the child so a live entry moves to the back of the queue.
      await beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-evict-child", sessionKey: childSessionKey },
      );
    }

    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-evict-child", sessionKey: childSessionKey },
      ),
    ).resolves.toMatchObject({ block: true });
  });

  it("falls back to context signals for a run it never observed", async () => {
    const { beforeToolCall } = await loadProvenanceHooks();

    // Guard loaded mid-run, or OpenClaw restarted: provenance is empty. The
    // desktop must keep working, and the context-level signals must still fire.
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        { runId: "run-never-seen", sessionKey: "agent:bot-unseen:main" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      beforeToolCall(
        { toolName: "exec", params: {} },
        {
          runId: "run-never-seen-2",
          sessionKey: "agent:bot-unseen:slack:channel:C1",
          channelId: "C1",
        },
      ),
    ).resolves.toMatchObject({ block: true });
  });
});

describe("nexu-toolcall-guard local automation policy", () => {
  it("allows browser control from desktop main and local UUID sessions", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    await expect(
      beforeToolCall(
        { toolName: "browser", params: {} },
        { sessionKey: "agent:bot-1:main", runId: "run-1" },
      ),
    ).resolves.toBeUndefined();
    await expect(
      beforeToolCall(
        { toolName: "cua-driver__click", params: {} },
        {
          sessionKey: "agent:bot-1:123e4567-e89b-12d3-a456-426614174000",
          runId: "run-2",
        },
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks browser and platform MCP tools from external channels", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    const browserResult = await beforeToolCall(
      { toolName: "browser", params: {} },
      {
        sessionKey: "agent:bot-1:slack:channel:C123",
        channelId: "C123",
      },
    );
    const cuaResult = await beforeToolCall(
      { toolName: "cua-driver__click", params: {} },
      {},
    );

    expect(browserResult).toMatchObject({ block: true });
    expect(cuaResult).toMatchObject({ block: true });
  });

  it("does not affect unrelated tools", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    await expect(
      beforeToolCall(
        { toolName: "message", params: {} },
        { channelId: "C123" },
      ),
    ).resolves.toBeUndefined();
  });

  it("blocks backend tools outside the reviewed local automation surface", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    // The whole peekaboo surface fails closed now that cua-driver is the only
    // compiled backend; cua-driver itself is limited to the reviewed filter.
    for (const toolName of [
      "peekaboo__agent",
      "peekaboo__browser",
      "peekaboo__paste",
      "peekaboo__click",
      "peekaboo__list",
      "cua-driver__run_shell",
      "cua-driver__page",
    ]) {
      await expect(
        beforeToolCall(
          { toolName, params: {} },
          { sessionKey: "agent:bot-1:main" },
        ),
      ).resolves.toMatchObject({ block: true });
    }

    await expect(
      beforeToolCall(
        {
          toolName: "cua-driver__list_apps",
          params: {},
        },
        { sessionKey: "agent:bot-1:main" },
      ),
    ).resolves.toBeUndefined();
  });

  // Reverses the PR #17 posture on purpose: host execution stays prompt-free
  // for the desktop user, but a channel-originated run is no longer allowed to
  // reach it. Kept as an explicit inverted assertion rather than a deletion so
  // the intent flip is visible in the history.
  it("blocks host execution for channel-originated runs", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    for (const toolName of ["exec", "process", "code_execution"]) {
      await expect(
        beforeToolCall(
          { toolName, params: { action: "status" } },
          {
            sessionKey: "agent:bot-1:slack:channel:C123",
            channelId: "C123",
          },
        ),
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("blocks host execution for automation-originated runs", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    // openclaw-cron-gateway.ts:471 is the only automation key the controller
    // mints; `cron:` covers OpenClaw-side cron keys defensively.
    for (const sessionKey of [
      "agent:bot-1:schedule-1234",
      "agent:bot-1:cron:daily-report",
    ]) {
      await expect(
        beforeToolCall({ toolName: "exec", params: {} }, { sessionKey }),
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("leaves host execution untouched for desktop and derived sessions", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    // Desktop main, a desktop UUID session, and the sub-session shapes that
    // team/workflow/media lanes run under. Sub-session lineage is not present
    // in the tool context, and most bundled skills are shell-driven, so
    // restricting them on key shape alone would break the user's own work.
    for (const sessionKey of [
      "agent:bot-1:main",
      "agent:bot-1:0f8fad5b-d9cb-469f-a165-70867728950e",
      // Shapes minted by media-generation-service and run-message-intent-service.
      "agent:bot-1:subagent:imagegen-abc123",
      "agent:bot-1:subagent:imgenhance-abc123",
      "agent:bot-1:subagent:run-intent-abc123",
    ]) {
      for (const toolName of ["exec", "process", "code_execution"]) {
        await expect(
          beforeToolCall({ toolName, params: {} }, { sessionKey }),
        ).resolves.toBeUndefined();
      }
    }
  });

  it("isolates runtime control-plane tools", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    for (const toolName of ["gateway", "nodes", "cron"]) {
      await expect(
        beforeToolCall(
          { toolName, params: { action: "status" } },
          {
            sessionKey: "agent:bot-1:slack:channel:C123",
            channelId: "C123",
          },
        ),
      ).resolves.toMatchObject({ block: true });

      await expect(
        beforeToolCall(
          { toolName, params: { action: "status" } },
          { sessionKey: "agent:bot-1:main" },
        ),
      ).resolves.toBeUndefined();
    }
  });
});

describe("nexu-toolcall-guard write fence", () => {
  const BOT_ID = "bot-1";

  /**
   * `layout: "nested"` reproduces `pnpm start` and the controller's own default,
   * where OPENCLAW_STATE_DIR lives INSIDE NEXU_HOME. The agent workspace is
   * `<stateDir>/agents/<agentId>`, so a fence that takes nexuHome as a whole
   * tree swallows the workspace and blocks every desktop write. The sibling
   * layout alone cannot see that.
   */
  async function withFence(layout: "sibling" | "nested" = "sibling"): Promise<{
    beforeToolCall: HookHandler;
    stateDir: string;
    nexuHome: string;
    workspace: string;
    userSkillsDir: string;
    cleanup: () => Promise<void>;
  }> {
    const root = await mkdtemp(path.join(tmpdir(), "nexu-guard-fence-"));
    const nexuHome = path.join(root, "nexu-home");
    const stateDir =
      layout === "nested"
        ? path.join(nexuHome, "runtime", "openclaw", "state")
        : path.join(root, "state");
    const workspace = path.join(stateDir, "agents", BOT_ID);
    const userSkillsDir = path.join(root, "user-skills");

    await mkdir(path.join(stateDir, "extensions", "nexu-toolcall-guard"), {
      recursive: true,
    });
    await mkdir(path.join(stateDir, "skills"), { recursive: true });
    await mkdir(workspace, { recursive: true });
    await mkdir(nexuHome, { recursive: true });
    await mkdir(userSkillsDir, { recursive: true });
    await writeFile(path.join(stateDir, "openclaw.json"), "{}");

    const beforeToolCall = await loadBeforeToolCallHook({
      fence: { stateDir, nexuHome, userSkillsDir },
    });
    return {
      beforeToolCall,
      stateDir,
      nexuHome,
      workspace,
      userSkillsDir,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  const desktopCtx = { sessionKey: `agent:${BOT_ID}:main`, agentId: BOT_ID };

  it.each(["sibling", "nested"] as const)(
    "never fences the agent's own workspace (%s state dir layout)",
    async (layout) => {
      const { beforeToolCall, workspace, cleanup } = await withFence(layout);
      try {
        for (const target of [
          path.join(workspace, "index.html"),
          path.join(workspace, "AGENTS.md"),
          path.join(workspace, "src", "app.ts"),
        ]) {
          await expect(
            beforeToolCall(
              { toolName: "write", params: { path: target, content: "x" } },
              desktopCtx,
            ),
            `${layout}: ${target} must stay writable`,
          ).resolves.toBeUndefined();
        }

        await expect(
          beforeToolCall(
            {
              toolName: "apply_patch",
              params: { patch: "*** Begin Patch" },
              derivedPaths: [path.join(workspace, "src", "app.ts")],
            },
            desktopCtx,
          ),
        ).resolves.toBeUndefined();
      } finally {
        await cleanup();
      }
    },
  );

  it("still fences runtime-critical paths under the nested layout", async () => {
    const { beforeToolCall, stateDir, nexuHome, cleanup } =
      await withFence("nested");
    try {
      for (const target of [
        path.join(stateDir, "extensions", "nexu-toolcall-guard", "index.js"),
        path.join(stateDir, "openclaw.json"),
        path.join(nexuHome, "config.json"),
      ]) {
        await expect(
          beforeToolCall(
            { toolName: "write", params: { path: target, content: "x" } },
            desktopCtx,
          ),
        ).resolves.toMatchObject({ block: true });
      }
    } finally {
      await cleanup();
    }
  });

  it("fences relative paths that climb out of the workspace", async () => {
    const { beforeToolCall, cleanup } = await withFence("nested");
    try {
      // `write`/`edit` accept relative paths and the host derives paths only
      // for apply_patch, so a fence that only understands absolute strings is
      // a no-op against exactly the payload an attacker would send.
      for (const relative of [
        "../../openclaw.json",
        "../../extensions/nexu-toolcall-guard/index.js",
        "../../skills/evil/SKILL.md",
      ]) {
        await expect(
          beforeToolCall(
            { toolName: "write", params: { path: relative, content: "x" } },
            desktopCtx,
          ),
          `${relative} must be fenced`,
        ).resolves.toMatchObject({ block: true });
      }

      await expect(
        beforeToolCall(
          { toolName: "write", params: { path: "notes.md", content: "x" } },
          desktopCtx,
        ),
      ).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("fences the user skills directory", async () => {
    const { beforeToolCall, userSkillsDir, cleanup } = await withFence();
    try {
      await expect(
        beforeToolCall(
          {
            toolName: "write",
            params: {
              path: path.join(userSkillsDir, "evil", "SKILL.md"),
              content: "x",
            },
          },
          desktopCtx,
        ),
      ).resolves.toMatchObject({ block: true });
    } finally {
      await cleanup();
    }
  });

  it("compares fence roots case-insensitively on macOS and Windows", async () => {
    const { beforeToolCall, stateDir, cleanup } = await withFence();
    try {
      const mixedCase = path.join(
        path.dirname(stateDir),
        path.basename(stateDir),
        "EXTENSIONS",
        "nexu-toolcall-guard",
        "index.js",
      );
      const expected =
        process.platform === "darwin" || process.platform === "win32"
          ? { block: true }
          : undefined;
      const result = await beforeToolCall(
        { toolName: "write", params: { path: mixedCase, content: "x" } },
        desktopCtx,
      );
      if (expected) expect(result).toMatchObject(expected);
      else expect(result).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("blocks writes to runtime-critical paths from every tier, desktop included", async () => {
    const { beforeToolCall, stateDir, nexuHome, cleanup } = await withFence();
    try {
      const fenced = [
        path.join(stateDir, "extensions", "nexu-toolcall-guard", "index.js"),
        path.join(stateDir, "openclaw.json"),
        path.join(stateDir, "skills", "evil", "SKILL.md"),
        path.join(nexuHome, "config.json"),
      ];

      for (const target of fenced) {
        for (const toolName of ["write", "edit", "apply_patch"]) {
          await expect(
            beforeToolCall(
              { toolName, params: { path: target, content: "x" } },
              { sessionKey: "agent:bot-1:main" },
            ),
          ).resolves.toMatchObject({ block: true });
        }
      }
    } finally {
      await cleanup();
    }
  });

  it("uses host-derived paths when the params carry no path key", async () => {
    const { beforeToolCall, stateDir, cleanup } = await withFence();
    try {
      await expect(
        beforeToolCall(
          {
            toolName: "apply_patch",
            params: { patch: "*** Begin Patch" },
            derivedPaths: [path.join(stateDir, "openclaw.json")],
          },
          { sessionKey: "agent:bot-1:main" },
        ),
      ).resolves.toMatchObject({ block: true });
    } finally {
      await cleanup();
    }
  });

  it("resolves symlinked parents before deciding", async () => {
    const { beforeToolCall, stateDir, cleanup } = await withFence();
    try {
      const link = path.join(path.dirname(stateDir), "state-link");
      await symlink(stateDir, link);

      await expect(
        beforeToolCall(
          {
            toolName: "write",
            params: {
              path: path.join(link, "extensions", "x.js"),
              content: "x",
            },
          },
          { sessionKey: "agent:bot-1:main" },
        ),
      ).resolves.toMatchObject({ block: true });
    } finally {
      await cleanup();
    }
  });

  it("does not fence ordinary workspace writes", async () => {
    const { beforeToolCall, cleanup } = await withFence();
    try {
      await expect(
        beforeToolCall(
          {
            toolName: "write",
            params: {
              path: "/tmp/nexu-guard-fence-ordinary/notes.md",
              content: "hello",
            },
          },
          { sessionKey: "agent:bot-1:main" },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("blocks a restricted origin from reading credential paths, and lets the desktop read them", async () => {
    const { beforeToolCall, nexuHome, cleanup } = await withFence();
    try {
      const secret = path.join(nexuHome, "config.json");

      // Channel origin: refused. Blocking exec but not `read` would leave
      // `read` + `web_fetch` as a shell-free exfiltration path, and
      // <nexuHome>/config.json holds channel app secrets in plain text.
      await expect(
        beforeToolCall(
          { toolName: "read", params: { path: secret } },
          {
            sessionKey: `agent:${BOT_ID}:slack:channel:C1`,
            channelId: "C1",
            agentId: BOT_ID,
          },
        ),
      ).resolves.toMatchObject({ block: true });

      // Automation origin: refused.
      await expect(
        beforeToolCall(
          { toolName: "read", params: { path: secret } },
          { sessionKey: `agent:${BOT_ID}:schedule-7`, agentId: BOT_ID },
        ),
      ).resolves.toMatchObject({ block: true });

      // Desktop: the user asking their own assistant about their own config is
      // the product working.
      await expect(
        beforeToolCall(
          { toolName: "read", params: { path: secret } },
          desktopCtx,
        ),
      ).resolves.toBeUndefined();

      // And an ordinary file stays readable from a channel session.
      await expect(
        beforeToolCall(
          { toolName: "read", params: { path: "/tmp/ordinary-notes.md" } },
          {
            sessionKey: `agent:${BOT_ID}:slack:channel:C1`,
            channelId: "C1",
            agentId: BOT_ID,
          },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("does not fence a write whose content merely mentions a fenced path", async () => {
    const { beforeToolCall, stateDir, cleanup } = await withFence();
    try {
      await expect(
        beforeToolCall(
          {
            toolName: "write",
            params: {
              path: "/tmp/nexu-guard-fence-ordinary/notes.md",
              content: `see ${path.join(stateDir, "openclaw.json")}`,
            },
          },
          { sessionKey: "agent:bot-1:main" },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});

describe("nexu-toolcall-guard computer-use completion evidence", () => {
  it("rewrites a completion claim when the same-target observation fails", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    expect(afterToolCall).toBeDefined();
    expect(beforeMessageWrite).toBeDefined();

    const context = {
      runId: "run-unverified",
      sessionKey: "agent:bot-1:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__type_text",
        params: {
          app: "PID:18609",
          element_id: "search-field",
          text: "锦鲤",
        },
        result: '[ok] Typed "锦鲤"',
      },
      context,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app_target: "PID:18609" },
        error: "Operation timed out",
      },
      context,
    );

    const result = await beforeMessageWrite?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已完成搜索。" }],
          stopReason: "stop",
        },
      },
      { sessionKey: context.sessionKey },
    );

    expect(result).toMatchObject({
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: expect.stringContaining("未确认完成"),
          },
        ],
      },
    });
  });

  it("appends a caveat instead of replacing the reply when only a click is unverified", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const context = {
      runId: "run-click-advisory",
      sessionKey: "agent:bot-advisory:main",
    };

    // Real cua-driver 0.12.6 macOS click output: explicitly unverifiable.
    await afterToolCall?.(
      {
        toolName: "cua-driver__click",
        params: { pid: 61227, x: 600, y: 400 },
        result: {
          content: [{ type: "text", text: "\u2705 Posted click to pid 61227" }],
          structuredContent: {
            effect: "unverifiable",
            path: "cgevent",
            verified: false,
          },
        },
      },
      context,
    );

    const result = await beforeMessageWrite?.(
      {
        message: {
          role: "assistant",
          content: [
            {
              type: "text",
              text: "\u5df2\u70b9\u51fb\u63d0\u4ea4\u6309\u94ae\u3002",
            },
          ],
          stopReason: "stop",
        },
      },
      { sessionKey: context.sessionKey },
    );

    const content = (
      result as { message: { content: Array<{ text: string }> } }
    ).message.content;
    // The original answer survives; the caveat is added after it.
    expect(content).toHaveLength(2);
    expect(content[0]?.text).toBe(
      "\u5df2\u70b9\u51fb\u63d0\u4ea4\u6309\u94ae\u3002",
    );
    expect(content[1]?.text).toContain(
      "\u65e0\u6cd5\u88ab\u7cfb\u7edf\u9a8c\u8bc1",
    );
    expect(content[1]?.text).not.toContain("\u672a\u786e\u8ba4\u5b8c\u6210");
  });

  it("preserves the final answer after fresh same-target state evidence", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const context = {
      runId: "run-verified",
      sessionKey: "agent:bot-1:main",
    };

    await afterToolCall?.(
      {
        toolName: "cua-driver__type_text",
        params: {
          app: "PID:18609",
          element_id: "search-field",
          text: "锦鲤",
        },
        result: '[ok] Typed "锦鲤"',
      },
      context,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app_target: "PID:18609" },
        result: {
          elements: [{ element_id: "search-field", value: "锦鲤" }],
        },
      },
      context,
    );

    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已完成搜索。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: context.sessionKey },
      ),
    ).toBeUndefined();
  });

  it("does not accept a successful observation of a different app", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const context = {
      runId: "run-wrong-target",
      sessionKey: "agent:bot-2:main",
    };

    await afterToolCall?.(
      {
        toolName: "cua-driver__type_text",
        params: { app: "com.electron.lark", text: "锦鲤" },
        result: { ok: true },
      },
      context,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_window_state",
        params: { app: "com.apple.Safari" },
        result: { snapshot: { title: "Safari" } },
      },
      context,
    );

    const result = await beforeMessageWrite?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已完成。" }],
          stopReason: "stop",
        },
      },
      { sessionKey: context.sessionKey },
    );
    expect(result).toMatchObject({ message: { role: "assistant" } });
  });

  it("does not let a different successful action hide an earlier failure", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const context = {
      runId: "run-failure-hidden",
      sessionKey: "agent:bot-3:main",
    };

    await afterToolCall?.(
      {
        toolName: "cua-driver__type_text",
        params: { app: "飞书", text: "锦鲤" },
        error: "input failed",
      },
      context,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__click",
        params: { app: "飞书", x: 100, y: 120 },
        result: { ok: true },
      },
      context,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app: "飞书" },
        result: { ok: true },
      },
      context,
    );

    const result = await beforeMessageWrite?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已完成。" }],
          stopReason: "stop",
        },
      },
      { sessionKey: context.sessionKey },
    );
    expect(result).toMatchObject({
      message: {
        content: [
          { type: "text", text: expect.stringContaining("未确认完成") },
        ],
      },
    });
  });

  it("does not accept state evidence that lacks the expected input value", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const context = {
      runId: "run-value-missing",
      sessionKey: "agent:bot-4:main",
    };

    await afterToolCall?.(
      {
        toolName: "cua-driver__type_text",
        params: {
          app: "飞书",
          element_id: "search-field",
          text: "锦鲤",
        },
        result: { ok: true },
      },
      context,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__hotkey",
        params: { app: "飞书", keys: "return" },
        result: { ok: true },
      },
      context,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app: "飞书" },
        result: {
          elements: [
            { element_id: "search-field", value: "" },
            { element_id: "other", text: "锦鲤" },
          ],
        },
      },
      context,
    );

    const result = await beforeMessageWrite?.(
      {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "已完成。" }],
          stopReason: "stop",
        },
      },
      { sessionKey: context.sessionKey },
    );
    expect(result).toMatchObject({ message: { role: "assistant" } });
  });

  it("does not accept same-target observation as proof of a click", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const context = {
      runId: "run-click-unchanged",
      sessionKey: "agent:bot-click:main",
    };

    await afterToolCall?.(
      {
        toolName: "cua-driver__click",
        params: { app: "Safari", on: "submit-button" },
        result: { ok: true },
      },
      context,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app_target: "Safari" },
        result: {
          content: [
            { type: "text", text: "UI unchanged; button still present" },
          ],
        },
      },
      context,
    );

    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已点击。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: context.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });
  });

  it("ignores static labels as value evidence for typed text", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");

    const labelContext = {
      runId: "run-label-only",
      sessionKey: "agent:bot-label:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__type_text",
        params: { app: "Safari", on: "search-field", text: "Search" },
        result: { ok: true },
      },
      labelContext,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app_target: "Safari" },
        result: {
          elements: [
            { element_id: "search-field", label: "Search", value: "" },
          ],
        },
      },
      labelContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已输入。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: labelContext.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });
  });

  it("accepts element refs and cua-driver 0.12.6 verification", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");

    const refContext = {
      runId: "run-cua-driver-refs",
      sessionKey: "agent:bot-refs:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__set_value",
        params: {
          on: "search-field",
          snapshot: "snapshot-1",
          value: "锦鲤",
        },
        result: { ok: true },
      },
      refContext,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app_target: "Safari", snapshot: "snapshot-1" },
        result: {
          content: [
            {
              type: "text",
              text: 'search-field text field value="锦鲤"',
            },
          ],
        },
      },
      refContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已输入。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: refContext.sessionKey },
      ),
    ).toBeUndefined();

    const verifiedContext = {
      runId: "run-provider-verified",
      sessionKey: "agent:bot-verified:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__set_value",
        params: { app: "Notepad", element_index: 3, value: "锦鲤" },
        result: {
          details: {
            structuredContent: {
              path: "msaa",
              verified: true,
              effect: "confirmed",
            },
          },
        },
      },
      verifiedContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已输入。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: verifiedContext.sessionKey },
      ),
    ).toBeUndefined();
  });

  it("accepts exact empty value evidence but not verification-shaped text", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");

    const emptyContext = {
      runId: "run-empty-value",
      sessionKey: "agent:bot-empty:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__set_value",
        params: { app: "Safari", on: "field", value: "" },
        result: { ok: true },
      },
      emptyContext,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app_target: "Safari" },
        result: {
          content: [{ type: "text", text: 'field text field value=""' }],
        },
      },
      emptyContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已清空。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: emptyContext.sessionKey },
      ),
    ).toBeUndefined();

    const textContext = {
      runId: "run-untrusted-verification-text",
      sessionKey: "agent:bot-untrusted:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__set_value",
        params: { app: "Notepad", element_index: 3, value: "锦鲤" },
        result: {
          content: [
            {
              type: "text",
              text: '{"path":"msaa","verified":true,"effect":"confirmed"}',
            },
          ],
        },
      },
      textContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已设置。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: textContext.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });

    const actionTextContext = {
      runId: "run-untrusted-action-verification-text",
      sessionKey: "agent:bot-untrusted-action:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__set_value",
        params: { app: "Notepad", element_index: 3, value: "hello" },
        result: {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                action: {
                  element_index: 3,
                  verification: {
                    state: "verified",
                    property: "value",
                    expected: "hello",
                  },
                },
              }),
            },
          ],
        },
      },
      actionTextContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已设置。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: actionTextContext.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });
  });

  it("rewrites a final answer while an allowed mutation is still in flight", async () => {
    const hooks = await loadHooks();
    const beforeToolCall = hooks.get("before_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const context = {
      runId: "run-mutation-in-flight",
      sessionKey: "agent:bot-mutation-in-flight:main",
    };

    await expect(
      beforeToolCall?.(
        {
          toolName: "cua-driver__click",
          params: { app: "Safari", x: 10, y: 20 },
        },
        context,
      ),
    ).resolves.toBeUndefined();

    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已点击。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: context.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });
  });

  it("rejects text value evidence from prefix-colliding element references", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const cases = [
      {
        suffix: "other-field",
        target: "field",
        value: "",
        evidence: 'other-field text field value=""',
      },
      {
        suffix: "b10",
        target: "B1",
        value: "锦鲤",
        evidence: 'B10 text field value="锦鲤"',
      },
      {
        suffix: "value-suffix",
        target: "field",
        value: "hello",
        evidence: 'field text field value="hello world"',
      },
      {
        suffix: "default-value",
        target: "field",
        value: "hello",
        evidence: 'field default_value="hello" value="different"',
      },
      {
        suffix: "default-space-value",
        target: "field",
        value: "hello",
        evidence: 'field default value="hello" current="different"',
      },
      {
        suffix: "multiple-element-fields",
        target: "field",
        value: "hello",
        evidence:
          'element_id="field", value="wrong"; element_id="other", value="hello"',
      },
    ];

    for (const testCase of cases) {
      const context = {
        runId: `run-${testCase.suffix}`,
        sessionKey: `agent:bot-${testCase.suffix}:main`,
      };
      await afterToolCall?.(
        {
          toolName: "cua-driver__set_value",
          params: {
            app: "Safari",
            on: testCase.target,
            value: testCase.value,
          },
          result: { ok: true },
        },
        context,
      );
      await afterToolCall?.(
        {
          toolName: "cua-driver__get_accessibility_tree",
          params: { app_target: "Safari" },
          result: {
            content: [{ type: "text", text: testCase.evidence }],
          },
        },
        context,
      );

      expect(
        beforeMessageWrite?.(
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "已设置。" }],
              stopReason: "stop",
            },
          },
          { sessionKey: context.sessionKey },
        ),
      ).toMatchObject({ message: { role: "assistant" } });
    }
  });

  it("rejects weak value evidence and leaves read-only browser calls alone", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");

    const substringContext = {
      runId: "run-substring-value",
      sessionKey: "agent:bot-substring:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__set_value",
        params: { app: "Safari", on: "field", value: "锦" },
        result: { ok: true },
      },
      substringContext,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app_target: "Safari" },
        result: { elements: [{ element_id: "field", value: "旧锦鲤" }] },
      },
      substringContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已设置。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: substringContext.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });

    const mismatchContext = {
      runId: "run-mismatched-verification",
      sessionKey: "agent:bot-mismatch:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__set_value",
        params: { app: "Notepad", element_index: 3, value: "锦鲤" },
        result: {
          action: {
            verification: {
              state: "verified",
              property: "value",
              expected: "完全不同",
            },
          },
        },
      },
      mismatchContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已设置。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: mismatchContext.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });

    const missingElementContext = {
      runId: "run-missing-verification-element",
      sessionKey: "agent:bot-missing-element:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__set_value",
        params: { app: "Notepad", element_index: 3, value: "hello" },
        result: {
          action: {
            verification: {
              state: "verified",
              property: "value",
              expected: "hello",
            },
          },
        },
      },
      missingElementContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已设置。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: missingElementContext.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });

    const browserContext = {
      runId: "run-browser-tabs",
      sessionKey: "agent:bot-browser:main",
    };
    await afterToolCall?.(
      {
        toolName: "browser",
        params: { action: "tabs" },
        result: { tabs: [{ id: "tab-1", title: "Example" }] },
      },
      browserContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "找到一个标签页。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: browserContext.sessionKey },
      ),
    ).toBeUndefined();
  });

  it("ignores CUA session lifecycle calls for completion evidence", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const context = {
      runId: "run-session-lifecycle",
      sessionKey: "agent:bot-5:main",
    };

    for (const toolName of [
      "cua-driver__start_session",
      "cua-driver__escalate_session",
      "cua-driver__end_session",
    ]) {
      await afterToolCall?.(
        {
          toolName,
          params: { session_id: "session-5" },
          result: { ok: true },
        },
        context,
      );
    }

    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "会话已关闭。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: context.sessionKey },
      ),
    ).toBeUndefined();
  });

  it("keeps targetless and separate-window actions pending", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");

    const targetlessContext = {
      runId: "run-targetless",
      sessionKey: "agent:bot-6:main",
    };
    await afterToolCall?.(
      {
        toolName: "cua-driver__click",
        params: { x: 100, y: 120 },
        result: { ok: true },
      },
      targetlessContext,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_accessibility_tree",
        params: { app_target: "frontmost" },
        result: { tree: "frontmost app" },
      },
      targetlessContext,
    );
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已完成。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: targetlessContext.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });

    for (const testCase of [
      {
        suffix: "native",
        params: { element_index: 3, value: "hello" },
        result: { verified: true },
      },
      {
        suffix: "enriched",
        params: { app: "frontmost", element_index: 3, value: "hello" },
        result: {
          action: {
            element_index: 3,
            verification: {
              state: "verified",
              property: "value",
              expected: "hello",
            },
          },
        },
      },
    ]) {
      const providerContext = {
        runId: `run-targetless-provider-${testCase.suffix}`,
        sessionKey: `agent:bot-targetless-provider-${testCase.suffix}:main`,
      };
      await afterToolCall?.(
        {
          toolName: "cua-driver__set_value",
          params: testCase.params,
          result: testCase.result,
        },
        providerContext,
      );
      expect(
        beforeMessageWrite?.(
          {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "已设置。" }],
              stopReason: "stop",
            },
          },
          { sessionKey: providerContext.sessionKey },
        ),
      ).toMatchObject({ message: { role: "assistant" } });
    }

    const windowContext = {
      runId: "run-separate-windows",
      sessionKey: "agent:bot-7:main",
    };
    for (const [toolCall, params] of [
      ["click", { app: "Safari", window_id: 1, x: 100, y: 120 }],
      ["click", { app: "Safari", window_id: 2, x: 200, y: 220 }],
      ["get_accessibility_tree", { app: "Safari", window_id: 2 }],
    ] as const) {
      await afterToolCall?.(
        {
          toolName: `cua-driver__${toolCall}`,
          params,
          result: { ok: true },
        },
        windowContext,
      );
    }
    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已完成。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: windowContext.sessionKey },
      ),
    ).toMatchObject({ message: { role: "assistant" } });
  });

  it("accepts Windows launch evidence by the returned pid", async () => {
    const hooks = await loadHooks();
    const afterToolCall = hooks.get("after_tool_call");
    const beforeMessageWrite = hooks.get("before_message_write");
    const context = {
      runId: "run-launch-alias",
      sessionKey: "agent:bot-8:main",
    };

    await afterToolCall?.(
      {
        toolName: "cua-driver__launch_app",
        params: { name: "Notepad" },
        result: { pid: 123, windows: [{ window_id: 7 }] },
      },
      context,
    );
    await afterToolCall?.(
      {
        toolName: "cua-driver__get_window_state",
        params: { pid: 123 },
        result: { pid: 123, window_id: 7, title: "Untitled - Notepad" },
      },
      context,
    );

    expect(
      beforeMessageWrite?.(
        {
          message: {
            role: "assistant",
            content: [{ type: "text", text: "已打开记事本。" }],
            stopReason: "stop",
          },
        },
        { sessionKey: context.sessionKey },
      ),
    ).toBeUndefined();
  });
});

describe("nexu-toolcall-guard automation block reporting", () => {
  it("reports an automation block to the controller once per session and tool", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const beforeToolCall = await loadBeforeToolCallHook({
        controllerUrl: "http://127.0.0.1:50800/",
      });
      const ctx = {
        sessionKey: "agent:bot-report:schedule-42",
        agentId: "bot-report",
      };

      await beforeToolCall({ toolName: "exec", params: {} }, ctx);
      // A model that retries the refused call must not turn into a storm.
      await beforeToolCall({ toolName: "exec", params: {} }, ctx);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(url).toBe(
        "http://127.0.0.1:50800/api/internal/runtime/host-execution-blocked",
      );
      expect(JSON.parse(String(init.body))).toMatchObject({
        sessionKey: "agent:bot-report:schedule-42",
        toolName: "exec",
        reason: "automation-origin",
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("does not report a channel block, which has its own reply path", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const beforeToolCall = await loadBeforeToolCallHook({
        controllerUrl: "http://127.0.0.1:50800",
      });
      await beforeToolCall(
        { toolName: "exec", params: {} },
        {
          sessionKey: "agent:bot-report2:slack:channel:C1",
          channelId: "C1",
          agentId: "bot-report2",
        },
      );
      expect(fetchMock).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = previousFetch;
    }
  });

  it("still blocks when the controller cannot be reached", async () => {
    const previousFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("controller down");
    }) as unknown as typeof globalThis.fetch;
    try {
      const beforeToolCall = await loadBeforeToolCallHook({
        controllerUrl: "http://127.0.0.1:50800",
      });
      await expect(
        beforeToolCall(
          { toolName: "exec", params: {} },
          {
            sessionKey: "agent:bot-report3:schedule-9",
            agentId: "bot-report3",
          },
        ),
      ).resolves.toMatchObject({ block: true });
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("nexu-toolcall-guard block report retry", () => {
  it("retries a rejected report instead of suppressing it forever", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValue(new Response(null, { status: 200 }));
    const previousFetch = globalThis.fetch;
    globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
    try {
      const beforeToolCall = await loadBeforeToolCallHook({
        controllerUrl: "http://127.0.0.1:50800",
      });
      const ctx = {
        sessionKey: "agent:bot-retry:schedule-1",
        agentId: "bot-retry",
      };

      await beforeToolCall({ toolName: "exec", params: {} }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      await beforeToolCall({ toolName: "exec", params: {} }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));
      // Third call must be deduped now that one succeeded.
      await beforeToolCall({ toolName: "exec", params: {} }, ctx);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = previousFetch;
    }
  });
});

describe("nexu-toolcall-guard restricted-origin surface", () => {
  const channelCtx = {
    sessionKey: "agent:bot-surface:slack:channel:CS1",
    channelId: "CS1",
    agentId: "bot-surface",
  };
  const desktopCtx = {
    sessionKey: "agent:bot-surface:main",
    agentId: "bot-surface",
  };

  it("refuses a tool that is not on the reviewed list", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    // An MCP server or third-party plugin. `plugins.allow` is gone, so the
    // compiled config no longer enumerates the tool surface.
    for (const toolName of [
      "mcp__filesystem__write_file",
      "shell_exec",
      "some-plugin__run",
    ]) {
      await expect(
        beforeToolCall({ toolName, params: {} }, channelCtx),
      ).resolves.toMatchObject({ block: true });
    }
  });

  it("leaves the reviewed conversation surface working for channels", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();

    for (const toolName of [
      "message",
      "memory_search",
      "web_fetch",
      "image_generate",
      "render_a2ui",
      "sessions_history",
    ]) {
      await expect(
        beforeToolCall({ toolName, params: {} }, channelCtx),
        `${toolName} must stay available to a channel bot`,
      ).resolves.toBeUndefined();
    }
  });

  it("refuses sessions_send from a restricted origin", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();
    // Injecting into another session hands attacker text to a session that
    // runs at the host tier.
    await expect(
      beforeToolCall({ toolName: "sessions_send", params: {} }, channelCtx),
    ).resolves.toMatchObject({ block: true });
  });

  it("does not narrow the desktop surface", async () => {
    const beforeToolCall = await loadBeforeToolCallHook();
    for (const toolName of [
      "mcp__filesystem__write_file",
      "sessions_send",
      "some-plugin__run",
    ]) {
      await expect(
        beforeToolCall({ toolName, params: {} }, desktopCtx),
      ).resolves.toBeUndefined();
    }
  });

  it("opens the surface for a bot that opted its channels in", async () => {
    const beforeToolCall = await loadBeforeToolCallHook({
      hostExecution: {
        "bot-surface-open": { channels: "host", automations: "restricted" },
      },
    });
    await expect(
      beforeToolCall(
        { toolName: "mcp__filesystem__write_file", params: {} },
        {
          sessionKey: "agent:bot-surface-open:slack:channel:CS2",
          channelId: "CS2",
          agentId: "bot-surface-open",
        },
      ),
    ).resolves.toBeUndefined();
  });
});

describe("nexu-toolcall-guard instruction-file fence", () => {
  async function withWorkspaceFence() {
    const root = await mkdtemp(path.join(tmpdir(), "nexu-guard-instr-"));
    const stateDir = path.join(root, "state");
    const nexuHome = path.join(root, "nexu-home");
    const workspace = path.join(stateDir, "agents", "bot-instr");
    await mkdir(workspace, { recursive: true });
    await mkdir(nexuHome, { recursive: true });
    const beforeToolCall = await loadBeforeToolCallHook({
      fence: { stateDir, nexuHome },
    });
    return {
      beforeToolCall,
      workspace,
      cleanup: () => rm(root, { recursive: true, force: true }),
    };
  }

  it("stops a channel run from making an injected turn permanent", async () => {
    const { beforeToolCall, workspace, cleanup } = await withWorkspaceFence();
    try {
      for (const name of ["AGENTS.md", "HEARTBEAT.md", "SOUL.md"]) {
        await expect(
          beforeToolCall(
            {
              toolName: "write",
              params: { path: path.join(workspace, name), content: "x" },
            },
            {
              sessionKey: "agent:bot-instr:slack:channel:CI1",
              channelId: "CI1",
              agentId: "bot-instr",
            },
          ),
          `${name} must not be writable from a channel`,
        ).resolves.toMatchObject({ block: true });
      }

      // Ordinary workspace files stay writable.
      await expect(
        beforeToolCall(
          {
            toolName: "write",
            params: { path: path.join(workspace, "notes.md"), content: "x" },
          },
          {
            sessionKey: "agent:bot-instr:slack:channel:CI1",
            channelId: "CI1",
            agentId: "bot-instr",
          },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it("lets the desktop user edit their own assistant's instructions", async () => {
    const { beforeToolCall, workspace, cleanup } = await withWorkspaceFence();
    try {
      await expect(
        beforeToolCall(
          {
            toolName: "write",
            params: {
              path: path.join(workspace, "AGENTS.md"),
              content: "x",
            },
          },
          { sessionKey: "agent:bot-instr:main", agentId: "bot-instr" },
        ),
      ).resolves.toBeUndefined();
    } finally {
      await cleanup();
    }
  });
});
