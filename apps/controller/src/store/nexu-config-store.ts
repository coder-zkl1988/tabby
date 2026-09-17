import crypto from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  BotOrigin,
  BotResponse,
  ChannelResponse,
  ConnectDingtalkInput,
  ConnectDiscordInput,
  ConnectFeishuInput,
  ConnectQqbotInput,
  ConnectSlackInput,
  ConnectWecomInput,
  CreateScheduleInput,
  CreditRechargeRecord,
  DesktopRewardClaimProof,
  DesktopRewardsStatus,
  FeishuChannelCapabilities,
  FeishuPermissions,
  ModelProviderConfig,
  PersistedModelsConfig,
  RewardTask,
  RewardTaskId,
  ScheduleResponse,
  SlackChannelCapabilities,
  UpdateScheduleInput,
} from "@nexu/shared";
import {
  type claimDesktopRewardResponseSchema,
  type cloudProfileSchema,
  type connectIntegrationResponseSchema,
  type connectIntegrationSchema,
  getDefaultProviderBaseUrls,
  getProviderRuntimePolicy,
  type integrationResponseSchema,
  parseCustomProviderKey,
  type refreshIntegrationSchema,
  rewardGroupSchema,
  rewardTaskIdSchema,
  rewardTasks,
  type updateAuthSourceSchema,
  type updateUserProfileSchema,
  type upsertProviderBodySchema,
  userProfileResponseSchema,
} from "@nexu/shared";
import type { z } from "zod";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";
import {
  isManagedCloudModelId,
  resolveManagedCloudModel,
} from "../lib/managed-models.js";
import { proxyFetch } from "../lib/proxy-fetch.js";
import {
  type CloudRewardService,
  type RewardStatusResponse,
  createCloudRewardService,
} from "../services/cloud-reward-service.js";
import { LowDbStore } from "./lowdb-store.js";
import {
  CANONICAL_MODELS_PROVIDERS_CUTOVER_SCHEMA_VERSION,
  type CloudProfileEntry,
  type CloudProfilesFile,
  type ControllerRuntimeConfig,
  type DeviceControlConfig,
  type LocalAutomationConfig,
  type MemoryConfig,
  type MemosConfig,
  type NexuConfig,
  cloudProfilesFileSchema,
  nexuConfigSchema,
  type storedProviderResponseSchema,
} from "./schemas.js";
import { SecretBox } from "./secret-box.js";

const DEFAULT_MANAGED_CHANNEL_ACCOUNT_ID = "default";

type UpsertProviderBody = z.infer<typeof upsertProviderBodySchema>;
type IntegrationResponse = z.infer<typeof integrationResponseSchema>;
type StoredProviderResponse = z.infer<typeof storedProviderResponseSchema>;
type ConnectIntegrationInput = z.infer<typeof connectIntegrationSchema>;
type ConnectIntegrationResponse = z.infer<
  typeof connectIntegrationResponseSchema
>;
type RefreshIntegrationInput = z.infer<typeof refreshIntegrationSchema>;
type UserProfileResponse = z.infer<typeof userProfileResponseSchema>;
type UpdateUserProfileInput = z.infer<typeof updateUserProfileSchema>;
type UpdateAuthSourceInput = z.infer<typeof updateAuthSourceSchema>;
type CloudProfileInput = z.infer<typeof cloudProfileSchema>;

type CloudModel = { id: string; name: string; provider?: string };
type DesktopCloudState = {
  connected: boolean;
  polling: boolean;
  userId?: string | null;
  userName?: string | null;
  userEmail?: string | null;
  connectedAt?: string | null;
  linkUrl?: string | null;
  apiKey?: string | null;
  models?: Array<{ id: string; name: string; provider?: string }>;
};

type CloudPollingState = {
  deviceId: string;
  deviceSecret: string;
  abortController: AbortController;
};

type DesktopRewardClaimResponse = z.infer<
  typeof claimDesktopRewardResponseSchema
>;

type DesktopBalanceBreakdown = {
  giftedBalance: number;
  planBalance: number;
};

const defaultCloudProfile: CloudProfileEntry = {
  name: "Default",
  cloudUrl: "https://tabby.picaso.studio",
  linkUrl: "https://tabbyapi.picaso.studio",
};

const rewardTaskTemplateById = new Map<RewardTaskId, RewardTask>(
  rewardTasks.map((task) => [task.id, task]),
);

const GIFTED_CREDIT_SOURCES = new Set<CreditRechargeRecord["source"]>([
  "signup_bonus",
  "daily_bonus",
  "github_star",
  "social_share",
  "test",
]);

export type DesktopCloudStateChange = {
  hadCloudInventory: boolean;
  hasCloudInventory: boolean;
  connected: boolean;
};

function describeFetchError(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const parts = [error.message];
  const cause = error.cause;

  if (cause && typeof cause === "object") {
    const code = "code" in cause ? cause.code : undefined;
    const message = "message" in cause ? cause.message : undefined;

    if (typeof code === "string" && code.length > 0) {
      parts.push(code);
    }

    if (typeof message === "string" && message.length > 0) {
      parts.push(message);
    }
  }

  return parts.join(" | ");
}

const MAX_CLOUD_ERROR_BODY_LENGTH = 300;

async function describeCloudErrorResponse(res: Response): Promise<string> {
  const body = await res.text().catch(() => "");
  const contentType = res.headers.get("content-type") ?? "";
  const looksLikeHtml =
    contentType.includes("text/html") ||
    /^\s*<(!doctype|html)[\s>]/i.test(body);
  if (res.headers.get("cf-mitigated") === "challenge" || looksLikeHtml) {
    return `HTTP ${res.status}: blocked by a bot-protection challenge before reaching the cloud API. The current network/proxy exit IP is likely flagged - switch the proxy node or bypass the proxy for this domain, then retry.`;
  }
  const compact = body.replace(/\s+/g, " ").trim();
  const truncated =
    compact.length > MAX_CLOUD_ERROR_BODY_LENGTH
      ? `${compact.slice(0, MAX_CLOUD_ERROR_BODY_LENGTH)}…`
      : compact;
  return truncated.length > 0
    ? `HTTP ${res.status}: ${truncated}`
    : `HTTP ${res.status}`;
}

function buildLinkModelsUrl(baseUrl: string): string {
  return new URL(
    "v1/models",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).toString();
}

function buildCloudMeUrl(baseUrl: string): string {
  return new URL(
    "api/v1/me",
    baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`,
  ).toString();
}

type CloudPollResponse = {
  status: string;
  apiKey?: string;
  userId?: string;
  userName?: string;
  userEmail?: string;
  cloudModels?: CloudModel[];
  linkGatewayUrl?: string;
};

function defaultLocalProfile(): UserProfileResponse {
  return {
    id: "desktop-local-user",
    email: "desktop@nexu.local",
    name: "Desktop User",
    image: null,
    plan: "local",
    inviteAccepted: true,
    onboardingCompleted: true,
    authSource: "desktop-local",
  };
}

function readLocalProfile(config: NexuConfig): UserProfileResponse {
  const desktop = config.desktop as Record<string, unknown>;
  const parsed = userProfileResponseSchema.safeParse(desktop.localProfile);
  return parsed.success ? parsed.data : defaultLocalProfile();
}

function normalizeDesktopCloudState(
  cloud: Record<string, unknown> | null,
): DesktopCloudState {
  return {
    connected: cloud?.connected === true,
    polling: cloud?.polling === true,
    userId: typeof cloud?.userId === "string" ? cloud.userId : null,
    userName: typeof cloud?.userName === "string" ? cloud.userName : null,
    userEmail: typeof cloud?.userEmail === "string" ? cloud.userEmail : null,
    connectedAt:
      typeof cloud?.connectedAt === "string" ? cloud.connectedAt : null,
    linkUrl: typeof cloud?.linkUrl === "string" ? cloud.linkUrl : undefined,
    apiKey: typeof cloud?.apiKey === "string" ? cloud.apiKey : undefined,
    models: Array.isArray(cloud?.models)
      ? (cloud.models as Array<{ id: string; name: string; provider?: string }>)
      : [],
  };
}

function readDesktopCloud(config: NexuConfig): DesktopCloudState {
  const desktop = config.desktop as Record<string, unknown>;
  const cloud =
    typeof desktop.cloud === "object" && desktop.cloud !== null
      ? (desktop.cloud as Record<string, unknown>)
      : null;

  return normalizeDesktopCloudState(cloud);
}

function readDesktopCloudSessions(
  config: NexuConfig,
): Record<string, DesktopCloudState> {
  const desktop = config.desktop as Record<string, unknown>;
  const sessions =
    typeof desktop.cloudSessions === "object" && desktop.cloudSessions !== null
      ? (desktop.cloudSessions as Record<string, unknown>)
      : {};

  return Object.fromEntries(
    Object.entries(sessions).map(([name, value]) => [
      name,
      normalizeDesktopCloudState(
        typeof value === "object" && value !== null
          ? (value as Record<string, unknown>)
          : null,
      ),
    ]),
  );
}

function readDesktopLocale(config: NexuConfig): "en" | "zh-CN" | null {
  const desktop = config.desktop as Record<string, unknown>;
  if (desktop.locale === "zh-CN") {
    return "zh-CN";
  }
  if (desktop.locale === "en") {
    return "en";
  }
  return null;
}

function readDesktopActiveCloudProfileName(config: NexuConfig): string | null {
  const desktop = config.desktop as Record<string, unknown>;
  return typeof desktop.activeCloudProfileName === "string"
    ? desktop.activeCloudProfileName
    : null;
}

function normalizeImportedCloudProfiles(
  profiles: CloudProfileInput[],
): CloudProfileEntry[] {
  const deduped = new Map<string, CloudProfileEntry>();

  for (const profile of profiles) {
    const name = profile.name.trim();
    if (name.length === 0 || name === defaultCloudProfile.name) {
      continue;
    }

    deduped.set(name, {
      name,
      cloudUrl: profile.cloudUrl.trim(),
      linkUrl: profile.linkUrl.trim(),
    });
  }

  return [defaultCloudProfile, ...Array.from(deduped.values())];
}

function isDefaultCloudProfileName(name: string): boolean {
  return name.trim() === defaultCloudProfile.name;
}

function now(): string {
  return new Date().toISOString();
}

function parseModelsJson(modelsJson: string | undefined): string[] {
  if (!modelsJson) {
    return [];
  }

  try {
    const parsed = JSON.parse(modelsJson) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === "string");
  } catch {
    return [];
  }
}

function getProviderMetadata(
  provider: ModelProviderConfig | undefined,
): Record<string, unknown> | null {
  if (!provider) {
    return null;
  }
  return typeof provider.metadata === "object" && provider.metadata !== null
    ? provider.metadata
    : null;
}

function getLegacyProviderField(
  provider: ModelProviderConfig,
  key: string,
): string | null {
  const metadata = getProviderMetadata(provider);
  const value = metadata?.[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function getLegacyOauthCredential(provider: ModelProviderConfig): {
  provider: string;
  access: string;
  refresh?: string;
  expires?: number;
  email?: string;
} | null {
  const metadata = getProviderMetadata(provider);
  const value = metadata?.legacyOauthCredential;
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const credential = value as Record<string, unknown>;
  if (
    typeof credential.provider !== "string" ||
    typeof credential.access !== "string"
  ) {
    return null;
  }

  return {
    provider: credential.provider,
    access: credential.access,
    ...(typeof credential.refresh === "string"
      ? { refresh: credential.refresh }
      : {}),
    ...(typeof credential.expires === "number"
      ? { expires: credential.expires }
      : {}),
    ...(typeof credential.email === "string"
      ? { email: credential.email }
      : {}),
  };
}

function serializeProvider(
  providerId: string,
  provider: ModelProviderConfig,
): StoredProviderResponse {
  const oauthCredential = getLegacyOauthCredential(provider);
  const modelIds = provider.models.map((model) => model.id);
  return {
    id: getLegacyProviderField(provider, "legacyId") ?? providerId,
    providerId,
    displayName: provider.displayName ?? null,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl ?? null,
    authMode: provider.auth === "oauth" ? "oauth" : "apiKey",
    hasApiKey:
      typeof provider.apiKey === "string" && provider.apiKey.length > 0,
    hasOauthCredential: oauthCredential !== null,
    oauthRegion: provider.oauthRegion ?? null,
    oauthEmail: oauthCredential?.email ?? null,
    modelsJson: JSON.stringify(modelIds),
    createdAt: getLegacyProviderField(provider, "legacyCreatedAt") ?? undefined,
    updatedAt: getLegacyProviderField(provider, "legacyUpdatedAt") ?? undefined,
    apiKey: typeof provider.apiKey === "string" ? provider.apiKey : null,
    models: modelIds,
  };
}

function listCanonicalProviders(config: NexuConfig): StoredProviderResponse[] {
  return Object.entries(config.models.providers).map(([providerId, provider]) =>
    serializeProvider(providerId, provider),
  );
}

function buildProviderBaseUrl(
  providerId: string,
  baseUrl: string | null | undefined,
  oauthRegion: "global" | "cn" | null | undefined,
): string {
  if (typeof baseUrl === "string" && baseUrl.trim().length > 0) {
    return baseUrl;
  }
  if (providerId === "minimax" && oauthRegion === "cn") {
    return "https://api.minimaxi.com/anthropic";
  }
  return (
    getDefaultProviderBaseUrls(providerId)[0] ?? "https://api.openai.com/v1"
  );
}

function buildProviderConfig(
  providerKey: string,
  input: UpsertProviderBody,
  currentTime: string,
  existing?: ModelProviderConfig,
): ModelProviderConfig {
  const customProvider = parseCustomProviderKey(providerKey);
  const providerId = customProvider?.templateId ?? providerKey;
  const runtimePolicy = getProviderRuntimePolicy(providerId);
  const existingMetadata = getProviderMetadata(existing) ?? {};
  const authMode =
    input.authMode ?? (existing?.auth === "oauth" ? "oauth" : "apiKey");
  const nextModels =
    input.modelsJson === undefined
      ? (existing?.models ?? [])
      : parseModelsJson(input.modelsJson).map((modelId) => ({
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"] as Array<"text" | "image">,
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: 0,
          maxTokens: 0,
          ...(runtimePolicy?.apiKind ? { api: runtimePolicy.apiKind } : {}),
        }));
  const nextOauthRegion =
    authMode === "apiKey" ? null : (existing?.oauthRegion ?? null);
  const nextMetadata: Record<string, unknown> = {
    ...existingMetadata,
    legacyId:
      (typeof existingMetadata.legacyId === "string" &&
        existingMetadata.legacyId) ||
      crypto.randomUUID(),
    legacyCreatedAt:
      (typeof existingMetadata.legacyCreatedAt === "string" &&
        existingMetadata.legacyCreatedAt) ||
      currentTime,
    legacyUpdatedAt: currentTime,
  };

  return {
    ...(customProvider
      ? {
          providerTemplateId: customProvider.templateId,
          instanceId: customProvider.instanceId,
        }
      : {}),
    enabled: input.enabled ?? existing?.enabled ?? true,
    ...((input.displayName ?? existing?.displayName)
      ? { displayName: input.displayName ?? existing?.displayName }
      : {}),
    baseUrl: buildProviderBaseUrl(
      providerId,
      input.baseUrl === undefined ? existing?.baseUrl : input.baseUrl,
      nextOauthRegion,
    ),
    ...(authMode === "oauth"
      ? {
          auth: "oauth" as const,
          ...(existing?.oauthProfileRef
            ? { oauthProfileRef: existing.oauthProfileRef }
            : {}),
        }
      : { auth: "api-key" as const }),
    ...(runtimePolicy?.apiKind ? { api: runtimePolicy.apiKind } : {}),
    ...(authMode === "apiKey"
      ? {
          apiKey:
            input.apiKey === undefined
              ? existing?.apiKey
              : (input.apiKey ?? undefined),
        }
      : {}),
    ...(nextOauthRegion ? { oauthRegion: nextOauthRegion } : {}),
    models: nextModels,
    metadata:
      authMode === "apiKey"
        ? Object.fromEntries(
            Object.entries(nextMetadata).filter(
              ([key]) => key !== "legacyOauthCredential",
            ),
          )
        : nextMetadata,
  };
}

function convertCloudStatusToDesktop(
  cloudStatus: RewardStatusResponse,
  viewer: {
    cloudConnected: boolean;
    activeModelId: string | null;
    activeManagedModel: { provider?: string } | null | undefined;
  },
  balanceBreakdown?: DesktopBalanceBreakdown,
): DesktopRewardsStatus {
  const { cloudConnected, activeModelId, activeManagedModel } = viewer;
  const tasks = cloudStatus.tasks.flatMap((task) => {
    const parsedTaskId = rewardTaskIdSchema.safeParse(task.id);
    const parsedGroupId = rewardGroupSchema.safeParse(task.groupId);
    if (!parsedTaskId.success || !parsedGroupId.success) {
      return [];
    }

    return {
      id: parsedTaskId.data as RewardTaskId,
      group: parsedGroupId.data,
      icon: task.icon ?? "gift",
      reward: task.rewardPoints,
      shareMode: task.shareMode as "link" | "tweet" | "image",
      repeatMode: task.repeatMode as "once" | "daily" | "weekly",
      requiresScreenshot: task.shareMode === "image",
      actionUrl:
        rewardTaskTemplateById.get(parsedTaskId.data)?.actionUrl ?? null,
      isClaimed: task.isClaimed,
      lastClaimedAt: task.lastClaimedAt,
      claimCount: task.claimCount,
    };
  });

  return {
    viewer: {
      cloudConnected,
      activeModelId,
      activeModelProviderId:
        activeManagedModel?.provider ??
        (activeManagedModel ? "nexu" : (activeModelId?.split("/")[0] ?? null)),
      usingManagedModel: activeManagedModel != null,
    },
    progress: {
      ...cloudStatus.progress,
      claimedCount: tasks.filter((task) => task.isClaimed).length,
      totalCount: tasks.length,
    },
    tasks,
    cloudBalance: cloudStatus.cloudBalance
      ? {
          totalBalance: cloudStatus.cloudBalance.totalBalance,
          totalRecharged: cloudStatus.cloudBalance.totalRecharged,
          totalConsumed: cloudStatus.cloudBalance.totalConsumed,
          giftedBalance: balanceBreakdown?.giftedBalance ?? 0,
          planBalance:
            balanceBreakdown?.planBalance ??
            cloudStatus.cloudBalance.totalBalance,
        }
      : null,
  };
}

function isActiveCreditGrant(
  grant: CreditRechargeRecord,
  nowTimestamp: number,
): boolean {
  if (!grant.enabled) {
    return false;
  }

  const expiresAtTimestamp = Date.parse(grant.expiresAt);
  if (!Number.isFinite(expiresAtTimestamp)) {
    return true;
  }

  return expiresAtTimestamp > nowTimestamp;
}

function deriveDesktopBalanceBreakdown(input: {
  totalBalance: number;
  grants: CreditRechargeRecord[];
}): DesktopBalanceBreakdown & { giftedBalanceRaw: number } {
  const nowTimestamp = Date.now();
  const giftedBalanceRaw = input.grants.reduce((sum, grant) => {
    if (!GIFTED_CREDIT_SOURCES.has(grant.source)) {
      return sum;
    }

    if (!isActiveCreditGrant(grant, nowTimestamp)) {
      return sum;
    }

    return sum + grant.balance;
  }, 0);

  const giftedBalance = Math.min(giftedBalanceRaw, input.totalBalance);

  return {
    giftedBalance,
    planBalance: Math.max(input.totalBalance - giftedBalance, 0),
    giftedBalanceRaw,
  };
}

/**
 * Remove secrets whose keys start with any of the given channel ID prefixes.
 * Used to clean up orphaned secrets when a channel is replaced or deleted.
 */
function removeOrphanedSecrets(
  secrets: Record<string, string>,
  channelIds: string[],
): Record<string, string> {
  if (channelIds.length === 0) return secrets;
  const prefixes = channelIds.map((id) => `channel:${id}:`);
  return Object.fromEntries(
    Object.entries(secrets).filter(
      ([key]) => !prefixes.some((p) => key.startsWith(p)),
    ),
  );
}

export class NexuConfigStore {
  private readonly store: LowDbStore<NexuConfig>;
  private readonly cloudProfilesStore: LowDbStore<CloudProfilesFile>;
  private pollingState: CloudPollingState | null = null;

  /** Callback fired when cloud state changes (connect/disconnect). */
  onCloudStateChanged?: (change: DesktopCloudStateChange) => Promise<void>;

  private readonly secretBox: SecretBox;

  constructor(private readonly env: ControllerEnv) {
    this.secretBox = new SecretBox(path.join(env.nexuHomeDir, "secret.key"));
    this.store = new LowDbStore<NexuConfig>(
      env.nexuConfigPath,
      nexuConfigSchema,
      () => ({
        $schema: "https://tabby.picaso.studio/config.json",
        schemaVersion: CANONICAL_MODELS_PROVIDERS_CUTOVER_SCHEMA_VERSION,
        app: {},
        bots: [],
        runtime: {
          gateway: {
            port: env.openclawGatewayPort,
            bind: "loopback",
            authMode: env.openclawGatewayToken ? "token" : "none",
          },
          defaultModelId: env.defaultModelId,
          utilityModelId: null,
        },
        models: {
          mode: "merge",
          providers: {},
        },
        integrations: [],
        channels: [],
        templates: {},
        desktop: {
          analyticsEnabled: true,
        },
        deviceControl: {
          enabled: true,
          wsPort: 18790,
          rpcPort: 18801,
        },
        localAutomation: {
          browser: { enabled: false },
          computerUse: { enabled: false },
        },
        memory: {
          enabled: true,
          sources: ["memory"],
          extraPaths: [],
          syncIntervalMinutes: 5,
          provider: "none",
          minScore: 0.2,
        },
        memos: {
          enabled: false,
          userId: "tabby-user",
          memoryLimitNumber: 9,
          preferenceLimitNumber: 6,
          relativity: 0.4,
        },
        schedules: [],
        secrets: {},
      }),
      {
        // Credentials are encrypted at rest and the file is owner-only. This
        // does not stop the agent (same OS user, see SecretBox), it stops the
        // config being readable by other accounts and being usable when the
        // file alone is copied into a bug report or a backup.
        fileMode: 0o600,
        transform: {
          onWrite: (config) => ({
            ...config,
            secrets: Object.fromEntries(
              Object.entries(config.secrets).map(([key, value]) => [
                key,
                SecretBox.isEncrypted(value)
                  ? value
                  : this.secretBox.encrypt(value),
              ]),
            ),
          }),
          onRead: (config) => ({
            ...config,
            secrets: Object.fromEntries(
              Object.entries(config.secrets).map(([key, value]) => [
                key,
                this.secretBox.decrypt(value),
              ]),
            ),
          }),
        },
      },
    );
    this.cloudProfilesStore = new LowDbStore<CloudProfilesFile>(
      path.join(env.nexuHomeDir, "cloud-profiles.json"),
      cloudProfilesFileSchema,
      () => ({
        schemaVersion: 1,
        profiles: [defaultCloudProfile],
      }),
    );
  }

  async getConfig(): Promise<NexuConfig> {
    return this.store.read();
  }

  private async listStoredCloudProfiles(): Promise<CloudProfileEntry[]> {
    const file = await this.cloudProfilesStore.read();
    return normalizeImportedCloudProfiles(file.profiles);
  }

  private resolveActiveCloudProfile(
    profiles: CloudProfileEntry[],
    activeProfileName: string | null,
  ): CloudProfileEntry {
    return (
      profiles.find((profile) => profile.name === activeProfileName) ??
      profiles.find((profile) => profile.name === defaultCloudProfile.name) ??
      defaultCloudProfile
    );
  }

  private async readConfiguredDesktopCloudProfile(config: NexuConfig) {
    const profiles = await this.listStoredCloudProfiles();
    const activeProfileName = readDesktopActiveCloudProfileName(config);
    const activeProfile = this.resolveActiveCloudProfile(
      profiles,
      activeProfileName,
    );
    return { profiles, activeProfile };
  }

  private async writeActiveDesktopCloudState(
    input: DesktopCloudState,
  ): Promise<void> {
    await this.store.update((config) => {
      const activeProfileName =
        readDesktopActiveCloudProfileName(config) ?? defaultCloudProfile.name;
      const sessions = readDesktopCloudSessions(config);

      return {
        ...config,
        desktop: {
          ...config.desktop,
          cloud: {
            connected: input.connected,
            polling: input.polling,
            userId: input.userId ?? null,
            userName: input.userName ?? null,
            userEmail: input.userEmail ?? null,
            connectedAt: input.connectedAt ?? null,
            linkUrl: input.linkUrl ?? null,
            apiKey: input.apiKey ?? null,
            models: input.models ?? [],
          },
          cloudSessions: {
            ...sessions,
            [activeProfileName]: {
              connected: input.connected,
              polling: input.polling,
              userId: input.userId ?? null,
              userName: input.userName ?? null,
              userEmail: input.userEmail ?? null,
              connectedAt: input.connectedAt ?? null,
              linkUrl: input.linkUrl ?? null,
              apiKey: input.apiKey ?? null,
              models: input.models ?? [],
            },
          },
        },
      };
    });
  }

  private async resolveDesktopCloudLinkUrl(
    config: NexuConfig,
    linkUrl?: string | null,
  ): Promise<string> {
    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    return linkUrl ?? activeProfile.linkUrl ?? activeProfile.cloudUrl;
  }

  private async resolveDesktopCloudApiUrl(config: NexuConfig): Promise<string> {
    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    return activeProfile.cloudUrl;
  }

  async reconcileConfiguredDesktopCloudState(): Promise<void> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);

    if (!cloud.connected) {
      return;
    }

    const linkUrl = await this.resolveDesktopCloudLinkUrl(
      config,
      cloud.linkUrl,
    );
    if (cloud.linkUrl === linkUrl) {
      return;
    }

    const endpointChanged = cloud.linkUrl !== linkUrl;

    await this.setDesktopCloudState({
      connected: endpointChanged ? false : cloud.connected,
      polling: false,
      userId: endpointChanged ? null : (cloud.userId ?? null),
      userName: endpointChanged ? null : (cloud.userName ?? null),
      userEmail: endpointChanged ? null : (cloud.userEmail ?? null),
      connectedAt: endpointChanged ? null : (cloud.connectedAt ?? null),
      linkUrl,
      apiKey: endpointChanged ? null : (cloud.apiKey ?? null),
      models: endpointChanged ? [] : (cloud.models ?? []),
    });
  }

  private async setDesktopCloudState(input: {
    connected: boolean;
    polling: boolean;
    userId?: string | null;
    userName?: string | null;
    userEmail?: string | null;
    connectedAt?: string | null;
    linkUrl?: string | null;
    apiKey?: string | null;
    models?: CloudModel[];
  }): Promise<void> {
    await this.writeActiveDesktopCloudState(input);
  }

  private async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, ms);
      signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new Error("aborted"));
      });
    });
  }

  private isCurrentPollingSignal(signal: AbortSignal): boolean {
    // The polling loop may still be processing a response when a newer
    // connectDesktopCloud() call has already aborted it and installed a fresh
    // pollingState. Identifying the active poll by AbortSignal identity lets
    // any final-state write from a stale loop become a no-op instead of
    // clobbering the new flow's pollingState or persisted credentials.
    return this.pollingState?.abortController.signal === signal;
  }

  private async pollDesktopCloudAuthorization(
    cloudApiUrl: string,
    deviceId: string,
    deviceSecret: string,
    signal: AbortSignal,
  ): Promise<void> {
    const maxAttempts = 100;

    for (let i = 0; i < maxAttempts; i++) {
      try {
        await this.sleep(3000, signal);
      } catch {
        return;
      }

      if (signal.aborted) {
        return;
      }

      try {
        const res = await proxyFetch(`${cloudApiUrl}/api/auth/device-poll`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ deviceId, deviceSecret }),
          signal,
        });

        if (!res.ok) {
          continue;
        }

        const data = (await res.json()) as CloudPollResponse;

        if (data.status === "completed" && data.apiKey) {
          const currentConfig = await this.getConfig();
          const previousCloud = readDesktopCloud(currentConfig);
          const linkUrl = await this.resolveDesktopCloudLinkUrl(
            currentConfig,
            data.linkGatewayUrl,
          );
          const models =
            data.cloudModels && data.cloudModels.length > 0
              ? data.cloudModels
              : ((await this.fetchDesktopCloudModels(linkUrl, data.apiKey)) ??
                []);

          if (signal.aborted || !this.isCurrentPollingSignal(signal)) {
            return;
          }
          this.pollingState = null;
          await this.setDesktopCloudState({
            connected: true,
            polling: false,
            userId: data.userId ?? null,
            userName: data.userName ?? null,
            userEmail: data.userEmail ?? null,
            connectedAt: now(),
            linkUrl,
            apiKey: data.apiKey,
            models,
          });
          await this.onCloudStateChanged?.({
            hadCloudInventory: (previousCloud.models?.length ?? 0) > 0,
            hasCloudInventory: models.length > 0,
            connected: true,
          });
          return;
        }

        if (data.status === "expired") {
          if (signal.aborted || !this.isCurrentPollingSignal(signal)) {
            return;
          }
          this.pollingState = null;
          await this.setDesktopCloudState({
            connected: false,
            polling: false,
            userId: null,
            userName: null,
            userEmail: null,
            connectedAt: null,
            linkUrl: null,
            apiKey: null,
            models: [],
          });
          return;
        }
      } catch {
        if (signal.aborted) {
          return;
        }
      }
    }

    if (signal.aborted || !this.isCurrentPollingSignal(signal)) {
      return;
    }
    this.pollingState = null;
    await this.setDesktopCloudState({
      connected: false,
      polling: false,
      userId: null,
      userName: null,
      userEmail: null,
      connectedAt: null,
      linkUrl: null,
      apiKey: null,
      models: [],
    });
  }

  async listBots(): Promise<BotResponse[]> {
    const config = await this.getConfig();
    return config.bots;
  }

  async getBot(botId: string): Promise<BotResponse | null> {
    const config = await this.getConfig();
    return config.bots.find((bot) => bot.id === botId) ?? null;
  }

  async createBot(input: {
    name: string;
    slug: string;
    systemPrompt?: string;
    /** Null or absent means the bot follows the global default model. */
    modelId?: string | null;
    poolId?: string;
    expertSlug?: string | null;
    origin?: BotOrigin;
  }): Promise<BotResponse> {
    // Dedup: if expertSlug is set and an active bot with the same expertSlug
    // already exists, return the existing bot instead of creating a duplicate.
    if (input.expertSlug) {
      const config = await this.getConfig();
      const existing = config.bots.find(
        (b) => b.expertSlug === input.expertSlug && b.status === "active",
      );
      if (existing) {
        logger.info(
          {
            expertSlug: input.expertSlug,
            existingBotId: existing.id,
            requestedName: input.name,
          },
          "bot_creation_skipped_expert_already_exists",
        );
        return existing;
      }
    }

    const createdAt = now();
    const bot: BotResponse = {
      id: crypto.randomUUID(),
      name: input.name,
      slug: input.slug,
      poolId: input.poolId ?? null,
      // Host execution for channel- and automation-driven runs is opt-in per
      // bot; a newly created bot never starts with it open.
      hostExecution: { channels: "restricted", automations: "restricted" },
      status: "active",
      // Null, not a snapshot of the current default: a new bot should follow
      // the global default as it changes, not be frozen to whatever it
      // happened to be at creation time.
      modelId: input.modelId ?? null,
      systemPrompt: input.systemPrompt ?? null,
      expertSlug: input.expertSlug ?? null,
      origin: input.origin ?? "user",
      createdAt,
      updatedAt: createdAt,
    };

    await this.store.update((config) => ({
      ...config,
      bots: [...config.bots, bot],
    }));

    logger.info(
      {
        botId: bot.id,
        slug: bot.slug,
        workspacePath: path.join(this.env.openclawStateDir, "agents", bot.id),
        createdVia: "nexu_config_store.createBot",
      },
      "bot_created",
    );

    return bot;
  }

  async updateBot(
    botId: string,
    input: {
      name?: string;
      systemPrompt?: string;
      modelId?: string | null;
      hostExecution?: Partial<BotResponse["hostExecution"]>;
    },
  ): Promise<BotResponse | null> {
    let updatedBot: BotResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      bots: config.bots.map((bot) => {
        if (bot.id !== botId) {
          return bot;
        }

        updatedBot = {
          ...bot,
          name: input.name ?? bot.name,
          systemPrompt: input.systemPrompt ?? bot.systemPrompt,
          // `undefined` leaves the binding alone; `null` clears it back to
          // following the global default. `??` alone cannot tell them apart.
          modelId: input.modelId === undefined ? bot.modelId : input.modelId,
          hostExecution: {
            channels:
              input.hostExecution?.channels ?? bot.hostExecution.channels,
            automations:
              input.hostExecution?.automations ?? bot.hostExecution.automations,
          },
          updatedAt: now(),
        };
        return updatedBot;
      }),
    }));

    return updatedBot;
  }

  async setBotStatus(
    botId: string,
    status: BotResponse["status"],
  ): Promise<BotResponse | null> {
    let updatedBot: BotResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      bots: config.bots.map((bot) => {
        if (bot.id !== botId) {
          return bot;
        }

        updatedBot = {
          ...bot,
          status,
          updatedAt: now(),
        };
        return updatedBot;
      }),
    }));

    return updatedBot;
  }

  async setDesktopDefaultBot(botId: string): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      desktop: {
        ...config.desktop,
        defaultBotId: botId,
      },
    }));
  }

  async deleteBot(botId: string): Promise<boolean> {
    let deleted = false;

    await this.store.update((config) => {
      const bots = config.bots.filter((bot) => {
        if (bot.id === botId) {
          deleted = true;
          return false;
        }

        return true;
      });

      return {
        ...config,
        bots,
        channels: config.channels.filter((channel) => channel.botId !== botId),
        schedules: (config.schedules ?? []).filter((s) => s.botId !== botId),
      };
    });

    return deleted;
  }

  async listSchedules(): Promise<ScheduleResponse[]> {
    const config = await this.getConfig();
    return config.schedules ?? [];
  }

  async getSchedule(id: string): Promise<ScheduleResponse | null> {
    const config = await this.getConfig();
    return config.schedules?.find((s) => s.id === id) ?? null;
  }

  async createSchedule(input: CreateScheduleInput): Promise<ScheduleResponse> {
    const createdAt = now();
    const schedule: ScheduleResponse = {
      id: crypto.randomUUID(),
      botId: input.botId,
      name: input.name,
      cron: input.cron,
      timezone: input.timezone ?? "UTC",
      prompt: input.prompt,
      enabled: input.enabled ?? true,
      source: input.source ?? "ui",
      sessionKey: input.sessionKey,
      channelType: input.channelType,
      channelId: input.channelId,
      description: input.description,
      modelId: input.modelId || undefined,
      onlyNotifyOnChange: input.onlyNotifyOnChange ?? false,
      failureAlertEnabled: input.failureAlertEnabled ?? false,
      failureAlertAfter: input.failureAlertAfter ?? 3,
      createdAt,
      updatedAt: createdAt,
    };

    await this.store.update((config) => ({
      ...config,
      schedules: [...(config.schedules ?? []), schedule],
    }));

    return schedule;
  }

  async updateSchedule(
    id: string,
    input: UpdateScheduleInput,
  ): Promise<ScheduleResponse | null> {
    let updated: ScheduleResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      schedules: (config.schedules ?? []).map((s) => {
        if (s.id !== id) return s;
        updated = {
          ...s,
          name: input.name ?? s.name,
          cron: input.cron ?? s.cron,
          timezone: input.timezone ?? s.timezone,
          prompt: input.prompt ?? s.prompt,
          enabled: input.enabled ?? s.enabled,
          source: input.source ?? s.source,
          sessionKey:
            input.sessionKey !== undefined
              ? input.sessionKey || undefined
              : s.sessionKey,
          channelType:
            input.channelType !== undefined
              ? input.channelType || undefined
              : s.channelType,
          channelId:
            input.channelId !== undefined
              ? input.channelId || undefined
              : s.channelId,
          description:
            input.description !== undefined
              ? input.description || undefined
              : s.description,
          // Empty string clears the per-job model override back to bot default.
          modelId:
            input.modelId !== undefined
              ? input.modelId || undefined
              : s.modelId,
          onlyNotifyOnChange: input.onlyNotifyOnChange ?? s.onlyNotifyOnChange,
          failureAlertEnabled:
            input.failureAlertEnabled ?? s.failureAlertEnabled,
          failureAlertAfter: input.failureAlertAfter ?? s.failureAlertAfter,
          ...(input.onlyNotifyOnChange !== undefined &&
          input.onlyNotifyOnChange !== s.onlyNotifyOnChange
            ? {
                lastOutputFingerprint: undefined,
                lastOutputObservedAt: undefined,
                lastOutputNotificationStatus: undefined,
                lastOutputNotificationError: undefined,
              }
            : {}),
          updatedAt: now(),
        };
        return updated;
      }),
    }));

    return updated;
  }

  /**
   * Record that a scheduled run was refused host command execution.
   *
   * Kept separate from the output-notification fields: those describe whether
   * an output was delivered, this describes work that could not happen at all.
   */
  async recordScheduleHostExecutionBlock(
    id: string,
    input: { at: string; toolName: string; reason: string },
  ): Promise<ScheduleResponse | null> {
    let updated: ScheduleResponse | null = null;
    await this.store.update((config) => ({
      ...config,
      schedules: (config.schedules ?? []).map((schedule) => {
        if (schedule.id !== id) return schedule;
        updated = { ...schedule, lastHostExecutionBlock: input };
        return updated;
      }),
    }));
    return updated;
  }

  async recordScheduleOutputNotification(
    id: string,
    input: {
      fingerprint: string;
      observedAt: string;
      status: NonNullable<ScheduleResponse["lastOutputNotificationStatus"]>;
      error?: string;
    },
  ): Promise<ScheduleResponse | null> {
    let updated: ScheduleResponse | null = null;
    await this.store.update((config) => ({
      ...config,
      schedules: (config.schedules ?? []).map((schedule) => {
        if (schedule.id !== id) return schedule;
        const currentObservedAtMs = schedule.lastOutputObservedAt
          ? Date.parse(schedule.lastOutputObservedAt)
          : Number.NaN;
        const nextObservedAtMs = Date.parse(input.observedAt);
        if (
          Number.isFinite(currentObservedAtMs) &&
          (!Number.isFinite(nextObservedAtMs) ||
            nextObservedAtMs < currentObservedAtMs)
        ) {
          updated = schedule;
          return schedule;
        }
        updated = {
          ...schedule,
          lastOutputFingerprint: input.fingerprint,
          lastOutputObservedAt: input.observedAt,
          lastOutputNotificationStatus: input.status,
          lastOutputNotificationError: input.error,
        };
        return updated;
      }),
    }));
    return updated;
  }

  async deleteSchedule(id: string): Promise<boolean> {
    let deleted = false;

    await this.store.update((config) => {
      const schedules = (config.schedules ?? []).filter((s) => {
        if (s.id === id) {
          deleted = true;
          return false;
        }
        return true;
      });

      return { ...config, schedules };
    });

    return deleted;
  }

  async setScheduleExternalId(id: string, externalId: string): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      schedules: (config.schedules ?? []).map((s) =>
        s.id === id ? { ...s, externalId } : s,
      ),
    }));
  }

  async listChannels(): Promise<ChannelResponse[]> {
    const config = await this.getConfig();
    return config.channels;
  }

  async getSecret(key: string): Promise<string | null> {
    const config = await this.getConfig();
    return config.secrets[key] ?? null;
  }

  async setSecret(key: string, value: string): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      secrets: {
        ...config.secrets,
        [key]: value,
      },
    }));
  }

  async deleteSecretsByPrefix(prefix: string): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      secrets: Object.fromEntries(
        Object.entries(config.secrets).filter(
          ([key]) => !key.startsWith(prefix),
        ),
      ),
    }));
  }

  async getChannel(channelId: string): Promise<ChannelResponse | null> {
    const config = await this.getConfig();
    return config.channels.find((channel) => channel.id === channelId) ?? null;
  }

  async assertBotNotBoundToSameChannelType(
    botId: string,
    channelType: string,
    excludeChannelId?: string,
  ): Promise<void> {
    const config = await this.getConfig();
    const conflict = config.channels.find(
      (ch) =>
        ch.botId === botId &&
        ch.channelType === channelType &&
        ch.id !== excludeChannelId,
    );
    if (conflict) {
      throw new Error(
        `Bot ${botId} is already bound to another ${channelType} channel (${conflict.id})`,
      );
    }
  }

  async updateChannel(
    channelId: string,
    patch: Partial<
      Pick<
        ChannelResponse,
        | "botId"
        | "feishuPermissions"
        | "slackCapabilities"
        | "feishuCapabilities"
      >
    >,
  ): Promise<ChannelResponse> {
    const existing = await this.getChannel(channelId);
    if (!existing) {
      throw new Error(`Channel not found: ${channelId}`);
    }

    if (patch.botId !== undefined) {
      const bot = await this.getBot(patch.botId);
      if (!bot) {
        throw new Error(`Bot not found: ${patch.botId}`);
      }
      await this.assertBotNotBoundToSameChannelType(
        patch.botId,
        existing.channelType,
        channelId,
      );
    }

    const updated: ChannelResponse = {
      ...existing,
      ...(patch.botId !== undefined ? { botId: patch.botId } : {}),
      ...(patch.feishuPermissions !== undefined
        ? { feishuPermissions: patch.feishuPermissions }
        : {}),
      ...(patch.slackCapabilities !== undefined
        ? { slackCapabilities: patch.slackCapabilities }
        : {}),
      ...(patch.feishuCapabilities !== undefined
        ? { feishuCapabilities: patch.feishuCapabilities }
        : {}),
      updatedAt: now(),
    };

    await this.store.update((config) => ({
      ...config,
      channels: config.channels.map((channel) =>
        channel.id === channelId ? updated : channel,
      ),
    }));

    return updated;
  }

  async updateChannelFeishuPermissions(
    channelId: string,
    perms: FeishuPermissions | null,
  ): Promise<ChannelResponse> {
    const existing = await this.getChannel(channelId);
    if (!existing) {
      throw new Error(`Channel not found: ${channelId}`);
    }
    if (existing.channelType !== "feishu") {
      throw new Error(`Not a Feishu channel: ${channelId}`);
    }
    return this.updateChannel(channelId, { feishuPermissions: perms });
  }

  async updateChannelCapabilities(
    channelId: string,
    input:
      | { channelType: "slack"; settings: SlackChannelCapabilities }
      | { channelType: "feishu"; settings: FeishuChannelCapabilities },
  ): Promise<ChannelResponse> {
    const existing = await this.getChannel(channelId);
    if (!existing) {
      throw new Error(`Channel not found: ${channelId}`);
    }
    if (existing.channelType !== input.channelType) {
      throw new Error(
        `Channel type mismatch: expected ${existing.channelType}, received ${input.channelType}`,
      );
    }
    if (input.channelType === "slack") {
      return this.updateChannel(channelId, {
        slackCapabilities: input.settings,
      });
    }
    return this.updateChannel(channelId, {
      feishuCapabilities: input.settings,
    });
  }

  async connectSlack(
    input: ConnectSlackInput & { botUserId?: string | null },
  ): Promise<ChannelResponse> {
    const bot = await this.getBot(input.botId);
    if (!bot) {
      throw new Error(`Bot not found: ${input.botId}`);
    }
    await this.assertBotNotBoundToSameChannelType(bot.id, "slack");
    const connectedAt = now();
    const teamId = input.teamId ?? crypto.randomUUID();
    const appId = input.appId ?? crypto.randomUUID();
    const accountId = `slack-${appId}-${teamId}`;
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "slack",
      accountId,
      status: "connected",
      teamName: input.teamName ?? null,
      appId,
      botUserId: input.botUserId ?? null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
      slackCapabilities: null,
    };

    await this.store.update((config) => {
      const replacedIds = config.channels
        .filter(
          (existing) =>
            existing.channelType === channel.channelType &&
            existing.accountId === channel.accountId,
        )
        .map((ch) => ch.id);
      return {
        ...config,
        channels: [
          ...config.channels.filter(
            (existing) =>
              !(
                existing.channelType === channel.channelType &&
                existing.accountId === channel.accountId
              ),
          ),
          channel,
        ],
        secrets: {
          ...removeOrphanedSecrets(config.secrets, replacedIds),
          [`channel:${channel.id}:botToken`]: input.botToken,
          [`channel:${channel.id}:signingSecret`]: input.signingSecret,
        },
      };
    });

    return channel;
  }

  async connectDiscord(
    input: ConnectDiscordInput & { botUserId?: string | null },
  ): Promise<ChannelResponse> {
    const bot = await this.getBot(input.botId);
    if (!bot) {
      throw new Error(`Bot not found: ${input.botId}`);
    }
    await this.assertBotNotBoundToSameChannelType(bot.id, "discord");
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "discord",
      accountId: `discord-${input.appId}`,
      status: "connected",
      teamName: input.guildName ?? null,
      appId: input.appId,
      botUserId: input.botUserId ?? null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => {
      const replacedIds = config.channels
        .filter(
          (existing) =>
            existing.channelType === channel.channelType &&
            existing.accountId === channel.accountId,
        )
        .map((ch) => ch.id);
      return {
        ...config,
        channels: [
          ...config.channels.filter(
            (existing) =>
              !(
                existing.channelType === channel.channelType &&
                existing.accountId === channel.accountId
              ),
          ),
          channel,
        ],
        secrets: {
          ...removeOrphanedSecrets(config.secrets, replacedIds),
          [`channel:${channel.id}:botToken`]: input.botToken,
        },
      };
    });

    return channel;
  }

  async connectWechat(input: {
    accountId: string;
    botId: string;
  }): Promise<ChannelResponse> {
    const bot = await this.getBot(input.botId);
    if (!bot) {
      throw new Error(`Bot not found: ${input.botId}`);
    }
    await this.assertBotNotBoundToSameChannelType(bot.id, "wechat");
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "wechat",
      accountId: input.accountId,
      status: "connected",
      teamName: null,
      appId: null,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => {
      const replacedIds = config.channels
        .filter(
          (existing) =>
            existing.channelType === channel.channelType &&
            existing.accountId === channel.accountId,
        )
        .map((ch) => ch.id);
      return {
        ...config,
        channels: [
          ...config.channels.filter(
            (existing) =>
              !(
                existing.channelType === channel.channelType &&
                existing.accountId === channel.accountId
              ),
          ),
          channel,
        ],
        secrets: removeOrphanedSecrets(config.secrets, replacedIds),
      };
    });

    return channel;
  }

  async connectTelegram(input: {
    botToken: string;
    telegramBotId: string;
    botUsername: string | null;
    displayName: string | null;
    botId: string;
  }): Promise<ChannelResponse> {
    const bot = await this.getBot(input.botId);
    if (!bot) {
      throw new Error(`Bot not found: ${input.botId}`);
    }
    await this.assertBotNotBoundToSameChannelType(bot.id, "telegram");
    const connectedAt = now();
    const accountId = `telegram-${input.telegramBotId}`;
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "telegram",
      accountId,
      status: "connected",
      teamName: input.displayName,
      appId: input.telegramBotId,
      botUserId: input.botUsername,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => {
      const replacedIds = config.channels
        .filter(
          (existing) =>
            existing.channelType === channel.channelType &&
            existing.accountId === channel.accountId,
        )
        .map((ch) => ch.id);
      return {
        ...config,
        channels: [
          ...config.channels.filter(
            (existing) =>
              !(
                existing.channelType === channel.channelType &&
                existing.accountId === channel.accountId
              ),
          ),
          channel,
        ],
        secrets: {
          ...removeOrphanedSecrets(config.secrets, replacedIds),
          [`channel:${channel.id}:botToken`]: input.botToken,
        },
      };
    });

    return channel;
  }

  async connectWhatsapp(input: {
    accountId: string;
    authDir?: string | null;
    botId: string;
  }): Promise<ChannelResponse> {
    const bot = await this.getBot(input.botId);
    if (!bot) {
      throw new Error(`Bot not found: ${input.botId}`);
    }
    await this.assertBotNotBoundToSameChannelType(bot.id, "whatsapp");
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "whatsapp",
      accountId: input.accountId,
      status: "connected",
      teamName: null,
      appId: null,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => {
      const replacedIds = config.channels
        .filter(
          (existing) =>
            existing.channelType === channel.channelType &&
            existing.accountId === channel.accountId,
        )
        .map((ch) => ch.id);
      const secrets: Record<string, string> = {
        ...removeOrphanedSecrets(config.secrets, replacedIds),
      };
      if (input.authDir) {
        secrets[`channel:${channel.id}:authDir`] = input.authDir;
      }
      return {
        ...config,
        channels: [
          ...config.channels.filter(
            (existing) =>
              !(
                existing.channelType === channel.channelType &&
                existing.accountId === channel.accountId
              ),
          ),
          channel,
        ],
        secrets,
      };
    });

    return channel;
  }

  async connectFeishu(input: ConnectFeishuInput): Promise<ChannelResponse> {
    const bot = await this.getBot(input.botId);
    if (!bot) {
      throw new Error(`Bot not found: ${input.botId}`);
    }
    await this.assertBotNotBoundToSameChannelType(bot.id, "feishu");
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "feishu",
      accountId: input.appId,
      status: "connected",
      teamName: null,
      appId: input.appId,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
      feishuPermissions: null,
      feishuCapabilities: null,
    };

    await this.store.update((config) => {
      const replacedIds = config.channels
        .filter(
          (existing) =>
            existing.channelType === channel.channelType &&
            existing.accountId === channel.accountId,
        )
        .map((ch) => ch.id);

      return {
        ...config,
        channels: [
          ...config.channels.filter(
            (existing) =>
              !(
                existing.channelType === channel.channelType &&
                existing.accountId === channel.accountId
              ),
          ),
          channel,
        ],
        secrets: {
          ...removeOrphanedSecrets(config.secrets, replacedIds),
          [`channel:${channel.id}:appSecret`]: input.appSecret,
          [`channel:${channel.id}:appId`]: input.appId,
          [`channel:${channel.id}:connectionMode`]:
            input.connectionMode ?? "websocket",
          ...(input.verificationToken
            ? {
                [`channel:${channel.id}:verificationToken`]:
                  input.verificationToken,
              }
            : {}),
        },
      };
    });

    return channel;
  }

  async connectQqbot(input: ConnectQqbotInput): Promise<ChannelResponse> {
    const bot = await this.getBot(input.botId);
    if (!bot) {
      throw new Error(`Bot not found: ${input.botId}`);
    }
    await this.assertBotNotBoundToSameChannelType(bot.id, "qqbot");
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "qqbot",
      accountId: DEFAULT_MANAGED_CHANNEL_ACCOUNT_ID,
      status: "connected",
      teamName: null,
      appId: input.appId,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => {
      const replacedIds = config.channels
        .filter((existing) => existing.channelType === channel.channelType)
        .map((ch) => ch.id);
      return {
        ...config,
        channels: [
          ...config.channels.filter(
            (existing) => existing.channelType !== channel.channelType,
          ),
          channel,
        ],
        secrets: {
          ...removeOrphanedSecrets(config.secrets, replacedIds),
          [`channel:${channel.id}:appId`]: input.appId,
          [`channel:${channel.id}:clientSecret`]: input.appSecret,
        },
      };
    });

    return channel;
  }

  async connectDingtalk(input: ConnectDingtalkInput): Promise<ChannelResponse> {
    const bot = await this.getBot(input.botId);
    if (!bot) {
      throw new Error(`Bot not found: ${input.botId}`);
    }
    await this.assertBotNotBoundToSameChannelType(bot.id, "dingtalk");
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "dingtalk",
      accountId: DEFAULT_MANAGED_CHANNEL_ACCOUNT_ID,
      status: "connected",
      teamName: null,
      appId: input.clientId,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => {
      const replacedIds = config.channels
        .filter((existing) => existing.channelType === channel.channelType)
        .map((ch) => ch.id);
      return {
        ...config,
        channels: [
          ...config.channels.filter(
            (existing) => existing.channelType !== channel.channelType,
          ),
          channel,
        ],
        secrets: {
          ...removeOrphanedSecrets(config.secrets, replacedIds),
          [`channel:${channel.id}:clientId`]: input.clientId,
          [`channel:${channel.id}:clientSecret`]: input.clientSecret,
        },
      };
    });

    return channel;
  }

  async connectWecom(input: ConnectWecomInput): Promise<ChannelResponse> {
    const bot = await this.getBot(input.nexuBotId);
    if (!bot) {
      throw new Error(`Bot not found: ${input.nexuBotId}`);
    }
    await this.assertBotNotBoundToSameChannelType(bot.id, "wecom");
    const connectedAt = now();
    const channel: ChannelResponse = {
      id: crypto.randomUUID(),
      botId: bot.id,
      channelType: "wecom",
      accountId: DEFAULT_MANAGED_CHANNEL_ACCOUNT_ID,
      status: "connected",
      teamName: null,
      appId: input.botId,
      botUserId: null,
      createdAt: connectedAt,
      updatedAt: connectedAt,
    };

    await this.store.update((config) => {
      const replacedIds = config.channels
        .filter((existing) => existing.channelType === channel.channelType)
        .map((ch) => ch.id);
      return {
        ...config,
        channels: [
          ...config.channels.filter(
            (existing) => existing.channelType !== channel.channelType,
          ),
          channel,
        ],
        secrets: {
          ...removeOrphanedSecrets(config.secrets, replacedIds),
          [`channel:${channel.id}:botId`]: input.botId,
          [`channel:${channel.id}:secret`]: input.secret,
        },
      };
    });

    return channel;
  }

  async disconnectChannel(channelId: string): Promise<boolean> {
    let disconnectedChannel: ChannelResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      channels: config.channels.flatMap((channel) => {
        if (channel.id === channelId) {
          disconnectedChannel = channel;
          return [];
        }

        return [channel];
      }),
      secrets:
        disconnectedChannel === null
          ? config.secrets
          : Object.fromEntries(
              Object.entries(config.secrets).filter(
                ([key]) => !key.startsWith(`channel:${channelId}:`),
              ),
            ),
    }));

    return disconnectedChannel !== null;
  }

  async getProvider(
    providerId: string,
  ): Promise<StoredProviderResponse | null> {
    const config = await this.getConfig();
    const provider =
      listCanonicalProviders(config).find(
        (item) => item.providerId === providerId,
      ) ?? null;
    return provider;
  }

  async upsertProvider(
    providerId: string,
    input: UpsertProviderBody,
  ): Promise<{ provider: StoredProviderResponse; created: boolean }> {
    const currentTime = now();
    let result: ModelProviderConfig | null = null;
    let created = false;

    await this.store.update((config) => {
      const existing = config.models.providers[providerId] as
        | ModelProviderConfig
        | undefined;
      const nextProvider = buildProviderConfig(
        providerId,
        input,
        currentTime,
        existing,
      );

      created = existing === undefined;
      result = nextProvider;

      return {
        ...config,
        schemaVersion: Math.max(
          config.schemaVersion,
          CANONICAL_MODELS_PROVIDERS_CUTOVER_SCHEMA_VERSION,
        ),
        models: {
          ...config.models,
          providers: {
            ...config.models.providers,
            [providerId]: nextProvider,
          },
        },
      };
    });

    if (result === null) {
      throw new Error(`Failed to upsert provider ${providerId}`);
    }

    return {
      provider: serializeProvider(providerId, result),
      created,
    };
  }

  async listProviders(): Promise<StoredProviderResponse[]> {
    return listCanonicalProviders(await this.getConfig());
  }

  async setProviderOauthCredentials(
    providerId: string,
    input: {
      models: string[];
      oauthRegion: "global" | "cn";
      enabled?: boolean;
      displayName?: string;
      baseUrl?: string;
      oauthCredential: {
        provider: string;
        access: string;
        refresh?: string;
        expires?: number;
        email?: string;
      };
    },
  ): Promise<StoredProviderResponse> {
    const currentTime = now();
    let result: ModelProviderConfig | null = null;

    await this.store.update((config) => {
      const existing = config.models.providers[providerId] as
        | ModelProviderConfig
        | undefined;
      const existingMetadata = getProviderMetadata(existing) ?? {};
      const nextProvider: ModelProviderConfig = {
        ...(existing?.providerTemplateId
          ? {
              providerTemplateId: existing.providerTemplateId,
              instanceId: existing.instanceId,
            }
          : {}),
        enabled: input.enabled ?? existing?.enabled ?? true,
        displayName: input.displayName ?? existing?.displayName ?? providerId,
        baseUrl: buildProviderBaseUrl(
          providerId,
          input.baseUrl === undefined ? existing?.baseUrl : input.baseUrl,
          input.oauthRegion,
        ),
        auth: "oauth",
        ...(existing?.api ? { api: existing.api } : {}),
        oauthRegion: input.oauthRegion,
        oauthProfileRef: input.oauthCredential.provider,
        models: input.models.map((modelId) => ({
          id: modelId,
          name: modelId,
          reasoning: false,
          input: ["text"] as Array<"text" | "image">,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 0,
          maxTokens: 0,
          ...(existing?.api ? { api: existing.api } : {}),
        })),
        metadata: {
          ...existingMetadata,
          legacyId:
            (typeof existingMetadata.legacyId === "string" &&
              existingMetadata.legacyId) ||
            crypto.randomUUID(),
          legacyCreatedAt:
            (typeof existingMetadata.legacyCreatedAt === "string" &&
              existingMetadata.legacyCreatedAt) ||
            currentTime,
          legacyUpdatedAt: currentTime,
          legacyOauthCredential: input.oauthCredential,
        },
      };

      result = nextProvider;

      return {
        ...config,
        schemaVersion: Math.max(
          config.schemaVersion,
          CANONICAL_MODELS_PROVIDERS_CUTOVER_SCHEMA_VERSION,
        ),
        models: {
          ...config.models,
          providers: {
            ...config.models.providers,
            [providerId]: nextProvider,
          },
        },
      };
    });

    if (result === null) {
      throw new Error(`Failed to set oauth provider ${providerId}`);
    }

    return serializeProvider(providerId, result);
  }

  async deleteProvider(providerId: string): Promise<boolean> {
    let deleted = false;

    await this.store.update((config) => {
      for (const provider of listCanonicalProviders(config)) {
        if (provider.providerId === providerId) {
          deleted = true;
        }
      }

      const nextCanonicalProviders = {
        ...config.models.providers,
      };
      delete nextCanonicalProviders[providerId];

      return {
        ...config,
        schemaVersion: Math.max(
          config.schemaVersion,
          CANONICAL_MODELS_PROVIDERS_CUTOVER_SCHEMA_VERSION,
        ),
        models: {
          ...config.models,
          providers: nextCanonicalProviders,
        },
      };
    });

    return deleted;
  }

  async listIntegrations(): Promise<IntegrationResponse[]> {
    const config = await this.getConfig();
    return config.integrations;
  }

  async getLocalProfile(): Promise<UserProfileResponse> {
    const config = await this.getConfig();
    return readLocalProfile(config);
  }

  async updateLocalProfile(
    input: UpdateUserProfileInput,
  ): Promise<UserProfileResponse> {
    let nextProfile = defaultLocalProfile();

    await this.store.update((config) => {
      const currentProfile = readLocalProfile(config);
      nextProfile = {
        ...currentProfile,
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.image !== undefined ? { image: input.image } : {}),
      };

      return {
        ...config,
        desktop: {
          ...config.desktop,
          localProfile: nextProfile,
        },
      };
    });

    return nextProfile;
  }

  async updateLocalAuthSource(
    input: UpdateAuthSourceInput,
  ): Promise<UserProfileResponse> {
    let nextProfile = defaultLocalProfile();

    await this.store.update((config) => {
      const currentProfile = readLocalProfile(config);
      nextProfile = {
        ...currentProfile,
        authSource: input.source,
      };

      return {
        ...config,
        desktop: {
          ...config.desktop,
          localProfile: nextProfile,
        },
      };
    });

    return nextProfile;
  }

  /**
   * VLM gateway credential pushed to phones (tabby-control → connected handshake)
   * so the phone runs its vision model on the signed-in user's cloud account,
   * billed to their balance. Returns null when no user is signed in — the phone
   * then falls back to its own local VLM settings.
   *
   * apiUrl = `${linkUrl}/v1/` (new-api gateway, OpenAI-compatible); the phone
   * appends `/chat/completions`. The gateway routes the phone model name to
   * StepFun's step_plan upstream internally, so no step_plan path is needed here.
   *
   * Model name is the gateway's published name for the phone VLM. Resolution
   * order: settings-page choice (`deviceControl.phoneVlmModel`, the
   * "手机控制模型" selector) → NEXU_PHONE_VLM_MODEL env (ops escape hatch for
   * gateway renames) → gateway default `tabby-phone` (was `step-3.7-flash`).
   *
   * A namespaced selection (`<providerId>/<modelId>`, the id shape BYOK models
   * carry in the models list) resolves against the desktop-configured provider
   * channel instead: phones then talk to that provider's baseUrl directly with
   * the channel's own API key (billed to the user's provider account, no cloud
   * login required). Only plain-string api-key channels serving
   * openai-completions are eligible — anything else logs a warning and falls
   * back to the gateway default so phones keep working.
   *
   * reasoningEffort is StepFun's `reasoning_effort` tier (low/medium/high on
   * step-3.7-flash) forwarded to the phone alongside the credential, so the
   * desktop can tune per-step latency without an app rebuild. Defaults to
   * "low" for the step family (per-step reasoning generation is the dominant
   * cost in the agent loop) and to the sentinel "none" (phone omits the
   * parameter) for any other model — non-StepFun endpoints may reject the
   * unknown parameter. Override via NEXU_PHONE_VLM_REASONING_EFFORT.
   *
   * temperature/topP/frequencyPenalty/maxTokens are optional sampling
   * overrides (NEXU_PHONE_VLM_TEMPERATURE / _TOP_P / _FREQUENCY_PENALTY /
   * _MAX_TOKENS). Absent fields keep the phone's step-tuned defaults, so a
   * model swap can be re-tuned without an app rebuild.
   *
   * contextWindow (tokens) drives the phone's adaptive history-compression
   * policy (large windows → less/no compression). Source: for BYOK models,
   * the provider model entry's `contextWindow` (settings page channel
   * config); NEXU_PHONE_VLM_CONTEXT_WINDOW env overrides for both paths.
   */
  async getVlmGatewayCredential(): Promise<{
    apiUrl: string;
    apiKey: string;
    model: string;
    reasoningEffort: string;
    temperature?: number;
    topP?: number;
    frequencyPenalty?: number;
    maxTokens?: number;
    contextWindow?: number;
  } | null> {
    const config = await this.getConfig();
    const envNumber = (name: string): number | undefined => {
      const raw = process.env[name];
      if (raw === undefined || raw.trim() === "") return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    };
    const samplingOverrides = {
      temperature: envNumber("NEXU_PHONE_VLM_TEMPERATURE"),
      topP: envNumber("NEXU_PHONE_VLM_TOP_P"),
      frequencyPenalty: envNumber("NEXU_PHONE_VLM_FREQUENCY_PENALTY"),
      maxTokens: envNumber("NEXU_PHONE_VLM_MAX_TOKENS"),
    };

    let selected =
      config.deviceControl.phoneVlmModel ??
      process.env.NEXU_PHONE_VLM_MODEL ??
      null;

    // BYOK channel: "<providerId>/<modelId>" — phone talks to the provider
    // directly with the channel's own key. Checked before the cloud gate so a
    // BYOK phone model works without a cloud login.
    if (selected?.includes("/")) {
      const slash = selected.indexOf("/");
      const providerId = selected.slice(0, slash);
      const modelId = selected.slice(slash + 1);
      const provider = config.models.providers[providerId];
      const entry = provider?.models.find((m) => m.id === modelId);
      // Provider base URLs are user-entered — trim stray whitespace (a
      // leading tab has been seen in the wild) and trailing slashes; the
      // phone appends /chat/completions itself.
      const baseUrl = provider?.baseUrl?.trim().replace(/\/+$/, "");
      const apiKey =
        typeof provider?.apiKey === "string" ? provider.apiKey.trim() : null;
      const api = entry?.api ?? provider?.api;
      const usable =
        provider !== undefined &&
        provider.enabled !== false &&
        entry !== undefined &&
        !!baseUrl &&
        !!apiKey &&
        (api === undefined || api === "openai-completions");
      if (usable) {
        const entryContextWindow =
          typeof entry?.contextWindow === "number" && entry.contextWindow > 0
            ? entry.contextWindow
            : undefined;
        return {
          apiUrl: baseUrl,
          apiKey,
          model: modelId,
          reasoningEffort:
            process.env.NEXU_PHONE_VLM_REASONING_EFFORT ?? "none",
          ...samplingOverrides,
          contextWindow:
            envNumber("NEXU_PHONE_VLM_CONTEXT_WINDOW") ?? entryContextWindow,
        };
      }
      console.warn(
        `[nexu-config] phone VLM model "${selected}" is not usable (provider disabled/missing, model not listed, secret-ref key, or non-openai api) — falling back to the gateway default`,
      );
      selected = null;
    }

    const cloud = readDesktopCloud(config);
    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    const linkUrl = activeProfile.linkUrl ?? cloud.linkUrl;
    if (!cloud.connected || !linkUrl || !cloud.apiKey) return null;
    const base = String(linkUrl).replace(/\/+$/, "");
    const DEFAULT_PHONE_VLM_MODEL = "tabby-phone";
    // step-3.7-flash (the upstream behind the tabby-phone alias) has a 256K
    // context window — known fact, so the phone's adaptive compression can
    // use the relaxed tier without per-model gateway metadata.
    const STEP_PHONE_CONTEXT_WINDOW = 262144;
    const model = selected ?? DEFAULT_PHONE_VLM_MODEL;
    // tabby-phone is the gateway alias for the step upstream; step-* covers a
    // direct model name. Everything else gets "none" → phone omits the param.
    const isStepFamily =
      model === DEFAULT_PHONE_VLM_MODEL || model.startsWith("step-");
    return {
      apiUrl: `${base}/v1/`,
      apiKey: cloud.apiKey,
      model,
      reasoningEffort:
        process.env.NEXU_PHONE_VLM_REASONING_EFFORT ??
        (isStepFamily ? "low" : "none"),
      ...samplingOverrides,
      contextWindow:
        envNumber("NEXU_PHONE_VLM_CONTEXT_WINDOW") ??
        (isStepFamily ? STEP_PHONE_CONTEXT_WINDOW : undefined),
    };
  }

  async getDesktopCloudStatus() {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);
    const cloudSessions = readDesktopCloudSessions(config);
    const { profiles, activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    return {
      connected: cloud.connected,
      polling: cloud.polling,
      userId: cloud.userId ?? null,
      userName: cloud.userName ?? null,
      userEmail: cloud.userEmail ?? null,
      connectedAt: cloud.connectedAt ?? null,
      models: cloud.models ?? [],
      cloudUrl: activeProfile.cloudUrl,
      linkUrl: activeProfile.linkUrl,
      activeProfileName: activeProfile.name,
      profiles: profiles.map((profile) => {
        const session =
          cloudSessions[profile.name] ??
          (profile.name === activeProfile.name ? cloud : undefined);

        return {
          ...profile,
          connected: session?.connected === true,
          polling: session?.polling === true,
          userId: session?.userId ?? null,
          userName: session?.userName ?? null,
          userEmail: session?.userEmail ?? null,
          connectedAt: session?.connectedAt ?? null,
          modelCount: session?.models?.length ?? 0,
        };
      }),
    };
  }

  private async resolveDesktopBalanceBreakdown(
    service: CloudRewardService,
    cloudStatus: RewardStatusResponse,
  ): Promise<DesktopBalanceBreakdown | undefined> {
    if (!cloudStatus.cloudBalance) {
      return undefined;
    }

    if (cloudStatus.cloudBalance.totalBalance === 0) {
      return {
        giftedBalance: 0,
        planBalance: 0,
      };
    }

    const creditRecordsResult = await service.getCreditRecords();
    if (!creditRecordsResult.ok) {
      logger.warn(
        { reason: creditRecordsResult.reason },
        "desktop_rewards_credit_records_fallback",
      );
      return {
        giftedBalance: 0,
        planBalance: cloudStatus.cloudBalance.totalBalance,
      };
    }

    const breakdown = deriveDesktopBalanceBreakdown({
      totalBalance: cloudStatus.cloudBalance.totalBalance,
      grants: creditRecordsResult.data.grants,
    });

    if (breakdown.giftedBalanceRaw > cloudStatus.cloudBalance.totalBalance) {
      logger.warn(
        {
          giftedBalanceRaw: breakdown.giftedBalanceRaw,
          totalBalance: cloudStatus.cloudBalance.totalBalance,
        },
        "desktop_rewards_balance_breakdown_clamped",
      );
    }

    return {
      giftedBalance: breakdown.giftedBalance,
      planBalance: breakdown.planBalance,
    };
  }

  private async convertCloudStatusToDesktopStatus(
    service: CloudRewardService,
    cloudStatus: RewardStatusResponse,
    viewer: {
      cloudConnected: boolean;
      activeModelId: string | null;
      activeManagedModel: { provider?: string } | null | undefined;
    },
  ): Promise<DesktopRewardsStatus> {
    const balanceBreakdown = await this.resolveDesktopBalanceBreakdown(
      service,
      cloudStatus,
    );

    return convertCloudStatusToDesktop(cloudStatus, viewer, balanceBreakdown);
  }

  async getDesktopRewardsStatus(): Promise<DesktopRewardsStatus> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);
    const activeModelId = config.runtime.defaultModelId || null;
    const activeManagedModel = resolveManagedCloudModel(
      activeModelId,
      cloud.models ?? [],
    );

    if (cloud.connected && cloud.apiKey) {
      const { activeProfile } =
        await this.readConfiguredDesktopCloudProfile(config);
      const cloudUrl = activeProfile.cloudUrl.replace(/\/+$/, "");
      const service = createCloudRewardService({
        cloudUrl,
        apiKey: cloud.apiKey,
      });
      const cloudResult = await service.getRewardsStatus();

      if (cloudResult.ok) {
        const cloudStatus = cloudResult.data;
        return this.convertCloudStatusToDesktopStatus(service, cloudStatus, {
          cloudConnected: true,
          activeModelId,
          activeManagedModel,
        });
      }

      if (cloudResult.reason === "auth_failed") {
        return {
          viewer: {
            cloudConnected: cloud.connected,
            activeModelId,
            activeModelProviderId:
              activeManagedModel?.provider ??
              (activeManagedModel
                ? "nexu"
                : (activeModelId?.split("/")[0] ?? null)),
            usingManagedModel: activeManagedModel !== null,
          },
          progress: { claimedCount: 0, totalCount: 0, earnedCredits: 0 },
          tasks: [],
          cloudBalance: null,
        };
      }

      logger.warn(
        { reason: cloudResult.reason },
        "desktop_rewards_status_cloud_fallback",
      );
    }

    return {
      viewer: {
        cloudConnected: cloud.connected,
        activeModelId,
        activeModelProviderId:
          activeManagedModel?.provider ??
          (activeManagedModel
            ? "nexu"
            : (activeModelId?.split("/")[0] ?? null)),
        usingManagedModel: activeManagedModel !== null,
      },
      progress: { claimedCount: 0, totalCount: 0, earnedCredits: 0 },
      tasks: [],
      cloudBalance: null,
    };
  }

  async claimDesktopReward(
    taskId: RewardTaskId,
    proof?: DesktopRewardClaimProof,
  ): Promise<DesktopRewardClaimResponse> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);

    if (!cloud.connected || !cloud.apiKey) {
      return {
        ok: false,
        alreadyClaimed: false,
        status: await this.getDesktopRewardsStatus(),
      };
    }

    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    const cloudUrl = activeProfile.cloudUrl.replace(/\/+$/, "");
    const service = createCloudRewardService({
      cloudUrl,
      apiKey: cloud.apiKey,
    });
    const result = await service.claimReward(taskId, proof);

    if (!result.ok) {
      return {
        ok: false,
        alreadyClaimed: false,
        status: await this.getDesktopRewardsStatus(),
      };
    }

    const claimData = result.data;
    const config2 = await this.getConfig();
    const cloud2 = readDesktopCloud(config2);
    const activeModelId2 = config2.runtime.defaultModelId || null;
    const activeManagedModel2 = resolveManagedCloudModel(
      activeModelId2,
      cloud2.models ?? [],
    );

    return {
      ok: claimData.ok,
      alreadyClaimed: claimData.alreadyClaimed,
      status: await this.convertCloudStatusToDesktopStatus(
        service,
        claimData.status,
        {
          cloudConnected: true,
          activeModelId: activeModelId2,
          activeManagedModel: activeManagedModel2,
        },
      ),
    };
  }

  async setDesktopRewardBalance(
    balance: number,
  ): Promise<DesktopRewardsStatus> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);

    if (!cloud.connected || !cloud.apiKey) {
      throw new Error("Desktop cloud is not connected");
    }

    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    const service = createCloudRewardService({
      cloudUrl: activeProfile.cloudUrl.replace(/\/+$/, ""),
      apiKey: cloud.apiKey,
    });
    const result = await service.setRewardBalance(balance);

    if (!result.ok) {
      throw new Error(
        result.message ??
          `Failed to set desktop reward balance: ${result.reason}`,
      );
    }

    return this.getDesktopRewardsStatus();
  }

  async getStoredDesktopLocale(): Promise<"en" | "zh-CN" | null> {
    const config = await this.getConfig();
    return readDesktopLocale(config);
  }

  async getDesktopLocale(): Promise<"en" | "zh-CN"> {
    return (await this.getStoredDesktopLocale()) ?? "en";
  }

  async setDesktopLocale(locale: "en" | "zh-CN"): Promise<"en" | "zh-CN"> {
    await this.store.update((config) => ({
      ...config,
      desktop: {
        ...config.desktop,
        locale,
      },
    }));

    return locale;
  }

  async getStoredDesktopAnalyticsEnabled(): Promise<boolean | null> {
    const config = await this.getConfig();
    return typeof config.desktop.analyticsEnabled === "boolean"
      ? config.desktop.analyticsEnabled
      : null;
  }

  async getDesktopAnalyticsEnabled(): Promise<boolean> {
    const storedValue = await this.getStoredDesktopAnalyticsEnabled();
    if (storedValue !== null) {
      return storedValue;
    }

    return this.setDesktopAnalyticsEnabled(true);
  }

  async setDesktopAnalyticsEnabled(enabled: boolean): Promise<boolean> {
    await this.store.update((config) => ({
      ...config,
      desktop: {
        ...config.desktop,
        analyticsEnabled: enabled,
      },
    }));

    return enabled;
  }

  /**
   * Desktop "crash reports" consent mirror. Source of truth lives in the
   * desktop shell preferences; this copy lets the controller re-push the
   * consent to phones (via tabby-control) after cold starts and OpenClaw
   * restarts without waiting for the desktop. Defaults to true, matching the
   * desktop default.
   */
  async getDesktopCrashReportsEnabled(): Promise<boolean> {
    const config = await this.getConfig();
    return typeof config.desktop.crashReportsEnabled === "boolean"
      ? config.desktop.crashReportsEnabled
      : true;
  }

  async setDesktopCrashReportsEnabled(enabled: boolean): Promise<boolean> {
    await this.store.update((config) => ({
      ...config,
      desktop: {
        ...config.desktop,
        crashReportsEnabled: enabled,
      },
    }));

    return enabled;
  }

  async refreshDesktopCloudModels() {
    await this.hydrateDesktopCloudModels(true);
    return this.getDesktopCloudStatus();
  }

  async prepareDesktopCloudModelsForBootstrap(): Promise<void> {
    await this.hydrateDesktopCloudModels();
  }

  async getDesktopCloudInventoryStatus(): Promise<{
    connected: boolean;
    hasCloudInventory: boolean;
  }> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);
    return {
      connected: cloud.connected,
      hasCloudInventory: (cloud.models?.length ?? 0) > 0,
    };
  }

  async setDefaultModel(modelId: string): Promise<void> {
    // Bots are deliberately left alone. A bot with modelId === null follows
    // this value through the compiler, so the change reaches it without a
    // write; a bot with an explicit model chose that model, and overwriting it
    // here — as this once did for every bot — is what made per-bot binding
    // impossible to keep.
    await this.store.update((config) => ({
      ...config,
      runtime: {
        ...config.runtime,
        defaultModelId: modelId,
      },
    }));
  }

  async setUtilityModel(modelId: string | null): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      runtime: {
        ...config.runtime,
        utilityModelId: modelId,
      },
    }));
  }

  private async fetchDesktopCloudModels(
    linkUrl: string,
    apiKey: string,
  ): Promise<CloudModel[] | null> {
    try {
      const res = await proxyFetch(buildLinkModelsUrl(linkUrl), {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: 10000,
      });
      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as {
        data?: Array<{ id: string; owned_by?: string }>;
      };
      if (!Array.isArray(data.data)) {
        return null;
      }

      return data.data.map((model) => ({
        id: model.id,
        name: model.id,
        provider: model.owned_by,
      }));
    } catch {
      return null;
    }
  }

  private async fetchDesktopCloudUserId(
    cloudApiUrl: string,
    apiKey: string,
  ): Promise<string | null> {
    try {
      const res = await proxyFetch(buildCloudMeUrl(cloudApiUrl), {
        headers: { Authorization: `Bearer ${apiKey}` },
        timeoutMs: 10000,
      });
      if (!res.ok) {
        return null;
      }

      const data = (await res.json()) as { id?: unknown };
      return typeof data.id === "string" && data.id.length > 0 ? data.id : null;
    } catch {
      return null;
    }
  }

  /**
   * Fetch the account's current credit balance. Returns null on any failure
   * (auth, network, parse) so the caller can fail open toward the paid model
   * rather than force everyone to the free tier on a transient hiccup.
   */
  private async fetchDesktopCloudBalance(
    cloudApiUrl: string,
    apiKey: string,
  ): Promise<number | null> {
    const service = createCloudRewardService({
      cloudUrl: cloudApiUrl,
      apiKey,
    });
    const result = await service.getRewardsStatus();
    return result.ok ? (result.data.cloudBalance?.totalBalance ?? null) : null;
  }

  /**
   * Writes tabby-image/tabby-video's free-vs-paid routing signal to a small
   * sidecar file under OPENCLAW_STATE_DIR, mirroring nexu-credit-guard-state.json.
   * Read directly by the skill scripts (see skills/nexubot/tabby-image/scripts/lib.js)
   * rather than folded into openclaw.json's own provider schema, so it can't
   * collide with what OpenClaw itself validates there.
   */
  private async writeAccountCreditState(
    cloudApiUrl: string,
    apiKey: string,
  ): Promise<void> {
    try {
      const balance = await this.fetchDesktopCloudBalance(cloudApiUrl, apiKey);
      const hasBalance = balance === null ? true : balance > 0;
      await mkdir(path.dirname(this.env.accountCreditStatePath), {
        recursive: true,
      });
      await writeFile(
        this.env.accountCreditStatePath,
        `${JSON.stringify({ hasBalance, updatedAt: now() }, null, 2)}\n`,
        "utf8",
      );
    } catch (err) {
      logger.warn(
        { err: err instanceof Error ? err.message : String(err) },
        "writeAccountCreditState failed (non-critical)",
      );
    }
  }

  private async hydrateDesktopCloudModels(forceRefresh = false): Promise<void> {
    const config = await this.getConfig();
    const cloud = readDesktopCloud(config);
    const linkUrl = await this.resolveDesktopCloudLinkUrl(
      config,
      cloud.linkUrl,
    );
    const cloudApiUrl = await this.resolveDesktopCloudApiUrl(config);
    let userId = cloud.userId ?? null;

    if (cloud.connected && cloud.linkUrl !== linkUrl) {
      await this.setDesktopCloudState({
        connected: cloud.connected,
        polling: cloud.polling,
        userId,
        userName: cloud.userName ?? null,
        userEmail: cloud.userEmail ?? null,
        connectedAt: cloud.connectedAt ?? null,
        linkUrl,
        apiKey: cloud.apiKey ?? null,
        models: cloud.models ?? [],
      });
    }

    if (cloud.connected && cloud.apiKey && !userId) {
      const fetchedUserId = await this.fetchDesktopCloudUserId(
        cloudApiUrl,
        cloud.apiKey,
      );
      if (fetchedUserId) {
        userId = fetchedUserId;
        await this.setDesktopCloudState({
          connected: cloud.connected,
          polling: cloud.polling,
          userId,
          userName: cloud.userName ?? null,
          userEmail: cloud.userEmail ?? null,
          connectedAt: cloud.connectedAt ?? null,
          linkUrl,
          apiKey: cloud.apiKey,
          models: cloud.models ?? [],
        });
      }
    }

    if (cloud.connected && cloud.apiKey) {
      await this.writeAccountCreditState(cloudApiUrl, cloud.apiKey);
    }

    if (
      !cloud.connected ||
      !cloud.apiKey ||
      (!forceRefresh && (cloud.models?.length ?? 0) > 0)
    ) {
      return;
    }

    const models = await this.fetchDesktopCloudModels(linkUrl, cloud.apiKey);
    if (models === null) {
      return;
    }

    await this.setDesktopCloudState({
      connected: cloud.connected,
      polling: cloud.polling,
      userId,
      userName: cloud.userName ?? null,
      userEmail: cloud.userEmail ?? null,
      connectedAt: cloud.connectedAt ?? null,
      linkUrl,
      apiKey: cloud.apiKey,
      models,
    });
  }

  private abortDesktopCloudPolling(): void {
    if (this.pollingState) {
      this.pollingState.abortController.abort();
      this.pollingState = null;
    }
  }

  async connectDesktopCloud(options?: { source?: string | null }) {
    const config = await this.getConfig();
    const current = readDesktopCloud(config);
    const { activeProfile } =
      await this.readConfiguredDesktopCloudProfile(config);
    if (current.connected && current.apiKey) {
      return { error: "Already connected. Disconnect first." };
    }
    // If a previous connect attempt is still polling (e.g. the user closed the
    // authorization tab without completing the flow), cancel it and clear the
    // persisted polling flag so this call can start a fresh browser login.
    if (this.pollingState || current.polling) {
      this.abortDesktopCloudPolling();
      await this.setDesktopCloudState({
        connected: false,
        polling: false,
        userId: null,
        userName: null,
        userEmail: null,
        connectedAt: null,
        linkUrl: null,
        apiKey: null,
        models: [],
      });
    }
    const trimmedSource = options?.source?.trim();
    const sourceQuery =
      trimmedSource && trimmedSource.length > 0
        ? `&source=${encodeURIComponent(trimmedSource)}`
        : "";

    const deviceId = crypto.randomUUID();
    const deviceSecret = crypto.randomUUID();
    const deviceSecretHash = crypto
      .createHash("sha256")
      .update(deviceSecret)
      .digest("hex");

    const cloudApiUrl = activeProfile.linkUrl || activeProfile.cloudUrl;
    let res: Response;
    const registerUrl = `${cloudApiUrl}/api/auth/device-register`;
    try {
      res = await proxyFetch(registerUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ deviceId, deviceSecretHash }),
        timeoutMs: 10_000,
      });
    } catch (error) {
      logger.warn(
        {
          url: registerUrl,
          error: describeFetchError(error),
        },
        "desktop_cloud_connect_register_failed",
      );
      return {
        error: `Cloud unreachable: ${describeFetchError(error)}`,
      };
    }

    if (!res.ok) {
      const detail = await describeCloudErrorResponse(res);
      logger.warn(
        {
          url: registerUrl,
          status: res.status,
          cfRay: res.headers.get("cf-ray") ?? undefined,
        },
        "desktop_cloud_connect_register_rejected",
      );
      return { error: `Failed to register device: ${detail}` };
    }

    await this.setDesktopCloudState({
      connected: false,
      polling: true,
      userId: null,
      userName: null,
      userEmail: null,
      connectedAt: null,
      linkUrl: null,
      apiKey: null,
      models: [],
    });

    const abortController = new AbortController();
    this.pollingState = { deviceId, deviceSecret, abortController };
    void this.pollDesktopCloudAuthorization(
      cloudApiUrl,
      deviceId,
      deviceSecret,
      abortController.signal,
    );

    return {
      browserUrl: `${activeProfile.cloudUrl}/auth?desktop=1&device_id=${encodeURIComponent(deviceId)}${sourceQuery}`,
      error: undefined,
    };
  }

  async setDesktopCloudProfiles(profiles: CloudProfileInput[]) {
    const normalizedProfiles = normalizeImportedCloudProfiles(profiles);
    await this.cloudProfilesStore.write({
      schemaVersion: 1,
      profiles: normalizedProfiles,
    });

    const config = await this.getConfig();
    const activeProfileName = readDesktopActiveCloudProfileName(config);
    const activeProfile = this.resolveActiveCloudProfile(
      normalizedProfiles,
      activeProfileName,
    );

    await this.store.update((currentConfig) => {
      const sessions = readDesktopCloudSessions(currentConfig);
      const allowedNames = new Set(
        normalizedProfiles.map((profile) => profile.name),
      );
      const nextSessions = Object.fromEntries(
        Object.entries(sessions).filter(([name]) => allowedNames.has(name)),
      );

      return {
        ...currentConfig,
        desktop: {
          ...currentConfig.desktop,
          activeCloudProfileName: activeProfile.name,
          cloudSessions: nextSessions,
        },
      };
    });

    return this.getDesktopCloudStatus();
  }

  async createDesktopCloudProfile(profile: CloudProfileInput) {
    if (isDefaultCloudProfileName(profile.name)) {
      throw new Error("Default cloud profile name is reserved.");
    }

    const existingProfiles = await this.listStoredCloudProfiles();
    if (existingProfiles.some((item) => item.name === profile.name.trim())) {
      throw new Error(`Cloud profile already exists: ${profile.name.trim()}`);
    }

    const normalizedProfiles = normalizeImportedCloudProfiles([
      ...existingProfiles,
      {
        name: profile.name.trim(),
        cloudUrl: profile.cloudUrl.trim(),
        linkUrl: profile.linkUrl.trim(),
      },
    ]);

    await this.cloudProfilesStore.write({
      schemaVersion: 1,
      profiles: normalizedProfiles,
    });

    return this.getDesktopCloudStatus();
  }

  async updateDesktopCloudProfile(
    previousName: string,
    profile: CloudProfileInput,
  ) {
    if (
      isDefaultCloudProfileName(previousName) ||
      isDefaultCloudProfileName(profile.name)
    ) {
      throw new Error("Default cloud profile cannot be edited.");
    }

    const existingProfiles = await this.listStoredCloudProfiles();
    if (!existingProfiles.some((item) => item.name === previousName)) {
      throw new Error(`Unknown cloud profile: ${previousName}`);
    }
    const nextName = profile.name.trim();
    if (
      nextName !== previousName &&
      existingProfiles.some((item) => item.name === nextName)
    ) {
      throw new Error(`Cloud profile already exists: ${nextName}`);
    }

    const nextProfiles = existingProfiles.map((item) =>
      item.name === previousName
        ? {
            name: nextName,
            cloudUrl: profile.cloudUrl.trim(),
            linkUrl: profile.linkUrl.trim(),
          }
        : item,
    );

    const normalizedProfiles = normalizeImportedCloudProfiles(nextProfiles);
    await this.cloudProfilesStore.write({
      schemaVersion: 1,
      profiles: normalizedProfiles,
    });

    await this.store.update((config) => {
      const sessions = readDesktopCloudSessions(config);
      const previousSession = sessions[previousName];
      const { [previousName]: _removed, ...restSessions } = sessions;

      return {
        ...config,
        desktop: {
          ...config.desktop,
          activeCloudProfileName:
            readDesktopActiveCloudProfileName(config) === previousName
              ? nextName
              : readDesktopActiveCloudProfileName(config),
          cloudSessions: previousSession
            ? {
                ...restSessions,
                [nextName]: previousSession,
              }
            : restSessions,
        },
      };
    });

    return this.getDesktopCloudStatus();
  }

  async deleteDesktopCloudProfile(name: string) {
    if (isDefaultCloudProfileName(name)) {
      throw new Error("Default cloud profile cannot be deleted.");
    }

    const existingProfiles = await this.listStoredCloudProfiles();
    if (!existingProfiles.some((item) => item.name === name)) {
      throw new Error(`Unknown cloud profile: ${name}`);
    }

    const normalizedProfiles = existingProfiles.filter(
      (item) => item.name !== name,
    );
    await this.cloudProfilesStore.write({
      schemaVersion: 1,
      profiles: normalizedProfiles,
    });

    const previousCloud = readDesktopCloud(await this.getConfig());

    this.abortDesktopCloudPolling();

    await this.store.update((config) => {
      const currentProfile = readLocalProfile(config);
      const shouldResetActive =
        readDesktopActiveCloudProfileName(config) === name;
      const sessions = readDesktopCloudSessions(config);
      const { [name]: _removed, ...restSessions } = sessions;

      return {
        ...config,
        desktop: {
          ...config.desktop,
          localProfile: {
            ...currentProfile,
            authSource: shouldResetActive
              ? "desktop-local"
              : currentProfile.authSource,
          },
          activeCloudProfileName: shouldResetActive
            ? defaultCloudProfile.name
            : readDesktopActiveCloudProfileName(config),
          cloudSessions: restSessions,
          cloud: shouldResetActive
            ? {
                connected: false,
                polling: false,
                userId: null,
                userName: null,
                userEmail: null,
                connectedAt: null,
                linkUrl: null,
                apiKey: null,
                models: [],
              }
            : config.desktop.cloud,
        },
      };
    });

    if (
      readDesktopActiveCloudProfileName(await this.getConfig()) ===
      defaultCloudProfile.name
    ) {
      await this.onCloudStateChanged?.({
        hadCloudInventory: (previousCloud.models?.length ?? 0) > 0,
        hasCloudInventory: false,
        connected: false,
      });
    }

    return this.getDesktopCloudStatus();
  }

  async switchDesktopCloudProfile(name: string) {
    const config = await this.getConfig();
    const previousCloud = readDesktopCloud(config);
    const profiles = await this.listStoredCloudProfiles();
    const nextProfile = profiles.find((profile) => profile.name === name);

    if (!nextProfile) {
      throw new Error(`Unknown cloud profile: ${name}`);
    }

    this.abortDesktopCloudPolling();

    await this.store.update((currentConfig) => {
      const currentProfile = readLocalProfile(currentConfig);
      const sessions = readDesktopCloudSessions(currentConfig);
      const nextSession = sessions[nextProfile.name];

      return {
        ...currentConfig,
        desktop: {
          ...currentConfig.desktop,
          localProfile: {
            ...currentProfile,
            authSource: nextSession?.connected
              ? currentProfile.authSource
              : "desktop-local",
          },
          activeCloudProfileName: nextProfile.name,
          cloud: nextSession
            ? {
                connected: nextSession.connected,
                polling: nextSession.polling,
                userId: nextSession.userId ?? null,
                userName: nextSession.userName ?? null,
                userEmail: nextSession.userEmail ?? null,
                connectedAt: nextSession.connectedAt ?? null,
                linkUrl: nextSession.linkUrl ?? null,
                apiKey: nextSession.apiKey ?? null,
                models: nextSession.models ?? [],
              }
            : {
                connected: false,
                polling: false,
                userId: null,
                userName: null,
                userEmail: null,
                connectedAt: null,
                linkUrl: null,
                apiKey: null,
                models: [],
              },
        },
      };
    });

    const switchedConfig = await this.getConfig();
    const switchedCloud = readDesktopCloud(switchedConfig);
    let nextModels = switchedCloud.models ?? [];

    if (switchedCloud.connected && switchedCloud.apiKey) {
      const refreshedModels = await this.fetchDesktopCloudModels(
        nextProfile.linkUrl,
        switchedCloud.apiKey,
      );
      nextModels = refreshedModels ?? nextModels;
    }

    await this.setDesktopCloudState({
      connected: switchedCloud.connected,
      polling: false,
      userId: switchedCloud.userId ?? null,
      userName: switchedCloud.userName ?? null,
      userEmail: switchedCloud.userEmail ?? null,
      connectedAt: switchedCloud.connectedAt ?? null,
      linkUrl: switchedCloud.connected ? nextProfile.linkUrl : null,
      apiKey: switchedCloud.apiKey ?? null,
      models: switchedCloud.connected ? nextModels : [],
    });

    await this.onCloudStateChanged?.({
      hadCloudInventory: (previousCloud.models?.length ?? 0) > 0,
      hasCloudInventory: nextModels.length > 0,
      connected: switchedCloud.connected,
    });

    return this.getDesktopCloudStatus();
  }

  async connectDesktopCloudProfile(
    name: string,
    options?: { source?: string | null },
  ) {
    const config = await this.getConfig();
    const activeProfileName = readDesktopActiveCloudProfileName(config);

    if (activeProfileName !== name) {
      await this.switchDesktopCloudProfile(name);
    }

    const status = await this.getDesktopCloudStatus();
    const targetProfile = status.profiles.find(
      (profile) => profile.name === name,
    );
    if (targetProfile?.connected) {
      return { browserUrl: undefined, error: undefined, status };
    }

    const result = await this.connectDesktopCloud(options);
    return {
      browserUrl: result.browserUrl,
      error: result.error,
      status: await this.getDesktopCloudStatus(),
    };
  }

  async disconnectDesktopCloudProfile(name: string) {
    const config = await this.getConfig();
    const activeProfileName = readDesktopActiveCloudProfileName(config);

    if (activeProfileName === name) {
      await this.disconnectDesktopCloud();
      return this.getDesktopCloudStatus();
    }

    await this.store.update((currentConfig) => {
      const sessions = readDesktopCloudSessions(currentConfig);
      const nextSession = sessions[name];

      if (!nextSession) {
        return currentConfig;
      }

      return {
        ...currentConfig,
        desktop: {
          ...currentConfig.desktop,
          cloudSessions: {
            ...sessions,
            [name]: {
              connected: false,
              polling: false,
              userId: null,
              userName: null,
              userEmail: null,
              connectedAt: null,
              linkUrl: null,
              apiKey: null,
              models: [],
            },
          },
        },
      };
    });

    return this.getDesktopCloudStatus();
  }

  async disconnectDesktopCloud() {
    const previousConfig = await this.getConfig();
    const previousCloud = readDesktopCloud(previousConfig);
    this.abortDesktopCloudPolling();

    await this.setDesktopCloudState({
      connected: false,
      polling: false,
      userId: null,
      userName: null,
      userEmail: null,
      connectedAt: null,
      linkUrl: null,
      apiKey: null,
      models: [],
    });
    // Strip every managed-cloud (link/*) reference from the persisted config:
    // the runtime default AND per-bot overrides. Only clearing the global
    // default leaves bots that were explicitly set to a Link model still
    // pointing at an unavailable link/* id, which later compiles into the
    // agent runtime and surfaces as "Unknown model"/"no provider" errors.
    // BYOK/OAuth selections are untouched so user-configured non-Link bots
    // keep working.
    const previousCloudModels = previousCloud.models;
    const defaultWasManaged = isManagedCloudModelId(
      previousConfig.runtime.defaultModelId,
      previousCloudModels,
    );
    const botsHaveManaged = previousConfig.bots.some(
      (bot) =>
        bot.modelId !== null &&
        isManagedCloudModelId(bot.modelId, previousCloudModels),
    );
    if (defaultWasManaged || botsHaveManaged) {
      const updatedAt = now();
      await this.store.update((config) => ({
        ...config,
        runtime: {
          ...config.runtime,
          defaultModelId: isManagedCloudModelId(
            config.runtime.defaultModelId,
            previousCloudModels,
          )
            ? ""
            : config.runtime.defaultModelId,
        },
        bots: config.bots.map((bot) =>
          bot.modelId !== null &&
          isManagedCloudModelId(bot.modelId, previousCloudModels)
            ? // Back to following the global default rather than an empty
              // string, which compiled into an "Unknown model" agent.
              { ...bot, modelId: null, updatedAt }
            : bot,
        ),
      }));
    }
    await this.onCloudStateChanged?.({
      hadCloudInventory: (previousCloud.models?.length ?? 0) > 0,
      hasCloudInventory: false,
      connected: false,
    });

    return { ok: true };
  }

  async setDesktopCloudModels(enabledModelIds: string[]) {
    await this.store.update((config) => {
      const cloud = readDesktopCloud(config);
      return {
        ...config,
        desktop: {
          ...config.desktop,
          cloud: {
            ...cloud,
            models: (cloud.models ?? []).filter((model) =>
              enabledModelIds.includes(model.id),
            ),
          },
        },
      };
    });

    const next = await this.getDesktopCloudStatus();
    return {
      ok: true,
      models: next.models,
    };
  }

  async connectIntegration(
    input: ConnectIntegrationInput,
  ): Promise<ConnectIntegrationResponse> {
    const timestamp = now();
    const integrationId = crypto.randomUUID();
    const integration: IntegrationResponse = {
      id: integrationId,
      toolkit: {
        slug: input.toolkitSlug,
        displayName: input.toolkitSlug,
        description: "Controller-managed integration",
        iconUrl: `/toolkit-icons/${input.toolkitSlug}.svg`,
        fallbackIconUrl: "https://www.google.com/s2/favicons?sz=64",
        category: "tooling",
        authScheme: input.credentials ? "api_key_user" : "oauth2",
        authFields: input.credentials
          ? Object.keys(input.credentials).map((key) => ({
              key,
              label: key,
              type: "secret" as const,
            }))
          : undefined,
      },
      status: input.credentials ? "active" : "initiated",
      connectUrl:
        input.credentials === undefined
          ? `${input.returnTo ?? "/"}?integration=${input.toolkitSlug}`
          : undefined,
      connectedAt: input.credentials ? timestamp : undefined,
      credentialHints: input.credentials
        ? Object.fromEntries(
            Object.keys(input.credentials).map((key) => [key, "***"]),
          )
        : undefined,
      returnTo: input.returnTo,
      source: input.source,
    };

    await this.store.update((config) => ({
      ...config,
      integrations: [
        ...config.integrations.filter(
          (item) => item.toolkit.slug !== input.toolkitSlug,
        ),
        integration,
      ],
      secrets: {
        ...config.secrets,
        ...Object.fromEntries(
          Object.entries(input.credentials ?? {})
            .filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === "string",
            )
            .map(([key, value]) => [
              `integration:${integrationId}:${key}`,
              value,
            ]),
        ),
      },
    }));

    return {
      integration,
      connectUrl: integration.connectUrl,
      state: integration.id,
    };
  }

  async refreshIntegration(
    integrationId: string,
    _input: RefreshIntegrationInput,
  ): Promise<IntegrationResponse | null> {
    let updated: IntegrationResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      integrations: config.integrations.map((integration) => {
        if (integration.id !== integrationId) {
          return integration;
        }

        updated = {
          ...integration,
          status: "active",
          connectedAt: integration.connectedAt ?? now(),
        };

        return updated;
      }),
    }));

    return updated;
  }

  async deleteIntegration(
    integrationId: string,
  ): Promise<IntegrationResponse | null> {
    let removed: IntegrationResponse | null = null;

    await this.store.update((config) => ({
      ...config,
      integrations: config.integrations.filter((integration) => {
        if (integration.id === integrationId) {
          removed = {
            ...integration,
            status: "disconnected",
          };
          return false;
        }

        return true;
      }),
      secrets: Object.fromEntries(
        Object.entries(config.secrets).filter(
          ([key]) => !key.startsWith(`integration:${integrationId}:`),
        ),
      ),
    }));

    return removed;
  }

  async getRuntimeConfig(): Promise<ControllerRuntimeConfig> {
    const config = await this.getConfig();
    return config.runtime;
  }

  async setRuntimeConfig(
    runtime: ControllerRuntimeConfig,
  ): Promise<ControllerRuntimeConfig> {
    await this.store.update((config) => ({
      ...config,
      runtime,
    }));

    return runtime;
  }

  async getDeviceControlConfig(): Promise<DeviceControlConfig> {
    const config = await this.getConfig();
    return config.deviceControl;
  }

  async setDeviceControlConfig(patch: {
    enabled?: boolean;
    wsPort?: number;
    rpcPort?: number;
    phoneVlmModel?: string | null;
  }): Promise<void> {
    await this.store.update((config) => ({
      ...config,
      deviceControl: {
        ...config.deviceControl,
        ...patch,
      },
    }));
  }

  async getLocalAutomationConfig(): Promise<LocalAutomationConfig> {
    const config = await this.getConfig();
    return config.localAutomation;
  }

  async setLocalAutomationConfig(
    patch: Partial<LocalAutomationConfig>,
  ): Promise<LocalAutomationConfig> {
    let nextConfig: LocalAutomationConfig = {
      browser: { enabled: false },
      computerUse: { enabled: false },
    };
    await this.store.update((config) => {
      nextConfig = {
        browser: {
          ...config.localAutomation.browser,
          ...patch.browser,
        },
        computerUse: {
          ...config.localAutomation.computerUse,
          ...patch.computerUse,
        },
      };
      return { ...config, localAutomation: nextConfig };
    });
    return nextConfig;
  }

  async getMemoryConfig(): Promise<MemoryConfig> {
    const config = await this.getConfig();
    return config.memory;
  }

  async setMemoryConfig(patch: Partial<MemoryConfig>): Promise<MemoryConfig> {
    let nextConfig: MemoryConfig = {
      enabled: true,
      sources: ["memory"],
      extraPaths: [],
      syncIntervalMinutes: 5,
      provider: "none",
      minScore: 0.2,
    };
    await this.store.update((config) => {
      nextConfig = {
        ...config.memory,
        ...patch,
        sources: patch.sources ?? config.memory.sources,
        extraPaths: patch.extraPaths ?? config.memory.extraPaths,
      };
      return { ...config, memory: nextConfig };
    });
    return nextConfig;
  }

  async getMemosConfig(): Promise<MemosConfig> {
    const config = await this.getConfig();
    return config.memos;
  }

  async setMemosConfig(patch: Partial<MemosConfig>): Promise<MemosConfig> {
    let nextConfig: MemosConfig = {
      enabled: false,
      userId: "tabby-user",
      memoryLimitNumber: 9,
      preferenceLimitNumber: 6,
      relativity: 0.4,
    };
    await this.store.update((config) => {
      nextConfig = { ...config.memos, ...patch };
      return { ...config, memos: nextConfig };
    });
    return nextConfig;
  }

  async getModelProviderConfigDocument(): Promise<PersistedModelsConfig> {
    const config = await this.getConfig();
    return config.models;
  }

  async setModelProviderConfigDocument(
    models: PersistedModelsConfig,
  ): Promise<PersistedModelsConfig> {
    await this.store.update((config) => ({
      ...config,
      schemaVersion: Math.max(
        config.schemaVersion,
        CANONICAL_MODELS_PROVIDERS_CUTOVER_SCHEMA_VERSION,
      ),
      models,
    }));

    return (await this.getConfig()).models;
  }

  async syncManagedRuntimeGateway(input: {
    port: number;
    authMode: ControllerRuntimeConfig["gateway"]["authMode"];
  }): Promise<void> {
    await this.store.update((config) => {
      if (
        config.runtime.gateway.port === input.port &&
        config.runtime.gateway.authMode === input.authMode
      ) {
        return config;
      }

      return {
        ...config,
        runtime: {
          ...config.runtime,
          gateway: {
            ...config.runtime.gateway,
            port: input.port,
            authMode: input.authMode,
          },
        },
      };
    });
  }

  async listTemplates() {
    const config = await this.getConfig();
    return Object.values(config.templates);
  }

  async upsertTemplate(input: {
    name: string;
    content: string;
    writeMode?: "seed" | "inject";
    status?: "active" | "inactive";
  }) {
    const existing = (await this.getConfig()).templates[input.name];
    const timestamp = now();
    const template = {
      id: existing?.id ?? crypto.randomUUID(),
      name: input.name,
      content: input.content,
      writeMode: input.writeMode ?? existing?.writeMode ?? "seed",
      status: input.status ?? existing?.status ?? "active",
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };

    await this.store.update((config) => ({
      ...config,
      templates: {
        ...config.templates,
        [input.name]: template,
      },
    }));

    return template;
  }

  async getRuntimeTemplatesSnapshot(): Promise<{
    version: number;
    templatesHash: string;
    templates: Record<
      string,
      { content: string; writeMode: "seed" | "inject" }
    >;
    createdAt: string;
  }> {
    const templates = (await this.listTemplates()).filter(
      (template) => template.status === "active",
    );
    const payload = Object.fromEntries(
      templates.map((template) => [
        template.name,
        {
          content: template.content,
          writeMode: template.writeMode,
        },
      ]),
    );
    const createdAt = now();
    return {
      version: templates.length,
      templatesHash: crypto
        .createHash("sha256")
        .update(JSON.stringify(payload))
        .digest("hex"),
      templates: payload,
      createdAt,
    };
  }
}
