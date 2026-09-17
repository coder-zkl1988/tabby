import { createHash } from "node:crypto";
import path from "node:path";

export type ComputerUseBackend = "cua-driver";

/**
 * CuaDriver.app declares `LSMinimumSystemVersion 13.0`, so macOS 13 (Darwin 22)
 * is the floor. This is wider than the macOS 15 floor the previous
 * macOS-only backend required before the backends were unified.
 */
const MIN_DARWIN_MAJOR = 22;

export function createComputerUseInstanceId(nexuHomeDir: string): string {
  return createHash("sha256").update(nexuHomeDir).digest("hex").slice(0, 12);
}

/**
 * cua-driver owns its control socket, and nexu must not override it.
 *
 * Two things break when a custom `--socket` is passed:
 *
 * 1. `permissions status` does not honour it. The driver discovers its daemon
 *    through the default socket only, so a custom path makes every permission
 *    read report `daemon_running: false` — the macOS grant UI then shows
 *    "unavailable" even with Accessibility and Screen Recording granted.
 * 2. macOS caps `sun_path` at 103 bytes. A NEXU_HOME-scoped socket blows past
 *    that for long homes and dev worktrees, and the daemon then fails to start
 *    with no diagnostic at all.
 *
 * The driver's own default (`~/Library/Caches/cua-driver/cua-driver.sock`) is
 * short by construction and already per-user. One daemon per user is also what
 * the driver assumes, so sharing it across nexu instances is its intended
 * model rather than a compromise.
 */
export const CUA_DRIVER_USES_DEFAULT_SOCKET = true;

/**
 * macOS TCC grants attach to CuaDriver.app's signed bundle identity
 * (com.trycua.driver), not to the executable path. The daemon therefore has to
 * be launched as the app — running `Contents/MacOS/cua-driver` directly makes
 * the controller the responsible process and the driver reports no grants.
 *
 * Returns null off darwin, or when the binary is not inside an app bundle.
 */
export function resolveCuaAppBundle(
  binPath: string | null,
  platform: NodeJS.Platform,
): string | null {
  if (platform !== "darwin" || !binPath) {
    return null;
  }
  // <bundle>.app/Contents/MacOS/cua-driver -> <bundle>.app
  const bundle = path.dirname(path.dirname(path.dirname(binPath)));
  return path.extname(bundle) === ".app" ? bundle : null;
}

export function supportsComputerUseBackend(
  backend: ComputerUseBackend | null,
  platform: NodeJS.Platform,
  kernelRelease: string,
): boolean {
  if (backend !== "cua-driver") {
    return false;
  }
  if (platform === "win32") {
    return true;
  }
  if (platform !== "darwin") {
    return false;
  }
  const darwinMajor = Number.parseInt(kernelRelease.split(".")[0] ?? "", 10);
  return Number.isInteger(darwinMajor) && darwinMajor >= MIN_DARWIN_MAJOR;
}
