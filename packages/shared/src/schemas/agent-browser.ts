import { z } from "zod";

/**
 * Agent control of the embedded browser.
 *
 * The agent runs in OpenClaw, the browser view lives in the Electron main
 * process, and the panel that gives that view its bounds is owned by the web
 * renderer. Rather than let the controller reach into the main process, the
 * renderer is the executor: it subscribes to a command stream and calls the
 * desktop host itself.
 *
 * That is not just plumbing convenience. The executor being the panel makes
 * "the user can see what the agent is doing" structural — an action cannot be
 * performed while the panel is closed, because the thing that performs it is
 * the panel.
 */

/** Largest element listing a single snapshot may carry. */
export const AGENT_BROWSER_MAX_SNAPSHOT_NODES = 1000;

export const agentBrowserCommandSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("open"), url: z.string() }),
  z.object({
    action: z.literal("snapshot"),
    maxNodes: z
      .number()
      .int()
      .min(1)
      .max(AGENT_BROWSER_MAX_SNAPSHOT_NODES)
      .optional(),
    // Only elements laid out inside the current viewport. Pairs with scroll
    // for pages whose full listing would not fit in one snapshot.
    visibleOnly: z.boolean().optional(),
  }),
  z.object({ action: z.literal("click"), ref: z.string() }),
  z.object({
    action: z.literal("type"),
    ref: z.string(),
    text: z.string(),
    submit: z.boolean().optional(),
    // Typing replaces the field's existing text unless the agent asks to
    // append; a prefilled field otherwise ends up with both values.
    append: z.boolean().optional(),
  }),
  z.object({
    action: z.literal("press"),
    // A key name ("Enter", "ArrowDown"), a single character, or a chord such
    // as "Shift+Tab" / "Control+A". Parsed on the desktop side.
    key: z.string(),
    // Focused first when given; otherwise the key goes to whatever has focus.
    ref: z.string().optional(),
  }),
  z.object({
    action: z.literal("select"),
    ref: z.string(),
    // Matched against option values first, then labels.
    option: z.string(),
  }),
  z.object({ action: z.literal("hover"), ref: z.string() }),
  z.object({ action: z.literal("scroll"), deltaY: z.number() }),
  z.object({
    action: z.literal("navigate"),
    to: z.enum(["back", "forward", "reload"]),
  }),
  z.object({ action: z.literal("screenshot") }),
]);

export const agentBrowserSnapshotNodeSchema = z.object({
  ref: z.string(),
  role: z.string(),
  name: z.string(),
  value: z.string().optional(),
  // Link destination, resolved to an absolute URL; only for link roles.
  href: z.string().optional(),
  checked: z.boolean().optional(),
  disabled: z.boolean().optional(),
  depth: z.number(),
});

export const agentBrowserSnapshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  truncated: z.boolean(),
  visibleOnly: z.boolean().optional(),
  nodes: z.array(agentBrowserSnapshotNodeSchema),
});

/** A JavaScript dialog the page raised while an action ran. */
export const agentBrowserDialogSchema = z.object({
  type: z.enum(["alert", "confirm", "prompt", "beforeunload"]),
  message: z.string(),
});

/**
 * An uncaught exception the page threw while an action ran.
 *
 * The case that made this necessary: Electron does not implement
 * `window.prompt()` at all — it throws rather than opening a dialog — so a
 * page's click handler dies at that line and there is no dialog to report.
 * Without this the agent saw only "the element did not change" and could not
 * tell a dead handler from a click that missed.
 */
export const agentBrowserPageErrorSchema = z.object({
  message: z.string(),
  source: z.string().optional(),
});

/**
 * What an action leaves behind: where the page ended up, and the state of the
 * element that was acted on.
 *
 * Every successful action carries evidence rather than a bare acknowledgement.
 * A browser can be read back, unlike a desktop click, so "it succeeded" and
 * "here is the element afterwards" cost the same round trip — and only the
 * second one can be checked.
 */
export const agentBrowserObservationSchema = z.object({
  url: z.string(),
  title: z.string(),
  // Absent when the element is gone — usually because the click navigated.
  // Optional rather than nullable: the OpenAPI 3.0 `nullable` this emits is
  // dropped by the SDK generator, so a nullable field would type as non-null
  // in the frontend.
  element: agentBrowserSnapshotNodeSchema.optional(),
  // The page moved to a new document. Refs issued before the action are gone.
  navigated: z.boolean(),
  // Same document, but its URL or title changed (a pushState route, an
  // in-page search). Refs stay valid; the content is worth a fresh snapshot.
  changedInPlace: z.boolean().optional(),
  // The page was still loading when this evidence was read: the load did not
  // finish inside the wait budget, so the listing may be incomplete.
  loading: z.boolean().optional(),
  // Dialogs the page raised during the action. The agent's tab dismisses them
  // automatically (alerts closed, confirms cancelled), so this is the only way
  // the agent learns they happened.
  dialogs: z.array(agentBrowserDialogSchema).optional(),
  // Uncaught exceptions the page threw during the action, deduplicated. They
  // explain an action that landed on the right element and still changed
  // nothing, because the page's own handler died part way through.
  pageErrors: z.array(agentBrowserPageErrorSchema).optional(),
  // Scroll position after a scroll, in CSS pixels; maxY is the furthest the
  // page can scroll, so y === maxY means the bottom.
  scroll: z.object({ y: z.number(), maxY: z.number() }).optional(),
});

export const agentBrowserScreenshotSchema = z.object({
  url: z.string(),
  title: z.string(),
  mimeType: z.string(),
  base64: z.string(),
  width: z.number(),
  height: z.number(),
});

/** What the renderer sends back for a command it finished executing. */
export const agentBrowserOutcomeSchema = z.union([
  z.object({ ok: z.literal(true), snapshot: agentBrowserSnapshotSchema }),
  z.object({
    ok: z.literal(true),
    observation: agentBrowserObservationSchema,
  }),
  z.object({
    ok: z.literal(true),
    screenshot: agentBrowserScreenshotSchema,
  }),
  z.object({ ok: z.literal(false), error: z.string() }),
]);

/** What the runtime plugin POSTs on behalf of the agent. */
export const agentBrowserActBodySchema = z.object({
  sessionKey: z.string(),
  command: agentBrowserCommandSchema,
});

/** What the renderer POSTs once a dispatched command settles. */
export const agentBrowserResultBodySchema = z.object({
  requestId: z.string(),
  outcome: agentBrowserOutcomeSchema,
});

export const agentBrowserResultAckSchema = z.object({
  // False when the request already timed out and no one is waiting any more.
  accepted: z.boolean(),
});

export type AgentBrowserCommand = z.infer<typeof agentBrowserCommandSchema>;
export type AgentBrowserSnapshot = z.infer<typeof agentBrowserSnapshotSchema>;
export type AgentBrowserSnapshotNode = z.infer<
  typeof agentBrowserSnapshotNodeSchema
>;
export type AgentBrowserDialog = z.infer<typeof agentBrowserDialogSchema>;
export type AgentBrowserPageError = z.infer<typeof agentBrowserPageErrorSchema>;
export type AgentBrowserObservation = z.infer<
  typeof agentBrowserObservationSchema
>;
export type AgentBrowserScreenshot = z.infer<
  typeof agentBrowserScreenshotSchema
>;
export type AgentBrowserOutcome = z.infer<typeof agentBrowserOutcomeSchema>;
