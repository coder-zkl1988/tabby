import { mkdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ControllerEnv } from "../src/app/env.js";
import {
  readAgentAuthStore,
  writeAgentAuthStore,
} from "../src/runtime/openclaw-agent-auth-db.js";
import { OpenClawAuthService } from "../src/services/openclaw-auth-service.js";

type AuthProfilesData = {
  version: number;
  profiles: Record<string, unknown>;
};

type TestOAuthProfile = {
  type: "oauth";
  provider: string;
  access: string;
  refresh: string;
  expires: number;
  accountId: string;
};

type OpenClawAuthServiceInternals = {
  mergeOAuthProfile: (key: string, profile: TestOAuthProfile) => Promise<void>;
};

function createEnv(rootDir: string): ControllerEnv {
  return {
    nodeEnv: "test",
    port: 3010,
    host: "127.0.0.1",
    webUrl: "http://localhost:5173",
    nexuHomeDir: path.join(rootDir, ".nexu"),
    nexuConfigPath: path.join(rootDir, ".nexu", "config.json"),
    artifactsIndexPath: path.join(rootDir, ".nexu", "artifacts", "index.json"),
    compiledOpenclawSnapshotPath: path.join(
      rootDir,
      ".nexu",
      "compiled-openclaw.json",
    ),
    openclawStateDir: path.join(rootDir, ".openclaw"),
    openclawConfigPath: path.join(rootDir, ".openclaw", "openclaw.json"),
    openclawSkillsDir: path.join(rootDir, ".openclaw", "skills"),
    openclawExtensionsDir: path.join(rootDir, ".openclaw", "extensions"),
    runtimePluginTemplatesDir: path.join(rootDir, "runtime-plugins"),
    openclawCuratedSkillsDir: path.join(rootDir, ".openclaw", "bundled-skills"),
    openclawRuntimeModelStatePath: path.join(
      rootDir,
      ".openclaw",
      "nexu-runtime-model.json",
    ),
    skillhubCacheDir: path.join(rootDir, ".nexu", "skillhub-cache"),
    skillDbPath: path.join(rootDir, ".nexu", "skill-ledger.json"),
    analyticsStatePath: path.join(rootDir, ".nexu", "analytics-state.json"),
    staticSkillsDir: undefined,
    platformTemplatesDir: undefined,
    openclawWorkspaceTemplatesDir: path.join(
      rootDir,
      ".openclaw",
      "workspace-templates",
    ),
    openclawBin: "openclaw",
    litellmBaseUrl: null,
    litellmApiKey: null,
    openclawGatewayPort: 18789,
    openclawGatewayToken: undefined,
    manageOpenclawProcess: false,
    gatewayProbeEnabled: false,
    runtimeSyncIntervalMs: 2000,
    runtimeHealthIntervalMs: 5000,
    defaultModelId: "anthropic/claude-sonnet-4",
    posthogApiKey: undefined,
    posthogHost: undefined,
  };
}

// Seeds the per-agent OpenClaw SQLite store (OpenClaw >= 2026.6.5 reads auth
// profiles only from `<agent>/agent/openclaw-agent.sqlite`, not the legacy
// JSON file). Only the secrets store (version + profiles) is controller-owned;
// auth_profile_state (usage stats / lastGood) is owned by OpenClaw.
function writeAgentAuthProfiles(
  env: ControllerEnv,
  agentId: string,
  data: AuthProfilesData,
): string {
  const filePath = path.join(
    env.openclawStateDir,
    "agents",
    agentId,
    "agent",
    "openclaw-agent.sqlite",
  );
  // OpenClaw owns the database file; since 2026.9 the controller refuses to
  // create one, because a database without schema ownership metadata blocks
  // gateway startup and cannot be repaired. Stand in for OpenClaw here.
  mkdirSync(path.dirname(filePath), { recursive: true });
  new DatabaseSync(filePath).close();
  writeAgentAuthStore(filePath, {
    version: data.version,
    profiles: data.profiles,
  });
  return filePath;
}

function readAuthProfiles(filePath: string): AuthProfilesData {
  const cell = readAgentAuthStore(filePath);
  return cell
    ? { version: cell.version, profiles: cell.profiles }
    : { version: 1, profiles: {} };
}

describe("OpenClawAuthService", () => {
  let rootDir = "";
  let env: ControllerEnv;

  beforeEach(async () => {
    rootDir = await mkdtemp(path.join(tmpdir(), "nexu-openclaw-auth-"));
    env = createEnv(rootDir);
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it("writes the OAuth profile to every agent workspace and preserves metadata", async () => {
    const service = new OpenClawAuthService(env);
    const authService = service as unknown as OpenClawAuthServiceInternals;
    const profile: TestOAuthProfile = {
      type: "oauth",
      provider: "openai-codex",
      access: "access-token",
      refresh: "refresh-token",
      expires: Date.now() + 60_000,
      accountId: "acct_123",
    };

    const firstPath = writeAgentAuthProfiles(env, "bot-a", {
      version: 2,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant",
        },
        "existing-oauth:default": {
          type: "oauth",
          provider: "custom",
          access: "old",
          refresh: "old-refresh",
          expires: 123,
          accountId: "old-acct",
        },
      },
    });
    const secondPath = writeAgentAuthProfiles(env, "bot-b", {
      version: 3,
      profiles: {},
    });

    await authService.mergeOAuthProfile("openai-codex:default", profile);

    expect(readAuthProfiles(firstPath)).toMatchObject({
      version: 2,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant",
        },
        "existing-oauth:default": {
          type: "oauth",
          provider: "custom",
        },
        "openai-codex:default": profile,
      },
    });
    expect(readAuthProfiles(secondPath)).toMatchObject({
      version: 3,
      profiles: {
        "openai-codex:default": profile,
      },
    });
  });

  it("reports connected when any agent workspace has a valid OAuth profile", async () => {
    const service = new OpenClawAuthService(env);
    const expiredAt = Date.now() - 5_000;
    const validExpiresAt = Date.now() + 60_000;

    writeAgentAuthProfiles(env, "bot-a", {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "expired",
          refresh: "refresh",
          expires: expiredAt,
          accountId: "acct-old",
        },
      },
    });
    writeAgentAuthProfiles(env, "bot-b", {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "valid",
          refresh: "refresh",
          expires: validExpiresAt,
          accountId: "acct-new",
        },
      },
    });

    const status = await service.getProviderOAuthStatus("openai");

    expect(status.connected).toBe(true);
    expect(status.provider).toBe("openai-codex");
    expect(status.expiresAt).toBe(validExpiresAt);
    expect(status.remainingMs).toBeGreaterThan(0);
  });

  it("disconnects the OAuth profile from every agent workspace", async () => {
    const service = new OpenClawAuthService(env);
    const firstPath = writeAgentAuthProfiles(env, "bot-a", {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-a",
          refresh: "refresh-a",
          expires: Date.now() + 60_000,
          accountId: "acct-a",
        },
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant",
        },
      },
    });
    const secondPath = writeAgentAuthProfiles(env, "bot-b", {
      version: 1,
      profiles: {
        "openai-codex:default": {
          type: "oauth",
          provider: "openai-codex",
          access: "access-b",
          refresh: "refresh-b",
          expires: Date.now() + 60_000,
          accountId: "acct-b",
        },
      },
    });

    await expect(service.disconnectOAuth("openai")).resolves.toBe(true);
    expect(readAuthProfiles(firstPath)).toMatchObject({
      version: 1,
      profiles: {
        "anthropic:default": {
          type: "api_key",
          provider: "anthropic",
          key: "sk-ant",
        },
      },
    });
    expect(readAuthProfiles(secondPath)).toMatchObject({
      version: 1,
      profiles: {},
    });
  });
});
