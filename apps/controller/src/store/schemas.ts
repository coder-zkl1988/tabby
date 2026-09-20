import {
  type ModelProviderConfig,
  type ModelProviderModelEntry,
  type PersistedModelsConfig,
  botResponseSchema,
  buildCustomProviderKey,
  channelResponseSchema,
  getDefaultProviderBaseUrls,
  getProviderAliasCandidates,
  getProviderRuntimePolicy,
  integrationResponseSchema,
  normalizeProviderId,
  parseCustomProviderKey,
  persistedModelsConfigSchema,
  providerResponseSchema,
  scheduleResponseSchema,
} from "@nexu/shared";
import { z } from "zod";

const LEGACY_PROVIDER_MIGRATION_CREATED_AT = "1970-01-01T00:00:00.000Z";
export const CANONICAL_MODELS_PROVIDERS_CUTOVER_SCHEMA_VERSION = 2;

type ProviderMetadataRecord = Record<string, unknown>;

function getMetadataRecord(value: unknown): ProviderMetadataRecord | undefined {
  return typeof value === "object" && value !== null
    ? (value as ProviderMetadataRecord)
    : undefined;
}

function normalizeProviderStorageKey(providerId: string): string | null {
  const customProvider = parseCustomProviderKey(providerId);
  if (customProvider) {
    return buildCustomProviderKey(
      customProvider.templateId,
      customProvider.instanceId,
    );
  }

  return normalizeProviderId(providerId);
}

function encodeCustomProviderRuntimeKey(
  templateId: string,
  instanceId: string,
): string {
  return `${templateId}__${encodeURIComponent(instanceId)}`;
}

/**
 * Namespaces a persisted ref may carry in the segment after its provider key.
 *
 * Every alias, not just the current canonical id: `byok_gemini/gemini/...` was
 * written when `gemini` was google's canonical id, so stripping only today's
 * `google` would leave the stale namespace glued to the model id.
 */
function getProviderRuntimeNamespaces(providerKey: string): string[] {
  if (parseCustomProviderKey(providerKey)) {
    return [];
  }

  if (!getProviderRuntimePolicy(providerKey)) {
    return [];
  }

  return getProviderAliasCandidates(providerKey);
}

function stripRuntimeModelNamespace(
  modelId: string,
  namespaces: readonly string[],
): string {
  for (const namespace of namespaces) {
    if (modelId.startsWith(`${namespace}/`)) {
      return modelId.slice(namespace.length + 1);
    }
  }
  return modelId;
}

function matchPersistedModelRef(
  modelsConfig: PersistedModelsConfig,
  rawModelId: string,
): { persistedKey: string; modelId: string } | null {
  const prefixes = Object.entries(modelsConfig.providers).flatMap(
    ([persistedKey]): Array<{
      persistedKey: string;
      prefix: string;
      runtimeNamespaces: string[];
    }> => {
      const customProvider = parseCustomProviderKey(persistedKey);
      const providerId = customProvider?.templateId ?? persistedKey;
      const runtimePolicy = getProviderRuntimePolicy(providerId);
      const runtimeNamespaces = getProviderRuntimeNamespaces(persistedKey);
      if (!runtimePolicy) {
        return [];
      }

      const candidatePrefixes = customProvider
        ? [
            persistedKey,
            encodeCustomProviderRuntimeKey(
              customProvider.templateId,
              customProvider.instanceId,
            ),
          ]
        : [
            persistedKey,
            // Every alias, each also in its `byok_` runtime form. Covering only
            // the current canonical id strands refs persisted before a rename:
            // `byok_gemini/...` stopped matching once google's canonical id
            // moved off `gemini`, and then fell through to a bare model id that
            // belongs to no provider at all.
            ...getProviderAliasCandidates(providerId).flatMap((alias) => [
              alias,
              `byok_${alias}`,
            ]),
          ];

      return Array.from(new Set(candidatePrefixes)).map((prefix) => ({
        persistedKey,
        prefix,
        runtimeNamespaces,
      }));
    },
  );

  prefixes.sort((left, right) => right.prefix.length - left.prefix.length);

  for (const { persistedKey, prefix, runtimeNamespaces } of prefixes) {
    if (!rawModelId.startsWith(`${prefix}/`)) {
      continue;
    }

    const remainder = rawModelId.slice(prefix.length + 1);
    return {
      persistedKey,
      modelId: stripRuntimeModelNamespace(remainder, runtimeNamespaces),
    };
  }

  return null;
}

function normalizePersistedModelRef(
  rawModelId: string,
  modelsConfig: PersistedModelsConfig,
): string {
  const modelId = rawModelId.trim();
  if (modelId.length === 0) {
    return modelId;
  }

  if (
    modelId.startsWith("link/") ||
    modelId.startsWith("litellm/") ||
    modelId.startsWith("debug/")
  ) {
    return modelId;
  }

  const matched = matchPersistedModelRef(modelsConfig, modelId);
  if (matched) {
    return `${matched.persistedKey}/${matched.modelId}`;
  }

  if (modelId.startsWith("byok_")) {
    const slashIndex = modelId.indexOf("/");
    if (slashIndex > 0 && slashIndex < modelId.length - 1) {
      return normalizePersistedModelRef(
        modelId.slice(slashIndex + 1),
        modelsConfig,
      );
    }
  }

  const slashIndex = modelId.indexOf("/");
  if (slashIndex <= 0 || slashIndex === modelId.length - 1) {
    return modelId;
  }

  const providerPrefix = modelId.slice(0, slashIndex);
  const remainder = modelId.slice(slashIndex + 1);
  const normalizedProviderPrefix = normalizeProviderStorageKey(providerPrefix);
  if (!normalizedProviderPrefix) {
    return modelId;
  }

  return `${normalizedProviderPrefix}/${remainder}`;
}

function normalizeProviderModelId(
  providerKey: string,
  rawModelId: string,
  modelsConfig: PersistedModelsConfig,
): string {
  const normalizedRef = normalizePersistedModelRef(rawModelId, modelsConfig);
  if (normalizedRef.startsWith(`${providerKey}/`)) {
    return normalizedRef.slice(providerKey.length + 1);
  }

  return stripRuntimeModelNamespace(
    normalizedRef,
    getProviderRuntimeNamespaces(providerKey),
  );
}

function normalizeCanonicalModelsConfig(
  modelsConfig: PersistedModelsConfig,
): PersistedModelsConfig {
  const normalizedProviders = Object.fromEntries(
    Object.entries(modelsConfig.providers).flatMap(
      ([providerKey, provider]) => {
        const normalizedProviderKey = normalizeProviderStorageKey(providerKey);
        if (!normalizedProviderKey) {
          return [];
        }

        return [[normalizedProviderKey, provider]];
      },
    ),
  );

  const normalizedConfig: PersistedModelsConfig = {
    ...modelsConfig,
    providers: normalizedProviders,
  };

  return {
    ...normalizedConfig,
    providers: Object.fromEntries(
      Object.entries(normalizedConfig.providers).map(
        ([providerKey, provider]) => [
          providerKey,
          {
            ...provider,
            models: provider.models.map((model) => ({
              ...model,
              id: normalizeProviderModelId(
                providerKey,
                model.id,
                normalizedConfig,
              ),
            })),
          },
        ],
      ),
    ),
  };
}

function buildCanonicalModelEntry(
  providerKey: string,
  modelId: string,
): ModelProviderModelEntry {
  const customProvider = parseCustomProviderKey(providerKey);
  const providerPolicy = getProviderRuntimePolicy(
    customProvider?.templateId ?? providerKey,
  );

  return {
    id: modelId,
    name: modelId,
    api: providerPolicy?.apiKind,
    reasoning: false,
    input: ["text"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow: 0,
    maxTokens: 0,
  };
}

function buildCanonicalProviderBaseUrl(
  providerId: string,
  baseUrl: string | null,
  oauthRegion: "global" | "cn" | null,
) {
  if (typeof baseUrl === "string" && baseUrl.trim().length > 0) {
    return baseUrl;
  }

  if (providerId === "minimax" && oauthRegion === "cn") {
    return "https://api.minimaxi.com/anthropic";
  }

  return getDefaultProviderBaseUrls(providerId)[0] ?? null;
}

function migrateLegacyProviderToCanonicalConfig(
  provider: ControllerProvider,
): [string, ModelProviderConfig] | null {
  const providerKey = normalizeProviderStorageKey(provider.providerId);
  if (!providerKey) {
    return null;
  }

  const customProvider = parseCustomProviderKey(providerKey);
  const runtimePolicy = getProviderRuntimePolicy(
    customProvider?.templateId ?? providerKey,
  );
  const hasApiKey =
    typeof provider.apiKey === "string" && provider.apiKey.length > 0;
  const baseUrl = buildCanonicalProviderBaseUrl(
    provider.providerId,
    provider.baseUrl,
    provider.oauthRegion,
  );

  if (baseUrl === null) {
    return null;
  }

  const metadata: ProviderMetadataRecord = {
    legacyId: provider.id,
    legacyCreatedAt: provider.createdAt,
    legacyUpdatedAt: provider.updatedAt,
  };

  if (provider.oauthCredential) {
    metadata.legacyOauthCredential = provider.oauthCredential;
  }

  const nextProvider: ModelProviderConfig = {
    ...(customProvider
      ? {
          providerTemplateId: customProvider.templateId,
          instanceId: customProvider.instanceId,
        }
      : {}),
    enabled: provider.enabled,
    displayName: provider.displayName ?? undefined,
    baseUrl,
    ...(provider.authMode === "oauth"
      ? { auth: "oauth" as const }
      : hasApiKey
        ? { auth: "api-key" as const }
        : {}),
    api: runtimePolicy?.apiKind,
    ...((provider.authMode === "apiKey" || provider.authMode === undefined) &&
    hasApiKey
      ? { apiKey: provider.apiKey as string }
      : {}),
    ...(provider.oauthRegion ? { oauthRegion: provider.oauthRegion } : {}),
    ...(provider.oauthCredential?.provider
      ? { oauthProfileRef: provider.oauthCredential.provider }
      : {}),
    models: provider.models.map((modelId) =>
      buildCanonicalModelEntry(providerKey, modelId),
    ),
    metadata,
  };

  return [providerKey, nextProvider];
}

export function migrateLegacyProvidersToCanonicalModelsConfig(
  providers: ReadonlyArray<ControllerProvider>,
): PersistedModelsConfig {
  const nextProviders: Record<string, ModelProviderConfig> = {};

  for (const provider of providers) {
    const migrated = migrateLegacyProviderToCanonicalConfig(provider);
    if (!migrated) {
      continue;
    }

    const [providerKey, nextProvider] = migrated;
    nextProviders[providerKey] = nextProvider;
  }

  return {
    mode: "merge",
    providers: nextProviders,
  };
}

function migrateCanonicalProviderToLegacyProvider(
  providerKey: string,
  provider: ModelProviderConfig,
): ControllerProvider | null {
  const metadata = getMetadataRecord(provider.metadata);
  const providerId = providerKey;
  const legacyId =
    typeof metadata?.legacyId === "string" && metadata.legacyId.length > 0
      ? metadata.legacyId
      : providerId;
  const createdAt =
    typeof metadata?.legacyCreatedAt === "string" &&
    metadata.legacyCreatedAt.length > 0
      ? metadata.legacyCreatedAt
      : LEGACY_PROVIDER_MIGRATION_CREATED_AT;
  const updatedAt =
    typeof metadata?.legacyUpdatedAt === "string" &&
    metadata.legacyUpdatedAt.length > 0
      ? metadata.legacyUpdatedAt
      : createdAt;
  const oauthCredential =
    typeof metadata?.legacyOauthCredential === "object" &&
    metadata.legacyOauthCredential !== null
      ? (metadata.legacyOauthCredential as ControllerProvider["oauthCredential"])
      : null;

  return {
    id: legacyId,
    providerId,
    displayName: provider.displayName ?? null,
    enabled: provider.enabled,
    baseUrl: provider.baseUrl,
    authMode: provider.auth === "oauth" ? "oauth" : "apiKey",
    apiKey: typeof provider.apiKey === "string" ? provider.apiKey : null,
    oauthRegion: provider.oauthRegion ?? null,
    oauthCredential,
    models: provider.models.map((model) => model.id),
    createdAt,
    updatedAt,
  };
}

export function deriveLegacyProvidersFromCanonicalModelsConfig(
  modelsConfig: PersistedModelsConfig,
): ControllerProvider[] {
  return Object.entries(modelsConfig.providers)
    .map(([providerKey, provider]) =>
      migrateCanonicalProviderToLegacyProvider(providerKey, provider),
    )
    .filter((provider): provider is ControllerProvider => provider !== null);
}

function normalizeModelsConfigInput(
  candidateModels: unknown,
  legacyProviders: ReadonlyArray<ControllerProvider>,
): PersistedModelsConfig {
  const parsedModels = persistedModelsConfigSchema.safeParse(candidateModels);
  if (parsedModels.success) {
    return normalizeCanonicalModelsConfig(parsedModels.data);
  }

  return normalizeCanonicalModelsConfig(
    migrateLegacyProvidersToCanonicalModelsConfig(legacyProviders),
  );
}

function normalizeNexuConfigSchemaVersion(
  schemaVersion: unknown,
  input: Record<string, unknown>,
): number {
  const parsedSchemaVersion =
    typeof schemaVersion === "number" ? schemaVersion : 1;

  const hasCanonicalModels = input.models !== undefined;
  const hasLegacyProviders =
    Array.isArray(input.providers) && input.providers.length > 0;

  if (!hasCanonicalModels && !hasLegacyProviders) {
    return parsedSchemaVersion;
  }

  return Math.max(
    parsedSchemaVersion,
    CANONICAL_MODELS_PROVIDERS_CUTOVER_SCHEMA_VERSION,
  );
}

export const controllerRuntimeConfigSchema = z
  .object({
    gateway: z
      .object({
        port: z.number().int().positive().default(18789),
        bind: z.enum(["loopback", "lan", "auto"]).default("loopback"),
        authMode: z.enum(["none", "token"]).default("none"),
      })
      .default({ port: 18789, bind: "loopback", authMode: "none" }),
    defaultModelId: z.string().default("link/gemini-3-flash-preview"),
    // Optional lower-cost model for OpenClaw's short internal tasks (generated
    // session/thread titles). Compiled to agents.defaults.utilityModel; when
    // null OpenClaw falls back to the agent's primary model.
    utilityModelId: z.string().nullable().default(null),
  })
  .passthrough();

export const controllerProviderSchema = z.object({
  id: z.string(),
  providerId: z.string(),
  displayName: z.string().nullable(),
  enabled: z.boolean(),
  baseUrl: z.string().nullable(),
  authMode: z.enum(["apiKey", "oauth"]).default("apiKey"),
  apiKey: z.string().nullable(),
  oauthRegion: z.enum(["global", "cn"]).nullable().default(null),
  oauthCredential: z
    .object({
      provider: z.string(),
      access: z.string(),
      refresh: z.string().optional(),
      expires: z.number().int().optional(),
      email: z.string().optional(),
    })
    .nullable()
    .default(null),
  models: z.array(z.string()).default([]),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const controllerProviderInputSchema = z.object({
  apiKey: z.string().nullable().optional(),
  baseUrl: z.string().nullable().optional(),
  enabled: z.boolean().optional(),
  displayName: z.string().optional(),
  authMode: z.enum(["apiKey", "oauth"]).optional(),
  modelsJson: z.string().optional(),
});

export const storedProviderResponseSchema = providerResponseSchema.extend({
  apiKey: z.string().nullable().optional(),
  models: z.array(z.string()).optional(),
});

export const controllerTemplateSchema = z.object({
  id: z.string(),
  name: z.string(),
  content: z.string(),
  writeMode: z.enum(["seed", "inject"]).default("seed"),
  status: z.enum(["active", "inactive"]).default("active"),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const controllerTemplateUpsertBodySchema = z.object({
  content: z.string().min(1),
  writeMode: z.enum(["seed", "inject"]).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const controllerArtifactSchema = z.object({
  id: z.string(),
  botId: z.string(),
  title: z.string(),
  sessionKey: z.string().nullable(),
  channelType: z.string().nullable(),
  channelId: z.string().nullable(),
  artifactType: z.string().nullable(),
  source: z.string().nullable(),
  contentType: z.string().nullable(),
  status: z.string(),
  previewUrl: z.string().nullable(),
  deployTarget: z.string().nullable(),
  linesOfCode: z.number().nullable(),
  fileCount: z.number().nullable(),
  durationMs: z.number().nullable(),
  metadata: z.record(z.unknown()).nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export const deviceControlConfigSchema = z.object({
  enabled: z.boolean().default(true),
  wsPort: z.number().int().positive().default(18790),
  rpcPort: z.number().int().positive().default(18801),
  localIp: z.string().optional(),
  /**
   * Gateway model name pushed to phones as the device-control VLM
   * (settings page "手机控制模型"). null/absent = gateway default
   * (tabby-phone). Free-form string: the new-api gateway routes it.
   */
  phoneVlmModel: z.string().min(1).nullable().optional(),
});

export const localAutomationConfigSchema = z.object({
  browser: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
  computerUse: z
    .object({
      enabled: z.boolean().default(false),
    })
    .default({ enabled: false }),
});

export const memoryConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    sources: z
      .array(z.enum(["memory", "sessions"]))
      .min(1)
      .default(["memory"]),
    extraPaths: z.array(z.string().trim().min(1)).default([]),
    syncIntervalMinutes: z.number().int().min(1).max(1440).default(5),
    provider: z.string().trim().min(1).default("none"),
    model: z.string().trim().min(1).optional(),
    // Hybrid retrieval scores 0.7 * vector + 0.3 * BM25, so a query with no
    // literal overlap tops out at 0.7 even on a perfect semantic match.
    // OpenClaw's own default of 0.35 discarded most of those, which made
    // semantic recall look broken once an embedding provider was finally
    // configured. 0.2 lets them through.
    minScore: z.number().min(0).max(1).default(0.2),
  })
  .superRefine((value, ctx) => {
    if (value.provider !== "none" && !value.model) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["model"],
        message: "model is required when a memory embedding provider is set",
      });
    }
  });

/**
 * MemOS Cloud memory plugin, which recalls and stores conversation memory
 * outside OpenClaw's own file-backed memory.
 *
 * `multiAgentMode` and `recallGlobal` are deliberately absent: the plugin
 * defaults to recallGlobal=true with multiAgentMode=false, and that pair was
 * measured against two real bots — a second bot answered with the first bot's
 * memory verbatim, because without multiAgentMode nothing carries an agent_id
 * and recall spans the whole account. The compiler pins both. Memories written
 * while multiAgentMode is off carry no agent_id at all and stay invisible to
 * every later agent-scoped query, so there is no safe way to expose it.
 */
export const memosConfigSchema = z.object({
  enabled: z.boolean().default(false),
  // Stored in the encrypted `secrets` table, never here.
  userId: z.string().trim().min(1).max(200).default("tabby-user"),
  memoryLimitNumber: z.number().int().min(1).max(50).default(9),
  preferenceLimitNumber: z.number().int().min(1).max(50).default(6),
  relativity: z.number().min(0).max(1).default(0.4),
});

const nexuConfigObjectSchema = z.object({
  $schema: z.string(),
  schemaVersion: z.number().int().positive(),
  app: z.record(z.unknown()).default({}),
  bots: z.array(botResponseSchema).default([]),
  runtime: controllerRuntimeConfigSchema,
  models: persistedModelsConfigSchema.default({ mode: "merge", providers: {} }),
  providers: z.array(controllerProviderSchema).optional(),
  integrations: z.array(integrationResponseSchema).default([]),
  channels: z.array(channelResponseSchema).default([]),
  templates: z.record(z.string(), controllerTemplateSchema).default({}),
  desktop: z
    .object({
      localProfile: z.unknown().optional(),
      cloud: z.unknown().optional(),
      locale: z.enum(["en", "zh-CN"]).optional(),
      analyticsEnabled: z.boolean().optional(),
      crashReportsEnabled: z.boolean().optional(),
    })
    .catchall(z.unknown())
    .default({}),
  deviceControl: deviceControlConfigSchema.default({
    enabled: true,
    wsPort: 18790,
    rpcPort: 18801,
  }),
  localAutomation: localAutomationConfigSchema.default({
    browser: { enabled: false },
    computerUse: { enabled: false },
  }),
  memory: memoryConfigSchema.default({
    enabled: true,
    sources: ["memory"],
    extraPaths: [],
    syncIntervalMinutes: 5,
    provider: "none",
  }),
  memos: memosConfigSchema.default({}),
  secrets: z.record(z.string(), z.string()).default({}),
  schedules: z.array(scheduleResponseSchema).default([]),
});

export const nexuConfigSchema = z.preprocess((input) => {
  if (typeof input !== "object" || input === null) {
    return input;
  }

  const candidate = input as Record<string, unknown>;
  const legacyProviders = Array.isArray(candidate.providers)
    ? candidate.providers
    : [];
  const models = normalizeModelsConfigInput(candidate.models, legacyProviders);
  const runtimeCandidate =
    typeof candidate.runtime === "object" && candidate.runtime !== null
      ? (candidate.runtime as Record<string, unknown>)
      : null;
  const desktopCandidate =
    typeof candidate.desktop === "object" && candidate.desktop !== null
      ? (candidate.desktop as Record<string, unknown>)
      : null;
  const persistedDefaultModelId = runtimeCandidate?.defaultModelId;
  return {
    $schema:
      typeof candidate.$schema === "string"
        ? candidate.$schema
        : "https://tabby.picaso.studio/config.json",
    schemaVersion: normalizeNexuConfigSchemaVersion(
      candidate.schemaVersion,
      candidate,
    ),
    app:
      typeof candidate.app === "object" && candidate.app !== null
        ? candidate.app
        : {},
    bots: Array.isArray(candidate.bots)
      ? candidate.bots.map((bot) => {
          if (typeof bot !== "object" || bot === null) return bot;
          if (typeof bot.modelId !== "string") return bot;
          const modelId = normalizePersistedModelRef(bot.modelId, models);
          // An empty id was the old "no model" marker; null is now the one
          // way to say "follow the global default".
          if (modelId === "") return { ...bot, modelId: null };
          // Migration: before per-bot binding existed, changing the global
          // default rewrote every bot, so a bot whose model merely equals the
          // current default was never a deliberate choice. Reset those to
          // follow, or they would silently freeze at today's value and stop
          // tracking the default forever. A bot pointing at anything else was
          // chosen and is left alone.
          const currentDefault =
            typeof persistedDefaultModelId === "string"
              ? normalizePersistedModelRef(persistedDefaultModelId, models)
              : null;
          if (currentDefault && modelId === currentDefault) {
            return { ...bot, modelId: null };
          }
          return { ...bot, modelId };
        })
      : [],
    runtime: runtimeCandidate
      ? {
          ...runtimeCandidate,
          ...(typeof runtimeCandidate.defaultModelId === "string"
            ? {
                defaultModelId: normalizePersistedModelRef(
                  runtimeCandidate.defaultModelId,
                  models,
                ),
              }
            : {}),
          ...(typeof runtimeCandidate.utilityModelId === "string"
            ? {
                utilityModelId: normalizePersistedModelRef(
                  runtimeCandidate.utilityModelId,
                  models,
                ),
              }
            : {}),
        }
      : {},
    models,
    integrations: Array.isArray(candidate.integrations)
      ? candidate.integrations
      : [],
    channels: Array.isArray(candidate.channels) ? candidate.channels : [],
    templates:
      typeof candidate.templates === "object" && candidate.templates !== null
        ? candidate.templates
        : {},
    desktop: desktopCandidate
      ? {
          ...desktopCandidate,
          ...(typeof desktopCandidate.selectedModelId === "string"
            ? {
                selectedModelId: normalizePersistedModelRef(
                  desktopCandidate.selectedModelId,
                  models,
                ),
              }
            : {}),
        }
      : {},
    deviceControl:
      typeof candidate.deviceControl === "object" &&
      candidate.deviceControl !== null
        ? candidate.deviceControl
        : {},
    localAutomation:
      typeof candidate.localAutomation === "object" &&
      candidate.localAutomation !== null
        ? candidate.localAutomation
        : {},
    memory:
      typeof candidate.memory === "object" && candidate.memory !== null
        ? candidate.memory
        : {},
    memos:
      typeof candidate.memos === "object" && candidate.memos !== null
        ? candidate.memos
        : {},
    secrets:
      typeof candidate.secrets === "object" && candidate.secrets !== null
        ? candidate.secrets
        : {},
    schedules: Array.isArray(candidate.schedules) ? candidate.schedules : [],
  };
}, nexuConfigObjectSchema);

export const artifactsIndexSchema = z.object({
  schemaVersion: z.number().int().positive(),
  artifacts: z.array(controllerArtifactSchema).default([]),
});

export const compiledOpenClawSnapshotSchema = z.object({
  updatedAt: z.string(),
  config: z.record(z.unknown()),
});

export const cloudProfileEntrySchema = z.object({
  name: z.string().min(1),
  cloudUrl: z.string().min(1),
  linkUrl: z.string().min(1),
});

export const cloudProfilesFileSchema = z.object({
  schemaVersion: z.number().int().positive(),
  profiles: z.array(cloudProfileEntrySchema).default([]),
});

export type NexuConfig = z.infer<typeof nexuConfigSchema>;
export type ControllerRuntimeConfig = z.infer<
  typeof controllerRuntimeConfigSchema
>;
export type DeviceControlConfig = z.infer<typeof deviceControlConfigSchema>;
export type LocalAutomationConfig = z.infer<typeof localAutomationConfigSchema>;
export type MemoryConfig = z.infer<typeof memoryConfigSchema>;
export type MemosConfig = z.infer<typeof memosConfigSchema>;
export type ControllerProvider = z.infer<typeof controllerProviderSchema>;
export type ControllerArtifact = z.infer<typeof controllerArtifactSchema>;
export type ArtifactsIndex = z.infer<typeof artifactsIndexSchema>;
export type CloudProfileEntry = z.infer<typeof cloudProfileEntrySchema>;
export type CloudProfilesFile = z.infer<typeof cloudProfilesFileSchema>;
