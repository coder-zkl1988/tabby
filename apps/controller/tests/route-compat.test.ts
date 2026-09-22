import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerContainer } from "../src/app/container.js";
import { createApp } from "../src/app/create-app.js";
import type { ControllerEnv } from "../src/app/env.js";
import * as proxyFetchModule from "../src/lib/proxy-fetch.js";
import { ControlPlaneHealthService } from "../src/runtime/control-plane-health.js";
import { CreditGuardStateWriter } from "../src/runtime/credit-guard-state-writer.js";
import { OpenClawAuthProfilesStore } from "../src/runtime/openclaw-auth-profiles-store.js";
import { OpenClawAuthProfilesWriter } from "../src/runtime/openclaw-auth-profiles-writer.js";
import { OpenClawConfigWriter } from "../src/runtime/openclaw-config-writer.js";
import { OpenClawProcessManager } from "../src/runtime/openclaw-process.js";
import { OpenClawWatchTrigger } from "../src/runtime/openclaw-watch-trigger.js";
import { SessionsRuntime } from "../src/runtime/sessions-runtime.js";
import { OpenClawRuntimeModelWriter } from "../src/runtime/slimclaw-runtime-model-writer.js";
import { OpenClawRuntimePluginWriter } from "../src/runtime/slimclaw-runtime-plugin-writer.js";
import { createRuntimeState } from "../src/runtime/state.js";
import { WorkspaceTemplateWriter } from "../src/runtime/workspace-template-writer.js";
import { AgentService } from "../src/services/agent-service.js";
import { ArtifactService } from "../src/services/artifact-service.js";
import { ChannelFallbackService } from "../src/services/channel-fallback-service.js";
import { ChannelService } from "../src/services/channel-service.js";
import { DesktopLocalService } from "../src/services/desktop-local-service.js";
import { IntegrationService } from "../src/services/integration-service.js";
import { LocalAutomationService } from "../src/services/local-automation-service.js";
import { LocalUserService } from "../src/services/local-user-service.js";
import { ModelProviderService } from "../src/services/model-provider-service.js";
import { OpenClawAuthService } from "../src/services/openclaw-auth-service.js";
import { OpenClawGatewayService } from "../src/services/openclaw-gateway-service.js";
import { OpenClawSyncService } from "../src/services/openclaw-sync-service.js";
import { RuntimeConfigService } from "../src/services/runtime-config-service.js";
import { RuntimeModelStateService } from "../src/services/runtime-model-state-service.js";
import { ScheduleWorkspaceWriter } from "../src/services/schedule-workspace-writer.js";
import { SessionService } from "../src/services/session-service.js";
import type { SkillhubService } from "../src/services/skillhub-service.js";
import { TemplateService } from "../src/services/template-service.js";
import { ArtifactsStore } from "../src/store/artifacts-store.js";
import { CompiledOpenClawStore } from "../src/store/compiled-openclaw-store.js";
import { NexuConfigStore } from "../src/store/nexu-config-store.js";

async function createTestContainer(
  rootDir: string,
): Promise<ControllerContainer> {
  const env: ControllerEnv = {
    nodeEnv: "test",
    port: 3010,
    host: "127.0.0.1",
    webUrl: "http://localhost:5173",
    nexuCloudUrl: "https://nexu.io",
    nexuLinkUrl: "https://link.nexu.io",
    nexuHomeDir: path.join(rootDir, ".nexu"),
    nexuConfigPath: path.join(rootDir, ".nexu", "config.json"),
    artifactsIndexPath: path.join(rootDir, ".nexu", "artifacts", "index.json"),
    compiledOpenclawSnapshotPath: path.join(
      rootDir,
      ".nexu",
      "compiled-openclaw.json",
    ),
    openclawStateDir: path.join(rootDir, ".openclaw"),
    openclawConfigPath: path.join(rootDir, ".openclaw", "openclaw.json"),
    openclawSkillsDir: path.join(rootDir, ".openclaw", "skills"),
    openclawExtensionsDir: path.join(rootDir, ".openclaw", "extensions"),
    runtimePluginTemplatesDir: path.join(rootDir, "runtime-plugins"),
    openclawCuratedSkillsDir: path.join(rootDir, ".openclaw", "bundled-skills"),
    openclawRuntimeModelStatePath: path.join(
      rootDir,
      ".openclaw",
      "nexu-runtime-model.json",
    ),
    creditGuardStatePath: path.join(
      rootDir,
      ".openclaw",
      "nexu-credit-guard-state.json",
    ),
    skillhubCacheDir: path.join(rootDir, ".nexu", "skillhub-cache"),
    skillDbPath: path.join(rootDir, ".nexu", "skill-ledger.json"),
    analyticsStatePath: path.join(rootDir, ".nexu", "analytics-state.json"),
    staticSkillsDir: undefined,
    platformTemplatesDir: undefined,
    openclawWorkspaceTemplatesDir: path.join(
      rootDir,
      ".openclaw",
      "workspace-templates",
    ),
    openclawBin: "openclaw",
    litellmBaseUrl: null,
    litellmApiKey: null,
    openclawGatewayPort: 18789,
    openclawGatewayToken: undefined,
    manageOpenclawProcess: false,
    gatewayProbeEnabled: false,
    runtimeSyncIntervalMs: 2000,
    runtimeHealthIntervalMs: 5000,
    defaultModelId: "anthropic/claude-sonnet-4",
    posthogApiKey: undefined,
    posthogHost: undefined,
  };

  const configStore = new NexuConfigStore(env);
  const artifactsStore = new ArtifactsStore(env);
  const compiledStore = new CompiledOpenClawStore(env);
  const configWriter = new OpenClawConfigWriter(env);
  const authProfilesStore = new OpenClawAuthProfilesStore(env);
  const authProfilesWriter = new OpenClawAuthProfilesWriter(authProfilesStore);
  const runtimePluginWriter = new OpenClawRuntimePluginWriter(env);
  const runtimeModelWriter = new OpenClawRuntimeModelWriter(env);
  const creditGuardStateWriter = new CreditGuardStateWriter(env);
  const templateWriter = new WorkspaceTemplateWriter(env);
  const scheduleWorkspaceWriter = new ScheduleWorkspaceWriter(env);
  const watchTrigger = new OpenClawWatchTrigger(env);
  const sessionsRuntime = new SessionsRuntime(env);
  const openclawProcess = new OpenClawProcessManager(env);
  const runtimeState = createRuntimeState();
  const wsClient = {
    isConnected: () => false,
    stop: vi.fn(),
  } as unknown as ControllerContainer["wsClient"];
  const gatewayService = new OpenClawGatewayService({
    isConnected: () => false,
    request: vi.fn(),
  } as never);
  const controlPlaneHealth = new ControlPlaneHealthService(
    gatewayService,
    wsClient,
    runtimeState,
    openclawProcess,
  );
  const openclawSyncService = new OpenClawSyncService(
    env,
    configStore,
    compiledStore,
    configWriter,
    authProfilesWriter,
    authProfilesStore,
    runtimePluginWriter,
    runtimeModelWriter,
    creditGuardStateWriter,
    templateWriter,
    scheduleWorkspaceWriter,
    watchTrigger,
    gatewayService,
  );
  const modelProviderService = new ModelProviderService(
    configStore,
    env.nodeEnv,
  );
  const runtimeModelStateService = new RuntimeModelStateService(env);
  const channelFallbackService = new ChannelFallbackService(
    openclawProcess,
    gatewayService,
    { getLocale: async () => "en" as const },
  );
  const skillhubService = {
    catalog: {
      getCatalog: () => ({
        skills: [],
        installedSlugs: [],
        installedSkills: [],
        meta: null,
      }),
      installSkill: vi.fn(async () => ({ ok: true })),
      uninstallSkill: vi.fn(async () => ({ ok: true })),
      refreshCatalog: vi.fn(async () => ({ ok: true, skillCount: 0 })),
      importSkillZip: vi.fn(async () => ({ ok: true })),
    },
    dispose: vi.fn(),
    start: vi.fn(),
  } as unknown as SkillhubService;
  const openclawAuthService = new OpenClawAuthService(env, authProfilesStore);

  return {
    env,
    configStore,
    gatewayClient: {
      fetchJson: vi.fn(),
    } as unknown as ControllerContainer["gatewayClient"],
    controlPlaneHealth,
    openclawProcess,
    agentService: new AgentService(configStore, openclawSyncService),
    channelService: new ChannelService(
      env,
      configStore,
      openclawSyncService,
      gatewayService,
      openclawProcess,
      controlPlaneHealth,
      wsClient,
    ),
    channelFallbackService,
    sessionService: new SessionService(sessionsRuntime),
    runtimeConfigService: new RuntimeConfigService(
      configStore,
      openclawSyncService,
    ),
    runtimeModelStateService,
    modelProviderService,
    integrationService: new IntegrationService(configStore),
    localAutomationService: new LocalAutomationService(
      env,
      configStore,
      openclawSyncService,
      openclawProcess,
    ),
    localUserService: new LocalUserService(configStore),
    desktopLocalService: new DesktopLocalService(
      configStore,
      modelProviderService,
      openclawProcess,
    ),
    artifactService: new ArtifactService(artifactsStore),
    templateService: new TemplateService(configStore, openclawSyncService),
    skillhubService,
    openclawSyncService,
    openclawAuthService,
    quotaFallbackService: {
      triggerFallback: vi.fn(),
    } as never,
    githubStarVerificationService: {
      prepareSession: vi.fn(),
      verifySession: vi.fn(),
    } as never,
    wsClient,
    gatewayService,
    runtimeState,
    startBackgroundLoops: () => () => {},
  };
}

describe("controller route compatibility", () => {
  let rootDir = "";
  let container: ControllerContainer;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-controller-routes-"));
    container = await createTestContainer(rootDir);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(rootDir, { recursive: true, force: true });
  });

  it("serves local auth/user compatibility endpoints", async () => {
    const app = createApp(container);

    const meResponse = await app.request("/api/v1/me");
    expect(meResponse.status).toBe(200);
    const me = (await meResponse.json()) as { email: string };
    expect(me.email).toBe("desktop@nexu.local");
  });

  it("routes keyed-agent chat completions to the configured default or explicit agent", async () => {
    const firstBot = await container.configStore.createBot({
      name: "Alphabetically first",
      slug: "alpha",
    });
    const defaultBot = await container.configStore.createBot({
      name: "Desktop default",
      slug: "zulu",
    });
    await container.configStore.setDesktopDefaultBot(defaultBot.id);
    await mkdir(path.dirname(container.env.openclawConfigPath), {
      recursive: true,
    });
    await writeFile(
      container.env.openclawConfigPath,
      JSON.stringify({
        gateway: { auth: { mode: "none" } },
        agents: {
          ownership: "explicit",
          entries: {
            [firstBot.id]: { model: "custom/first" },
            [defaultBot.id]: { model: "custom/default" },
          },
        },
        models: {
          providers: {
            custom: {
              baseUrl: "https://model.example.test/v1",
              apiKey: "test-key",
              api: "openai-completions",
              models: [],
            },
          },
        },
        channels: {},
        bindings: [],
        plugins: {},
        skills: {},
        commands: {},
      }),
    );
    const completionFetch = vi
      .spyOn(proxyFetchModule, "proxyFetch")
      .mockImplementation(async () => new Response("data: [DONE]\n\n"));
    const app = createApp(container);

    for (const [requestedAgentId, expectedModel] of [
      [undefined, "default"],
      [firstBot.id, "first"],
      ["missing-agent", "default"],
    ] as const) {
      const response = await app.request("/v1/chat/completions", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(requestedAgentId
            ? { "x-openclaw-agent-id": requestedAgentId }
            : {}),
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "hello" }],
        }),
      });

      expect(response.status).toBe(200);
      expect(await response.text()).toContain("data: [DONE]");
      const request = completionFetch.mock.lastCall?.[1];
      expect(JSON.parse(String(request?.body))).toMatchObject({
        model: expectedModel,
      });
    }
  });

  it("rejects cross-site compatible automation POSTs without JSON", async () => {
    const app = createApp(container);
    const paths = [
      "/api/v1/runtime-config/local-automation/computer-use/permissions",
    ];

    for (const requestPath of paths) {
      const response = await app.request(requestPath, { method: "POST" });
      expect(response.status).toBe(415);
    }
  });

  it("rejects DNS rebinding hosts before local automation handlers", async () => {
    const permissionsSpy = vi
      .spyOn(container.localAutomationService, "requestComputerUsePermissions")
      .mockResolvedValue();
    const app = createApp(container);

    const response = await app.request(
      "http://evil.example/api/v1/runtime-config/local-automation/computer-use/permissions",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          host: "evil.example",
          origin: "http://evil.example",
        },
        body: "{}",
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("access-control-allow-origin")).toBeNull();
    expect(await response.text()).toBe("Forbidden");
    expect(permissionsSpy).not.toHaveBeenCalled();
  });

  it("admits the desktop shell's boot probe of the ready endpoint", async () => {
    // The file:// shell polls readiness with an opaque origin and cross-site
    // fetch metadata — exactly what the global guard rejects. Measured on CI:
    // gating it left the packaged app on the boot screen through every health
    // attempt while the endpoint answered ready:true to plain probes, because
    // the packaged web sidecar proxies the shell's headers here verbatim.
    const app = createApp(container);

    const probe = await app.request(
      "http://127.0.0.1:50800/api/internal/desktop/ready",
      {
        headers: {
          host: "127.0.0.1:50800",
          origin: "null",
          "sec-fetch-site": "cross-site",
        },
      },
    );
    // Not 403 is the assertion; the handler's own status is its business.
    expect(probe.status).not.toBe(403);

    // The exception is path-exact, method-exact, and never overrides the
    // loopback-host requirement.
    const evilHost = await app.request(
      "http://evil.example/api/internal/desktop/ready",
      { headers: { host: "evil.example" } },
    );
    expect(evilHost.status).toBe(403);
    const post = await app.request(
      "http://127.0.0.1:50800/api/internal/desktop/ready",
      {
        method: "POST",
        headers: {
          host: "127.0.0.1:50800",
          origin: "null",
          "sec-fetch-site": "cross-site",
        },
      },
    );
    expect(post.status).toBe(403);
  });

  it("supports channel connect, integration connect, session lifecycle, and runtime config routes", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("slack.com/api/auth.test")) {
          return new Response(
            JSON.stringify({
              ok: true,
              team_id: "T123",
              team: "Acme",
              bot_id: "B123",
            }),
            { status: 200 },
          );
        }
        if (url.includes("slack.com/api/bots.info")) {
          return new Response(
            JSON.stringify({ ok: true, bot: { app_id: "A123" } }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const bot = await container.configStore.createBot({
      name: "Test Bot",
      slug: "test-bot",
      modelId: "anthropic/claude-sonnet-4",
    });

    const app = createApp(container);

    const channelConnect = await app.request("/api/v1/channels/slack/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botToken: "xoxb-test",
        signingSecret: "secret",
        teamId: "T123",
        appId: "A123",
        botId: bot.id,
      }),
    });
    expect(channelConnect.status).toBe(200);

    const integrationConnect = await app.request(
      "/api/v1/integrations/connect",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          toolkitSlug: "openai",
          credentials: { apiKey: "sk-test" },
          source: "page",
        }),
      },
    );
    expect(integrationConnect.status).toBe(200);

    const createSession = await app.request("/api/internal/sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "bot-1",
        sessionKey: "s1",
        title: "Session 1",
      }),
    });
    expect(createSession.status).toBe(201);

    const listSessions = await app.request("/api/v1/sessions?limit=10");
    expect(listSessions.status).toBe(200);
    const sessionList = (await listSessions.json()) as {
      total: number;
      sessions: Array<{ id: string }>;
    };
    expect(sessionList.total).toBe(1);

    const resetSession = await app.request(
      `/api/v1/sessions/${sessionList.sessions[0]?.id}/reset`,
      {
        method: "POST",
      },
    );
    expect(resetSession.status).toBe(200);

    const runtimeUpdate = await app.request("/api/v1/runtime-config", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        gateway: { port: 18789, bind: "loopback", authMode: "none" },
        defaultModelId: "gpt-4o",
      }),
    });
    expect(runtimeUpdate.status).toBe(200);

    const importProfiles = await app.request(
      "/api/internal/desktop/cloud-profiles/import",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profiles: [
            {
              name: "Local Dev",
              cloudUrl: "http://localhost:5173",
              linkUrl: "http://localhost:8080",
            },
          ],
        }),
      },
    );
    expect(importProfiles.status).toBe(200);

    const switchProfile = await app.request(
      "/api/internal/desktop/cloud-profile/select",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Local Dev" }),
      },
    );
    expect(switchProfile.status).toBe(200);

    const createProfile = await app.request(
      "/api/internal/desktop/cloud-profile/create",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          profile: {
            name: "Manual Staging",
            cloudUrl: "https://staging.example.com",
            linkUrl: "https://link.staging.example.com",
          },
        }),
      },
    );
    expect(createProfile.status).toBe(200);

    const updateProfile = await app.request(
      "/api/internal/desktop/cloud-profile/update",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          previousName: "Local Dev",
          profile: {
            name: "Local QA",
            cloudUrl: "http://127.0.0.1:5173",
            linkUrl: "http://127.0.0.1:8080",
          },
        }),
      },
    );
    expect(updateProfile.status).toBe(200);

    const deleteProfile = await app.request(
      "/api/internal/desktop/cloud-profile/delete",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Local QA" }),
      },
    );
    expect(deleteProfile.status).toBe(200);
  });

  it("supports qqbot connect when the plugin is installed", async () => {
    await mkdir(
      path.join(container.env.openclawExtensionsDir, "openclaw-qqbot"),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(
        container.env.openclawExtensionsDir,
        "openclaw-qqbot",
        "openclaw.plugin.json",
      ),
      JSON.stringify({ id: "openclaw-qqbot", channels: ["qqbot"] }),
      "utf8",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("bots.qq.com/app/getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "qq-access-token" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const bot = await container.configStore.createBot({
      name: "QQ Bot",
      slug: "qq-bot",
      modelId: "anthropic/claude-sonnet-4",
    });

    const app = createApp(container);
    const response = await app.request("/api/v1/channels/qqbot/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: "123456",
        appSecret: "qq-secret",
        botId: bot.id,
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      channelType: string;
      appId?: string;
    };
    expect(payload.channelType).toBe("qqbot");
    expect(payload.appId).toBe("123456");
  });

  it("supports wecom connect when the plugin is installed", async () => {
    await mkdir(path.join(container.env.openclawExtensionsDir, "wecom"), {
      recursive: true,
    });
    await writeFile(
      path.join(
        container.env.openclawExtensionsDir,
        "wecom",
        "openclaw.plugin.json",
      ),
      JSON.stringify({ id: "wecom", channels: ["wecom"] }),
      "utf8",
    );

    const bot = await container.configStore.createBot({
      name: "WeCom Bot",
      slug: "wecom-bot",
      modelId: "anthropic/claude-sonnet-4",
    });

    const app = createApp(container);
    const response = await app.request("/api/v1/channels/wecom/connect", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "wecom-bot-123",
        secret: "wecom-secret",
        nexuBotId: bot.id,
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      channelType: string;
      appId?: string;
    };
    expect(payload.channelType).toBe("wecom");
    expect(payload.appId).toBe("wecom-bot-123");
  });

  it("supports wecom connectivity tests when the plugin is installed", async () => {
    await mkdir(path.join(container.env.openclawExtensionsDir, "wecom"), {
      recursive: true,
    });
    await writeFile(
      path.join(
        container.env.openclawExtensionsDir,
        "wecom",
        "openclaw.plugin.json",
      ),
      JSON.stringify({ id: "wecom", channels: ["wecom"] }),
      "utf8",
    );

    const bot = await container.configStore.createBot({
      name: "WeCom Bot",
      slug: "wecom-bot",
      modelId: "anthropic/claude-sonnet-4",
    });

    const app = createApp(container);
    const response = await app.request("/api/v1/channels/wecom/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        botId: "wecom-bot-123",
        secret: "wecom-secret",
        nexuBotId: bot.id,
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      message: string;
    };
    expect(payload.success).toBe(true);
    expect(payload.message).toContain("wecom-bot-123");
  });

  it("supports qqbot connectivity tests when the plugin is installed", async () => {
    await mkdir(
      path.join(container.env.openclawExtensionsDir, "openclaw-qqbot"),
      {
        recursive: true,
      },
    );
    await writeFile(
      path.join(
        container.env.openclawExtensionsDir,
        "openclaw-qqbot",
        "openclaw.plugin.json",
      ),
      JSON.stringify({ id: "openclaw-qqbot", channels: ["qqbot"] }),
      "utf8",
    );

    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const url = input.toString();
        if (url.includes("bots.qq.com/app/getAppAccessToken")) {
          return new Response(
            JSON.stringify({ access_token: "qq-access-token" }),
            { status: 200 },
          );
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    const bot = await container.configStore.createBot({
      name: "QQ Bot",
      slug: "qq-bot",
      modelId: "anthropic/claude-sonnet-4",
    });

    const app = createApp(container);
    const response = await app.request("/api/v1/channels/qqbot/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        appId: "123456",
        appSecret: "qq-secret",
        botId: bot.id,
      }),
    });

    expect(response.status).toBe(200);
    const payload = (await response.json()) as {
      success: boolean;
      message: string;
    };
    expect(payload.success).toBe(true);
    expect(payload.message).toContain("123456");
  });

  it("resolves qqbot live status via the default account id", async () => {
    // New qqbot channels always use accountId "default" (stored by
    // NexuConfigStore.connectQqbot via DEFAULT_MANAGED_CHANNEL_ACCOUNT_ID).
    // The legacy all-qqbot→"default" mapping in resolveOpenClawAccountId was
    // removed in 6ff1507b2; tests now use the current "default" accountId.
    const gatewayService = new OpenClawGatewayService({
      isConnected: () => true,
      request: vi.fn(async () => ({
        channelOrder: ["qqbot"],
        channels: {},
        channelAccounts: {
          qqbot: [
            {
              accountId: "default",
              enabled: true,
              configured: true,
              running: true,
              connected: true,
              lastError: null,
            },
          ],
        },
      })),
    } as never);

    const result = await gatewayService.getAllChannelsLiveStatus([
      {
        id: "qq-channel-1",
        channelType: "qqbot",
        accountId: "default",
      },
    ]);

    expect(result.gatewayConnected).toBe(true);
    expect(result.channels).toEqual([
      {
        channelType: "qqbot",
        channelId: "qq-channel-1",
        accountId: "default",
        status: "connected",
        ready: true,
        connected: true,
        running: true,
        configured: true,
        lastError: null,
      },
    ]);
  });

  it("does not expose the removed internal skill compatibility endpoints", async () => {
    const app = createApp(container);

    const latestSkills = await app.request("/api/internal/skills/latest");
    expect(latestSkills.status).toBe(404);

    const skillUpsert = await app.request(
      "/api/internal/skills/daily-standup",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "# Standup" }),
      },
    );
    expect(skillUpsert.status).toBe(404);
  });

  it("serves workspace template internal compatibility endpoints", async () => {
    const app = createApp(container);

    const templateUpsert = await app.request(
      "/api/internal/workspace-templates/AGENTS.md",
      {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ content: "hello" }),
      },
    );
    expect(templateUpsert.status).toBe(200);

    const latestTemplates = await app.request(
      "/api/internal/workspace-templates/latest",
    );
    expect(latestTemplates.status).toBe(200);
  });

  it("returns the default bot workspace path for desktop ready", async () => {
    const bot = await container.configStore.createBot({
      name: "nexu Assistant",
      slug: "nexu-assistant",
      modelId: "anthropic/claude-sonnet-4",
    });
    const app = createApp(container);

    const response = await app.request("/api/internal/desktop/ready");
    expect(response.status).toBe(200);

    const payload = (await response.json()) as { workspacePath: string };
    expect(payload.workspacePath).toBe(
      path.join(rootDir, ".openclaw", "agents", bot.id),
    );
  });

  it("serves desktop rewards status and claim routes (cloud proxy mode)", async () => {
    const app = createApp(container);

    // Without cloud connection, status returns empty fallback
    const statusResponse = await app.request("/api/internal/desktop/rewards");
    expect(statusResponse.status).toBe(200);
    const statusPayload = (await statusResponse.json()) as {
      tasks: Array<{ id: string; isClaimed: boolean }>;
      viewer: { cloudConnected: boolean; usingManagedModel: boolean };
      cloudBalance: null;
    };
    expect(statusPayload.tasks).toHaveLength(0);
    expect(statusPayload.viewer.cloudConnected).toBe(false);
    expect(statusPayload.viewer.usingManagedModel).toBe(false);
    expect(statusPayload.cloudBalance).toBeNull();

    // Without cloud connection, claim returns ok:false
    const claimResponse = await app.request(
      "/api/internal/desktop/rewards/claim",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ taskId: "daily_checkin" }),
      },
    );
    expect(claimResponse.status).toBe(200);
    const claimPayload = (await claimResponse.json()) as {
      ok: boolean;
      alreadyClaimed: boolean;
    };
    expect(claimPayload.ok).toBe(false);
    expect(claimPayload.alreadyClaimed).toBe(false);
  });
});
