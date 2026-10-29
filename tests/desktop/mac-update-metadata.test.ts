import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createAppUpdateYml,
  createLatestMacYml,
  writeAppUpdateYml,
  writeLatestMacYml,
} from "../../apps/desktop/scripts/mac-update-metadata.mjs";

describe("mac update metadata", () => {
  it("writes latest-mac.yml for the update zip", async () => {
    const releaseRoot = await mkdtemp(resolve(tmpdir(), "nexu-mac-update-"));
    const updateZipPath = resolve(releaseRoot, "tabby-1.2.3-arm64.zip");
    await writeFile(updateZipPath, "fake zip content");

    await writeLatestMacYml({
      releaseRoot,
      updateZipPath,
      version: "1.2.3",
      releaseDate: "2026-06-30T00:00:00.000Z",
    });

    const latestMacYml = await readFile(
      resolve(releaseRoot, "latest-mac.yml"),
      "utf8",
    );

    expect(latestMacYml).toContain("version: 1.2.3");
    expect(latestMacYml).toContain("url: tabby-1.2.3-arm64.zip");
    expect(latestMacYml).toContain("path: tabby-1.2.3-arm64.zip");
    expect(latestMacYml).not.toContain(".dmg");
  });

  it("rejects DMG metadata because electron-updater needs a zip", () => {
    expect(() =>
      createLatestMacYml({
        version: "1.2.3",
        file: {
          url: "tabby-1.2.3-arm64.dmg",
          sha512: "abc",
          size: 123,
        },
        releaseDate: "2026-06-30T00:00:00.000Z",
      }),
    ).toThrow("macOS electron-updater metadata must reference a .zip artifact");
  });

  it("writes app-update.yml for the packaged macOS app", async () => {
    const releaseRoot = await mkdtemp(resolve(tmpdir(), "nexu-mac-update-"));
    const appPath = resolve(releaseRoot, "Tabby.app");
    await mkdir(resolve(appPath, "Contents", "Resources"), {
      recursive: true,
    });

    await writeAppUpdateYml({
      appPath,
      channel: "stable",
      arch: "arm64",
    });

    const appUpdateYml = await readFile(
      resolve(appPath, "Contents", "Resources", "app-update.yml"),
      "utf8",
    );

    expect(appUpdateYml).toBe(
      [
        "provider: generic",
        "url: https://downloads.happywork.today/updates/stable/arm64",
        "updaterCacheDirName: tabby-updater",
        "",
      ].join("\n"),
    );
  });

  it("rejects unsupported macOS update architectures", () => {
    expect(() =>
      createAppUpdateYml({
        channel: "stable",
        arch: "ia32",
      }),
    ).toThrow("Unsupported macOS update architecture");
  });
});
