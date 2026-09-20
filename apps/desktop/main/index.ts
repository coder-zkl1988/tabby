import { execFileSync } from "node:child_process";
import { existsSync, readlinkSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as Sentry from "@sentry/electron/main";
import {
  BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
  Tray,
  app,
  clipboard,
  crashReporter,
  dialog,
  globalShortcut,
  ipcMain,
  nativeImage,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  screen,
  session,
  shell,
  webContents,
} from "electron";
import { getOpenclawSkillsDir } from "../shared/desktop-paths";
import type {
  DesktopChromeMode,
  DesktopDeskpetMood,
  DesktopDeskpetMoodSource,
  DesktopDeskpetSize,
  DesktopSurface,
  HostDesktopCommand,
  RuntimeEvent,
  RuntimeState,
} from "../shared/host";
import { buildChildProcessProxyEnv } from "../shared/proxy-config";
import { getDesktopRuntimeConfig } from "../shared/runtime-config";
import { getDesktopSentryBuildMetadata } from "../shared/sentry-build-metadata";
import {
  shouldEnableDesktopUpdateManager,
  shouldStartDesktopPeriodicUpdateChecks,
} from "../shared/update-policy";
import { getDesktopAppRoot, getWorkspaceRoot } from "../shared/workspace-paths";
import { DesktopDiagnosticsReporter } from "./desktop-diagnostics";
import { exportDiagnostics, uploadDiagnostics } from "./diagnostics-export";
import {
  registerIpcHandlers,
  setComponentUpdater,
  setQuitFallback,
  setQuitHandlerOpts,
  setUpdateManager,
} from "./ipc";
import { getDesktopRuntimePlatformAdapter } from "./platforms";
import { resolveLaunchdPaths } from "./platforms/mac/launchd-paths";
import { expandHomePath } from "./platforms/shared/runtime-roots";
import type { PrepareForUpdateInstallArgs } from "./platforms/types";
import { RuntimeOrchestrator } from "./runtime/daemon-supervisor";
import {
  buildSkillNodePath,
  checkOpenclawExtractionNeeded,
  createRuntimeUnitManifests,
  extractOpenclawSidecarAsync,
  resolveOfficeCliBinary,
} from "./runtime/manifests";
import {
  type PortAllocation,
  PortAllocationError,
  allocateDesktopRuntimePorts,
} from "./runtime/port-allocation";
import {
  flushRuntimeLoggers,
  rotateDesktopLogSession,
  writeDesktopMainLog,
} from "./runtime/runtime-logger";
import {
  type LaunchdBootstrapResult,
  SERVICE_LABELS,
  bootstrapWithLaunchd,
  getDefaultPlistDir,
  getLogDir,
  installLaunchdQuitHandler,
  runTeardownAndExit,
  teardownLaunchdServices,
} from "./services";
import { AgentBrowserRelay } from "./services/agent-browser-relay";
import { broadcastDesktopCommandToTargets } from "./services/desktop-command-broadcast";
import {
  type DesktopShellPreferences,
  applyDesktopShellPreferencesOnStartup,
  getDesktopShellPreferences,
  readCrashReportsConsent,
  setDesktopShellPreferencesRuntimeHandler,
  updateDesktopShellPreferences,
} from "./services/desktop-shell-preferences";
import {
  startDesktopDevInspectServer,
  stopDesktopDevInspectServer,
} from "./services/dev-inspect-server";
import { isLaunchdBootstrapEnabled } from "./services/launchd-bootstrap";
import { ProxyManager } from "./services/proxy-manager";
import {
  captureExternalQuickChatSelection,
  stageQuickChatSelection,
} from "./services/quick-chat-selection";
import {
  isTelemetryActive,
  setCrashReportsConsentApplier,
  setTelemetryActive,
} from "./services/telemetry";
import { flushV8CoverageIfEnabled } from "./services/v8-coverage";
import { readPendingWindowsUserDataMigration } from "./services/windows-user-data-migration";
import { SleepGuard, type SleepGuardLogEntry } from "./sleep-guard";
import { ComponentUpdater, R2_BASE_URL } from "./updater/component-updater";
import { StartupHealthCheck } from "./updater/rollback";
import { UpdateManager } from "./updater/update-manager";
import {
  TRANSPARENT_WINDOW_BACKGROUND_COLOR,
  resolveDeskpetWindowChromeOptions,
  resolveMainWindowChromeOptions,
} from "./window-chrome";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Set display name early (matches productName in package.json).
app.setName("nexu");
nativeTheme.themeSource = "light";

/**
 * Electron's single-instance lock can be left stale by a prior crash, Force
 * Quit, or SIGKILL: the SingletonLock symlink + SingletonSocket survive in
 * userData even though no instance is running. requestSingleInstanceLock() then
 * fails on every subsequent launch and the app exits silently (just below),
 * before it ever reaches cold start — i.e. the app "won't start" forever. If the
 * lock's owner PID is provably dead, remove the stale singleton files so we can
 * re-acquire. Conservative: if any process still owns that PID (or we cannot
 * prove it dead), the lock is left untouched, so we never evict a live instance
 * or spawn a real second one.
 */
function cleanStaleSingletonLock(userDataPath: string): boolean {
  let pid = Number.NaN;
  try {
    const target = readlinkSync(join(userDataPath, "SingletonLock"));
    pid = Number.parseInt(target.slice(target.lastIndexOf("-") + 1), 10);
  } catch {
    return false; // no/unreadable lock symlink — nothing to recover
  }

  // Only reclaim a lock whose owner PID is provably DEAD (the crash / Force
  // Quit / SIGKILL case that orphaned the singleton files). If the PID is alive,
  // unparseable, or unprobeable (EPERM ⇒ a live owner under another user), leave
  // the lock alone — proving liveness by process name is unreliable (PID reuse),
  // and staying conservative means we never evict a live instance.
  if (!Number.isFinite(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0); // throws ESRCH if dead, EPERM if alive but foreign
    return false; // a process still owns this PID → assume a real instance
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") {
      return false; // EPERM / unknown → cannot prove dead, stay safe
    }
  }

  let removed = false;
  for (const name of ["SingletonLock", "SingletonSocket", "SingletonCookie"]) {
    try {
      rmSync(join(userDataPath, name), { force: true });
      removed = true;
    } catch {
      /* best effort */
    }
  }
  return removed;
}

let hasSingleInstanceLock = app.requestSingleInstanceLock();

if (!hasSingleInstanceLock) {
  // Self-heal a stale lock left by a prior crash / Force Quit so the app does
  // not silently refuse to start forever; retry once after cleaning it.
  if (cleanStaleSingletonLock(app.getPath("userData"))) {
    console.warn(
      "[desktop:singleton] removed stale single-instance lock from a prior unclean exit; retrying",
    );
    hasSingleInstanceLock = app.requestSingleInstanceLock();
  }
}

if (!hasSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

// Info.plist declares LSUIElement=true so that child processes (spawned with
// ELECTRON_RUN_AS_NODE) don't create extra Dock icons.  Show the dock icon
// BEFORE any blocking initialization (tar extraction, directory creation, etc.)
// so users see it immediately on first launch.
void app.dock?.show();

// In dev mode the raw Electron binary is used (no .app bundle), so macOS
// falls back to the default Electron atom icon.  Set the custom icon explicitly
// so the Dock shows the correct Nexu icon during local development.
if (!app.isPackaged && app.dock) {
  const devIcon = resolve(getDesktopAppRoot(), "build", "icon.png");
  app.dock.setIcon(devIcon);
}

const electronRoot = app.isPackaged
  ? process.resourcesPath
  : getDesktopAppRoot();
const baseRuntimeConfig = getDesktopRuntimeConfig(process.env, {
  appVersion: app.getVersion(),
  resourcesPath: app.isPackaged ? electronRoot : undefined,
  useBuildConfig: app.isPackaged,
});
const runtimePlatformAdapter =
  getDesktopRuntimePlatformAdapter(baseRuntimeConfig);
const useExternalRuntime = baseRuntimeConfig.runtimeMode === "external";
// In launchd mode, skip port probing — the bootstrap has its own port
// recovery via runtime-ports.json and handles leftover processes gracefully.
// Probing here would waste time and the results get overridden by attach anyway.
const useLaunchdMode = !useExternalRuntime && isLaunchdBootstrapEnabled();
const runtimeLifecycle = runtimePlatformAdapter.lifecycle;
const { allocations: runtimePortAllocations, runtimeConfig } =
  useLaunchdMode || useExternalRuntime
    ? {
        allocations: [] as PortAllocation[],
        runtimeConfig: baseRuntimeConfig,
      }
    : await allocateDesktopRuntimePorts(process.env, baseRuntimeConfig).catch(
        (error: unknown) => {
          if (error instanceof PortAllocationError) {
            throw new Error(
              `[desktop:ports] ${error.code} purpose=${error.purpose} ` +
                `preferredPort=${error.preferredPort ?? "n/a"} ${error.message}`,
            );
          }

          throw error;
        },
      );

const pendingUserDataMigration =
  app.isPackaged && process.platform === "win32"
    ? readPendingWindowsUserDataMigration()
    : null;
const runtimeRoots = runtimePlatformAdapter.capabilities.resolveRuntimeRoots({
  app,
  electronRoot,
  runtimeConfig,
});
if (!useLaunchdMode) {
  runtimePlatformAdapter.capabilities.stateMigrationPolicy.run({
    runtimeConfig,
    runtimeRoots,
    isPackaged: app.isPackaged,
    pendingUserDataMigration,
    log: (message) => {
      writeDesktopMainLog({
        source: "state-migration",
        stream: "system",
        kind: "lifecycle",
        message,
        logFilePath: resolve(
          app.getPath("userData"),
          "logs",
          "desktop-main.log",
        ),
      });
    },
  });
}

const needsSetupExtraction = checkOpenclawExtractionNeeded(
  electronRoot,
  app.getPath("userData"),
  app.isPackaged,
);

// Set env var BEFORE window creation so the preload can read it for bootstrap data.
if (needsSetupExtraction) {
  process.env.NEXU_NEEDS_SETUP_ANIMATION = "1";
}

if (!app.isPackaged && process.env.NEXU_DEV_IMMERSIVE !== "0") {
  process.env.NEXU_DEV_IMMERSIVE = "1";
}

const runtimeUnitManifests = createRuntimeUnitManifests(
  electronRoot,
  app.getPath("userData"),
  app.isPackaged,
  runtimeConfig,
);
const orchestrator = new RuntimeOrchestrator(runtimeUnitManifests);

// Disable Chromium's popup blocker.  window.open() inside webviews can lose
// "transient user activation" after async work (fetch → response → open),
// causing silent popup blocking.  All popups are already caught by
// setWindowOpenHandler and redirected to shell.openExternal, so this is safe.
app.commandLine.appendSwitch("disable-popup-blocking");

// Keep the renderer running at full speed when backgrounded — without
// these, Chromium pauses the setup-animation video the moment the user
// switches to another app, making the cold-start hand-off look broken.
app.commandLine.appendSwitch("disable-background-timer-throttling");
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

const sentryDsn = runtimeConfig.sentryDsn;
const embeddedWorkspaceTransparentCss = `
  html,
  body,
  #root {
    background: transparent !important;
    background-color: transparent !important;
  }
`;
const desktopDevInspectHost =
  process.env.NEXU_DESKTOP_DEV_INSPECT_HOST ?? "127.0.0.1";
const desktopDevInspectPort = Number.parseInt(
  process.env.NEXU_DESKTOP_DEV_INSPECT_PORT ?? "5181",
  10,
);
const desktopDevInspectToken =
  process.env.NEXU_DESKTOP_DEV_INSPECT_TOKEN ?? null;
const desktopDevServerUrl = process.env.NEXU_DESKTOP_DEV_SERVER_URL ?? null;

function readNativeCrashTestTitle(event: Sentry.Event): string | null {
  const taggedTitle =
    typeof event.tags?.["nexu.crash_title"] === "string"
      ? event.tags["nexu.crash_title"]
      : typeof event.extra?.["nexu.crash_title"] === "string"
        ? event.extra["nexu.crash_title"]
        : null;

  if (taggedTitle) {
    return taggedTitle;
  }

  const electronContext = event.contexts?.electron as
    | Record<string, unknown>
    | undefined;
  const crashpadTitle = electronContext?.["crashpad.nexu.crash_title"];

  return typeof crashpadTitle === "string" ? crashpadTitle : null;
}

function readNativeCrashTestKind(event: Sentry.Event): string | null {
  const taggedKind =
    typeof event.tags?.["nexu.crash_kind"] === "string"
      ? event.tags["nexu.crash_kind"]
      : null;

  if (taggedKind) {
    return taggedKind;
  }

  const electronContext = event.contexts?.electron as
    | Record<string, unknown>
    | undefined;
  const crashpadKind = electronContext?.["crashpad.nexu.crash_kind"];

  return typeof crashpadKind === "string" ? crashpadKind : null;
}

function startSentry(): void {
  if (!sentryDsn) {
    return;
  }
  const sentryBuildMetadata = getDesktopSentryBuildMetadata(
    runtimeConfig.buildInfo,
  );

  Sentry.init({
    dsn: sentryDsn,
    environment: app.isPackaged ? "production" : "development",
    release: sentryBuildMetadata.release,
    ...(sentryBuildMetadata.dist ? { dist: sentryBuildMetadata.dist } : {}),
    beforeSend(event) {
      const testTitle = readNativeCrashTestTitle(event);

      if (!testTitle) {
        return event;
      }

      const testKind = readNativeCrashTestKind(event);
      const firstException = event.exception?.values?.[0];
      const updatedException = event.exception?.values
        ? {
            ...event.exception,
            values: [
              {
                ...firstException,
                type: "Error",
                value: testTitle,
              },
              ...event.exception.values.slice(1),
            ],
          }
        : {
            values: [
              {
                type: "Error",
                value: testTitle,
              },
            ],
          };

      return {
        ...event,
        message: testTitle,
        exception: updatedException,
        fingerprint: [testTitle],
        tags: {
          ...event.tags,
          "nexu.crash_title": testTitle,
          ...(testKind ? { "nexu.crash_kind": testKind } : {}),
        },
      };
    },
  });

  Sentry.setContext("build", sentryBuildMetadata.buildContext);
  setTelemetryActive(true);
}

// The "崩溃报告 / Crash reports" toggle (default on) starts/stops reporting at
// runtime; index.ts owns the Sentry lifecycle, so it registers the applier here.
setCrashReportsConsentApplier((enabled) => {
  if (enabled) {
    if (!isTelemetryActive()) {
      startSentry();
    }
  } else {
    setTelemetryActive(false);
    void Sentry.close();
  }
});

if (sentryDsn && readCrashReportsConsent()) {
  startSentry();
} else {
  crashReporter.start({
    companyName: "nexu",
    productName: app.getName(),
    submitURL: "https://127.0.0.1/desktop-crash-reporter-disabled",
    uploadToServer: false,
    compress: true,
    ignoreSystemCrashHandler: false,
    extra: {
      environment: app.isPackaged ? "production" : "development",
    },
  });
}

let mainWindow: BrowserWindow | null = null;
let agentBrowserRelay: AgentBrowserRelay | null = null;
let deskpetWindow: BrowserWindow | null = null;
let deskpetSize: DesktopDeskpetSize = "medium";
let deskpetAlwaysOnTop = true;
let currentDeskpetMood: DesktopDeskpetMood = "idle";
let residentTray: Tray | null = null;
let launchdQuitOptsForResidentEntry:
  | Parameters<typeof installLaunchdQuitHandler>[0]
  | null = null;
let diagnosticsReporter: DesktopDiagnosticsReporter | null = null;

let unsubscribeIpc: (() => void) | null = null;
let unsubscribeDeskpetRuntime: (() => void) | null = null;
let systemTray: Tray | null = null;
let pendingMacResidentEntryPreferences: DesktopShellPreferences | null = null;

function isZhLocale(): boolean {
  return app.getLocale().toLowerCase().startsWith("zh");
}

function getWindowsTrayStrings(): {
  show: string;
  hide: string;
  quit: string;
} {
  if (isZhLocale()) {
    return {
      show: "显示 Tabby",
      hide: "隐藏 Tabby",
      quit: "退出 Tabby",
    };
  }

  return {
    show: "Show Tabby",
    hide: "Hide Tabby",
    quit: "Quit Tabby",
  };
}

function resolveWindowsTrayIconPath(): string {
  return app.isPackaged
    ? join(process.resourcesPath, "tray-icon.ico")
    : resolve(getDesktopAppRoot(), "build", "icon.ico");
}

function isForceQuitInProgress(): boolean {
  return Boolean((app as unknown as Record<string, unknown>).__nexuForceQuit);
}

function markForceQuitInProgress(): void {
  (app as unknown as Record<string, unknown>).__nexuForceQuit = true;
}

/** True if this is the x86_64 build running under Rosetta 2 on Apple Silicon. */
function isRunningUnderRosetta(): boolean {
  if (process.platform !== "darwin") return false;
  if (process.arch !== "x64") return false;
  try {
    const out = execFileSync(
      "/usr/sbin/sysctl",
      ["-n", "sysctl.proc_translated"],
      {
        encoding: "utf8",
        timeout: 1000,
      },
    ).trim();
    return out === "1";
  } catch {
    return false;
  }
}

/**
 * Resolve the latest arm64 dmg URL from the same update feed (channel) the
 * user is currently on, so the link mirrors what auto-update would install.
 * Reads runtimeConfig (not process.env) because packaged builds bake the
 * channel + feed URL into build-config.json, not live env vars.
 */
async function resolveLatestArm64DownloadUrl(): Promise<string> {
  const channel = runtimeConfig.updates.channel ?? "stable";
  const r2Origin = new URL(R2_BASE_URL).origin;
  const fallbackDmgUrl = `${r2Origin}/releases/tabby-latest-mac-arm64.dmg`;

  let baseUrl = `${R2_BASE_URL}/${channel}/arm64`;
  const feedOverride = runtimeConfig.urls.updateFeed;
  if (feedOverride) {
    try {
      const u = new URL(feedOverride);
      const trimmed = u.pathname.replace(/\/+$/, "");
      const swapped = trimmed.replace(/\/x64$/, "/arm64");
      u.pathname = swapped.endsWith("/arm64") ? swapped : `${swapped}/arm64`;
      u.search = "";
      u.hash = "";
      baseUrl = u.toString().replace(/\/+$/, "");
    } catch {}
  }

  const ymlUrl = `${baseUrl}/latest-mac.yml`;
  try {
    const res = await fetch(ymlUrl, { signal: AbortSignal.timeout(3000) });
    if (res.ok) {
      const manifest = await res.text();
      const dmgMatch = manifest.match(/url:\s*(\S+\.dmg)/);
      if (dmgMatch?.[1]) {
        return new URL(dmgMatch[1], `${baseUrl}/`).toString();
      }

      // Tabby's update feed intentionally publishes only the ZIP used by
      // electron-updater. Its matching manual-install DMG is versioned under
      // /releases/ on the same R2 origin.
      const zipMatch = manifest.match(/url:\s*(\S+\.zip)/);
      if (zipMatch?.[1] && new URL(baseUrl).origin === r2Origin) {
        const dmgName = zipMatch[1].replace(/\.zip$/, ".dmg");
        return new URL(dmgName, `${r2Origin}/releases/`).toString();
      }
    }
  } catch {}
  return fallbackDmgUrl;
}

/**
 * Block startup with a warning if the Intel build is running on Apple
 * Silicon under Rosetta 2 — the symptoms (slow startup, high CPU, sidecar
 * native bindings failing to load) give users no hint of the root cause.
 * Skipped in dev and skippable via NEXU_SKIP_ARCH_WARNING=1.
 */
async function warnIfRunningUnderRosetta(): Promise<void> {
  if (!app.isPackaged) return;
  if (process.env.NEXU_SKIP_ARCH_WARNING === "1") return;
  if (!isRunningUnderRosetta()) return;

  const downloadUrl = await resolveLatestArm64DownloadUrl();
  const isZh = app.getLocale().toLowerCase().startsWith("zh");
  const messageBox = isZh
    ? {
        title: "检测到架构不匹配",
        message: "正在 Apple Silicon Mac 上运行 Intel 版 Tabby",
        detail:
          "macOS 通过 Rosetta 2 翻译运行 Intel 版本，会导致：\n• 启动比正常慢 3-5 倍\n• 界面卡顿、CPU 占用过高\n• 部分原生模块可能加载失败\n\n请下载 Apple Silicon (arm64) 版本以获得最佳体验。",
        // Trailing space on the default-button label is a workaround for
        // electron/electron#40466 — non-standard button labels otherwise do
        // not get the macOS blue default-button highlight. The "(推荐)"
        // suffix is a textual fallback so the recommended action is still
        // obvious if the visual highlight ever stops working.
        downloadButton: "下载 arm64 版本（推荐） ",
        continueButton: "继续运行",
      }
    : {
        title: "Architecture mismatch detected",
        message: "Running the Intel build of Tabby on an Apple Silicon Mac",
        detail:
          "macOS is running this build through Rosetta 2 translation, which causes:\n• 3-5x slower startup\n• Laggy UI and high CPU usage\n• Possible native module load failures\n\nPlease download the Apple Silicon (arm64) build for the best experience.",
        downloadButton: "Download arm64 build (recommended) ",
        continueButton: "Continue anyway",
      };

  const result = await dialog.showMessageBox({
    type: "warning",
    title: messageBox.title,
    message: messageBox.message,
    detail: messageBox.detail,
    buttons: [messageBox.downloadButton, messageBox.continueButton],
    defaultId: 0,
    cancelId: 1,
    noLink: true,
  });

  if (result.response === 0) {
    void shell.openExternal(downloadUrl);
    app.exit(0);
  }
}

/**
 * Controls whether the Develop menu is visible. In local dev it starts enabled
 * so the menu matches today's default behavior, but the same shortcut can
 * still toggle it for validation. In packaged builds it starts disabled.
 */
let productionDebugMode = !app.isPackaged;
let sleepGuard: SleepGuard | null = null;
let launchdResult: LaunchdBootstrapResult | null = null;
let proxyManager: ProxyManager | null = null;

async function refreshProxyDiagnostics(): Promise<void> {
  if (!proxyManager) {
    return;
  }
  const targets = [
    { label: "controller", url: runtimeConfig.urls.controllerBase },
    { label: "openclaw", url: runtimeConfig.urls.openclawBase },
    { label: "external", url: "https://tabby.picaso.studio" },
  ];
  const snapshot = await proxyManager.collectDiagnostics(
    runtimeConfig.proxy,
    targets,
  );
  diagnosticsReporter?.setProxySnapshot(snapshot);
}

// ---------------------------------------------------------------------------
// Unified graceful shutdown — single authoritative teardown path.
// Called by: before-quit, SIGTERM, SIGINT, quit-handler, system shutdown.
// Idempotent: safe to call multiple times (second call is a no-op).
// ---------------------------------------------------------------------------

let shutdownInProgress = false;
const SHUTDOWN_HARD_TIMEOUT_MS = 8_000;

async function gracefulShutdown(reason: string): Promise<void> {
  if (shutdownInProgress) return;
  shutdownInProgress = true;

  writeDesktopMainLog({
    source: "shutdown",
    stream: "system",
    kind: "lifecycle",
    message: `graceful shutdown started: ${reason}`,
    logFilePath: null,
    windowId: null,
  });

  // Hard timeout: if teardown hangs, force exit after 8 seconds.
  const hardTimer = setTimeout(() => {
    writeDesktopMainLog({
      source: "shutdown",
      stream: "system",
      kind: "lifecycle",
      message: `graceful shutdown hard timeout (${SHUTDOWN_HARD_TIMEOUT_MS}ms), forcing exit`,
      logFilePath: null,
      windowId: null,
    });
    process.exit(1);
  }, SHUTDOWN_HARD_TIMEOUT_MS);

  try {
    sleepGuard?.dispose(reason);
    agentBrowserRelay?.stop();
    agentBrowserRelay = null;
    unsubscribeIpc?.();
    unsubscribeIpc = null;
    unsubscribeDeskpetRuntime?.();
    unsubscribeDeskpetRuntime = null;
    await diagnosticsReporter?.flushNow().catch(() => undefined);
    flushRuntimeLoggers();
    flushV8CoverageIfEnabled();

    if (launchdResult) {
      await teardownLaunchdServices({
        launchd: launchdResult.launchd,
        labels: launchdResult.labels,
        plistDir: getDefaultPlistDir(!app.isPackaged),
      });
    }

    await orchestrator.dispose().catch(() => undefined);
  } finally {
    clearTimeout(hardTimer);
  }
}

// Cold-start gate: IPC handler for `env:get-runtime-config` waits for this
// promise to resolve before returning, ensuring the renderer always gets the
// final config with correct ports (not the pre-cold-start defaults).
let resolveColdStartReady: () => void;
const coldStartReady = new Promise<void>((r) => {
  resolveColdStartReady = r;
});

logLaunchTimeline(
  `runtime ports ${runtimePortAllocations
    .map(
      (allocation) =>
        `${allocation.purpose}=${allocation.preferredPort}->${allocation.port} ` +
        `strategy=${allocation.strategy} attemptDelta=${allocation.attemptDelta}`,
    )
    .join(" ")}`,
);

function sendDesktopCommand(
  surface: DesktopSurface,
  chromeMode: DesktopChromeMode,
): void {
  mainWindow?.webContents.send("host:desktop-command", {
    type:
      chromeMode === "immersive" && surface !== "control"
        ? "develop:focus-surface"
        : "develop:show-shell",
    surface,
    chromeMode,
  });
}

function sendHostDesktopCommand(command: HostDesktopCommand): void {
  mainWindow?.webContents.send("host:desktop-command", command);
}

function broadcastHostDesktopCommand(command: HostDesktopCommand): void {
  broadcastDesktopCommandToTargets(webContents.getAllWebContents(), command);
}

function sendSetupProgress(stage: string, detail?: string): void {
  sendHostDesktopCommand({ type: "setup:progress", stage, detail });
}

const DESKPET_WINDOW_SIZES: Record<DesktopDeskpetSize, number> = {
  small: 210,
  medium: 315,
  large: 420,
};

const DESKPET_MOOD_LABELS: Record<DesktopDeskpetMood, string> = {
  "belly-rub": "摸肚皮",
  connection: "连接中",
  error: "异常提醒",
  idle: "待命",
  "lobster-replying": "龙虾回复中",
  peek: "偷看",
  rest: "休息",
  success: "成功",
  "tease-lobster": "逗龙虾",
  working: "认真工作",
  yawn: "打哈欠",
};

const DESKPET_AUTOMATION_DURATIONS: Partial<
  Record<DesktopDeskpetMood, number>
> = {
  "belly-rub": 2600,
  "lobster-replying": 4800,
  success: 3600,
  "tease-lobster": 4200,
  working: 2200,
  yawn: 2600,
};

const DESKPET_SELECTABLE_MOODS: DesktopDeskpetMood[] = [
  "connection",
  "error",
  "idle",
  "lobster-replying",
  "peek",
  "rest",
  "success",
  "tease-lobster",
  "working",
];

function runtimeHasPhase(
  runtimeState: RuntimeState,
  phases: Array<RuntimeState["units"][number]["phase"]>,
): boolean {
  return runtimeState.units.some((unit) => phases.includes(unit.phase));
}

function resolveDeskpetRuntimeMood(
  runtimeState: RuntimeState,
): DesktopDeskpetMood {
  if (runtimeHasPhase(runtimeState, ["failed"])) {
    return "error";
  }

  if (runtimeHasPhase(runtimeState, ["starting", "stopping"])) {
    return "connection";
  }

  if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) {
    return "rest";
  }

  if (runtimeHasPhase(runtimeState, ["running"])) {
    return "idle";
  }

  return "rest";
}

function getDeskpetWindowSize(): number {
  return DESKPET_WINDOW_SIZES[deskpetSize];
}

function sendDeskpetCommand(command: HostDesktopCommand): void {
  if (!deskpetWindow || deskpetWindow.isDestroyed()) {
    return;
  }

  deskpetWindow.webContents.send("host:desktop-command", command);
}

function applyDeskpetMood(
  mood: DesktopDeskpetMood,
  options?: {
    source?: DesktopDeskpetMoodSource;
    durationMs?: number;
    replyText?: string;
  },
): void {
  currentDeskpetMood = mood;
  sendDeskpetCommand({
    type: "deskpet:set-mood",
    mood,
    source: options?.source ?? "auto",
    durationMs: options?.durationMs,
    replyText: options?.replyText,
  });
}

function applyDeskpetRuntimeMood(): void {
  applyDeskpetMood(resolveDeskpetRuntimeMood(orchestrator.getRuntimeState()), {
    source: "runtime",
  });
}

function handleDeskpetRuntimeEvent(event: RuntimeEvent): void {
  if (event.type !== "runtime:unit-state") {
    return;
  }

  if (event.type === "runtime:unit-state" && event.unit.phase === "failed") {
    applyDeskpetMood("error", { source: "runtime" });
    return;
  }

  if (
    event.type === "runtime:unit-state" &&
    (event.unit.phase === "starting" || event.unit.phase === "stopping")
  ) {
    applyDeskpetMood("connection", { source: "runtime" });
    return;
  }

  applyDeskpetRuntimeMood();
}

function handleDeskpetActivity(
  mood: DesktopDeskpetMood,
  source: DesktopDeskpetMoodSource = "auto",
  durationMs = DESKPET_AUTOMATION_DURATIONS[mood],
  replyText?: string,
): void {
  applyDeskpetMood(mood, { source, durationMs, replyText });
}

ipcMain.on(
  "deskpet:activity",
  (
    _event,
    payload: {
      mood?: DesktopDeskpetMood;
      durationMs?: number;
      source?: DesktopDeskpetMoodSource;
      replyText?: string;
    },
  ) => {
    if (!payload || typeof payload !== "object") {
      return;
    }

    const mood = payload.mood;
    if (!mood || !(mood in DESKPET_MOOD_LABELS)) {
      return;
    }

    const durationMs =
      typeof payload.durationMs === "number" &&
      Number.isFinite(payload.durationMs)
        ? Math.max(500, Math.min(payload.durationMs, 10_000))
        : undefined;
    const replyText =
      typeof payload.replyText === "string" && payload.replyText.trim()
        ? payload.replyText.trim().slice(0, 280)
        : undefined;

    handleDeskpetActivity(
      mood,
      payload.source ?? "auto",
      durationMs,
      replyText,
    );
  },
);

function positionDeskpetWindow(window: BrowserWindow): void {
  const size = getDeskpetWindowSize();
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const margin = 36;

  window.setBounds({
    x: display.workArea.x + display.workArea.width - size - margin,
    y: display.workArea.y + display.workArea.height - size - margin,
    width: size,
    height: size,
  });
}

function setDeskpetSize(size: DesktopDeskpetSize): void {
  deskpetSize = size;
  if (deskpetWindow && !deskpetWindow.isDestroyed()) {
    const bounds = deskpetWindow.getBounds();
    const nextSize = getDeskpetWindowSize();
    deskpetWindow.setBounds({
      x: bounds.x,
      y: bounds.y,
      width: nextSize,
      height: nextSize,
    });
  }

  sendDeskpetCommand({ type: "deskpet:set-size", size });
}

function showDeskpetContextMenu(): void {
  if (!deskpetWindow || deskpetWindow.isDestroyed()) {
    return;
  }

  const moodItems: MenuItemConstructorOptions[] = DESKPET_SELECTABLE_MOODS.map(
    (mood) => ({
      label: DESKPET_MOOD_LABELS[mood],
      type: "radio",
      checked: currentDeskpetMood === mood,
      click: () => applyDeskpetMood(mood, { source: "manual" }),
    }),
  );

  const sizeItems: MenuItemConstructorOptions[] = [
    ["small", "小"],
    ["medium", "默认"],
    ["large", "大"],
  ].map(([size, label]) => ({
    label,
    type: "radio",
    checked: deskpetSize === size,
    click: () => setDeskpetSize(size as DesktopDeskpetSize),
  }));

  Menu.buildFromTemplate([
    {
      label: "打开 Tabby",
      click: () => {
        showMainWindowFromResidentEntry();
      },
    },
    { type: "separator" },
    { label: "状态", submenu: moodItems },
    { label: "大小", submenu: sizeItems },
    { type: "separator" },
    {
      label: "保持置顶",
      type: "checkbox",
      checked: deskpetAlwaysOnTop,
      click: (item) => {
        deskpetAlwaysOnTop = item.checked;
        deskpetWindow?.setAlwaysOnTop(deskpetAlwaysOnTop, "floating");
      },
    },
    {
      label: "隐藏桌宠",
      click: () => {
        updateDesktopShellPreferences({ deskpetEnabled: false });
      },
    },
  ]).popup({ window: deskpetWindow });
}

function showAboutDialog(): void {
  const version = app.getVersion();
  const detailLines = [
    `Version ${version}`,
    `Electron ${process.versions.electron}`,
    `Chromium ${process.versions.chrome}`,
    `Node ${process.versions.node}`,
  ];
  const options = {
    type: "info" as const,
    title: "About Tabby",
    message: "Tabby",
    detail: detailLines.join("\n"),
    buttons: ["OK"],
    noLink: true,
  };
  void (mainWindow
    ? dialog.showMessageBox(mainWindow, options)
    : dialog.showMessageBox(options));
}

function installApplicationMenu(): void {
  const developMenu: MenuItemConstructorOptions = {
    label: "Develop",
    submenu: [
      {
        label: "Focus Web Surface",
        accelerator: "CmdOrCtrl+Shift+1",
        click: () => sendDesktopCommand("web", "immersive"),
      },
      {
        label: "Focus OpenClaw Surface",
        accelerator: "CmdOrCtrl+Shift+2",
        click: () => sendDesktopCommand("openclaw", "immersive"),
      },
      { type: "separator" },
      {
        label: "Show Desktop Shell",
        accelerator: "CmdOrCtrl+Shift+0",
        click: () => sendDesktopCommand("control", "full"),
      },
      {
        label: "Hide Desktop Shell",
        accelerator: "CmdOrCtrl+Shift+H",
        click: () => sendDesktopCommand("web", "immersive"),
      },
      { type: "separator" },
      {
        label: "Set Test Balance…",
        click: () =>
          sendHostDesktopCommand({ type: "develop:open-set-balance" }),
      },
    ],
  };

  const helpSubmenu: MenuItemConstructorOptions[] = [
    {
      label: "Export Diagnostics…",
      click: () => {
        void exportDiagnostics({
          orchestrator,
          runtimeConfig,
          source: "help-menu",
        }).catch(() => undefined);
      },
    },
    {
      label: "Send Diagnostics to Support…",
      click: () => {
        void (async () => {
          const confirm = await dialog.showMessageBox({
            type: "question",
            buttons: ["Send", "Cancel"],
            defaultId: 0,
            cancelId: 1,
            message: "Send diagnostics to Tabby support?",
            detail:
              "Uploads a redacted diagnostics archive (logs, runtime state, config with credentials removed) so support can investigate your issue. You'll get a reference ID to share.",
          });
          if (confirm.response !== 0) {
            return;
          }
          const result = await uploadDiagnostics({
            orchestrator,
            runtimeConfig,
          });
          if (result.status === "success") {
            await dialog.showMessageBox({
              type: "info",
              message: "Diagnostics sent",
              detail: `Reference ID: ${result.referenceId}\n\nShare this ID with support so they can find your upload.`,
            });
          } else {
            await dialog.showMessageBox({
              type: "error",
              message: "Diagnostics upload failed",
              detail: result.errorMessage ?? "Unknown error.",
            });
          }
        })().catch(() => undefined);
      },
    },
  ];

  // On macOS About/Check-for-Updates live in the application menu by
  // platform convention. On Windows/Linux there is no app menu, so surface
  // them in Help instead (issue nexu-io/nexu#784).
  if (process.platform !== "darwin") {
    helpSubmenu.push(
      { type: "separator" },
      {
        id: "about-nexu",
        label: `About Tabby (v${app.getVersion()})`,
        click: () => showAboutDialog(),
      },
    );
  }

  const helpMenu: MenuItemConstructorOptions = {
    role: "help",
    submenu: helpSubmenu,
  };

  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === "darwin"
      ? ([
          {
            role: "appMenu",
            submenu: [
              // Explicit labels: the macOS app menu auto-names About/Hide/Quit
              // from app.getName() which is "nexu" (kept for internal paths), so
              // without these the menu bar would read "About nexu" etc.
              { role: "about", label: "About Tabby" },
              { type: "separator" },
              { role: "services" },
              { type: "separator" },
              { role: "hide", label: "Hide Tabby" },
              { role: "hideOthers" },
              { role: "unhide" },
              { type: "separator" },
              { role: "quit", label: "Quit Tabby" },
            ],
          },
        ] satisfies MenuItemConstructorOptions[])
      : []),
    {
      label: "File",
      submenu: [
        {
          label: "Quick Chat",
          accelerator: "CommandOrControl+Shift+Space",
          click: () => openDesktopQuickChat(),
        },
        { type: "separator" },
        { role: "close" },
      ],
    },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        // Reload shortcuts are dev-only — in production they expose
        // internal "starting local service" screens (see #399).
        // They can be unlocked at runtime via Cmd/Ctrl+Shift+Alt+D.
        ...(productionDebugMode
          ? ([
              { role: "reload" },
              { role: "forceReload" },
              { type: "separator" },
            ] satisfies MenuItemConstructorOptions[])
          : []),
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    ...(productionDebugMode ? [developMenu] : []),
    { role: "windowMenu" },
    helpMenu,
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function getDesktopLogFilePath(name: string): string {
  return resolve(app.getPath("userData"), "logs", name);
}

function getMainWindowId(): number | null {
  return mainWindow?.webContents.id ?? null;
}

function startAgentBrowserRelay(): void {
  if (agentBrowserRelay) return;
  agentBrowserRelay = new AgentBrowserRelay({
    controllerBaseUrl: runtimeConfig.urls.controllerBase,
    getWindow: () => mainWindow,
    onOpen: (url, sessionKey, tabId) => {
      // The browser view is already loading; the panel is how the user gets to
      // watch it, so raise it in the window that owns the view.
      if (!mainWindow || mainWindow.isDestroyed()) return;
      if (!mainWindow.isVisible()) mainWindow.show();
      broadcastHostDesktopCommand({
        type: "browser:agent-opened",
        tabId,
        url,
        sessionKey,
      });
    },
    onRunEnded: (sessionKey) => {
      broadcastHostDesktopCommand({
        type: "browser:agent-run-ended",
        sessionKey,
      });
    },
    onLog: (message) => {
      console.error(`[agent-browser] ${message}`);
      writeDesktopMainLog({
        source: "agent-browser",
        stream: "stderr",
        kind: "lifecycle",
        message,
        logFilePath: getDesktopLogFilePath("agent-browser.log"),
        windowId: getMainWindowId(),
      });
    },
  });
  agentBrowserRelay.start();
}

function logColdStart(message: string): void {
  writeDesktopMainLog({
    source: "cold-start",
    stream: "system",
    kind: "lifecycle",
    message,
    logFilePath: getDesktopLogFilePath("cold-start.log"),
    windowId: getMainWindowId(),
  });
}

function logLaunchTimeline(message: string): void {
  const launchId = process.env.NEXU_DESKTOP_LAUNCH_ID ?? "unknown";
  writeDesktopMainLog({
    source: "launch-timeline",
    stream: "system",
    kind: "lifecycle",
    message: `${message} launchId=${launchId}`,
    logFilePath: getDesktopLogFilePath("desktop-main.log"),
    windowId: getMainWindowId(),
  });
}

function logRendererEvent({
  source,
  stream,
  kind,
  message,
  windowId,
}: {
  source: string;
  stream: "stdout" | "stderr";
  kind: "app" | "lifecycle";
  message: string;
  windowId?: number | null;
}): void {
  writeDesktopMainLog({
    source,
    stream,
    kind,
    message,
    logFilePath: getDesktopLogFilePath("desktop-main.log"),
    windowId,
  });
}

function logSleepGuard(entry: SleepGuardLogEntry): void {
  writeDesktopMainLog({
    source: "sleep-guard",
    stream: entry.stream,
    kind: entry.kind,
    message: entry.message,
    logFilePath: getDesktopLogFilePath("desktop-main.log"),
    windowId: getMainWindowId(),
  });
}

async function waitForControllerReadiness(): Promise<void> {
  const startedAt = Date.now();
  const timeoutMs = 15_000;
  const probeUrl = new URL("/health", runtimeConfig.urls.controllerBase);
  let attempt = 0;

  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(probeUrl, {
        headers: {
          Accept: "application/json",
        },
      });

      if (response.status < 500) {
        logColdStart(
          `controller ready via ${probeUrl.pathname} status=${response.status} after ${Date.now() - startedAt}ms`,
        );
        return;
      }
    } catch {
      // Ignore transient startup failures while the controller starts.
    }

    // Adaptive polling: start aggressive (50ms), increase to 250ms
    const delay = Math.min(50 + attempt * 50, 250);
    await new Promise((resolve) => setTimeout(resolve, delay));
    attempt++;
  }

  throw new Error(
    `Controller readiness probe timed out for ${probeUrl.toString()}`,
  );
}

async function runDesktopColdStart(): Promise<void> {
  diagnosticsReporter?.markColdStartRunning("starting controller");
  logColdStart("starting controller");
  sendSetupProgress("starting_controller");
  await orchestrator.startOne("controller");

  diagnosticsReporter?.markColdStartRunning("waiting for controller readiness");
  logColdStart("waiting for controller readiness");
  sendSetupProgress("waiting_controller");
  await waitForControllerReadiness();

  diagnosticsReporter?.markColdStartRunning("starting web");
  logColdStart("starting web");
  sendSetupProgress("starting_web");
  await orchestrator.startOne("web");

  const sessionId = rotateDesktopLogSession();
  logColdStart(`cold start session ready sessionId=${sessionId}`);

  logColdStart("cold start complete");
  sendSetupProgress("complete");
  diagnosticsReporter?.markColdStartSucceeded();
}

async function runLaunchdColdStart(): Promise<void> {
  const launchdColdStartStartedAt = Date.now();
  diagnosticsReporter?.markColdStartRunning("launchd bootstrap");
  logColdStart("starting launchd bootstrap");
  sendSetupProgress("launchd_bootstrap");

  const isDev = !app.isPackaged;
  const nexuHome = expandHomePath(runtimeConfig.paths.nexuHome);
  const runtimeRoots = runtimePlatformAdapter.capabilities.resolveRuntimeRoots({
    app,
    electronRoot,
    runtimeConfig,
  });

  const { openclawRuntimeRoot, openclawStateDir, openclawConfigPath } =
    runtimeRoots;

  const resolvePathsStartedAt = Date.now();
  const paths = await resolveLaunchdPaths(
    app.isPackaged,
    electronRoot,
    app.getVersion(),
    logColdStart,
    app.isPackaged ? runtimeRoots.runtimeRoot : undefined,
  );
  logColdStart(
    `launchd path resolution complete after ${Date.now() - resolvePathsStartedAt}ms`,
  );

  runtimePlatformAdapter.capabilities.stateMigrationPolicy.run({
    runtimeConfig,
    runtimeRoots,
    isPackaged: app.isPackaged,
    pendingUserDataMigration: null,
    log: (message) => logColdStart(`state-migration: ${message}`),
  });

  // In dev mode, serve web app from apps/web/dist
  // In packaged mode, serve from resources/web
  const webRoot = isDev
    ? resolve(getWorkspaceRoot(), "apps", "web", "dist")
    : resolve(electronRoot, "runtime", "web", "dist");

  const repoRoot = getWorkspaceRoot();
  const userDataPath = app.getPath("userData");
  const openclawSkillsDir = getOpenclawSkillsDir(userDataPath);
  const openclawTmpDir = resolve(openclawRuntimeRoot, "tmp");
  const openclawBinPath =
    process.env.NEXU_OPENCLAW_BIN ?? paths.openclawBinPath;
  const openclawExtensionsDir = paths.openclawExtensionsDir;
  const skillhubStaticSkillsDir = app.isPackaged
    ? resolve(electronRoot, "static/bundled-skills")
    : resolve(repoRoot, "apps/desktop/static/bundled-skills");
  const experthubStaticExpertsDir = app.isPackaged
    ? resolve(electronRoot, "static/bundled-experts")
    : resolve(repoRoot, "apps/desktop/static/bundled-experts");
  const platformTemplatesDir = app.isPackaged
    ? resolve(electronRoot, "static/platform-templates")
    : resolve(repoRoot, "apps/controller/static/platform-templates");
  const skillNodePath = buildSkillNodePath(electronRoot, app.isPackaged);
  const officeCliBinPath = resolveOfficeCliBinary(electronRoot, app.isPackaged);
  const proxyEnv = buildChildProcessProxyEnv(runtimeConfig.proxy);

  const bootstrapStartedAt = Date.now();
  launchdResult = await bootstrapWithLaunchd({
    isDev,
    controllerPort: runtimeConfig.ports.controller,
    openclawPort: Number(
      new URL(runtimeConfig.urls.openclawBase).port || 18789,
    ),
    nexuHome,
    gatewayToken: isDev ? undefined : runtimeConfig.tokens.gateway,
    webPort: runtimeConfig.ports.web,
    webRoot,
    plistDir: getDefaultPlistDir(isDev),
    ...paths,
    openclawConfigPath,
    openclawStateDir,
    officeCliBinPath,
    // Controller-specific env vars
    webUrl: runtimeConfig.urls.web,
    openclawSkillsDir,
    skillhubStaticSkillsDir,
    experthubStaticExpertsDir,
    platformTemplatesDir,
    openclawBinPath,
    openclawExtensionsDir,
    localAutomationPreviewEnabled:
      isDev || runtimeConfig.localAutomationPreviewEnabled ? "true" : undefined,
    skillNodePath,
    openclawTmpDir,
    proxyEnv,
    posthogApiKey:
      process.env.POSTHOG_API_KEY ?? runtimeConfig.posthogApiKey ?? undefined,
    posthogHost:
      process.env.POSTHOG_HOST ?? runtimeConfig.posthogHost ?? undefined,
    langfusePublicKey:
      process.env.LANGFUSE_PUBLIC_KEY ??
      runtimeConfig.langfusePublicKey ??
      undefined,
    langfuseSecretKey:
      process.env.LANGFUSE_SECRET_KEY ??
      runtimeConfig.langfuseSecretKey ??
      undefined,
    langfuseBaseUrl:
      process.env.LANGFUSE_BASE_URL ??
      runtimeConfig.langfuseBaseUrl ??
      undefined,
    log: (message: string) => logColdStart(message),
    nodeV8Coverage: process.env.NODE_V8_COVERAGE,
    desktopE2ECoverage: process.env.NEXU_DESKTOP_E2E_COVERAGE,
    desktopE2ECoverageRunId: process.env.NEXU_DESKTOP_E2E_COVERAGE_RUN_ID,
    controllerStartupValidationTimeoutMs: app.isPackaged ? 120_000 : undefined,
    appVersion: app.getVersion(),
    userDataPath: app.getPath("userData"),
    buildSource:
      process.env.NEXU_DESKTOP_BUILD_SOURCE ??
      (app.isPackaged ? "packaged" : "local-dev"),
  });
  logColdStart(
    `bootstrapWithLaunchd returned after ${Date.now() - bootstrapStartedAt}ms isAttach=${launchdResult.isAttach}`,
  );

  // Wire launchd-managed units into the orchestrator so the control plane
  // shows correct status, and Start/Stop buttons work via launchd.
  const launchdLogDir = getLogDir(isDev ? nexuHome : undefined);
  orchestrator.enableLaunchdMode(
    launchdResult.launchd,
    {
      controller: SERVICE_LABELS.controller(isDev),
      openclaw: SERVICE_LABELS.openclaw(isDev),
    },
    launchdLogDir,
  );

  // Always sync runtimeConfig with actual effective ports — these may differ
  // from the initial config if ports were recovered from a previous session or
  // OS-assigned due to conflicts.
  const { controllerPort, openclawPort, webPort } =
    launchdResult.effectivePorts;
  runtimeConfig.ports.controller = controllerPort;
  runtimeConfig.ports.web = webPort;
  runtimeConfig.urls.controllerBase = `http://127.0.0.1:${controllerPort}`;
  runtimeConfig.urls.web = `http://127.0.0.1:${webPort}`;
  runtimeConfig.urls.openclawBase = `http://127.0.0.1:${openclawPort}`;

  if (launchdResult.isAttach) {
    logColdStart(
      `attached to running services (controller=${controllerPort} openclaw=${openclawPort} web=${webPort})`,
    );
    sendSetupProgress("attached");
  } else {
    logColdStart("launchd services started, waiting for controller readiness");
    diagnosticsReporter?.markColdStartRunning(
      "waiting for controller readiness",
    );
    sendSetupProgress("waiting_controller");
  }

  const controllerReadyStartedAt = Date.now();
  const controllerReady = await launchdResult.controllerReady;
  logColdStart(
    `controller readiness promise settled after ${Date.now() - controllerReadyStartedAt}ms ok=${controllerReady.ok}`,
  );
  if (!controllerReady.ok) {
    throw controllerReady.error;
  }
  if (!launchdResult.isAttach) {
    logColdStart("controller ready");
  }

  const sessionId = rotateDesktopLogSession();
  logColdStart(
    `launchd cold start complete sessionId=${sessionId} totalMs=${Date.now() - launchdColdStartStartedAt}`,
  );
  sendSetupProgress("complete");
  diagnosticsReporter?.markColdStartSucceeded();
}

function focusMainWindow(): void {
  if (!mainWindow) {
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }
  if (mainWindow.isMinimized()) {
    mainWindow.restore();
  }

  mainWindow.focus();
}

function shouldUseResidentEntry(preferences: DesktopShellPreferences): boolean {
  if (process.platform === "darwin") {
    return true;
  }

  return !preferences.showInDock;
}

function resolveTrayIconPath(): string | null {
  const candidate =
    process.platform === "darwin"
      ? app.isPackaged
        ? join(process.resourcesPath, "tray-icon-mac.png")
        : resolve(getDesktopAppRoot(), "build", "tray-icon-mac.png")
      : resolve(
          app.isPackaged ? process.resourcesPath : getDesktopAppRoot(),
          "build",
          process.platform === "win32" ? "icon.ico" : "icon.png",
        );

  return existsSync(candidate) ? candidate : null;
}

function hideMainWindowToBackground(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    return;
  }

  mainWindow.hide();
}

function hideMainWindowToTray(): void {
  hideMainWindowToBackground();
}

function showDeskpetWindow(): void {
  const preferences = getDesktopShellPreferences();
  if (!preferences.deskpetEnabled) {
    return;
  }

  if (!deskpetWindow || deskpetWindow.isDestroyed()) {
    createDeskpetWindow();
    return;
  }

  deskpetWindow.showInactive();
}

function openDesktopQuickChat(): void {
  stageQuickChatSelection(
    captureExternalQuickChatSelection({
      readClipboardText: () =>
        clipboard.readText("selection").trim() || clipboard.readText().trim(),
    }),
  );
  const window = createDeskpetWindow();
  const openComposer = (): void => {
    if (window.isDestroyed()) return;
    window.show();
    window.focus();
    window.webContents.send("host:desktop-command", {
      type: "deskpet:open-composer",
    } satisfies HostDesktopCommand);
  };
  if (window.webContents.isLoadingMainFrame() || !window.webContents.getURL()) {
    window.webContents.once("did-finish-load", openComposer);
    return;
  }
  openComposer();
}

function applyDeskpetPreference(preferences: DesktopShellPreferences): void {
  if (preferences.deskpetEnabled) {
    if (!mainWindow || mainWindow.isDestroyed()) {
      return;
    }

    showDeskpetWindow();
    return;
  }

  if (deskpetWindow && !deskpetWindow.isDestroyed()) {
    deskpetWindow.hide();
  }
  updateSystemTrayMenu();
  updateResidentTrayMenu();
}

function updateSystemTrayMenu(): void {
  if (!systemTray) {
    return;
  }

  const trayStrings = getWindowsTrayStrings();

  const isVisible = Boolean(
    mainWindow && !mainWindow.isDestroyed() && mainWindow.isVisible(),
  );
  const isDeskpetVisible = Boolean(
    deskpetWindow && !deskpetWindow.isDestroyed() && deskpetWindow.isVisible(),
  );
  const shellPreferences = getDesktopShellPreferences();

  systemTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "快捷对话",
        click: () => openDesktopQuickChat(),
      },
      { type: "separator" },
      {
        label: isVisible ? trayStrings.hide : trayStrings.show,
        click: () => {
          if (isVisible) {
            hideMainWindowToBackground();
            return;
          }

          showMainWindowFromResidentEntry();
        },
      },
      {
        label: shellPreferences.deskpetEnabled
          ? isDeskpetVisible
            ? "隐藏桌宠"
            : "显示桌宠"
          : "桌宠已关闭",
        enabled: shellPreferences.deskpetEnabled,
        click: () => {
          if (isDeskpetVisible) {
            deskpetWindow?.hide();
            return;
          }

          showDeskpetWindow();
        },
      },
      { type: "separator" },
      {
        label: trayStrings.quit,
        click: () => {
          markForceQuitInProgress();
          app.quit();
        },
      },
    ]),
  );
}

function showSystemTrayMenu(): void {
  if (!systemTray) {
    return;
  }

  updateSystemTrayMenu();
  systemTray.popUpContextMenu();
}

function showMainWindowFromResidentEntry(): void {
  const preferences = getDesktopShellPreferences();

  if (process.platform === "darwin" && preferences.showInDock) {
    void app.dock?.show();
  }

  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }

  if (!mainWindow.isVisible()) {
    mainWindow.show();
  }

  focusMainWindow();
}

function destroyResidentTray(): void {
  residentTray?.destroy();
  residentTray = null;
}

function showResidentTrayMenu(): void {
  if (!residentTray) {
    return;
  }

  updateResidentTrayMenu();
  residentTray.popUpContextMenu();
}

function updateResidentTrayMenu(): void {
  if (!residentTray) {
    return;
  }

  const isDeskpetVisible = Boolean(
    deskpetWindow && !deskpetWindow.isDestroyed() && deskpetWindow.isVisible(),
  );
  const shellPreferences = getDesktopShellPreferences();

  residentTray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: "Quick Chat",
        click: () => openDesktopQuickChat(),
      },
      { type: "separator" },
      {
        label: "Open Tabby",
        click: () => {
          showMainWindowFromResidentEntry();
        },
      },
      {
        label: shellPreferences.deskpetEnabled
          ? isDeskpetVisible
            ? "Hide Deskpet"
            : "Show Deskpet"
          : "Deskpet Off",
        enabled: shellPreferences.deskpetEnabled,
        click: () => {
          if (isDeskpetVisible) {
            deskpetWindow?.hide();
            return;
          }

          showDeskpetWindow();
        },
      },
      { type: "separator" },
      {
        label: "Quit",
        click: () => {
          if (app.isPackaged && launchdQuitOptsForResidentEntry) {
            void runTeardownAndExit(
              launchdQuitOptsForResidentEntry,
              "tray-quit",
            );
            return;
          }

          markForceQuitInProgress();
          app.quit();
        },
      },
    ]),
  );
}

function ensureResidentTray(): void {
  if (residentTray) {
    return;
  }

  const trayIconPath = resolveTrayIconPath();
  if (!trayIconPath) {
    return;
  }

  let trayIcon = nativeImage.createFromPath(trayIconPath);
  if (trayIcon.isEmpty()) {
    return;
  }

  if (process.platform === "darwin") {
    trayIcon = trayIcon.resize({ height: 18 });
    trayIcon.setTemplateImage(true);
  }

  const tray = new Tray(trayIcon);
  residentTray = tray;
  tray.setToolTip("Tabby");
  updateResidentTrayMenu();
  tray.on("click", () => {
    showResidentTrayMenu();
  });
  tray.on("right-click", () => {
    showResidentTrayMenu();
  });
}

async function ensureWindowsTray(): Promise<void> {
  if (process.platform !== "win32" || !app.isPackaged || systemTray) {
    return;
  }

  const trayIconPath = resolveWindowsTrayIconPath();
  const trayIcon = nativeImage.createFromPath(trayIconPath);

  if (!trayIcon || trayIcon.isEmpty()) {
    return;
  }

  systemTray = new Tray(trayIcon);
  systemTray.setToolTip("Tabby");
  updateSystemTrayMenu();

  systemTray.on("click", () => {
    showSystemTrayMenu();
  });

  systemTray.on("right-click", () => {
    showSystemTrayMenu();
  });
}

function broadcastShellPreferencesUpdated(): void {
  for (const contents of webContents.getAllWebContents()) {
    if (!contents.isDestroyed()) {
      contents.send("host:desktop-command", {
        type: "desktop:shell-preferences-updated",
      });
    }
  }
}

function applyResidentEntryPreferences(
  preferences: DesktopShellPreferences,
): void {
  if (process.platform === "darwin") {
    const window = mainWindow;
    if (window && !window.isDestroyed() && window.isFullScreen()) {
      pendingMacResidentEntryPreferences = preferences;
      window.setFullScreen(false);
      return;
    }

    pendingMacResidentEntryPreferences = null;
    app.setActivationPolicy(preferences.showInDock ? "regular" : "accessory");
    if (preferences.showInDock) {
      void app.dock?.show();
    } else {
      app.dock?.hide();
    }
  }

  if (process.platform === "win32" && mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.setSkipTaskbar(!preferences.showInDock);
  }

  if (process.platform !== "win32" && shouldUseResidentEntry(preferences)) {
    ensureResidentTray();
  } else {
    destroyResidentTray();
  }

  applyDeskpetPreference(preferences);
}

function shouldHideOnWindowClose(): boolean {
  if (!app.isPackaged) {
    return false;
  }

  if (process.platform === "darwin") {
    return true;
  }

  if (process.platform === "win32") {
    return systemTray !== null;
  }

  return shouldUseResidentEntry(getDesktopShellPreferences());
}
app.on("second-instance", () => {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }

  showMainWindowFromResidentEntry();
  focusMainWindow();
});

app.on("before-quit", () => {
  stopDesktopDevInspectServer().catch((error) => {
    writeDesktopMainLog({
      source: "dev-inspect",
      stream: "stderr",
      kind: "app",
      message: `desktop dev inspect server failed to stop error=${error instanceof Error ? error.message : String(error)}`,
      logFilePath: null,
    });
  });
});

function createMainWindow(): BrowserWindow {
  logLaunchTimeline("main window creation requested");
  const isMacOS = process.platform === "darwin";
  const shellPreferences = getDesktopShellPreferences();
  const window = new BrowserWindow({
    width: 1280,
    height: 720,
    minWidth: needsSetupExtraction ? 1280 : 1120,
    minHeight: 720,
    title: "tabby",
    ...resolveMainWindowChromeOptions(process.platform),
    show: false,
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      webviewTag: true,
      // Window-level backup for the disable-renderer-backgrounding flag.
      backgroundThrottling: false,
    },
  });

  if (process.platform === "win32") {
    window.setSkipTaskbar(!shellPreferences.showInDock);
  }

  // Disable sandbox for the trusted app surface so its preload can expose the
  // host bridge. Arbitrary browser pages live in sandboxed WebContentsViews.
  window.webContents.on(
    "will-attach-webview",
    (_event, webPreferences, _params) => {
      webPreferences.sandbox = false;
    },
  );

  // Per-webContents handler is set globally via app.on('web-contents-created')
  // so we don't need one here on the main window.

  if (isMacOS) {
    window.setBackgroundColor("#00000000");
    window.setVibrancy("sidebar");
  }

  // Electron keeps dispatching webContents events while a window tears down,
  // and every listener below reads `window` / `window.webContents`. Touching
  // either after destruction throws "Object has been destroyed", which is fatal
  // in the main process — for work that is only diagnostic or cosmetic. Bail
  // once the window is gone instead.
  window.webContents.on("console-message", (details) => {
    if (window.isDestroyed()) return;
    logRendererEvent({
      source: `renderer:${details.level}`,
      stream: details.level === "error" ? "stderr" : "stdout",
      kind: "app",
      message: `${details.message} (${details.sourceId}:${details.lineNumber})`,
      windowId: window.webContents.id,
    });
  });

  window.webContents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl) => {
      if (window.isDestroyed()) return;
      diagnosticsReporter?.recordStartupProbe({
        source: "main",
        stage: "main:renderer-did-fail-load",
        status: "error",
        detail: `${errorCode} ${errorDescription} ${validatedUrl}`,
      });
      diagnosticsReporter?.recordRendererDidFailLoad({
        errorCode,
        errorDescription,
        validatedUrl,
      });
      logRendererEvent({
        source: "renderer:fail-load",
        stream: "stderr",
        kind: "lifecycle",
        message: `${errorCode} ${errorDescription} ${validatedUrl}`,
        windowId: window.webContents.id,
      });
    },
  );

  window.webContents.on("did-finish-load", () => {
    if (window.isDestroyed()) return;
    diagnosticsReporter?.recordStartupProbe({
      source: "main",
      stage: "main:renderer-did-finish-load",
      status: "ok",
      detail: window.webContents.getURL(),
    });
    diagnosticsReporter?.recordRendererDidFinishLoad(
      window.webContents.getURL(),
    );
    logRendererEvent({
      source: "renderer",
      stream: "stdout",
      kind: "lifecycle",
      message: `did-finish-load ${window.webContents.getURL()}`,
      windowId: window.webContents.id,
    });
  });

  window.webContents.on("render-process-gone", (_event, details) => {
    if (window.isDestroyed()) return;
    diagnosticsReporter?.recordStartupProbe({
      source: "main",
      stage: "main:renderer-process-gone",
      status: "error",
      detail: `reason=${details.reason} exitCode=${details.exitCode}`,
    });
    diagnosticsReporter?.recordRendererProcessGone({
      reason: details.reason,
      exitCode: details.exitCode,
    });
    logRendererEvent({
      source: "renderer:gone",
      stream: "stderr",
      kind: "lifecycle",
      message: `reason=${details.reason} exitCode=${details.exitCode}`,
      windowId: window.webContents.id,
    });
  });

  window.once("ready-to-show", () => {
    diagnosticsReporter?.recordStartupProbe({
      source: "main",
      stage: "main:window-ready-to-show",
      status: "ok",
      detail: window.webContents.getURL(),
    });
    logLaunchTimeline("main window ready-to-show");
    if (isMacOS && !needsSetupExtraction) {
      // Only apply vibrancy after ready-to-show when NOT in setup mode.
      // During setup, vibrancy is applied after the animation finishes
      // to avoid the transparent background showing through the video.
      window.setBackgroundColor("#00000000");
      window.setVibrancy("sidebar");
    }
    if (!window.isVisible()) {
      window.show();
      focusMainWindow();
    }
  });

  window.on("closed", () => {
    if (mainWindow === window) {
      mainWindow = null;
    }

    applyDeskpetRuntimeMood();
    updateSystemTrayMenu();
  });

  window.on("close", (event) => {
    if (process.platform !== "win32" || !app.isPackaged) {
      return;
    }

    if (!systemTray) {
      return;
    }

    if (isForceQuitInProgress()) {
      return;
    }

    event.preventDefault();
    hideMainWindowToTray();
  });

  window.on("show", () => {
    applyDeskpetRuntimeMood();
    updateSystemTrayMenu();
  });

  window.on("hide", () => {
    applyDeskpetMood("rest", { source: "runtime" });
    updateSystemTrayMenu();
  });

  window.on("leave-full-screen", () => {
    if (mainWindow !== window || !pendingMacResidentEntryPreferences) {
      return;
    }

    const pendingPreferences = pendingMacResidentEntryPreferences;
    pendingMacResidentEntryPreferences = null;
    applyResidentEntryPreferences(pendingPreferences);
  });

  window.on("close", (event) => {
    if ((app as unknown as Record<string, unknown>).__nexuForceQuit) {
      return;
    }

    if (!launchdResult && shouldHideOnWindowClose()) {
      event.preventDefault();
      hideMainWindowToBackground();
    }
  });

  // During first install / post-update, show the window IMMEDIATELY with a
  // white background — before loadFile, before React, before anything.
  // This eliminates the 10-20s blank screen while the Electron main process
  // is doing sidecar extraction / launchd bootstrap in the background.
  // The white background matches the animation overlay seamlessly.
  if (needsSetupExtraction) {
    logLaunchTimeline("setup animation: showing window immediately");
    window.setBackgroundColor("#ffffff");
    window.show();
    focusMainWindow();
  }

  const desktopRendererEntryPath = resolve(__dirname, "../../dist/index.html");
  const desktopRendererTarget =
    !app.isPackaged && desktopDevServerUrl
      ? desktopDevServerUrl
      : desktopRendererEntryPath;

  if (!app.isPackaged && desktopDevServerUrl) {
    void window.loadURL(desktopDevServerUrl);
  } else {
    void window.loadFile(desktopRendererEntryPath);
  }
  diagnosticsReporter?.recordStartupProbe({
    source: "main",
    stage: "main:window-load-dispatched",
    status: "ok",
    detail: desktopRendererTarget,
  });
  logLaunchTimeline(
    !app.isPackaged && desktopDevServerUrl
      ? "main window loadURL dispatched"
      : "main window loadFile dispatched",
  );
  mainWindow = window;
  return window;
}

function createDeskpetWindow(): BrowserWindow {
  if (deskpetWindow && !deskpetWindow.isDestroyed()) {
    deskpetWindow.showInactive();
    return deskpetWindow;
  }

  const size = getDeskpetWindowSize();
  const window = new BrowserWindow({
    width: size,
    height: size,
    minWidth: DESKPET_WINDOW_SIZES.small,
    minHeight: DESKPET_WINDOW_SIZES.small,
    maxWidth: DESKPET_WINDOW_SIZES.large,
    maxHeight: DESKPET_WINDOW_SIZES.large,
    ...resolveDeskpetWindowChromeOptions(),
    resizable: false,
    movable: true,
    show: false,
    skipTaskbar: true,
    alwaysOnTop: deskpetAlwaysOnTop,
    title: "Tabby Deskpet",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false,
    },
  });

  deskpetWindow = window;
  window.setBackgroundColor(TRANSPARENT_WINDOW_BACKGROUND_COLOR);
  window.setAlwaysOnTop(deskpetAlwaysOnTop, "floating");
  window.setIgnoreMouseEvents(true, { forward: true });
  positionDeskpetWindow(window);

  // Same teardown race as the main window: the deskpet is opened and closed far
  // more often, so its listeners are the likelier ones to fire post-destroy.
  window.webContents.on("context-menu", () => {
    if (window.isDestroyed()) return;
    showDeskpetContextMenu();
  });

  window.webContents.on(
    "console-message",
    (_event, level, message, line, sourceId) => {
      if (window.isDestroyed()) return;
      const levelLabel =
        ["verbose", "info", "warning", "error"][level] ?? String(level);
      logRendererEvent({
        source: `deskpet:${levelLabel}`,
        stream: level >= 3 ? "stderr" : "stdout",
        kind: "app",
        message: `${message} (${sourceId}:${line})`,
        windowId: window.webContents.id,
      });
    },
  );

  window.once("ready-to-show", () => {
    window.setBackgroundColor(TRANSPARENT_WINDOW_BACKGROUND_COLOR);
    window.showInactive();
  });

  window.webContents.on("did-finish-load", () => {
    if (window.isDestroyed()) return;
    window.setBackgroundColor(TRANSPARENT_WINDOW_BACKGROUND_COLOR);
  });

  window.on("closed", () => {
    if (deskpetWindow === window) {
      deskpetWindow = null;
    }
  });

  const desktopRendererEntryPath = resolve(__dirname, "../../dist/index.html");
  if (!app.isPackaged && desktopDevServerUrl) {
    const url = new URL(desktopDevServerUrl);
    url.searchParams.set("surface", "deskpet");
    void window.loadURL(url.toString());
  } else {
    void window.loadFile(desktopRendererEntryPath, {
      query: { surface: "deskpet" },
    });
  }

  return window;
}

// Intercept window.open() in ALL webContents (main window + webviews) and open
// the URL in the user's default system browser instead.
app.on("web-contents-created", (_event, contents) => {
  const contentType = contents.getType();

  contents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http://") || url.startsWith("https://")) {
      setImmediate(() => {
        void shell.openExternal(url);
      });
    }
    return { action: "deny" };
  });

  // In packaged builds, block reload shortcuts (Cmd+R, Ctrl+R, Ctrl+Shift+R,
  // F5) at the webContents level to prevent exposing internal startup screens
  // (#399). The same focused-window event path also toggles the Develop menu in
  // dev so the shortcut can be validated without a packaged build.
  contents.on("before-input-event", (event, input) => {
    if (input.type !== "keyDown") return;
    // Toggle debug mode: Cmd+Shift+Alt+D (mac) / Ctrl+Shift+Alt+D (win/linux).
    // Handled here in addition to globalShortcut so it works on Windows even
    // when system-level registration is blocked by other software.
    if (
      input.key.toLowerCase() === "d" &&
      input.shift &&
      input.alt &&
      (input.meta || input.control)
    ) {
      event.preventDefault();
      productionDebugMode = !productionDebugMode;
      installApplicationMenu();
      return;
    }
    if (!app.isPackaged || productionDebugMode) return;
    const isReload =
      (input.key.toLowerCase() === "r" && (input.meta || input.control)) ||
      input.key === "F5";
    if (isReload) {
      event.preventDefault();
    }
  });

  if (contentType !== "webview") {
    return;
  }

  contents.on("console-message", (details) => {
    logRendererEvent({
      source: `embedded:${contentType}:${details.level}`,
      stream: details.level === "error" ? "stderr" : "stdout",
      kind: "app",
      message: `${details.message} (${details.sourceId}:${details.lineNumber})`,
      windowId: contents.id,
    });
  });

  contents.on(
    "did-fail-load",
    (_event, errorCode, errorDescription, validatedUrl) => {
      diagnosticsReporter?.recordEmbeddedDidFailLoad({
        id: contents.id,
        type: contentType,
        errorCode,
        errorDescription,
        validatedUrl,
      });
      logRendererEvent({
        source: `embedded:${contentType}:fail-load`,
        stream: "stderr",
        kind: "lifecycle",
        message: `${errorCode} ${errorDescription} ${validatedUrl}`,
        windowId: contents.id,
      });
    },
  );

  contents.on("did-finish-load", () => {
    const url = contents.getURL();
    if (url.startsWith(runtimeConfig.urls.web)) {
      void contents
        .insertCSS(embeddedWorkspaceTransparentCss)
        .catch((error) => {
          writeDesktopMainLog({
            source: `embedded:${contentType}:transparent-css`,
            stream: "stderr",
            kind: "app",
            message: `failed to inject transparent workspace CSS url=${url} error=${
              error instanceof Error ? error.message : String(error)
            }`,
            logFilePath: null,
          });
        });
    }
    diagnosticsReporter?.recordEmbeddedDidFinishLoad({
      id: contents.id,
      type: contentType,
      url,
    });
    logRendererEvent({
      source: `embedded:${contentType}`,
      stream: "stdout",
      kind: "lifecycle",
      message: `did-finish-load ${url}`,
      windowId: contents.id,
    });
  });

  contents.on("render-process-gone", (_event, details) => {
    diagnosticsReporter?.recordEmbeddedProcessGone({
      id: contents.id,
      type: contentType,
      reason: details.reason,
      exitCode: details.exitCode,
    });
    logRendererEvent({
      source: `embedded:${contentType}:gone`,
      stream: "stderr",
      kind: "lifecycle",
      message: `reason=${details.reason} exitCode=${details.exitCode}`,
      windowId: contents.id,
    });
  });

  contents.on("destroyed", () => {
    diagnosticsReporter?.removeEmbedded(contents.id);
  });
});

logLaunchTimeline("electron main module evaluated");

app.whenReady().then(async () => {
  logLaunchTimeline("app.whenReady resolved");
  // Short-circuit before any heavy startup if running under Rosetta.
  await warnIfRunningUnderRosetta();
  // Electron denies every renderer permission request by default, so Talk's
  // getUserMedia call would fail silently. Grant only audio capture — the
  // renderer is our own local UI, but a blanket allow would also hand it
  // camera, geolocation and notifications.
  session.defaultSession.setPermissionRequestHandler(
    (_contents, permission, callback, details) => {
      if (permission === "media") {
        const requested =
          (details as { mediaTypes?: string[] }).mediaTypes ?? [];
        // `mediaTypes` is absent on some platforms; audio-only Talk is the only
        // caller, so an unspecified request is treated as audio.
        callback(requested.every((type) => type === "audio"));
        return;
      }
      callback(false);
    },
  );

  proxyManager = new ProxyManager(session.defaultSession);
  await proxyManager.applyPolicy(runtimeConfig.proxy);
  installApplicationMenu();

  // Hidden shortcut to toggle the Develop menu and packaged-only reload items.
  // Registered in both dev and packaged builds so the shortcut itself can be
  // validated locally, while before-input-event remains the Windows fallback.
  globalShortcut.register("CommandOrControl+Shift+Alt+D", () => {
    productionDebugMode = !productionDebugMode;
    installApplicationMenu();
  });
  globalShortcut.register("CommandOrControl+Shift+Space", () => {
    openDesktopQuickChat();
  });
  diagnosticsReporter = new DesktopDiagnosticsReporter(orchestrator);
  await refreshProxyDiagnostics();
  diagnosticsReporter.recordStartupProbe({
    source: "main",
    stage: "main:app-when-ready",
    status: "ok",
    detail: app.getVersion(),
  });
  if (
    !app.isPackaged &&
    desktopDevInspectToken &&
    Number.isInteger(desktopDevInspectPort) &&
    desktopDevInspectPort > 0
  ) {
    try {
      await startDesktopDevInspectServer({
        host: desktopDevInspectHost,
        port: desktopDevInspectPort,
        token: desktopDevInspectToken,
      });
    } catch (error) {
      writeDesktopMainLog({
        source: "dev-inspect",
        stream: "stderr",
        kind: "app",
        message: `desktop dev inspect server failed to start host=${desktopDevInspectHost} port=${desktopDevInspectPort} error=${error instanceof Error ? error.message : String(error)}`,
        logFilePath: null,
      });
    }
  }
  setDesktopShellPreferencesRuntimeHandler((preferences) => {
    applyResidentEntryPreferences(preferences);
    broadcastShellPreferencesUpdated();
  });
  applyDesktopShellPreferencesOnStartup();
  unsubscribeIpc = registerIpcHandlers(
    orchestrator,
    runtimeConfig,
    diagnosticsReporter,
    coldStartReady,
    (mood) => {
      currentDeskpetMood = mood;
    },
    runtimeRoots.openclawStateDir,
    () =>
      deskpetWindow && !deskpetWindow.isDestroyed()
        ? deskpetWindow.webContents.id
        : null,
  );
  unsubscribeDeskpetRuntime = orchestrator.subscribe(handleDeskpetRuntimeEvent);
  // Provide orchestrator-mode quit fallback for app:quit IPC when launchd
  // quit handler is not available (e.g. CI, orchestrator mode).
  setQuitFallback(() =>
    gracefulShutdown("ipc-quit").finally(() => {
      (app as unknown as Record<string, unknown>).__nexuForceQuit = true;
      app.exit(0);
    }),
  );
  const unsubscribeDiagnostics = diagnosticsReporter.start();
  sleepGuard = new SleepGuard({
    powerMonitor,
    powerSaveBlocker,
    log: logSleepGuard,
    onSnapshot: (snapshot) => {
      diagnosticsReporter?.setSleepGuardSnapshot(snapshot);
    },
  });
  const win = createMainWindow();
  if (getDesktopShellPreferences().deskpetEnabled) {
    createDeskpetWindow();
  }
  if (!app.isPackaged) {
    setTimeout(() => {
      showMainWindowFromResidentEntry();
    }, 1200);
  }
  await ensureWindowsTray();
  sleepGuard.start("desktop-runtime-active");

  void (async () => {
    const healthCheck = new StartupHealthCheck();
    const health = healthCheck.check();

    if (!health.healthy) {
      logColdStart(
        `unhealthy: ${health.consecutiveFailures} consecutive cold-start failures`,
      );
    }

    try {
      if (needsSetupExtraction) {
        logColdStart("starting async openclaw sidecar extraction");
        diagnosticsReporter?.markColdStartRunning(
          "extracting openclaw sidecar",
        );
        sendSetupProgress("extracting", "解压OpenClaw运行时...");
        await extractOpenclawSidecarAsync(
          electronRoot,
          app.getPath("userData"),
        );
        logColdStart("openclaw sidecar extraction complete");
        sendSetupProgress("extracted");
      }

      logColdStart(
        `bootstrap mode: ${useExternalRuntime ? "external" : useLaunchdMode ? "launchd" : "orchestrator"}`,
      );

      if (useExternalRuntime) {
        await runtimeLifecycle.coldStartOrAttach({
          app,
          electronRoot,
          runtimeConfig,
          orchestrator,
          diagnosticsReporter,
          logColdStart,
          logStartupStep: logLaunchTimeline,
          rotateDesktopLogSession,
          waitForControllerReadiness,
          onProgress: sendSetupProgress,
        });
      } else if (useLaunchdMode) {
        await runLaunchdColdStart();
      } else if (baseRuntimeConfig.runtimeMode === "external") {
        // External mode: pnpm dev services (controller, web, openclaw) are
        // already running; just wait for controller to be ready and attach.
        diagnosticsReporter?.markColdStartRunning(
          "attaching to external runtime",
        );
        logColdStart("attaching to external runtime");
        sendSetupProgress("attaching_external");
        logColdStart("waiting for external controller readiness");
        sendSetupProgress("waiting_controller");
        await waitForControllerReadiness();
        const sessionId = rotateDesktopLogSession();
        logColdStart(`cold start session ready sessionId=${sessionId}`);
        logColdStart("cold start complete");
        sendSetupProgress("complete");
        diagnosticsReporter?.markColdStartSucceeded();
      } else {
        await runDesktopColdStart();
      }
      await refreshProxyDiagnostics();
      startAgentBrowserRelay();
      healthCheck.recordSuccess();
    } catch (error) {
      await refreshProxyDiagnostics().catch(() => undefined);
      healthCheck.recordFailure();
      diagnosticsReporter?.markColdStartFailed(
        error instanceof Error ? error.message : String(error),
      );
      writeDesktopMainLog({
        source: "cold-start",
        stream: "stderr",
        kind: "lifecycle",
        message: error instanceof Error ? error.message : String(error),
        logFilePath: getDesktopLogFilePath("cold-start.log"),
        windowId: getMainWindowId(),
      });
    } finally {
      // Unblock renderer — it will get the final config (or show error state)
      resolveColdStartReady();
    }

    // Install launchd quit handler regardless of cold-start success/failure
    // so services can always be stopped cleanly on quit.
    if (launchdResult) {
      const quitOpts = {
        launchd: launchdResult.launchd,
        labels: launchdResult.labels,
        webServer: launchdResult.webServer,
        plistDir: getDefaultPlistDir(!app.isPackaged),
        onBeforeQuit: async () => {
          sleepGuard?.dispose("launchd-quit");
          await diagnosticsReporter?.flushNow().catch(() => undefined);
          flushRuntimeLoggers();
          flushV8CoverageIfEnabled();
        },
      };
      installLaunchdQuitHandler(quitOpts);
      setQuitHandlerOpts(quitOpts);
      launchdQuitOptsForResidentEntry = quitOpts;
    }

    const shouldEnableUpdates =
      app.isPackaged &&
      runtimeConfig.updates.autoUpdateEnabled &&
      shouldEnableDesktopUpdateManager({
        buildSource: runtimeConfig.buildInfo.source,
        updateFeed: runtimeConfig.urls.updateFeed,
      });

    if (shouldEnableUpdates) {
      const updateMgr = new UpdateManager(win, orchestrator, {
        channel: runtimeConfig.updates.channel,
        feedUrl: runtimeConfig.urls.updateFeed,
        autoDownload: true,
        initialDelayMs: process.platform === "win32" ? 30_000 : 0,
        prepareForUpdateInstall: runtimeLifecycle.prepareForUpdateInstall
          ? async (args: PrepareForUpdateInstallArgs) => {
              await runtimeLifecycle.prepareForUpdateInstall?.(args);
            }
          : undefined,
        launchd: launchdResult
          ? {
              manager: launchdResult.launchd,
              labels: launchdResult.labels,
              plistDir: getDefaultPlistDir(!app.isPackaged),
            }
          : undefined,
      });
      setUpdateManager(updateMgr);

      if (
        shouldStartDesktopPeriodicUpdateChecks({
          buildSource: runtimeConfig.buildInfo.source,
          updateFeed: runtimeConfig.urls.updateFeed,
        })
      ) {
        updateMgr.startPeriodicCheck();
      }
    } else {
      setUpdateManager(null);
    }

    const compUpdater = new ComponentUpdater();
    setComponentUpdater(compUpdater);
  })();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createMainWindow();
      return;
    }

    setImmediate(() => {
      if (
        deskpetWindow &&
        !deskpetWindow.isDestroyed() &&
        deskpetWindow.isFocused()
      ) {
        return;
      }

      focusMainWindow();
    });
  });

  app.once("before-quit", () => {
    unsubscribeDiagnostics();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    if (shouldUseResidentEntry(getDesktopShellPreferences())) {
      return;
    }
    app.quit();
  }
});

// ---------------------------------------------------------------------------
// Signal handlers — route to unified gracefulShutdown.
// SIGTERM: sent by launchctl stop, systemd, Docker, Activity Monitor "Quit".
// SIGINT: sent by Ctrl+C in terminal.
// ---------------------------------------------------------------------------

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.on(signal, () => {
    void gracefulShutdown(`signal:${signal}`).finally(() => {
      (app as unknown as Record<string, unknown>).__nexuForceQuit = true;
      app.exit(0);
    });
  });
}

// ---------------------------------------------------------------------------
// before-quit handler — uses gracefulShutdown for non-launchd mode.
// In launchd mode, quit-handler.ts intercepts window close and calls
// gracefulShutdown via teardownLaunchdServices directly.
// ---------------------------------------------------------------------------

const beforeQuitHandler = (event: Electron.Event) => {
  // If using launchd mode, the quit handler (quit-handler.ts) manages
  // the quit flow via window close dialog. This handler only does
  // lightweight cleanup.
  if (launchdResult) {
    return;
  }

  // Legacy orchestrator mode: run unified shutdown, then quit.
  event.preventDefault();
  void gracefulShutdown("before-quit").finally(() => {
    markForceQuitInProgress();
    // P1-2: Remove only this specific handler (not all before-quit listeners).
    app.removeListener("before-quit", beforeQuitHandler);
    app.quit();
  });
};

app.on("before-quit", beforeQuitHandler);
app.on("before-quit", () => {
  systemTray?.destroy();
  systemTray = null;
});
