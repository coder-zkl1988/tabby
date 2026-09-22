import { existsSync } from "node:fs";
import path from "node:path";
import type { OpenClawConfig } from "@nexu/shared";
import { openclawConfigSchema } from "@nexu/shared";
import type { ControllerEnv } from "../app/env.js";
import type { OAuthConnectionState } from "../runtime/openclaw-auth-profiles-store.js";
import type { NexuConfig } from "../store/schemas.js";
import {
  compileChannelBindings,
  compileChannelsConfig,
  resolveManagedChannelPluginId,
} from "./channel-binding-compiler.js";
import { resolveDefaultBotFromConfig } from "./default-bot.js";
import {
  buildProviderRuntimeModelId,
  buildProviderRuntimeModelRef,
  findProviderDescriptorForModelRef,
  listModelProviderRuntimeDescriptors,
  resolveModelProviderApiKey,
} from "./model-provider-runtime.js";
import { normalizeProviderBaseUrl } from "./provider-base-url.js";

/**
 * Known model capabilities for popular providers.
 * Keys are matched case-insensitively against the model ID (without provider prefix).
 * When a match is found, the contextWindow and maxTokens values override the defaults.
 */
const MODEL_CAPABILITIES: Record<
  string,
  { contextWindow: number; maxTokens?: number; reasoning?: boolean }
> = {
  // DeepSeek V4
  "deepseek-v4-pro": { contextWindow: 1048576, maxTokens: 384000 },
  "deepseek-v4-flash": { contextWindow: 1048576, maxTokens: 384000 },
  "deepseek-chat": { contextWindow: 1048576, maxTokens: 384000 },
  "deepseek-reasoner": { contextWindow: 1048576, maxTokens: 384000 },

  // OpenAI GPT
  "gpt-5.4": { contextWindow: 1048576, maxTokens: 32768 },
  "gpt-5.4-mini": { contextWindow: 1048576, maxTokens: 32768 },
  "gpt-4.1": { contextWindow: 1048576, maxTokens: 32768 },
  "gpt-4.1-mini": { contextWindow: 1048576, maxTokens: 32768 },
  "gpt-4.1-nano": { contextWindow: 1048576, maxTokens: 32768 },
  "o4-mini": { contextWindow: 200000, maxTokens: 100000, reasoning: true },
  o3: { contextWindow: 200000, maxTokens: 100000, reasoning: true },
  "o3-mini": { contextWindow: 200000, maxTokens: 100000, reasoning: true },

  // Anthropic Claude
  "claude-sonnet-4-20250514": { contextWindow: 200000, maxTokens: 64000 },
  "claude-opus-8-20250514": { contextWindow: 200000, maxTokens: 32000 },

  // Google Gemini
  "gemini-3-flash-preview": { contextWindow: 1048576, maxTokens: 65536 },
  "gemini-3-pro-preview": { contextWindow: 1048576, maxTokens: 65536 },

  // Groq
  "llama-4-scout-17b-16e-instruct": { contextWindow: 1048576, maxTokens: 8192 },
  "llama-4-maverick-17b-128e-instruct": {
    contextWindow: 1048576,
    maxTokens: 8192,
  },

  // Zhipu GLM
  "glm-5.3": { contextWindow: 1048576, maxTokens: 131072 }, // official docs: 1M ctx / 128K out; BYOK discovery persists the same window
  "glm-5.3-flash": { contextWindow: 1048576, maxTokens: 131072 },

  // StepFun
  "step-3.7-flash": { contextWindow: 245760, maxTokens: 8192 }, // confirmed 256,000 ctx (same upstream as tabby-phone), with margin

  // Tabby Official aliases → underlying-model limits. Without these the aliases
  // fall back to the compiler default (contextWindow 200000), which mismatches
  // the real window and causes context-overflow errors. Comment = the gateway's
  // underlying model and source. contextWindow is set at or just under the
  // documented cap (never above it — overshooting is what causes the overflow
  // error; undershooting only triggers compaction a little earlier, which is
  // safe). Values for unknown upstreams (stepfun) and the auto router are set
  // conservatively so they never overflow; raise once confirmed.
  // gpt-5.5/5.4/5.4-mini are accessed through the Codex subscription (see the
  // `openai: "openai-codex"` OAuth mapping below), NOT the raw pay-per-token
  // API — Codex enforces its own product-level context window, which is
  // smaller than the API's published 1,050,000. Use the Codex window, not the
  // API one, or these overflow exactly like tabby-mini did before.
  "tabby-ultra": { contextWindow: 258000, maxTokens: 128000 }, // gpt-5.5 via Codex — effective product window capped at 258K
  "tabby-pro": { contextWindow: 1048576, maxTokens: 131072 }, // glm-5.3 (gateway re-routed 2026-09; was gpt-5.4 via Codex) — official docs: 1M ctx / 128K out
  "tabby-plus": { contextWindow: 1048576, maxTokens: 131072 }, // glm-5.3-flash — official docs: 1M ctx / 128K out
  "tabby-mini": { contextWindow: 258000, maxTokens: 32768 }, // gpt-5.4-mini via Codex — effective product window capped at 258K
  "tabby-fast": { contextWindow: 983040, maxTokens: 384000 }, // deepseek-v4-pro — official docs: 1,000,000 ctx (was wrongly 1,048,576, slightly over cap)
  "tabby-free": { contextWindow: 240000, maxTokens: 8192 }, // agnes-2.0-flash — docs conflict (512K vs 256K); using the more conservative 256K with margin
  "tabby-phone": { contextWindow: 245760, maxTokens: 8192 }, // stepfun-3.7-flash — confirmed 256,000 ctx, with margin
  "tabby-auto": { contextWindow: 131072, maxTokens: 8192 }, // auto router → smallest routable window (unconfirmed — conservative placeholder)
};

/** Look up known model capabilities by ID (case-insensitive, stripped of provider prefix). */
function lookupModelCapabilities(modelId: string): {
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
} {
  // Try exact match first
  const lower = modelId.toLowerCase();
  const exact = MODEL_CAPABILITIES[lower];
  if (exact) return exact;

  // Try matching the tail after the last slash (e.g. "deepseek/deepseek-v4-pro" → "deepseek-v4-pro")
  const tail = lower.split("/").pop() ?? lower;
  if (tail !== lower) {
    const match = MODEL_CAPABILITIES[tail];
    if (match) return match;
  }

  return {};
}

export type { OAuthConnectionState };

const LINK_PROVIDER_HEADERS = {
  "User-Agent": "Mozilla/5.0",
};

const EMPTY_OAUTH_CONNECTION_STATE: OAuthConnectionState = {
  connectedProviderIds: [],
};

const OAUTH_PROVIDER_MAP: Record<string, string> = {
  openai: "openai-codex",
};

/**
 * Derive the OpenClaw control-UI asset root from OPENCLAW_EXTENSIONS_DIR.
 *
 * The real OpenClaw package layout keeps both directories under dist/
 * (`<pkg>/dist/extensions`, `<pkg>/dist/control-ui`), which is what the
 * packaged launchd path passes. Some launchers still pass the legacy
 * `<pkg>/extensions` form, so handle both instead of blindly appending
 * "dist" (which produced a broken `<pkg>/dist/dist/control-ui` and a 503
 * from the control UI in packaged builds).
 */
export function resolveControlUiRoot(builtinExtensionsDir: string): string {
  const parentDir = path.dirname(builtinExtensionsDir);
  return path.basename(parentDir) === "dist"
    ? path.join(parentDir, "control-ui")
    : path.join(parentDir, "dist", "control-ui");
}

function isDesktopCloudConfig(value: unknown): value is {
  linkUrl: string;
  apiKey: string;
  models: Array<{ id: string; name: string; provider?: string }>;
} {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.linkUrl === "string" &&
    typeof candidate.apiKey === "string" &&
    Array.isArray(candidate.models)
  );
}

function getDesktopSelectedModel(config: NexuConfig): string | null {
  const selectedModelId = config.desktop.selectedModelId;
  return typeof selectedModelId === "string" && selectedModelId.length > 0
    ? selectedModelId
    : null;
}

const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 8192;

function buildModelEntry(
  id: string,
  name?: string,
  overrides?: { contextWindow?: number; maxTokens?: number },
) {
  const known = lookupModelCapabilities(id);
  return {
    id,
    name: name ?? id,
    reasoning: known.reasoning ?? false,
    input: ["text", "image"],
    cost: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    },
    contextWindow:
      (overrides?.contextWindow && overrides.contextWindow > 0
        ? overrides.contextWindow
        : known.contextWindow) ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens:
      (overrides?.maxTokens && overrides.maxTokens > 0
        ? overrides.maxTokens
        : known.maxTokens) ?? DEFAULT_MAX_TOKENS,
    compat: {
      supportsStore: false,
    },
  };
}

function collectLitellmModelIds(config: NexuConfig): string[] {
  const selectedModelId = getDesktopSelectedModel(config);
  const candidateIds = [
    ...config.bots.map((bot) => bot.modelId),
    config.runtime.defaultModelId,
    selectedModelId,
  ];

  return [...new Set(candidateIds)]
    .filter(
      (value): value is string => typeof value === "string" && value.length > 0,
    )
    .map((value) => value.replace(/^litellm\//, ""))
    .filter(
      (value) => !value.startsWith("link/") && !value.startsWith("debug/"),
    );
}

function compileModelsConfig(
  config: NexuConfig,
  env: ControllerEnv,
): OpenClawConfig["models"] {
  const providers: NonNullable<OpenClawConfig["models"]>["providers"] = {};

  if (env.litellmBaseUrl && env.litellmApiKey) {
    providers.litellm = {
      baseUrl: env.litellmBaseUrl,
      apiKey: env.litellmApiKey,
      api: "openai-completions",
      models: collectLitellmModelIds(config).map((modelId) =>
        buildModelEntry(modelId),
      ),
    };
  }

  for (const descriptor of listModelProviderRuntimeDescriptors(config)) {
    if (!descriptor.provider.enabled) {
      continue;
    }

    const apiKey = resolveModelProviderApiKey(descriptor);
    if (
      apiKey === null &&
      descriptor.provider.auth !== "oauth" &&
      descriptor.provider.auth !== "aws-sdk"
    ) {
      continue;
    }

    // Keep apiKey when it's a non-empty string or a secret-ref object; only
    // drop it when null/undefined or an empty string. Emitting apiKey:""
    // caused OpenClaw to reject the provider (and caused relogin to fail
    // with "Unknown model: link/...").
    const hasUsableApiKey =
      apiKey !== null && !(typeof apiKey === "string" && apiKey.length === 0);
    providers[descriptor.runtimeKey] = {
      baseUrl: descriptor.provider.baseUrl,
      ...(hasUsableApiKey ? { apiKey } : {}),
      ...(descriptor.provider.auth === "aws-sdk"
        ? { auth: "aws-sdk" as const }
        : {}),
      api: descriptor.apiKind,
      ...(descriptor.authHeader ? { authHeader: true } : {}),
      ...(descriptor.defaultHeaders
        ? { headers: descriptor.defaultHeaders }
        : {}),
      models: descriptor.provider.models.map((model) =>
        buildModelEntry(
          buildProviderRuntimeModelId(descriptor, model.id),
          model.name,
          { contextWindow: model.contextWindow, maxTokens: model.maxTokens },
        ),
      ),
    };
  }

  const desktopCloud = isDesktopCloudConfig(config.desktop.cloud)
    ? config.desktop.cloud
    : null;
  if (desktopCloud && desktopCloud.models.length > 0) {
    providers.link = {
      baseUrl: `${normalizeProviderBaseUrl(desktopCloud.linkUrl) ?? desktopCloud.linkUrl}/v1`,
      apiKey: desktopCloud.apiKey,
      api: "openai-completions",
      headers: LINK_PROVIDER_HEADERS,
      models: desktopCloud.models.map((model) =>
        buildModelEntry(model.id, model.name),
      ),
    };
  }

  return Object.keys(providers).length > 0
    ? {
        mode: "merge",
        providers,
      }
    : undefined;
}

export function resolveModelId(
  config: NexuConfig,
  env: ControllerEnv,
  rawModelId: string,
  oauthState: OAuthConnectionState = EMPTY_OAUTH_CONNECTION_STATE,
): string {
  if (rawModelId.startsWith("litellm/") || rawModelId.startsWith("link/")) {
    return rawModelId;
  }

  const descriptors = listModelProviderRuntimeDescriptors(config).filter(
    (descriptor) => descriptor.provider.enabled,
  );
  const matchedDescriptor = findProviderDescriptorForModelRef(
    descriptors,
    rawModelId,
  );

  if (matchedDescriptor) {
    const oauthTarget =
      OAUTH_PROVIDER_MAP[matchedDescriptor.descriptor.providerId];
    if (
      oauthTarget &&
      oauthState.connectedProviderIds.includes(
        matchedDescriptor.descriptor.providerId,
      )
    ) {
      return `${oauthTarget}/${matchedDescriptor.modelId}`;
    }

    return buildProviderRuntimeModelRef(
      matchedDescriptor.descriptor,
      matchedDescriptor.modelId,
    );
  }

  if (isDesktopCloudConfig(config.desktop.cloud)) {
    const cloudModels = config.desktop.cloud.models;
    const slashIndex = rawModelId.indexOf("/");
    const modelSuffix =
      slashIndex > 0 ? rawModelId.slice(slashIndex + 1) : null;
    // Only use Link fallback if the model actually exists in Link's model list
    if (cloudModels.some((m) => m.id === rawModelId)) {
      return `link/${rawModelId}`;
    }
    if (
      modelSuffix &&
      cloudModels.some((m) => m.id === modelSuffix || m.name === modelSuffix)
    ) {
      return `link/${modelSuffix}`;
    }
  }

  if (env.litellmBaseUrl && env.litellmApiKey) {
    return `litellm/${rawModelId}`;
  }

  return rawModelId;
}

/**
 * Native sub-agent tools added to delegation-capable chat bots. The default tool
 * profile may not expose these, so we add them explicitly (see OpenClaw
 * docs/tools/subagents.md). Spiked working in the live runtime 2026-06-30.
 */
const SUBAGENT_DELEGATION_TOOLS = [
  "sessions_spawn",
  "sessions_yield",
  "subagents",
];

/**
 * Workboard's worker-completion protocol tools. Without these, a Workboard
 * dispatch worker's LLM turn finishes correctly but has no way to signal it —
 * the card sits in "running" forever even though the model already answered.
 * Verified live 2026-07-01: a worker without these tools replied correctly in
 * plain text instead of calling workboard_complete, per buildWorkerPrompt's
 * "Heartbeat with workboard_heartbeat ... call workboard_complete ... If
 * blocked, call workboard_block" instructions.
 */
const WORKBOARD_WORKER_TOOLS = [
  "workboard_heartbeat",
  "workboard_complete",
  "workboard_block",
];

// Embedded-browser tools, registered by the nexu-browser runtime plugin. These
// are Nexu's own — they drive the browser panel inside the desktop app, not the
// user's Chrome. Exported so tests can assert this stays in sync with the
// independent allowlist inside static/runtime-plugins/nexu-toolcall-guard,
// which is what stops an external channel from reaching them.
export const EMBEDDED_BROWSER_TOOLS = [
  "browser_click",
  "browser_hover",
  "browser_navigate",
  "browser_open",
  "browser_press",
  "browser_screenshot",
  "browser_scroll",
  "browser_select",
  "browser_snapshot",
  "browser_type",
];
// Exported so tests can assert this stays in sync with the independent
// allowlist inside static/runtime-plugins/nexu-toolcall-guard. The two lists
// are enforced at different layers (MCP tool filter vs. before_tool_call gate)
// and drift between them is either a silent capability gap or a dead entry.
export const CUA_TOOL_FILTER = [
  "check_permissions",
  "get_accessibility_tree",
  "get_cursor_position",
  "get_desktop_state",
  "get_screen_size",
  "get_session_state",
  "get_window_state",
  "list_apps",
  "list_windows",
  "click",
  "double_click",
  "right_click",
  "drag",
  "move_cursor",
  "scroll",
  "type_text",
  "press_key",
  "hotkey",
  "set_value",
  "launch_app",
  "start_session",
  "end_session",
  "escalate_session",
];

function isLocalAutomationPreviewEnabled(env: ControllerEnv): boolean {
  return env.localAutomationPreviewEnabled === true;
}

function compileAgentEntries(
  config: NexuConfig,
  env: ControllerEnv,
  oauthState: OAuthConnectionState,
  installedSkillSlugs?: readonly string[],
  workspaceSkillsByAgent?: ReadonlyMap<string, readonly string[]>,
): OpenClawConfig["agents"]["entries"] {
  const browserEnabled =
    isLocalAutomationPreviewEnabled(env) &&
    config.localAutomation?.browser.enabled === true;
  const sharedSlugs = [...(installedSkillSlugs ?? [])].sort((left, right) =>
    left.localeCompare(right),
  );

  return Object.fromEntries(
    config.bots
      .filter((bot) => bot.status === "active")
      .sort((left, right) => left.slug.localeCompare(right.slug))
      .map((bot) => {
        const workspaceSlugs = [
          ...(workspaceSkillsByAgent?.get(bot.id) ?? []),
        ].sort((left, right) => left.localeCompare(right));
        const merged = Array.from(
          new Set([...sharedSlugs, ...workspaceSlugs]),
        ).sort((left, right) => left.localeCompare(right));

        // Chat assistants (not installed experts) can delegate one turn to an
        // expert bot via native sub-agents (in-chat auto-routing). OpenClaw's
        // sub-agent tool policy strips these tools from spawned children, so a
        // delegated expert cannot recurse. See
        // specs/design-docs/2026-06-30-in-chat-expert-auto-route.md.
        return [
          bot.id,
          {
            name: bot.name,
            workspace: `${env.openclawStateDir}/agents/${bot.id}`,
            model: bot.modelId
              ? {
                  primary: resolveModelId(config, env, bot.modelId, oauthState),
                }
              : undefined,
            ...(merged.length > 0 ? { skills: merged } : {}),
            tools: {
              alsoAllow: [
                ...SUBAGENT_DELEGATION_TOOLS,
                ...WORKBOARD_WORKER_TOOLS,
                ...(browserEnabled ? EMBEDDED_BROWSER_TOOLS : []),
              ],
            },
            subagents: { allowAgents: ["*"] },
          },
        ];
      }),
  );
}

/** Key for the MemOS Cloud token inside the encrypted `secrets` table. */
export const MEMOS_API_KEY_SECRET = "memos:apiKey";

/**
 * Does this cloud model id denote a realtime voice model?
 *
 * Tabby cloud fronts every capability under its own name — `tabby-video`,
 * `tabby-image-pro`, `tabby-phone` — and realtime voice is `tabby-audio`,
 * regardless of which vendor is behind it. A direct-to-provider deployment
 * instead carries the vendor's own id, and StepFun names those `*realtime*`.
 * Accept both, and keep the cloud side an exact set so a future sibling such
 * as `tabby-audio-tts` is not mistaken for a realtime session.
 */
const CLOUD_REALTIME_VOICE_MODEL_IDS = new Set(["tabby-audio"]);

function isRealtimeVoiceModelId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return (
    CLOUD_REALTIME_VOICE_MODEL_IDS.has(normalized) ||
    normalized.includes("realtime")
  );
}

/**
 * Prefer an enabled official StepFun provider with a configured realtime model.
 * Its realtime endpoint is independent of the REST/coding-plan base path.
 * Otherwise retain the Tabby cloud realtime route, when available.
 */
function compileStepfunRealtimeConfig(
  config: NexuConfig,
): { apiKey: string; url: string; model: string } | null {
  for (const descriptor of listModelProviderRuntimeDescriptors(config)) {
    if (descriptor.providerId !== "stepfun" || !descriptor.provider.enabled) {
      continue;
    }

    const apiKey = resolveModelProviderApiKey(descriptor);
    // The realtime plugin accepts concrete keys, not OpenClaw SecretRefs.
    if (typeof apiKey !== "string" || apiKey.trim().length === 0) continue;

    let baseUrl: URL;
    try {
      baseUrl = new URL(descriptor.provider.baseUrl);
    } catch {
      continue;
    }
    // Never redirect credentials configured for a custom proxy to StepFun.
    if (
      baseUrl.protocol !== "https:" ||
      !["api.stepfun.com", "api.stepfun.ai"].includes(baseUrl.hostname) ||
      baseUrl.port !== "" ||
      baseUrl.username ||
      baseUrl.password
    ) {
      continue;
    }

    const realtimeModel = descriptor.provider.models.find((model) => {
      const id = model.id.trim().toLowerCase();
      return /^stepaudio.*realtime/.test(id) && !id.includes("tts");
    });
    if (!realtimeModel) continue;

    const url = new URL("/v1/realtime", baseUrl.origin);
    url.protocol = "wss:";
    return { apiKey: apiKey.trim(), url: url.href, model: realtimeModel.id };
  }

  const cloud = isDesktopCloudConfig(config.desktop.cloud)
    ? config.desktop.cloud
    : null;
  if (!cloud || !cloud.apiKey) return null;

  const realtimeModel = cloud.models.find((model) =>
    isRealtimeVoiceModelId(model.id),
  );
  if (!realtimeModel) return null;

  const base = normalizeProviderBaseUrl(cloud.linkUrl) ?? cloud.linkUrl;
  const url = `${base.replace(/^http/, "ws")}/v1/realtime`;
  return { apiKey: cloud.apiKey, url, model: realtimeModel.id };
}

function compilePlugins(
  config: NexuConfig,
  env: ControllerEnv,
  hasTeams: boolean,
): OpenClawConfig["plugins"] {
  const stepfunRealtime = compileStepfunRealtimeConfig(config);
  // Exact session keys whose runs may use the embedded browser even though
  // they are channel-shaped: the paired owner's Feishu DMs. Handed to BOTH
  // browser-facing plugins — the toolcall guard and nexu-browser keep
  // independent fail-closed copies of this decision, so the whitelist has to
  // reach each of them or the layer left behind blocks what the other allows.
  const browserOwnerSessions = config.channels
    .filter(
      (channel) =>
        channel.channelType === "feishu" && channel.status === "connected",
    )
    .flatMap((channel) =>
      (channel.feishuPermissions?.browserOwnerIds ?? []).map(
        (openId) => `agent:${channel.botId}:direct:${openId}`,
      ),
    );

  const modelProviderDescriptors = listModelProviderRuntimeDescriptors(config);
  const resolvedMiniMaxOauth = modelProviderDescriptors.some(
    (descriptor) =>
      descriptor.providerId === "minimax" &&
      descriptor.provider.enabled &&
      descriptor.provider.auth === "oauth" &&
      descriptor.legacyOauthCredential !== null,
  );
  const bedrockDiscovery = config.models.bedrockDiscovery;
  const resolvedAmazonBedrock =
    bedrockDiscovery?.enabled === true ||
    modelProviderDescriptors.some(
      (descriptor) =>
        descriptor.providerId === "amazon-bedrock" &&
        descriptor.provider.enabled,
    );

  const connectedPluginIds = [
    ...new Set(
      config.channels
        .filter((channel) => channel.status === "connected")
        .map((channel) => resolveManagedChannelPluginId(channel.channelType))
        .filter((pluginId): pluginId is string => pluginId !== null),
    ),
  ];
  const analyticsEnabled = config.desktop.analyticsEnabled !== false;
  const deviceControlEnabled = config.deviceControl.enabled;
  // Same shape as `config.memory` above: callers (and every compiler test
  // fixture) predate this field, so treat it as absent rather than required.
  const memosConfig = config.memos ?? {
    enabled: false,
    userId: "tabby-user",
    memoryLimitNumber: 9,
    preferenceLimitNumber: 6,
    relativity: 0.4,
  };
  const memosApiKey = config.secrets[MEMOS_API_KEY_SECRET] ?? "";
  // No key means no plugin. It would otherwise load, fail every call, and log
  // nothing on the success path, so a missing key would look like working
  // memory that simply never recalls anything.
  const memosEnabled = memosConfig.enabled && memosApiKey.length > 0;

  return {
    load: {
      paths: [env.openclawExtensionsDir],
    },
    // Deliberately omit both `allow` and `deny`. OpenClaw then discovers all
    // installed plugins by default, while `entries` below remains the source
    // of truth for Nexu-managed plugin settings and explicit enablement.
    entries: {
      ...(memosEnabled
        ? {
            "memos-cloud-openclaw-plugin": {
              enabled: true,
              // The plugin reads the conversation to build its recall query
              // and to capture the turn; without this OpenClaw blocks the
              // hook at registration.
              hooks: { allowConversationAccess: true },
              config: {
                apiKey: memosApiKey,
                userId: memosConfig.userId,
                // Pinned, not exposed. See memosConfigSchema.
                multiAgentMode: true,
                recallGlobal: true,
                memoryLimitNumber: memosConfig.memoryLimitNumber,
                preferenceLimitNumber: memosConfig.preferenceLimitNumber,
                relativity: memosConfig.relativity,
              },
            },
          }
        : {}),
      ...(stepfunRealtime
        ? {
            "nexu-stepfun-realtime": {
              enabled: true,
              config: stepfunRealtime,
            },
          }
        : {}),
      ...(connectedPluginIds.includes("openclaw-lark")
        ? {
            "openclaw-lark": {
              enabled: true,
            },
          }
        : {}),
      ...(connectedPluginIds.includes("openclaw-weixin")
        ? {
            "openclaw-weixin": {
              enabled: true,
            },
          }
        : {}),
      ...(connectedPluginIds.includes("dingtalk-connector")
        ? {
            "dingtalk-connector": {
              enabled: true,
            },
          }
        : {}),
      ...(connectedPluginIds.includes("wecom")
        ? {
            wecom: {
              enabled: true,
            },
          }
        : {}),
      ...(connectedPluginIds.includes("openclaw-qqbot")
        ? {
            "openclaw-qqbot": {
              enabled: true,
            },
          }
        : {}),
      "nexu-runtime-model": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
      },
      "nexu-platform-bootstrap": {
        enabled: true,
      },
      "langfuse-tracer": {
        enabled: analyticsEnabled,
      },
      "nexu-credit-guard": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
      },
      "nexu-a2ui": {
        enabled: true,
      },
      "find-expert": {
        enabled: true,
        config: {
          // The plugin runs in the OpenClaw process and reaches the controller
          // on loopback to read the expert catalog + trigger installs.
          controllerUrl: `http://127.0.0.1:${env.port}`,
        },
      },
      "nexu-team": {
        enabled: true,
        config: {
          // Same loopback pattern as find-expert: the plugin resolves the
          // caller's team by leadBotId and drives the team board engine.
          controllerUrl: `http://127.0.0.1:${env.port}`,
        },
      },
      "nexu-canvas": {
        enabled: true,
        config: {
          // Same loopback pattern: canvas_read GETs the canvas mirror the web
          // frontend pushes. canvas_op is a pure courier and needs no URL.
          controllerUrl: `http://127.0.0.1:${env.port}`,
        },
      },
      // OpenClaw bundles its own `browser` tool, which drives a real Chrome —
      // including a `user` profile that attaches to the user's own signed-in
      // session. Nexu deliberately dropped that capability when it built
      // nexu-browser (see the header of static/runtime-plugins/nexu-browser),
      // but leaving the bundled plugin on silently reinstated it: the agent
      // saw both tool sets, preferred the richer bundled one, and browsed in
      // Chrome instead of the panel the user watches. Disabling the plugin
      // removes the CLI, gateway method, agent tool, and control service as
      // one unit, leaving nexu-browser as the only browser surface.
      browser: {
        enabled: false,
      },
      "nexu-browser": {
        enabled: true,
        config: {
          // Same loopback pattern: every tool POSTs the command here and the
          // controller relays it to the desktop browser panel.
          controllerUrl: `http://127.0.0.1:${env.port}`,
          browserOwnerSessions,
        },
        hooks: {
          // OpenClaw gates `agent_end` behind this flag for non-bundled
          // plugins; without it the hook is silently blocked at registration.
          // The plugin uses agent_end only for ctx.sessionKey — the run-ended
          // signal that lets the desktop release the browser panel's agent
          // pin. It does not read the conversation messages the flag exposes.
          allowConversationAccess: true,
        },
      },
      "nexu-toolcall-guard": {
        enabled: true,
        hooks: {
          allowConversationAccess: true,
        },
        // openclaw.json is written only by the controller and is itself fenced,
        // so it is the one channel that can hand the guard its policy without
        // being forgeable by a tool call.
        config: {
          controllerUrl: `http://127.0.0.1:${env.port}`,
          fence: {
            stateDir: env.openclawStateDir,
            nexuHome: env.nexuHomeDir,
          },
          // Per-bot escape hatch. Only bots that opted out of a default are
          // emitted, so the common case stays a small object. A bot record
          // without the field is read as fully restricted rather than throwing:
          // a compiler that crashes here leaves the runtime with no config at
          // all, which is a worse outcome than a conservative default.
          hostExecution: Object.fromEntries(
            config.bots
              .filter(
                (bot) =>
                  bot.hostExecution?.channels === "host" ||
                  bot.hostExecution?.automations === "host",
              )
              .map((bot) => [bot.id, bot.hostExecution]),
          ),
          // Compiled to full keys (not bare open_ids) so the guard does a
          // plain string match and a group/forked session can never qualify.
          browserOwnerSessions,
        },
      },
      ...(hasTeams
        ? {
            workboard: {
              enabled: true,
            },
          }
        : {}),
      ...(resolvedMiniMaxOauth
        ? {
            "minimax-portal-auth": {
              enabled: true,
            },
          }
        : {}),
      ...(resolvedAmazonBedrock
        ? {
            "amazon-bedrock": {
              enabled: true,
              ...(bedrockDiscovery
                ? { config: { discovery: bedrockDiscovery } }
                : {}),
            },
          }
        : {}),
      ...(deviceControlEnabled
        ? {
            "tabby-control": {
              enabled: true,
              config: {
                wsPort: config.deviceControl.wsPort,
                rpcPort: config.deviceControl.rpcPort,
              },
            },
          }
        : {}),
    },
  };
}

/**
 * Image, video and embedding entries live on the same relay provider as the
 * chat models but do not share its API surface, so they are never valid
 * failover targets. Matched on the id because that is all the catalog carries.
 */
const NON_CHAT_MODEL_ID = /(^|[/-])(image|video|embedding|bge|reranker)/i;

/**
 * OpenClaw picks failover targets from `model.fallbacks`. Nexu compiles the
 * Tabby relay as a single provider, so without a ladder one dead upstream
 * channel fails every agent outright — the runtime logs that as
 * "All models failed (1)". Offer the relay's other chat models, in the order
 * it declares them, so an outage degrades instead of failing the run.
 *
 * Only ever within the relay: a BYOK or OAuth primary must not silently fail
 * over to a different vendor's billing and data path.
 */
function collectModelFallbacks(
  config: NexuConfig,
  env: ControllerEnv,
  primaryModelRef: string,
  oauthState: OAuthConnectionState,
): string[] {
  if (!primaryModelRef.startsWith("link/")) return [];
  const cloud = isDesktopCloudConfig(config.desktop.cloud)
    ? config.desktop.cloud
    : null;
  if (!cloud) return [];
  const fallbacks: string[] = [];
  for (const model of cloud.models) {
    if (NON_CHAT_MODEL_ID.test(model.id)) continue;
    const ref = resolveModelId(config, env, model.id, oauthState);
    if (ref === primaryModelRef || fallbacks.includes(ref)) continue;
    fallbacks.push(ref);
  }
  return fallbacks;
}

export function compileOpenClawConfig(
  config: NexuConfig,
  env: ControllerEnv,
  oauthState: OAuthConnectionState = EMPTY_OAUTH_CONNECTION_STATE,
  installedSkillSlugs?: readonly string[],
  workspaceSkillsByAgent?: ReadonlyMap<string, readonly string[]>,
  hasTeams = false,
): OpenClawConfig {
  const disableMdnsDiscovery = process.env.CI === "true";
  const activeBots = config.bots.filter((bot) => bot.status === "active");
  const defaultBot = resolveDefaultBotFromConfig(config);
  // agents.defaults.model is what every bot without its own binding runs on,
  // so it has to be the configured default. This once read the first active
  // bot first, which only worked because changing the default rewrote every
  // bot: with per-bot bindings that order would let whichever bot happens to
  // sort first dictate the default for all the others. The first bot's model
  // stays as a last resort for configs that never recorded a default.
  const firstBotModel = activeBots.find((bot) => bot.modelId)?.modelId ?? null;
  const defaultModelId = resolveModelId(
    config,
    env,
    config.runtime.defaultModelId ||
      getDesktopSelectedModel(config) ||
      firstBotModel ||
      "",
    oauthState,
  );
  const modelFallbacks = collectModelFallbacks(
    config,
    env,
    defaultModelId,
    oauthState,
  );
  const utilityModelId = config.runtime.utilityModelId
    ? resolveModelId(config, env, config.runtime.utilityModelId, oauthState)
    : null;
  const memoryConfig = config.memory ?? {
    enabled: true,
    sources: ["memory" as const],
    extraPaths: [],
    syncIntervalMinutes: 5,
    provider: "none",
    minScore: 0.2,
  };
  const sessionMemoryEnabled = memoryConfig.sources.includes("sessions");
  const memoryProvider = memoryConfig.provider ?? "none";
  const semanticMemoryEnabled = memoryProvider !== "none";
  const computerUseEnabled =
    isLocalAutomationPreviewEnabled(env) &&
    config.localAutomation?.computerUse.enabled === true &&
    env.computerUseBackend !== null &&
    env.computerUsePlatformSupported !== false &&
    env.computerUseBin !== null &&
    path.isAbsolute(env.computerUseBin) &&
    existsSync(env.computerUseBin);

  const openClawConfig: OpenClawConfig = {
    ...(disableMdnsDiscovery
      ? {
          discovery: {
            mdns: {
              mode: "off",
            },
          },
        }
      : {}),
    // Bundled, version-pinned OpenClaw must not phone npm for a newer version
    // on boot. `checkOnStart` is the `registry.npmjs.org/openclaw/latest` fetch
    // that times out on restricted networks (e.g. China) and stalls startup.
    // The OpenClaw version is managed by slimclaw + the desktop auto-updater.
    update: { checkOnStart: false },
    ...(computerUseEnabled
      ? {
          mcp: {
            servers: {
              "cua-driver": {
                enabled: true,
                transport: "stdio",
                // The MCP process is a thin client of the daemon; the daemon
                // owns the platform grants, so this may run from the plain
                // executable path.
                command: env.computerUseBin,
                // No --socket: the driver must use its own default,
                // which is the only one `permissions status` discovers.
                args: ["mcp", "--embedded"],
                env: {
                  CUA_DRIVER_EMBEDDED: "1",
                  CUA_DRIVER_HOST_BUNDLE_ID: "io.tabby.desktop",
                  CUA_DRIVER_RS_TELEMETRY_ENABLED: "false",
                  CUA_DRIVER_TELEMETRY_HOME: path.join(
                    env.nexuHomeDir,
                    "runtime",
                    "cua-driver",
                  ),
                },
                connectionTimeoutMs: 10_000,
                requestTimeoutMs: 60_000,
                toolFilter: {
                  include: CUA_TOOL_FILTER,
                },
              },
            },
          },
        }
      : {}),
    gateway: {
      port: env.openclawGatewayPort,
      mode: "local",
      bind: config.runtime.gateway.bind,
      auth: {
        mode: config.runtime.gateway.authMode,
        ...(env.openclawGatewayToken
          ? { token: env.openclawGatewayToken }
          : {}),
      },
      reload: {
        mode: "hybrid",
      },
      controlUi: {
        ...(env.openclawBuiltinExtensionsDir
          ? {
              root: resolveControlUiRoot(env.openclawBuiltinExtensionsDir),
            }
          : {}),
        allowedOrigins: [
          env.webUrl,
          `http://127.0.0.1:${env.openclawGatewayPort}`,
          `http://localhost:${env.openclawGatewayPort}`,
        ],
        // Host-header origin fallback lets any page that can reach the port
        // pass the origin check, which defeats the allowlist under DNS
        // rebinding. List the real loopback origins instead.
        dangerouslyAllowHostHeaderOriginFallback: false,
      },
      http: {
        endpoints: {
          chatCompletions: {
            enabled: true,
          },
        },
        // tools.allow intentionally omitted — when absent, OpenClaw allows
        // all plugin-registered tools. An explicit allowlist here would be
        // validated as gateway.http.tools and reject unrecognised names.
      },
      // TEMP: removed to debug device_list visibility
    },
    memory: {
      search: {
        enabled: memoryConfig.enabled,
        sources: memoryConfig.sources,
        experimental: { sessionMemory: sessionMemoryEnabled },
        // Provider aliases such as `link` reuse the matching compiled model
        // provider's base URL and credential without duplicating secrets.
        provider: memoryProvider,
        ...(semanticMemoryEnabled && memoryConfig.model
          ? { model: memoryConfig.model }
          : {}),
        fallback: "none",
        ...(memoryConfig.extraPaths.length > 0
          ? { extraPaths: memoryConfig.extraPaths }
          : {}),
        store: {
          fts: { tokenizer: "trigram" },
          vector: { enabled: semanticMemoryEnabled },
        },
        // Without this OpenClaw applies its own 0.35 floor. Hybrid scoring
        // caps a purely semantic hit at 0.7 * cosine, so that floor drops
        // most of them and semantic recall reads as "no matches". Stored
        // configs always carry the field (schema default 0.2); a raw legacy
        // object that bypassed the schema gets no query block rather than
        // `{ minScore: undefined }`.
        ...(typeof memoryConfig.minScore === "number"
          ? { query: { minScore: memoryConfig.minScore } }
          : {}),
      },
    },
    agents: {
      ownership: "explicit",
      defaults: {
        ...(defaultBot
          ? {
              systemAgent: { agentId: defaultBot.id },
              heartbeat: { agentId: defaultBot.id },
              sessionStore: { agentId: defaultBot.id },
            }
          : {}),
        model: {
          primary: defaultModelId,
          ...(modelFallbacks.length > 0 ? { fallbacks: modelFallbacks } : {}),
        },
        // Route short internal tasks (generated session/thread titles) through
        // a cheaper model when configured; OpenClaw falls back to the primary
        // model when absent.
        ...(utilityModelId ? { utilityModel: utilityModelId } : {}),
        compaction: {
          // "safeguard" mode: Pi framework auto-compacts when prompt
          // approaches context window. The safeguard extension (compaction-
          // safeguard.ts) handles LLM summarization with quality guards.
          mode: "safeguard",
          // OpenClaw owns the history budget in 2026.9.4; keep the supported
          // recent-token and turn safeguards instead of retired tuning keys.
          keepRecentTokens: 20000,
          recentTurnsPreserve: 5,
          qualityGuard: { enabled: true },
          memoryFlush: {
            enabled: true,
          },
        },
        // Wall-clock ceiling for an entire agent run — every tool call and
        // every wait inside one turn, not a single LLM request. OpenClaw
        // defaults this to 48h, i.e. effectively unbounded; the 900s once set
        // here was aimed at slow device steps but capped the whole turn
        // instead, so a healthy run that kept making progress was killed the
        // moment it passed 15 minutes. Browsing 30 posts takes longer than
        // that at 25-75s per phone step, so the cap failed exactly the
        // workloads it was meant to serve.
        //
        // A ceiling still earns its place: a runaway run holds an OpenClaw
        // lane and leaves the bot unreachable. But detecting a hung run is the
        // stalled-session watchdog's job (OpenClaw owns its thresholds)
        // — it measures lack of progress, which is the actual symptom. This
        // only needs to be high enough that no legitimate turn reaches it.
        timeoutSeconds: 2 * 60 * 60,
        humanDelay: {
          mode: "off",
        },
        verboseDefault: "off",
      },
      entries: compileAgentEntries(
        config,
        env,
        oauthState,
        installedSkillSlugs,
        workspaceSkillsByAgent,
      ),
    },
    ...(defaultBot ? { talk: { agentId: defaultBot.id } } : {}),
    tools: {
      profile: "full",
      // Desktop agents can use the native exec/process surface by default.
      // Enabling the sandbox changes the execution host, not tool visibility
      // or approval behavior.
      exec: {
        security: "full",
        ask: "off",
        host: process.env.SANDBOX_ENABLED === "true" ? "sandbox" : "gateway",
      },
      web: {
        // Only advertise web_search when a provider is actually configured.
        // `enabled: true` with no provider still registers the tool, so the
        // agent picks it and every call fails with "web_search is disabled or
        // no provider is available" — a whole turn spent discovering that the
        // capability was never there. An absent tool is read correctly the
        // first time.
        search: process.env.BRAVE_API_KEY
          ? {
              enabled: true,
              provider: "brave",
              apiKey: process.env.BRAVE_API_KEY,
            }
          : { enabled: false },
        fetch: {
          enabled: true,
        },
      },
      ...(process.env.SANDBOX_ENABLED === "true"
        ? {
            sandbox: {
              tools: {
                deny: ["gateway"],
              },
            },
          }
        : {}),
    },
    session: {
      dmScope: "per-peer",
      // Disable automatic session reset. OpenClaw defaults to daily reset at
      // 4 AM which silently drops conversation history — unexpected for a
      // desktop chat app where users expect persistent sessions.
      reset: {
        mode: "idle",
        idleMinutes: 525_600, // 1 year
      },
    },
    cron: {
      enabled: true,
    },
    messages: {
      ackReaction: "eyes",
      ackReactionScope: "group-mentions",
    },
    models: compileModelsConfig(config, env),
    channels: compileChannelsConfig({
      channels: config.channels,
      secrets: config.secrets,
      gatewayBaseUrl: `http://127.0.0.1:${env.openclawGatewayPort}`,
      gatewayToken: env.openclawGatewayToken,
    }),
    bindings: compileChannelBindings(config.bots, config.channels),
    plugins: compilePlugins(config, env, hasTeams),
    skills: {
      load: {
        watch: true,
        extraDirs: [env.openclawSkillsDir, env.userSkillsDir].filter(Boolean),
      },
    },
    commands: {
      native: "auto",
      nativeSkills: "auto",
      restart: false,
      // OpenClaw 2026.7.1 treats a wildcard command owner as "every sender is
      // an owner", which exposes the owner-only `nodes`, `gateway`, and `cron`
      // tools to any channel. Do not reintroduce it on the strength of the
      // docs' claim that a wildcard alone is insufficient for ownership.
    },
    diagnostics: {
      enabled: true,
      // Watchdog thresholds are runtime-owned in OpenClaw 2026.9.4.
      ...(process.env.DD_API_KEY || process.env.OTEL_EXPORTER_OTLP_ENDPOINT
        ? {
            otel: {
              enabled: true,
              endpoint:
                process.env.OTEL_EXPORTER_OTLP_ENDPOINT ??
                `https://otlp.${process.env.DD_SITE ?? "datadoghq.com"}`,
              serviceName: process.env.OTEL_SERVICE_NAME ?? "nexu-openclaw",
              traces: true,
              metrics: true,
              logs: true,
              ...(process.env.DD_API_KEY
                ? {
                    headers: {
                      "dd-api-key": process.env.DD_API_KEY,
                    },
                  }
                : {}),
            },
          }
        : {}),
    },
  };

  return openclawConfigSchema.parse(openClawConfig);
}
