import { createHash } from "node:crypto";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

export const DEFAULT_MAC_UPDATE_BASE_URL =
  "https://downloads.happywork.today/updates";

function assertSupportedMacArch(arch) {
  if (arch === "arm64" || arch === "x64") {
    return arch;
  }

  throw new Error(
    `Unsupported macOS update architecture "${arch}". Expected "arm64" or "x64".`,
  );
}

export function resolveMacUpdateFeedUrl({
  channel,
  arch,
  baseUrl = DEFAULT_MAC_UPDATE_BASE_URL,
}) {
  return `${baseUrl.replace(/\/+$/u, "")}/${channel}/${assertSupportedMacArch(
    arch,
  )}`;
}

export async function getUpdateFileInfo(filePath) {
  const bytes = await readFile(filePath);
  const fileStat = await stat(filePath);

  return {
    url: basename(filePath),
    sha512: createHash("sha512").update(bytes).digest("base64"),
    size: fileStat.size,
  };
}

export function createLatestMacYml({ version, file, releaseDate }) {
  if (!file.url.endsWith(".zip")) {
    throw new Error(
      `macOS electron-updater metadata must reference a .zip artifact, received ${file.url}.`,
    );
  }

  return [
    `version: ${version}`,
    "files:",
    `  - url: ${file.url}`,
    `    sha512: ${file.sha512}`,
    `    size: ${file.size}`,
    `path: ${file.url}`,
    `sha512: ${file.sha512}`,
    `releaseDate: '${releaseDate ?? new Date().toISOString()}'`,
    "",
  ].join("\n");
}

export function createAppUpdateYml({
  channel,
  arch,
  baseUrl,
  updaterCacheDirName = "tabby-updater",
}) {
  return [
    "provider: generic",
    `url: ${resolveMacUpdateFeedUrl({ channel, arch, baseUrl })}`,
    `updaterCacheDirName: ${updaterCacheDirName}`,
    "",
  ].join("\n");
}

export async function writeAppUpdateYml({
  appPath,
  channel,
  arch,
  baseUrl,
  updaterCacheDirName,
}) {
  const resourcesPath = resolve(appPath, "Contents", "Resources");
  await mkdir(resourcesPath, { recursive: true });

  const appUpdateYml = createAppUpdateYml({
    channel,
    arch,
    baseUrl,
    updaterCacheDirName,
  });
  await writeFile(resolve(resourcesPath, "app-update.yml"), appUpdateYml);
  return appUpdateYml;
}

export async function writeLatestMacYml({
  releaseRoot,
  updateZipPath,
  version,
  releaseDate,
}) {
  const file = await getUpdateFileInfo(updateZipPath);
  const latestMacYml = createLatestMacYml({ version, file, releaseDate });
  await writeFile(resolve(releaseRoot, "latest-mac.yml"), latestMacYml);
  return latestMacYml;
}
