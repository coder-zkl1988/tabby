import { useSyncExternalStore } from "react";
import type { A2UIMessage } from "../a2ui/a2ui-types";
import { getCanvasBoards, setActiveBoardId } from "./canvas-boards";
import { NODE_MIN_HEIGHT, NODE_MIN_WIDTH } from "./canvas-geometry";
import type { PersistedCanvas } from "./canvas-persistence";
import { getActiveStorage } from "./canvas-persistence";
import type { VideoAspectRatio } from "./video-generation-params";
export { NODE_MIN_HEIGHT, NODE_MIN_WIDTH } from "./canvas-geometry";

/**
 * Canvas v2 store — the workbench's single source of truth (design doc
 * 2026-07-03-infinite-canvas-sidebar.md §v2). Hand-rolled store following the
 * repo's xhs-batch-store pattern (useSyncExternalStore, zero deps).
 *
 * Concept model mirrors the reference infinite-canvas app (typed nodes +
 * free connections + snapshot history), reimplemented from scratch — the
 * reference is AGPL and only its interaction paradigm is borrowed.
 *
 * Serializability: everything in CanvasState round-trips through JSON for
 * export/import and history snapshots. A2UI payloads (messages + onAction
 * closures) intentionally live OUTSIDE the state in a runtime map keyed by
 * surfaceId; a2ui nodes only reference that key.
 */

// ── Types ──────────────────────────────────────────────────────

export type CanvasViewport = { x: number; y: number; scale: number };

export type CanvasNodeType =
  | "a2ui"
  | "text"
  | "image"
  | "video"
  | "audio"
  | "team-step"
  | "config"
  | "xhs"
  | "phone"
  | "group";

export type CanvasXhsPost = {
  title: string;
  content: string;
  images: string[];
  hashtags: string[];
  theme?: string;
  deviceId?: string;
};

export type CanvasPhonePreview = {
  deviceId?: string;
};

export type CanvasNodeMetadata = {
  /** a2ui: surfaceId into the runtime payload map. */
  surfaceId?: string;
  /** text: note content. image/video/audio: data URL / servable URL. */
  content?: string;
  mimeType?: string;
  fontSize?: number;
  /**
   * Image/video nodes with content keep aspect ratio by default.
   * Set true to opt out of ratio lock (free resize).
   */
  freeResize?: boolean;
  /**
   * Config node: generation settings (params mirror channel capabilities).
   * Model/quality/aspect/size and friends are best-effort hints — the channel
   * forwards them to the generation agent, which honors what it supports.
   */
  config?: {
    mode: "image" | "video" | "audio" | "text";
    /** image: number of outputs, 1–12 */
    count?: number;
    /** video: duration in seconds, 1–60 */
    durationSeconds?: number;
    /** video: output resolution tier */
    resolution?: "480p" | "720p" | "1080p";
    /** audio: voice identifier */
    voice?: string;
    /** audio: playback speed, 0.5–2 */
    speed?: number;
    /** all modes: preferred generation model (best-effort hint) */
    model?: string;
    /** image: quality hint */
    quality?: "auto" | "high" | "medium" | "low";
    /** image/video: aspect-ratio hint, e.g. "1:1", "16:9" */
    aspectRatio?: string;
    /** video: frame count, <=441 and following 8n+1 */
    numFrames?: number;
    /** video: frame rate, 1-60 */
    frameRate?: number;
    /** video: optional positive model inference step count */
    numInferenceSteps?: number;
    /** video: content to avoid */
    negativePrompt?: string;
    /** video: deterministic seed */
    seed?: number;
    /** image: output size hint, e.g. "1K", "2K", "4K" */
    size?: string;
    /** video: also generate an audio track (hint) */
    generateAudio?: boolean;
    /** video: add a watermark (hint) */
    watermark?: boolean;
    /** audio: output format hint */
    format?: "mp3" | "wav" | "m4a" | "ogg" | "flac";
    /** audio: extra voice/style instructions (hint) */
    instructions?: string;
    /** composer: base prompt prepended to the upstream prompt */
    composedPrompt?: string;
    /** text: how many alternatives to generate (1-4). Separate from `count`,
     *  which is the image fan-out — sharing them was the reference's v0.16 bug. */
    textCount?: number;
  };
  /** xhs: canvas-native Xiaohongshu post editor state. */
  xhs?: CanvasXhsPost;
  /** phone: selected connected device for the live preview shell. */
  phone?: CanvasPhonePreview;
  /** batch group: root carries childIds+expanded; children carry rootId. */
  batch?: { childIds?: string[]; expanded?: boolean; rootId?: string };
  /**
   * text: several generated alternatives held in ONE node (reference v0.17 —
   * unlike images, which fan out into sibling nodes). `content` always mirrors
   * `items[activeIndex]`; `requested` records how many were asked for, so a
   * partial failure shows as "2/4" instead of silently looking complete.
   */
  textAlternatives?: {
    items: string[];
    activeIndex: number;
    requested?: number;
  };
  /**
   * Group membership: set on a member node; points at its group node's id.
   * Groups never nest — a group node never carries a groupId. Distinct from
   * `batch` (image multi-result groups): batch and group are independent
   * concepts, each with its own cascade in removeNodes.
   */
  groupId?: string;
  /** team-step: one step of a live team run (board card is the truth). */
  step?: {
    teamId: string;
    cardId: string;
    stepId?: string;
    runId?: string;
    workflowId?: string;
    assigneeName: string;
    isApproval?: boolean;
  };
  /**
   * W4.2: Natural dimensions of the loaded image (stored on first onLoad).
   * Used by the image-info badge when showImageInfo pref is on.
   * Written at most once per content load via shouldStoreNaturalSize predicate.
   */
  naturalWidth?: number;
  naturalHeight?: number;
  /**
   * Transient generation task. Absence = idle; content presence = success.
   *
   * Deliberate refinement of the idle/generating/success/error model: idle and
   * success are represented by ABSENCE of this key — no stale success states in
   * persistence. A reloaded app must never show an eternal spinner; hydration
   * normalizes any persisted `generating` task to `error` with an interrupted
   * message.
   */
  task?: {
    status: "generating" | "error";
    /**
     * Controller-side job backing an in-flight generation. Persisted, so a
     * reload can pick the poll back up instead of declaring the run lost —
     * `normalizeInterruptedTasks` leaves these alone and canvas-task-resume.ts
     * re-attaches. Absent for channels with no job queue (audio, text, …).
     */
    job?: { kind: "image" | "video"; jobId: string };
    error?: string;
    /** Params to re-run the generation (retry). */
    retry?:
      | {
          kind: "image";
          prompt: string;
          referenceImages?: string[];
          count?: number;
          sourceImage?: string;
          maskDataUrl?: string;
          model?: string;
          quality?: "auto" | "high" | "medium" | "low";
          aspectRatio?: string;
          size?: string;
          transparentBackground?: boolean;
        }
      | {
          kind: "video";
          prompt: string;
          durationSeconds?: number;
          resolution?: "480p" | "720p" | "1080p";
          model?: string;
          aspectRatio?: VideoAspectRatio;
          numFrames?: number;
          frameRate?: number;
          numInferenceSteps?: number;
          negativePrompt?: string;
          seed?: number;
          generateAudio?: boolean;
          watermark?: boolean;
        }
      | {
          kind: "audio";
          prompt: string;
          voice?: string;
          speed?: number;
          model?: string;
          format?: "mp3" | "wav" | "m4a" | "ogg" | "flac";
          instructions?: string;
        }
      | {
          kind: "text";
          prompt: string;
          sourceText?: string;
          model?: string;
          /** How many alternatives the original run asked for (1-4). */
          count?: number;
        }
      | {
          kind: "enhance";
          sourceImage: string;
          operation: "super-resolve" | "multi-angle";
          targetLongEdge?: 1024 | 2048 | 4096;
          horizontalDeg?: number;
          pitchDeg?: number;
          distance?: number;
          wideAngle?: boolean;
          prompt?: string;
        };
  };
};

export interface CanvasNode {
  id: string;
  type: CanvasNodeType;
  title: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
  metadata: CanvasNodeMetadata;
}

export interface CanvasConnection {
  id: string;
  fromNodeId: string;
  toNodeId: string;
}

export interface CanvasState {
  nodes: CanvasNode[];
  connections: CanvasConnection[];
  viewport: CanvasViewport;
  selectedNodeIds: string[];
  selectedConnectionId: string | null;
  panelOpen: boolean;
}

export const NODE_DEFAULT_SIZES: Record<
  CanvasNodeType,
  { width: number; height: number }
> = {
  a2ui: { width: 380, height: 420 },
  text: { width: 300, height: 180 },
  image: { width: 340, height: 240 },
  video: { width: 420, height: 260 },
  audio: { width: 340, height: 120 },
  "team-step": { width: 300, height: 200 },
  config: { width: 320, height: 240 },
  xhs: { width: 440, height: 640 },
  phone: { width: 300, height: 680 },
  group: { width: 760, height: 480 },
};

// ── Store internals ────────────────────────────────────────────

const HISTORY_LIMIT = 50;
const HISTORY_DEBOUNCE_MS = 400;
const GEOMETRY_STORAGE_KEY = "nexu:canvas:sidebar:v2";
const PERSIST_DEBOUNCE_MS = 600;

/**
 * The board whose content the persistence paths read/write (W4.4). Mutable so
 * switchCanvasBoard can retarget save/load without re-keying storage. Seeded
 * from the boards index active id (defaults to "sidebar" — the back-compat
 * default board), guarded for SSR / no-localStorage environments.
 */
let activeBoardId = readInitialActiveBoardId();

function readInitialActiveBoardId(): string {
  try {
    return getCanvasBoards().activeId;
  } catch {
    return "sidebar";
  }
}

type HistoryEntry = Pick<CanvasState, "nodes" | "connections">;

let state: CanvasState = {
  nodes: [],
  connections: [],
  viewport: loadStoredViewport(),
  selectedNodeIds: [],
  selectedConnectionId: null,
  panelOpen: false,
};

const listeners = new Set<() => void>();
const history: { past: HistoryEntry[]; future: HistoryEntry[] } = {
  past: [],
  future: [],
};
let historyTimer: ReturnType<typeof setTimeout> | null = null;
let historyBase: HistoryEntry | null = null;

// Persistence state
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persistResolvers: Array<() => void> = [];
let isHydrating = false;
let hydratedOnce = false;

/** A2UI payloads (messages + action closures) — runtime only, never serialized. */
const a2uiPayloads = new Map<
  string,
  {
    messages: A2UIMessage[];
    onAction: (name: string, context: Record<string, unknown>) => void;
  }
>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<CanvasState>): void {
  const prevNodes = state.nodes;
  const prevConnections = state.connections;
  state = { ...state, ...patch };
  emit();
  // Schedule a trailing-debounce persist when content changes (not during hydration)
  if (
    !isHydrating &&
    (state.nodes !== prevNodes || state.connections !== prevConnections)
  ) {
    schedulePersist();
  }
}

function schedulePersist(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
  }
  persistTimer = setTimeout(() => {
    persistTimer = null;
    const resolvers = persistResolvers;
    persistResolvers = [];
    const snapshot: PersistedCanvas = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: state.nodes,
      connections: state.connections,
    };
    void getActiveStorage()
      .save(activeBoardId, snapshot)
      .finally(() => {
        for (const resolve of resolvers) resolve();
      });
  }, PERSIST_DEBOUNCE_MS);
}

function snapshot(): HistoryEntry {
  return {
    nodes: state.nodes.map((node) => ({
      ...node,
      position: { ...node.position },
      size: { ...node.size },
      metadata: { ...node.metadata },
    })),
    connections: state.connections.map((connection) => ({ ...connection })),
  };
}

/**
 * Record the pre-change snapshot once per debounce window (reference
 * behavior: rapid drags collapse into one undo step).
 */
function recordHistory(): void {
  if (historyBase === null) {
    historyBase = snapshot();
  }
  if (historyTimer) {
    clearTimeout(historyTimer);
  }
  historyTimer = setTimeout(() => {
    if (historyBase) {
      history.past.push(historyBase);
      if (history.past.length > HISTORY_LIMIT) {
        history.past.shift();
      }
      history.future = [];
      historyBase = null;
    }
    historyTimer = null;
  }, HISTORY_DEBOUNCE_MS);
}

/** Flush a pending debounced history commit immediately (undo correctness). */
function flushHistory(): void {
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  if (historyBase) {
    history.past.push(historyBase);
    if (history.past.length > HISTORY_LIMIT) {
      history.past.shift();
    }
    history.future = [];
    historyBase = null;
  }
}

function loadStoredViewport(): CanvasViewport {
  try {
    const raw = localStorage.getItem(GEOMETRY_STORAGE_KEY);
    const parsed = raw
      ? (JSON.parse(raw) as { viewport?: CanvasViewport })
      : {};
    return parsed.viewport ?? { x: 0, y: 0, scale: 1 };
  } catch {
    return { x: 0, y: 0, scale: 1 };
  }
}

function persistViewport(viewport: CanvasViewport): void {
  try {
    localStorage.setItem(GEOMETRY_STORAGE_KEY, JSON.stringify({ viewport }));
  } catch {
    // Storage unavailable — viewport just won't survive a reload.
  }
}

/** localStorage writes are synchronous I/O — never run them per pan/zoom frame. */
let viewportPersistTimer: ReturnType<typeof setTimeout> | null = null;
function persistViewportDebounced(viewport: CanvasViewport): void {
  if (viewportPersistTimer) {
    clearTimeout(viewportPersistTimer);
  }
  viewportPersistTimer = setTimeout(() => {
    viewportPersistTimer = null;
    persistViewport(viewport);
  }, 300);
}

/** Generate a unique id with the given prefix (e.g. "text-lx3abc-4z1f"). */
export function genId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Cascade slot for the n-th node (new nodes stagger down-right). */
export function cascadePosition(index: number): { x: number; y: number } {
  return { x: 32 + (index % 8) * 44, y: 32 + (index % 8) * 40 };
}

// ── Actions ────────────────────────────────────────────────────

export function addNode(input: {
  type: CanvasNodeType;
  title: string;
  position?: { x: number; y: number };
  size?: { width: number; height: number };
  metadata?: CanvasNodeMetadata;
  id?: string;
}): CanvasNode {
  recordHistory();
  const node: CanvasNode = {
    id: input.id ?? genId(input.type),
    type: input.type,
    title: input.title,
    position: input.position ?? cascadePosition(state.nodes.length),
    size: input.size ?? NODE_DEFAULT_SIZES[input.type],
    metadata: input.metadata ?? {},
  };
  setState({
    nodes: [...state.nodes, node],
    selectedNodeIds: [node.id],
    selectedConnectionId: null,
    panelOpen: true,
  });
  return node;
}

export function updateNode(
  id: string,
  patch: Partial<Pick<CanvasNode, "title" | "metadata">>,
): void {
  recordHistory();
  setState({
    nodes: state.nodes.map((node) =>
      node.id === id
        ? {
            ...node,
            ...(patch.title !== undefined ? { title: patch.title } : {}),
            ...(patch.metadata
              ? { metadata: { ...node.metadata, ...patch.metadata } }
              : {}),
          }
        : node,
    ),
  });
}

/**
 * Set or clear the transient generation task for a node.
 * Passing `null` removes the `task` key entirely (metadata has no `task`
 * property, not `task: undefined`) — absence represents idle/success.
 */
export function setNodeTask(
  id: string,
  task: CanvasNodeMetadata["task"] | null,
): void {
  setState({
    nodes: state.nodes.map((node) => {
      if (node.id !== id) return node;
      if (task === null) {
        // Remove the key entirely — do not leave task: undefined in metadata.
        const { task: _removed, ...rest } = node.metadata;
        return { ...node, metadata: rest };
      }
      return { ...node, metadata: { ...node.metadata, task } };
    }),
  });
}

export function moveNode(id: string, position: { x: number; y: number }): void {
  moveNodes([{ id, position }]);
}

/** Move several nodes in one state update (multi-select drag = one emit). */
export function moveNodes(
  updates: ReadonlyArray<{ id: string; position: { x: number; y: number } }>,
): void {
  if (updates.length === 0) return;
  recordHistory();
  const byId = new Map(updates.map((update) => [update.id, update.position]));
  setState({
    nodes: state.nodes.map((node) => {
      const position = byId.get(node.id);
      return position ? { ...node, position } : node;
    }),
  });
}

/**
 * Reassign group membership after a drag (drop-to-join). Each entry sets a
 * node's `metadata.groupId`; `undefined` clears it (the node left every group).
 * Applied in ONE setState so the whole reassignment is a single history entry —
 * and because it lands inside the drag's history debounce window it folds into
 * the same undo step as the move. Callers pass only non-group nodes and only
 * entries that actually change (so this never records a stray no-op step).
 */
export function setGroupMemberships(
  assignments: ReadonlyArray<{ id: string; groupId: string | undefined }>,
): void {
  if (assignments.length === 0) return;
  recordHistory();
  const byId = new Map(assignments.map((a) => [a.id, a.groupId]));
  setState({
    nodes: state.nodes.map((node) => {
      if (!byId.has(node.id)) return node;
      const groupId = byId.get(node.id);
      if (groupId === undefined) {
        const { groupId: _cleared, ...rest } = node.metadata;
        return { ...node, metadata: rest };
      }
      return { ...node, metadata: { ...node.metadata, groupId } };
    }),
  });
}

export function resizeNode(
  id: string,
  size: { width: number; height: number },
  position?: { x: number; y: number },
): void {
  recordHistory();
  const width = Math.max(NODE_MIN_WIDTH, size.width);
  const height = Math.max(NODE_MIN_HEIGHT, size.height);
  setState({
    nodes: state.nodes.map((node) =>
      node.id === id
        ? {
            ...node,
            size: { width, height },
            ...(position !== undefined ? { position } : {}),
          }
        : node,
    ),
  });
}

export function removeNodes(ids: readonly string[]): void {
  if (ids.length === 0) return;
  recordHistory();
  const gone = new Set(ids);

  // Batch cascade: when a root is removed, its children join the removal set.
  // Root removal wins if both root and child are in the same call.
  for (const node of state.nodes) {
    if (gone.has(node.id) && node.metadata.batch?.childIds) {
      for (const childId of node.metadata.batch.childIds) {
        gone.add(childId);
      }
    }
  }

  // Group unbind (distinct from the batch cascade above): deleting a group node
  // does NOT delete its members — they survive with their groupId cleared.
  // Collect the removed group ids so the surviving-nodes pass can strip stale
  // groupId references.
  const removedGroupIds = new Set<string>();
  for (const node of state.nodes) {
    if (gone.has(node.id) && node.type === "group") {
      removedGroupIds.add(node.id);
    }
  }

  // Cleanup a2ui payloads for deleted nodes
  for (const node of state.nodes) {
    if (gone.has(node.id) && node.metadata.surfaceId) {
      a2uiPayloads.delete(node.metadata.surfaceId);
    }
  }

  // Surviving nodes get two independent fixups:
  //  - batch: a surviving root whose some children were removed cleans childIds;
  //  - group: a surviving member whose group was removed loses its groupId.
  const survivingNodes = state.nodes
    .filter((node) => !gone.has(node.id))
    .map((node) => {
      const childIds = node.metadata.batch?.childIds;
      const remaining = childIds
        ? childIds.filter((childId) => !gone.has(childId))
        : undefined;
      const batchChanged =
        childIds !== undefined &&
        remaining !== undefined &&
        remaining.length !== childIds.length;
      const groupRemoved =
        node.metadata.groupId !== undefined &&
        removedGroupIds.has(node.metadata.groupId);

      if (!batchChanged && !groupRemoved) return node;

      let metadata: CanvasNodeMetadata = node.metadata;
      if (groupRemoved) {
        const { groupId: _cleared, ...rest } = metadata;
        metadata = rest;
      }
      if (batchChanged) {
        const newBatch =
          remaining && remaining.length > 0
            ? { ...node.metadata.batch, childIds: remaining }
            : undefined; // no children left → strip batch entirely
        metadata = { ...metadata, batch: newBatch };
      }
      return { ...node, metadata };
    });

  const survivingConnections = state.connections.filter(
    (connection) =>
      !gone.has(connection.fromNodeId) && !gone.has(connection.toNodeId),
  );
  // A selected connection can be cascade-removed here (e.g. the hover
  // toolbar's delete button removes a node directly, bypassing
  // selectConnection/selectNodes' own selection bookkeeping). Leaving
  // selectedConnectionId pointing at a gone connection makes the next
  // deleteSelection() call a silent no-op — see removeConnection below.
  const selectedConnectionGone =
    state.selectedConnectionId !== null &&
    !survivingConnections.some((c) => c.id === state.selectedConnectionId);

  setState({
    nodes: survivingNodes,
    connections: survivingConnections,
    selectedNodeIds: state.selectedNodeIds.filter((id) => !gone.has(id)),
    ...(selectedConnectionGone ? { selectedConnectionId: null } : {}),
  });
}

export function clearCanvas(): void {
  recordHistory();
  a2uiPayloads.clear();
  setState({
    nodes: [],
    connections: [],
    selectedNodeIds: [],
    selectedConnectionId: null,
  });
}

export function connectNodes(
  fromNodeId: string,
  toNodeId: string,
): CanvasConnection | null {
  if (fromNodeId === toNodeId) return null;
  const nodeIds = new Set(state.nodes.map((node) => node.id));
  if (!nodeIds.has(fromNodeId) || !nodeIds.has(toNodeId)) return null;
  const exists = state.connections.some(
    (connection) =>
      connection.fromNodeId === fromNodeId && connection.toNodeId === toNodeId,
  );
  if (exists) return null;
  recordHistory();
  const connection: CanvasConnection = {
    id: genId("conn"),
    fromNodeId,
    toNodeId,
  };
  setState({ connections: [...state.connections, connection] });
  return connection;
}

export function removeConnection(id: string): void {
  recordHistory();
  setState({
    connections: state.connections.filter((connection) => connection.id !== id),
    selectedConnectionId:
      state.selectedConnectionId === id ? null : state.selectedConnectionId,
  });
}

export function setViewport(viewport: CanvasViewport): void {
  setState({ viewport });
  persistViewportDebounced(viewport);
}

export function selectNodes(ids: readonly string[], additive = false): void {
  const next = additive
    ? [...new Set([...state.selectedNodeIds, ...ids])]
    : [...new Set(ids)];
  setState({ selectedNodeIds: next, selectedConnectionId: null });
}

export function selectConnection(id: string | null): void {
  setState({ selectedConnectionId: id, selectedNodeIds: [] });
}

export function clearSelection(): void {
  setState({ selectedNodeIds: [], selectedConnectionId: null });
}

export function selectAll(): void {
  setState({
    selectedNodeIds: state.nodes.map((node) => node.id),
    selectedConnectionId: null,
  });
}

export function deleteSelection(): void {
  if (state.selectedConnectionId) {
    removeConnection(state.selectedConnectionId);
    return;
  }
  removeNodes(state.selectedNodeIds);
}

export function setPanelOpen(open: boolean): void {
  setState({ panelOpen: open });
}

export function undo(): void {
  flushHistory();
  const previous = history.past.pop();
  if (!previous) return;
  history.future.push(snapshot());
  setState({
    nodes: previous.nodes,
    connections: previous.connections,
    selectedNodeIds: [],
    selectedConnectionId: null,
  });
}

export function redo(): void {
  const next = history.future.pop();
  if (!next) return;
  history.past.push(snapshot());
  setState({
    nodes: next.nodes,
    connections: next.connections,
    selectedNodeIds: [],
    selectedConnectionId: null,
  });
}

// ── A2UI bridge ────────────────────────────────────────────────

/**
 * Pin an A2UI surface as a canvas node (the openWith compatibility path).
 * Same surfaceId refreshes the payload in place instead of adding a node.
 */
export function upsertA2UINode(
  surfaceId: string,
  title: string,
  messages: A2UIMessage[],
  onAction: (name: string, context: Record<string, unknown>) => void,
  opts?: {
    position?: { x: number; y: number };
    size?: { width: number; height: number };
  },
): void {
  a2uiPayloads.set(surfaceId, { messages, onAction });
  const existing = state.nodes.find(
    (node) => node.metadata.surfaceId === surfaceId,
  );
  if (existing) {
    // Payload map already refreshed; nudge subscribers + open the panel.
    setState({ panelOpen: true });
    return;
  }
  addNode({
    type: "a2ui",
    title,
    ...(opts?.position ? { position: opts.position } : {}),
    ...(opts?.size ? { size: opts.size } : {}),
    metadata: { surfaceId },
  });
}

export function getA2UIPayload(surfaceId: string) {
  return a2uiPayloads.get(surfaceId) ?? null;
}

/**
 * Re-attach a runtime payload to an EXISTING a2ui node after a reload wiped
 * the payload map (node shells persist to IDB; onAction closures cannot).
 * Unlike upsertA2UINode this never creates a node and never opens the panel —
 * it only heals an "内容已过期" placeholder back into a live surface.
 *
 * The nudge swaps the node's metadata identity so NodeBody's memo (which
 * ignores everything except id/type/title/metadata) lets the placeholder
 * re-render. Deliberately NOT a history entry: nothing user-visible moved.
 */
export function refreshA2UIPayload(
  surfaceId: string,
  messages: A2UIMessage[],
  onAction: (name: string, context: Record<string, unknown>) => void,
): boolean {
  const target = state.nodes.find(
    (node) => node.metadata.surfaceId === surfaceId,
  );
  if (!target) return false;
  a2uiPayloads.set(surfaceId, { messages, onAction });
  setState({
    nodes: state.nodes.map((node) =>
      node.id === target.id
        ? { ...node, metadata: { ...node.metadata } }
        : node,
    ),
  });
  return true;
}

// ── Export / import ────────────────────────────────────────────

export type CanvasExportFile = {
  app: "nexu-canvas";
  version: 1;
  exportedAt: string;
  nodes: CanvasNode[];
  connections: CanvasConnection[];
};

/**
 * Serialize the canvas. a2ui nodes are skipped — their payloads are runtime
 * closures re-created by their entry points, not portable data.
 */
export function exportCanvas(): CanvasExportFile {
  return {
    app: "nexu-canvas",
    version: 1,
    exportedAt: new Date().toISOString(),
    nodes: state.nodes.filter((node) => node.type !== "a2ui"),
    connections: state.connections.filter((connection) => {
      const portable = new Set(
        state.nodes
          .filter((node) => node.type !== "a2ui")
          .map((node) => node.id),
      );
      return (
        portable.has(connection.fromNodeId) && portable.has(connection.toNodeId)
      );
    }),
  };
}

export function importCanvas(file: CanvasExportFile): void {
  if (file.app !== "nexu-canvas" || !Array.isArray(file.nodes)) {
    throw new Error("not a nexu canvas export");
  }
  recordHistory();
  flushHistory();

  // 1. Generate fresh ids for every imported node; build oldId→newId map.
  const idMap = new Map<string, string>();
  // First pass: assign new ids so batch remapping has the full map.
  for (const node of file.nodes) {
    idMap.set(node.id, genId(node.type));
  }
  const importedNodes: CanvasNode[] = file.nodes.map((node) => {
    const newId = idMap.get(node.id) as string;
    // 2. Strip surfaceId — a2ui payloads are runtime singletons.
    const {
      surfaceId: _stripped,
      batch: rawBatch,
      ...restMeta
    } = node.metadata;

    // 3. Remap batch fields through the id map; strip orphaned references.
    let remappedBatch: CanvasNodeMetadata["batch"];
    if (rawBatch) {
      if (rawBatch.rootId !== undefined) {
        // Child node: rootId must map to a node in the import set.
        const newRootId = idMap.get(rawBatch.rootId);
        remappedBatch = newRootId
          ? { ...rawBatch, rootId: newRootId }
          : undefined; // orphan: root not in file → strip
      } else if (rawBatch.childIds !== undefined) {
        // Root node: filter to only children that were imported.
        const remappedChildIds = rawBatch.childIds
          .map((cid) => idMap.get(cid))
          .filter((cid): cid is string => cid !== undefined);
        remappedBatch =
          remappedChildIds.length > 0
            ? { ...rawBatch, childIds: remappedChildIds }
            : undefined;
      }
    }

    const metadata: CanvasNodeMetadata = {
      ...restMeta,
      ...(remappedBatch !== undefined ? { batch: remappedBatch } : {}),
    };
    return { ...node, id: newId, metadata };
  });

  // 3. Remap connections through the map; drop any with unmapped endpoints.
  const importedConnections: CanvasConnection[] = file.connections
    .map((conn) => {
      const fromNodeId = idMap.get(conn.fromNodeId);
      const toNodeId = idMap.get(conn.toNodeId);
      if (!fromNodeId || !toNodeId) return null;
      return { id: genId("conn"), fromNodeId, toNodeId };
    })
    .filter((conn): conn is CanvasConnection => conn !== null);

  setState({
    nodes: [...state.nodes, ...importedNodes],
    connections: [...state.connections, ...importedConnections],
    panelOpen: true,
  });
}

// ── Test helper ────────────────────────────────────────────────

/** Reset everything (tests only). */
export function __resetCanvasForTests(): void {
  state = {
    nodes: [],
    connections: [],
    viewport: { x: 0, y: 0, scale: 1 },
    selectedNodeIds: [],
    selectedConnectionId: null,
    panelOpen: false,
  };
  history.past = [];
  history.future = [];
  historyBase = null;
  if (historyTimer) {
    clearTimeout(historyTimer);
    historyTimer = null;
  }
  if (viewportPersistTimer) {
    clearTimeout(viewportPersistTimer);
    viewportPersistTimer = null;
  }
  // Reset persistence state
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  persistResolvers = [];
  isHydrating = false;
  hydratedOnce = false;
  // Reset the active board to the back-compat default (deterministic; does not
  // depend on boards-store reset ordering in test beforeEach hooks).
  activeBoardId = "sidebar";
  a2uiPayloads.clear();
  emit();
}

/** Read the id of the board the persistence paths currently target (tests only). */
export function __getActiveBoardIdForTests(): string {
  return activeBoardId;
}

/**
 * Flush any pending debounced save immediately, saving the current snapshot to
 * the ACTIVE board. Resolves after the save completes (or immediately when
 * nothing is pending). Shared by the test flush helper and switchCanvasBoard so
 * a switch never drops the current board's unsaved edits.
 */
function flushPendingSave(): Promise<void> {
  if (!persistTimer) {
    // No pending timer — either already flushed or nothing changed
    return Promise.resolve();
  }
  clearTimeout(persistTimer);
  persistTimer = null;
  return new Promise<void>((resolve) => {
    persistResolvers.push(resolve);
    const snapshot: PersistedCanvas = {
      version: 1,
      savedAt: new Date().toISOString(),
      nodes: state.nodes,
      connections: state.connections,
    };
    void getActiveStorage()
      .save(activeBoardId, snapshot)
      .finally(() => {
        const resolvers = persistResolvers;
        persistResolvers = [];
        for (const r of resolvers) r();
      });
  });
}

/**
 * Flush any pending debounced save immediately (tests only).
 * Returns a promise that resolves after the save completes.
 */
export function __flushCanvasPersistForTests(): Promise<void> {
  return flushPendingSave();
}

/**
 * Switch the active canvas board (W4.4).
 *
 * 1. No-op when already on the target board.
 * 2. Flush-save the CURRENT board first (no data loss on switch).
 * 3. Retarget the active board id.
 * 4. Reset in-memory state to empty WITHOUT persisting back and WITHOUT
 *    recording undo history (isHydrating guards the save; history is cleared).
 * 5. REPLACE-load the target board's snapshot (never merges two boards'
 *    content — unlike hydrate's reload-merge path). Missing snapshot → empty.
 * 6. Persist the boards-index active pointer so a reload returns here.
 *
 * The once-ever hydratedOnce guard is intentionally left untouched: the switch
 * owns its load path and does not go through hydrateCanvasFromStorage.
 */
export async function switchCanvasBoard(boardId: string): Promise<void> {
  if (boardId === activeBoardId) return;

  // 1. Persist the current board's pending edits before leaving it.
  await flushPendingSave();

  // 2. Retarget, then load the destination board (REPLACE, not merge).
  activeBoardId = boardId;
  const saved = await getActiveStorage().load(boardId);

  // 3. Swap in the loaded content with no save-back and no undo history.
  isHydrating = true;
  try {
    if (saved) {
      const nodes = normalizeInterruptedTasks(saved.nodes);
      const nodeIds = new Set(nodes.map((n) => n.id));
      const connections = saved.connections.filter(
        (c) => nodeIds.has(c.fromNodeId) && nodeIds.has(c.toNodeId),
      );
      state = {
        ...state,
        nodes,
        connections,
        selectedNodeIds: [],
        selectedConnectionId: null,
      };
    } else {
      state = {
        ...state,
        nodes: [],
        connections: [],
        selectedNodeIds: [],
        selectedConnectionId: null,
      };
    }
    // A2UI payloads + history are board-scoped: reset them on switch.
    a2uiPayloads.clear();
    history.past = [];
    history.future = [];
    historyBase = null;
    if (historyTimer) {
      clearTimeout(historyTimer);
      historyTimer = null;
    }
    emit();
  } finally {
    isHydrating = false;
  }

  // 4. Persist the index active pointer.
  setActiveBoardId(boardId);
}

/**
 * Normalize a persisted `generating` task to `error` — a reloaded (or
 * board-switched-into) canvas must never show an eternal spinner. Nodes
 * without a generating task pass through unchanged.
 *
 * A task carrying a controller job id is the exception: the run is still alive
 * on the controller, so it stays `generating` and canvas-task-resume.ts picks
 * the poll back up. If the job turns out to be gone (controller restarted, TTL
 * expired), the resume marks it failed — which is the honest answer, and one
 * this function cannot give on its own.
 */
function normalizeInterruptedTasks(nodes: CanvasNode[]): CanvasNode[] {
  return nodes.map((n) => {
    if (n.metadata.task?.status !== "generating") return n;
    if (n.metadata.task.job !== undefined) return n;
    return {
      ...n,
      metadata: {
        ...n.metadata,
        task: {
          status: "error" as const,
          error: "生成已中断（应用重启）",
          ...(n.metadata.task.retry ? { retry: n.metadata.task.retry } : {}),
        },
      },
    };
  });
}

/**
 * Hydrate canvas nodes/connections from storage.
 * - Module-level guard: only first call does work (React StrictMode double-mount safety).
 * - Merge semantics: add only nodes whose id is not already present;
 *   add only connections whose id is not present AND whose both endpoints exist.
 * - Does NOT record undo history.
 * - Does NOT schedule a save-back of the loaded data.
 * - Returns true iff anything was applied.
 */
export async function hydrateCanvasFromStorage(): Promise<boolean> {
  if (hydratedOnce) return false;
  hydratedOnce = true;

  const saved = await getActiveStorage().load(activeBoardId);
  if (!saved) return false;

  const existingNodeIds = new Set(state.nodes.map((n) => n.id));
  const existingConnIds = new Set(state.connections.map((c) => c.id));

  const newNodes = normalizeInterruptedTasks(
    saved.nodes.filter((n) => !existingNodeIds.has(n.id)),
  );

  // Build the full set of node ids after the merge to validate connections
  const mergedNodeIds = new Set([
    ...existingNodeIds,
    ...newNodes.map((n) => n.id),
  ]);

  const newConnections = saved.connections.filter(
    (c) =>
      !existingConnIds.has(c.id) &&
      mergedNodeIds.has(c.fromNodeId) &&
      mergedNodeIds.has(c.toNodeId),
  );

  if (newNodes.length === 0 && newConnections.length === 0) return false;

  // Apply without triggering persist or undo history
  isHydrating = true;
  try {
    state = {
      ...state,
      nodes: [...state.nodes, ...newNodes],
      connections: [...state.connections, ...newConnections],
    };
    emit();
  } finally {
    isHydrating = false;
  }

  return true;
}

/** Flush the pending history window (tests need deterministic undo points). */
export function __flushCanvasHistoryForTests(): void {
  flushHistory();
}

// ── React bindings ─────────────────────────────────────────────

export function getCanvasState(): CanvasState {
  return state;
}

export function useCanvas(): CanvasState {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => state,
    () => state,
  );
}
