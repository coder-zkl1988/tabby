import {
  chmod,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import { NexuConfigStore } from "../src/store/nexu-config-store.js";
import { SecretBox } from "../src/store/secret-box.js";

describe("SecretBox", () => {
  let root = "";
  let keyPath = "";

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nexu-secret-box-"));
    keyPath = path.join(root, "secret.key");
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("round-trips a value and never emits it in the clear", () => {
    const box = new SecretBox(keyPath);
    const sealed = box.encrypt("xoxb-super-secret");

    expect(sealed).not.toContain("xoxb-super-secret");
    expect(SecretBox.isEncrypted(sealed)).toBe(true);
    expect(box.decrypt(sealed)).toBe("xoxb-super-secret");
  });

  it("writes the key owner-only", async () => {
    new SecretBox(keyPath).encrypt("x");
    const mode = (await stat(keyPath)).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("passes legacy plaintext through untouched", () => {
    const box = new SecretBox(keyPath);
    expect(box.decrypt("plain-legacy-value")).toBe("plain-legacy-value");
  });

  it("refuses a tampered ciphertext instead of returning garbage", () => {
    const box = new SecretBox(keyPath);
    const sealed = box.encrypt("original");
    const parts = sealed.split(":");
    // Flip the payload; GCM must reject it.
    parts[3] = Buffer.from("tampered").toString("base64url");
    expect(() => box.decrypt(parts.join(":"))).toThrow();
  });

  it("refuses a truncated key file rather than corrupting every secret", async () => {
    await writeFile(keyPath, Buffer.from("short").toString("base64"), "utf8");
    expect(() => new SecretBox(keyPath).encrypt("x")).toThrow(/32-byte key/);
  });

  it("uses a fresh IV per value", () => {
    const box = new SecretBox(keyPath);
    expect(box.encrypt("same")).not.toBe(box.encrypt("same"));
  });
});

describe("NexuConfigStore secret persistence", () => {
  let root = "";
  let env: ControllerEnv;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "nexu-config-secrets-"));
    env = {
      nexuHomeDir: root,
      nexuConfigPath: path.join(root, "config.json"),
      openclawStateDir: path.join(root, "state"),
    } as unknown as ControllerEnv;
  });
  afterEach(async () => rm(root, { recursive: true, force: true }));

  it("keeps secrets out of the file at rest and owner-only on disk", async () => {
    const store = new NexuConfigStore(env);
    await store.setSecret("channel:c1:appSecret", "feishu-plaintext-secret");

    const raw = await readFile(env.nexuConfigPath, "utf8");
    expect(raw).not.toContain("feishu-plaintext-secret");
    expect(JSON.parse(raw).secrets["channel:c1:appSecret"]).toMatch(
      /^enc\.v1:/,
    );

    const mode = (await stat(env.nexuConfigPath)).mode & 0o777;
    expect(mode).toBe(0o600);

    // Callers above the store still see plaintext.
    const reopened = new NexuConfigStore(env);
    await expect(reopened.getSecret("channel:c1:appSecret")).resolves.toBe(
      "feishu-plaintext-secret",
    );
  });

  it("reads a config written before encryption existed and seals it on write", async () => {
    // A 0644 file with plaintext secrets — exactly what shipped before.
    await writeFile(
      env.nexuConfigPath,
      `${JSON.stringify(
        {
          $schema: "https://tabby.happywork.today/config.json",
          schemaVersion: 6,
          app: {},
          bots: [],
          runtime: {
            gateway: { port: 1, bind: "loopback", authMode: "token" },
          },
          secrets: { "channel:c1:appSecret": "legacy-plaintext" },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await chmod(env.nexuConfigPath, 0o644);

    const store = new NexuConfigStore(env);
    await expect(store.getSecret("channel:c1:appSecret")).resolves.toBe(
      "legacy-plaintext",
    );

    await store.setSecret("channel:c1:other", "another");
    const raw = await readFile(env.nexuConfigPath, "utf8");
    expect(raw).not.toContain("legacy-plaintext");
    expect((await stat(env.nexuConfigPath)).mode & 0o777).toBe(0o600);
  });
});
