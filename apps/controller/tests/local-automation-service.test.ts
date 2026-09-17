import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import { supportsComputerUseBackend } from "../src/lib/computer-use-platform.js";
import type { OpenClawProcessManager } from "../src/runtime/openclaw-process.js";
import { LocalAutomationService } from "../src/services/local-automation-service.js";
import type { OpenClawSyncService } from "../src/services/openclaw-sync-service.js";
import type { NexuConfigStore } from "../src/store/nexu-config-store.js";
import type { LocalAutomationConfig } from "../src/store/schemas.js";

const roots: string[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function createHarness(
  initial: LocalAutomationConfig,
  backend: "cua-driver" = "cua-driver",
  options: {
    timing?: {
      cuaDaemonStartTimeoutMs: number;
      cuaDaemonPollIntervalMs: number;
    };
    platformSupported?: boolean;
    previewEnabled?: boolean;
    accessibilityGranted?: boolean;
    screenRecordingGranted?: boolean;
    /** Set to exercise the macOS LaunchServices launch path. */
    appBundle?: string | null;
  } = {},
) {
  const root = await mkdtemp(path.join(tmpdir(), "nexu-local-automation-"));
  roots.push(root);
  const binaryPath = path.join(root, backend);
  const extensionPath = path.join(
    root,
    "extensions",
    "browser",
    "chrome-extension",
  );
  await writeFile(binaryPath, "fixture");
  await mkdir(extensionPath, { recursive: true });

  let config = initial;
  const getLocalAutomationConfig = vi.fn(async () => config);
  const configStore = {
    getLocalAutomationConfig,
    setLocalAutomationConfig: vi.fn(
      async (patch: Partial<LocalAutomationConfig>) => {
        config = {
          browser: { ...config.browser, ...patch.browser },
          computerUse: { ...config.computerUse, ...patch.computerUse },
        };
        return config;
      },
    ),
  } as unknown as NexuConfigStore;
  const syncAll = vi.fn().mockResolvedValue({ configChanged: true });
  const restart = vi.fn().mockResolvedValue(undefined);
  // The daemon is stateful: `status` only succeeds once something started it,
  // which is what drives the service's start/stop reconciliation.
  let daemonRunning = false;
  const runCommand = vi.fn(
    async (command: string, args: string[], _options: object) => {
      if (args[0] === "permissions" && args[1] === "status") {
        return {
          stdout: JSON.stringify({
            daemon_running: daemonRunning,
            ...(daemonRunning
              ? {
                  accessibility: options.accessibilityGranted ?? true,
                  screen_recording: options.screenRecordingGranted ?? true,
                }
              : { status: "unknown" }),
          }),
        };
      }
      if (args[0] === "permissions" && args[1] === "grant") {
        return { stdout: "" };
      }
      if (args[0] === "status") {
        if (!daemonRunning) throw new Error("not running");
        return { stdout: JSON.stringify({ running: true }) };
      }
      if (args[0] === "stop") {
        daemonRunning = false;
        return { stdout: JSON.stringify({ success: true }) };
      }
      if (command === "/usr/bin/open") {
        daemonRunning = true;
        return { stdout: "" };
      }
      return { stdout: JSON.stringify({ success: true }) };
    },
  );
  const unref = vi.fn();
  const kill = vi.fn(() => true);
  const once = vi.fn();
  const stdinEnd = vi.fn();
  const stdin = {
    end: stdinEnd,
    on: vi.fn(),
  };
  stdin.on.mockReturnValue(stdin);
  const startProcess = vi.fn(() => {
    daemonRunning = true;
    return { kill, once, stdin, unref };
  });
  const env = {
    nexuHomeDir: root,
    localAutomationPreviewEnabled: options.previewEnabled ?? true,
    computerUseBackend: backend,
    computerUsePlatformSupported: options.platformSupported ?? true,
    computerUseBin: binaryPath,
    computerUseAppBundle: options.appBundle ?? null,
    computerUseCuaSocket: path.join(root, "runtime", "cua-driver.sock"),
    openclawBuiltinExtensionsDir: path.join(root, "extensions"),
    openclawBin: path.join(root, "openclaw.mjs"),
    openclawStateDir: path.join(root, "openclaw-state"),
    openclawConfigPath: path.join(root, "openclaw.json"),
  } as ControllerEnv;
  const service = new LocalAutomationService(
    env,
    configStore,
    { syncAll } as unknown as OpenClawSyncService,
    { restart } as unknown as OpenClawProcessManager,
    runCommand,
    startProcess,
    options.timing,
  );

  return {
    root,
    service,
    getConfig: () => config,
    getLocalAutomationConfig,
    runCommand,
    startProcess,
    kill,
    once,
    stdinEnd,
    unref,
    syncAll,
    restart,
    env,
    isDaemonRunning: () => daemonRunning,
  };
}

describe("LocalAutomationService", () => {
  it("fails closed outside preview while allowing stale settings to be disabled", async () => {
    const disabledHarness = await createHarness(
      {
        browser: { enabled: false },
        computerUse: { enabled: false },
      },
      "cua-driver",
      { previewEnabled: false },
    );

    await expect(
      disabledHarness.service.updateConfig({ browser: { enabled: true } }),
    ).rejects.toThrow("preview is disabled");
    await expect(
      disabledHarness.service.updateConfig({ computerUse: { enabled: true } }),
    ).rejects.toThrow("preview is disabled");
    await expect(
      disabledHarness.service.requestComputerUsePermissions(),
    ).rejects.toThrow("preview is disabled");
    expect(disabledHarness.syncAll).not.toHaveBeenCalled();
    expect((await disabledHarness.service.getStatus()).previewEnabled).toBe(
      false,
    );

    const staleHarness = await createHarness(
      {
        browser: { enabled: true },
        computerUse: { enabled: true },
      },
      "cua-driver",
      { previewEnabled: false },
    );
    await staleHarness.service.prepare();
    await staleHarness.service.updateConfig({
      browser: { enabled: false },
      computerUse: { enabled: false },
    });

    expect(staleHarness.getConfig()).toEqual({
      browser: { enabled: false },
      computerUse: { enabled: false },
    });
    expect(staleHarness.startProcess).not.toHaveBeenCalled();
  });

  it("fails closed when the Preview capability flag is absent", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: false },
    });
    Reflect.deleteProperty(harness.env, "localAutomationPreviewEnabled");

    await expect(
      harness.service.updateConfig({ browser: { enabled: true } }),
    ).rejects.toThrow("preview is disabled");
    expect((await harness.service.getStatus()).previewEnabled).toBe(false);
  });

  it("starts the daemon before enabling MCP and restarts OpenClaw", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: false },
    });
    const next = await harness.service.updateConfig({
      computerUse: { enabled: true },
    });

    expect(next.computerUse.enabled).toBe(true);
    expect(harness.startProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["serve", "--permission-mode"]),
      expect.any(Object),
    );
    expect(harness.syncAll).toHaveBeenCalledOnce();
    expect(harness.restart).toHaveBeenCalledWith("local-automation-changed");
  });

  it("stops a partially started daemon when enable fails", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: false },
    });
    harness.startProcess.mockImplementationOnce(() => {
      throw new Error("startup timed out");
    });

    await expect(
      harness.service.updateConfig({ computerUse: { enabled: true } }),
    ).rejects.toThrow("startup timed out");

    expect(harness.getConfig().computerUse.enabled).toBe(false);
    expect(harness.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      ["stop"],
      expect.any(Object),
    );
    expect(harness.syncAll).not.toHaveBeenCalled();
  });

  it("restores persisted config and stops the daemon when sync fails", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: false },
    });
    harness.syncAll
      .mockRejectedValueOnce(new Error("sync failed"))
      .mockResolvedValueOnce({ configChanged: true });

    await expect(
      harness.service.updateConfig({ computerUse: { enabled: true } }),
    ).rejects.toThrow("sync failed");

    expect(harness.getConfig().computerUse.enabled).toBe(false);
    expect(harness.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      ["stop"],
      expect.any(Object),
    );
    expect(harness.syncAll).toHaveBeenCalledTimes(2);
  });

  // The two permission-state tests exercise the macOS TCC read-back path;
  // `readComputerUsePermissions` deliberately short-circuits on other
  // platforms (Windows needs no TCC grants), so the states they assert can
  // only exist on darwin. Same precedent as the launchd integration tests.
  it.runIf(process.platform === "darwin")(
    "reports ready only when the driver daemon answers for its own identity",
    async () => {
      const harness = await createHarness({
        browser: { enabled: true },
        computerUse: { enabled: true },
      });

      // Permission state is only readable through a live daemon.
      await harness.service.prepare();
      const status = await harness.service.getStatus();

      expect(status.computerUseAvailable).toBe(true);
      expect(status.computerUseUnavailableReason).toBeNull();
      expect(status.computerUsePermissionState).toBe("ready");
      expect(status.computerUsePermissions).toEqual([
        { name: "Accessibility", granted: true, required: true },
        { name: "Screen Recording", granted: true, required: true },
      ]);
    },
  );

  it.runIf(process.platform === "darwin")(
    "reports permission-required until every macOS grant is present",
    async () => {
      const harness = await createHarness(
        {
          browser: { enabled: false },
          computerUse: { enabled: true },
        },
        "cua-driver",
        { accessibilityGranted: false },
      );

      // Permission state is only readable through a live daemon.
      await harness.service.prepare();
      const status = await harness.service.getStatus();

      expect(status.computerUsePermissionState).toBe("permission-required");
      expect(status.computerUsePermissions).toEqual([
        { name: "Accessibility", granted: false, required: true },
        { name: "Screen Recording", granted: true, required: true },
      ]);
    },
  );

  it("requests every platform grant in one pass", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: true },
    });

    await harness.service.requestComputerUsePermissions();

    // cua-driver has no per-permission entry point: `permissions grant` asks
    // for Accessibility, Screen Recording and direct capture together.
    expect(harness.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      ["permissions", "grant"],
      expect.any(Object),
    );
  });

  it("reuses a healthy daemon instead of restarting it on macOS", async () => {
    const harness = await createHarness(
      {
        browser: { enabled: false },
        computerUse: { enabled: false },
      },
      "cua-driver",
      { appBundle: "/somewhere/CuaDriver.app" },
    );
    // A daemon someone else started, on the driver's shared per-user socket.
    harness.runCommand.mockImplementation(
      async (_c: string, args: string[]) => {
        if (args[0] === "status")
          return { stdout: JSON.stringify({ ok: true }) };
        return { stdout: "" };
      },
    );

    await harness.service.updateConfig({ computerUse: { enabled: true } });

    // Stopping and relaunching raced the socket teardown and made enabling
    // fail intermittently; a reachable daemon is reusable whoever owns it.
    const stopCalls = harness.runCommand.mock.calls.filter(
      (call) => (call[1] as string[])[0] === "stop",
    );
    const launchCalls = harness.runCommand.mock.calls.filter(
      (call) => call[0] === "/usr/bin/open",
    );
    expect(stopCalls).toHaveLength(0);
    expect(launchCalls).toHaveLength(0);
  });

  it("never sets CUA_DRIVER_EMBEDDED on daemon or CLI invocations", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: false },
    });

    await harness.service.updateConfig({ computerUse: { enabled: true } });
    await harness.service.getStatus();

    // Embedded is an MCP-proxy mode. A daemon started with it does not register
    // as the standalone daemon `permissions status` discovers, so every grant
    // read comes back `daemon_running: false` and the UI reports "unavailable"
    // even when Accessibility and Screen Recording are both granted.
    for (const call of harness.runCommand.mock.calls) {
      const options = call[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(options?.env?.CUA_DRIVER_EMBEDDED).toBeUndefined();
    }
    for (const call of harness.startProcess.mock.calls) {
      const options = call[2] as { env?: NodeJS.ProcessEnv } | undefined;
      expect(options?.env?.CUA_DRIVER_EMBEDDED).toBeUndefined();
    }
  });

  it("treats stopping an already-stopped daemon as success", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: true },
    });
    // `cua-driver stop` exits non-zero when nothing is running.
    harness.runCommand.mockImplementation(
      async (_c: string, args: string[]) => {
        if (args[0] === "status") throw new Error("not running");
        if (args[0] === "stop")
          throw new Error("Cua Driver daemon is not running");
        return { stdout: "" };
      },
    );

    await expect(
      harness.service.updateConfig({ computerUse: { enabled: false } }),
    ).resolves.toMatchObject({ computerUse: { enabled: false } });
  });

  it("starts the daemon before requesting grants", async () => {
    const harness = await createHarness(
      {
        browser: { enabled: false },
        computerUse: { enabled: true },
      },
      "cua-driver",
      { appBundle: "/somewhere/outside/Applications/CuaDriver.app" },
    );

    await harness.service.requestComputerUsePermissions();

    // `permissions grant` resolves the app through LaunchServices by *name*,
    // which fails for a bundle outside /Applications — the driver then reports
    // "Check that /Applications/CuaDriver.app is installed" and grants
    // nothing. Starting the daemon by absolute path first makes grant take its
    // "daemon already running" path instead, which is why nexu can ship the
    // bundle under NEXU_HOME. Order matters; do not reverse these.
    const order = harness.runCommand.mock.calls.map((call) => call[1]);
    const launchIndex = order.findIndex(
      (args: string[]) => args[0] === "-n" && args.includes("serve"),
    );
    const grantIndex = order.findIndex(
      (args: string[]) => args[0] === "permissions" && args[1] === "grant",
    );
    expect(launchIndex).toBeGreaterThanOrEqual(0);
    expect(grantIndex).toBeGreaterThan(launchIndex);
  });

  it("launches the daemon through the app bundle so macOS attributes TCC to the driver", async () => {
    const harness = await createHarness(
      {
        browser: { enabled: false },
        computerUse: { enabled: false },
      },
      "cua-driver",
      { appBundle: "/Applications/CuaDriver.app" },
    );

    await harness.service.updateConfig({ computerUse: { enabled: true } });

    // Running Contents/MacOS/cua-driver directly would make the controller the
    // responsible process, and the driver would report no grants.
    expect(harness.runCommand).toHaveBeenCalledWith(
      "/usr/bin/open",
      expect.arrayContaining([
        "-n",
        "-g",
        "-a",
        "/Applications/CuaDriver.app",
        "--args",
        "serve",
      ]),
      expect.any(Object),
    );
    expect(harness.startProcess).not.toHaveBeenCalled();
  });

  it("reconciles the persisted switch during controller bootstrap", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: true },
    });

    await harness.service.prepare();

    expect(harness.startProcess).toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["serve", "--permission-mode"]),
      expect.any(Object),
    );
  });

  it("fails closed when bootstrap cannot start Computer Use and allows an explicit retry", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: true },
    });
    harness.startProcess.mockImplementationOnce(() => {
      throw new Error("startup failed");
    });

    await harness.service.prepare();

    expect(harness.getConfig().computerUse.enabled).toBe(false);
    expect(harness.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      ["stop"],
      expect.any(Object),
    );
    expect(harness.syncAll).not.toHaveBeenCalled();

    await harness.service.updateConfig({ computerUse: { enabled: true } });

    expect(harness.getConfig().computerUse.enabled).toBe(true);
    expect(harness.syncAll).toHaveBeenCalledOnce();
  });

  it("starts and stops a dedicated CUA daemon before exposing its MCP proxy", async () => {
    const harness = await createHarness(
      {
        browser: { enabled: false },
        computerUse: { enabled: false },
      },
      "cua-driver",
    );
    harness.runCommand.mockRejectedValueOnce(new Error("not running"));

    await harness.service.updateConfig({ computerUse: { enabled: true } });

    expect(harness.startProcess).toHaveBeenCalledWith(
      expect.any(String),
      // No --socket: the driver's own default is the only path
      // `permissions status` discovers, and a NEXU_HOME-scoped one can exceed
      // the 103-byte sun_path limit.
      expect.arrayContaining([
        "serve",
        "--embedded",
        "--parent-liveness-stdio",
        "--permission-mode",
        "standard",
      ]),
      expect.objectContaining({
        detached: false,
        // Embedded comes from the `--embedded` argument above, never the
        // environment — see the CUA_DRIVER_EMBEDDED test.
        env: expect.objectContaining({
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        }),
        stdio: ["pipe", "ignore", "ignore"],
      }),
    );
    expect(harness.unref).not.toHaveBeenCalled();
    expect((await harness.service.getStatus()).computerUsePermissionState).toBe(
      "ready",
    );

    await harness.service.updateConfig({ computerUse: { enabled: false } });

    expect(harness.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      ["stop"],
      expect.objectContaining({
        env: expect.objectContaining({
          CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
        }),
      }),
    );
    expect(harness.stdinEnd).toHaveBeenCalledOnce();
  });

  it("attempts an idempotent CUA stop even when status probing fails", async () => {
    const harness = await createHarness(
      {
        browser: { enabled: false },
        computerUse: { enabled: true },
      },
      "cua-driver",
    );
    harness.runCommand.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === "status") {
          throw new Error("status timed out");
        }
        return { stdout: JSON.stringify({ success: true }) };
      },
    );

    await harness.service.stop();

    expect(harness.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      ["stop"],
      expect.any(Object),
    );
  });

  it("replaces an unowned daemon with a parent-bound process", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: false },
    });
    // Simulate a daemon left behind by an earlier run: reachable, but not one
    // this controller started, so it must be stopped before we bind our own.
    harness.runCommand.mockImplementation(
      async (_c: string, args: string[]) => {
        if (args[0] === "status") return { stdout: "{}" };
        return { stdout: JSON.stringify({ success: true }) };
      },
    );

    await harness.service.updateConfig({ computerUse: { enabled: true } });

    const stopIndex = harness.runCommand.mock.calls.findIndex(
      (call) => call[1]?.[0] === "stop",
    );
    expect(stopIndex).toBeGreaterThanOrEqual(0);
    expect(harness.runCommand.mock.invocationCallOrder[stopIndex]).toBeLessThan(
      harness.startProcess.mock.invocationCallOrder[0] ??
        Number.POSITIVE_INFINITY,
    );
    expect(harness.startProcess).toHaveBeenCalledOnce();
  });

  it("serializes concurrent automation updates so config and backend stay aligned", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: true },
    });
    let resolveFirstSync: ((value: { configChanged: boolean }) => void) | null =
      null;
    const firstSync = new Promise<{ configChanged: boolean }>((resolve) => {
      resolveFirstSync = resolve;
    });
    let syncCallCount = 0;
    harness.syncAll.mockImplementation(async () => {
      syncCallCount += 1;
      if (syncCallCount === 1) {
        return firstSync;
      }
      return { configChanged: true };
    });

    const disable = harness.service.updateConfig({
      computerUse: { enabled: false },
    });
    await vi.waitFor(() => {
      expect(harness.getConfig().computerUse.enabled).toBe(false);
    });
    expect(harness.getLocalAutomationConfig).toHaveBeenCalledTimes(1);
    const enable = harness.service.updateConfig({
      computerUse: { enabled: true },
    });
    expect(harness.getLocalAutomationConfig).toHaveBeenCalledTimes(1);
    resolveFirstSync?.({ configChanged: true });

    await Promise.all([disable, enable]);

    expect(harness.getConfig().computerUse.enabled).toBe(true);
    // The enable landed last, so the daemon must be up rather than stopped.
    const lastStop = harness.runCommand.mock.calls
      .map((call, index) => ({ args: call[1] as string[], index }))
      .filter((call) => call.args[0] === "stop")
      .at(-1);
    expect(harness.startProcess).toHaveBeenCalled();
    const lastStart = harness.startProcess.mock.invocationCallOrder.at(-1) ?? 0;
    const lastStopOrder = lastStop
      ? (harness.runCommand.mock.invocationCallOrder[lastStop.index] ?? 0)
      : 0;
    expect(lastStart).toBeGreaterThan(lastStopOrder);
    expect(harness.isDaemonRunning()).toBe(true);
  });

  it("serializes permission requests with disable so the daemon stays stopped", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: true },
    });
    let releaseDaemonStart: (() => void) | null = null;
    const daemonStartGate = new Promise<void>((resolve) => {
      releaseDaemonStart = resolve;
    });
    let markDaemonStart: (() => void) | null = null;
    const daemonStartObserved = new Promise<void>((resolve) => {
      markDaemonStart = resolve;
    });
    const lifecycleEvents: string[] = [];
    let daemonUp = false;
    harness.runCommand.mockImplementation(
      async (_command: string, args: string[]) => {
        if (args[0] === "status") {
          if (!daemonUp) throw new Error("not running");
          return { stdout: JSON.stringify({ running: true }) };
        }
        if (args[0] === "stop") {
          daemonUp = false;
          lifecycleEvents.push("stop");
        } else if (args[0] === "permissions" && args[1] === "grant") {
          lifecycleEvents.push("permission");
        }
        return { stdout: JSON.stringify({ success: true }) };
      },
    );
    harness.startProcess.mockImplementation(() => {
      lifecycleEvents.push("start-begin");
      markDaemonStart?.();
      void daemonStartGate.then(() => {
        daemonUp = true;
        lifecycleEvents.push("start-complete");
      });
      daemonUp = true;
      return {
        kill: vi.fn(() => true),
        once: vi.fn(),
        stdin: { end: vi.fn(), on: vi.fn() },
        unref: vi.fn(),
      };
    });

    const permission = harness.service.requestComputerUsePermissions();
    await daemonStartObserved;
    const disable = harness.service.updateConfig({
      computerUse: { enabled: false },
    });

    await Promise.resolve();
    expect(harness.getConfig().computerUse.enabled).toBe(true);
    releaseDaemonStart?.();
    await Promise.all([permission, disable]);

    expect(harness.getConfig().computerUse.enabled).toBe(false);
    expect(lifecycleEvents).toEqual([
      "start-begin",
      "start-complete",
      "permission",
      "stop",
    ]);
  });

  it("cleans up a CUA process that never becomes ready", async () => {
    const harness = await createHarness(
      {
        browser: { enabled: false },
        computerUse: { enabled: false },
      },
      "cua-driver",
      {
        timing: {
          cuaDaemonStartTimeoutMs: 20,
          cuaDaemonPollIntervalMs: 1,
        },
      },
    );
    harness.runCommand.mockRejectedValue(new Error("not running"));

    await expect(
      harness.service.updateConfig({ computerUse: { enabled: true } }),
    ).rejects.toThrow("did not become ready");

    expect(harness.runCommand).toHaveBeenCalledWith(
      expect.any(String),
      ["stop"],
      expect.any(Object),
    );
    expect(harness.kill).toHaveBeenCalledWith("SIGTERM");
    expect(harness.getConfig().computerUse.enabled).toBe(false);
  });

  it("retries backend shutdown while keeping MCP access revoked", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: true },
    });
    harness.runCommand.mockRejectedValueOnce(new Error("stop failed"));

    await harness.service.updateConfig({ computerUse: { enabled: false } });

    expect(harness.getConfig().computerUse.enabled).toBe(false);
    expect(harness.syncAll).toHaveBeenCalledOnce();
    expect(harness.restart).toHaveBeenCalledWith("local-automation-changed");
    expect(harness.runCommand).toHaveBeenCalledTimes(2);
  });

  it("reports persistent backend shutdown failure without restoring MCP access", async () => {
    const harness = await createHarness({
      browser: { enabled: false },
      computerUse: { enabled: true },
    });
    // A real shutdown failure is one where the daemon survives. `stop` also
    // exits non-zero when nothing is running, and that case must NOT surface
    // as an error, so `status` has to keep reporting the daemon as alive here.
    harness.runCommand.mockImplementation(
      async (_c: string, args: string[]) => {
        if (args[0] === "status")
          return { stdout: JSON.stringify({ ok: true }) };
        throw new Error("stop failed");
      },
    );

    await expect(
      harness.service.updateConfig({ computerUse: { enabled: false } }),
    ).rejects.toThrow("backend could not be stopped");

    expect(harness.getConfig().computerUse.enabled).toBe(false);
    expect(harness.syncAll).toHaveBeenCalledOnce();
    expect(harness.restart).toHaveBeenCalledTimes(1);
    expect(harness.restart).toHaveBeenCalledWith("local-automation-changed");

    harness.runCommand.mockResolvedValue({
      stdout: JSON.stringify({ success: true }),
    });
    await expect(
      harness.service.updateConfig({ computerUse: { enabled: false } }),
    ).resolves.toEqual({
      browser: { enabled: false },
      computerUse: { enabled: false },
    });

    expect(harness.getConfig().computerUse.enabled).toBe(false);
    // The retry must not restart OpenClaw again: access was already revoked.
    expect(harness.restart).toHaveBeenCalledTimes(1);
    // Counting `stop` rather than every command keeps this from breaking each
    // time the daemon probe changes.
    const stopCalls = harness.runCommand.mock.calls.filter(
      (call) => (call[1] as string[])[0] === "stop",
    );
    expect(stopCalls).toHaveLength(3);
  });

  it("does not start or expose Computer Use on an unsupported OS", async () => {
    const harness = await createHarness(
      {
        browser: { enabled: false },
        computerUse: { enabled: true },
      },
      "cua-driver",
      { platformSupported: false },
    );

    await harness.service.prepare();
    const status = await harness.service.getStatus();
    await harness.service.updateConfig({ computerUse: { enabled: false } });

    expect(status.computerUseUnavailableReason).toBe("unsupported-os");
    expect(harness.getConfig().computerUse.enabled).toBe(false);
    expect(harness.runCommand).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.arrayContaining(["daemon", "start"]),
      expect.any(Object),
    );
  });

  it("requires macOS 13 or later, matching CuaDriver.app's LSMinimumSystemVersion", () => {
    // Darwin 22 == macOS 13. This floor is lower than the macOS 15 the
    // previous macOS-only backend needed before the backends were unified.
    expect(supportsComputerUseBackend("cua-driver", "darwin", "21.6.0")).toBe(
      false,
    );
    expect(supportsComputerUseBackend("cua-driver", "darwin", "22.0.0")).toBe(
      true,
    );
    expect(supportsComputerUseBackend("cua-driver", "win32", "10.0.0")).toBe(
      true,
    );
    expect(supportsComputerUseBackend("cua-driver", "linux", "6.0.0")).toBe(
      false,
    );
  });
});
