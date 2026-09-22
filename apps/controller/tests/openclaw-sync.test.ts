import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import type { compileOpenClawConfig } from "../src/lib/openclaw-config-compiler.js";
import { CreditGuardStateWriter } from "../src/runtime/credit-guard-state-writer.js";
import { OpenClawAuthProfilesStore } from "../src/runtime/openclaw-auth-profiles-store.js";
import { OpenClawAuthProfilesWriter } from "../src/runtime/openclaw-auth-profiles-writer.js";
import { OpenClawConfigWriter } from "../src/runtime/openclaw-config-writer.js";
import { OpenClawWatchTrigger } from "../src/runtime/openclaw-watch-trigger.js";
import { OpenClawRuntimeModelWriter } from "../src/runtime/slimclaw-runtime-model-writer.js";
import { OpenClawRuntimePluginWriter } from "../src/runtime/slimclaw-runtime-plugin-writer.js";
import { WorkspaceTemplateWriter } from "../src/runtime/workspace-template-writer.js";
import type { OpenClawGatewayService } from "../src/services/openclaw-gateway-service.js";
import { OpenClawSyncService } from "../src/services/openclaw-sync-service.js";
import { ScheduleWorkspaceWriter } from "../src/services/schedule-workspace-writer.js";
import { SkillDb } from "../src/services/skillhub/skill-db.js";
import { CompiledOpenClawStore } from "../src/store/compiled-openclaw-store.js";
import { NexuConfigStore } from "../src/store/nexu-config-store.js";

describe("OpenClawSyncService", () => {
  let rootDir = "";
  let env: ControllerEnv;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-controller-sync-"));
    env = {
      nodeEnv: "test",
      port: 3010,
      host: "127.0.0.1",
      webUrl: "http://localhost:5173",
      nexuHomeDir: path.join(rootDir, ".nexu"),
      nexuConfigPath: path.join(rootDir, ".nexu", "config.json"),
      artifactsIndexPath: path.join(
        rootDir,
        ".nexu",
        "artifacts",
        "index.json",
      ),
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
      openclawCuratedSkillsDir: path.join(
        rootDir,
        ".openclaw",
        "bundled-skills",
      ),
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
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("writes compiled config and templates from controller state", async () => {
    const configStore = new NexuConfigStore(env);
    const compiledStore = new CompiledOpenClawStore(env);
    const authProfilesStore = new OpenClawAuthProfilesStore(env);
    const syncService = new OpenClawSyncService(
      env,
      configStore,
      compiledStore,
      new OpenClawConfigWriter(env),
      new OpenClawAuthProfilesWriter(authProfilesStore),
      authProfilesStore,
      new OpenClawRuntimePluginWriter(env),
      new OpenClawRuntimeModelWriter(env),
      new CreditGuardStateWriter(env),
      new WorkspaceTemplateWriter(env),
      new ScheduleWorkspaceWriter(env),
      new OpenClawWatchTrigger(env),
      {
        isConnected: () => false,
        shouldPushConfig: async () => false,
        noteConfigWritten: () => {},
      } as unknown as OpenClawGatewayService,
    );

    const bot = await configStore.createBot({
      name: "Assistant",
      slug: "assistant",
    });
    await configStore.connectSlack({
      botId: bot.id,
      botToken: "xoxb-test",
      signingSecret: "secret",
      teamId: "T123",
      appId: "A123",
      teamName: "Acme",
    });
    await syncService.syncAll();

    const config = JSON.parse(
      await readFile(env.openclawConfigPath, "utf8"),
    ) as ReturnType<typeof compileOpenClawConfig>;
    expect(Object.keys(config.agents.entries)).toHaveLength(1);
    expect(config.channels.slack?.accounts["slack-A123-T123"]?.botToken).toBe(
      "xoxb-test",
    );

    const snapshot = JSON.parse(
      await readFile(env.compiledOpenclawSnapshotPath, "utf8"),
    ) as { config: Record<string, unknown> };
    expect(snapshot.config).toBeTruthy();
  });

  it("includes installed skill slugs in compiled agent config", async () => {
    const configStore = new NexuConfigStore(env);
    const compiledStore = new CompiledOpenClawStore(env);
    const authProfilesStore = new OpenClawAuthProfilesStore(env);
    const skillDb = await SkillDb.create(env.skillDbPath);

    skillDb.recordInstall("web-search", "managed");
    skillDb.recordInstall("image-gen", "managed");

    const syncService = new OpenClawSyncService(
      env,
      configStore,
      compiledStore,
      new OpenClawConfigWriter(env),
      new OpenClawAuthProfilesWriter(authProfilesStore),
      authProfilesStore,
      new OpenClawRuntimePluginWriter(env),
      new OpenClawRuntimeModelWriter(env),
      new CreditGuardStateWriter(env),
      new WorkspaceTemplateWriter(env),
      new ScheduleWorkspaceWriter(env),
      new OpenClawWatchTrigger(env),
      {
        isConnected: () => false,
        shouldPushConfig: async () => false,
        noteConfigWritten: () => {},
      } as unknown as OpenClawGatewayService,
      skillDb,
    );

    const bot = await configStore.createBot({
      name: "Assistant",
      slug: "assistant",
    });
    await syncService.syncAllImmediate();

    const config = JSON.parse(
      await readFile(env.openclawConfigPath, "utf8"),
    ) as ReturnType<typeof compileOpenClawConfig>;

    expect(Object.keys(config.agents.entries)).toHaveLength(1);
    expect(config.agents.entries[bot.id].skills).toEqual(
      expect.arrayContaining(["web-search", "image-gen"]),
    );
    expect(config.agents.entries[bot.id].skills).toHaveLength(2);
  });

  function createSyncService(options: {
    gateway: {
      isConnected: () => boolean;
      shouldPushConfig: () => Promise<boolean>;
    };
    watchTrigger: { nudgeSkillsWatcher: (reason: string) => Promise<void> };
    skillDb?: SkillDb;
  }) {
    const configStore = new NexuConfigStore(env);
    const authProfilesStore = new OpenClawAuthProfilesStore(env);
    const syncService = new OpenClawSyncService(
      env,
      configStore,
      new CompiledOpenClawStore(env),
      new OpenClawConfigWriter(env),
      new OpenClawAuthProfilesWriter(authProfilesStore),
      authProfilesStore,
      new OpenClawRuntimePluginWriter(env),
      new OpenClawRuntimeModelWriter(env),
      new CreditGuardStateWriter(env),
      new WorkspaceTemplateWriter(env),
      new ScheduleWorkspaceWriter(env),
      {
        ...options.watchTrigger,
        touchConfig: async () => {},
      } as unknown as OpenClawWatchTrigger,
      {
        ...options.gateway,
        noteConfigWritten: () => {},
      } as unknown as OpenClawGatewayService,
      options.skillDb ?? null,
    );
    return { syncService, configStore };
  }

  /**
   * Regression guard for the packaged-app boot loop: lastSkillAllowlist
   * starts empty in memory, so the first sync after a controller (re)boot
   * used to see a spurious allowlist diff and restart OpenClaw before the
   * controller was ready — breaking the control-plane stability window and
   * looping the desktop app on the loading screen.
   */
  it("does not restart OpenClaw on first sync after boot when on-disk config is unchanged", async () => {
    const nudges: string[] = [];

    // First controller "boot": writes the compiled config to disk.
    const first = createSyncService({
      gateway: {
        isConnected: () => false,
        shouldPushConfig: async () => false,
      },
      watchTrigger: {
        nudgeSkillsWatcher: async (reason) => {
          nudges.push(reason);
        },
      },
    });
    await first.configStore.createBot({ name: "Assistant", slug: "assistant" });
    await first.syncService.syncAllImmediate();
    nudges.length = 0;

    // Second controller "boot" over the same state: gateway reports a
    // snapshot diff (configPushed=true) but the on-disk file is unchanged.
    const second = createSyncService({
      gateway: { isConnected: () => true, shouldPushConfig: async () => true },
      watchTrigger: {
        nudgeSkillsWatcher: async (reason) => {
          nudges.push(reason);
        },
      },
    });
    const result = await second.syncService.syncAllImmediate();

    expect(result.configChanged).toBe(false);
    expect(nudges).toEqual([]);
  });

  it("still restarts OpenClaw when the config and skill allowlist actually change", async () => {
    const nudges: string[] = [];
    const skillDb = await SkillDb.create(env.skillDbPath);
    skillDb.recordInstall("web-search", "managed");

    const { syncService, configStore } = createSyncService({
      gateway: { isConnected: () => true, shouldPushConfig: async () => true },
      watchTrigger: {
        nudgeSkillsWatcher: async (reason) => {
          nudges.push(reason);
        },
      },
      skillDb,
    });
    await configStore.createBot({ name: "Assistant", slug: "assistant" });
    const result = await syncService.syncAllImmediate();

    expect(result.configChanged).toBe(true);
    expect(nudges).toEqual(["config-pushed"]);
  });
});
