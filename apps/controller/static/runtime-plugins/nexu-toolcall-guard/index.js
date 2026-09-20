/**
 * nexu-toolcall-guard
 *
 * Circuit breaker for runaway tool-call retry loops and local automation gate.
 *
 * Some models (observed: gpt-5.3-codex-spark) call a tool but never produce
 * arguments — the tool call's `arguments` is always `{}`. OpenClaw validates
 * the arguments against the tool schema, throws "Validation failed for tool
 * ...", feeds that error back as a tool result, and the model retries the same
 * empty call forever. pi-ai's agent loop has no step ceiling, so this burns
 * tokens indefinitely while the user only sees "a tool keeps running but never
 * produces output".
 *
 * Strategy (no OpenClaw source changes; pure plugin):
 *  1. `after_tool_call` — when a call fails *argument validation* (error text
 *     contains "Validation failed for tool"), accumulate a per-run counter
 *     keyed by (runId, toolName, paramsHash). Only count when there is NO
 *     progress: same tool, same (or still-empty) arguments. Any successful
 *     call, any non-validation error, or any *changed* arguments resets the
 *     counter — so a normal "got it wrong once, then fixed it" path is never
 *     penalised.
 *  2. `before_tool_call` — once the same tool has failed `threshold` times in a
 *     row with no progress, block the next call and return a clear instruction
 *     telling the model to stop retrying and tell the user to switch models.
 *  3. `agent_end` — drop the run's counter so the map cannot grow unbounded.
 *
 * We cannot hard-kill the run from a plugin (`abortEmbeddedAgentRun` is not
 * exported from the openclaw entrypoint), so this relies on blocking the tool
 * plus a strong instruction. The threshold gives the model a couple of chances
 * to self-correct before the brake engages.
 */

import { realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const DEFAULT_THRESHOLD = 3;
const MAX_TRACKED_RUNS = 500;
// peekaboo__ stays in the gate list as a permanently unapproved legacy
// surface: Nexu ships cua-driver on every platform, so any peekaboo__* tool
// (including a third-party Peekaboo MCP) fails closed in
// isApprovedLocalAutomationTool below.
const LOCAL_AUTOMATION_TOOL_PREFIXES = ["peekaboo__", "cua-driver__"];
// Embedded-browser tools registered by the nexu-browser plugin. They drive a
// browser that carries the user's own logins, so they are gated exactly like
// desktop control: desktop main session only. Kept in sync with
// EMBEDDED_BROWSER_TOOLS in apps/controller/src/lib/openclaw-config-compiler.ts.
const EMBEDDED_BROWSER_TOOLS = new Set([
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
]);
const HOST_EXECUTION_TOOLS = new Set([
  "gateway",
  "nodes",
  "cron",
]);
const COMPUTER_OBSERVATION_TOOLS = new Set([
  "cua-driver__get_accessibility_tree",
  "cua-driver__get_desktop_state",
  "cua-driver__get_session_state",
  "cua-driver__get_window_state",
]);
const COMPUTER_MUTATION_TOOLS = new Set([
  "cua-driver__click",
  "cua-driver__double_click",
  "cua-driver__right_click",
  "cua-driver__drag",
  "cua-driver__move_cursor",
  "cua-driver__scroll",
  "cua-driver__type_text",
  "cua-driver__press_key",
  "cua-driver__hotkey",
  "cua-driver__set_value",
  "cua-driver__launch_app",
]);
const NON_MUTATING_COMPUTER_TOOLS = new Set([
  ...COMPUTER_OBSERVATION_TOOLS,
  "cua-driver__check_permissions",
  "cua-driver__get_cursor_position",
  "cua-driver__get_screen_size",
  "cua-driver__list_apps",
  "cua-driver__list_windows",
  "cua-driver__start_session",
  "cua-driver__end_session",
  "cua-driver__escalate_session",
]);
const APPROVED_CUA_TOOLS = new Set([
  "cua-driver__check_permissions",
  "cua-driver__get_accessibility_tree",
  "cua-driver__get_cursor_position",
  "cua-driver__get_desktop_state",
  "cua-driver__get_screen_size",
  "cua-driver__get_session_state",
  "cua-driver__get_window_state",
  "cua-driver__list_apps",
  "cua-driver__list_windows",
  "cua-driver__click",
  "cua-driver__double_click",
  "cua-driver__right_click",
  "cua-driver__drag",
  "cua-driver__move_cursor",
  "cua-driver__scroll",
  "cua-driver__type_text",
  "cua-driver__press_key",
  "cua-driver__hotkey",
  "cua-driver__set_value",
  "cua-driver__launch_app",
  "cua-driver__start_session",
  "cua-driver__end_session",
  "cua-driver__escalate_session",
]);
const IMPLICIT_APP_TARGETS = new Set(["active", "current", "frontmost"]);
// Action classes with no read-back — see the identical list and rationale in
// apps/controller/src/services/local-automation-completion-guard.ts. Keyed by
// action class, not by whether a call carried an element reference: an
// unverified `type` stays a hard failure even where the provider cannot bind
// it to an element.
const UNVERIFIABLE_ACTION_TOOLS = new Set([
  "cua-driver__click",
  "cua-driver__double_click",
  "cua-driver__right_click",
  "cua-driver__drag",
  "cua-driver__scroll",
  "cua-driver__press_key",
  "cua-driver__hotkey",
  "cua-driver__move_cursor",
]);
const UNVERIFIED_COMPUTER_ACTION_MESSAGE =
  "电脑操作未确认完成：工具可能只投递了动作，后续状态没有证明请求结果。系统不会仅凭成功回执或一次普通截图报告完成。";

const MAX_NAMED_EVIDENCE_GAPS = 5;

// Names what is actually missing, per action. The generic verdict alone reads
// as a contradiction: the transcript shows a success story and the reply calls
// the run unconfirmed without saying which step it doubts. Tool names and gap
// categories only — params can carry the user's typed text, which must never
// be echoed into a message. Mirrors describeEvidenceGaps in
// apps/controller/src/services/local-automation-completion-guard.ts.
function describeEvidenceGaps(state) {
  const gaps = [];
  for (const fingerprint of state.inFlight.keys()) {
    const toolName = String(fingerprint).split(":")[0] || "unknown-tool";
    gaps.push(`${toolName}（调用未返回结果，动作可能未投递）`);
  }
  for (const action of state.pending) {
    if (action.failed) {
      gaps.push(`${action.toolName}（失败后未以相同参数重试成功）`);
    } else if (action.verificationKind === "element-value") {
      gaps.push(`${action.toolName}（写入的值未从同一元素读回确认）`);
    } else if (action.verificationKind === "target-observed") {
      gaps.push(`${action.toolName}（目标启动后未被观察到）`);
    }
  }
  const unique = [...new Set(gaps)];
  const shown = unique.slice(0, MAX_NAMED_EVIDENCE_GAPS);
  if (shown.length === 0) return "";
  const suffix =
    unique.length > shown.length ? `（另有 ${unique.length - shown.length} 项）` : "";
  return `\n缺少证据的动作：${shown.join("、")}${suffix}。`;
}

// Click/hotkey/scroll/drag/menu/dock/dialog/window have no read-back, so no
// provider can prove they achieved intent. Replacing a correct reply with a
// failure for those reports successful work as failed. Append a caveat
// instead; evidence the provider could have produced and did not still
// replaces the message. Mirrors the severity split in
// apps/controller/src/services/local-automation-completion-guard.ts.
const UNVERIFIABLE_COMPUTER_ACTION_NOTICE =
  "\n\n---\n提示：本次操作中的点击/按键/滚动/拖拽类动作无法被系统验证——这类动作只能投递事件，操作系统不提供「是否达成意图」的回执。上述结果未经证实，请自行确认。";

// runId -> { toolName, count, paramsHash }
const runFailures = new Map();
// sessionKey -> { runId, inFlight: Map<string, number>, pending: Array<...> }
const pendingComputerRuns = new Map();

function stableHash(params) {
  try {
    return JSON.stringify(params ?? {});
  } catch {
    return "";
  }
}

function stableValue(value) {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, nested]) => [key, stableValue(nested)]),
  );
}

function mutationFingerprint(toolName, params) {
  try {
    return `${toolName}:${JSON.stringify(stableValue(params ?? {}))}`;
  } catch {
    return `${toolName}:unserializable`;
  }
}

function isValidationFailure(error) {
  if (!error) return false;
  const s = typeof error === "string" ? error : String(error);
  return (
    s.includes("Validation failed for tool") || s.includes("Received arguments")
  );
}

function isEmptyParams(params) {
  return (
    !params ||
    (typeof params === "object" && Object.keys(params).length === 0)
  );
}

function isLocalAutomationTool(toolName) {
  return (
    toolName === "browser" ||
    EMBEDDED_BROWSER_TOOLS.has(toolName) ||
    LOCAL_AUTOMATION_TOOL_PREFIXES.some((prefix) => toolName?.startsWith(prefix))
  );
}

function readText(params, keys) {
  for (const key of keys) {
    const value = params?.[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === "boolean") return String(value);
  }
  return null;
}

function readLiteralText(params, keys) {
  for (const key of keys) {
    const value = params?.[key];
    if (typeof value === "string") return value;
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
    if (typeof value === "boolean") return String(value);
  }
  return null;
}

function normalizeTarget(value) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized && !IMPLICIT_APP_TARGETS.has(normalized)
    ? normalized
    : null;
}

function resolveAutomationTarget(toolName, params) {
  const directApp = readText(params, [
    "app",
    "app_target",
    "application",
    "bundle_id",
    "bundleId",
  ]);
  const pid = readText(params, ["pid"]);
  const appName =
    toolName === "cua-driver__launch_app" ? readText(params, ["name"]) : null;
  const windowId = readText(params, ["window_id", "windowId"]);
  const windowIndex = readText(params, ["window_index", "windowIndex"]);
  const session = readText(params, [
    "session",
    "session_id",
    "sessionId",
    "snapshot",
    "snapshot_id",
    "snapshotId",
  ]);
  return {
    app: normalizeTarget(directApp ?? (pid ? `pid:${pid}` : appName)),
    window: windowId
      ? `id:${windowId.toLowerCase()}`
      : windowIndex
        ? `index:${windowIndex.toLowerCase()}`
        : null,
    session: normalizeTarget(session),
  };
}

function resultTargets(value) {
  const targets = [];
  const seen = new Set();
  let remainingNodes = 500;

  const visit = (candidate) => {
    if (remainingNodes-- <= 0) return;
    // See the identical rationale in
    // apps/controller/src/services/local-automation-completion-guard.ts.
    if (typeof candidate === "string") {
      for (const match of candidate.matchAll(/\(pid (\d{1,10})\)/g)) {
        targets.push({
          app: normalizeTarget(`pid:${match[1]}`),
          window: null,
          session: null,
        });
      }
      return;
    }
    if (!candidate || typeof candidate !== "object") {
      return;
    }
    if (seen.has(candidate)) return;
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      for (const entry of candidate) visit(entry);
      return;
    }
    const pid = readText(candidate, ["pid", "process_id", "processId"]);
    const app = readText(candidate, [
      "app",
      "application",
      "bundle_id",
      "bundleId",
      "process_name",
      "processName",
    ]);
    const windowId = readText(candidate, ["window_id", "windowId"]);
    const session = readText(candidate, [
      "session",
      "session_id",
      "sessionId",
    ]);
    if (pid || app || windowId || session) {
      targets.push({
        app: normalizeTarget(pid ? `pid:${pid}` : app),
        window: windowId ? `id:${windowId.toLowerCase()}` : null,
        session: normalizeTarget(session),
      });
    }
    for (const nested of Object.values(candidate)) visit(nested);
  };

  visit(value);
  const deduplicated = new Map();
  for (const target of targets) {
    deduplicated.set(JSON.stringify(target), target);
  }
  return [...deduplicated.values()];
}

function automationTargetsMatch(action, evidence) {
  if (action.window) {
    return (
      action.window === evidence.window &&
      (!action.app || !evidence.app || action.app === evidence.app)
    );
  }
  if (action.session) {
    return (
      action.session === evidence.session &&
      (!action.app || !evidence.app || action.app === evidence.app)
    );
  }
  if (action.app) return action.app === evidence.app;
  return false;
}

function hasExplicitAutomationTarget(target) {
  return Boolean(target.app || target.window || target.session);
}

function expectedTextForMutation(toolName, params) {
  if (toolName === "cua-driver__type_text") {
    return readLiteralText(params, ["text"]);
  }
  if (toolName === "cua-driver__set_value") {
    return readLiteralText(params, ["value", "text"]);
  }
  return null;
}

function expectedElementIdForMutation(params) {
  return normalizeTarget(
    readText(params, [
      "element_id",
      "elementId",
      "node_id",
      "nodeId",
      "target_id",
      "targetId",
      "element_index",
      "elementIndex",
      "element_token",
      "elementToken",
      "on",
    ]),
  );
}

function parseStructuredText(value) {
  const trimmed = value.trim();
  if (
    trimmed.length === 0 ||
    trimmed.length > 1_000_000 ||
    (!trimmed.startsWith("{") && !trimmed.startsWith("["))
  ) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function textHasExplicitElementValue(
  text,
  expectedElementId,
  expectedText,
  matchMode,
) {
  const normalizedElementId = expectedElementId.normalize("NFKC").toLocaleLowerCase();
  const normalizedExpectedText = expectedText.normalize("NFKC").toLocaleLowerCase();
  if (
    !normalizedElementId ||
    (!normalizedExpectedText && matchMode === "contains")
  ) {
    return false;
  }
  const escapedElementId = normalizedElementId.replace(
    /[.*+?^${}()|[\]\\]/g,
    "\\$&",
  );
  const bareOrWrappedElement = `(?:${escapedElementId}|\\[${escapedElementId}\\]|\\(${escapedElementId}\\))`;
  const elementPrefixPattern = new RegExp(
    `^\\s*(?:(?:[-*]|\\u2022)\\s*)?${bareOrWrappedElement}(?=\\s|[:=,}\\]]|$)`,
    "u",
  );
  const elementFieldPattern =
    /(?:^|[\s,{])(?:element[_ -]?id|node[_ -]?id|target[_ -]?id|element[_ -]?(?:index|token)|runtime[_ -]?id|automation[_ -]?id|id|on)\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,}\]]+))/giu;
  const valueFieldPattern =
    /(?:^|[\s,{])(?:value|current[_ -]?value|text[_ -]?value)\s*[:=]\s*(?:"([^"\r\n]*)"|'([^'\r\n]*)'|([^\s,}\]]+))/giu;

  return text.split(/\r?\n|;/).some((segment) => {
    const normalizedSegment = segment.normalize("NFKC").toLocaleLowerCase();
    const elementIds = [...normalizedSegment.matchAll(elementFieldPattern)].map(
      (match) => normalizeTarget(match[1] ?? match[2] ?? match[3] ?? ""),
    );
    if (elementIds.length > 1) return false;
    const prefixMatches = elementPrefixPattern.test(normalizedSegment);
    if (
      (!prefixMatches && elementIds.length !== 1) ||
      (elementIds.length === 1 && elementIds[0] !== normalizedElementId)
    ) {
      return false;
    }

    const values = [...normalizedSegment.matchAll(valueFieldPattern)]
      .filter((match) => {
        const prefix = normalizedSegment.slice(0, match.index).trimEnd();
        return !/(?:^|[\s,{])default(?:[_ -])?$/.test(prefix);
      })
      .map((match) => match[1] ?? match[2] ?? match[3] ?? "");
    const [value] = values;
    if (values.length !== 1 || value === undefined) return false;
    return matchMode === "exact"
      ? value === normalizedExpectedText
      : value.includes(normalizedExpectedText);
  });
}

function evidenceConfirmsExpectedValue(
  value,
  expectedElementId,
  expectedText,
  matchMode,
) {
  if (!expectedElementId) return false;
  const needle = expectedText.normalize("NFKC").toLocaleLowerCase();
  if (!needle && matchMode === "contains") return false;
  let remainingNodes = 2_000;
  const seen = new Set();

  const containsExpectedValue = (record) => {
    for (const key of ["value", "currentValue", "textValue"]) {
      const candidate = record[key];
      if (
        typeof candidate === "string" &&
        (matchMode === "exact"
          ? candidate.normalize("NFKC").toLocaleLowerCase() === needle
          : candidate.normalize("NFKC").toLocaleLowerCase().includes(needle))
      ) {
        return true;
      }
    }
    const attributes = record.attributes;
    return attributes && typeof attributes === "object"
      ? containsExpectedValue(attributes)
      : false;
  };

  const visit = (candidate) => {
    if (remainingNodes-- <= 0) return false;
    if (typeof candidate === "string") {
      const structured = parseStructuredText(candidate);
      return structured
        ? visit(structured)
        : textHasExplicitElementValue(
            candidate,
            expectedElementId,
            expectedText,
            matchMode,
          );
    }
    if (!candidate || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    const candidateId = normalizeTarget(
      readText(candidate, [
        "element_id",
        "elementId",
        "node_id",
        "nodeId",
        "target_id",
        "targetId",
        "element_index",
        "elementIndex",
        "element_token",
        "elementToken",
        "index",
        "runtime_id",
        "runtimeId",
        "automation_id",
        "automationId",
        "id",
      ]),
    );
    if (
      candidateId === expectedElementId &&
      containsExpectedValue(candidate)
    ) {
      return true;
    }
    return Object.values(candidate).some(visit);
  };

  return visit(value);
}

function resultHasCuaNativeVerification(value) {
  const seen = new Set();
  let remainingNodes = 100;

  const visit = (candidate) => {
    if (remainingNodes-- <= 0 || !candidate || typeof candidate !== "object") {
      return false;
    }
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    if (candidate.verified === true) return true;
    return [
      candidate.result,
      candidate.data,
      candidate.payload,
      candidate.details,
      candidate.structuredContent,
    ].some(visit);
  };

  return visit(value);
}

function resultHasProviderVerification(
  value,
  toolName,
  expectedText,
  expectedElementId,
) {
  if (
    toolName?.startsWith("cua-driver__") &&
    resultHasCuaNativeVerification(value)
  ) {
    return true;
  }
  const seen = new Set();
  let remainingNodes = 1_000;

  const visit = (candidate) => {
    if (remainingNodes-- <= 0) return false;
    if (typeof candidate === "string") return false;
    if (!candidate || typeof candidate !== "object") return false;
    if (seen.has(candidate)) return false;
    seen.add(candidate);
    if (Array.isArray(candidate)) return candidate.some(visit);
    const action =
      candidate.action && typeof candidate.action === "object"
        ? candidate.action
        : null;
    if (
      action?.verification &&
      typeof action.verification === "object" &&
      action.verification.state === "verified"
    ) {
      if (expectedText === null) {
        const actionName = readText(action, ["toolName", "actionName"]);
        const toolOperation = toolName.split("__").at(-1);
        if (!actionName || !toolOperation) return false;
        return (
          actionName.toLocaleLowerCase().replace(/[^a-z0-9]/g, "") ===
          toolOperation.toLocaleLowerCase().replace(/[^a-z0-9]/g, "")
        );
      }
      const verifiedElementId = expectedElementIdForMutation(action);
      if (expectedElementId && verifiedElementId !== expectedElementId) {
        return false;
      }
      const expected = readLiteralText(action.verification, ["expected"]);
      const property = readText(action.verification, ["property"]);
      const normalizedExpected = expected
        ?.normalize("NFKC")
        .toLocaleLowerCase();
      const normalizedRequested = expectedText
        .normalize("NFKC")
        .toLocaleLowerCase();
      const allowedProperties = toolName.endsWith("__set_value")
        ? new Set(["value"])
        : new Set(["focusedtext", "selection", "value"]);
      if (
        normalizedExpected !== normalizedRequested ||
        !property ||
        !allowedProperties.has(property.toLocaleLowerCase())
      ) {
        return false;
      }
      const actualPreview = readLiteralText(action.verification, ["actualPreview"]);
      return (
        actualPreview === null ||
        actualPreview.normalize("NFKC").toLocaleLowerCase() ===
          normalizedRequested
      );
    }
    return [
      candidate.result,
      candidate.data,
      candidate.payload,
      candidate.content,
    ].some(visit);
  };

  return visit(value);
}

function verificationKindForMutation(toolName, params) {
  const expectedText = expectedTextForMutation(toolName, params);
  const expectedElementId = expectedElementIdForMutation(params);
  if (expectedText !== null && expectedElementId !== null) {
    return "element-value";
  }
  if (toolName === "cua-driver__launch_app") return "target-observed";
  return "provider-only";
}

function isComputerMutation(toolName) {
  if (NON_MUTATING_COMPUTER_TOOLS.has(toolName)) return false;
  if (COMPUTER_MUTATION_TOOLS.has(toolName)) return true;
  return toolName?.startsWith("cua-driver__") === true;
}

function isApprovedLocalAutomationTool(toolName) {
  // Fail closed for gate-listed surfaces that are not individually reviewed:
  // cua-driver tools must be on APPROVED_CUA_TOOLS, and peekaboo__* — the
  // pre-unification macOS backend, plus any third-party Peekaboo MCP — is
  // never approved. Embedded-browser tools are policed by the session gate,
  // not by this list, so they stay approved here.
  if (toolName?.startsWith("peekaboo__")) {
    return false;
  }
  if (toolName?.startsWith("cua-driver__")) {
    return APPROVED_CUA_TOOLS.has(toolName);
  }
  return true;
}

function toolCallFailed(event) {
  if (event?.error) return true;
  const result = event?.result;
  return (
    result &&
    typeof result === "object" &&
    (result.isError === true || result.ok === false)
  );
}

function completionStateKey(ctx) {
  return typeof ctx?.sessionKey === "string" && ctx.sessionKey
    ? `session:${ctx.sessionKey}`
    : null;
}

function getComputerRunState(ctx, event) {
  const key = completionStateKey(ctx);
  const runId = ctx?.runId || event?.runId;
  if (!key || !runId) return null;
  const existing = pendingComputerRuns.get(key);
  if (existing?.runId === runId) return { key, state: existing };
  const state = { runId, inFlight: new Map(), pending: [] };
  pendingComputerRuns.set(key, state);
  if (pendingComputerRuns.size > MAX_TRACKED_RUNS) {
    const oldest = pendingComputerRuns.keys().next().value;
    if (oldest !== undefined) pendingComputerRuns.delete(oldest);
  }
  return { key, state };
}

function trackComputerStart(event, ctx) {
  const toolName = event?.toolName;
  const params = event?.params ?? {};
  if (!isComputerMutation(toolName)) return;
  const tracked = getComputerRunState(ctx, event);
  if (!tracked) return;
  const fingerprint = mutationFingerprint(toolName, params);
  tracked.state.inFlight.set(
    fingerprint,
    (tracked.state.inFlight.get(fingerprint) ?? 0) + 1,
  );
}

function trackComputerCompletion(event, ctx) {
  const toolName = event?.toolName;
  const params = event?.params ?? {};
  const mutation = isComputerMutation(toolName);
  const observation = COMPUTER_OBSERVATION_TOOLS.has(toolName);
  if (!mutation && !observation) return;
  const tracked = getComputerRunState(ctx, event);
  if (!tracked) return;
  const target = resolveAutomationTarget(toolName, params);
  const failed = toolCallFailed(event);

  if (mutation) {
    const aliases =
      toolName === "cua-driver__launch_app" ? resultTargets(event.result) : [];
    const expectedElementId = expectedElementIdForMutation(params);
    const expectedText = expectedTextForMutation(toolName, params);
    const fingerprint = mutationFingerprint(toolName, params);
    const inFlightCount = tracked.state.inFlight.get(fingerprint) ?? 0;
    if (inFlightCount <= 1) tracked.state.inFlight.delete(fingerprint);
    else tracked.state.inFlight.set(fingerprint, inFlightCount - 1);
    const verificationKind = verificationKindForMutation(toolName, params);
    if (!failed) {
      tracked.state.pending = tracked.state.pending.filter(
        (pending) => (pending.failed ? pending.fingerprint !== fingerprint : true),
      );
    }
    if (
      !failed &&
      hasExplicitAutomationTarget(target) &&
      resultHasProviderVerification(
        event.result,
        toolName,
        expectedText,
        expectedElementId,
      )
    ) {
      return;
    }
    tracked.state.pending.push({
      aliases,
      expectedElementId,
      expectedText,
      failed,
      fingerprint,
      target,
      toolName,
      verificationKind,
    });
    return;
  }

  if (!failed) {
    tracked.state.pending = tracked.state.pending.filter(
      (pending) =>
        pending.failed ||
        ![pending.target, ...pending.aliases].some((candidate) =>
          automationTargetsMatch(candidate, target),
        ) ||
        pending.verificationKind === "provider-only" ||
        (pending.verificationKind === "element-value" &&
          (pending.expectedText === null ||
            !evidenceConfirmsExpectedValue(
              event.result,
              pending.expectedElementId,
              pending.expectedText,
              pending.toolName.endsWith("__set_value")
                ? "exact"
                : "contains",
            ))),
    );
  }
}

function assistantMessageHasToolCall(message) {
  return (
    Array.isArray(message?.content) &&
    message.content.some(
      (part) =>
        part &&
        typeof part === "object" &&
        (part.type === "toolCall" || part.type === "tool_call"),
    )
  );
}

function isLocalInteractiveSession(ctx) {
  // `webchat` and friends are the runtime's internal surfaces, not channels.
  if (remoteChannelId(ctx)) return false;
  return /^agent:[^:]+:(?:main|[0-9a-f]{8}-[0-9a-f-]{27})$/i.test(
    ctx?.sessionKey ?? "",
  );
}

// ---------------------------------------------------------------------------
// Host execution tiering
//
// `exec`/`process` stay prompt-free for the person sitting at the desktop app —
// that is a product requirement, not an oversight. What is gated is the run
// whose *driver* is not that person.
//
// The discriminator is a positively observed remote signal, never the absence
// of one. `ctx.channelId` is populated by OpenClaw 2026.7.1 for every
// channel-originated run (see buildToolContext in
// dist/agent-tools.before-tool-call-*.js) regardless of what the session key
// looks like, so it survives the key-shaping paths that would otherwise
// launder a channel conversation into desktop shape.
//
// Sub-sessions are intentionally NOT restricted here. Their lineage is not
// present in the tool context, and most bundled skills are shell-driven, so
// judging them on session-key shape alone would break the user's own team,
// workflow, and media flows. Tightening them requires run-provenance tracking
// (before_agent_start), which is deliberately a separate change.
// ---------------------------------------------------------------------------
const AUTOMATION_SESSION_KEY_PATTERN =
  /^agent:[^:]+:(?:cron(?::|$)|schedule[-:])/i;

const HOST_EXECUTION_TIER = "host";
const RESTRICTED_EXECUTION_TIER = "restricted";

// Triggers that start a run with nobody at the keyboard. `user` is excluded on
// purpose, and so are the mid-run continuations (`budget`, `overflow`,
// `timeout_recovery`): those resume a run a human already started, and
// restricting them would revoke host execution halfway through the desktop
// user's own turn.
const UNATTENDED_TRIGGERS = new Set(["cron", "heartbeat", "memory"]);

const MAX_TRACKED_ORIGINS = 500;

// `channelId` on the agent hook context is NOT a conversation id. OpenClaw
// derives it as `messageChannel ?? provider` (dist/hook-agent-context-*.js),
// so a plain desktop `chat.send` turn arrives with `channelId: "webchat"` —
// INTERNAL_MESSAGE_CHANNEL, the desktop's own surface. Treating that as a
// remote channel refuses host execution to the person sitting at the app.
// These are the runtime's own internal surface names.
const INTERNAL_CHANNEL_IDS = new Set([
  "webchat",
  "heartbeat",
  "cron",
  "webhook",
  "voice",
  "sessions_send",
]);

/**
 * The conversation id of a genuinely remote channel, or null.
 *
 * Two things are not remote: one of the runtime's internal surface names, and
 * a value that merely echoes the message provider — that is the derivation's
 * "no conversation ref available" fallback, not a conversation. A real inbound
 * Slack turn carries the channel id (`C123`), never the string `slack`.
 */
function remoteChannelId(ctx) {
  const raw = ctx?.channelId;
  if (typeof raw !== "string" || !raw) return null;
  const normalized = raw.toLowerCase();
  if (INTERNAL_CHANNEL_IDS.has(normalized)) return null;
  const provider =
    typeof ctx.messageProvider === "string"
      ? ctx.messageProvider.toLowerCase()
      : null;
  if (provider && normalized === provider) return null;
  return raw;
}

// runId -> { trigger, channelId, sessionKey, agentId }, observed on the agent
// lifecycle hooks where OpenClaw populates them. The tool context carries
// neither `trigger` nor any lineage, so this is the only way to tell an
// unattended run from a user's.
const runOrigins = new Map();

// sessionKey -> { reason, agentId }, for sessions restricted by their own
// nature (channel conversations) and for sub-sessions that inherit from one.
//
// Deliberately NOT populated from trigger-based restrictions: heartbeat runs on
// `agent:<bot>:main`, the same key the desktop user types into, so marking the
// key would revoke the desktop user's own host execution from the next turn on.
const restrictedSessions = new Map();

// sessionKey -> runId for the run currently executing on that session.
//
// `subagent_spawned` reports the requester's session key but not its run id,
// and a trigger restriction lives on the run. This index is the join between
// the two, so a child can inherit from its parent's *run* rather than from a
// second copy of the restriction kept per session. OpenClaw serializes runs
// per session (and Nexu's SessionRunRegistry gates the desktop path), so a
// session has at most one active run. Cleared at `agent_end`.
const activeRunBySession = new Map();

/**
 * Bounded insert with LRU semantics.
 *
 * A restriction is meant to be forgotten when its session ends, not because
 * other sessions showed up: plain FIFO eviction lets a restricted run flood the
 * map with new sessions until its own entry is dropped, which un-restricts it.
 * Lifecycle teardown (`session_end` / `subagent_ended` / `agent_end`) is the
 * real reclaim path; this bound is only a memory backstop, and it says so out
 * loud when it drops something load-bearing.
 */
function rememberBounded(map, key, value, limit, onEvict) {
  map.delete(key);
  map.set(key, value);
  if (map.size <= limit) return;
  const oldest = map.keys().next().value;
  if (oldest === undefined) return;
  const evicted = map.get(oldest);
  map.delete(oldest);
  if (onEvict) onEvict(oldest, evicted);
}

/** Move a live entry to the back of the queue so lookups keep it warm. */
function touchBounded(map, key) {
  const value = map.get(key);
  if (value === undefined) return value;
  map.delete(key);
  map.set(key, value);
  return value;
}

// One predicate per reason family, shared by the escape hatch and the block
// message so the two cannot drift into telling the user different stories.
function isAutomationReason(reason) {
  const base = reason?.startsWith("inherited:") ? reason.slice(10) : reason;
  return (
    base === "automation-origin" ||
    base === "cron-origin" ||
    base === "heartbeat-origin" ||
    base === "memory-origin"
  );
}

function isChannelReason(reason) {
  const base = reason?.startsWith("inherited:") ? reason.slice(10) : reason;
  return base === "channel-origin";
}

/** Reason this origin is restricted, or null when it is not. */
function restrictedOriginReason(origin) {
  if (!origin) return null;
  // Trigger first: an unattended run that also carries a delivery channel is
  // still an automation, and must be governed by the `automations` switch
  // rather than the `channels` one.
  if (origin.trigger && UNATTENDED_TRIGGERS.has(origin.trigger)) {
    return `${origin.trigger}-origin`;
  }
  if (origin.channelId) return "channel-origin";
  return null;
}

/**
 * Record what started a run. Called from several lifecycle hooks because the
 * runtime marks some of them deprecated; recording is idempotent and can only
 * ever restrict, so observing the same run more than once is harmless.
 */
function recordRunOrigin(ctx) {
  const runId = ctx?.runId;
  if (!runId) return;
  const origin = {
    trigger: ctx.trigger,
    channelId: remoteChannelId(ctx),
    sessionKey: ctx.sessionKey,
    agentId: ctx.agentId,
  };
  rememberBounded(runOrigins, runId, origin, MAX_TRACKED_ORIGINS);
  if (ctx.sessionKey) {
    rememberBounded(
      activeRunBySession,
      ctx.sessionKey,
      runId,
      MAX_TRACKED_ORIGINS,
    );
  }

  const reason = restrictedOriginReason(origin);
  if (!reason || !ctx.sessionKey) return;

  if (reason === "channel-origin") {
    // Intrinsic to the session: a channel conversation never serves desktop
    // runs, so remembering it by key is safe.
    rememberBounded(
      restrictedSessions,
      ctx.sessionKey,
      { reason, agentId: ctx.agentId },
      MAX_TRACKED_ORIGINS,
    );
    return;
  }

}

/** Drop everything scoped to a finished run. */
function forgetRun(runId, sessionKey) {
  if (runId) runOrigins.delete(runId);
  if (!sessionKey) return;
  const active = activeRunBySession.get(sessionKey);
  if (active === undefined || !runId || active === runId) {
    activeRunBySession.delete(sessionKey);
  }
}

// Blocks already reported, keyed by session+tool, so a model that retries the
// same refused call does not turn into a notification storm.
const reportedBlocks = new Set();
const MAX_REPORTED_BLOCKS = 200;

/**
 * Tell the controller an automation run lost its shell.
 *
 * Fire-and-forget on purpose: the block itself must not depend on the
 * controller being reachable. Without this the user finds out from a missing
 * artifact instead of an error — the run "succeeded", it just could not do the
 * work.
 */
function reportAutomationBlock(api, controllerUrl, ctx, toolName, reason) {
  if (!controllerUrl || !ctx?.sessionKey) return;
  const dedupeKey = `${ctx.sessionKey}:${toolName}`;
  if (reportedBlocks.has(dedupeKey)) return;

  // Marked as reported only after the controller accepts it. Marking up front
  // makes a failed report permanent: the retry is suppressed and nothing ever
  // surfaces, which is the same silent outcome this reporter exists to remove.
  const url = `${controllerUrl.replace(/\/+$/, "")}/api/internal/runtime/host-execution-blocked`;
  void (async () => {
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey: ctx.sessionKey, toolName, reason }),
      });
      if (!response.ok) {
        try {
          api.logger.warn(
            `[nexu-toolcall-guard] automation block report rejected: HTTP ${response.status}`,
          );
        } catch {}
        return;
      }
      reportedBlocks.add(dedupeKey);
      if (reportedBlocks.size > MAX_REPORTED_BLOCKS) {
        const oldest = reportedBlocks.values().next().value;
        if (oldest !== undefined) reportedBlocks.delete(oldest);
      }
    } catch (error) {
      try {
        api.logger.warn(
          `[nexu-toolcall-guard] could not report automation block: ${error?.message ?? String(error)}`,
        );
      } catch {}
    }
  })();
}

// OpenClaw's own `group:runtime`. `code_execution` belongs here too — gating
// only exec/process would leave a third door to the same place.
const HOST_COMMAND_TOOLS = new Set(["exec", "process", "code_execution"]);

/**
 * Resolve the execution tier for a run, plus the signal that decided it.
 * `reason` is null for the host tier so callers can log a single shape.
 */
function resolveExecutionTier(ctx) {
  // Observed provenance first. It can only ever restrict: a run we did not
  // observe falls through to the signals below rather than being refused, so a
  // guard that loads mid-run or an OpenClaw restart cannot strand the desktop
  // user without host execution.
  const observed = ctx?.runId ? runOrigins.get(ctx.runId) : undefined;
  const observedReason = restrictedOriginReason(observed);
  if (observedReason) {
    return {
      tier: RESTRICTED_EXECUTION_TIER,
      reason: observedReason,
      originAgentId: observed?.agentId,
    };
  }

  const inherited = ctx?.sessionKey
    ? touchBounded(restrictedSessions, ctx.sessionKey)
    : undefined;
  if (inherited) {
    return {
      tier: RESTRICTED_EXECUTION_TIER,
      reason: inherited.reason,
      originAgentId: inherited.agentId,
    };
  }

  if (remoteChannelId(ctx)) {
    return {
      tier: RESTRICTED_EXECUTION_TIER,
      reason: "channel-origin",
      originAgentId: ctx?.agentId,
    };
  }
  if (AUTOMATION_SESSION_KEY_PATTERN.test(ctx?.sessionKey ?? "")) {
    return {
      tier: RESTRICTED_EXECUTION_TIER,
      reason: "automation-origin",
      originAgentId: ctx?.agentId,
    };
  }
  return { tier: HOST_EXECUTION_TIER, reason: null, originAgentId: undefined };
}

/**
 * A sub-session is never more trusted than the run that asked for it.
 * `subagent_spawned` is the supported observation point — `subagent_spawning`
 * is deprecated in 2026.7.1 and scheduled for removal.
 */
function inheritSubagentRestriction(event, ctx) {
  const childSessionKey = ctx?.childSessionKey || event?.childSessionKey;
  const requesterSessionKey = ctx?.requesterSessionKey;
  if (!childSessionKey || !requesterSessionKey) return null;

  // Intrinsic restriction, an in-flight trigger restriction (the only join
  // available: the spawn hook gives the requester's session key, not its run
  // id), then the requester's key shape.
  const requesterRunId = touchBounded(activeRunBySession, requesterSessionKey);
  const requesterOrigin = requesterRunId
    ? runOrigins.get(requesterRunId)
    : undefined;
  const requesterRunReason = restrictedOriginReason(requesterOrigin);

  const source =
    touchBounded(restrictedSessions, requesterSessionKey) ??
    (requesterRunReason
      ? { reason: requesterRunReason, agentId: requesterOrigin?.agentId }
      : null) ??
    (AUTOMATION_SESSION_KEY_PATTERN.test(requesterSessionKey)
      ? { reason: "automation-origin", agentId: event?.agentId }
      : null);
  if (!source) return null;

  const reason = source.reason.startsWith("inherited:")
    ? source.reason
    : `inherited:${source.reason}`;
  rememberBounded(
    restrictedSessions,
    childSessionKey,
    // The escape hatch stays bound to the bot that owns the restricted origin,
    // never the one the child happens to run as: `sessions_spawn` lets a
    // restricted run choose the child's agentId, which would otherwise let it
    // borrow another bot's opt-out.
    { reason, agentId: source.agentId },
    MAX_TRACKED_ORIGINS,
  );
  return reason;
}

// ---------------------------------------------------------------------------
// Write fence
//
// A tier that only covers `exec` is wrapped around the wrong thing: `write`
// reaches the same outcomes without a shell. These paths are the ones where a
// single file write converts into persistent code execution or silently
// disables this guard, and none of them has a legitimate agent-tool writer —
// SkillHub installs, plugin materialization, and schedule writes all go through
// the controller process. So the fence applies to EVERY tier, desktop included.
// ---------------------------------------------------------------------------
const FILE_MUTATION_TOOLS = new Set(["write", "edit", "apply_patch"]);

// The agent's own instruction files. Rewriting one is how a single injected
// turn becomes permanent: `workspace-template-writer` is strict seed-if-missing
// and never overwrites, so the poisoned copy survives every resync. HEARTBEAT.md
// is the sharpest of them — OpenClaw reads it on a timer, in the main session,
// with nobody watching, so a write there converts one message into a recurring
// unattended run. Restricted origins cannot touch them; the desktop user can,
// because editing your own assistant's instructions is the product working.
const AGENT_INSTRUCTION_FILES = new Set([
  "agents.md",
  "bootstrap.md",
  "heartbeat.md",
  "identity.md",
  "schedule.md",
  "soul.md",
  "tools.md",
  "user.md",
]);

// What a run that Nexu did not trust may call at all.
//
// Built from OpenClaw's own builtin tool groups minus the execution, control
// plane, and lateral-movement surfaces, plus Nexu's own reviewed plugin tools.
// It is an ALLOWlist on purpose: PR #17 removed `plugins.allow`, so OpenClaw
// now discovers every installed plugin and a user-installed MCP server that
// shells out would otherwise be arbitrary execution under a different name.
// Unknown tool ⇒ refused for restricted origins.
const RESTRICTED_ORIGIN_TOOL_ALLOWLIST = new Set([
  // fs — still subject to the write fence and the read fence
  "read",
  "write",
  "edit",
  "apply_patch",
  // web
  "web_search",
  "web_fetch",
  "x_search",
  // memory
  "memory_search",
  "memory_get",
  // conversation
  "message",
  "heartbeat_respond",
  "sessions_list",
  "sessions_history",
  "session_status",
  "sessions_yield",
  "sessions_spawn",
  "subagents",
  "agents_list",
  "update_plan",
  // media
  "image",
  "image_generate",
  "music_generate",
  "video_generate",
  "tts",
  // Nexu's own reviewed plugin tools
  "canvas",
  "canvas_op",
  "canvas_read",
  "render_a2ui",
  "find_expert",
]);

// Deliberately absent from the allowlist above, and worth naming: `sessions_send`
// injects a message into another session. From a restricted origin that is a
// direct escalation — it would hand attacker text to the desktop main session,
// which then runs at the host tier.

// Read fence. Blocking execution and persistence still leaves exfiltration:
// a restricted run needs no shell to `read` a credential file and hand it to
// `web_fetch`. These roots hold secrets in plain text and nothing an agent
// legitimately answers with, so restricted origins cannot read them at all.
// The desktop tier is NOT fenced here — the user asking their own assistant
// about their own config is the product working.
const FILE_READ_TOOLS = new Set(["read"]);
const PATH_PARAM_KEYS = new Set([
  "path",
  "file_path",
  "filePath",
  "target",
  "targetPath",
  "dest",
  "destination",
]);

/**
 * Collect candidate paths from a tool call. `derivedPaths` is the host's
 * cwd-aware extraction; its own docs call it a lenient hint rather than an
 * authoritative parse, so the params walk is unioned in rather than trusted
 * alone. Values are collected by KEY name only: collecting every path-shaped
 * string would fence a write whose *content* merely mentions a fenced path.
 */
function collectCandidatePaths(event) {
  const found = new Set();
  for (const derived of event?.derivedPaths ?? []) {
    if (typeof derived === "string" && derived) found.add(derived);
  }

  const visit = (value, key, depth) => {
    if (depth > 6 || value === null || value === undefined) return;
    if (typeof value === "string") {
      if (key !== null && PATH_PARAM_KEYS.has(key) && value) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, key, depth + 1);
      return;
    }
    if (typeof value === "object") {
      for (const [childKey, childValue] of Object.entries(value)) {
        visit(childValue, childKey, depth + 1);
      }
    }
  };
  visit(event?.params, null, 0);

  return [...found];
}

/**
 * Resolve as far as the filesystem allows. A fenced target that does not exist
 * yet still resolves through its nearest existing ancestor, so a symlinked
 * parent cannot be used to step around the fence.
 *
 * `baseDir` resolves relative candidates. `write` and `edit` accept "relative
 * or absolute" paths and the host only derives paths for `apply_patch`, so
 * dropping non-absolute candidates would leave the fence trivially bypassable
 * with `../../openclaw.json`.
 */
function resolveFenceCandidate(candidate, baseDir = null) {
  const expanded = candidate.startsWith("~/")
    ? path.join(os.homedir(), candidate.slice(2))
    : candidate;

  let absolute = expanded;
  if (!path.isAbsolute(absolute)) {
    // Without the run's workspace there is nothing to resolve against.
    // Blocking every relative write instead would break ordinary desktop work,
    // which is the more severe failure; the gap is logged at registration.
    if (!baseDir) return null;
    absolute = path.resolve(baseDir, absolute);
  }

  let current = path.resolve(absolute);
  const trailing = [];
  for (let depth = 0; depth < 64; depth += 1) {
    try {
      return path.join(realpathSync(current), ...trailing);
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return path.resolve(absolute);
      trailing.unshift(path.basename(current));
      current = parent;
    }
  }
  return path.resolve(absolute);
}

// macOS and Windows default to case-insensitive filesystems, so a
// case-sensitive containment test is bypassable with `.../Extensions/...`.
const CASE_INSENSITIVE_FS =
  process.platform === "darwin" || process.platform === "win32";

function normalizeForCompare(value) {
  return CASE_INSENSITIVE_FS ? value.toLowerCase() : value;
}

function isWithin(root, target) {
  if (!root || !path.isAbsolute(root)) return false;
  const resolvedRoot = normalizeForCompare(
    resolveFenceCandidate(root) ?? path.resolve(root),
  );
  const resolvedTarget = normalizeForCompare(target);
  return (
    resolvedTarget === resolvedRoot ||
    resolvedTarget.startsWith(`${resolvedRoot}${path.sep}`)
  );
}

/** Build the fence from plugin config, falling back to runtime env. */
function resolveFence(pluginConfig) {
  const stateDir =
    pluginConfig?.fence?.stateDir || process.env.OPENCLAW_STATE_DIR || "";
  const nexuHome = pluginConfig?.fence?.nexuHome || process.env.NEXU_HOME || "";
  const userSkillsDir =
    pluginConfig?.fence?.userSkillsDir ||
    path.join(os.homedir(), ".agents", "skills");
  const extra = Array.isArray(pluginConfig?.fence?.extraRoots)
    ? pluginConfig.fence.extraRoots.filter(
        (entry) => typeof entry === "string" && entry,
      )
    : [];

  const roots = [...extra];
  if (stateDir) {
    // The guard's own source, the compiled runtime config, and the hot-reloaded
    // skills directory: writing any of them survives the current turn.
    roots.push(path.join(stateDir, "extensions"));
    roots.push(path.join(stateDir, "openclaw.json"));
    roots.push(path.join(stateDir, "skills"));
  }
  if (nexuHome) roots.push(nexuHome);
  if (userSkillsDir) roots.push(userSkillsDir);

  // The agent workspace is `<stateDir>/agents/<agentId>` and OPENCLAW_STATE_DIR
  // is nested INSIDE NEXU_HOME under `pnpm start` and under the controller's
  // own default. Without this carve-out the nexuHome root swallows the entire
  // workspace and the desktop user cannot write a single file into their own
  // bot — the worst failure this policy can have. Allow-roots win over fence
  // roots, so ordering of the two lists does not matter.
  const workspaceRoot = stateDir ? path.join(stateDir, "agents") : "";
  const allowRoots = workspaceRoot ? [workspaceRoot] : [];

  // Secret-bearing roots. `<nexuHome>/config.json` holds channel app secrets in
  // plain text; the rest are the usual credential stores.
  const home = os.homedir();
  const readRoots = [
    nexuHome,
    stateDir ? path.join(stateDir, "openclaw.json") : "",
    path.join(home, ".ssh"),
    path.join(home, ".aws"),
    path.join(home, "Library", "Keychains"),
  ].filter((root) => root && path.isAbsolute(root));

  return {
    roots: roots.filter((root) => root && path.isAbsolute(root)),
    allowRoots,
    readRoots,
    workspaceRoot,
  };
}

/**
 * Per-bot opt-out, delivered through the controller-written plugin config.
 *
 * `reason` decides which switch applies: a channel-driven run is governed by
 * `channels`, an unattended one by `automations`. Anything else (an inherited
 * restriction whose root is unknown) stays refused — an escape hatch that
 * fires on reasons it was not written for is not an escape hatch.
 */
function isHostExecutionAllowed(hostExecution, originAgentId, reason) {
  if (!originAgentId || !reason) return false;
  const setting = hostExecution?.[originAgentId];
  if (!setting) return false;
  if (isAutomationReason(reason)) return setting.automations === "host";
  if (isChannelReason(reason)) return setting.channels === "host";
  return false;
}

/** The run's own workspace, used to resolve relative candidates. */
function resolveWorkspaceDir(ctx, fence) {
  if (!fence.workspaceRoot || !ctx?.agentId) return null;
  return path.join(fence.workspaceRoot, ctx.agentId);
}

/** Instruction files inside this run's own workspace, if any. */
function findFencedInstructionFile(event, ctx, fence) {
  if (!FILE_MUTATION_TOOLS.has(event?.toolName)) return null;
  const baseDir = resolveWorkspaceDir(ctx, fence);
  for (const candidate of collectCandidatePaths(event)) {
    const resolved = resolveFenceCandidate(candidate, baseDir);
    if (!resolved) continue;
    if (AGENT_INSTRUCTION_FILES.has(path.basename(resolved).toLowerCase())) {
      return { candidate, file: path.basename(resolved) };
    }
  }
  return null;
}

function findFencedPath(event, ctx, fence, roots) {
  const baseDir = resolveWorkspaceDir(ctx, fence);

  for (const candidate of collectCandidatePaths(event)) {
    const resolved = resolveFenceCandidate(candidate, baseDir);
    if (!resolved) continue;
    if (fence.allowRoots.some((allowed) => isWithin(allowed, resolved))) {
      continue;
    }
    for (const root of roots) {
      if (isWithin(root, resolved)) return { candidate, root };
    }
  }
  return null;
}

const plugin = {
  id: "nexu-toolcall-guard",
  name: "Nexu Tool Call Guard",
  description:
    "Breaks infinite tool-call retry loops caused by models that repeatedly fail argument validation.",
  register(api) {
    const configured = Number(api.pluginConfig?.threshold);
    const threshold =
      Number.isFinite(configured) && configured >= 2
        ? Math.floor(configured)
        : DEFAULT_THRESHOLD;

    const fence = resolveFence(api.pluginConfig);
    const controllerUrl =
      typeof api.pluginConfig?.controllerUrl === "string"
        ? api.pluginConfig.controllerUrl
        : "";
    const hostExecution =
      api.pluginConfig?.hostExecution &&
      typeof api.pluginConfig.hostExecution === "object"
        ? api.pluginConfig.hostExecution
        : {};
    // Exact session keys allowed to drive the embedded browser from a
    // channel: the paired owner's Feishu DMs. Compiled by the controller as
    // full `agent:<bot>:direct:<open_id>` keys; anything not in that shape is
    // dropped here so a mis-compiled entry can only fail closed. This widens
    // ONLY the browser tools — desktop control and the runtime control plane
    // stay desktop-session-only regardless of this list.
    const browserOwnerSessions = new Set(
      (Array.isArray(api.pluginConfig?.browserOwnerSessions)
        ? api.pluginConfig.browserOwnerSessions
        : []
      ).filter(
        (key) =>
          typeof key === "string" &&
          /^agent:[^:]+:direct:[^:]+$/i.test(key),
      ),
    );

    try {
      api.logger.info(
        `[nexu-toolcall-guard] loaded — tripping after ${threshold} consecutive validation failures; ` +
          `write fence covers ${fence.roots.length} root(s), workspace ${fence.workspaceRoot || "<unknown>"} exempt; ` +
            `automation block reporting ${controllerUrl ? `-> ${controllerUrl}` : "DISABLED (no controllerUrl in plugin config)"}`,
      );
    } catch {}

    // Phase 1: accumulate consecutive same-tool, no-progress validation failures.
    api.on("after_tool_call", async (event, ctx) => {
      trackComputerCompletion(event, ctx);
      const runId = ctx?.runId || event?.runId;
      if (!runId) return;

      if (!isValidationFailure(event?.error)) {
        // Success, or any non-validation error, or a different outcome:
        // the model is making progress — reset this run's streak.
        runFailures.delete(runId);
        return;
      }

      const toolName = event?.toolName;
      const paramsHash = stableHash(event?.params);
      const prev = runFailures.get(runId);

      if (prev && prev.toolName === toolName && prev.paramsHash === paramsHash) {
        // Same tool, same arguments → no progress.
        prev.count += 1;
      } else {
        // New tool or changed arguments → start a fresh streak.
        runFailures.set(runId, { toolName, count: 1, paramsHash });
      }

      const rec = runFailures.get(runId);
      if (rec.count >= threshold) {
        try {
          api.logger.warn(
            `[nexu-toolcall-guard] tool "${toolName}" failed validation ${rec.count}x with no progress in run ${runId} — next call will be blocked`,
          );
        } catch {}
      }

      // Bound memory: evict the oldest tracked run if we somehow leak.
      if (runFailures.size > MAX_TRACKED_RUNS) {
        const oldest = runFailures.keys().next().value;
        if (oldest !== undefined) runFailures.delete(oldest);
      }
    });

    // Phase 2: once tripped, block further no-progress calls to the same tool.
    api.on("before_tool_call", async (event, ctx) => {
      const fenced = FILE_MUTATION_TOOLS.has(event?.toolName)
        ? findFencedPath(event, ctx, fence, fence.roots)
        : null;
      if (fenced) {
        try {
          api.logger.warn(
            `[nexu-toolcall-guard] BLOCKING fenced write via "${event.toolName}" to ${fenced.candidate} (fence root ${fenced.root})`,
          );
        } catch {}
        return {
          block: true,
          blockReason:
            "该路径属于 Nexu 运行时的受保护区域（运行时插件、运行时配置、技能目录或 Nexu 主目录），任何会话都不能通过文件工具写入。请改用 Nexu 桌面端对应的设置或管理入口。",
        };
      }

      // Everything below is scoped to runs Nexu did not trust.
      const restricted = resolveExecutionTier(ctx);
      const restrictedAndNotOptedIn =
        restricted.tier === RESTRICTED_EXECUTION_TIER &&
        !isHostExecutionAllowed(
          hostExecution,
          restricted.originAgentId,
          restricted.reason,
        );

      if (restrictedAndNotOptedIn) {
        const instructionFile = findFencedInstructionFile(event, ctx, fence);
        if (instructionFile) {
          try {
            api.logger.warn(
              `[nexu-toolcall-guard] BLOCKING instruction-file write via "${event.toolName}" to ${instructionFile.file} ` +
                `(reason=${restricted.reason})`,
            );
          } catch {}
          return {
            block: true,
            blockReason:
              "外部渠道和无人值守的运行不能修改机器人的行为说明文件（AGENTS.md、HEARTBEAT.md 等）。这类修改会长期改变机器人的行为，请由用户在 Nexu 桌面端完成。",
          };
        }

        if (
          event?.toolName &&
          !RESTRICTED_ORIGIN_TOOL_ALLOWLIST.has(event.toolName) &&
          !isLocalAutomationTool(event.toolName) &&
          !HOST_COMMAND_TOOLS.has(event.toolName) &&
          !HOST_EXECUTION_TOOLS.has(event.toolName)
        ) {
          // Unknown tool: an MCP server or third-party plugin. Since PR #17
          // removed `plugins.allow`, the compiled config no longer enumerates
          // the tool surface, so anything not on the reviewed list fails closed
          // rather than becoming execution under a different name.
          try {
            api.logger.warn(
              `[nexu-toolcall-guard] BLOCKING unreviewed tool "${event.toolName}" for a restricted origin ` +
                `(reason=${restricted.reason})`,
            );
          } catch {}
          return {
            block: true,
            blockReason:
              "该工具不在 Nexu 为外部渠道和自动化审核过的能力清单中（例如用户自行安装的 MCP 工具）。请让用户在 Nexu 桌面主会话中完成这一步。",
          };
        }
      }

      if (FILE_READ_TOOLS.has(event?.toolName)) {
        const { tier } = resolveExecutionTier(ctx);
        if (tier === RESTRICTED_EXECUTION_TIER) {
          const secret = findFencedPath(event, ctx, fence, fence.readRoots);
          if (secret) {
            try {
              api.logger.warn(
                `[nexu-toolcall-guard] BLOCKING fenced read via "${event.toolName}" to ${secret.candidate} (read root ${secret.root})`,
              );
            } catch {}
            return {
              block: true,
              blockReason:
                "外部渠道和无人值守的运行不能读取 Nexu 的配置与凭据目录。请让用户在 Nexu 桌面主会话中处理这类内容。",
            };
          }
        }
      }

      if (HOST_COMMAND_TOOLS.has(event?.toolName)) {
        const { tier, reason, originAgentId } = resolveExecutionTier(ctx);
        if (
          tier === RESTRICTED_EXECUTION_TIER &&
          isHostExecutionAllowed(hostExecution, originAgentId, reason)
        ) {
          try {
            api.logger.info(
              `[nexu-toolcall-guard] host execution allowed for "${event.toolName}" by per-bot setting ` +
                `(originAgentId=${originAgentId ?? "<none>"} reason=${reason})`,
            );
          } catch {}
        } else if (tier === RESTRICTED_EXECUTION_TIER) {
          try {
            api.logger.warn(
              `[nexu-toolcall-guard] BLOCKING host execution tool "${event.toolName}" — tier=${tier} reason=${reason} ` +
                `(sessionKey=${ctx?.sessionKey ?? "<none>"} channelId=${ctx?.channelId ?? "<none>"})`,
            );
          } catch {}
          if (isAutomationReason(reason)) {
            reportAutomationBlock(
              api,
              controllerUrl,
              ctx,
              event.toolName,
              reason,
            );
          }
          return {
            block: true,
            blockReason:
              isAutomationReason(reason)
                ? "定时任务、心跳和其他无人值守的运行不能在本机执行命令。请让用户在 Nexu 桌面主会话中手动执行这一步。"
                : "外部渠道的消息不能在用户本机执行命令。请让用户在 Nexu 桌面主会话中完成需要本机执行的操作。",
          };
        }
      }

      if (
        isLocalAutomationTool(event?.toolName) &&
        !isApprovedLocalAutomationTool(event?.toolName)
      ) {
        try {
          api.logger.warn(
            `[nexu-toolcall-guard] BLOCKING unapproved local automation tool "${event.toolName}"`,
          );
        } catch {}
        return {
          block: true,
          blockReason:
            "该本机自动化工具不在 Nexu 审核过的能力清单中，已阻止调用。请使用设置中已授权的电脑控制或浏览器控制能力。",
        };
      }

      const protectedLocalTool =
        isLocalAutomationTool(event?.toolName) ||
        HOST_EXECUTION_TOOLS.has(event?.toolName);
      // Owner-DM carve-out: the paired owner's own Feishu DM may use the
      // embedded browser. Exact-key membership means group chats, forks
      // (`agent:<bot>:fork:<uuid>`), sub-agents and every other channel shape
      // stay blocked, and the carve-out never extends past the browser tool
      // set — a whitelisted DM still cannot touch desktop control or the
      // runtime control plane.
      if (
        EMBEDDED_BROWSER_TOOLS.has(event?.toolName) &&
        browserOwnerSessions.has(ctx?.sessionKey ?? "")
      ) {
        try {
          api.logger.info(
            `[nexu-toolcall-guard] embedded browser allowed for owner DM ` +
              `(tool=${event.toolName} sessionKey=${ctx?.sessionKey})`,
          );
        } catch {}
      } else if (protectedLocalTool && !isLocalInteractiveSession(ctx)) {
        try {
          // Name the failing condition: a refusal that does not say which of
          // "wrong channel" or "wrong session shape" tripped is guesswork to
          // debug from a transcript.
          api.logger.warn(
            `[nexu-toolcall-guard] BLOCKING protected local tool "${event.toolName}" outside the desktop main session ` +
              `(sessionKey=${ctx?.sessionKey ?? "<none>"} channelId=${ctx?.channelId ?? "<none>"})`,
          );
        } catch {}

        return {
          block: true,
          blockReason: HOST_EXECUTION_TOOLS.has(event?.toolName)
            ? "外部渠道、子会话和来源不明的调用不能直接操作 Nexu 运行时控制面。请让用户在 Nexu 桌面主会话中完成节点、网关或定时任务管理。"
            : "本机浏览器和桌面控制只允许从 Nexu 桌面主会话调用。外部渠道、子会话和来源不明的调用默认被拒绝。请让用户在桌面端打开对应机器人的主会话后重试；如果用户希望在自己的飞书私聊中使用内置浏览器，可以在桌面端渠道设置中把自己的飞书账号加入浏览器白名单。",
        };
      }

      const runId = ctx?.runId || event?.runId;
      if (!runId) return;

      const rec = runFailures.get(runId);
      if (!rec || rec.toolName !== event?.toolName || rec.count < threshold) {
        trackComputerStart(event, ctx);
        return;
      }

      // Only block if there is still no progress: arguments unchanged from the
      // failing call, or still empty. If the model finally produced different,
      // non-empty arguments, let it through (it may have self-corrected).
      const paramsHash = stableHash(event?.params);
      if (paramsHash !== rec.paramsHash && !isEmptyParams(event?.params)) {
        trackComputerStart(event, ctx);
        return;
      }

      try {
        api.logger.warn(
          `[nexu-toolcall-guard] BLOCKING tool "${event.toolName}" in run ${runId} after ${rec.count} consecutive validation failures`,
        );
      } catch {}

      return {
        block: true,
        blockReason:
          `工具「${event.toolName}」已连续 ${rec.count} 次因参数校验失败被调用（生成的参数为空或始终没有变化），已阻止继续重试以避免无限循环。` +
          `请立即停止调用该工具，并直接用纯文本回复用户：当前所选模型无法正确生成工具调用参数，请在「设置 → AI 模型」中更换为支持工具调用的模型（如 DeepSeek、Claude 等）后再试。`,
      };
    });

    api.on("before_message_write", (event, ctx) => {
      const key = completionStateKey(ctx);
      const state = key ? pendingComputerRuns.get(key) : null;
      const message = event?.message;
      if (
        !state ||
        (state.pending.length === 0 && state.inFlight.size === 0) ||
        message?.role !== "assistant" ||
        message?.stopReason === "toolUse" ||
        assistantMessageHasToolCall(message)
      ) {
        return;
      }

      // An in-flight mutation never returned, so the action may not even have
      // been delivered — that outranks any per-action verifiability question.
      const hasObtainableEvidenceGap =
        state.inFlight.size > 0 ||
        state.pending.some(
          (pending) =>
            pending.failed || !UNVERIFIABLE_ACTION_TOOLS.has(pending.toolName),
        );

      if (!hasObtainableEvidenceGap) {
        try {
          api.logger.warn(
            `[nexu-toolcall-guard] appending unverifiable-action notice in run ${state.runId}; pending=${state.pending.length}`,
          );
        } catch {}
        return {
          message: {
            ...message,
            content: [
              ...(Array.isArray(message.content) ? message.content : []),
              { type: "text", text: UNVERIFIABLE_COMPUTER_ACTION_NOTICE },
            ],
          },
        };
      }

      try {
        api.logger.warn(
          `[nexu-toolcall-guard] replacing unverified computer-use completion in run ${state.runId}; pending=${state.pending.length}; inFlight=${state.inFlight.size}`,
        );
      } catch {}
      return {
        message: {
          ...message,
          content: [
            {
              type: "text",
              text: `${UNVERIFIED_COMPUTER_ACTION_MESSAGE}${describeEvidenceGaps(state)}`,
            },
          ],
        },
      };
    });

    // Run provenance. The tool context carries neither `trigger` nor lineage,
    // so what started a run is observed here and looked up at tool-call time.
    // Several hooks are registered because the runtime marks some of them
    // deprecated (`before_agent_start` is already flagged for removal) and
    // because recording is idempotent and can only restrict — observing the
    // same run twice costs nothing, missing it entirely would silently drop
    // the heartbeat and cron gates.
    for (const hookName of [
      "before_model_resolve",
      "before_prompt_build",
      "before_agent_start",
    ]) {
      api.on(hookName, async (_event, ctx) => {
        recordRunOrigin(ctx);
      });
    }

    // Sessions that end release their restriction; the size bound is only a
    // backstop for sessions that never report an end.
    api.on("subagent_ended", async (event, ctx) => {
      const key = event?.targetSessionKey || ctx?.childSessionKey;
      if (key) {
        restrictedSessions.delete(key);
        activeRunBySession.delete(key);
      }
    });

    api.on("session_end", async (event, ctx) => {
      const key = ctx?.sessionKey || event?.sessionKey;
      if (key) {
        restrictedSessions.delete(key);
        activeRunBySession.delete(key);
      }
    });

    api.on("subagent_spawned", async (event, ctx) => {
      const inherited = inheritSubagentRestriction(event, ctx);
      if (!inherited) return;
      try {
        api.logger.warn(
          `[nexu-toolcall-guard] sub-session ${ctx?.childSessionKey ?? "<unknown>"} inherits ${inherited} from ${ctx?.requesterSessionKey ?? "<unknown>"}`,
        );
      } catch {}
    });

    // Phase 3: clean up when the run ends.
    api.on("agent_end", async (event, ctx) => {
      const runId = ctx?.runId || event?.runId;
      if (runId) runFailures.delete(runId);
      forgetRun(runId, ctx?.sessionKey);
      const key = completionStateKey(ctx);
      if (key) pendingComputerRuns.delete(key);
    });
  },
};

export default plugin;
