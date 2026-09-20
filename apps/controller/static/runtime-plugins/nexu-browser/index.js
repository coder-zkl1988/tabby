// nexu-browser runtime plugin: let the chat agent drive the browser panel
// embedded in the Nexu desktop app.
//
// Every tool POSTs to the controller, which relays the command to the desktop
// main process and returns what the browser view saw afterwards. The panel is
// what puts that view on screen, so the user always watches the agent browse —
// see apps/controller/src/routes/agent-browser-routes.ts.
//
// This plugin does not touch any browser outside the app. Control of the
// user's own Chrome was deliberately dropped: it needed an extension, a
// pairing step, and a dedicated tab group, and it still handed the agent every
// logged-in session the user had.

const ACT_PATH = "/api/v1/browser/agent/act";

/** Controller base URL, injected via plugin config by the compiler. */
let configuredControllerUrl = null;

function controllerOrigin() {
  const raw =
    configuredControllerUrl ||
    process.env.NEXU_CONTROLLER_URL ||
    process.env.CONTROLLER_URL ||
    "";
  return raw.replace(/\/+$/, "");
}

function textResult(text, isError) {
  const result = { content: [{ type: "text", text }] };
  if (isError) result.isError = true;
  return result;
}

/**
 * toolCallId -> session context captured in `before_tool_call`.
 *
 * The tool's `execute` only receives the call id and params, but the command
 * has to carry a session key: the controller refuses anything that is not the
 * desktop main session.
 */
const callContexts = new Map();

// Exact channel-shaped session keys allowed to drive the browser: the paired
// owner's Feishu DMs, compiled by the controller as full
// `agent:<bot>:direct:<open_id>` keys. Independent fail-closed copy of the
// toolcall guard's decision — a key must pass BOTH layers, and anything not
// in the direct-DM shape is dropped on load so a bad entry cannot widen this.
let browserOwnerSessions = new Set();
const MAX_TRACKED_CALLS = 200;

/**
 * Sessions whose current run drove the browser. On `agent_end` these get a
 * one-way run-ended signal so the desktop can release the panel's agent pin —
 * without it the panel stays glued across routes long after the agent
 * finished. Best-effort: a missed signal leaves the pin, nothing worse.
 */
const browserSessions = new Set();

function rememberCallContext(toolCallId, ctx) {
  if (!toolCallId) return;
  callContexts.set(toolCallId, {
    sessionKey: ctx?.sessionKey ?? null,
    channelId: ctx?.channelId ?? null,
  });
  if (callContexts.size > MAX_TRACKED_CALLS) {
    const oldest = callContexts.keys().next().value;
    if (oldest !== undefined) callContexts.delete(oldest);
  }
}

/** One element on one line: ref, role, name, then whatever state it carries. */
function renderNode(node) {
  const value = node.value ? ` = ${JSON.stringify(node.value)}` : "";
  const href = node.href ? ` → ${node.href}` : "";
  const checked =
    node.checked === undefined ? "" : node.checked ? " [checked]" : " [unchecked]";
  const disabled = node.disabled ? " [disabled]" : "";
  return `${node.ref} ${node.role} ${JSON.stringify(node.name)}${value}${href}${checked}${disabled}`;
}

/**
 * Renders a snapshot as indented lines. Cheaper than the raw JSON and easier
 * for a model to scan, while keeping every ref addressable.
 */
function renderSnapshot(snapshot) {
  const lines = [
    `${snapshot.title || "(untitled)"} — ${snapshot.url}`,
    snapshot.visibleOnly
      ? "Elements in the current viewport (browser_scroll to reach the rest; act on a ref with browser_click / browser_type / browser_select / browser_press):"
      : "Elements (act on a ref with browser_click / browser_type / browser_select / browser_press):",
  ];
  for (const node of snapshot.nodes) {
    const indent = "  ".repeat(Math.min(node.depth, 8));
    lines.push(`${indent}${renderNode(node)}`);
  }
  if (snapshot.nodes.length === 0) {
    lines.push(
      "(no readable elements — the page may still be loading, or draws itself on a canvas; try browser_screenshot)",
    );
  }
  if (snapshot.truncated) {
    lines.push(
      `(cut off after ${snapshot.nodes.length} elements — call browser_snapshot with a larger maxNodes, or visibleOnly=true to list only what is on screen)`,
    );
  }
  return lines.join("\n");
}

/**
 * Renders what an action left behind.
 *
 * `expectElement` says whether the action targeted a ref: a key press into
 * whatever has focus or a history move has no element to report, and "the
 * element is no longer on the page" would be a false alarm there.
 */
function renderObservation(observation, options = {}) {
  const expectElement = options.expectElement !== false;
  const lines = [`${observation.title || "(untitled)"} — ${observation.url}`];
  if (observation.navigated) {
    lines.push(
      "The page navigated to a new document; earlier refs are gone — take a snapshot before acting again.",
    );
  } else if (observation.changedInPlace) {
    lines.push(
      "The page updated in place (same document, refs still valid) — take a snapshot to read the new content.",
    );
  }
  if (observation.loading) {
    lines.push(
      "The page was still loading when this was read; snapshot again if something is missing.",
    );
  }
  for (const dialog of observation.dialogs ?? []) {
    const handled =
      dialog.type === "alert"
        ? "closed automatically"
        : dialog.type === "beforeunload"
          ? "the page was allowed to leave"
          : "dismissed automatically (treated as Cancel)";
    lines.push(
      `A ${dialog.type} dialog appeared and was ${handled}: ${JSON.stringify(dialog.message)}. Tell the user if it needed a real answer.`,
    );
  }
  for (const error of observation.pageErrors ?? []) {
    const where = error.source ? ` (${error.source})` : "";
    lines.push(
      `The page's own code threw an error, so whatever it was doing stopped part way: ${error.message}${where}`,
    );
    // Not a broken page: Electron has no prompt() at all, so a page asking for
    // typed input this way always fails here. Without saying so the model
    // reports the site as broken and retries the same click.
    if (/prompt\(\) is not supported/iu.test(error.message)) {
      lines.push(
        "That error is a limit of this browser, not a broken site: the page tried to ask the user to type something into a popup, which the embedded browser cannot show. Say what it was asking for and let the user do that step, or look for the same action elsewhere on the page. Repeating the click will fail the same way.",
      );
    }
  }
  if (observation.scroll) {
    const { y, maxY } = observation.scroll;
    const where =
      maxY <= 0
        ? " (the page does not scroll)"
        : y >= maxY
          ? " (bottom of the page)"
          : y <= 0
            ? " (top of the page)"
            : "";
    lines.push(`Scroll position ${y} of ${maxY}px${where}.`);
  }
  if (observation.element) {
    lines.push(`Element now: ${renderNode(observation.element)}`);
  } else if (expectElement && !observation.navigated) {
    lines.push("The element is no longer on the page.");
  }
  return lines.join("\n");
}

function renderScreenshot(screenshot) {
  return {
    content: [
      {
        type: "text",
        text: `${screenshot.title || "(untitled)"} — ${screenshot.url} (screenshot ${screenshot.width}×${screenshot.height})`,
      },
      { type: "image", data: screenshot.base64, mimeType: screenshot.mimeType },
    ],
  };
}

async function act(toolCallId, command, render = {}) {
  const origin = controllerOrigin();
  if (!origin) {
    return textResult("browser unavailable (controller URL not configured)", true);
  }
  const context = callContexts.get(toolCallId);
  const ownerDm =
    Boolean(context?.sessionKey) &&
    browserOwnerSessions.has(context.sessionKey);
  if (!context?.sessionKey || (context.channelId && !ownerDm)) {
    return textResult(
      "The embedded browser can only be driven from the Nexu desktop main session.",
      true,
    );
  }

  browserSessions.add(context.sessionKey);

  let response;
  try {
    response = await fetch(`${origin}${ACT_PATH}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionKey: context.sessionKey, command }),
    });
  } catch {
    return textResult("browser unavailable (controller unreachable)", true);
  }

  let payload = null;
  try {
    payload = await response.json();
  } catch {
    payload = null;
  }
  if (!response.ok) {
    return textResult(
      payload?.message
        ? `browser command failed: ${payload.message}`
        : `browser command failed (${response.status})`,
      true,
    );
  }
  if (!payload || payload.ok !== true) {
    return textResult(
      `browser command failed: ${payload?.error ?? "unknown error"}`,
      true,
    );
  }
  if (payload.snapshot) return textResult(renderSnapshot(payload.snapshot));
  if (payload.screenshot) return renderScreenshot(payload.screenshot);
  if (payload.observation) {
    return textResult(renderObservation(payload.observation, render));
  }
  return textResult("done");
}

const REF_NOTE =
  "Refs come from browser_open / browser_snapshot and stay valid until the page navigates.";

const EVIDENCE_NOTE =
  "Returns the page URL and the element's state afterwards — report what came back, do not assume success.";

const BROWSER_TOOL_NAMES = [
  "browser_open",
  "browser_snapshot",
  "browser_screenshot",
  "browser_click",
  "browser_type",
  "browser_press",
  "browser_select",
  "browser_hover",
  "browser_scroll",
  "browser_navigate",
];

function refParam(description = "Element ref, e.g. e12") {
  return { type: "string", description };
}

function readRef(params, tool) {
  const ref = typeof params?.ref === "string" ? params.ref.trim() : "";
  if (!ref) throw new Error(`${tool} requires a ref.`);
  return ref;
}

const plugin = {
  id: "nexu-browser",
  name: "Nexu Embedded Browser",
  description:
    "Registers the browser_* tools (open, snapshot, screenshot, click, type, press, select, hover, scroll, navigate) so the chat agent can drive the browser panel embedded in the Nexu desktop app.",
  register(api) {
    const cfg = api?.pluginConfig;
    if (cfg && typeof cfg.controllerUrl === "string" && cfg.controllerUrl) {
      configuredControllerUrl = cfg.controllerUrl;
    }
    browserOwnerSessions = new Set(
      (Array.isArray(cfg?.browserOwnerSessions)
        ? cfg.browserOwnerSessions
        : []
      ).filter(
        (key) =>
          typeof key === "string" &&
          /^agent:[^:]+:direct:[^:]+$/i.test(key),
      ),
    );

    api.on("before_tool_call", (event, ctx) => {
      if (!event?.toolName?.startsWith("browser_")) return;
      rememberCallContext(event.toolCallId ?? ctx?.toolCallId, ctx);
    });

    api.on("agent_end", (event, ctx) => {
      const sessionKey = ctx?.sessionKey ?? event?.sessionKey;
      if (!sessionKey || !browserSessions.delete(sessionKey)) return;
      const origin = controllerOrigin();
      if (!origin) return;
      void fetch(`${origin}/api/v1/browser/agent/run-ended`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sessionKey }),
      }).catch(() => {
        // Best-effort; a missed release leaves the panel pinned, not broken.
      });
    });

    const registerBrowserTools = () => [
      {
        name: "browser_open",
        label: "Open in browser",
        description: `Open a web page in the browser panel inside the Nexu desktop app, and return the page's elements. Opens the panel if it is closed, so the user sees the page you are working with. Use this instead of asking the user to open a link. Returns the same element listing as browser_snapshot.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            url: {
              type: "string",
              description: "The page to open, e.g. https://example.com",
            },
          },
          required: ["url"],
        },
        async execute(toolCallId, params) {
          const url = typeof params?.url === "string" ? params.url.trim() : "";
          if (!url) return textResult("browser_open requires a url.", true);
          return act(toolCallId, { action: "open", url });
        },
      },
      {
        name: "browser_snapshot",
        label: "Read page",
        description: `Read the current page in the Nexu browser panel: every interactive and named element with a ref you can act on, links with their destination. Call this after a page changes in a way you need to see in full — click and type already report the element they touched. Long pages: pass visibleOnly=true to list only what is on screen and browser_scroll between reads, or raise maxNodes.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            maxNodes: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              description:
                "Most elements to return. Default 400; raise it when a listing was cut off.",
            },
            visibleOnly: {
              type: "boolean",
              description:
                "Only elements currently inside the viewport. Default false.",
            },
          },
        },
        async execute(toolCallId, params) {
          const command = { action: "snapshot" };
          const maxNodes = Number(params?.maxNodes);
          if (Number.isInteger(maxNodes) && maxNodes >= 1 && maxNodes <= 1000) {
            command.maxNodes = maxNodes;
          }
          if (params?.visibleOnly === true) command.visibleOnly = true;
          return act(toolCallId, command);
        },
      },
      {
        name: "browser_screenshot",
        label: "Screenshot page",
        description: `See the Nexu browser panel as the user sees it: a screenshot of the current viewport. Use it when the element listing is not enough — charts, maps, canvases, images, layout questions, or a page that lists no readable elements. NO arguments.`,
        parameters: { type: "object", additionalProperties: false, properties: {} },
        async execute(toolCallId) {
          return act(toolCallId, { action: "screenshot" });
        },
      },
      {
        name: "browser_click",
        label: "Click element",
        description: `Click an element in the Nexu browser panel. ${EVIDENCE_NOTE} A click that navigated reports the new page and no element. ${REF_NOTE}`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { ref: refParam() },
          required: ["ref"],
        },
        async execute(toolCallId, params) {
          let ref;
          try {
            ref = readRef(params, "browser_click");
          } catch (error) {
            return textResult(error.message, true);
          }
          return act(toolCallId, { action: "click", ref });
        },
      },
      {
        name: "browser_type",
        label: "Type into element",
        description: `Type text into a field in the Nexu browser panel. Replaces whatever the field already contains unless append is true. Set submit to press Enter afterwards — search boxes and forms need it. Returns that element's value afterwards, which is your evidence the text landed. ${REF_NOTE}`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            ref: refParam(),
            text: { type: "string", description: "Text to type" },
            submit: {
              type: "boolean",
              description: "Press Enter after typing. Default false.",
            },
            append: {
              type: "boolean",
              description:
                "Keep the field's existing text and add to it. Default false (replace).",
            },
          },
          required: ["ref", "text"],
        },
        async execute(toolCallId, params) {
          const ref = typeof params?.ref === "string" ? params.ref.trim() : "";
          const text = typeof params?.text === "string" ? params.text : null;
          if (!ref || text === null) {
            return textResult("browser_type requires a ref and text.", true);
          }
          return act(toolCallId, {
            action: "type",
            ref,
            text,
            submit: params?.submit === true,
            append: params?.append === true,
          });
        },
      },
      {
        name: "browser_press",
        label: "Press key",
        description: `Press a key in the Nexu browser panel: Enter, Tab, Escape, Backspace, Delete, ArrowUp/ArrowDown/ArrowLeft/ArrowRight, Home, End, PageUp, PageDown, Space, a single character, or a chord like "Shift+Tab" or "Control+A". Give a ref to focus that element first; otherwise the key goes to whatever has focus. Use it for menus, autocomplete lists, dismissing overlays (Escape) and keyboard-only forms.`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            key: { type: "string", description: 'Key or chord, e.g. "Enter", "ArrowDown", "Shift+Tab"' },
            ref: refParam("Element to focus before pressing (optional)"),
          },
          required: ["key"],
        },
        async execute(toolCallId, params) {
          const key = typeof params?.key === "string" ? params.key.trim() : "";
          if (!key) return textResult("browser_press requires a key.", true);
          const ref = typeof params?.ref === "string" ? params.ref.trim() : "";
          return act(
            toolCallId,
            { action: "press", key, ...(ref ? { ref } : {}) },
            { expectElement: Boolean(ref) },
          );
        },
      },
      {
        name: "browser_select",
        label: "Choose option",
        description: `Choose an option in a dropdown (<select>) in the Nexu browser panel, by its value or visible label. Clicking a native dropdown cannot open it, so use this instead. Returns the element's value afterwards; a miss lists the available options. ${REF_NOTE}`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            ref: refParam("Ref of the combobox / select element"),
            option: {
              type: "string",
              description: "Option value or label to choose",
            },
          },
          required: ["ref", "option"],
        },
        async execute(toolCallId, params) {
          const ref = typeof params?.ref === "string" ? params.ref.trim() : "";
          const option =
            typeof params?.option === "string" ? params.option.trim() : "";
          if (!ref || !option) {
            return textResult("browser_select requires a ref and an option.", true);
          }
          return act(toolCallId, { action: "select", ref, option });
        },
      },
      {
        name: "browser_hover",
        label: "Hover element",
        description: `Move the pointer over an element in the Nexu browser panel without clicking, to open hover menus or reveal tooltips. Take a snapshot afterwards to see what appeared. ${REF_NOTE}`,
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: { ref: refParam() },
          required: ["ref"],
        },
        async execute(toolCallId, params) {
          let ref;
          try {
            ref = readRef(params, "browser_hover");
          } catch (error) {
            return textResult(error.message, true);
          }
          return act(toolCallId, { action: "hover", ref });
        },
      },
      {
        name: "browser_scroll",
        label: "Scroll page",
        description:
          "Scroll the page in the Nexu browser panel. Positive deltaY scrolls down. Reports the scroll position afterwards and whether the bottom was reached. Pair it with browser_snapshot visibleOnly=true to read a long page in parts.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            deltaY: {
              type: "number",
              description: "Pixels to scroll; positive is down, e.g. 600",
            },
          },
          required: ["deltaY"],
        },
        async execute(toolCallId, params) {
          const deltaY = Number(params?.deltaY);
          if (!Number.isFinite(deltaY)) {
            return textResult("browser_scroll requires a numeric deltaY.", true);
          }
          return act(
            toolCallId,
            { action: "scroll", deltaY },
            { expectElement: false },
          );
        },
      },
      {
        name: "browser_navigate",
        label: "Back / forward / reload",
        description:
          "Go back or forward in the Nexu browser panel's history, or reload the current page. To open a URL use browser_open. Returns the page you landed on.",
        parameters: {
          type: "object",
          additionalProperties: false,
          properties: {
            to: {
              type: "string",
              enum: ["back", "forward", "reload"],
              description: "Where to go",
            },
          },
          required: ["to"],
        },
        async execute(toolCallId, params) {
          const to = params?.to;
          if (to !== "back" && to !== "forward" && to !== "reload") {
            return textResult(
              "browser_navigate requires to = back | forward | reload.",
              true,
            );
          }
          return act(
            toolCallId,
            { action: "navigate", to },
            { expectElement: false },
          );
        },
      },
    ];

    // Factory registrations MUST pass opts.names (matching manifest
    // contracts.tools) — without it the registry records zero tool names and no
    // agent ever sees the tools.
    api.registerTool(registerBrowserTools, { names: BROWSER_TOOL_NAMES });
  },
};

export default plugin;
export { BROWSER_TOOL_NAMES, renderObservation, renderSnapshot };
