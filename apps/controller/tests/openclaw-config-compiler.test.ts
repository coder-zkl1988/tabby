import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import {
  EMBEDDED_BROWSER_TOOLS,
  type OAuthConnectionState,
  compileOpenClawConfig,
  resolveControlUiRoot,
} from "../src/lib/openclaw-config-compiler.js";
import type { NexuConfig } from "../src/store/schemas.js";

function createEnv(overrides: Record<string, unknown> = {}): ControllerEnv {
  return {
    nodeEnv: "test",
    port: 3010,
    host: "127.0.0.1",
    webUrl: "http://localhost:5173",
    nexuHomeDir: "/tmp/nexu-test",
    nexuConfigPath: "/tmp/nexu-test/config.json",
    artifactsIndexPath: "/tmp/nexu-test/artifacts/index.json",
    compiledOpenclawSnapshotPath: "/tmp/nexu-test/compiled-openclaw.json",
    openclawStateDir: "/tmp/openclaw",
    openclawConfigPath: "/tmp/openclaw/openclaw.json",
    openclawSkillsDir: "/tmp/openclaw/skills",
    userSkillsDir: "/tmp/.agents/skills",
    openclawWorkspaceTemplatesDir: "/tmp/openclaw/workspace-templates",
    openclawBin: "openclaw",
    openclawGatewayPort: 18789,
    openclawGatewayToken: "token-123",
    manageOpenclawProcess: false,
    gatewayProbeEnabled: false,
    runtimeSyncIntervalMs: 2000,
    runtimeHealthIntervalMs: 5000,
    defaultModelId: "link/gemini-3-flash-preview",
    localAutomationPreviewEnabled: true,
    ...overrides,
  } as unknown as ControllerEnv;
}

function createConfig(overrides: Partial<NexuConfig> = {}): NexuConfig {
  const now = new Date().toISOString();
  return {
    $schema: "https://nexu.io/config.json",
    schemaVersion: 1,
    app: {},
    bots: [
      {
        id: "bot-1",
        name: "Assistant",
        slug: "assistant",
        poolId: null,
        status: "active",
        modelId: "anthropic/claude-sonnet-4",
        systemPrompt: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    runtime: {
      gateway: {
        port: 18789,
        bind: "loopback",
        authMode: "token",
      },
      defaultModelId: "anthropic/claude-sonnet-4",
    },
    models: {
      mode: "merge",
      providers: {},
    },
    providers: [
      {
        id: "provider-1",
        providerId: "openai",
        displayName: "OpenAI",
        enabled: true,
        baseUrl: null,
        apiKey: "sk-test",
        models: ["gpt-4o"],
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "provider-2",
        providerId: "anthropic",
        displayName: "Anthropic Proxy",
        enabled: true,
        baseUrl: "https://proxy.example.com/v1",
        apiKey: "proxy-key",
        models: ["claude-sonnet-4"],
        createdAt: now,
        updatedAt: now,
      },
    ],
    integrations: [],
    channels: [
      {
        id: "slack-channel-1",
        botId: "bot-1",
        channelType: "slack",
        accountId: "slack-A123-T123",
        status: "connected",
        teamName: "Acme",
        appId: "A123",
        botUserId: null,
        createdAt: now,
        updatedAt: now,
      },
      {
        id: "feishu-channel-1",
        botId: "bot-1",
        channelType: "feishu",
        accountId: "cli_a1b2c3",
        status: "connected",
        teamName: null,
        appId: "cli_a1b2c3",
        botUserId: null,
        createdAt: now,
        updatedAt: now,
      },
    ],
    templates: {},
    skills: {
      version: 1,
      defaults: {
        enabled: true,
        source: "inline",
      },
      items: {},
    },
    desktop: {
      selectedModelId: "gpt-4o",
      cloud: {
        linkUrl: "https://link.example.com",
        apiKey: "link-key",
        models: [
          {
            id: "gemini-2.5-flash",
            name: "Gemini 2.5 Flash",
            provider: "google",
          },
        ],
      },
    },
    deviceControl: {
      enabled: true,
      wsPort: 18790,
      rpcPort: 18801,
    },
    secrets: {
      "channel:slack-channel-1:botToken": "xoxb-test",
      "channel:slack-channel-1:signingSecret": "signing-secret",
      "channel:feishu-channel-1:appId": "cli_a1b2c3",
      "channel:feishu-channel-1:appSecret": "feishu-secret",
      "channel:feishu-channel-1:connectionMode": "webhook",
      "channel:feishu-channel-1:verificationToken": "verify-token",
    },
    ...overrides,
  } as unknown as NexuConfig;
}

describe("compileOpenClawConfig", () => {
  // A bot with no model of its own follows the global default. The compiler
  // expresses that by omitting the per-agent model so OpenClaw falls back to
  // agents.defaults — which is the whole reason per-bot binding can coexist
  // with a global setting instead of being overwritten by it.
  it("omits the per-agent model for a bot that follows the default", () => {
    const config = createConfig();
    const result = compileOpenClawConfig(
      {
        ...config,
        bots: [{ ...config.bots[0], modelId: null } as (typeof config.bots)[0]],
      },
      createEnv(),
    );

    expect(result.agents.list[0]?.model).toBeUndefined();
    expect(
      (result.agents.defaults as Record<string, unknown>).model,
    ).toMatchObject({ primary: expect.stringContaining("claude-sonnet-4") });
  });

  it("keeps a bot's own model even when it differs from the default", () => {
    const config = createConfig();
    const result = compileOpenClawConfig(
      {
        ...config,
        bots: [
          {
            ...config.bots[0],
            modelId: "openai/gpt-4.1",
          } as (typeof config.bots)[0],
        ],
        runtime: {
          ...config.runtime,
          defaultModelId: "anthropic/claude-sonnet-4",
        },
      },
      createEnv(),
    );

    // The bot chose this model; the global default must not reach it.
    expect(result.agents.list[0]?.model).toMatchObject({
      primary: expect.stringContaining("gpt-4.1"),
    });
  });

  it("takes the default from the configured default, not the first bot", () => {
    const config = createConfig();
    const result = compileOpenClawConfig(
      {
        ...config,
        bots: [
          {
            ...config.bots[0],
            modelId: "openai/gpt-4.1",
          } as (typeof config.bots)[0],
        ],
        runtime: {
          ...config.runtime,
          defaultModelId: "anthropic/claude-sonnet-4",
        },
      },
      createEnv(),
    );

    // This once read the first active bot first, which only worked because
    // changing the default rewrote every bot. With per-bot bindings that order
    // lets whichever bot sorts first dictate the default for all the others.
    expect(
      (result.agents.defaults as Record<string, unknown>).model,
    ).toMatchObject({ primary: expect.stringContaining("claude-sonnet-4") });
  });

  it("allows host shell and process execution by default", () => {
    const previousSandboxEnabled = process.env.SANDBOX_ENABLED;
    Reflect.deleteProperty(process.env, "SANDBOX_ENABLED");
    try {
      const result = compileOpenClawConfig(createConfig(), createEnv());
      expect(result.tools?.profile).toBe("full");
      expect(result.tools?.exec).toEqual({
        security: "full",
        ask: "off",
        host: "gateway",
      });
      expect(result.tools?.deny).toBeUndefined();
    } finally {
      if (previousSandboxEnabled === undefined) {
        Reflect.deleteProperty(process.env, "SANDBOX_ENABLED");
      } else {
        process.env.SANDBOX_ENABLED = previousSandboxEnabled;
      }
    }
  });

  it("pins the control UI to explicit loopback origins", () => {
    const result = compileOpenClawConfig(createConfig(), createEnv());
    expect(result.gateway.controlUi?.allowedOrigins).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:18789",
      "http://localhost:18789",
    ]);
    expect(
      result.gateway.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
    ).toBe(false);
  });

  it("compiles memory scope, cross-session recall, and sync settings", () => {
    const result = compileOpenClawConfig(
      createConfig({
        memory: {
          enabled: true,
          sources: ["memory", "sessions"],
          extraPaths: ["docs/knowledge"],
          syncIntervalMinutes: 15,
        },
      }),
      createEnv(),
    );

    expect(result.agents.defaults.memorySearch).toEqual({
      enabled: true,
      sources: ["memory", "sessions"],
      experimental: { sessionMemory: true },
      provider: "none",
      fallback: "none",
      extraPaths: ["docs/knowledge"],
      store: {
        fts: { tokenizer: "trigram" },
        vector: { enabled: false },
      },
      sync: { intervalMinutes: 15 },
    });
  });

  it("keeps session transcript indexing disabled outside cross-session memory", () => {
    const result = compileOpenClawConfig(createConfig(), createEnv());

    expect(result.agents.defaults.memorySearch).toMatchObject({
      sources: ["memory"],
      experimental: { sessionMemory: false },
      provider: "none",
      fallback: "none",
      store: {
        fts: { tokenizer: "trigram" },
        vector: { enabled: false },
      },
    });
  });

  it("reuses a compiled model provider for semantic memory embeddings", () => {
    const result = compileOpenClawConfig(
      createConfig({
        memory: {
          enabled: true,
          sources: ["memory", "sessions"],
          extraPaths: [],
          syncIntervalMinutes: 5,
          provider: "link",
          model: "Qwen/Qwen3-Embedding-4B",
        },
      }),
      createEnv(),
    );

    expect(result.agents.defaults.memorySearch).toMatchObject({
      provider: "link",
      model: "Qwen/Qwen3-Embedding-4B",
      fallback: "none",
      store: {
        fts: { tokenizer: "trigram" },
        vector: { enabled: true },
      },
    });
    expect(result.models?.providers?.link?.apiKey).toBe("link-key");
  });

  it("keeps local automation absent when the persisted config predates it", () => {
    const result = compileOpenClawConfig(createConfig(), createEnv());

    expect(result.mcp).toBeUndefined();
    expect(result.tools?.exec?.security).toBe("full");
    expect(result.tools?.deny).toBeUndefined();
    expect(result.plugins?.allow).toBeUndefined();
    expect(result.plugins?.deny).toBeUndefined();
    expect(result.agents.list[0]?.tools?.alsoAllow).not.toContain("browser");
  });

  it("hands the tool call guard its write-fence roots", () => {
    const env = createEnv();
    const result = compileOpenClawConfig(createConfig(), env);

    // openclaw.json is controller-written and itself fenced, so it is the one
    // delivery path for guard policy that a tool call cannot forge.
    expect(result.plugins?.entries?.["nexu-toolcall-guard"]).toMatchObject({
      enabled: true,
      config: {
        fence: {
          stateDir: env.openclawStateDir,
          nexuHome: env.nexuHomeDir,
        },
      },
    });
  });

  // The manifest is `additionalProperties: false`, so a key the compiler emits
  // or the plugin reads but the manifest omits is rejected at plugin load —
  // silently disarming the guard rather than failing loudly.
  it("emits guard config the plugin's own manifest accepts", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.resolve(
          process.cwd(),
          "static/runtime-plugins/nexu-toolcall-guard/openclaw.plugin.json",
        ),
        "utf8",
      ),
    ) as {
      configSchema: {
        properties: Record<string, { properties?: Record<string, unknown> }>;
      };
    };

    const base = createConfig();
    const config = {
      ...base,
      bots: [
        {
          ...base.bots[0],
          hostExecution: {
            channels: "host" as const,
            automations: "restricted" as const,
          },
        },
      ],
    };
    const emitted = (
      compileOpenClawConfig(config, createEnv()).plugins?.entries?.[
        "nexu-toolcall-guard"
      ] as { config?: Record<string, unknown> }
    )?.config;

    expect(emitted).toBeDefined();
    for (const key of Object.keys(emitted ?? {})) {
      expect(
        Object.keys(manifest.configSchema.properties),
        `guard config key "${key}" is missing from the plugin manifest`,
      ).toContain(key);
    }
    for (const key of Object.keys(
      (emitted?.fence as Record<string, unknown>) ?? {},
    )) {
      expect(
        Object.keys(manifest.configSchema.properties.fence?.properties ?? {}),
        `guard fence key "${key}" is missing from the plugin manifest`,
      ).toContain(key);
    }
  });

  // The gateway refuses to boot on a plugin config key the manifest does not
  // declare (additionalProperties: false) — adding a compiler field without
  // its manifest entry took the whole runtime down, so pin the same
  // compiler↔manifest contract for nexu-browser as for the guard.
  it("emits nexu-browser config the plugin's own manifest accepts", async () => {
    const manifest = JSON.parse(
      await readFile(
        path.resolve(
          process.cwd(),
          "static/runtime-plugins/nexu-browser/openclaw.plugin.json",
        ),
        "utf8",
      ),
    ) as {
      configSchema: { properties: Record<string, unknown> };
    };

    const emitted = (
      compileOpenClawConfig(createConfig(), createEnv()).plugins?.entries?.[
        "nexu-browser"
      ] as { config?: Record<string, unknown> }
    )?.config;

    expect(emitted).toBeDefined();
    for (const key of Object.keys(emitted ?? {})) {
      expect(
        Object.keys(manifest.configSchema.properties),
        `nexu-browser config key "${key}" is missing from the plugin manifest`,
      ).toContain(key);
    }
  });
  it("emits only the bots that opted out of the host-execution default", () => {
    const base = createConfig();
    const config = {
      ...base,
      bots: [
        {
          ...base.bots[0],
          id: "bot-default",
          hostExecution: {
            channels: "restricted" as const,
            automations: "restricted" as const,
          },
        },
        {
          ...base.bots[0],
          id: "bot-opened",
          hostExecution: {
            channels: "host" as const,
            automations: "restricted" as const,
          },
        },
      ],
    };

    const guardEntry = compileOpenClawConfig(config, createEnv()).plugins
      ?.entries?.["nexu-toolcall-guard"] as
      | { config?: { hostExecution?: Record<string, unknown> } }
      | undefined;

    expect(guardEntry?.config?.hostExecution).toEqual({
      "bot-opened": { channels: "host", automations: "restricted" },
    });
  });

  it("compiles feishu browser owners into exact owner-DM session keys", () => {
    const base = createConfig();
    const config: NexuConfig = {
      ...base,
      channels: base.channels.map((channel) =>
        channel.channelType === "feishu"
          ? {
              ...channel,
              feishuPermissions: {
                requireMention: true,
                dmPolicy: "open" as const,
                groupPolicy: "open" as const,
                allowFrom: [],
                browserOwnerIds: ["ou_owner_1", "ou_owner_2"],
              },
            }
          : channel,
      ),
    };

    const guardEntry = compileOpenClawConfig(config, createEnv()).plugins
      ?.entries?.["nexu-toolcall-guard"] as
      | { config?: { browserOwnerSessions?: string[] } }
      | undefined;

    expect(guardEntry?.config?.browserOwnerSessions).toEqual([
      "agent:bot-1:direct:ou_owner_1",
      "agent:bot-1:direct:ou_owner_2",
    ]);

    // Both browser-facing plugins keep independent fail-closed copies of this
    // gate; the list must reach each of them or one layer blocks what the
    // other allows.
    const browserEntry = compileOpenClawConfig(config, createEnv()).plugins
      ?.entries?.["nexu-browser"] as
      | { config?: { browserOwnerSessions?: string[] } }
      | undefined;
    expect(browserEntry?.config?.browserOwnerSessions).toEqual([
      "agent:bot-1:direct:ou_owner_1",
      "agent:bot-1:direct:ou_owner_2",
    ]);
  });

  it("emits no browser owner sessions for disconnected or ownerless channels", () => {
    const base = createConfig();
    const config: NexuConfig = {
      ...base,
      channels: base.channels.map((channel) =>
        channel.channelType === "feishu"
          ? {
              ...channel,
              status: "disconnected" as const,
              feishuPermissions: {
                requireMention: true,
                dmPolicy: "open" as const,
                groupPolicy: "open" as const,
                allowFrom: [],
                browserOwnerIds: ["ou_owner_1"],
              },
            }
          : channel,
      ),
    };

    const guardEntry = compileOpenClawConfig(config, createEnv()).plugins
      ?.entries?.["nexu-toolcall-guard"] as
      | { config?: { browserOwnerSessions?: string[] } }
      | undefined;

    expect(guardEntry?.config?.browserOwnerSessions).toEqual([]);
  });

  it("does not grant external command ownership or channel restarts", () => {
    const result = compileOpenClawConfig(createConfig(), createEnv());

    expect(result.commands?.restart).toBe(false);
    expect(result.commands?.ownerAllowFrom).toBeUndefined();
  });

  it("grants the embedded browser tools instead of control of the user's Chrome", () => {
    const result = compileOpenClawConfig(
      createConfig({
        localAutomation: {
          browser: { enabled: true },
          computerUse: { enabled: false },
        },
      }),
      createEnv(),
    );

    expect(result.agents.list[0]?.tools?.alsoAllow).toEqual(
      expect.arrayContaining([...EMBEDDED_BROWSER_TOOLS]),
    );
    // OpenClaw silently blocks `agent_end` for non-bundled plugins without
    // this grant, and the run-ended signal that unpins the browser panel dies
    // with it — measured: the hook never fired until the flag was compiled.
    expect(
      (
        result.plugins?.entries?.["nexu-browser"] as {
          hooks?: { allowConversationAccess?: boolean };
        }
      )?.hooks?.allowConversationAccess,
    ).toBe(true);
    // OpenClaw's own browser tool drives the user's real Chrome, including a
    // profile that attaches to their signed-in session. The agent is meant to
    // get the browser panel inside the app instead, which carries no session
    // the user did not open in it.
    //
    // Emitting nothing was not enough: OpenClaw bundles that plugin and enables
    // it by default, so "not configured" still meant "available", and the agent
    // — seeing one rich tool next to five narrow ones — chose it and browsed in
    // Chrome. It has to be disabled explicitly.
    expect(result.plugins?.allow).toBeUndefined();
    expect(result.plugins?.entries?.browser).toEqual({ enabled: false });
    expect(result.agents.list[0]?.tools?.alsoAllow).not.toContain("browser");
    expect(result.tools?.exec?.security).toBe("full");
    expect(result.tools?.deny).toBeUndefined();
  });

  it("withholds the embedded browser tools while the switch is off", () => {
    const result = compileOpenClawConfig(
      createConfig({
        localAutomation: {
          browser: { enabled: false },
          computerUse: { enabled: false },
        },
      }),
      createEnv(),
    );

    for (const tool of EMBEDDED_BROWSER_TOOLS) {
      expect(result.agents.list[0]?.tools?.alsoAllow).not.toContain(tool);
    }
  });

  it("fails closed when local automation preview is disabled", () => {
    const result = compileOpenClawConfig(
      createConfig({
        localAutomation: {
          browser: { enabled: true },
          computerUse: { enabled: true },
        },
      }),
      createEnv({
        localAutomationPreviewEnabled: false,
        computerUseBackend: "cua-driver",
        computerUseBin: process.execPath,
      }),
    );

    expect(result.mcp).toBeUndefined();
    expect(result.plugins?.allow).toBeUndefined();
    // Disabled explicitly, not merely unconfigured — the bundled plugin is on
    // by default, so omitting it leaves the user's real Chrome reachable.
    expect(result.plugins?.entries?.browser).toEqual({ enabled: false });
    expect(result.agents.list[0]?.tools?.alsoAllow).not.toContain("browser");
    expect(result.agents.list[0]?.tools?.alsoAllow).not.toContain(
      "cua-driver__click",
    );
    expect(result.tools?.exec?.security).toBe("full");
  });

  it("fails closed when the local automation preview flag is missing", () => {
    const result = compileOpenClawConfig(
      createConfig({
        localAutomation: {
          browser: { enabled: true },
          computerUse: { enabled: true },
        },
      }),
      createEnv({
        localAutomationPreviewEnabled: undefined,
        computerUseBackend: "cua-driver",
        computerUseBin: process.execPath,
      }),
    );

    expect(result.mcp).toBeUndefined();
  });

  it("registers the notarized CuaDriver bundle as the macOS MCP backend", () => {
    const result = compileOpenClawConfig(
      createConfig({
        localAutomation: {
          browser: { enabled: false },
          computerUse: { enabled: true },
        },
      }),
      createEnv({
        computerUseBackend: "cua-driver",
        computerUseBin: process.execPath,
      }),
    );
    const server = result.mcp?.servers["cua-driver"] as
      | Record<string, unknown>
      | undefined;

    expect(server).toMatchObject({
      command: process.execPath,
      transport: "stdio",
    });
    // The MCP process is a thin client of the daemon that owns the grants.
    expect(server?.args).toEqual(["mcp", "--embedded"]);
    expect(server?.toolFilter).toMatchObject({
      include: expect.arrayContaining([
        "click",
        "type_text",
        "set_value",
        "get_window_state",
      ]),
    });
    // Nested agent loops and remote-debugging browser control are not part
    // of the reviewed surface on any platform.
    expect(server?.toolFilter).not.toMatchObject({
      include: expect.arrayContaining(["agent"]),
    });
    expect(result.tools?.exec?.security).toBe("full");
  });

  it("registers cua-driver on Windows and omits a missing sidecar", () => {
    const enabledConfig = createConfig({
      localAutomation: {
        browser: { enabled: false },
        computerUse: { enabled: true },
      },
    });
    const available = compileOpenClawConfig(
      enabledConfig,
      createEnv({
        computerUseBackend: "cua-driver",
        computerUseBin: process.execPath,
      }),
    );
    const unavailable = compileOpenClawConfig(
      enabledConfig,
      createEnv({
        computerUseBackend: "cua-driver",
        computerUseBin: "/definitely/missing/cua-driver.exe",
      }),
    );

    expect(available.mcp?.servers["cua-driver"]).toMatchObject({
      command: process.execPath,
      args: ["mcp", "--embedded"],
      env: {
        CUA_DRIVER_EMBEDDED: "1",
        CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
      },
      toolFilter: {
        include: expect.arrayContaining([
          "get_desktop_state",
          "get_window_state",
          "type_text",
          "press_key",
        ]),
      },
    });
    expect(unavailable.mcp).toBeUndefined();
    expect(available.tools?.exec?.security).toBe("full");
    expect(available.tools?.deny).toBeUndefined();
  });

  it("keeps command execution inside an explicitly enabled sandbox", () => {
    const previousSandboxEnabled = process.env.SANDBOX_ENABLED;
    process.env.SANDBOX_ENABLED = "true";
    try {
      const result = compileOpenClawConfig(createConfig(), createEnv());

      expect(result.tools?.exec).toMatchObject({
        security: "full",
        ask: "off",
        host: "sandbox",
      });
      expect(result.tools?.deny).toBeUndefined();
      expect(result.tools?.sandbox?.tools?.allow).toBeUndefined();
      expect(result.tools?.sandbox?.tools?.deny).toEqual(["gateway"]);
    } finally {
      if (previousSandboxEnabled === undefined) {
        Reflect.deleteProperty(process.env, "SANDBOX_ENABLED");
      } else {
        process.env.SANDBOX_ENABLED = previousSandboxEnabled;
      }
    }
  });

  it("does not expose persisted Computer Use on an unsupported platform", () => {
    const result = compileOpenClawConfig(
      createConfig({
        localAutomation: {
          browser: { enabled: false },
          computerUse: { enabled: true },
        },
      }),
      createEnv({
        computerUseBackend: "cua-driver",
        computerUseBin: process.execPath,
        computerUsePlatformSupported: false,
      }),
    );

    expect(result.mcp).toBeUndefined();
  });

  it("marks the desktop defaultBotId agent as the default agent", () => {
    const now = new Date().toISOString();
    const botBase = {
      poolId: null,
      status: "active",
      modelId: "anthropic/claude-sonnet-4",
      systemPrompt: null,
      origin: "user",
      createdAt: now,
      updatedAt: now,
    };
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          { ...botBase, id: "bot-a", name: "A", slug: "aaa" },
          { ...botBase, id: "bot-z", name: "Z", slug: "zzz" },
        ],
        desktop: { defaultBotId: "bot-z" },
      } as unknown as Partial<NexuConfig>),
      createEnv(),
    );

    const defaultFlags = Object.fromEntries(
      result.agents.list.map((agent) => [agent.id, agent.default]),
    );
    expect(defaultFlags).toEqual({ "bot-a": false, "bot-z": true });
  });

  it("marks the system bot as the default agent when no defaultBotId is set", () => {
    const now = new Date().toISOString();
    const botBase = {
      poolId: null,
      status: "active",
      modelId: "anthropic/claude-sonnet-4",
      systemPrompt: null,
      createdAt: now,
      updatedAt: now,
    };
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          { ...botBase, id: "bot-a", name: "A", slug: "aaa", origin: "user" },
          {
            ...botBase,
            id: "bot-sys",
            name: "Tabby",
            slug: "zzz-tabby",
            origin: "system",
          },
        ],
        desktop: {},
      } as unknown as Partial<NexuConfig>),
      createEnv(),
    );

    const defaultFlags = Object.fromEntries(
      result.agents.list.map((agent) => [agent.id, agent.default]),
    );
    expect(defaultFlags).toEqual({ "bot-a": false, "bot-sys": true });
  });

  it("emits sub-agent delegation config on every agent (in-chat auto-routing)", () => {
    const result = compileOpenClawConfig(createConfig(), createEnv());
    expect(result.agents.list.length).toBeGreaterThan(0);
    for (const agent of result.agents.list) {
      expect(agent.tools).toMatchObject({
        alsoAllow: expect.arrayContaining(["sessions_spawn", "sessions_yield"]),
      });
      expect(agent.subagents).toEqual({ allowAgents: ["*"] });
    }
  });

  it("builds OpenClaw config with provider and channel parity defaults", () => {
    // Provide canonical models.providers so the compiler can resolve provider
    // descriptors (legacy config.providers is not read by the compiler).
    const now = new Date().toISOString();
    const result = compileOpenClawConfig(
      createConfig({
        models: {
          mode: "merge",
          providers: {
            openai: {
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-4o",
                  name: "gpt-4o",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
            // Proxy baseUrl → runtime key becomes byok_anthropic
            anthropic: {
              enabled: true,
              auth: "api-key",
              api: "anthropic-messages",
              apiKey: "proxy-key",
              baseUrl: "https://proxy.example.com/v1",
              models: [
                {
                  id: "claude-sonnet-4",
                  name: "claude-sonnet-4",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          } as unknown as Record<string, unknown>,
        } as unknown as NexuConfig["models"],
        providers: [],
        createdAt: now,
        updatedAt: now,
      } as unknown as Partial<NexuConfig>),
      createEnv(),
    );

    expect(result.gateway.auth.mode).toBe("token");
    expect(result.gateway.auth.token).toBe("token-123");
    expect(result.gateway.controlUi?.allowedOrigins).toEqual([
      "http://localhost:5173",
      "http://127.0.0.1:18789",
      "http://localhost:18789",
    ]);
    expect(
      result.gateway.controlUi?.dangerouslyAllowHostHeaderOriginFallback,
    ).toBe(false);
    // bot modelId "anthropic/claude-sonnet-4" matches the proxied anthropic
    // descriptor (byok_anthropic); namespace prefix is stripped from model id.
    expect(result.agents.defaults?.model).toEqual({
      primary: "byok_anthropic/claude-sonnet-4",
    });
    expect(result.agents.list[0]).toMatchObject({
      id: "bot-1",
      workspace: "/tmp/openclaw/agents/bot-1",
      model: { primary: "byok_anthropic/claude-sonnet-4" },
    });
    expect(result.models?.providers.openai?.models[0]?.id).toBe("gpt-4o");
    // BYOK anthropic proxy: model id stored bare (canonical prefix stripped)
    expect(result.models?.providers.byok_anthropic?.models[0]?.id).toBe(
      "claude-sonnet-4",
    );
    expect(result.models?.providers.link?.baseUrl).toBe(
      "https://link.example.com/v1",
    );
    expect(result.channels.slack?.accounts["slack-A123-T123"]).toMatchObject({
      mode: "http",
      webhookPath: "/slack/events/slack-A123-T123",
      botToken: "xoxb-test",
    });
    expect(result.channels.feishu?.accounts.cli_a1b2c3).toMatchObject({
      connectionMode: "webhook",
      webhookPath: "/feishu/events/cli_a1b2c3",
      verificationToken: "verify-token",
    });
    // Feishu Card Kit streaming was added intentionally (commit 626adb7b9)
    expect(result.channels.feishu).toMatchObject({
      streaming: true,
      renderMode: "card",
      requireMention: true,
    });
    // Plugin key is "openclaw-lark" since commit 66ac77e7a
    expect(result.plugins?.entries?.["openclaw-lark"]?.enabled).toBe(true);
    expect(result.skills?.load?.extraDirs).toEqual([
      "/tmp/openclaw/skills",
      "/tmp/.agents/skills",
    ]);
  });

  it("compiles Tabby aliases with their underlying-model context windows", () => {
    const result = compileOpenClawConfig(
      createConfig({
        desktop: {
          selectedModelId: "link/tabby-ultra",
          cloud: {
            linkUrl: "https://link.example.com",
            apiKey: "link-key",
            models: [
              { id: "tabby-ultra", name: "tabby-ultra", provider: "openai" },
              { id: "tabby-pro", name: "tabby-pro", provider: "openai" },
              { id: "tabby-plus", name: "tabby-plus", provider: "openai" },
              { id: "tabby-mini", name: "tabby-mini", provider: "openai" },
            ],
          },
        },
      }),
      createEnv(),
    );

    expect(result.models?.providers.link?.models).toMatchObject([
      { id: "tabby-ultra", contextWindow: 258000, maxTokens: 128000 },
      { id: "tabby-pro", contextWindow: 1048576, maxTokens: 131072 },
      { id: "tabby-plus", contextWindow: 1048576, maxTokens: 131072 },
      { id: "tabby-mini", contextWindow: 258000, maxTokens: 32768 },
    ]);
  });

  it("gives agents.defaults a failover ladder of the relay's other chat models", () => {
    const result = compileOpenClawConfig(
      createConfig({
        desktop: {
          selectedModelId: "link/tabby-plus",
          cloud: {
            linkUrl: "https://link.example.com",
            apiKey: "link-key",
            models: [
              { id: "tabby-plus", name: "tabby-plus", provider: "openai" },
              { id: "tabby-ultra", name: "tabby-ultra", provider: "openai" },
              { id: "tabby-phone", name: "tabby-phone", provider: "openai" },
              // Not chat surfaces — never valid failover targets.
              {
                id: "tabby-image-pro",
                name: "tabby-image-pro",
                provider: "openai",
              },
              { id: "tabby-video", name: "tabby-video", provider: "openai" },
              { id: "BAAI/bge-m3", name: "bge-m3", provider: "baai" },
            ],
          },
        },
        runtime: {
          gateway: { port: 18789, bind: "loopback", authMode: "token" },
          defaultModelId: "link/tabby-plus",
        },
      }),
      createEnv(),
    );

    expect(result.agents.defaults?.model).toEqual({
      primary: "link/tabby-plus",
      fallbacks: ["link/tabby-ultra", "link/tabby-phone"],
    });
  });

  it("never fails a BYOK primary over to the relay", () => {
    const result = compileOpenClawConfig(
      createConfig({
        desktop: {
          selectedModelId: "byok_anthropic/claude-sonnet-4",
          cloud: {
            linkUrl: "https://link.example.com",
            apiKey: "link-key",
            models: [
              { id: "tabby-plus", name: "tabby-plus", provider: "openai" },
            ],
          },
        },
      }),
      createEnv(),
    );

    expect(
      (result.agents.defaults?.model as { fallbacks?: string[] }).fallbacks,
    ).toBeUndefined();
  });

  it("fills known GLM and StepFun windows when BYOK stores no metadata", () => {
    const model = (id: string) => ({
      id,
      name: id,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 0,
      maxTokens: 0,
    });
    const result = compileOpenClawConfig(
      createConfig({
        models: {
          mode: "merge",
          providers: {
            glm: {
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: "glm-key",
              baseUrl: "https://open.bigmodel.cn/api/coding/paas/v4",
              models: [model("glm-5.3"), model("glm-5.3-flash")],
            },
            stepfun: {
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: "step-key",
              baseUrl: "https://api.stepfun.com/step_plan/v1/",
              models: [model("step-3.7-flash")],
            },
          } as unknown as Record<string, unknown>,
        } as unknown as NexuConfig["models"],
      }),
      createEnv(),
    );

    const compiledModels = Object.values(
      result.models?.providers ?? {},
    ).flatMap((provider) => provider.models ?? []);
    const byId = new Map(compiledModels.map((model) => [model.id, model]));
    expect(byId.get("glm-5.3")).toMatchObject({
      contextWindow: 1048576,
      maxTokens: 131072,
    });
    expect(byId.get("glm-5.3-flash")).toMatchObject({
      contextWindow: 1048576,
      maxTokens: 131072,
    });
    expect(byId.get("step-3.7-flash")).toMatchObject({
      contextWindow: 245760,
      maxTokens: 8192,
    });
  });

  it("does not allow/enable openclaw-weixin without a connected wechat channel", () => {
    // The empty-config prewarm was removed because always-loading the channel
    // plugins (plus the placeholder channels) blocked controller readiness for
    // ~120s. openclaw-weixin is only allowed/enabled once a real WeChat channel
    // connects; the first connect then triggers a one-time gateway reload.
    const result = compileOpenClawConfig(
      createConfig({
        channels: [],
        secrets: {},
      }),
      createEnv(),
    );

    expect(result.plugins?.allow).toBeUndefined();
    expect(result.plugins?.entries?.["openclaw-weixin"]).toBeUndefined();
  });

  it("compiles qqbot channels and enables the canonical qq plugin id", () => {
    const now = new Date().toISOString();
    const result = compileOpenClawConfig(
      createConfig({
        channels: [
          {
            id: "qq-channel-1",
            botId: "bot-1",
            channelType: "qqbot",
            accountId: "default",
            status: "connected",
            teamName: null,
            appId: "123456",
            botUserId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        secrets: {
          "channel:qq-channel-1:appId": "123456",
          "channel:qq-channel-1:clientSecret": "qq-secret",
        },
      }),
      createEnv(),
    );

    expect(result.channels.qqbot).toMatchObject({
      enabled: true,
      appId: "123456",
      clientSecret: "qq-secret",
      dmPolicy: "open",
      groupPolicy: "open",
      historyLimit: 50,
      markdownSupport: true,
    });
    expect(result.bindings).toContainEqual({
      agentId: "bot-1",
      match: {
        channel: "qqbot",
        accountId: "default",
      },
    });
    expect(result.plugins?.allow).toBeUndefined();
    expect(result.plugins?.entries?.["openclaw-qqbot"]?.enabled).toBe(true);
  });

  it("compiles wecom channels and enables the canonical wecom plugin id", () => {
    const now = new Date().toISOString();
    const result = compileOpenClawConfig(
      createConfig({
        channels: [
          {
            id: "wecom-channel-1",
            botId: "bot-1",
            channelType: "wecom",
            accountId: "default",
            status: "connected",
            teamName: null,
            appId: "wecom-bot-123",
            botUserId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        secrets: {
          "channel:wecom-channel-1:botId": "wecom-bot-123",
          "channel:wecom-channel-1:secret": "wecom-secret",
        },
      }),
      createEnv(),
    );

    expect(result.channels.wecom).toMatchObject({
      enabled: true,
      botId: "wecom-bot-123",
      secret: "wecom-secret",
      dmPolicy: "open",
      groupPolicy: "open",
      sendThinkingMessage: true,
    });
    expect(result.bindings).toContainEqual({
      agentId: "bot-1",
      match: {
        channel: "wecom",
        accountId: "default",
      },
    });
    expect(result.plugins?.allow).toBeUndefined();
    expect(result.plugins?.entries?.wecom?.enabled).toBe(true);
  });

  it("injects env-backed litellm routing for bare local model ids", () => {
    const result = compileOpenClawConfig(
      createConfig({
        providers: [],
        desktop: {},
        bots: [
          {
            ...createConfig().bots[0],
            modelId: "anthropic/claude-sonnet-4",
          },
        ],
        runtime: {
          gateway: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
          },
          defaultModelId: "anthropic/claude-sonnet-4",
        },
      }),
      createEnv({
        litellmBaseUrl: "https://litellm.powerformer.net",
        litellmApiKey: "litellm-key",
      }),
    );

    expect(result.models?.providers.litellm?.baseUrl).toBe(
      "https://litellm.powerformer.net",
    );
    expect(result.models?.providers.litellm?.models[0]?.id).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect(result.agents.defaults?.model).toEqual({
      primary: "litellm/anthropic/claude-sonnet-4",
    });
    expect(result.agents.list[0]?.model).toEqual({
      primary: "litellm/anthropic/claude-sonnet-4",
    });
  });

  it("compiles dingtalk channels and enables the canonical dingtalk plugin id", () => {
    const now = new Date().toISOString();
    const result = compileOpenClawConfig(
      createConfig({
        channels: [
          {
            id: "dingtalk-channel-1",
            botId: "bot-1",
            channelType: "dingtalk",
            accountId: "default",
            status: "connected",
            teamName: null,
            appId: "ding-client-id",
            botUserId: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
        secrets: {
          "channel:dingtalk-channel-1:clientId": "ding-client-id",
          "channel:dingtalk-channel-1:clientSecret": "ding-client-secret",
        },
      }),
      createEnv(),
    );

    expect(result.plugins?.entries?.["tabby-control"]).toEqual({
      enabled: true,
      config: {
        wsPort: 18790,
        rpcPort: 18801,
      },
    });

    expect(result.channels["dingtalk-connector"]).toMatchObject({
      enabled: true,
      clientId: "ding-client-id",
      clientSecret: "ding-client-secret",
      gatewayBaseUrl: "http://127.0.0.1:18789",
      gatewayToken: "token-123",
      dmPolicy: "open",
      groupPolicy: "open",
    });
    expect(
      (
        result.gateway as {
          http?: { endpoints?: { chatCompletions?: { enabled?: boolean } } };
        }
      ).http?.endpoints?.chatCompletions?.enabled,
    ).toBe(true);
    // dingtalk accountId "default" is mapped to "__default__" at runtime
    // (resolveOpenClawRuntimeAccountId, added in commit e825ac79e)
    expect(result.bindings).toContainEqual({
      agentId: "bot-1",
      match: {
        channel: "dingtalk-connector",
        accountId: "__default__",
      },
    });
    expect(result.plugins?.allow).toBeUndefined();
    expect(result.plugins?.entries?.["dingtalk-connector"]?.enabled).toBe(true);
  });

  it("does not remap openai models to OAuth providers without persisted OAuth state", () => {
    const baseConfig = createConfig();
    const baseBot = baseConfig.bots[0];
    const baseProvider = baseConfig.providers?.[0];
    if (!baseBot || !baseProvider) {
      throw new Error("expected base config fixtures");
    }
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          {
            ...baseBot,
            modelId: "openai/gpt-5.4",
          },
        ],
        runtime: {
          gateway: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
          },
          defaultModelId: "openai/gpt-5.4",
        },
        providers: [
          {
            ...baseProvider,
            apiKey: null,
            models: ["gpt-5.4"],
          },
        ],
        desktop: {},
      }),
      createEnv(),
    );

    expect(result.agents.defaults?.model).toEqual({
      primary: "openai/gpt-5.4",
    });
    expect(result.agents.list[0]?.model).toEqual({
      primary: "openai/gpt-5.4",
    });
  });

  it("uses SiliconFlow's cn API base URL by default", () => {
    // Use canonical models.providers so the compiler can resolve the descriptor.
    // Legacy config.providers is not read by the compiler.
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          {
            ...createConfig().bots[0],
            modelId: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
          },
        ],
        runtime: {
          gateway: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
          },
          defaultModelId: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
        },
        providers: [],
        models: {
          mode: "merge",
          providers: {
            siliconflow: {
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: "sk-test",
              // null baseUrl → compiler picks default: https://api.siliconflow.cn/v1
              baseUrl: "https://api.siliconflow.cn/v1",
              models: [
                {
                  id: "Pro/MiniMaxAI/MiniMax-M2.5",
                  name: "Pro/MiniMaxAI/MiniMax-M2.5",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          } as unknown as Record<string, unknown>,
        } as unknown as NexuConfig["models"],
        desktop: {},
      }),
      createEnv(),
    );

    expect(result.models?.providers.siliconflow?.baseUrl).toBe(
      "https://api.siliconflow.cn/v1",
    );
    expect(result.models?.providers.siliconflow?.models[0]?.id).toBe(
      "Pro/MiniMaxAI/MiniMax-M2.5",
    );
    expect(result.agents.defaults?.model).toEqual({
      primary: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
    });
  });

  it("treats the explicit SiliconFlow .cn URL as a direct official endpoint", () => {
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          {
            ...createConfig().bots[0],
            modelId: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
          },
        ],
        runtime: {
          gateway: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
          },
          defaultModelId: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
        },
        providers: [],
        models: {
          mode: "merge",
          providers: {
            siliconflow: {
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: "sk-test",
              baseUrl: "https://api.siliconflow.cn/v1",
              models: [
                {
                  id: "Pro/MiniMaxAI/MiniMax-M2.5",
                  name: "Pro/MiniMaxAI/MiniMax-M2.5",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          } as unknown as Record<string, unknown>,
        } as unknown as NexuConfig["models"],
        desktop: {},
      }),
      createEnv(),
    );

    // .cn is a default URL → direct (non-proxy) mode, runtimeKey = "siliconflow"
    expect(result.models?.providers.siliconflow?.baseUrl).toBe(
      "https://api.siliconflow.cn/v1",
    );
    expect(result.models?.providers.byok_siliconflow).toBeUndefined();
    expect(result.models?.providers.siliconflow?.models[0]?.id).toBe(
      "Pro/MiniMaxAI/MiniMax-M2.5",
    );
    expect(result.agents.defaults?.model).toEqual({
      primary: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
    });
  });

  it("treats the legacy SiliconFlow .com URL as a direct default endpoint", () => {
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          {
            ...createConfig().bots[0],
            modelId: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
          },
        ],
        runtime: {
          gateway: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
          },
          defaultModelId: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
        },
        providers: [],
        models: {
          mode: "merge",
          providers: {
            siliconflow: {
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: "sk-test",
              // .com is also in defaultBaseUrls → direct (non-proxy) mode
              baseUrl: "https://api.siliconflow.com/v1",
              models: [
                {
                  id: "Pro/MiniMaxAI/MiniMax-M2.5",
                  name: "Pro/MiniMaxAI/MiniMax-M2.5",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          } as unknown as Record<string, unknown>,
        } as unknown as NexuConfig["models"],
        desktop: {},
      }),
      createEnv(),
    );

    // .com is a legacy default URL (in defaultBaseUrls) → direct mode, not proxied
    expect(result.models?.providers.siliconflow?.baseUrl).toBe(
      "https://api.siliconflow.com/v1",
    );
    expect(result.models?.providers.byok_siliconflow).toBeUndefined();
    expect(result.models?.providers.siliconflow?.models[0]?.id).toBe(
      "Pro/MiniMaxAI/MiniMax-M2.5",
    );
    expect(result.agents.defaults?.model).toEqual({
      primary: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
    });
  });

  it("treats custom SiliconFlow gateway URLs as proxied endpoints", () => {
    // Use the canonical persisted modelId form: "siliconflow/Pro/..." (not
    // "byok_siliconflow/siliconflow/..." which was the pre-normalisation legacy form).
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          {
            ...createConfig().bots[0],
            modelId: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
          },
        ],
        runtime: {
          gateway: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
          },
          defaultModelId: "siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
        },
        providers: [],
        models: {
          mode: "merge",
          providers: {
            siliconflow: {
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: "sk-test",
              // Custom (non-default) baseUrl → proxy mode, runtimeKey = byok_siliconflow
              baseUrl: "https://models.example.com/v1",
              models: [
                {
                  id: "Pro/MiniMaxAI/MiniMax-M2.5",
                  name: "Pro/MiniMaxAI/MiniMax-M2.5",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          } as unknown as Record<string, unknown>,
        } as unknown as NexuConfig["models"],
        desktop: {},
      }),
      createEnv(),
    );

    expect(result.models?.providers.byok_siliconflow?.baseUrl).toBe(
      "https://models.example.com/v1",
    );
    expect(result.models?.providers.siliconflow).toBeUndefined();
    // BYOK proxy: canonical namespace prefix ("siliconflow/") is stripped from model id
    expect(result.models?.providers.byok_siliconflow?.models[0]?.id).toBe(
      "Pro/MiniMaxAI/MiniMax-M2.5",
    );
    // resolveModelId: "siliconflow/Pro/..." matched by "siliconflow" prefix on
    // byok descriptor → produces "byok_siliconflow/Pro/MiniMaxAI/MiniMax-M2.5"
    expect(result.agents.defaults?.model).toEqual({
      primary: "byok_siliconflow/Pro/MiniMaxAI/MiniMax-M2.5",
    });
  });

  it("ignores unsupported custom providers in compiled model config", () => {
    const baseConfig = createConfig();
    const baseProviders = baseConfig.providers ?? [];
    const baseProvider = baseProviders[0];
    if (!baseProvider) {
      throw new Error("expected base config providers");
    }
    const result = compileOpenClawConfig(
      createConfig({
        providers: [
          ...baseProviders,
          {
            ...baseProvider,
            id: "provider-3",
            providerId: "custom",
            displayName: "Custom",
            baseUrl: "https://models.example.com/v1",
            apiKey: "custom-key",
            models: ["anthropic/claude-sonnet-4"],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          },
        ],
      }),
      createEnv(),
    );

    expect(Object.keys(result.models?.providers ?? {})).not.toContain("custom");
    expect(
      Object.keys(result.models?.providers ?? {}).some((key) =>
        key.startsWith("custom_"),
      ),
    ).toBe(false);
  });

  it("uses the CN MiniMax endpoint for CN OAuth providers", () => {
    // Use canonical models.providers format; legacy config.providers is not
    // read by the compiler. CN region → resolveDefaultBaseUrls returns the
    // CN endpoint first: https://api.minimaxi.com/anthropic
    const result = compileOpenClawConfig(
      createConfig({
        providers: [],
        models: {
          mode: "merge",
          providers: {
            minimax: {
              enabled: true,
              auth: "oauth",
              api: "anthropic-messages",
              oauthRegion: "cn",
              oauthProfileRef: "minimax-portal",
              // null baseUrl → resolveDefaultBaseUrls("minimax","cn") picks CN first
              baseUrl: "https://api.minimaxi.com/anthropic",
              models: [
                {
                  id: "MiniMax-M2.7",
                  name: "MiniMax-M2.7",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          } as unknown as Record<string, unknown>,
        } as unknown as NexuConfig["models"],
        desktop: {},
      }),
      createEnv(),
    );

    expect(result.models?.providers.minimax?.baseUrl).toBe(
      "https://api.minimaxi.com/anthropic",
    );
  });

  it("compiles canonical custom provider instances with deterministic runtime keys", () => {
    const now = new Date().toISOString();
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          {
            ...createConfig().bots[0],
            modelId: "custom-openai/team-gateway/anthropic/claude-haiku-4.5",
            createdAt: now,
            updatedAt: now,
          },
        ],
        runtime: {
          gateway: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
          },
          defaultModelId:
            "custom-openai/team-gateway/anthropic/claude-haiku-4.5",
        },
        providers: [],
        models: {
          mode: "merge",
          providers: {
            "custom-openai/team-gateway": {
              providerTemplateId: "custom-openai",
              instanceId: "team-gateway",
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: "custom-key",
              baseUrl: "https://gateway.example.com/v1",
              displayName: "Team Gateway",
              headers: {
                "x-team-id": "team-gateway",
              },
              models: [
                {
                  id: "anthropic/claude-haiku-4.5",
                  name: "Claude Haiku 4.5",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          },
        },
        desktop: {},
      }),
      createEnv(),
    );

    expect(
      result.models?.providers["custom-openai__team-gateway"],
    ).toMatchObject({
      baseUrl: "https://gateway.example.com/v1",
      apiKey: "custom-key",
      api: "openai-completions",
      headers: {
        "x-team-id": "team-gateway",
      },
    });
    expect(
      result.models?.providers["custom-openai__team-gateway"]?.models[0]?.id,
    ).toBe("anthropic/claude-haiku-4.5");
    expect(result.agents.defaults?.model).toEqual({
      primary: "custom-openai__team-gateway/anthropic/claude-haiku-4.5",
    });
  });

  it("preserves secret-ref provider API keys in compiled models config", () => {
    const result = compileOpenClawConfig(
      createConfig({
        providers: [],
        models: {
          mode: "merge",
          providers: {
            openai: {
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: {
                source: "env",
                provider: "nexu",
                id: "openai-api-key",
              },
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-4.1",
                  name: "GPT-4.1",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          },
        },
        desktop: {},
      }),
      createEnv(),
    );

    expect(result.models?.providers.openai?.apiKey).toEqual({
      source: "env",
      provider: "nexu",
      id: "openai-api-key",
    });
    expect(result.models?.providers.openai?.models[0]?.id).toBe("gpt-4.1");
  });

  it("normalizes legacy byok model refs against canonical provider config", () => {
    const now = new Date().toISOString();
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          {
            ...createConfig().bots[0],
            modelId: "byok_openai/openai/gpt-4.1",
            createdAt: now,
            updatedAt: now,
          },
        ],
        runtime: {
          gateway: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
          },
          defaultModelId: "byok_openai/openai/gpt-4.1",
        },
        providers: [],
        models: {
          mode: "merge",
          providers: {
            openai: {
              enabled: true,
              auth: "api-key",
              api: "openai-completions",
              apiKey: "sk-test",
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-4.1",
                  name: "GPT-4.1",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          },
        },
        desktop: {},
      }),
      createEnv(),
    );

    expect(result.agents.defaults?.model).toEqual({
      primary: "openai/gpt-4.1",
    });
  });

  describe("agent skill assignment", () => {
    it("includes skills on agents when installedSlugs is provided", () => {
      const config = createConfig();
      const env = createEnv();
      const compiled = compileOpenClawConfig(config, env, undefined, [
        "git",
        "npm",
      ]);
      expect(compiled.agents.list[0].skills).toEqual(["git", "npm"]);
    });

    it("omits skills field when installedSlugs is empty (legacy fallback)", () => {
      const config = createConfig();
      const env = createEnv();
      const compiled = compileOpenClawConfig(config, env, undefined, []);
      expect(compiled.agents.list[0]).not.toHaveProperty("skills");
    });

    it("omits skills field when installedSlugs is undefined", () => {
      const config = createConfig();
      const env = createEnv();
      const compiled = compileOpenClawConfig(config, env);
      expect(compiled.agents.list[0]).not.toHaveProperty("skills");
    });

    it("assigns same skills to all active agents", () => {
      const now = new Date().toISOString();
      const config = createConfig({
        bots: [
          {
            id: "bot-1",
            name: "Bot A",
            slug: "bot-a",
            poolId: null,
            status: "active",
            modelId: "anthropic/claude-sonnet-4",
            systemPrompt: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "bot-2",
            name: "Bot B",
            slug: "bot-b",
            poolId: null,
            status: "active",
            modelId: "anthropic/claude-sonnet-4",
            systemPrompt: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      const env = createEnv();
      const compiled = compileOpenClawConfig(config, env, undefined, [
        "calendar",
      ]);
      expect(compiled.agents.list).toHaveLength(2);
      expect(compiled.agents.list[0].skills).toEqual(["calendar"]);
      expect(compiled.agents.list[1].skills).toEqual(["calendar"]);
    });
  });

  describe("per-agent workspace skill merge", () => {
    it("merges shared and workspace skills for each agent", () => {
      const now = new Date().toISOString();
      const config = createConfig({
        bots: [
          {
            id: "bot-1",
            name: "Bot A",
            slug: "bot-a",
            poolId: null,
            status: "active",
            modelId: "anthropic/claude-sonnet-4",
            systemPrompt: null,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: "bot-2",
            name: "Bot B",
            slug: "bot-b",
            poolId: null,
            status: "active",
            modelId: "anthropic/claude-sonnet-4",
            systemPrompt: null,
            createdAt: now,
            updatedAt: now,
          },
        ],
      });
      const wsMap = new Map<string, readonly string[]>([
        ["bot-1", ["agent-tool"]],
      ]);
      const compiled = compileOpenClawConfig(
        config,
        createEnv(),
        undefined,
        ["shared-skill"],
        wsMap,
      );

      const botA = compiled.agents.list.find((a) => a.id === "bot-1");
      expect(botA?.skills).toEqual(
        expect.arrayContaining(["shared-skill", "agent-tool"]),
      );
      expect(botA?.skills).toHaveLength(2);

      const botB = compiled.agents.list.find((a) => a.id === "bot-2");
      expect(botB?.skills).toEqual(["shared-skill"]);
    });

    it("sorts merged skills deterministically regardless of input order", () => {
      const baseConfig = createConfig();
      const baseBot = baseConfig.bots[0];
      if (!baseBot) {
        throw new Error("expected base config bot");
      }
      const config = createConfig({
        bots: [
          {
            ...baseBot,
            id: "bot-a",
            slug: "bot-a",
          },
        ],
        channels: [],
      });

      const compiled = compileOpenClawConfig(
        config,
        createEnv(),
        undefined,
        ["zeta", "alpha", "shared-skill"],
        new Map([["bot-a", ["workspace-z", "alpha", "workspace-a"]]]),
      );

      expect(compiled.agents.list[0]?.skills).toEqual([
        "alpha",
        "shared-skill",
        "workspace-a",
        "workspace-z",
        "zeta",
      ]);
    });

    it("deduplicates when same slug in shared and workspace", () => {
      const config = createConfig();
      const wsMap = new Map<string, readonly string[]>([
        ["bot-1", ["shared-skill"]],
      ]);
      const compiled = compileOpenClawConfig(
        config,
        createEnv(),
        undefined,
        ["shared-skill"],
        wsMap,
      );
      const agent = compiled.agents.list[0];
      expect(agent.skills).toEqual(["shared-skill"]);
    });

    it("workspace-only skills still activate allowlist", () => {
      const config = createConfig();
      const wsMap = new Map<string, readonly string[]>([
        ["bot-1", ["ws-only"]],
      ]);
      const compiled = compileOpenClawConfig(
        config,
        createEnv(),
        undefined,
        [],
        wsMap,
      );
      expect(compiled.agents.list[0].skills).toEqual(["ws-only"]);
    });

    it("omits skills when both shared and workspace are empty", () => {
      const config = createConfig();
      const wsMap = new Map<string, readonly string[]>();
      const compiled = compileOpenClawConfig(
        config,
        createEnv(),
        undefined,
        [],
        wsMap,
      );
      expect(compiled.agents.list[0]).not.toHaveProperty("skills");
    });
  });

  it("remaps openai models to OAuth provider ids when persisted OAuth state is connected", () => {
    const baseConfig = createConfig();
    const baseBot = baseConfig.bots[0];
    if (!baseBot) {
      throw new Error("expected base config fixtures");
    }
    const oauthState: OAuthConnectionState = {
      connectedProviderIds: ["openai"],
    };
    // Use canonical models.providers so resolveModelId can find the "openai"
    // descriptor and apply the OAUTH_PROVIDER_MAP remap (openai → openai-codex).
    // Legacy config.providers is not read by the compiler.
    const result = compileOpenClawConfig(
      createConfig({
        bots: [
          {
            ...baseBot,
            modelId: "openai/gpt-5.4",
          },
        ],
        runtime: {
          gateway: {
            port: 18789,
            bind: "loopback",
            authMode: "token",
          },
          defaultModelId: "openai/gpt-5.4",
        },
        providers: [],
        models: {
          mode: "merge",
          providers: {
            openai: {
              enabled: true,
              // No apiKey (OAuth flow) — auth left unset so schema doesn't
              // require apiKey; provider still appears in descriptor list.
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.4",
                  name: "gpt-5.4",
                  reasoning: false,
                  input: ["text"],
                  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          } as unknown as Record<string, unknown>,
        } as unknown as NexuConfig["models"],
        desktop: {},
      }),
      createEnv(),
      oauthState,
    );

    expect(result.agents.defaults?.model).toEqual({
      primary: "openai-codex/gpt-5.4",
    });
    expect(result.agents.list[0]?.model).toEqual({
      primary: "openai-codex/gpt-5.4",
    });
  });

  it("omits empty apiKey fields for oauth-backed providers in compiled models config", () => {
    const result = compileOpenClawConfig(
      createConfig({
        providers: [],
        models: {
          mode: "merge",
          providers: {
            openai: {
              enabled: true,
              auth: "oauth",
              api: "openai-completions",
              apiKey: null,
              oauthProfileRef: "openai-codex",
              baseUrl: "https://api.openai.com/v1",
              models: [
                {
                  id: "gpt-5.4",
                  name: "GPT-5.4",
                  reasoning: false,
                  input: ["text"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 0,
                  maxTokens: 0,
                },
              ],
            },
          },
        },
        desktop: {
          selectedModelId: null,
        },
      }),
      createEnv(),
    );

    expect(result.models?.providers.openai).toBeDefined();
    expect(result.models?.providers.openai).not.toHaveProperty("apiKey");
    expect(result.models?.providers.openai?.models[0]?.id).toBe("gpt-5.4");
  });

  it("compiles Bedrock with AWS SDK auth without emitting legacy discovery", () => {
    const result = compileOpenClawConfig(
      createConfig({
        models: {
          mode: "merge",
          bedrockDiscovery: {
            enabled: true,
            region: "us-west-2",
            providerFilter: ["anthropic"],
          },
          providers: {
            "amazon-bedrock": {
              enabled: true,
              auth: "aws-sdk",
              api: "bedrock-converse-stream",
              baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
              models: [
                {
                  id: "us.anthropic.claude-opus-4-6-v1:0",
                  name: "Claude Opus 4.6 (Bedrock)",
                  reasoning: true,
                  input: ["text", "image"],
                  cost: {
                    input: 0,
                    output: 0,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                  contextWindow: 200_000,
                  maxTokens: 8_192,
                },
              ],
            },
          },
        },
      }),
      createEnv(),
    );

    expect(result.models).not.toHaveProperty("bedrockDiscovery");
    expect(result.models?.providers["amazon-bedrock"]).toMatchObject({
      auth: "aws-sdk",
      api: "bedrock-converse-stream",
      baseUrl: "https://bedrock-runtime.us-west-2.amazonaws.com",
      models: [
        expect.objectContaining({
          id: "us.anthropic.claude-opus-4-6-v1:0",
          contextWindow: 200_000,
          maxTokens: 8_192,
        }),
      ],
    });
    expect(result.models?.providers["amazon-bedrock"]?.apiKey).toBeUndefined();
    expect(result.plugins.allow).toBeUndefined();
    expect(result.plugins.entries["amazon-bedrock"]).toEqual({
      enabled: true,
      config: {
        discovery: {
          enabled: true,
          region: "us-west-2",
          providerFilter: ["anthropic"],
        },
      },
    });
  });
});

/**
 * Regression guard for the packaged-app control UI 503: the launchd path
 * passes the real `<pkg>/dist/extensions` layout, and the old derivation
 * appended another "dist", producing `<pkg>/dist/dist/control-ui`.
 */
describe("resolveControlUiRoot", () => {
  it("maps the packaged dist/extensions layout to dist/control-ui", () => {
    expect(
      resolveControlUiRoot("/app/node_modules/openclaw/dist/extensions"),
    ).toBe("/app/node_modules/openclaw/dist/control-ui");
  });

  it("maps the legacy package-root extensions layout to dist/control-ui", () => {
    expect(resolveControlUiRoot("/app/node_modules/openclaw/extensions")).toBe(
      "/app/node_modules/openclaw/dist/control-ui",
    );
  });

  it("is wired into the compiled gateway config", () => {
    const result = compileOpenClawConfig(
      createConfig(),
      createEnv({
        openclawBuiltinExtensionsDir:
          "/app/node_modules/openclaw/dist/extensions",
      }),
    );

    expect(result.gateway.controlUi?.root).toBe(
      "/app/node_modules/openclaw/dist/control-ui",
    );
  });
});

describe("compileOpenClawConfig > workboard (teams) gating", () => {
  it("omits the workboard plugin when no teams exist (hasTeams unset)", () => {
    const result = compileOpenClawConfig(createConfig(), createEnv());
    expect(result.plugins?.allow).toBeUndefined();
    expect(result.plugins?.entries?.workboard).toBeUndefined();
  });

  it("enables the workboard plugin when hasTeams is true", () => {
    const result = compileOpenClawConfig(
      createConfig(),
      createEnv(),
      undefined,
      undefined,
      undefined,
      true,
    );
    expect(result.plugins?.allow).toBeUndefined();
    expect(result.plugins?.entries?.workboard).toEqual({ enabled: true });
  });
});
