import { selectPreferredModel } from "@nexu/shared";
import { describe, expect, it } from "vitest";
import type { ControllerEnv } from "#controller/app/env";
import {
  compileOpenClawConfig,
  resolveModelId,
} from "#controller/lib/openclaw-config-compiler";
import type { NexuConfig } from "#controller/store/schemas";

function createEnv(): ControllerEnv {
  return {
    nodeEnv: "test",
    port: 3010,
    host: "127.0.0.1",
    webUrl: "http://localhost:5173",
    nexuCloudUrl: "https://nexu.io",
    nexuLinkUrl: null,
    nexuHomeDir: "/tmp/nexu-home",
    nexuConfigPath: "/tmp/nexu-home/config.json",
    artifactsIndexPath: "/tmp/nexu-home/artifacts/index.json",
    compiledOpenclawSnapshotPath: "/tmp/nexu-home/compiled-openclaw.json",
    openclawStateDir: "/tmp/nexu-home/runtime/openclaw/state",
    openclawConfigPath: "/tmp/nexu-home/runtime/openclaw/openclaw.json",
    openclawSkillsDir: "/tmp/nexu-home/runtime/openclaw/state/skills",
    userSkillsDir: "/tmp/.agents/skills",
    openclawExtensionsDir: "/tmp/nexu-home/runtime/openclaw/state/extensions",
    runtimePluginTemplatesDir: "/tmp/nexu-home/runtime-plugins",
    openclawRuntimeModelStatePath:
      "/tmp/nexu-home/runtime/openclaw/state/nexu-runtime-model.json",
    skillhubCacheDir: "/tmp/nexu-home/skillhub-cache",
    skillDbPath: "/tmp/nexu-home/skill-ledger.json",
    staticSkillsDir: undefined,
    platformTemplatesDir: undefined,
    openclawWorkspaceTemplatesDir:
      "/tmp/nexu-home/runtime/openclaw/state/workspace-templates",
    openclawBin: "openclaw",
    litellmBaseUrl: null,
    litellmApiKey: null,
    openclawGatewayPort: 18789,
    openclawGatewayToken: undefined,
    manageOpenclawProcess: false,
    gatewayProbeEnabled: true,
    runtimeSyncIntervalMs: 2000,
    runtimeHealthIntervalMs: 5000,
    defaultModelId: "anthropic/claude-sonnet-4",
  };
}

function createBaseConfig(): NexuConfig {
  return {
    $schema: "https://nexu.io/config.json",
    schemaVersion: 1,
    app: {},
    bots: [
      {
        id: "bot_1",
        name: "Bot One",
        slug: "bot-one",
        systemPrompt: null,
        modelId: "anthropic/claude-sonnet-4",
        status: "active",
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
      },
    ],
    runtime: {
      gateway: {
        port: 18789,
        bind: "loopback",
        authMode: "none",
      },
      defaultModelId: "anthropic/claude-sonnet-4",
    },
    models: {
      mode: "merge",
      providers: {},
    },
    providers: [],
    integrations: [],
    channels: [],
    templates: {},
    desktop: {},
    deviceControl: {
      enabled: false,
      wsPort: 18790,
      rpcPort: 18801,
    },
    secrets: {},
  };
}

describe("compileOpenClawConfig", () => {
  it("does not cap an agent run below what a device workflow needs", () => {
    const compiled = compileOpenClawConfig(createBaseConfig(), createEnv());

    // agents.defaults.timeoutSeconds is a wall-clock ceiling on a whole run,
    // not a per-LLM-call timeout. It was once 900s, which killed healthy runs
    // that were still making progress: a phone step takes 25-75s, so browsing
    // 30 posts passes 15 minutes by construction. Detecting a hung run belongs
    // to the stalled-session watchdog, which measures lack of progress.
    const timeoutSeconds = (
      compiled.agents?.defaults as Record<string, unknown> | undefined
    )?.timeoutSeconds;
    expect(typeof timeoutSeconds).toBe("number");
    expect(timeoutSeconds as number).toBeGreaterThanOrEqual(60 * 60);
  });

  it("leaves nexu-browser as the only browser surface", () => {
    const compiled = compileOpenClawConfig(createBaseConfig(), createEnv());
    const entries = compiled.plugins?.entries as
      | Record<string, { enabled?: boolean }>
      | undefined;

    // OpenClaw bundles a `browser` tool whose "user" profile attaches to the
    // user's own signed-in Chrome — the capability nexu-browser deliberately
    // dropped. With both registered the agent preferred the bundled one and
    // browsed in Chrome instead of the panel the user watches.
    expect(entries?.browser?.enabled).toBe(false);
    expect(entries?.["nexu-browser"]?.enabled).toBe(true);
  });

  it("does not advertise web_search when no provider is configured", () => {
    const braveKey = process.env.BRAVE_API_KEY;
    process.env.BRAVE_API_KEY = undefined;
    // biome-ignore lint/performance/noDelete: env vars must be absent, not "undefined".
    delete process.env.BRAVE_API_KEY;
    try {
      const compiled = compileOpenClawConfig(createBaseConfig(), createEnv());
      // `enabled: true` with no provider still registers the tool, so the
      // agent picks it and every call fails at runtime.
      const search = (
        compiled.tools?.web as Record<string, unknown> | undefined
      )?.search as Record<string, unknown> | undefined;
      expect(search?.enabled).toBe(false);
      expect(search?.provider).toBeUndefined();
    } finally {
      if (braveKey !== undefined) process.env.BRAVE_API_KEY = braveKey;
    }
  });

  it("puts the stalled-session thresholds where OpenClaw reads them", () => {
    const compiled = compileOpenClawConfig(createBaseConfig(), createEnv());

    // OpenClaw reads these from top-level `diagnostics`. They were once nested
    // under agents.defaults.heartbeat, whose schema is strict and has no such
    // key — the gateway refused to start at all, and nothing caught it because
    // the value was still readable back out of the written JSON.
    expect(compiled.diagnostics?.stuckSessionAbortMs).toBe(20 * 60_000);
    expect(
      (compiled.agents?.defaults as Record<string, unknown> | undefined)
        ?.heartbeat,
    ).toBeUndefined();
  });

  it("does not emit Feishu/weixin plugin entries or channel accounts before first connect", () => {
    const compiled = compileOpenClawConfig(createBaseConfig(), createEnv());

    // Prewarm was removed: without a connected channel, no Feishu/lark/weixin
    // plugin entries or channel accounts are emitted.
    expect(compiled.plugins?.entries?.feishu).toBeUndefined();
    expect(compiled.plugins?.entries?.["openclaw-lark"]).toBeUndefined();
    expect(compiled.plugins?.entries?.["openclaw-weixin"]).toBeUndefined();
    expect(compiled.plugins?.allow).toBeUndefined();
    expect(compiled.plugins?.deny).toBeUndefined();
    expect(compiled.channels?.feishu).toBeUndefined();
    expect(compiled.bindings).toEqual([]);
  });

  it("enables Langfuse tracer by default and disables it when analytics is explicitly off", () => {
    const defaultCompiled = compileOpenClawConfig(
      createBaseConfig(),
      createEnv(),
    );

    expect(defaultCompiled.plugins?.allow).toBeUndefined();
    expect(defaultCompiled.plugins?.entries?.["langfuse-tracer"]).toEqual({
      enabled: true,
    });

    const disabledConfig = createBaseConfig();
    disabledConfig.desktop = {
      analyticsEnabled: false,
    };

    const disabledCompiled = compileOpenClawConfig(disabledConfig, createEnv());

    // Discovery remains open; only the managed entry flag changes.
    expect(disabledCompiled.plugins?.allow).toBeUndefined();
    expect(disabledCompiled.plugins?.entries?.["langfuse-tracer"]).toEqual({
      enabled: false,
    });
  });

  it("uses the real Feishu account once connected and does not keep the prewarm account", () => {
    const config = createBaseConfig();
    config.channels = [
      {
        id: "channel_1",
        botId: "bot_1",
        channelType: "feishu",
        accountId: "cli_real_account",
        status: "connected",
        teamName: null,
        appId: "cli_app_id",
        botUserId: null,
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
      },
    ];
    config.secrets = {
      "channel:channel_1:appId": "cli_app_id",
      "channel:channel_1:appSecret": "cli_app_secret",
      "channel:channel_1:connectionMode": "websocket",
    };

    const compiled = compileOpenClawConfig(config, createEnv());

    expect(compiled.plugins?.entries?.["openclaw-lark"]).toEqual({
      enabled: true,
    });
    expect(compiled.channels?.feishu?.accounts).toEqual({
      cli_real_account: {
        enabled: true,
        appId: "cli_app_id",
        appSecret: "cli_app_secret",
        connectionMode: "websocket",
        dmPolicy: "open",
        groupPolicy: "open",
        allowFrom: ["*"],
      },
    });
    expect(compiled.bindings).toEqual([
      {
        agentId: "bot_1",
        match: {
          channel: "feishu",
          accountId: "cli_real_account",
        },
      },
    ]);
  });

  it("drops the Feishu channel entirely after disconnect and clears bindings", () => {
    const config = createBaseConfig();
    config.channels = [
      {
        id: "channel_1",
        botId: "bot_1",
        channelType: "feishu",
        accountId: "cli_real_account",
        status: "disconnected",
        teamName: null,
        appId: "cli_app_id",
        botUserId: null,
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
      },
    ];
    config.secrets = {
      "channel:channel_1:appId": "cli_app_id",
      "channel:channel_1:appSecret": "cli_app_secret",
      "channel:channel_1:connectionMode": "websocket",
    };

    const compiled = compileOpenClawConfig(config, createEnv());

    // Disconnected channels are dropped entirely (prewarm removal in
    // commit 80e68d98a); the account is no longer kept in a disabled state.
    expect(compiled.channels?.feishu).toBeUndefined();
    expect(compiled.bindings).toEqual([]);
  });

  it("keeps openclaw-weixin plugin entry stable when a wechat channel exists", () => {
    const config = createBaseConfig();
    config.channels = [
      {
        id: "channel_1",
        botId: "bot_1",
        channelType: "wechat",
        accountId: "wx_account_1",
        status: "connected",
        teamName: null,
        appId: null,
        botUserId: null,
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
      },
    ];

    const compiled = compileOpenClawConfig(config, createEnv());

    expect(compiled.plugins?.entries?.["openclaw-weixin"]).toEqual({
      enabled: true,
    });
    expect(compiled.channels?.["openclaw-weixin"]).toEqual({
      enabled: true,
      accounts: {
        wx_account_1: {
          enabled: true,
        },
      },
    });
    expect(compiled.bindings).toEqual([
      {
        agentId: "bot_1",
        match: {
          channel: "openclaw-weixin",
          accountId: "wx_account_1",
        },
      },
    ]);
  });

  it("does not silently rewrite the default model to the first Link model", () => {
    const config = createBaseConfig();
    config.desktop = {
      cloud: {
        connected: true,
        polling: false,
        userName: null,
        userEmail: null,
        connectedAt: null,
        linkUrl: "https://nexu-link.powerformer.net",
        apiKey: "test-key",
        models: [
          {
            id: "gemini-3.1-pro-preview",
            name: "Gemini 3.1 Pro Preview",
          },
        ],
      },
    };

    const compiled = compileOpenClawConfig(config, createEnv());

    expect(compiled.agents?.defaults?.model?.primary).toBe(
      "anthropic/claude-sonnet-4",
    );
    expect(compiled.models?.providers?.link?.models).toHaveLength(1);
    expect(compiled.models?.providers?.link?.models[0]?.id).toBe(
      "gemini-3.1-pro-preview",
    );
    expect(compiled.models?.providers?.link?.models[0]?.name).toBe(
      "Gemini 3.1 Pro Preview",
    );
  });

  it("maps runtime model refs onto available Link inventory", () => {
    const config = createBaseConfig();
    config.desktop = {
      cloud: {
        connected: true,
        polling: false,
        userName: null,
        userEmail: null,
        connectedAt: null,
        linkUrl: "https://nexu-link.powerformer.net",
        apiKey: "test-key",
        models: [
          {
            id: "claude-sonnet-4",
            name: "claude-sonnet-4",
          },
        ],
      },
    };

    expect(
      resolveModelId(config, createEnv(), "anthropic/claude-sonnet-4"),
    ).toBe("link/claude-sonnet-4");
  });

  it("prefers an actually available runtime model when the default is unavailable", () => {
    const availableModels = [
      { id: "link/claude-sonnet-4-6", name: "claude-sonnet-4-6" },
      { id: "link/gemini-3.1-pro-preview", name: "gemini-3.1-pro-preview" },
    ];

    expect(selectPreferredModel(availableModels)?.id).toBe(
      "link/gemini-3.1-pro-preview",
    );
  });

  it("compiles ollama providers with the native ollama API", () => {
    const config = createBaseConfig();
    config.models = {
      mode: "merge",
      providers: {
        ollama: {
          enabled: true,
          displayName: "Ollama",
          baseUrl: "http://127.0.0.1:11434",
          auth: "api-key",
          api: "ollama",
          apiKey: "ollama-local",
          models: [
            {
              id: "qwen2.5-coder:7b",
              name: "qwen2.5-coder:7b",
              api: "ollama",
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
    };
    config.providers = [
      {
        id: "provider_ollama",
        providerId: "ollama",
        displayName: "Ollama",
        enabled: true,
        baseUrl: "http://127.0.0.1:11434",
        authMode: "apiKey",
        apiKey: "ollama-local",
        oauthRegion: null,
        oauthCredential: null,
        models: ["qwen2.5-coder:7b"],
        createdAt: "2026-03-21T00:00:00.000Z",
        updatedAt: "2026-03-21T00:00:00.000Z",
      },
    ];

    const compiled = compileOpenClawConfig(config, createEnv());

    expect(compiled.models?.providers?.ollama).toEqual({
      baseUrl: "http://127.0.0.1:11434",
      apiKey: "ollama-local",
      api: "ollama",
      models: [
        expect.objectContaining({
          id: "qwen2.5-coder:7b",
          name: "qwen2.5-coder:7b",
        }),
      ],
    });
  });

  /**
   * The StepFun realtime plugin is configured entirely from the Tabby cloud
   * connection — the user never handles a provider key. Pin the derivation:
   * the failure mode is silent, since a wrong URL or a missing entry only makes
   * the voice button disappear with no error surfaced anywhere.
   */
  describe("stepfun realtime plugin", () => {
    function cloudWith(models: Array<{ id: string; name: string }>) {
      return {
        connected: true,
        polling: false,
        userName: null,
        userEmail: null,
        connectedAt: null,
        linkUrl: "https://nexu-link.powerformer.net",
        apiKey: "test-key",
        models,
      };
    }

    it("derives the ws endpoint and reuses the cloud credential", () => {
      const config = createBaseConfig();
      config.desktop = {
        cloud: cloudWith([
          { id: "gemini-3.1-pro-preview", name: "Gemini" },
          { id: "tabby-audio", name: "tabby-audio" },
        ]),
      };

      const entry = compileOpenClawConfig(config, createEnv()).plugins
        ?.entries?.["nexu-stepfun-realtime"];

      expect(entry?.enabled).toBe(true);
      expect(entry?.config).toEqual({
        apiKey: "test-key",
        // https -> wss, and the REST `/v1` base becomes the realtime socket.
        url: "wss://nexu-link.powerformer.net/v1/realtime",
        model: "tabby-audio",
      });
    });

    it("also accepts a vendor-named realtime id for direct deployments", () => {
      const config = createBaseConfig();
      config.desktop = {
        cloud: cloudWith([
          { id: "stepaudio-3-realtime-preview", name: "StepAudio 3 Realtime" },
        ]),
      };
      const entry = compileOpenClawConfig(config, createEnv()).plugins
        ?.entries?.["nexu-stepfun-realtime"];
      expect(entry?.config?.model).toBe("stepaudio-3-realtime-preview");
    });

    it("does not mistake a sibling tabby-audio-* model for realtime", () => {
      const config = createBaseConfig();
      config.desktop = {
        cloud: cloudWith([{ id: "tabby-audio-tts", name: "tabby-audio-tts" }]),
      };
      expect(
        compileOpenClawConfig(config, createEnv()).plugins?.entries?.[
          "nexu-stepfun-realtime"
        ],
      ).toBeUndefined();
    });

    it("stays absent when the account exposes no realtime model", () => {
      const config = createBaseConfig();
      config.desktop = {
        cloud: cloudWith([
          { id: "tabby-ultra", name: "tabby-ultra" },
          { id: "tabby-video", name: "tabby-video" },
        ]),
      };
      expect(
        compileOpenClawConfig(config, createEnv()).plugins?.entries?.[
          "nexu-stepfun-realtime"
        ],
      ).toBeUndefined();
    });

    it("stays absent when cloud is not connected", () => {
      const config = createBaseConfig();
      expect(
        compileOpenClawConfig(config, createEnv()).plugins?.entries?.[
          "nexu-stepfun-realtime"
        ],
      ).toBeUndefined();
    });

    it("follows a renamed realtime model instead of a pinned preview id", () => {
      const config = createBaseConfig();
      config.desktop = {
        cloud: cloudWith([{ id: "stepaudio-4-realtime", name: "StepAudio 4" }]),
      };
      const entry = compileOpenClawConfig(config, createEnv()).plugins
        ?.entries?.["nexu-stepfun-realtime"];
      expect(entry?.config?.model).toBe("stepaudio-4-realtime");
    });
  });
});
