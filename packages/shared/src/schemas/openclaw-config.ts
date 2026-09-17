import { z } from "zod";

const providerSecretRefSchema = z.object({
  source: z.enum(["env", "file", "exec"]),
  provider: z.string().min(1),
  id: z.string().min(1),
});

const gatewayAuthSchema = z.object({
  mode: z.enum(["none", "token"]),
  token: z.string().optional(),
});

const gatewayReloadSchema = z.object({
  mode: z.enum(["off", "hot", "hybrid"]),
});

const controlUiSchema = z
  .object({
    root: z.string().optional(),
    allowedOrigins: z.array(z.string()).optional(),
    dangerouslyAllowHostHeaderOriginFallback: z.boolean().optional(),
  })
  .optional();

const gatewayToolsSchema = z
  .object({
    allow: z.array(z.string()).optional(),
    deny: z.array(z.string()).optional(),
  })
  .passthrough()
  .optional();

const gatewayConfigSchema = z
  .object({
    port: z.number().default(18789),
    mode: z.literal("local").default("local"),
    bind: z.enum(["loopback", "lan", "auto"]).default("lan"),
    auth: gatewayAuthSchema,
    reload: gatewayReloadSchema.default({ mode: "hybrid" }),
    controlUi: controlUiSchema,
    tools: gatewayToolsSchema,
  })
  .passthrough();

const agentModelSchema = z.union([
  z.string(),
  z.object({
    primary: z.string(),
    fallbacks: z.array(z.string()).optional(),
  }),
]);

const agentSchema = z
  .object({
    id: z.string(),
    name: z.string().optional(),
    default: z.boolean().optional(),
    workspace: z.string().optional(),
    model: agentModelSchema.optional(),
    skills: z.array(z.string()).optional(),
  })
  .passthrough();

const compactionMemoryFlushSchema = z
  .object({
    enabled: z.boolean().optional(),
    softThresholdTokens: z.number().optional(),
    forceFlushTranscriptBytes: z.union([z.number(), z.string()]).optional(),
    prompt: z.string().optional(),
    systemPrompt: z.string().optional(),
  })
  .passthrough();

const compactionQualityGuardSchema = z
  .object({
    enabled: z.boolean().optional(),
    maxRetries: z.number().optional(),
  })
  .passthrough();

const compactionSchema = z
  .object({
    mode: z.enum(["default", "safeguard"]).optional(),
    reserveTokens: z.number().optional(),
    keepRecentTokens: z.number().optional(),
    reserveTokensFloor: z.number().optional(),
    maxHistoryShare: z.number().optional(),
    recentTurnsPreserve: z.number().min(0).max(12).optional(),
    identifierPolicy: z.enum(["strict", "off", "custom"]).optional(),
    identifierInstructions: z.string().optional(),
    qualityGuard: compactionQualityGuardSchema.optional(),
    postCompactionSections: z.array(z.string()).optional(),
    memoryFlush: compactionMemoryFlushSchema.optional(),
  })
  .passthrough();

const memorySearchRemoteSchema = z
  .object({
    baseUrl: z.string().optional(),
    apiKey: z.union([z.string(), providerSecretRefSchema]).optional(),
    headers: z.record(z.string(), z.string()).optional(),
    nonBatchConcurrency: z.number().int().positive().optional(),
    batch: z
      .object({
        enabled: z.boolean().optional(),
        wait: z.boolean().optional(),
        concurrency: z.number().int().positive().optional(),
        pollIntervalMs: z.number().int().positive().optional(),
        timeoutMinutes: z.number().positive().optional(),
      })
      .optional(),
  })
  .passthrough();

const memorySearchSyncSchema = z
  .object({
    onSessionStart: z.boolean().optional(),
    onSearch: z.boolean().optional(),
    watch: z.boolean().optional(),
    watchDebounceMs: z.number().int().nonnegative().optional(),
    intervalMinutes: z.number().optional(),
    embeddingBatchTimeoutSeconds: z.number().positive().optional(),
    sessions: z
      .object({
        deltaBytes: z.number().int().nonnegative().optional(),
        deltaMessages: z.number().int().nonnegative().optional(),
        postCompactionForce: z.boolean().optional(),
      })
      .optional(),
  })
  .passthrough();

const memorySearchStoreSchema = z
  .object({
    driver: z.enum(["sqlite"]).optional(),
    fts: z
      .object({ tokenizer: z.enum(["unicode61", "trigram"]).optional() })
      .optional(),
    vector: z
      .object({
        enabled: z.boolean().optional(),
        extensionPath: z.string().optional(),
      })
      .optional(),
    cache: z
      .object({
        enabled: z.boolean().optional(),
        maxEntries: z.number().int().positive().optional(),
      })
      .optional(),
  })
  .passthrough();

const memorySearchChunkingSchema = z
  .object({
    tokens: z.number().optional(),
    overlap: z.number().optional(),
  })
  .passthrough();

const memorySearchQuerySchema = z
  .object({
    maxResults: z.number().optional(),
    minScore: z.number().optional(),
    hybrid: z
      .object({
        enabled: z.boolean().optional(),
        vectorWeight: z.number().optional(),
        textWeight: z.number().optional(),
        candidateMultiplier: z.number().optional(),
        mmr: z
          .object({
            enabled: z.boolean().optional(),
            lambda: z.number().optional(),
          })
          .optional(),
        temporalDecay: z
          .object({
            enabled: z.boolean().optional(),
            halfLifeDays: z.number().optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .passthrough();

const memorySearchSchema = z
  .object({
    enabled: z.boolean().optional(),
    sources: z.array(z.enum(["memory", "sessions"])).optional(),
    extraPaths: z.array(z.string()).optional(),
    experimental: z
      .object({ sessionMemory: z.boolean().optional() })
      .optional(),
    provider: z.string().min(1).optional(),
    fallback: z.string().min(1).optional(),
    model: z.string().optional(),
    remote: memorySearchRemoteSchema.optional(),
    local: z
      .object({
        modelPath: z.string().optional(),
        modelCacheDir: z.string().optional(),
        contextSize: z
          .union([z.number().int().positive(), z.literal("auto")])
          .optional(),
      })
      .optional(),
    sync: memorySearchSyncSchema.optional(),
    store: memorySearchStoreSchema.optional(),
    chunking: memorySearchChunkingSchema.optional(),
    query: memorySearchQuerySchema.optional(),
  })
  .passthrough();

const humanDelaySchema = z
  .object({
    mode: z.enum(["off", "natural", "custom"]).optional(),
    minMs: z.number().optional(),
    maxMs: z.number().optional(),
  })
  .passthrough();

const subagentsSchema = z
  .object({
    maxConcurrent: z.number().optional(),
    maxSpawnDepth: z.number().optional(),
    maxChildrenPerAgent: z.number().optional(),
    archiveAfterMinutes: z.number().optional(),
    model: agentModelSchema.optional(),
    thinking: z.string().optional(),
  })
  .passthrough();

const blockStreamingChunkSchema = z
  .object({
    minChars: z.number().optional(),
    maxChars: z.number().optional(),
    preferParagraph: z.boolean().optional(),
    preferNewline: z.boolean().optional(),
  })
  .passthrough();

const blockStreamingCoalesceSchema = z
  .object({
    idleMs: z.number().optional(),
  })
  .passthrough();

const agentsConfigSchema = z.object({
  defaults: z
    .object({
      // Same shape as a per-agent override: plain z.object() strips unknown
      // keys, so an inline `{ primary }` here silently dropped `fallbacks`
      // and left the defaults with no failover ladder.
      model: agentModelSchema.optional(),
      // Lower-cost model for short internal tasks (generated session/thread
      // titles). Falls back to the primary model when unset.
      utilityModel: z.string().optional(),
      compaction: compactionSchema.optional(),
      memorySearch: memorySearchSchema.optional(),
      // Thinking and verbosity
      thinkingDefault: z
        .enum(["off", "minimal", "low", "medium", "high", "xhigh", "adaptive"])
        .optional(),
      verboseDefault: z.enum(["off", "on", "full"]).optional(),
      elevatedDefault: z.enum(["off", "on", "ask", "full"]).optional(),
      // Streaming
      blockStreamingDefault: z.enum(["off", "on"]).optional(),
      blockStreamingBreak: z.enum(["text_end", "message_end"]).optional(),
      blockStreamingChunk: blockStreamingChunkSchema.optional(),
      blockStreamingCoalesce: blockStreamingCoalesceSchema.optional(),
      // Human delay
      humanDelay: humanDelaySchema.optional(),
      // Subagents
      subagents: subagentsSchema.optional(),
      // Context and bootstrap
      contextTokens: z.number().optional(),
      bootstrapMaxChars: z.number().optional(),
      userTimezone: z.string().optional(),
      timeFormat: z.enum(["12h", "24h"]).optional(),
      // Max concurrent
      maxConcurrent: z.number().optional(),
    })
    .passthrough()
    .optional(),
  list: z.array(agentSchema),
});

const slackAccountSchema = z
  .object({
    enabled: z.boolean().default(true),
    botToken: z.string(),
    signingSecret: z.string().optional(),
    appToken: z.string().optional(),
    mode: z.enum(["socket", "http"]).default("http"),
    webhookPath: z.string().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open"]).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    streaming: z
      .object({
        mode: z.enum(["off", "partial", "block", "progress"]).optional(),
        nativeTransport: z.boolean().optional(),
        progress: z
          .object({
            nativeTaskCards: z.boolean().optional(),
            render: z.enum(["text", "rich"]).optional(),
            toolProgress: z.boolean().optional(),
            commandText: z.enum(["raw", "status"]).optional(),
          })
          .passthrough()
          .optional(),
      })
      .passthrough()
      .optional(),
    replyToMode: z.enum(["off", "first", "all", "batched"]).optional(),
  })
  .passthrough();

const slackChannelSchema = z
  .object({
    mode: z.enum(["socket", "http"]).optional(),
    signingSecret: z.string().optional(),
    enabled: z.boolean().optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    requireMention: z.boolean().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    ackReaction: z.string().optional(),
    accounts: z.record(z.string(), slackAccountSchema),
  })
  .passthrough();

const discordAccountSchema = z.object({
  enabled: z.boolean().default(true),
  token: z.string(),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).default("open"),
  dmPolicy: z.enum(["pairing", "allowlist", "open"]).optional(),
  allowFrom: z.array(z.string()).optional(),
});

const discordChannelSchema = z.object({
  enabled: z.boolean().optional(),
  groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
  dmPolicy: z.enum(["pairing", "allowlist", "open"]).optional(),
  allowFrom: z.array(z.string()).optional(),
  accounts: z.record(z.string(), discordAccountSchema),
});

const feishuAccountSchema = z
  .object({
    enabled: z.boolean().default(true),
    appId: z.string(),
    appSecret: z.string(),
    connectionMode: z.enum(["websocket", "webhook"]).optional(),
    webhookPath: z.string().optional(),
    webhookPort: z.number().optional(),
    webhookHost: z.string().optional(),
    verificationToken: z.string().optional(),
    requireMention: z.boolean().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    streaming: z.boolean().optional(),
    renderMode: z.enum(["auto", "raw", "card"]).optional(),
    replyInThread: z.enum(["enabled", "disabled"]).optional(),
    mediaMaxMb: z.number().optional(),
    tts: z
      .object({
        auto: z.enum(["off", "always", "tagged", "inbound"]).optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const feishuChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    connectionMode: z.enum(["websocket", "webhook"]).optional(),
    streaming: z.boolean().optional(),
    renderMode: z.enum(["auto", "raw", "card"]).optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open"]).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    requireMention: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    accounts: z.record(z.string(), feishuAccountSchema),
  })
  .passthrough();

const telegramGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
  })
  .passthrough();

const telegramAccountSchema = z
  .object({
    enabled: z.boolean().default(true),
    botToken: z.string(),
  })
  .passthrough();

const telegramChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open"]).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    accounts: z.record(z.string(), telegramAccountSchema),
    groups: z.record(z.string(), telegramGroupSchema).optional(),
  })
  .passthrough();

const whatsappGroupSchema = z
  .object({
    requireMention: z.boolean().optional(),
  })
  .passthrough();

const whatsappAccountSchema = z
  .object({
    enabled: z.boolean().default(true),
    authDir: z.string().optional(),
    selfChatMode: z.boolean().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groups: z.record(z.string(), whatsappGroupSchema).optional(),
  })
  .passthrough();

const whatsappChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    selfChatMode: z.boolean().optional(),
    allowFrom: z.array(z.string()).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    groups: z.record(z.string(), whatsappGroupSchema).optional(),
    accounts: z.record(z.string(), whatsappAccountSchema).optional(),
  })
  .passthrough();

const qqbotChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    appId: z.string(),
    clientSecret: z.string(),
    dmPolicy: z.enum(["pairing", "allowlist", "open"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    historyLimit: z.number().optional(),
    markdownSupport: z.boolean().optional(),
  })
  .passthrough();

const dingtalkChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    clientId: z.string(),
    clientSecret: z.string(),
    gatewayToken: z.string().optional(),
    gatewayBaseUrl: z.string().optional(),
    dmPolicy: z.enum(["pairing", "allowlist", "open"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
  })
  .passthrough();

const wecomChannelSchema = z
  .object({
    enabled: z.boolean().optional(),
    botId: z.string(),
    secret: z.string(),
    dmPolicy: z.enum(["pairing", "allowlist", "open"]).optional(),
    allowFrom: z.array(z.string()).optional(),
    groupPolicy: z.enum(["open", "allowlist", "disabled"]).optional(),
    groupAllowFrom: z.array(z.string()).optional(),
    sendThinkingMessage: z.boolean().optional(),
  })
  .passthrough();

const channelsConfigSchema = z
  .object({
    slack: slackChannelSchema.optional(),
    discord: discordChannelSchema.optional(),
    feishu: feishuChannelSchema.optional(),
    "dingtalk-connector": dingtalkChannelSchema.optional(),
    wecom: wecomChannelSchema.optional(),
    telegram: telegramChannelSchema.optional(),
    whatsapp: whatsappChannelSchema.optional(),
    qqbot: qqbotChannelSchema.optional(),
  })
  .passthrough();

const bindingMatchSchema = z.object({
  channel: z.string(),
  accountId: z.string().optional(),
});

const bindingSchema = z.object({
  agentId: z.string(),
  match: bindingMatchSchema,
});

// Model provider configuration for LiteLLM / custom endpoints
const modelCompatSchema = z
  .object({
    supportsStore: z.boolean().optional(),
  })
  .passthrough();

const modelCostSchema = z.object({
  input: z.number(),
  output: z.number(),
  cacheRead: z.number().optional(),
  cacheWrite: z.number().optional(),
});

const modelEntrySchema = z.object({
  id: z.string(),
  name: z.string().optional(),
  reasoning: z.boolean().optional(),
  input: z.array(z.string()).optional(),
  cost: modelCostSchema.optional(),
  contextWindow: z.number().optional(),
  maxTokens: z.number().optional(),
  compat: modelCompatSchema.optional(),
});

const modelProviderSchema = z
  .object({
    baseUrl: z.string(),
    apiKey: z.union([z.string(), providerSecretRefSchema]).optional(),
    auth: z.enum(["api-key", "token", "oauth", "aws-sdk"]).optional(),
    api: z.string(),
    models: z.array(modelEntrySchema),
  })
  .passthrough();

const modelsConfigSchema = z.object({
  mode: z.enum(["merge", "replace"]).optional(),
  providers: z.record(z.string(), modelProviderSchema),
});

const commandsConfigSchema = z
  .object({
    native: z.enum(["auto", "off"]).optional(),
    nativeSkills: z.enum(["auto", "off"]).optional(),
    restart: z.boolean().optional(),
    ownerDisplay: z.enum(["raw", "friendly"]).optional(),
  })
  .passthrough();

const skillsLoadSchema = z
  .object({
    watch: z.boolean().optional(),
    watchDebounceMs: z.number().optional(),
    extraDirs: z.array(z.string()).optional(),
  })
  .passthrough();

const skillsConfigSchema = z
  .object({
    load: skillsLoadSchema.optional(),
  })
  .passthrough();

const toolsExecSchema = z
  .object({
    security: z.enum(["deny", "allowlist", "full"]).optional(),
    ask: z.enum(["off", "on-miss", "always"]).optional(),
    host: z.enum(["sandbox", "gateway", "node"]).optional(),
  })
  .passthrough();

const toolsWebSearchSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .passthrough();

const toolsWebFetchSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .passthrough();

const toolsWebSchema = z
  .object({
    search: toolsWebSearchSchema.optional(),
    fetch: toolsWebFetchSchema.optional(),
  })
  .passthrough();

const toolsConfigSchema = z
  .object({
    profile: z.enum(["minimal", "coding", "messaging", "full"]).optional(),
    exec: toolsExecSchema.optional(),
    web: toolsWebSchema.optional(),
  })
  .passthrough();

const cronConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .passthrough();

const diagnosticsOtelSchema = z
  .object({
    enabled: z.boolean().optional(),
    endpoint: z.string().optional(),
    serviceName: z.string().optional(),
    traces: z.boolean().optional(),
    metrics: z.boolean().optional(),
    logs: z.boolean().optional(),
    flushIntervalMs: z.number().optional(),
  })
  .passthrough();

const pluginEntrySchema = z
  .object({
    enabled: z.boolean().optional(),
  })
  .passthrough();

const pluginsConfigSchema = z
  .object({
    entries: z.record(z.string(), pluginEntrySchema).optional(),
    allow: z.array(z.string()).optional(),
  })
  .passthrough();

const hookConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    env: z.record(z.string(), z.string()).optional(),
  })
  .passthrough();

const internalHooksSchema = z
  .object({
    enabled: z.boolean().optional(),
    entries: z.record(z.string(), hookConfigSchema).optional(),
  })
  .passthrough();

const hooksConfigSchema = z
  .object({
    internal: internalHooksSchema.optional(),
  })
  .passthrough();

const diagnosticsConfigSchema = z
  .object({
    enabled: z.boolean().optional(),
    otel: diagnosticsOtelSchema.optional(),
    /** No-progress age before the stalled-session watchdog warns (default 2m). */
    stuckSessionWarnMs: z.number().int().positive().optional(),
    /** No-progress age before it aborts the run (default: 3x the warn value). */
    stuckSessionAbortMs: z.number().int().positive().optional(),
  })
  .passthrough();

const messagesConfigSchema = z
  .object({
    ackReaction: z.string().optional(),
    ackReactionScope: z
      .enum(["off", "none", "all", "direct", "group-all", "group-mentions"])
      .optional(),
    removeAckAfterReply: z.boolean().optional(),
  })
  .passthrough();

const sessionConfigSchema = z
  .object({
    dmScope: z
      .enum([
        "main",
        "per-peer",
        "per-channel-peer",
        "per-account-channel-peer",
      ])
      .optional(),
  })
  .passthrough();

/** OpenClaw self-update policy. `checkOnStart` gates the boot-time
 * `registry.npmjs.org/openclaw/latest` version fetch; `auto.enabled` gates
 * background auto-update installs. Nexu ships a version-pinned bundled OpenClaw
 * (slimclaw + desktop auto-updater), so both stay off. */
const updateConfigSchema = z
  .object({
    checkOnStart: z.boolean().optional(),
    auto: z
      .object({ enabled: z.boolean().optional() })
      .passthrough()
      .optional(),
  })
  .passthrough();

const mcpConfigSchema = z
  .object({
    servers: z.record(z.string(), z.record(z.unknown())),
  })
  .passthrough();

export const openclawConfigSchema = z.object({
  gateway: gatewayConfigSchema,
  models: modelsConfigSchema.optional(),
  tools: toolsConfigSchema.optional(),
  skills: skillsConfigSchema.optional(),
  agents: agentsConfigSchema,
  channels: channelsConfigSchema,
  bindings: z.array(bindingSchema),
  commands: commandsConfigSchema.optional(),
  session: sessionConfigSchema.optional(),
  cron: cronConfigSchema.optional(),
  messages: messagesConfigSchema.optional(),
  diagnostics: diagnosticsConfigSchema.optional(),
  plugins: pluginsConfigSchema.optional(),
  hooks: hooksConfigSchema.optional(),
  update: updateConfigSchema.optional(),
  mcp: mcpConfigSchema.optional(),
});

export type OpenClawConfig = z.infer<typeof openclawConfigSchema>;
export type AgentConfig = z.infer<typeof agentSchema>;
export type SlackAccountConfig = z.infer<typeof slackAccountSchema>;
export type DiscordAccountConfig = z.infer<typeof discordAccountSchema>;
export type FeishuAccountConfig = z.infer<typeof feishuAccountSchema>;
export type TelegramAccountConfig = z.infer<typeof telegramAccountSchema>;
export type WhatsappAccountConfig = z.infer<typeof whatsappAccountSchema>;
export type BindingConfig = z.infer<typeof bindingSchema>;
