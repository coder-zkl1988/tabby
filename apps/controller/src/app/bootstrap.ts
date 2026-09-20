import { logger } from "../lib/logger.js";
import type { ControllerContainer } from "./container.js";

const INITIAL_CONTROL_PLANE_READY_TIMEOUT_MS = 30_000;
const EXTERNAL_CONFIG_CHANGED_STABLE_CONTROL_PLANE_TIMEOUT_MS = 120_000;
const MANAGED_STABLE_CONTROL_PLANE_TIMEOUT_MS = 90_000;
const STABLE_CONTROL_PLANE_WINDOW_MS = 4_000;
const CONTROL_PLANE_POLL_INTERVAL_MS = 500;

function logBootstrapStage(stage: string, startedAt: number, extra = {}): void {
  logger.info(
    {
      stage,
      durationMs: Date.now() - startedAt,
      ...extra,
    },
    "controller_bootstrap_stage",
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForGatewayConnection(
  container: ControllerContainer,
  timeoutMs: number,
): Promise<void> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < timeoutMs) {
    if (container.wsClient.isConnected()) {
      return;
    }

    await sleep(CONTROL_PLANE_POLL_INTERVAL_MS);
  }

  throw new Error(
    "controller bootstrap timed out waiting for gateway connection",
  );
}

async function waitForStableControlPlane(
  container: ControllerContainer,
  timeoutMs: number,
  stableWindowMs: number,
): Promise<void> {
  const startedAt = Date.now();
  let stableSince: number | null = null;

  while (Date.now() - startedAt < timeoutMs) {
    const result = await container.controlPlaneHealth.bootstrapProbe();

    if (result.ok) {
      stableSince ??= Date.now();
      if (Date.now() - stableSince >= stableWindowMs) {
        return;
      }
    } else {
      stableSince = null;
    }

    await sleep(CONTROL_PLANE_POLL_INTERVAL_MS);
  }

  throw new Error(
    "controller bootstrap timed out waiting for a stable control plane",
  );
}

export async function bootstrapController(
  container: ControllerContainer,
): Promise<() => void> {
  const bootstrapStartedAt = Date.now();
  container.runtimeState.bootPhase = "preparing";

  logger.info(
    {
      nexuHomeDir: container.env.nexuHomeDir,
      openclawOwnershipMode: container.env.openclawOwnershipMode,
      openclawBaseUrl: container.env.openclawBaseUrl,
      openclawConfigPath: container.env.openclawConfigPath,
      openclawStateDir: container.env.openclawStateDir,
      openclawSkillsDir: container.env.openclawSkillsDir,
      openclawWorkspaceTemplatesDir:
        container.env.openclawWorkspaceTemplatesDir,
      openclawLogDir: container.env.openclawLogDir,
      platformTemplatesDir: container.env.platformTemplatesDir ?? null,
    },
    "controller_bootstrap_runtime_contract",
  );

  // Run independent prep tasks in parallel to shave off startup time.
  // All three are independent: process cleanup, plugin files, cloud model fetch.
  const prepareStartedAt = Date.now();
  const [, , pluginResult] = await Promise.all([
    container.openclawProcess.prepare(),
    container.localAutomationService.prepare(),
    container.openclawSyncService.ensureRuntimeModelPlugin(),
    container.configStore
      .prepareDesktopCloudModelsForBootstrap()
      .catch(() => {}),
  ]);
  logBootstrapStage("parallel_prepare", prepareStartedAt);

  // OpenClaw reads a plugin's source once, at registration, and the local dev
  // stack starts it BEFORE the controller materializes plugins. Without this a
  // guard update only takes effect on the *next* OpenClaw start, which for
  // nexu-toolcall-guard means the previous version of a security control keeps
  // running after an upgrade.
  if ((pluginResult?.changedPluginIds?.size ?? 0) > 0) {
    logger.info(
      { changedPluginIds: [...(pluginResult?.changedPluginIds ?? [])] },
      "runtime_plugins_changed_restarting_openclaw",
    );
    await container.openclawProcess
      .restart("runtime-plugins-changed")
      .catch((err: unknown) => {
        logger.warn(
          {
            error: err instanceof Error ? err.message : String(err),
            changedPluginIds: [...(pluginResult?.changedPluginIds ?? [])],
          },
          "runtime_plugins_restart_failed",
        );
      });
  }

  // Validate default model against available models before first sync
  const modelValidationStartedAt = Date.now();
  await container.modelProviderService.ensureValidDefaultModel();
  logBootstrapStage("model_validation", modelValidationStartedAt);

  // Ensure bundled skills are on disk and the skill ledger is up to date
  // BEFORE the first config push.  Without this, the compiled agent
  // allowlist may be missing newly-bundled skills, causing them to be
  // invisible to the running agent until a restart.
  const skillhubStartedAt = Date.now();
  container.skillhubService.bootstrap();
  logBootstrapStage("skillhub_bootstrap", skillhubStartedAt);

  // Auto-install default experts on startup (fire-and-forget so startup
  // isn't blocked; failures are logged inside installDefaultExperts).
  void container.installDefaultExpertsFn().catch((err) => {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "default_experts_auto_install_failed",
    );
  });

  container.channelFallbackService.start();

  container.wsClient.onGatewayShutdown(({ restartExpectedMs }) => {
    if (restartExpectedMs !== null) {
      container.openclawProcess.noteControlledRestartExpected("ws-shutdown");
    }
  });

  if (container.openclawProcess.managesProcess()) {
    // Clear out agent databases a previous controller created for itself.
    // OpenClaw 2026.9 refuses to start against one and doctor refuses to repair
    // it, so this has to happen before the seed below — which then correctly
    // skips the absent files and lets OpenClaw create its own.
    await container.authProfilesStore.reclaimUnownedAgentDatabases();

    // Managed bootstrap: seed config before runtime start so the first attach
    // happens against the desired config instead of triggering a restart.
    const syncStartedAt = Date.now();
    await container.openclawSyncService.syncAllImmediate();
    container.openclawSyncService.beginSettling();
    logBootstrapStage("managed_sync", syncStartedAt);

    container.runtimeState.bootPhase = "starting-managed-runtime";
    container.openclawProcess.enableAutoRestart();
    const openclawStartStartedAt = Date.now();
    container.openclawProcess.start();
    container.wsClient.connect();
    logBootstrapStage("managed_openclaw_start", openclawStartStartedAt);

    container.runtimeState.bootPhase = "stabilizing-runtime";
    const stableStartedAt = Date.now();
    await waitForStableControlPlane(
      container,
      MANAGED_STABLE_CONTROL_PLANE_TIMEOUT_MS,
      STABLE_CONTROL_PLANE_WINDOW_MS,
    );
    logBootstrapStage("managed_stable_control_plane", stableStartedAt);
  } else {
    // launchd may start OpenClaw while the controller is still bootstrapping.
    // Seed plugins and config before connecting so an incompatible persisted
    // config cannot prevent the gateway from starting and deadlock bootstrap.
    logger.info({}, "controller_bootstrap_preparing_external_openclaw");

    container.runtimeState.bootPhase = "reconciling-runtime";
    const syncStartedAt = Date.now();
    const { configChanged } =
      await container.openclawSyncService.syncAllImmediate();
    container.openclawSyncService.beginSettling();
    logBootstrapStage("external_sync", syncStartedAt, { configChanged });

    container.runtimeState.bootPhase = "attaching-external-runtime";
    const gatewayStartedAt = Date.now();
    container.wsClient.connect();
    await waitForGatewayConnection(
      container,
      INITIAL_CONTROL_PLANE_READY_TIMEOUT_MS,
    );
    logBootstrapStage("external_gateway_connection", gatewayStartedAt);

    container.runtimeState.bootPhase = "stabilizing-runtime";
    const stableStartedAt = Date.now();
    const stableTimeoutMs =
      EXTERNAL_CONFIG_CHANGED_STABLE_CONTROL_PLANE_TIMEOUT_MS;
    const stableWindowMs = STABLE_CONTROL_PLANE_WINDOW_MS;
    // In external (launchd-supervised) mode a stability timeout must not
    // kill the controller: launchd would relaunch it, repeat the same
    // bootstrap, and the packaged app would loop on the loading screen.
    // Degrade to a warning and let the control-plane health loop and the
    // gateway WS reconnect logic converge after bootstrap instead.
    try {
      await waitForStableControlPlane(
        container,
        stableTimeoutMs,
        stableWindowMs,
      );
      logBootstrapStage("external_stable_control_plane", stableStartedAt, {
        configChanged,
        stableTimeoutMs,
        stableWindowMs,
      });
    } catch (err) {
      logger.warn(
        {
          configChanged,
          stableTimeoutMs,
          stableWindowMs,
          elapsedMs: Date.now() - stableStartedAt,
          error: err instanceof Error ? err.message : String(err),
        },
        "external_stable_control_plane_timeout_ignored",
      );
    }
  }

  // Register existing schedules with OpenClaw now that the WS connection
  // is established. Fire-and-forget so bootstrap isn't blocked.
  void container.scheduleService.bootstrap().catch((err) => {
    logger.warn(
      { error: err instanceof Error ? err.message : String(err) },
      "schedule_bootstrap_failed",
    );
  });

  container.runtimeState.bootPhase = "ready";
  logBootstrapStage("ready", bootstrapStartedAt);

  return container.startBackgroundLoops();
}
