import { type ModelProviderConfig, selectPreferredModel } from "@nexu/shared";
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

  it("uses runtime-owned watchdog thresholds without retired config keys", () => {
    const compiled = compileOpenClawConfig(createBaseConfig(), createEnv());

    expect(compiled.diagnostics?.enabled).toBe(true);
    expect(compiled.diagnostics).not.toHaveProperty("stuckSessionAbortMs");
    expect(compiled.diagnostics).not.toHaveProperty("stuckSessionWarnMs");
    expect(compiled.agents.defaults?.heartbeat).toEqual({ agentId: "bot_1" });
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

    function stepfunProvider(
      overrides: Partial<ModelProviderConfig> = {},
    ): ModelProviderConfig {
      return {
        enabled: true,
        auth: "api-key",
        apiKey: "direct-stepfun-key",
        baseUrl: "https://api.stepfun.com/step_plan/v1/",
        models: [
          {
            id: "stepaudio-2.5-realtime",
            name: "StepAudio Realtime",
            reasoning: false,
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 0,
            maxTokens: 0,
          },
        ],
        ...overrides,
      };
    }

    it.each(["api.stepfun.com", "api.stepfun.ai"])(
      "prefers configured realtime BYOK on %s over the cloud alias",
      (host) => {
        const config = createBaseConfig();
        config.desktop.cloud = cloudWith([
          { id: "tabby-audio", name: "Tabby Audio" },
        ]);
        config.models.providers.stepfun = stepfunProvider({
          baseUrl: `https://${host}/step_plan/v1/?ignored=true`,
        });

        const entry = compileOpenClawConfig(config, createEnv()).plugins
          ?.entries?.["nexu-stepfun-realtime"];

        expect(entry?.enabled).toBe(true);
        expect(entry?.config).toEqual({
          apiKey: "direct-stepfun-key",
          url: `wss://${host}/v1/realtime`,
          model: "stepaudio-2.5-realtime",
        });
      },
    );

    it("uses the configured realtime model without requiring cloud login", () => {
      const config = createBaseConfig();
      const provider = stepfunProvider();
      provider.models[0].id = "stepaudio-4-realtime";
      config.models.providers.stepfun = provider;

      const entry = compileOpenClawConfig(config, createEnv()).plugins
        ?.entries?.["nexu-stepfun-realtime"];

      expect(entry?.config?.model).toBe("stepaudio-4-realtime");
    });

    it.each(["global", "cn"] as const)(
      "keeps the realtime origin stable for the %s provider region",
      (oauthRegion) => {
        const config = createBaseConfig();
        config.models.providers.stepfun = stepfunProvider({ oauthRegion });

        const entry = compileOpenClawConfig(config, createEnv()).plugins
          ?.entries?.["nexu-stepfun-realtime"];

        expect(entry?.config?.url).toBe("wss://api.stepfun.com/v1/realtime");
      },
    );

    const unavailableDirectProviders: Array<
      [string, Partial<ModelProviderConfig>]
    > = [
      ["disabled", { enabled: false }],
      ["missing key", { apiKey: undefined }],
      ["blank key", { apiKey: " " }],
      [
        "SecretRef key",
        {
          apiKey: { source: "env", provider: "default", id: "STEPFUN_API_KEY" },
        },
      ],
      ["no configured realtime model", { models: [] }],
      ["custom proxy", { baseUrl: "https://proxy.example.com/v1" }],
      ["custom StepFun port", { baseUrl: "https://api.stepfun.com:8443/v1" }],
      ["untrusted hostname", { baseUrl: "https://api.stepfun.com.example/v1" }],
      ["HTTP endpoint", { baseUrl: "http://api.stepfun.com/v1" }],
      ["invalid URL", { baseUrl: "invalid-url" }],
      [
        "TTS model",
        {
          models: stepfunProvider().models.map((model) => ({
            ...model,
            id: "stepaudio-tts-realtime",
          })),
        },
      ],
    ];

    it.each(unavailableDirectProviders)(
      "retains the cloud fallback for a provider with %s",
      (_reason, overrides) => {
        const config = createBaseConfig();
        config.desktop.cloud = cloudWith([
          { id: "tabby-audio", name: "Tabby Audio" },
        ]);
        config.models.providers.stepfun = stepfunProvider(overrides);

        const entry = compileOpenClawConfig(config, createEnv()).plugins
          ?.entries?.["nexu-stepfun-realtime"];

        expect(entry?.config).toEqual({
          apiKey: "test-key",
          url: "wss://nexu-link.powerformer.net/v1/realtime",
          model: "tabby-audio",
        });
      },
    );

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
