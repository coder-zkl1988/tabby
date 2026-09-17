import { randomUUID } from "node:crypto";
import fsp from "node:fs/promises";
import path from "node:path";
import type { SkillReference } from "@nexu/shared";
import { logger } from "../lib/logger.js";
import { startChannelHealthWatchdog } from "../runtime/channel-health-watchdog.js";
import { ControlPlaneHealthService } from "../runtime/control-plane-health.js";
import { CreditGuardStateWriter } from "../runtime/credit-guard-state-writer.js";
import { GatewayClient } from "../runtime/gateway-client.js";
import { startHealthLoop } from "../runtime/loops.js";
import { startAnalyticsLoop } from "../runtime/loops.js";
import { OpenClawAuthProfilesStore } from "../runtime/openclaw-auth-profiles-store.js";
import { OpenClawAuthProfilesWriter } from "../runtime/openclaw-auth-profiles-writer.js";
import { OpenClawConfigWriter } from "../runtime/openclaw-config-writer.js";
import { OpenClawProcessManager } from "../runtime/openclaw-process.js";
import { OpenClawWatchTrigger } from "../runtime/openclaw-watch-trigger.js";
import { OpenClawWsClient } from "../runtime/openclaw-ws-client.js";
import { SessionsRuntime } from "../runtime/sessions-runtime.js";
import { OpenClawRuntimeModelWriter } from "../runtime/slimclaw-runtime-model-writer.js";
import { OpenClawRuntimePluginWriter } from "../runtime/slimclaw-runtime-plugin-writer.js";
import {
  type ControllerRuntimeState,
  createRuntimeState,
} from "../runtime/state.js";
import { WorkspaceTemplateWriter } from "../runtime/workspace-template-writer.js";
import { AgentBrowserBridge } from "../services/agent-browser-bridge.js";
import { AgentService } from "../services/agent-service.js";
import { AnalyticsService } from "../services/analytics-service.js";
import { ApprovalAuditService } from "../services/approval-audit-service.js";
import { ArtifactService } from "../services/artifact-service.js";
import { AttachmentStore } from "../services/attachment-store.js";
import { BundledTabbyMediaRunner } from "../services/bundled-tabby-media-runner.js";
import { ChannelFallbackService } from "../services/channel-fallback-service.js";
import { ChannelService } from "../services/channel-service.js";
import { DesktopLocalService } from "../services/desktop-local-service.js";
import { DeviceControlService } from "../services/device-control-service.js";
import { DeviceMirrorProxy } from "../services/device-mirror-proxy.js";
import { DevicePollingService } from "../services/device-polling-service.js";
import { ExperthubCatalogManager } from "../services/experthub/catalog-manager.js";
import {
  DEFAULT_EXPERT_SLUGS,
  type InstallExpertResult,
  createCustomExpert,
  foldPersonaIntoAgents,
  installDefaultExperts,
  installExpert,
  updateExpertSkills,
} from "../services/experthub/install-flow.js";
import { ensureExpertPersonaFolds } from "../services/experthub/persona-fold-migration.js";
import { GithubStarVerificationService } from "../services/github-star-verification-service.js";
import { IntegrationService } from "../services/integration-service.js";
import { LocalAutomationService } from "../services/local-automation-service.js";
import { LocalUserService } from "../services/local-user-service.js";
import { MediaGenerationService } from "../services/media-generation-service.js";
import { ModelProviderService } from "../services/model-provider-service.js";
import { OpenClawAuthService } from "../services/openclaw-auth-service.js";
import { OpenClawCronGateway } from "../services/openclaw-cron-gateway.js";
import { OpenClawGatewayService } from "../services/openclaw-gateway-service.js";
import { OpenClawSyncService } from "../services/openclaw-sync-service.js";
import { QuotaFallbackService } from "../services/quota-fallback-service.js";
import { RunMessageIntentService } from "../services/run-message-intent-service.js";
import { RuntimeConfigService } from "../services/runtime-config-service.js";
import { RuntimeModelStateService } from "../services/runtime-model-state-service.js";
import { ScheduleService } from "../services/schedule-service.js";
import { ScheduleWorkspaceWriter } from "../services/schedule-workspace-writer.js";
import { SessionRunRegistry } from "../services/session-run-registry.js";
import { SessionService } from "../services/session-service.js";
import { SkillhubService } from "../services/skillhub-service.js";
import {
  readLastAssistantReply,
  readSubagentSessionEntry,
} from "../services/teams/subagent-session-reader.js";
import { TeamLedgerStore } from "../services/teams/team-ledger.js";
import { TeamService } from "../services/teams/team-service.js";
import { WorkflowComposer } from "../services/teams/team-workflow-composer.js";
import { TeamWorkflowLedgerStore } from "../services/teams/team-workflow-ledger.js";
import { TeamWorkflowService } from "../services/teams/team-workflow-service.js";
import { TemplateService } from "../services/template-service.js";
import { XhsOpsCommentService } from "../services/xhs-ops-comment-service.js";
import { XhsOpsProfileService } from "../services/xhs-ops-profile-service.js";
import { XhsOpsRunService } from "../services/xhs-ops-run-service.js";
import {
  XHS_OPS_SCHEDULER_INTERVAL_MS,
  XhsOpsScheduler,
} from "../services/xhs-ops-scheduler.js";
import { ArtifactsStore } from "../store/artifacts-store.js";
import { CompiledOpenClawStore } from "../store/compiled-openclaw-store.js";
import { DeviceNameStore } from "../store/device-name-store.js";
import { DeviceTaskHistoryStore } from "../store/device-task-history-store.js";
import { NexuConfigStore } from "../store/nexu-config-store.js";
import { XhsOpsStore } from "../store/xhs-ops-store.js";
import { type ControllerEnv, env } from "./env.js";

export interface ControllerContainer {
  env: ControllerEnv;
  configStore: NexuConfigStore;
  gatewayClient: GatewayClient;
  controlPlaneHealth: ControlPlaneHealthService;
  openclawProcess: OpenClawProcessManager;
  agentService: AgentService;
  channelService: ChannelService;
  channelFallbackService: ChannelFallbackService;
  sessionService: SessionService;
  runtimeConfigService: RuntimeConfigService;
  runtimeModelStateService: RuntimeModelStateService;
  modelProviderService: ModelProviderService;
  integrationService: IntegrationService;
  localAutomationService: LocalAutomationService;
  localUserService: LocalUserService;
  desktopLocalService: DesktopLocalService;
  analyticsService: AnalyticsService;
  approvalAuditService: ApprovalAuditService;
  artifactService: ArtifactService;
  attachmentStore: AttachmentStore;
  templateService: TemplateService;
  skillhubService: SkillhubService;
  teamService: TeamService;
  mediaGenerationService: MediaGenerationService;
  runMessageIntentService: RunMessageIntentService;
  teamWorkflowService: TeamWorkflowService;
  experthubCatalogManager: ExperthubCatalogManager;
  installExpertFn: (args: { slug: string }) => Promise<InstallExpertResult>;
  installDefaultExpertsFn: () => Promise<{
    installed: string[];
    skipped: string[];
  }>;
  createCustomExpertFn: (args: {
    name: string;
    avatarDataUrl?: string;
    modelId: string;
    description?: string;
    skills: string[];
    skillRefs?: SkillReference[];
    existingSlug?: string;
    workspaceFiles: Record<string, string>;
  }) => Promise<{ ok: true; botId: string; slug: string }>;
  updateExpertSkillsFn: (args: {
    slug: string;
    skills: string[];
    skillRefs?: SkillReference[];
  }) => Promise<{
    ok: true;
    configuredSkills: string[];
    configuredSkillRefs: SkillReference[];
  }>;
  openclawSyncService: OpenClawSyncService;
  openclawAuthService: OpenClawAuthService;
  quotaFallbackService: QuotaFallbackService;
  githubStarVerificationService: GithubStarVerificationService;
  deviceControlService: DeviceControlService;
  xhsOpsStore: XhsOpsStore;
  xhsOpsRunService: XhsOpsRunService;
  xhsOpsProfileService: XhsOpsProfileService;
  xhsOpsScheduler: XhsOpsScheduler;
  xhsOpsCommentService: XhsOpsCommentService;
  deviceMirrorProxy: DeviceMirrorProxy;
  devicePollingService: DevicePollingService;
  deviceTaskHistoryStore: DeviceTaskHistoryStore;
  deviceNameStore: DeviceNameStore;
  agentBrowserBridge: AgentBrowserBridge;
  wsClient: OpenClawWsClient;
  gatewayService: OpenClawGatewayService;
  sessionRunRegistry: SessionRunRegistry;
  scheduleService: ScheduleService;
  runtimeState: ControllerRuntimeState;
  startBackgroundLoops: () => () => void;
}

const NEXU_OFFICIAL_MODEL_REFRESH_INTERVAL_MS = 60 * 1000;

export async function createContainer(): Promise<ControllerContainer> {
  const configStore = new NexuConfigStore(env);
  await configStore.reconcileConfiguredDesktopCloudState();
  await configStore.syncManagedRuntimeGateway({
    port: env.openclawGatewayPort,
    authMode: env.openclawGatewayToken ? "token" : "none",
  });
  const artifactsStore = new ArtifactsStore(env);
  const deviceTaskHistoryStore = new DeviceTaskHistoryStore(
    env.deviceTaskHistoryPath,
    env.screenshotsDir,
  );
  const compiledStore = new CompiledOpenClawStore(env);
  const configWriter = new OpenClawConfigWriter(env);
  const authProfilesStore = new OpenClawAuthProfilesStore(env);
  const authProfilesWriter = new OpenClawAuthProfilesWriter(authProfilesStore);
  const runtimePluginWriter = new OpenClawRuntimePluginWriter(env);
  const runtimeModelWriter = new OpenClawRuntimeModelWriter(env);
  const creditGuardStateWriter = new CreditGuardStateWriter(env);
  const templateWriter = new WorkspaceTemplateWriter(env);
  const scheduleWorkspaceWriter = new ScheduleWorkspaceWriter(env);
  const gatewayClient = new GatewayClient(env);
  const sessionsRuntime = new SessionsRuntime(env);
  const runtimeState = createRuntimeState();
  // Construct openclawProcess before watchTrigger so the watch trigger can
  // delegate gateway restarts to OpenClawProcessManager.restart() instead of
  // re-implementing the dev-vs-launchd branching inline.
  const openclawProcess = new OpenClawProcessManager(env);
  const watchTrigger = new OpenClawWatchTrigger(env, openclawProcess);
  const wsClient = new OpenClawWsClient(env);
  const gatewayService = new OpenClawGatewayService(wsClient);
  const approvalAuditService = new ApprovalAuditService(
    path.join(env.nexuHomeDir, "approval-audit-ledger.json"),
  );
  await approvalAuditService.markInterruptedTeamApprovals();
  const observeApprovalEvent = (event: string, operation: Promise<boolean>) => {
    void operation.catch((error) => {
      logger.warn(
        {
          event,
          error: error instanceof Error ? error.message : String(error),
        },
        "approval_audit_event_persist_failed",
      );
    });
  };
  for (const kind of ["exec", "plugin"] as const) {
    wsClient.on(`${kind}.approval.requested`, (payload) => {
      observeApprovalEvent(
        `${kind}.approval.requested`,
        approvalAuditService.observeGatewayRequested(kind, payload),
      );
    });
    wsClient.on(`${kind}.approval.resolved`, (payload) => {
      observeApprovalEvent(
        `${kind}.approval.resolved`,
        approvalAuditService.observeGatewayResolved(kind, payload),
      );
    });
  }
  // Tracks in-flight webchat turns per session so the chat send path can reject
  // fast (friendly "busy") instead of submitting a second turn that would time
  // out on OpenClaw's session file lock. Fed by the gateway's chat lifecycle
  // events; subscribed once here for the app's lifetime (listeners survive WS
  // reconnects — only wsClient.stop() clears them).
  const sessionRunRegistry = new SessionRunRegistry();
  wsClient.onChatEvent((payload) =>
    sessionRunRegistry.handleChatEvent(payload),
  );
  wsClient.onChatSideResult((payload) =>
    sessionRunRegistry.handleChatSideResult(payload),
  );
  wsClient.onDisconnected(() => sessionRunRegistry.handleGatewayDisconnect());
  const controlPlaneHealth = new ControlPlaneHealthService(
    gatewayService,
    wsClient,
    runtimeState,
    openclawProcess,
  );
  const channelFallbackService = new ChannelFallbackService(
    openclawProcess,
    gatewayService,
    {
      getLocale: () => configStore.getDesktopLocale(),
    },
  );
  let syncService: OpenClawSyncService | null = null;
  const skillhubService = await SkillhubService.create(env, {
    onSyncNeeded: () => {
      void syncService?.syncAll().catch(() => {});
    },
    getBotIds: async () => {
      const config = await configStore.getConfig();
      return config.bots.map((b) => b.id);
    },
  });
  const teamLedgerStore = new TeamLedgerStore(env.teamDbPath);
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
    skillhubService.skillDb,
    skillhubService.workspaceSkillScanner,
    teamLedgerStore,
  );
  syncService = openclawSyncService;
  const localAutomationService = new LocalAutomationService(
    env,
    configStore,
    openclawSyncService,
    openclawProcess,
  );
  const cronGateway = new OpenClawCronGateway(wsClient, env);
  const scheduleService = new ScheduleService(
    configStore,
    cronGateway,
    openclawSyncService,
    sessionsRuntime,
  );
  wsClient.onConnected(() => {
    void scheduleService.handleGatewayConnected().catch((error) => {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "schedule_reconnect_reconciliation_failed",
      );
    });
  });
  const openclawAuthService = new OpenClawAuthService(env, authProfilesStore);
  const analyticsService = new AnalyticsService(
    env,
    configStore,
    sessionsRuntime,
  );
  const modelProviderService = new ModelProviderService(
    configStore,
    env,
    openclawSyncService,
    openclawProcess,
  );
  modelProviderService.setAuthService(openclawAuthService);
  modelProviderService.setGatewayService(gatewayService);
  const runtimeModelStateService = new RuntimeModelStateService(env);
  const quotaFallbackService = new QuotaFallbackService(
    configStore,
    openclawSyncService,
  );
  const githubStarVerificationService = new GithubStarVerificationService();
  const deviceControlService = new DeviceControlService(
    configStore,
    deviceTaskHistoryStore,
  );
  const xhsOpsStore = new XhsOpsStore(env.xhsOpsStorePath);
  const xhsOpsRunService = new XhsOpsRunService({
    store: xhsOpsStore,
    deviceControl: deviceControlService,
  });
  // P2-4 每日自动执行：每分钟检查各项目 schedule，到点后按兴趣池生成当日计划并派发。
  const xhsOpsScheduler = new XhsOpsScheduler({
    store: xhsOpsStore,
    runService: xhsOpsRunService,
  });
  // The tabby-control plugin loses its in-memory VLM credential on every
  // OpenClaw (re)start, so re-push it once the plugin RPC is reachable after
  // any restart (provider change, watchdog, skills nudge, cloud login, ...).
  openclawProcess.setVlmCredentialRepush(() =>
    deviceControlService.pushDesktopStateWhenReady(),
  );
  const deviceMirrorProxy = new DeviceMirrorProxy(configStore);
  const devicePollingService = new DevicePollingService(deviceControlService);
  const attachmentStore = new AttachmentStore({
    openclawStateDir: env.openclawStateDir,
  });
  // Sweep expired webchat attachments on boot.  Fire-and-forget so controller
  // startup isn't blocked by disk I/O, and errors are swallowed-with-log by
  // the store itself.
  void attachmentStore.cleanupExpired().catch((err) => {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "attachment-store: startup cleanup failed",
    );
  });

  // Experts (ExpertHub): catalog manager + install flow.
  // The catalog manager reads bundled manifests from the static dir and
  // managed manifests from the cache dir; if staticExpertsDir is undefined
  // (e.g. when SKILLHUB_STATIC_SKILLS_DIR is unset and no workspaceRoot was
  // detected), we pass an empty string which the manager treats as "no
  // bundled entries" via its existsSync guard.
  const experthubCatalogManager = new ExperthubCatalogManager({
    cacheDir: env.experthubCacheDir,
    ledgerPath: env.expertDbPath,
    staticDir: env.staticExpertsDir ?? "",
    versionUrl: env.experthubVersionUrl,
    downloadUrl: env.experthubDownloadUrl,
    log: (level, message) => {
      logger[level === "error" ? "error" : level === "warn" ? "warn" : "info"](
        { subsystem: "experthub" },
        message,
      );
    },
  });

  // Back-fill the SOUL.md -> AGENTS.md persona fold for experts installed before
  // in-chat delegation existed, so they keep their persona when delegated to.
  // Idempotent + fire-and-forget so startup isn't blocked by disk I/O.
  void ensureExpertPersonaFolds({
    readLedger: () => experthubCatalogManager.readLedger(),
    agentsDir: path.join(env.openclawStateDir, "agents"),
  })
    .then((updated) => {
      if (updated > 0) {
        logger.info({ updated }, "expert persona fold migration applied");
      }
    })
    .catch((error) => {
      logger.warn(
        { error: error instanceof Error ? error.message : String(error) },
        "expert persona fold migration failed",
      );
    });

  // AgentService is used by both the return block and the experthub install
  // flow. Construct it once so both paths share the same cache/syncAll semantics.
  const agentService = new AgentService(
    configStore,
    openclawSyncService,
    openclawProcess,
  );

  const teamWorkflowLedgerStore = new TeamWorkflowLedgerStore(
    env.teamWorkflowDbPath,
  );
  const teamService = new TeamService({
    ledger: teamLedgerStore,
    gateway: gatewayService,
    resolveExpertPersona: async (slug) => {
      const resolved = await experthubCatalogManager.resolveExpert(slug);
      if (!resolved) {
        return null;
      }
      // SOUL.md is the canonical persona file; fall back to the systemPrompt.
      return (
        resolved.manifest.workspaceFiles["SOUL.md"] ??
        resolved.manifest.systemPrompt ??
        null
      );
    },
    resolveExpertName: async (slug) => {
      const resolved = await experthubCatalogManager.resolveExpert(slug);
      return resolved?.manifest.name ?? null;
    },
    readExpertLedger: () => experthubCatalogManager.readLedger(),
    // Auto-install uninstalled experts when they are added to a team.
    // installExpertFn is declared below; only invoked at request time.
    installExpert: async (slug) => {
      await installExpertFn({ slug });
    },
    botService: {
      createBot: async (input) => {
        const bot = await agentService.createBot({
          name: input.name,
          slug: input.slug,
          modelId: input.modelId,
          systemPrompt: input.systemPrompt,
        });
        return { id: bot.id };
      },
      updateBotSystemPrompt: async (botId, systemPrompt) => {
        await agentService.updateBot(botId, { systemPrompt });
      },
      deleteBot: (botId) => agentService.deleteBot(botId),
    },
    applyLeadPersona: async (leadBotId, persona) => {
      const agentsPath = path.join(
        env.openclawStateDir,
        "agents",
        leadBotId,
        "AGENTS.md",
      );
      let agents = "";
      try {
        agents = await fsp.readFile(agentsPath, "utf8");
      } catch {
        // No AGENTS.md yet (platform templates not seeded) — synthesize one.
      }
      const next = foldPersonaIntoAgents(agents, persona);
      if (next !== agents) {
        await fsp.writeFile(agentsPath, next);
      }
    },
    syncAll: () => openclawSyncService.syncAll(),
    getGlobalModelId: async () =>
      (await configStore.getConfig()).runtime.defaultModelId,
    genId: () => randomUUID(),
    genBotSlug: (base) =>
      `${base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 32)}-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    resolveExpertDescription: async (slug) => {
      const resolved = await experthubCatalogManager.resolveExpert(slug);
      return resolved?.manifest.description ?? null;
    },
    removeTeamWorkflows: (teamId) =>
      teamWorkflowLedgerStore.removeByTeam(teamId),
    // Same controller-driven completion primitive as the workflow (SOP)
    // engine below (design doc §10.3/§10.4) — completion is decided by
    // polling the session, not by the worker's tool-call compliance.
    sendChat: (input) => gatewayService.sendToMainSession(input),
    readSessionEntry: (botId, sessionKey) =>
      readSubagentSessionEntry(env.openclawStateDir, botId, sessionKey),
    readAssistantReply: (sessionFile) => readLastAssistantReply(sessionFile),
  });

  const tabbyMediaRunner = env.staticSkillsDir
    ? new BundledTabbyMediaRunner({
        staticSkillsDir: env.staticSkillsDir,
        openclawStateDir: env.openclawStateDir,
        genId: () => randomUUID(),
      })
    : undefined;

  const mediaGenerationService = new MediaGenerationService({
    // Any active bot can run the utility lane; prefer the default agent
    // (first active bot, mirroring compileAgentList ordering).
    pickUtilityBotId: async () => {
      const config = await configStore.getConfig();
      const bot = config.bots
        .filter((candidate) => candidate.status === "active")
        .sort((left, right) => left.slug.localeCompare(right.slug))[0];
      return bot?.id ?? null;
    },
    sendChat: (input) => gatewayService.sendToMainSession(input),
    readSessionEntry: (botId, sessionKey) =>
      readSubagentSessionEntry(env.openclawStateDir, botId, sessionKey),
    readAssistantReply: (sessionFile) => readLastAssistantReply(sessionFile),
    openclawStateDir: env.openclawStateDir,
    genId: () => randomUUID(),
    tabbyMediaRunner,
  });

  const runMessageIntentService = new RunMessageIntentService({
    getUtilityModelId: async () =>
      (await configStore.getConfig()).runtime.utilityModelId,
    createSession: (input) => gatewayService.sessionsCreate(input),
    patchSession: (input) => gatewayService.sessionsPatch(input),
    sendChat: (input) => gatewayService.sendToMainSession(input),
    abortSession: (sessionKey) => gatewayService.abortChatSession(sessionKey),
    readSessionEntry: (botId, sessionKey) =>
      readSubagentSessionEntry(env.openclawStateDir, botId, sessionKey),
    readAssistantReply: (sessionFile) => readLastAssistantReply(sessionFile),
    genId: () => randomUUID(),
  });

  const teamWorkflowService = new TeamWorkflowService({
    workflows: teamWorkflowLedgerStore,
    getTeam: (teamId) => teamLedgerStore.get(teamId),
    gateway: gatewayService,
    resolveExpertPersona: async (slug) => {
      const resolved = await experthubCatalogManager.resolveExpert(slug);
      if (!resolved) {
        return null;
      }
      return (
        resolved.manifest.workspaceFiles["SOUL.md"] ??
        resolved.manifest.systemPrompt ??
        null
      );
    },
    // Same chat.send path normal expert chat uses — the lane worker runs with
    // the member's own configured model (design doc §10.3).
    sendChat: (input) => gatewayService.sendToMainSession(input),
    readSessionEntry: (botId, sessionKey) =>
      readSubagentSessionEntry(env.openclawStateDir, botId, sessionKey),
    readAssistantReply: (sessionFile) => readLastAssistantReply(sessionFile),
    approvalAudit: approvalAuditService,
    getReviewerName: async () => (await configStore.getLocalProfile()).name,
    ensureTeamMembers: async (teamId, memberSlugs) => {
      const team = teamLedgerStore.get(teamId);
      if (!team) {
        throw new Error(`Team not found: ${teamId}`);
      }
      const current = new Set(team.members.map((m) => m.expertSlug));
      const missing = memberSlugs.filter((slug) => !current.has(slug));
      if (missing.length === 0) {
        return team;
      }
      // updateTeam auto-installs uninstalled experts.
      return teamService.updateTeam(teamId, {
        memberSlugs: [...current, ...missing],
      });
    },
    composeDraft: async (team, description) => {
      const composer = new WorkflowComposer({
        gatewayBaseUrl: env.openclawBaseUrl,
        gatewayToken: env.openclawGatewayToken ?? null,
      });
      const experts = await experthubCatalogManager.listExperts();
      return composer.compose({
        description,
        // The gateway's OpenAI-compatible endpoint runs a full agent turn and
        // only accepts `openclaw/<agentId>` — the lead composes for its team
        // with its own configured model.
        model: `openclaw/${team.leadBotId}`,
        catalog: experts.map((expert) => ({
          slug: expert.slug,
          name: expert.name,
          description: expert.description ?? "",
        })),
      });
    },
    genId: () => randomUUID(),
  });

  const installExpertFn = (args: { slug: string }) =>
    installExpert({
      slug: args.slug,
      deps: {
        catalog: {
          resolveExpert: (slug) => experthubCatalogManager.resolveExpert(slug),
          readLedger: () => experthubCatalogManager.readLedger(),
          writeLedger: (ledger) => experthubCatalogManager.writeLedger(ledger),
        },
        botService: {
          createBot: async (input) => {
            const bot = await agentService.createBot({
              name: input.name,
              slug: input.slug,
              systemPrompt: input.systemPrompt,
              modelId: input.modelId,
              expertSlug: input.expertSlug,
            });
            return { id: bot.id, slug: bot.slug };
          },
        },
        skillhub: {
          install: async (input) => {
            return skillhubService.installWorkspaceSkill(input, input.agentId);
          },
        },
        sync: openclawSyncService,
        fs: {
          writeFile: (p, data) => fsp.writeFile(p, data),
          mkdir: async (p, opts) => {
            await fsp.mkdir(p, opts);
          },
          rm: (p) => fsp.rm(p, { force: true }),
        },
        agentsDir: path.join(env.openclawStateDir, "agents"),
        genBotSlug: (expertSlug) =>
          `${expertSlug}-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
        getGlobalModelId: async () =>
          (await configStore.getConfig()).runtime.defaultModelId,
      },
    });

  const installDefaultExpertsDeps = {
    catalog: {
      resolveExpert: (slug: string) =>
        experthubCatalogManager.resolveExpert(slug),
      readLedger: () => experthubCatalogManager.readLedger(),
      writeLedger: (
        ledger: Parameters<typeof experthubCatalogManager.writeLedger>[0],
      ) => experthubCatalogManager.writeLedger(ledger),
    },
    botService: {
      createBot: async (input: {
        name: string;
        slug: string;
        systemPrompt: string;
        modelId: string;
        expertSlug: string;
      }) => {
        const bot = await agentService.createBot({
          name: input.name,
          slug: input.slug,
          systemPrompt: input.systemPrompt,
          modelId: input.modelId,
          expertSlug: input.expertSlug,
        });
        return { id: bot.id, slug: bot.slug };
      },
    },
    skillhub: {
      install: async (input: {
        slug: string;
        ownerHandle?: string;
        version?: string;
        agentId: string;
        source: "workspace";
      }) => {
        return skillhubService.installWorkspaceSkill(input, input.agentId);
      },
    },
    sync: openclawSyncService,
    fs: {
      writeFile: (p: string, data: string) => fsp.writeFile(p, data),
      mkdir: async (p: string, opts?: { recursive: boolean }) => {
        await fsp.mkdir(p, opts);
      },
      rm: (p: string) => fsp.rm(p, { force: true }),
    },
    agentsDir: path.join(env.openclawStateDir, "agents"),
    genBotSlug: (expertSlug: string) =>
      `${expertSlug}-${randomUUID().replace(/-/g, "").slice(0, 8)}`,
    getGlobalModelId: async () =>
      (await configStore.getConfig()).runtime.defaultModelId,
  };

  const installDefaultExpertsFn = () =>
    installDefaultExperts({
      slugs: DEFAULT_EXPERT_SLUGS,
      deps: installDefaultExpertsDeps,
    });

  const createCustomExpertFn = (args: {
    name: string;
    avatarDataUrl?: string;
    modelId: string;
    description?: string;
    skills: string[];
    skillRefs?: SkillReference[];
    existingSlug?: string;
    workspaceFiles: Record<string, string>;
  }) =>
    createCustomExpert({
      ...args,
      deps: {
        catalog: {
          readLedger: () => experthubCatalogManager.readLedger(),
          writeLedger: (ledger) => experthubCatalogManager.writeLedger(ledger),
        },
        botService: {
          createBot: async (input) => {
            const bot = await agentService.createBot({
              name: input.name,
              slug: input.slug,
              systemPrompt: input.systemPrompt,
              modelId: input.modelId,
              expertSlug: input.expertSlug,
            });
            return { id: bot.id, slug: bot.slug };
          },
          getBotByExpertSlug: async (slug) => {
            const bots = await agentService.listBots();
            const match = (
              bots as Array<{ id: string; expertSlug: string }>
            ).find((b) => b.expertSlug === slug);
            return match ? { id: match.id } : null;
          },
          deleteBot: async (id) => {
            await agentService.deleteBot(id);
          },
        },
        skillhub: {
          install: async (input) => {
            return skillhubService.installWorkspaceSkill(input, input.agentId);
          },
        },
        sync: openclawSyncService,
        fs: {
          writeFile: (p, data) => fsp.writeFile(p, data),
          mkdir: async (p, opts) => {
            await fsp.mkdir(p, opts);
          },
          rm: async (p, opts) => {
            await fsp.rm(p, opts ?? { recursive: true });
          },
        },
        agentsDir: path.join(env.openclawStateDir, "agents"),
      },
    });

  const updateExpertSkillsFn = (args: {
    slug: string;
    skills: string[];
    skillRefs?: SkillReference[];
  }) =>
    updateExpertSkills({
      slug: args.slug,
      skills: args.skills,
      ...(args.skillRefs ? { skillRefs: args.skillRefs } : {}),
      deps: {
        catalog: {
          resolveExpert: (slug) => experthubCatalogManager.resolveExpert(slug),
          readLedger: () => experthubCatalogManager.readLedger(),
          writeLedger: (ledger) => experthubCatalogManager.writeLedger(ledger),
        },
        skillhub: {
          install: async (input) => {
            return skillhubService.installWorkspaceSkill(input, input.agentId);
          },
          uninstall: async (input) => {
            const result = await skillhubService.uninstallSkill({
              slug: input.slug,
              agentId: input.agentId,
              source: "workspace",
            });
            return result;
          },
        },
        sync: openclawSyncService,
      },
    });

  // Wire cloud state change callback to sync refreshed cloud inventory without
  // auto-switching the default model during startup or first-channel connect.
  configStore.onCloudStateChanged = async (_change) => {
    // Auto-select a valid default model: on login, pick a managed model;
    // on logout, fall back to any remaining BYOK/OAuth model (or leave
    // cleared, which surfaces the explicit no-model guidance).
    await modelProviderService.ensureValidDefaultModel();
    await openclawSyncService.syncAll();
    // Restart the gateway on every login/logout.  Provider-level changes
    // are not hot-reload-safe: OpenClaw builds its provider/model registry
    // once at boot, so without a restart the old providers map stays
    // resident in memory and the runtime keeps resolving to stale entries
    // (e.g. link/*) after disconnect, or reports "Unknown model" after a
    // fresh login because the registry never saw the new providers map.
    // `restart()` handles both dev-managed and launchd-managed modes, and
    // re-pushes the signed-in user's VLM gateway credential (or null on logout)
    // to the tabby-control plugin once it is back up, via setVlmCredentialRepush.
    await openclawProcess.restart("cloud_state_changed");
  };

  // Hoisted so both the container surface and the channel-health watchdog
  // (started in startBackgroundLoops) share one instance.
  const channelService = new ChannelService(
    env,
    configStore,
    openclawSyncService,
    gatewayService,
    openclawProcess,
    controlPlaneHealth,
    wsClient,
    quotaFallbackService,
  );
  const xhsOpsProfileService = new XhsOpsProfileService({
    store: xhsOpsStore,
    media: mediaGenerationService,
    deviceControl: deviceControlService,
    mediaRoot: path.resolve(env.openclawStateDir, "media"),
  });

  return {
    env,
    gatewayClient,
    controlPlaneHealth,
    openclawProcess,
    agentService,
    channelService,
    channelFallbackService,
    sessionService: new SessionService(
      sessionsRuntime,
      gatewayService,
      sessionRunRegistry,
    ),
    runtimeConfigService: new RuntimeConfigService(
      configStore,
      openclawSyncService,
    ),
    runtimeModelStateService,
    modelProviderService,
    integrationService: new IntegrationService(configStore),
    localAutomationService,
    localUserService: new LocalUserService(configStore),
    desktopLocalService: new DesktopLocalService(
      configStore,
      modelProviderService,
      openclawProcess,
    ),
    analyticsService,
    approvalAuditService,
    artifactService: new ArtifactService(artifactsStore),
    attachmentStore,
    templateService: new TemplateService(configStore, openclawSyncService),
    skillhubService,
    teamService,
    mediaGenerationService,
    runMessageIntentService,
    teamWorkflowService,
    experthubCatalogManager,
    installExpertFn,
    installDefaultExpertsFn,
    createCustomExpertFn,
    updateExpertSkillsFn,
    openclawSyncService,
    openclawAuthService,
    quotaFallbackService,
    githubStarVerificationService,
    deviceControlService,
    xhsOpsStore,
    xhsOpsRunService,
    xhsOpsProfileService,
    xhsOpsScheduler,
    xhsOpsCommentService: new XhsOpsCommentService({
      store: xhsOpsStore,
      media: mediaGenerationService,
    }),
    deviceMirrorProxy,
    devicePollingService,
    deviceTaskHistoryStore,
    deviceNameStore: new DeviceNameStore(env.deviceNamesPath),
    agentBrowserBridge: new AgentBrowserBridge(),
    wsClient,
    gatewayService,
    sessionRunRegistry,
    configStore,
    scheduleService,
    runtimeState,
    startBackgroundLoops: () => {
      // 控制器重启后恢复残留 run；只有手机停止已确认的任务才会收口，
      // 无法确认的手机任务继续保持隔离，避免重复派发。
      void xhsOpsRunService.recoverInterruptedRuns().catch((err) => {
        logger.warn(
          { error: err instanceof Error ? err.message : String(err) },
          "xhs-ops: recoverInterruptedRuns failed",
        );
      });
      let isReconcilingProfileOperations = false;
      const reconcileProfileOperations = () => {
        if (isReconcilingProfileOperations) return;
        isReconcilingProfileOperations = true;
        void xhsOpsProfileService
          .reconcileRunningOperations()
          .catch((err) => {
            logger.warn(
              { error: err instanceof Error ? err.message : String(err) },
              "xhs-ops: reconcile profile operations failed",
            );
          })
          .finally(() => {
            isReconcilingProfileOperations = false;
          });
      };
      reconcileProfileOperations();
      const profileOperationReconcileInterval = setInterval(
        reconcileProfileOperations,
        XHS_OPS_SCHEDULER_INTERVAL_MS,
      );
      profileOperationReconcileInterval.unref?.();
      let isRefreshingNexuOfficialModels = false;
      const stopHealthLoop = startHealthLoop({
        env,
        state: runtimeState,
        controlPlaneHealth,
        processManager: openclawProcess,
        wsClient,
      });
      const stopAnalyticsLoop = startAnalyticsLoop({
        env,
        analyticsService,
      });
      const stopChannelHealthWatchdog = startChannelHealthWatchdog({
        env,
        channelService,
        gatewayService,
        openclawProcess,
      });
      const nexuOfficialModelRefreshInterval = setInterval(() => {
        if (isRefreshingNexuOfficialModels) {
          return;
        }

        isRefreshingNexuOfficialModels = true;
        void modelProviderService
          .refreshNexuOfficialModels()
          .catch((error) => {
            logger.warn(
              {
                error: error instanceof Error ? error.message : String(error),
              },
              "nexu_official_model_refresh_failed",
            );
          })
          .finally(() => {
            isRefreshingNexuOfficialModels = false;
          });
      }, NEXU_OFFICIAL_MODEL_REFRESH_INTERVAL_MS);
      nexuOfficialModelRefreshInterval.unref?.();
      skillhubService.start();
      devicePollingService.start();
      xhsOpsScheduler.start();

      // On cold start, push the signed-in user's VLM gateway credential to the
      // device-control plugin once its RPC is up, so phones connecting before
      // any login change still run the model on the user's cloud account.
      void deviceControlService.pushDesktopStateWhenReady();

      return () => {
        stopHealthLoop();
        stopAnalyticsLoop();
        stopChannelHealthWatchdog();
        clearInterval(nexuOfficialModelRefreshInterval);
        clearInterval(profileOperationReconcileInterval);
        skillhubService.dispose();
        devicePollingService.dispose();
        xhsOpsScheduler.stop();
        deviceMirrorProxy.close();
        openclawAuthService.dispose();
        channelFallbackService.stop();
        wsClient.stop();
      };
    },
  };
}
