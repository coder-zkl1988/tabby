import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * `/api/v1/media/screenshots/:filename` reads straight off `env.screenshotsDir`
 * and answers 404 when the file is not there — so a wrong directory fails
 * silently, as a broken image, with nothing in the logs. It was wrong for a
 * while: hardcoded to ~/.openclaw/media/lobster-screenshots, while the phone
 * agent writes to <OPENCLAW_STATE_DIR>/media/tabby-screenshots.
 */
describe("env.screenshotsDir", () => {
  const original = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    process.env = { ...original };
    vi.resetModules();
  });

  it("follows OPENCLAW_STATE_DIR instead of assuming ~/.openclaw", async () => {
    process.env.OPENCLAW_STATE_DIR = "/tmp/nexu-test-state";
    const { env } = await import("../src/app/env.js");
    expect(env.screenshotsDir).toBe(
      path.join("/tmp/nexu-test-state", "media", "tabby-screenshots"),
    );
    expect(env.screenshotsDir).not.toContain("lobster");
  });

  it("stays under the state dir when NEXU_HOME drives the default", async () => {
    // biome-ignore lint/performance/noDelete: must fully unset the key — process.env coerces an `undefined` assignment to the string "undefined".
    delete process.env.OPENCLAW_STATE_DIR;
    process.env.NEXU_HOME = "/tmp/nexu-test-home";
    const { env } = await import("../src/app/env.js");
    expect(env.screenshotsDir).toBe(
      path.join(env.openclawStateDir, "media", "tabby-screenshots"),
    );
  });
});
