import type { WebContents } from "electron";
import type { DesktopBrowserSnapshotNode } from "../../shared/host";

/**
 * Agent-facing control of the embedded browser, over the CDP session that
 * `webContents.debugger` exposes in-process.
 *
 * Deliberately not `--remote-debugging-port`: that opens a real TCP listener
 * carrying *every* WebContents in the app — including nexu's own renderer with
 * the user's session — to any local process. A filtering proxy cannot contain
 * that, because anything can reach the port directly. Attaching per view keeps
 * the agent's reach to exactly the view it was given.
 */

/** Roles that carry no interaction or reading value for an agent. */
const SKIPPED_AX_ROLES = new Set([
  "none",
  "presentation",
  "generic",
  "InlineTextBox",
  "LineBreak",
]);

/** Link destinations longer than this are cut; the agent only needs to tell links apart. */
const MAX_HREF_LENGTH = 200;

/** Longest side of the JPEG handed to the model, matching OpenClaw's own image limit. */
const SCREENSHOT_MAX_SIDE_PX = 1200;
const SCREENSHOT_JPEG_QUALITY = 80;

export type BrowserSnapshotNode = DesktopBrowserSnapshotNode;

export type BrowserSnapshot = {
  url: string;
  title: string;
  nodes: BrowserSnapshotNode[];
  truncated: boolean;
  visibleOnly: boolean;
};

export type BrowserSnapshotOptions = {
  maxNodes: number;
  visibleOnly: boolean;
};

export type BrowserDialog = {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
};

/** An uncaught exception the page threw, as one readable line. */
export type BrowserPageError = {
  message: string;
  /** File and line it came from, e.g. "app.js:120". */
  source?: string;
};

type AxValue = { value?: unknown } | undefined;
type AxProperty = { name?: string; value?: AxValue };
type AxNode = {
  nodeId?: string;
  parentId?: string;
  childIds?: string[];
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  properties?: AxProperty[];
};

function axText(value: AxValue): string {
  const inner = value?.value;
  return typeof inner === "string"
    ? inner
    : typeof inner === "number" || typeof inner === "boolean"
      ? String(inner)
      : "";
}

function axFlag(node: AxNode, name: string): boolean {
  return (
    node.properties?.some(
      (property) => property.name === name && property.value?.value === true,
    ) ?? false
  );
}

/** The `checked` tristate as a boolean, or undefined for mixed / absent. */
function axChecked(node: AxNode): boolean | undefined {
  const property = node.properties?.find((entry) => entry.name === "checked");
  const value = property?.value?.value;
  if (value === true || value === "true") return true;
  if (value === false || value === "false") return false;
  return undefined;
}

/**
 * Refs are stable for the lifetime of a page and reset only on navigation.
 *
 * They map to `backendDOMNodeId` rather than the AX `nodeId`: AX node ids are
 * only meaningful within the tree that produced them, while backend node ids
 * stay valid for the lifetime of the DOM node.
 *
 * Renumbering per snapshot looks harmless but breaks the thing refs exist for:
 * an agent types into `e12`, snapshots again to check the result, and `e12` is
 * now a different element. Reusing the ref for a node already seen keeps
 * "the element I acted on" addressable across snapshots, which is also what
 * lets a read-back serve as evidence that the action landed.
 */
export class BrowserRefTable {
  private byRef = new Map<string, number>();
  private byNode = new Map<number, string>();
  private counter = 0;

  reset(): void {
    this.byRef.clear();
    this.byNode.clear();
    // The counter deliberately survives: restarting it would let a ref issued
    // before a navigation resolve to whatever element got the same number on
    // the new page. That matters most when two conversations share the tab —
    // one navigates between the other's snapshot and click, and the stale ref
    // would act on an element the agent never saw. Never reusing ids turns
    // that into a clean "unknown element ref" instead.
  }

  add(backendNodeId: number): string {
    const existing = this.byNode.get(backendNodeId);
    if (existing) return existing;
    this.counter += 1;
    const ref = `e${this.counter}`;
    this.byRef.set(ref, backendNodeId);
    this.byNode.set(backendNodeId, ref);
    return ref;
  }

  resolve(ref: string): number | null {
    return this.byRef.get(ref) ?? null;
  }
}

/**
 * Views whose CDP session already has the reporting domains enabled.
 *
 * `Page.enable` is what makes Chromium tell DevTools about JavaScript dialogs
 * and `Runtime.enable` about uncaught exceptions; without them both are
 * invisible to the agent. Enabled once per attach and forgotten on detach, so
 * a re-attach enables them again.
 */
const reportingDomainsEnabled = new WeakSet<WebContents>();

async function ensureAttached(contents: WebContents): Promise<void> {
  if (!contents.debugger.isAttached()) {
    contents.debugger.attach("1.3");
    reportingDomainsEnabled.delete(contents);
  }
  if (reportingDomainsEnabled.has(contents)) return;
  reportingDomainsEnabled.add(contents);
  try {
    await contents.debugger.sendCommand("Page.enable", {});
    await contents.debugger.sendCommand("Runtime.enable", {});
  } catch {
    // Reporting is best-effort; every other command works without it.
    reportingDomainsEnabled.delete(contents);
  }
}

async function send<T>(
  contents: WebContents,
  method: string,
  params?: Record<string, unknown>,
): Promise<T> {
  await ensureAttached(contents);
  return (await contents.debugger.sendCommand(method, params ?? {})) as T;
}

export function detachDebugger(contents: WebContents): void {
  try {
    if (contents.debugger.isAttached()) contents.debugger.detach();
  } catch {
    // Detaching a destroyed view is not an error worth surfacing.
  }
  reportingDomainsEnabled.delete(contents);
}

type ExceptionDetails = {
  text?: unknown;
  url?: unknown;
  lineNumber?: unknown;
  exception?: { description?: unknown } | undefined;
};

/**
 * Turns a `Runtime.exceptionThrown` payload into one readable line.
 *
 * `exception.description` carries the message plus a stack ("Error: prompt()
 * is not supported.\n    at HTMLButtonElement.<anonymous>..."); only its first
 * line says what went wrong. `text` is the fallback and is usually just
 * "Uncaught", which is why it is not the first choice.
 */
export function readPageError(params: unknown): BrowserPageError | null {
  const details = (params as { exceptionDetails?: ExceptionDetails })
    ?.exceptionDetails;
  if (!details) return null;
  const description =
    typeof details.exception?.description === "string"
      ? details.exception.description
      : "";
  const text = typeof details.text === "string" ? details.text : "";
  const message = (description || text).split("\n")[0]?.trim() ?? "";
  if (!message) return null;

  // Where it happened, kept to the file name: the full URL is mostly origin
  // the agent already knows, and a bundle path adds nothing it can act on.
  let source: string | undefined;
  if (typeof details.url === "string" && details.url) {
    const file = details.url.split(/[?#]/u)[0]?.split("/").pop() || details.url;
    const line =
      typeof details.lineNumber === "number"
        ? `:${details.lineNumber + 1}`
        : "";
    source = `${file}${line}`;
  }
  return { message, ...(source ? { source } : {}) };
}

/**
 * Reports what a view does out of band, for as long as it lives: JavaScript
 * dialogs, and uncaught page exceptions.
 *
 * The agent's view has dialogs disabled (see the manager), so Chromium closes
 * each one immediately — alerts acknowledged, confirms cancelled. That keeps a
 * `confirm()` from freezing the run, but it also means the agent would never
 * learn a dialog happened. DevTools is told about the dialog before the
 * embedder dismisses it, so listening here is what turns a silent cancel into
 * evidence in the action's observation.
 *
 * Exceptions matter for the same reason. `window.prompt()` is not implemented
 * in Electron at all — it throws `prompt() is not supported.` rather than
 * opening a dialog — so the page's own click handler dies at that line with
 * nothing to report. Measured, that left the agent with "the element did not
 * change" and no way to tell a dead handler from a click that missed. Any
 * other uncaught page error reaches the agent through the same path.
 */
export async function trackPageEvents(
  contents: WebContents,
  handlers: {
    onDialog: (dialog: BrowserDialog) => void;
    onPageError: (error: BrowserPageError) => void;
  },
): Promise<void> {
  contents.debugger.on("message", (_event, method, params) => {
    if (method === "Runtime.exceptionThrown") {
      const error = readPageError(params);
      if (error) handlers.onPageError(error);
      return;
    }
    if (method !== "Page.javascriptDialogOpening") return;
    const payload = params as { type?: unknown; message?: unknown };
    const type =
      payload.type === "alert" ||
      payload.type === "confirm" ||
      payload.type === "prompt" ||
      payload.type === "beforeunload"
        ? payload.type
        : "alert";
    handlers.onDialog({
      type,
      message: typeof payload.message === "string" ? payload.message : "",
    });
  });
  await ensureAttached(contents);
}

type LayoutIndex = {
  hrefByNode: Map<number, string>;
  boundsByNode: Map<number, [number, number, number, number]>;
  /** Document-coordinate rectangle of what is on screen, in CSS pixels. */
  viewport: { x: number; y: number; width: number; height: number } | null;
};

type DomSnapshotDocument = {
  documentURL?: number;
  /** Scrollable width in device pixels; see the scale note in captureLayoutIndex. */
  contentWidth?: number;
  nodes?: {
    backendNodeId?: number[];
    nodeName?: number[];
    attributes?: number[][];
  };
  layout?: {
    nodeIndex?: number[];
    bounds?: number[][];
  };
};

type LayoutMetrics = {
  cssLayoutViewport?: {
    pageX?: number;
    pageY?: number;
    clientWidth?: number;
    clientHeight?: number;
  };
  cssContentSize?: { width?: number; height?: number };
  cssVisualViewport?: { pageX?: number; pageY?: number };
};

/**
 * One DOM snapshot, indexed by backend node id.
 *
 * The accessibility tree has no link destinations and no geometry; both come
 * from `DOMSnapshot.captureSnapshot`, which is a single round trip for the
 * whole page where `DOM.getAttributes` / `DOM.getBoxModel` would be one per
 * element. Only the main document is indexed: frames report bounds in their
 * own coordinate space, and mapping those through the frame element is not
 * worth the complexity for a listing.
 */
async function captureLayoutIndex(contents: WebContents): Promise<LayoutIndex> {
  const empty: LayoutIndex = {
    hrefByNode: new Map(),
    boundsByNode: new Map(),
    viewport: null,
  };
  let strings: string[] = [];
  let main: DomSnapshotDocument | undefined;
  let metrics: LayoutMetrics = {};
  try {
    const [snapshot, layoutMetrics] = await Promise.all([
      send<{ documents?: DomSnapshotDocument[]; strings?: string[] }>(
        contents,
        "DOMSnapshot.captureSnapshot",
        { computedStyles: [] },
      ),
      send<LayoutMetrics>(contents, "Page.getLayoutMetrics"),
    ]);
    strings = snapshot.strings ?? [];
    main = snapshot.documents?.[0];
    metrics = layoutMetrics;
  } catch {
    return empty;
  }
  if (!main) return empty;

  const text = (index: number | undefined): string =>
    typeof index === "number" && index >= 0 ? (strings[index] ?? "") : "";
  const documentUrl = text(main.documentURL);
  const backendIds = main.nodes?.backendNodeId ?? [];
  const nodeNames = main.nodes?.nodeName ?? [];
  const attributes = main.nodes?.attributes ?? [];

  const hrefByNode = new Map<number, string>();
  for (let index = 0; index < backendIds.length; index += 1) {
    if (text(nodeNames[index]).toUpperCase() !== "A") continue;
    const pairs = attributes[index] ?? [];
    for (let pair = 0; pair + 1 < pairs.length; pair += 2) {
      if (text(pairs[pair]) !== "href") continue;
      const raw = text(pairs[pair + 1]).trim();
      if (!raw || /^javascript:/iu.test(raw)) break;
      try {
        const absolute = new URL(raw, documentUrl || undefined).toString();
        const backendId = backendIds[index];
        if (typeof backendId === "number") {
          hrefByNode.set(backendId, absolute.slice(0, MAX_HREF_LENGTH));
        }
      } catch {
        // A malformed href is not worth a broken listing.
      }
      break;
    }
  }

  const boundsByNode = new Map<number, [number, number, number, number]>();
  const nodeIndexes = main.layout?.nodeIndex ?? [];
  const bounds = main.layout?.bounds ?? [];
  for (let index = 0; index < nodeIndexes.length; index += 1) {
    const nodeIndex = nodeIndexes[index];
    const box = bounds[index];
    if (typeof nodeIndex !== "number" || !box || box.length < 4) continue;
    const backendId = backendIds[nodeIndex];
    const [x, y, width, height] = box;
    if (
      typeof backendId !== "number" ||
      typeof x !== "number" ||
      typeof y !== "number" ||
      typeof width !== "number" ||
      typeof height !== "number"
    ) {
      continue;
    }
    boundsByNode.set(backendId, [x, y, width, height]);
  }

  // DOMSnapshot reports geometry in device pixels — on a 2x display every
  // bound is twice its CSS value — while the layout metrics are CSS pixels.
  // Measured live: with the viewport left in CSS pixels, a page scrolled to
  // the bottom listed nothing at all. The snapshot's own content width against
  // the CSS content width gives the factor, zoom included.
  const cssContentWidth = metrics.cssContentSize?.width;
  const scale =
    typeof main.contentWidth === "number" &&
    main.contentWidth > 0 &&
    typeof cssContentWidth === "number" &&
    cssContentWidth > 0
      ? main.contentWidth / cssContentWidth
      : 1;
  const layoutViewport = metrics.cssLayoutViewport;
  const viewport =
    layoutViewport &&
    typeof layoutViewport.clientWidth === "number" &&
    typeof layoutViewport.clientHeight === "number"
      ? {
          x: (layoutViewport.pageX ?? 0) * scale,
          y: (layoutViewport.pageY ?? 0) * scale,
          width: layoutViewport.clientWidth * scale,
          height: layoutViewport.clientHeight * scale,
        }
      : null;

  return { hrefByNode, boundsByNode, viewport };
}

function intersectsViewport(
  box: [number, number, number, number],
  viewport: { x: number; y: number; width: number; height: number },
): boolean {
  const [x, y, width, height] = box;
  if (width <= 0 || height <= 0) return false;
  return (
    x < viewport.x + viewport.width &&
    x + width > viewport.x &&
    y < viewport.y + viewport.height &&
    y + height > viewport.y
  );
}

function buildNode(
  node: AxNode,
  ref: string,
  depth: number,
  href: string | undefined,
): BrowserSnapshotNode {
  const value = axText(node.value);
  const checked = axChecked(node);
  return {
    ref,
    role: axText(node.role),
    name: axText(node.name),
    ...(value ? { value } : {}),
    ...(href ? { href } : {}),
    ...(checked !== undefined ? { checked } : {}),
    ...(axFlag(node, "disabled") ? { disabled: true } : {}),
    depth,
  };
}

export async function captureSnapshot(
  contents: WebContents,
  refs: BrowserRefTable,
  options: BrowserSnapshotOptions,
): Promise<BrowserSnapshot> {
  const [tree, layout] = await Promise.all([
    send<{ nodes?: AxNode[] }>(contents, "Accessibility.getFullAXTree"),
    captureLayoutIndex(contents),
  ]);
  // Refs deliberately survive a snapshot; only navigation clears them.

  const all = tree.nodes ?? [];
  const byId = new Map<string, AxNode>();
  for (const node of all) {
    if (node.nodeId) byId.set(node.nodeId, node);
  }

  // Geometry is only trusted when the page reported it; otherwise a
  // viewport-only request degrades to the full listing and says so.
  const viewport = options.visibleOnly ? layout.viewport : null;
  const visibleOnly = viewport !== null;

  // Depth and de-duplication both refer to the nearest *emitted* ancestor.
  // Depth counted over the raw tree buried a text box seventeen levels deep
  // in wrappers the listing never shows; structural depth keeps the indent
  // meaningful. The ancestor's name is what tells a redundant text node
  // apart: a link's accessible name is computed from its text child, so
  // listing that child again doubled every link, button and heading.
  const emitted = new Map<string, { depth: number; name: string }>();
  const nearestEmitted = (
    node: AxNode,
  ): { depth: number; name: string } | null => {
    let parentId = node.parentId;
    let hops = 0;
    while (parentId && hops < 256) {
      const ancestor = emitted.get(parentId);
      if (ancestor) return ancestor;
      parentId = byId.get(parentId)?.parentId;
      hops += 1;
    }
    return null;
  };

  const nodes: BrowserSnapshotNode[] = [];
  let truncated = false;
  for (const node of all) {
    if (nodes.length >= options.maxNodes) {
      truncated = true;
      break;
    }
    if (node.ignored || typeof node.backendDOMNodeId !== "number") continue;
    const role = axText(node.role);
    if (!role || SKIPPED_AX_ROLES.has(role)) continue;
    const name = axText(node.name).trim();
    const value = axText(node.value);
    // A node with neither a name nor a value is not addressable by an agent
    // and only adds noise.
    if (!name && !value) continue;

    const parent = nearestEmitted(node);
    if (role === "StaticText" && parent && name && parent.name.includes(name))
      continue;

    // The root's layout box is the initial viewport, not the scrolled one, so
    // it would drop out of every listing taken below the fold; it carries the
    // page title and always stays.
    if (viewport && role !== "RootWebArea") {
      const box = layout.boundsByNode.get(node.backendDOMNodeId);
      if (!box || !intersectsViewport(box, viewport)) continue;
    }

    const depth = parent ? parent.depth + 1 : 0;
    if (node.nodeId) emitted.set(node.nodeId, { depth, name });
    nodes.push(
      buildNode(
        node,
        refs.add(node.backendDOMNodeId),
        depth,
        role === "link"
          ? layout.hrefByNode.get(node.backendDOMNodeId)
          : undefined,
      ),
    );
  }

  return {
    url: contents.getURL(),
    title: contents.getTitle(),
    nodes,
    truncated,
    visibleOnly,
  };
}

/**
 * One element's current accessible state, or null once it left the page.
 *
 * This is the evidence read after an action. A partial tree fetch for the
 * node alone costs one small round trip, where re-walking the whole page
 * would both be slower and — on a page longer than the listing cap — miss the
 * element entirely and report it as gone.
 */
export async function describeRef(
  contents: WebContents,
  refs: BrowserRefTable,
  ref: string,
): Promise<BrowserSnapshotNode | null> {
  const backendNodeId = refs.resolve(ref);
  if (backendNodeId === null) return null;
  let nodes: AxNode[] = [];
  try {
    const result = await send<{ nodes?: AxNode[] }>(
      contents,
      "Accessibility.getPartialAXTree",
      { backendNodeId, fetchRelatives: false },
    );
    nodes = result.nodes ?? [];
  } catch {
    // The DOM node is gone; CDP has no id to describe.
    return null;
  }
  const node = nodes.find((entry) => entry.backendDOMNodeId === backendNodeId);
  if (!node || node.ignored) return null;
  const role = axText(node.role);
  if (!role || SKIPPED_AX_ROLES.has(role)) return null;
  return buildNode(node, ref, 0, undefined);
}

async function centerOf(
  contents: WebContents,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  const box = await send<{ model?: { content?: number[] } }>(
    contents,
    "DOM.getBoxModel",
    { backendNodeId },
  );
  const quad = box.model?.content;
  if (!quad || quad.length < 8) {
    throw new Error("element has no layout box; it may be hidden");
  }
  const xs = [quad[0], quad[2], quad[4], quad[6]].filter(
    (value): value is number => typeof value === "number",
  );
  const ys = [quad[1], quad[3], quad[5], quad[7]].filter(
    (value): value is number => typeof value === "number",
  );
  return {
    x: xs.reduce((sum, value) => sum + value, 0) / xs.length,
    y: ys.reduce((sum, value) => sum + value, 0) / ys.length,
  };
}

function resolveRef(refs: BrowserRefTable, ref: string): number {
  const backendNodeId = refs.resolve(ref);
  if (backendNodeId === null) {
    throw new Error(`unknown element ref ${ref}; take a snapshot first`);
  }
  return backendNodeId;
}

async function pointOf(
  contents: WebContents,
  backendNodeId: number,
): Promise<{ x: number; y: number }> {
  await send(contents, "DOM.scrollIntoViewIfNeeded", { backendNodeId }).catch(
    () => undefined,
  );
  return centerOf(contents, backendNodeId);
}

export async function clickRef(
  contents: WebContents,
  refs: BrowserRefTable,
  ref: string,
): Promise<void> {
  const backendNodeId = resolveRef(refs, ref);
  const approach = await pointOf(contents, backendNodeId);
  // Hover-dependent handlers (menus that mount their items on mouseenter) need
  // the pointer to arrive before it presses.
  await send(contents, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: approach.x,
    y: approach.y,
  });
  // Arriving can move the target: leaving a hover menu collapses it and
  // everything below shifts back up. Measured live, the press at the stale
  // point landed on empty space and the button's handler never ran. Measure
  // again with the pointer in place, and follow the element if it moved.
  const point = await centerOf(contents, backendNodeId);
  if (point.x !== approach.x || point.y !== approach.y) {
    await send(contents, "Input.dispatchMouseEvent", {
      type: "mouseMoved",
      x: point.x,
      y: point.y,
    });
  }
  for (const type of ["mousePressed", "mouseReleased"] as const) {
    await send(contents, "Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: "left",
      // The bitmask of buttons held *during* the event, which CDP treats
      // separately from `button`. Omitting it sends a press that claims no
      // button is down.
      buttons: type === "mousePressed" ? 1 : 0,
      clickCount: 1,
    });
  }
}

export async function hoverRef(
  contents: WebContents,
  refs: BrowserRefTable,
  ref: string,
): Promise<void> {
  const point = await pointOf(contents, resolveRef(refs, ref));
  await send(contents, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
  });
}

/**
 * Runs a function against the element in the page's own world.
 *
 * Used for the two things CDP input events cannot express: selecting a
 * field's existing text so typing replaces it, and choosing a `<select>`
 * option, which no synthesized click can do on a native popup.
 */
async function callOnRef<T>(
  contents: WebContents,
  backendNodeId: number,
  functionDeclaration: string,
  args: unknown[] = [],
): Promise<T> {
  const resolved = await send<{ object?: { objectId?: string } }>(
    contents,
    "DOM.resolveNode",
    { backendNodeId },
  );
  const objectId = resolved.object?.objectId;
  if (!objectId) throw new Error("element is no longer on the page");
  try {
    const result = await send<{
      result?: { value?: T };
      exceptionDetails?: { text?: string };
    }>(contents, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((value) => ({ value })),
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(
        result.exceptionDetails.text ?? "script failed on the element",
      );
    }
    return result.result?.value as T;
  } finally {
    await send(contents, "Runtime.releaseObject", { objectId }).catch(
      () => undefined,
    );
  }
}

const SELECT_EXISTING_TEXT = `function () {
  if (typeof this.select === "function" && "value" in this) {
    this.select();
    return true;
  }
  if (this.isContentEditable) {
    const range = document.createRange();
    range.selectNodeContents(this);
    const selection = window.getSelection();
    if (selection) {
      selection.removeAllRanges();
      selection.addRange(range);
    }
    return true;
  }
  return false;
}`;

export async function typeIntoRef(
  contents: WebContents,
  refs: BrowserRefTable,
  ref: string,
  text: string,
  options: { submit?: boolean; append?: boolean } = {},
): Promise<void> {
  const backendNodeId = resolveRef(refs, ref);
  await send(contents, "DOM.focus", { backendNodeId });
  if (!options.append) {
    // `Input.insertText` types at the caret; on a prefilled field that
    // appends. Selecting first makes the insert replace, which is what
    // "type X into the field" means.
    await callOnRef<boolean>(contents, backendNodeId, SELECT_EXISTING_TEXT);
  }
  await send(contents, "Input.insertText", { text });
  if (!options.submit) return;
  // `Input.insertText` never produces key events, so a search box that submits
  // on Enter would sit there filled in and unsubmitted. Enter is dispatched as
  // real key events for exactly that reason.
  await pressKey(contents, refs, "Enter");
}

const MODIFIER_BITS: Record<string, number> = {
  alt: 1,
  option: 1,
  ctrl: 2,
  control: 2,
  meta: 4,
  cmd: 4,
  command: 4,
  shift: 8,
};

type KeyDefinition = {
  key: string;
  code: string;
  keyCode: number;
  text?: string;
};

const NAMED_KEYS: Record<string, KeyDefinition> = {
  enter: { key: "Enter", code: "Enter", keyCode: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", keyCode: 9 },
  escape: { key: "Escape", code: "Escape", keyCode: 27 },
  esc: { key: "Escape", code: "Escape", keyCode: 27 },
  backspace: { key: "Backspace", code: "Backspace", keyCode: 8 },
  delete: { key: "Delete", code: "Delete", keyCode: 46 },
  space: { key: " ", code: "Space", keyCode: 32, text: " " },
  arrowup: { key: "ArrowUp", code: "ArrowUp", keyCode: 38 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", keyCode: 40 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", keyCode: 37 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", keyCode: 39 },
  home: { key: "Home", code: "Home", keyCode: 36 },
  end: { key: "End", code: "End", keyCode: 35 },
  pageup: { key: "PageUp", code: "PageUp", keyCode: 33 },
  pagedown: { key: "PageDown", code: "PageDown", keyCode: 34 },
};

export type KeyChord = { definition: KeyDefinition; modifiers: number };

/**
 * Parses "Enter", "a", "Shift+Tab", "Control+A" into a CDP key event.
 *
 * Returns null for anything it cannot express so the caller can name the
 * unsupported key instead of sending an event Chromium ignores.
 */
export function parseKeyChord(input: string): KeyChord | null {
  const parts = input
    .trim()
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  const keyPart = parts[parts.length - 1] ?? "";
  let modifiers = 0;
  for (const part of parts.slice(0, -1)) {
    const bit = MODIFIER_BITS[part.toLowerCase()];
    if (bit === undefined) return null;
    modifiers |= bit;
  }

  const named = NAMED_KEYS[keyPart.toLowerCase()];
  if (named) return { definition: named, modifiers };
  if ([...keyPart].length !== 1) return null;

  const shifted = (modifiers & 8) !== 0;
  const character = shifted ? keyPart.toUpperCase() : keyPart;
  const upper = keyPart.toUpperCase();
  const isLetter = /^[A-Z]$/u.test(upper);
  const isDigit = /^[0-9]$/u.test(upper);
  return {
    definition: {
      key: character,
      code: isLetter ? `Key${upper}` : isDigit ? `Digit${upper}` : "",
      keyCode: isLetter || isDigit ? upper.charCodeAt(0) : 0,
      text: character,
    },
    modifiers,
  };
}

export async function pressKey(
  contents: WebContents,
  refs: BrowserRefTable,
  key: string,
  ref?: string,
): Promise<void> {
  const chord = parseKeyChord(key);
  if (!chord) throw new Error(`unsupported key "${key}"`);
  if (ref) {
    await send(contents, "DOM.focus", { backendNodeId: resolveRef(refs, ref) });
  }
  const { definition, modifiers } = chord;
  // A character only reaches the page as text when no non-shift modifier is
  // held; Control+A must select all, not type an "a".
  const text = (modifiers & ~8) === 0 ? definition.text : undefined;
  const base = {
    modifiers,
    key: definition.key,
    ...(definition.code ? { code: definition.code } : {}),
    windowsVirtualKeyCode: definition.keyCode,
    nativeVirtualKeyCode: definition.keyCode,
  };
  await send(contents, "Input.dispatchKeyEvent", {
    ...base,
    type: text ? "keyDown" : "rawKeyDown",
    ...(text ? { text, unmodifiedText: text } : {}),
  });
  await send(contents, "Input.dispatchKeyEvent", { ...base, type: "keyUp" });
}

const CHOOSE_OPTION = `function (wanted) {
  if (!(this instanceof HTMLSelectElement)) {
    return { ok: false, error: "element is not a <select>" };
  }
  const normalize = (value) => String(value ?? "").trim().toLowerCase();
  const options = Array.from(this.options);
  const labelOf = (option) => option.label || option.text || "";
  const target = normalize(wanted);
  const match =
    options.find((option) => option.value === wanted) ??
    options.find((option) => normalize(labelOf(option)) === target) ??
    options.find((option) => normalize(labelOf(option)).includes(target));
  if (!match) {
    return {
      ok: false,
      error: "no option matches",
      options: options.slice(0, 40).map(labelOf),
    };
  }
  this.value = match.value;
  this.dispatchEvent(new Event("input", { bubbles: true }));
  this.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, label: labelOf(match) };
}`;

export async function selectOption(
  contents: WebContents,
  refs: BrowserRefTable,
  ref: string,
  option: string,
): Promise<void> {
  const backendNodeId = resolveRef(refs, ref);
  await send(contents, "DOM.focus", { backendNodeId }).catch(() => undefined);
  const result = await callOnRef<
    | { ok: true; label: string }
    | { ok: false; error: string; options?: string[] }
  >(contents, backendNodeId, CHOOSE_OPTION, [option]);
  if (!result || result.ok) return;
  const available = result.options?.length
    ? `; available: ${result.options.map((label) => JSON.stringify(label)).join(", ")}`
    : "";
  throw new Error(`${result.error}${available}`);
}

async function scrollPosition(
  contents: WebContents,
): Promise<{ y: number; maxY: number }> {
  const metrics = await send<LayoutMetrics>(contents, "Page.getLayoutMetrics");
  const y = Math.round(
    metrics.cssVisualViewport?.pageY ?? metrics.cssLayoutViewport?.pageY ?? 0,
  );
  const maxY = Math.max(
    0,
    Math.round(
      (metrics.cssContentSize?.height ?? 0) -
        (metrics.cssLayoutViewport?.clientHeight ?? 0),
    ),
  );
  return { y, maxY };
}

export async function scrollBy(
  contents: WebContents,
  deltaY: number,
): Promise<{ y: number; maxY: number }> {
  const metrics = await send<LayoutMetrics>(contents, "Page.getLayoutMetrics");
  const viewport = metrics.cssLayoutViewport;
  await send(contents, "Input.dispatchMouseEvent", {
    type: "mouseWheel",
    x: Math.round((viewport?.clientWidth ?? 800) / 2),
    y: Math.round((viewport?.clientHeight ?? 600) / 2),
    deltaX: 0,
    deltaY,
  });
  // Wheel scrolling is animated; the position read straight after the event
  // is where the page was, not where it is going. Measured live, a fixed
  // 150ms reported 2156 of 2275 for a scroll that ended at the bottom, and
  // the listing taken next missed the footer that had just come into view.
  // Read until two consecutive reads agree.
  let previous = await scrollPosition(contents);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    const current = await scrollPosition(contents);
    if (current.y === previous.y) return current;
    previous = current;
  }
  return previous;
}

/**
 * The view as the user sees it, sized for a model.
 *
 * The panel's own `capture` returns a full-resolution PNG because the user
 * annotates it. A model gets a JPEG no longer than SCREENSHOT_MAX_SIDE_PX on
 * either side: that is the limit OpenClaw applies to its own image tools, and
 * a 2x display would otherwise ship four times the pixels for no extra
 * legibility.
 */
export async function captureScreenshot(contents: WebContents): Promise<{
  mimeType: string;
  base64: string;
  width: number;
  height: number;
}> {
  let image = await contents.capturePage();
  const size = image.getSize();
  const longest = Math.max(size.width, size.height);
  if (longest > SCREENSHOT_MAX_SIDE_PX && longest > 0) {
    const scale = SCREENSHOT_MAX_SIDE_PX / longest;
    image = image.resize({
      width: Math.max(1, Math.round(size.width * scale)),
      height: Math.max(1, Math.round(size.height * scale)),
    });
  }
  const scaled = image.getSize();
  return {
    mimeType: "image/jpeg",
    base64: image.toJPEG(SCREENSHOT_JPEG_QUALITY).toString("base64"),
    width: scaled.width,
    height: scaled.height,
  };
}
