import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const pluginDir = path.dirname(fileURLToPath(import.meta.url));
const statePath = path.resolve(
  pluginDir,
  "..",
  "..",
  "nexu-runtime-model.json",
);
// OpenClaw's compiled config lives at the state-dir root, next to the runtime
// model state file. It is the source of truth for which providers/models the
// runtime registry actually knows about.
const openclawConfigPath = path.resolve(
  pluginDir,
  "..",
  "..",
  "openclaw.json",
);

let cachedRaw = null;
let cachedState = null;

function loadState() {
  try {
    const raw = readFileSync(statePath, "utf8");
    if (cachedState && cachedRaw === raw) {
      return cachedState;
    }
    const parsed = JSON.parse(raw);
    if (
      !parsed ||
      typeof parsed !== "object" ||
      typeof parsed.selectedModelRef !== "string" ||
      typeof parsed.promptNotice !== "string"
    ) {
      return null;
    }
    cachedRaw = raw;
    cachedState = parsed;
    return parsed;
  } catch {
    return cachedState;
  }
}

let cachedConfigRaw = null;
let cachedProviderModels = null;
let cachedAgentsWithOwnModel = null;
let cachedAgentConfigRaw = null;

/**
 * Set of agent ids that carry their own `model.primary` in openclaw.json.
 *
 * Cached by raw file content alongside {@link loadProviderModels}, so the two
 * views never disagree about which config they came from.
 */
function loadAgentsWithOwnModel() {
  try {
    const raw = readFileSync(openclawConfigPath, "utf8");
    if (cachedAgentsWithOwnModel && cachedAgentConfigRaw === raw) {
      return cachedAgentsWithOwnModel;
    }
    const parsed = JSON.parse(raw);
    const entries = parsed?.agents?.entries;
    const ids = new Set();
    if (entries && typeof entries === "object" && !Array.isArray(entries)) {
      for (const [agentId, agent] of Object.entries(entries)) {
        const primary = typeof agent?.model === "string"
          ? agent.model
          : agent?.model?.primary;
        if (typeof primary === "string" && primary.trim().length > 0) {
          ids.add(agentId);
        }
      }
    }
    cachedAgentConfigRaw = raw;
    cachedAgentsWithOwnModel = ids;
    return ids;
  } catch {
    return cachedAgentsWithOwnModel;
  }
}

/**
 * Map of provider key -> Set of model ids registered in openclaw.json.
 * Cached by raw file content so we re-parse only when the config changes.
 */
function loadProviderModels() {
  try {
    const raw = readFileSync(openclawConfigPath, "utf8");
    if (cachedProviderModels && cachedConfigRaw === raw) {
      return cachedProviderModels;
    }
    const parsed = JSON.parse(raw);
    const providers = parsed?.models?.providers ?? {};
    const map = new Map();
    for (const [providerKey, providerValue] of Object.entries(providers)) {
      const models = providerValue?.models;
      const ids = new Set();
      if (Array.isArray(models)) {
        for (const m of models) {
          if (m && typeof m.id === "string") ids.add(m.id);
        }
      } else if (models && typeof models === "object") {
        for (const id of Object.keys(models)) ids.add(id);
      }
      map.set(providerKey, ids);
    }
    cachedConfigRaw = raw;
    cachedProviderModels = map;
    return map;
  } catch {
    return cachedProviderModels;
  }
}

/**
 * True when the override is safe to apply: either it carries no provider
 * prefix (a bare model override we can't validate, so we trust it), or the
 * provider exists in the registry and the model id is registered under it.
 *
 * Defends against a stale/invalid runtime-model selection (e.g. an
 * `anthropic/...` ref with no Anthropic provider configured) silently
 * bricking every reply with "Unknown model" — when invalid we skip the
 * override and let the agent fall back to its own configured model.
 */
function isOverrideRegistered(providerOverride, modelOverride) {
  if (!providerOverride) return true;
  const providerModels = loadProviderModels();
  // Can't read the registry → fail open (preserve previous behaviour).
  if (!providerModels) return true;
  const ids = providerModels.get(providerOverride);
  if (!ids) return false; // unknown provider (the real failure mode)
  if (ids.size === 0) return true; // provider known but model list empty → trust
  if (ids.has(modelOverride)) return true;
  // Tolerate refs that double-prefix the model (e.g. "stepfun/step-3.7-flash").
  const lastSegment = modelOverride.includes("/")
    ? modelOverride.slice(modelOverride.lastIndexOf("/") + 1)
    : modelOverride;
  return ids.has(lastSegment);
}

function resolveValidOverride(state) {
  if (!state || state.selectedModelRef.trim().length === 0) {
    return null;
  }
  const slashIndex = state.selectedModelRef.indexOf("/");
  const providerOverride =
    slashIndex > 0 ? state.selectedModelRef.slice(0, slashIndex) : "";
  const modelOverride =
    slashIndex > 0
      ? state.selectedModelRef.slice(slashIndex + 1)
      : state.selectedModelRef;
  if (!isOverrideRegistered(providerOverride, modelOverride)) {
    return null;
  }
  return { providerOverride, modelOverride };
}

/**
 * True when the running agent carries its own model binding, in which case the
 * global selection must stay out of the way.
 *
 * A missing agent id means we cannot tell, and the safe answer is to leave the
 * previous behaviour intact rather than drop the override for everyone.
 */
function agentPinsOwnModel(ctx) {
  const agentId = ctx?.agentId;
  if (typeof agentId !== "string" || agentId.length === 0) return false;
  const pinned = loadAgentsWithOwnModel();
  return pinned ? pinned.has(agentId) : false;
}

const plugin = {
  id: "nexu-runtime-model",
  name: "Nexu Runtime Model",
  description:
    "Injects the Nexu global model selection into model routing and prompt context, for agents that do not pin their own model.",
  register(api) {
    try {
      api.logger.info(
        "[nexu-runtime-model] loaded — intercepting before_model_resolve",
      );
    } catch {}
    api.on("before_model_resolve", async (_event, ctx) => {
      // The selection this plugin carries is the *global* default. An agent
      // that pins its own model in openclaw.json has already made a more
      // specific choice, and overriding it here silently defeated the
      // per-bot binding: the bot ran on the global model while every
      // surface — the picker, the bot record, agents.entries — showed the one
      // the user had chosen.
      if (agentPinsOwnModel(ctx)) {
        return;
      }
      const state = loadState();
      const override = resolveValidOverride(state);
      if (!override) {
        if (state && state.selectedModelRef.trim().length > 0) {
          try {
            api.logger.warn(
              `[nexu-runtime-model] selected model "${state.selectedModelRef}" is not in the registry — skipping override, falling back to the agent's configured model`,
            );
          } catch {}
        }
        return;
      }
      return {
        ...(override.providerOverride
          ? { providerOverride: override.providerOverride }
          : {}),
        modelOverride: override.modelOverride,
      };
    });

    api.on("before_prompt_build", async (_event, ctx) => {
      // Same gate as before_model_resolve: without it the prompt would tell a
      // pinned agent that the global model is "the only source of truth" for
      // this turn, which is how a bot bound to tabby-ultra reported itself as
      // tabby-pro.
      if (agentPinsOwnModel(ctx)) {
        return;
      }
      const state = loadState();
      // Only inject the "authoritative model is X" notice when the override is
      // actually being applied — otherwise the prompt would lie about a model
      // the runtime isn't using.
      if (
        !state ||
        state.promptNotice.trim().length === 0 ||
        !resolveValidOverride(state)
      ) {
        return;
      }
      return {
        prependSystemContext: state.promptNotice,
      };
    });
  },
};

export default plugin;
