import { selectPreferredModel } from "@nexu/shared";
import type { OpenClawConfig } from "@nexu/shared";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";
import {
  type OAuthConnectionState,
  compileOpenClawConfig,
  resolveModelId,
} from "../lib/openclaw-config-compiler.js";
import type { CreditGuardStateWriter } from "../runtime/credit-guard-state-writer.js";
import type { OpenClawAuthProfilesStore } from "../runtime/openclaw-auth-profiles-store.js";
import type { OpenClawAuthProfilesWriter } from "../runtime/openclaw-auth-profiles-writer.js";
import type { OpenClawConfigWriter } from "../runtime/openclaw-config-writer.js";
import type { OpenClawWatchTrigger } from "../runtime/openclaw-watch-trigger.js";
import {
  type OpenClawRuntimeModelWriter,
  resolveNoModelConfiguredMessage,
} from "../runtime/slimclaw-runtime-model-writer.js";
import type { OpenClawRuntimePluginWriter } from "../runtime/slimclaw-runtime-plugin-writer.js";
import type { WorkspaceTemplateWriter } from "../runtime/workspace-template-writer.js";
import type { ScheduleWorkspaceWriter } from "../services/schedule-workspace-writer.js";
import type { CompiledOpenClawStore } from "../store/compiled-openclaw-store.js";
import type { NexuConfigStore } from "../store/nexu-config-store.js";
import type { NexuConfig } from "../store/schemas.js";
import type { OpenClawGatewayService } from "./openclaw-gateway-service.js";
import type { SkillDb } from "./skillhub/skill-db.js";
import type { WorkspaceSkillScanner } from "./skillhub/workspace-skill-scanner.js";
import type { TeamLedgerStore } from "./teams/team-ledger.js";

function resolvePrimaryModelRef(
  model: string | { primary: string } | undefined,
  config: NexuConfig,
  compiled: ReturnType<typeof compileOpenClawConfig>,
  env: ControllerEnv,
  oauthState: OAuthConnectionState,
): string {
  const availableRuntimeModels = collectRuntimeModelRefs(compiled);
  const configuredProviderKeys = new Set(
    Object.keys(compiled.models?.providers ?? {}),
  );

  if (typeof model === "string") {
    return resolveAvailableRuntimeModel(
      resolveModelId(config, env, model, oauthState),
      availableRuntimeModels,
      configuredProviderKeys,
    );
  }

  if (model && typeof model.primary === "string") {
    return resolveAvailableRuntimeModel(
      resolveModelId(config, env, model.primary, oauthState),
      availableRuntimeModels,
      configuredProviderKeys,
    );
  }

  return resolveAvailableRuntimeModel(
    resolveModelId(config, env, env.defaultModelId, oauthState),
    availableRuntimeModels,
    configuredProviderKeys,
  );
}

function collectRuntimeModelRefs(
  compiled: ReturnType<typeof compileOpenClawConfig>,
): Array<{ id: string; name: string }> {
  const providers = compiled.models?.providers ?? {};
  return Object.entries(providers).flatMap(([providerKey, provider]) =>
    (provider.models ?? []).map((model) => ({
      id: `${providerKey}/${model.id}`,
      name: model.name ?? model.id,
    })),
  );
}

// OAuth providers whose models are managed via the auth profile store,
// not compiled into models.providers (no apiKey in config).
const OAUTH_PROVIDER_PREFIXES = ["openai-codex/"];

function resolveAvailableRuntimeModel(
  desiredRef: string,
  availableRuntimeModels: Array<{ id: string; name: string }>,
  configuredProviderKeys: ReadonlySet<string>,
): string {
  if (availableRuntimeModels.some((model) => model.id === desiredRef)) {
    return desiredRef;
  }

  // Trust OAuth provider model refs — they're managed by OpenClaw's
  // auth profile store and won't appear in compiled models.providers.
  if (OAUTH_PROVIDER_PREFIXES.some((prefix) => desiredRef.startsWith(prefix))) {
    return desiredRef;
  }

  // Trust any model ref whose provider is configured in compiled.models.providers,
  // even if the provider's explicit `models` list is empty. This covers BYOK
  // flows where the user enabled a provider (e.g. Anthropic) with their own
  // API key but never added models to its allowlist — OpenClaw's
  // resolveModelWithRegistry has a generic-fallback path that builds a
  // synthetic model entry when providerConfig is present, so the request
  // still goes through. Without this, the user's explicit selection is
  // silently overridden with the link default.
  const providerKey = desiredRef.split("/", 1)[0];
  if (providerKey && configuredProviderKeys.has(providerKey)) {
    return desiredRef;
  }

  return selectPreferredModel(availableRuntimeModels)?.id ?? desiredRef;
}

export class OpenClawSyncService {
  private pendingSync: Promise<{
    configPushed: boolean;
    configChanged: boolean;
  }> | null = null;
  private debounceTimer: ReturnType<typeof setTimeout> | null = null;
  private settling = false;
  private settlingDirty = false;
  private settlingResolvers: Array<{
    resolve: (v: { configPushed: boolean; configChanged: boolean }) => void;
    reject: (e: unknown) => void;
  }> = [];
  private static readonly DEBOUNCE_MS = 100;
  private static readonly SETTLING_MS = 3000;
  private static readonly SYNC_MAX_RETRIES = 2;
  private static readonly SYNC_RETRY_DELAY_MS = 1000;
  private syncCounter = 0;
  /** Tracks the last-known skill allowlist to detect skill-specific changes. */
  private lastSkillAllowlist: ReadonlySet<string> = new Set();

  constructor(
    private readonly env: ControllerEnv,
    private readonly configStore: NexuConfigStore,
    private readonly compiledStore: CompiledOpenClawStore,
    private readonly configWriter: OpenClawConfigWriter,
    private readonly authProfilesWriter: OpenClawAuthProfilesWriter,
    private readonly authProfilesStore: OpenClawAuthProfilesStore,
    private readonly runtimePluginWriter: OpenClawRuntimePluginWriter,
    private readonly runtimeModelWriter: OpenClawRuntimeModelWriter,
    private readonly creditGuardStateWriter: CreditGuardStateWriter,
    private readonly templateWriter: WorkspaceTemplateWriter,
    private readonly scheduleWorkspaceWriter: ScheduleWorkspaceWriter,
    private readonly watchTrigger: OpenClawWatchTrigger,
    private readonly gatewayService: OpenClawGatewayService,
    private readonly skillDb: SkillDb | null = null,
    private readonly workspaceScanner: WorkspaceSkillScanner | null = null,
    private readonly teamLedger: TeamLedgerStore | null = null,
  ) {}

  /** Teams enable the Workboard plugin in the compiled OpenClaw config. */
  private hasTeams(): boolean {
    return (this.teamLedger?.list().length ?? 0) > 0;
  }

  async compileCurrentConfig(): Promise<
    ReturnType<typeof compileOpenClawConfig>
  > {
    const config = await this.configStore.getConfig();
    const oauthState = await this.authProfilesStore.getOAuthConnectionState();
    const installedSlugs = this.skillDb
      ? this.skillDb
          .getAllInstalled()
          .filter((r) => r.source !== "workspace")
          .map((r) => r.slug)
          .sort((left, right) => left.localeCompare(right))
      : undefined;

    const workspaceMap = this.workspaceScanner
      ? this.workspaceScanner.scanAll(
          config.bots.filter((b) => b.status === "active").map((b) => b.id),
        )
      : undefined;

    return compileOpenClawConfig(
      config,
      this.env,
      oauthState,
      installedSlugs,
      workspaceMap,
      this.hasTeams(),
    );
  }

  /**
   * Enter settling mode after bootstrap. All syncAll() calls during
   * this period are deferred. After SETTLING_MS, one final sync fires.
   * This prevents OpenClaw restart-looping during initial setup
   * (cloud connect, model selection, bot creation, etc.).
   */
  beginSettling(): void {
    this.settling = true;
    this.settlingDirty = false;
    logger.info(
      {},
      `sync settling started (${OpenClawSyncService.SETTLING_MS}ms)`,
    );
    setTimeout(() => this.endSettling(), OpenClawSyncService.SETTLING_MS);
  }

  private endSettling(): void {
    this.settling = false;
    const resolvers = [...this.settlingResolvers];
    this.settlingResolvers = [];

    if (this.settlingDirty) {
      this.settlingDirty = false;
      logger.info({}, "sync settling ended — flushing deferred sync");
      const p = this.doSync();
      p.then(
        (result) => {
          for (const r of resolvers) r.resolve(result);
        },
        (err) => {
          for (const r of resolvers) r.reject(err);
        },
      );
    } else {
      logger.info({}, "sync settling ended — no deferred changes");
      for (const r of resolvers) {
        r.resolve({ configPushed: false, configChanged: false });
      }
    }
  }

  /**
   * Debounced sync: coalesces rapid calls within 100ms into a single
   * execution. During settling mode (startup), calls are deferred
   * entirely and flushed once at the end.
   */
  async syncAll(): Promise<{ configPushed: boolean; configChanged: boolean }> {
    if (this.settling) {
      this.settlingDirty = true;
      logger.debug({}, "syncAll deferred (settling mode)");
      return new Promise((resolve, reject) => {
        this.settlingResolvers.push({ resolve, reject });
      });
    }

    // If a sync is already in flight, wait for it and schedule another after
    if (this.pendingSync) {
      await this.pendingSync.catch(() => {});
    }

    return new Promise((resolve, reject) => {
      if (this.debounceTimer) {
        clearTimeout(this.debounceTimer);
      }
      this.debounceTimer = setTimeout(() => {
        this.debounceTimer = null;
        const p = this.doSyncWithRetry();
        this.pendingSync = p;
        p.then(resolve, reject).finally(() => {
          this.pendingSync = null;
        });
      }, OpenClawSyncService.DEBOUNCE_MS);
    });
  }

  /**
   * Immediate sync bypassing debounce and settling.
   * Used during bootstrap where we need the config written before OpenClaw starts.
   */
  async syncAllImmediate(): Promise<{
    configPushed: boolean;
    configChanged: boolean;
  }> {
    return this.doSync();
  }

  async ensureRuntimeModelPlugin(): Promise<{ changedPluginIds: Set<string> }> {
    const { changedPluginIds } = await this.runtimePluginWriter.ensurePlugins();
    await this.runtimeModelWriter.writeFallback();
    return { changedPluginIds };
  }

  /**
   * Seed platform templates into a specific bot's workspace.
   *
   * Should only be called once per bot, at creation time
   * (`AgentService.createBot`). The underlying writer is strictly
   * seed-if-missing — it never overwrites — so a duplicate call is a
   * harmless no-op, but it is conceptually wrong: agents read/write these
   * platform docs at runtime, and any caller that re-seeds is implicitly
   * claiming the bot's workspace state should be reset.
   */
  async writePlatformTemplatesForBot(
    botId: string,
    lang?: string,
  ): Promise<void> {
    await this.templateWriter.write([{ id: botId, status: "active", lang }]);
  }

  private async doSync(): Promise<{
    configPushed: boolean;
    configChanged: boolean;
  }> {
    const seq = ++this.syncCounter;
    const config = await this.configStore.getConfig();
    const oauthState = await this.authProfilesStore.getOAuthConnectionState();
    const installedSlugs = this.skillDb
      ? this.skillDb
          .getAllInstalled()
          .filter((r) => r.source !== "workspace")
          .map((r) => r.slug)
      : undefined;

    const workspaceMap = this.workspaceScanner
      ? this.workspaceScanner.scanAll(
          config.bots.filter((b) => b.status === "active").map((b) => b.id),
        )
      : undefined;

    // Refresh the platform-managed block in each bot's workspace docs. Seeding
    // only ever runs at creation, so without this a rule added to the templates
    // would reach new bots and no one else. Touches nothing outside the markers,
    // and rewrites only files whose block actually differs, so a steady state is
    // a read per doc.
    await this.templateWriter
      .syncPlatformBlocks(
        config.bots.map((b) => ({
          id: b.id,
          status: b.status,
          // Bots do not persist the language they were seeded with, so fall back
          // to the desktop locale — the same choice a new bot would get today.
          lang: config.desktop?.locale,
        })),
      )
      .catch((err: unknown) => {
        // Never let doc drift block a config push — the config is what keeps the
        // runtime working; the block is guidance.
        logger.warn(
          { error: err instanceof Error ? err.message : err },
          "platform block sync failed; continuing with config sync",
        );
      });

    const rawCompiled = compileOpenClawConfig(
      config,
      this.env,
      oauthState,
      installedSlugs,
      workspaceMap,
      this.hasTeams(),
    );

    const hasAnyProvider =
      Object.keys(rawCompiled.models?.providers ?? {}).length > 0;

    // When no model provider is configured (e.g. after link logout with no
    // BYOK keys), strip the model from agents so OpenClaw cannot fall back
    // to its built-in registry with the bare model name. This normalization
    // must happen BEFORE shouldPushConfig() — otherwise the pre-normalized
    // hash we diff against diverges from the post-normalized hash we store
    // via noteConfigWritten(), which would mark every subsequent no-provider
    // sync as changed and trigger spurious touchAnySkillMarker() runs.
    // Rebuild immutably (no in-place mutation of the compiled object).
    const compiled: OpenClawConfig = hasAnyProvider
      ? rawCompiled
      : {
          ...rawCompiled,
          agents: {
            ...rawCompiled.agents,
            defaults: rawCompiled.agents.defaults
              ? { ...rawCompiled.agents.defaults, model: undefined }
              : rawCompiled.agents.defaults,
            entries: Object.fromEntries(
              Object.entries(rawCompiled.agents.entries).map(([id, agent]) => [
                id,
                agent.model ? { ...agent, model: undefined } : agent,
              ]),
            ),
          },
        };

    logger.info(
      {
        seq,
        modelProviders: Object.keys(compiled.models?.providers ?? {}),
        channels: Object.keys(compiled.channels ?? {}),
        wsConnected: this.gatewayService.isConnected(),
      },
      "doSync: pushing config to OpenClaw",
    );

    // 1. Decide whether this config differs from the last observed snapshot.
    let configPushed = false;
    if (this.gatewayService.isConnected()) {
      try {
        configPushed = await this.gatewayService.shouldPushConfig(compiled);
      } catch (err) {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "openclaw config diff check failed",
        );
      }
    }

    // 2. Always write files once (persistence + watcher hot-reload path).
    const configChanged = await this.configWriter.write(compiled);
    await this.authProfilesWriter.writeForAgents(
      compiled,
      config.models.providers,
    );
    this.gatewayService.noteConfigWritten(compiled);
    const runtimeModelRef = hasAnyProvider
      ? resolvePrimaryModelRef(
          compiled.agents.defaults?.model,
          config,
          compiled,
          this.env,
          oauthState,
        )
      : null;
    logger.info({ seq, runtimeModelRef }, "doSync: resolved runtime model");
    // Write locale state for the credit-guard patch in OpenClaw runtime.
    // Match the controller's own locale default: unset → "en" (not "zh-CN").
    const locale =
      (config.desktop as Record<string, unknown>).locale === "zh-CN"
        ? "zh-CN"
        : "en";
    // Non-critical writes: these supplement the primary config but a failure
    // should not abort the sync. The next sync cycle will retry them.
    if (runtimeModelRef) {
      try {
        await this.runtimeModelWriter.write(runtimeModelRef);
      } catch (err) {
        logger.warn(
          { seq, err: err instanceof Error ? err.message : String(err) },
          "doSync: runtimeModelWriter.write failed (non-critical)",
        );
      }
    } else {
      try {
        await this.runtimeModelWriter.writeNoModelState(
          resolveNoModelConfiguredMessage(locale),
        );
      } catch (err) {
        logger.warn(
          { seq, err: err instanceof Error ? err.message : String(err) },
          "doSync: runtimeModelWriter.writeNoModelState failed (non-critical)",
        );
      }
    }
    try {
      await this.creditGuardStateWriter.write(locale);
    } catch (err) {
      logger.warn(
        { seq, err: err instanceof Error ? err.message : String(err) },
        "doSync: creditGuardStateWriter.write failed (non-critical)",
      );
    }
    try {
      await this.compiledStore.saveConfig(compiled);
    } catch (err) {
      logger.warn(
        { seq, err: err instanceof Error ? err.message : String(err) },
        "doSync: compiledStore.saveConfig failed (non-critical)",
      );
    }

    // Write SCHEDULE.md for each active bot so agents can register cron tasks.
    try {
      await this.scheduleWorkspaceWriter.write(config);
    } catch (err) {
      logger.warn(
        { seq, err: err instanceof Error ? err.message : String(err) },
        "doSync: scheduleWorkspaceWriter.write failed (non-critical)",
      );
    }

    // 3. If OpenClaw is not connected yet, nudge the file watcher after the
    // write. Connected runtimes already see the single in-place overwrite.
    if (!this.gatewayService.isConnected()) {
      try {
        await this.watchTrigger.touchConfig();
      } catch (err) {
        logger.warn(
          { seq, err: err instanceof Error ? err.message : String(err) },
          "doSync: touchConfig failed (non-critical)",
        );
      }
    }

    // 4. Nudge OpenClaw's skills watcher + restart gateway ONLY when the
    // agent skill allowlist actually changed. OpenClaw hot-reloads model,
    // channel, and plugin changes just fine — only agents.entries skill
    // changes are treated as kind "none" and require a full restart.
    // Gate on skill-list diff to avoid unnecessary restarts during
    // normal model/channel/provider updates.
    //
    // NOTE: This only gates on allowlist diffs (skill added/removed).
    // Skill file content changes (SKILL.md edits, ClawHub updates) with
    // an unchanged allowlist do NOT trigger a gateway restart — and that
    // is correct. OpenClaw's chokidar watcher handles file-level changes
    // natively via snapshotVersion bump. Do NOT add restart to that path.
    //
    // Also gate on configChanged (the on-disk file actually changed):
    // lastSkillAllowlist starts empty in memory, so the first sync after
    // controller boot always sees an allowlist "diff" even when nothing
    // changed on disk. Without this gate a fresh boot restarted OpenClaw
    // mid-bootstrap, broke the control plane stability window, and looped
    // the packaged app on the loading screen. Genuine skill changes always
    // rewrite the config file, so they still pass this gate.
    if (configPushed && configChanged) {
      const prevSkills = this.lastSkillAllowlist;
      const nextSkills = this.extractSkillAllowlist(compiled);
      if (!this.skillAllowlistEqual(prevSkills, nextSkills)) {
        await this.watchTrigger.nudgeSkillsWatcher("config-pushed");
      }
    }
    this.lastSkillAllowlist = this.extractSkillAllowlist(compiled);

    logger.info({ seq, configPushed, configChanged }, "doSync: complete");
    return { configPushed, configChanged };
  }

  /**
   * Retry wrapper around doSync(). Transient failures (e.g. file I/O during
   * OpenClaw restart, WS disconnection mid-push) are retried up to
   * SYNC_MAX_RETRIES times with SYNC_RETRY_DELAY_MS backoff. This prevents
   * a single blip from surfacing as an HTTP 500 to the caller.
   */
  private async doSyncWithRetry(): Promise<{
    configPushed: boolean;
    configChanged: boolean;
  }> {
    let lastError: unknown;
    for (
      let attempt = 0;
      attempt <= OpenClawSyncService.SYNC_MAX_RETRIES;
      attempt++
    ) {
      try {
        return await this.doSync();
      } catch (err) {
        lastError = err;
        if (attempt < OpenClawSyncService.SYNC_MAX_RETRIES) {
          logger.warn(
            {
              attempt: attempt + 1,
              maxRetries: OpenClawSyncService.SYNC_MAX_RETRIES,
              err: err instanceof Error ? err.message : String(err),
            },
            "doSync failed, retrying after backoff",
          );
          await new Promise((resolve) =>
            setTimeout(resolve, OpenClawSyncService.SYNC_RETRY_DELAY_MS),
          );
        }
      }
    }
    logger.error(
      {
        maxRetries: OpenClawSyncService.SYNC_MAX_RETRIES,
        err: lastError instanceof Error ? lastError.message : String(lastError),
      },
      "doSync failed after all retries",
    );
    throw lastError;
  }

  private extractSkillAllowlist(
    compiled: ReturnType<typeof compileOpenClawConfig>,
  ): ReadonlySet<string> {
    const skills = new Set<string>();
    for (const agent of Object.values(compiled.agents.entries)) {
      for (const skill of agent.skills ?? []) {
        skills.add(skill);
      }
    }
    return skills;
  }

  private skillAllowlistEqual(
    a: ReadonlySet<string>,
    b: ReadonlySet<string>,
  ): boolean {
    if (a.size !== b.size) return false;
    for (const skill of a) {
      if (!b.has(skill)) return false;
    }
    return true;
  }
}
