import { cn } from "@/lib/utils";
import {
  AudioLines,
  BookOpenText,
  Clapperboard,
  ImagePlus,
  SlidersHorizontal,
  Smartphone,
  Star,
  Type,
  X,
} from "lucide-react";
import {
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { toast } from "sonner";
import { ensureAssetsLoaded, useCanvasAssets } from "./canvas-assets";
import {
  isHiddenBatchChild,
  setBatchPrimary,
  toggleBatchExpanded,
} from "./canvas-batch";
import {
  clipboardHasContent,
  copySelection,
  duplicateNodes,
  pasteClipboard,
} from "./canvas-clipboard";
import { createConnectedNode } from "./canvas-create";
import { CanvasDialogs } from "./canvas-dialogs-mount";
import { exportNodesAsZip } from "./canvas-export";
import { FloatingMenu, clampMenuPosition } from "./canvas-floating-menu";
import { resumeGenerationJobs } from "./canvas-generation";
import { type ResizeCorner, computeResizeGeometry } from "./canvas-geometry";
import { groupSelectedNodes, ungroupSelectedNodes } from "./canvas-group-ops";
import {
  canGroupSelection,
  canUngroupSelection,
  groupIdForPoint,
  groupSelectionMembers,
  groupWrapRect,
  memberIdsOf,
} from "./canvas-groups";
import {
  ingestFilesAsNodes,
  ingestTextAsNode,
  readFilesAsDataUrls,
} from "./canvas-ingest";
import { CanvasMinimap } from "./canvas-minimap";
import { pushCanvasMirror, scheduleCanvasMirrorPush } from "./canvas-mirror";
import {
  type CanvasNode,
  type CanvasViewport,
  clearSelection,
  connectNodes,
  deleteSelection,
  getCanvasState,
  hydrateCanvasFromStorage,
  moveNodes,
  redo,
  removeConnection,
  removeNodes,
  resizeNode,
  selectAll,
  selectConnection,
  selectNodes,
  setGroupMemberships,
  setViewport,
  undo,
  useCanvas,
} from "./canvas-store";
import { CanvasToolbar } from "./canvas-toolbar";
import { useCanvasUiPrefs } from "./canvas-ui-prefs";
import {
  type VideoFramePosition,
  captureVideoFrameIntoNode,
  currentTimeOfNodeVideo,
} from "./canvas-video-frame";
import { applyConnectionEffects } from "./connection-effects";
import { HoverToolbar } from "./hover-toolbar";
import { NodeBody } from "./node-views";
import { PromptPanel } from "./prompt-panel";

/**
 * Canvas v2 surface — pannable/zoomable plane with typed nodes, free
 * connections (right edge → left edge, bezier), marquee multi-select,
 * corner resize, keyboard shortcuts and a bottom toolbar. Zero deps,
 * DOM-based; interaction paradigm follows the reference infinite-canvas app
 * (AGPL — reimplemented, no code reuse). Design doc
 * 2026-07-03-infinite-canvas-sidebar.md.
 *
 * Interaction core (reference paradigm):
 * - the container opts out of text selection permanently (`select-none`);
 *   gesture starts call preventDefault + setPointerCapture, and editors
 *   inside nodes opt back in with `select-text` / native form controls.
 * - window pointer listeners are registered ONCE and read live state via
 *   getCanvasState() — no identity churn mid-gesture.
 * - pointermove is coalesced through requestAnimationFrame: at most one
 *   store commit per frame.
 * - nodes are positioned with transform + `contain: layout style` and
 *   rendered through React.memo; node content additionally ignores
 *   geometry-only changes, so dragging never re-renders A2UI trees.
 */

export const CANVAS_MIN_SCALE = 0.05;
export const CANVAS_MAX_SCALE = 5;

export function clampScale(scale: number): number {
  return Math.min(CANVAS_MAX_SCALE, Math.max(CANVAS_MIN_SCALE, scale));
}

/**
 * Compute the grid background-size in pixels at the given scale.
 * Returns null when the dots would be < 4px apart (visual noise at high zoom-out).
 */
export function gridBackgroundSize(scale: number): number | null {
  const size = 24 * scale;
  return size < 4 ? null : size;
}

/**
 * W4.2: Mode-aware grid background style helper.
 *
 * Returns a CSS background style object for the canvas surface, or null when:
 *  - mode is "blank"
 *  - LOD determines the grid would be too small to render (gridBackgroundSize returns null)
 *
 * dots output is byte-identical to the previous inline style (existing markup test tolerance).
 */
export function gridBackgroundStyle(
  mode: "dots" | "lines" | "blank",
  scale: number,
  viewport: { x: number; y: number },
): {
  backgroundImage: string;
  backgroundSize: string;
  backgroundPosition: string;
} | null {
  if (mode === "blank") return null;
  const size = gridBackgroundSize(scale);
  if (size === null) return null;
  const backgroundSize = `${size}px ${size}px`;
  const backgroundPosition = `${viewport.x % size}px ${viewport.y % size}px`;
  if (mode === "lines") {
    return {
      backgroundImage:
        "linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)",
      backgroundSize,
      backgroundPosition,
    };
  }
  // dots (default)
  return {
    backgroundImage:
      "radial-gradient(circle, var(--color-border) 1px, transparent 1px)",
    backgroundSize,
    backgroundPosition,
  };
}

/** Zoom keeping the canvas point under `pointer` (container coords) fixed. */
export function zoomAtPoint(
  viewport: CanvasViewport,
  pointer: { x: number; y: number },
  nextScaleRaw: number,
): CanvasViewport {
  const nextScale = clampScale(nextScaleRaw);
  const worldX = (pointer.x - viewport.x) / viewport.scale;
  const worldY = (pointer.y - viewport.y) / viewport.scale;
  return {
    scale: nextScale,
    x: pointer.x - worldX * nextScale,
    y: pointer.y - worldY * nextScale,
  };
}

/** Viewport fitting all nodes inside `container` with padding. */
export function fitViewport(
  nodes: ReadonlyArray<Pick<CanvasNode, "position" | "size">>,
  container: { width: number; height: number },
  padding = 32,
): CanvasViewport {
  if (nodes.length === 0 || container.width <= 0 || container.height <= 0) {
    return { x: 0, y: 0, scale: 1 };
  }
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const node of nodes) {
    minX = Math.min(minX, node.position.x);
    minY = Math.min(minY, node.position.y);
    maxX = Math.max(maxX, node.position.x + node.size.width);
    maxY = Math.max(maxY, node.position.y + node.size.height);
  }
  const contentW = Math.max(1, maxX - minX);
  const contentH = Math.max(1, maxY - minY);
  const scale = clampScale(
    Math.min(
      (container.width - padding * 2) / contentW,
      (container.height - padding * 2) / contentH,
      1,
    ),
  );
  return {
    scale,
    x: (container.width - contentW * scale) / 2 - minX * scale,
    y: (container.height - contentH * scale) / 2 - minY * scale,
  };
}

/** Bezier path from a source anchor to a target point (world coords). */
export function connectionPath(
  from: { x: number; y: number },
  to: { x: number; y: number },
): string {
  const bend = Math.max(50, Math.abs(to.x - from.x) / 2);
  return `M ${from.x} ${from.y} C ${from.x + bend} ${from.y}, ${to.x - bend} ${to.y}, ${to.x} ${to.y}`;
}

function sourceAnchor(node: Pick<CanvasNode, "position" | "size">) {
  return {
    x: node.position.x + node.size.width,
    y: node.position.y + node.size.height / 2,
  };
}

function targetAnchor(node: Pick<CanvasNode, "position" | "size">) {
  return { x: node.position.x, y: node.position.y + node.size.height / 2 };
}

/** Live-drag preview anchor: whichever side the grabbed handle sits on. */
function connectHandleAnchor(
  node: Pick<CanvasNode, "position" | "size">,
  handleType: "source" | "target",
) {
  return handleType === "source" ? sourceAnchor(node) : targetAnchor(node);
}

type GestureState =
  | { kind: "pan"; startX: number; startY: number; origin: CanvasViewport }
  | {
      kind: "node";
      startX: number;
      startY: number;
      origins: Array<{ id: string; x: number; y: number }>;
    }
  | {
      kind: "resize";
      id: string;
      corner: ResizeCorner;
      startX: number;
      startY: number;
      origin: { x: number; y: number; width: number; height: number };
      lockRatio: boolean;
    }
  | { kind: "connect"; fromId: string; handleType: "source" | "target" }
  | { kind: "marquee"; additive: boolean };

type ContextMenuState =
  | { kind: "node"; id: string; x: number; y: number }
  | { kind: "edge"; id: string; x: number; y: number }
  | {
      kind: "background";
      x: number;
      y: number;
      worldPoint: { x: number; y: number };
    };

type ConnectMenuState = {
  fromId: string;
  handleType: "source" | "target";
  screenX: number;
  screenY: number;
  worldX: number;
  worldY: number;
};

/**
 * Connect-drop create menu items. The type union is pinned to what
 * createConnectedNode accepts, so a menu/creator drift fails typecheck;
 * tests assert the list content so dropped entries fail CI.
 */
export const CONNECT_MENU_ITEMS = [
  { type: "text", label: "文本" },
  { type: "image", label: "图片" },
  { type: "video", label: "视频" },
  { type: "audio", label: "音频" },
  { type: "config", label: "配置" },
  { type: "xhs", label: "小红书" },
  { type: "phone", label: "手机" },
] as const satisfies ReadonlyArray<{
  type: Parameters<typeof createConnectedNode>[1];
  label: string;
}>;

function connectMenuIcon(
  type: (typeof CONNECT_MENU_ITEMS)[number]["type"],
): ReactNode {
  switch (type) {
    case "text":
      return <Type size={14} />;
    case "image":
      return <ImagePlus size={14} />;
    case "video":
      return <Clapperboard size={14} />;
    case "audio":
      return <AudioLines size={14} />;
    case "config":
      return <SlidersHorizontal size={14} />;
    case "xhs":
      return <BookOpenText size={14} />;
    case "phone":
      return <Smartphone size={14} />;
  }
}

/** Render-order rank: group nodes (0) sort before all other nodes (1). */
function groupRank(node: CanvasNode): number {
  return node.type === "group" ? 0 : 1;
}

/**
 * The node a drop point would hit, respecting render z-order (group nodes
 * always sit behind everything else — see the render sort above) rather than
 * raw node-array order. Without this, a drop on a node that overlaps a
 * later-created group could resolve to the group instead of the node
 * actually on top.
 */
export function topmostNodeAtPoint(
  nodes: ReadonlyArray<CanvasNode>,
  point: { x: number; y: number },
  excludeId?: string,
): CanvasNode | undefined {
  return [...nodes]
    .sort((a, b) => groupRank(a) - groupRank(b))
    .reverse()
    .find(
      (node) =>
        node.id !== excludeId &&
        !isHiddenBatchChild(node, nodes) &&
        point.x >= node.position.x &&
        point.x <= node.position.x + node.size.width &&
        point.y >= node.position.y &&
        point.y <= node.position.y + node.size.height,
    );
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return (
    target.tagName === "INPUT" ||
    target.tagName === "TEXTAREA" ||
    target.isContentEditable
  );
}

export function CanvasSurface({ className }: { className?: string }) {
  const {
    nodes,
    connections,
    viewport,
    selectedNodeIds,
    selectedConnectionId,
  } = useCanvas();
  const { gridMode } = useCanvasUiPrefs();
  // Subscribe to the asset library so the mirror push re-fires when the saved
  // asset set changes (agent sees new assets without opening the picker).
  const { assets } = useCanvasAssets();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const gestureRef = useRef<GestureState | null>(null);
  const pointerRef = useRef({ x: 0, y: 0 });
  const rafRef = useRef<number | null>(null);
  const marqueeRef = useRef<{
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null>(null);
  const [gestureActive, setGestureActive] = useState(false);
  // Id of the node being resized right now, or null. Set once per gesture (not
  // per frame) — it exists only to freeze the prompt panel below.
  const [resizingNodeId, setResizingNodeId] = useState<string | null>(null);
  // The panel's node as of the gesture's first frame. Held by ref so the panel
  // keeps ONE prop identity for the whole drag and its memo can bail out.
  const frozenPanelNodeRef = useRef<CanvasNode | null>(null);
  const [connectPreview, setConnectPreview] = useState<{
    x: number;
    y: number;
  } | null>(null);
  const [marqueeBox, setMarqueeBox] = useState<{
    start: { x: number; y: number };
    current: { x: number; y: number };
  } | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [connectMenu, setConnectMenu] = useState<ConnectMenuState | null>(null);
  const spaceRef = useRef(false);
  const selected = new Set(selectedNodeIds);

  // Hydrate canvas content from IndexedDB on mount (once).
  useEffect(() => {
    void hydrateCanvasFromStorage().then(() => {
      // Generations that were still running when the page went away keep their
      // `generating` task (they carry a controller job id); re-attach to those
      // polls so a reload mid-run resumes instead of losing the result.
      resumeGenerationJobs();
    });
    // Hydrate the saved asset library too so the first mirror push already
    // carries any assets the agent can insert.
    void ensureAssetsLoaded();
  }, []);

  // S8 mirror push: keep the controller mirror in sync so the agent's
  // canvas_read sees reality. Push once on mount, then a debounced push on any
  // nodes/connections/viewport/selection change. The debounce (canvas-mirror)
  // absorbs drag bursts — this stays off the rAF gesture path. Failures are
  // swallowed inside the pusher; a mirror outage never disrupts the canvas.
  useEffect(() => {
    void pushCanvasMirror();
  }, []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: push on any board change
  useEffect(() => {
    scheduleCanvasMirrorPush();
  }, [nodes, connections, viewport, selectedNodeIds, assets]);

  // Stable: reads the live viewport from the store, never from a closure.
  const toWorld = useCallback((clientX: number, clientY: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    const live = getCanvasState().viewport;
    const px = clientX - (rect?.left ?? 0);
    const py = clientY - (rect?.top ?? 0);
    return {
      x: (px - live.x) / live.scale,
      y: (py - live.y) / live.scale,
    };
  }, []);

  /** Apply the latest pointer position for `gesture` (≤ once per frame). */
  const applyGesture = useCallback(
    (gesture: GestureState) => {
      const { x: clientX, y: clientY } = pointerRef.current;
      if (gesture.kind === "pan") {
        setViewport({
          scale: gesture.origin.scale,
          x: gesture.origin.x + (clientX - gesture.startX),
          y: gesture.origin.y + (clientY - gesture.startY),
        });
      } else if (gesture.kind === "node") {
        const scale = getCanvasState().viewport.scale;
        const dx = (clientX - gesture.startX) / scale;
        const dy = (clientY - gesture.startY) / scale;
        moveNodes(
          gesture.origins.map((origin) => ({
            id: origin.id,
            position: { x: origin.x + dx, y: origin.y + dy },
          })),
        );
      } else if (gesture.kind === "resize") {
        const scale = getCanvasState().viewport.scale;
        const dx = (clientX - gesture.startX) / scale;
        const dy = (clientY - gesture.startY) / scale;
        const result = computeResizeGeometry({
          corner: gesture.corner,
          origin: gesture.origin,
          dx,
          dy,
          lockRatio: gesture.lockRatio,
        });
        resizeNode(
          gesture.id,
          { width: result.width, height: result.height },
          { x: result.x, y: result.y },
        );
      } else if (gesture.kind === "connect") {
        setConnectPreview(toWorld(clientX, clientY));
      } else if (gesture.kind === "marquee") {
        const box = marqueeRef.current;
        if (box) {
          const next = { ...box, current: toWorld(clientX, clientY) };
          marqueeRef.current = next;
          setMarqueeBox(next);
        }
      }
    },
    [toWorld],
  );

  // Window listeners live for the component lifetime; gestures are pure ref
  // state, so identities never churn mid-drag (a viewport-dependent handler
  // here previously lost the pan listener after the first frame).
  useEffect(() => {
    const onPointerMove = (event: PointerEvent) => {
      if (!gestureRef.current) return;
      pointerRef.current = { x: event.clientX, y: event.clientY };
      if (rafRef.current == null) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = null;
          if (gestureRef.current) applyGesture(gestureRef.current);
        });
      }
    };

    const onPointerUp = (event: PointerEvent) => {
      const gesture = gestureRef.current;
      if (!gesture) return;
      gestureRef.current = null;
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      setGestureActive(false);
      if (gesture.kind === "resize") {
        setResizingNodeId(null);
        frozenPanelNodeRef.current = null;
      }
      pointerRef.current = { x: event.clientX, y: event.clientY };

      if (gesture.kind === "resize") {
        // Commit the exact release position (a pending frame may be stale).
        applyGesture(gesture);
        return;
      }
      if (gesture.kind === "node") {
        // Commit the exact release position first (a pending frame may be stale).
        applyGesture(gesture);
        // Drop-to-join: recompute membership for every moved non-group node. The
        // reassignment is one setState (setGroupMemberships) and lands inside the
        // drag's history debounce window, so it folds into the same undo step as
        // the move — one history entry per drag, not one per node.
        const liveNodes = getCanvasState().nodes;
        const groups = liveNodes.filter((node) => node.type === "group");
        const movedIds = new Set(gesture.origins.map((origin) => origin.id));
        const assignments: Array<{
          id: string;
          groupId: string | undefined;
        }> = [];
        for (const node of liveNodes) {
          if (node.type === "group" || !movedIds.has(node.id)) continue;
          const center = {
            x: node.position.x + node.size.width / 2,
            y: node.position.y + node.size.height / 2,
          };
          const groupId = groupIdForPoint(center, groups);
          if (groupId !== node.metadata.groupId) {
            assignments.push({ id: node.id, groupId });
          }
        }
        setGroupMemberships(assignments);
        return;
      }
      if (gesture.kind === "connect") {
        setConnectPreview(null);
        const point = toWorld(event.clientX, event.clientY);
        const liveNodes = getCanvasState().nodes;
        const target = topmostNodeAtPoint(liveNodes, point, gesture.fromId);
        if (target) {
          // A "target" handle drag means the dropped-on node feeds the
          // origin node (left handle = incoming), so from/to swap.
          const fromId =
            gesture.handleType === "source" ? gesture.fromId : target.id;
          const toId =
            gesture.handleType === "source" ? target.id : gesture.fromId;
          // A group is a container, never a sink: it has no content of its own
          // for an incoming edge to feed. Dropping onto one from a source
          // handle is a no-op rather than a dead edge.
          const toNodeType = liveNodes.find((node) => node.id === toId)?.type;
          const created =
            toNodeType === "group" ? null : connectNodes(fromId, toId);
          const fromNode = liveNodes.find((node) => node.id === fromId);
          const toNode = liveNodes.find((node) => node.id === toId);
          if (created && fromNode && toNode) {
            // Edges carry data: e.g. image → XHS editor feeds the post image.
            applyConnectionEffects(fromNode, toNode);
          }
        } else {
          // No target node hit — open the create-node menu at the drop point.
          const rect = containerRef.current?.getBoundingClientRect();
          const cw = rect?.width ?? 0;
          const ch = rect?.height ?? 0;
          const rawX = event.clientX - (rect?.left ?? 0);
          const rawY = event.clientY - (rect?.top ?? 0);
          // Connect menu is ~160px wide, use shared clamp with explicit override.
          const { x: screenX, y: screenY } = clampMenuPosition(
            rawX,
            rawY,
            cw,
            ch,
            160,
            170,
          );
          setConnectMenu({
            fromId: gesture.fromId,
            handleType: gesture.handleType,
            screenX,
            screenY,
            worldX: point.x,
            worldY: point.y,
          });
        }
        return;
      }
      if (gesture.kind === "marquee") {
        const box = marqueeRef.current;
        marqueeRef.current = null;
        setMarqueeBox(null);
        if (box) {
          const x1 = Math.min(box.start.x, box.current.x);
          const x2 = Math.max(box.start.x, box.current.x);
          const y1 = Math.min(box.start.y, box.current.y);
          const y2 = Math.max(box.start.y, box.current.y);
          const liveNodesMarquee = getCanvasState().nodes;
          const hit = liveNodesMarquee
            .filter(
              (node) =>
                !isHiddenBatchChild(node, liveNodesMarquee) &&
                node.position.x < x2 &&
                node.position.x + node.size.width > x1 &&
                node.position.y < y2 &&
                node.position.y + node.size.height > y1,
            )
            .map((node) => node.id);
          selectNodes(hit, gesture.additive);
        }
      }
    };

    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerUp);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerUp);
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
    };
  }, [applyGesture, toWorld]);

  /** Close floating menus (context and connect). */
  const closeFloatingMenus = useCallback(() => {
    setContextMenu(null);
    setConnectMenu(null);
  }, []);

  /** Start a gesture: kill text selection/native drag, capture the pointer. */
  const beginGesture = useCallback(
    (event: React.PointerEvent, gesture: GestureState) => {
      event.preventDefault();
      // No pointer capture for NODE drags: with capture active on the node
      // root, the browser retargets the follow-up click/dblclick to the root,
      // which silently kills double-click affordances inside the node body
      // (text-node edit). Movement tracking doesn't need capture — the
      // pointermove/pointerup listeners live on window.
      if (gesture.kind !== "node") {
        try {
          (event.currentTarget as Element).setPointerCapture(event.pointerId);
        } catch {
          // Pointer capture is best-effort (absent in some test DOMs).
        }
      }
      pointerRef.current = { x: event.clientX, y: event.clientY };
      gestureRef.current = gesture;
      setGestureActive(true);
      closeFloatingMenus();
    },
    [closeFloatingMenus],
  );

  const beginNodeDrag = useCallback(
    (event: React.PointerEvent, nodeId: string) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const state = getCanvasState();
      // Dragging a node inside the current selection moves the whole
      // selection; otherwise selection collapses to the grabbed node.
      if (!state.selectedNodeIds.includes(nodeId)) {
        selectNodes([nodeId], event.shiftKey);
      }
      const after = getCanvasState();
      // Origins = the selection PLUS every member of any selected group, deduped
      // by id. Building a Set of ids first means a member that is also selected
      // appears once, so it moves once (never twice) under the same delta.
      const originIds = new Set(after.selectedNodeIds);
      for (const node of after.nodes) {
        if (node.type === "group" && originIds.has(node.id)) {
          for (const memberId of memberIdsOf(node.id, after.nodes)) {
            originIds.add(memberId);
          }
        }
      }
      const origins = after.nodes
        .filter((node) => originIds.has(node.id))
        .map((node) => ({
          id: node.id,
          x: node.position.x,
          y: node.position.y,
        }));
      beginGesture(event, {
        kind: "node",
        startX: event.clientX,
        startY: event.clientY,
        origins,
      });
    },
    [beginGesture],
  );

  const beginResize = useCallback(
    (event: React.PointerEvent, nodeId: string, corner: ResizeCorner) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      const node = getCanvasState().nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const lockRatio =
        (node.type === "image" || node.type === "video") &&
        Boolean(node.metadata.content) &&
        node.metadata.freeResize !== true;
      frozenPanelNodeRef.current = node;
      setResizingNodeId(nodeId);
      beginGesture(event, {
        kind: "resize",
        id: nodeId,
        corner,
        startX: event.clientX,
        startY: event.clientY,
        origin: {
          x: node.position.x,
          y: node.position.y,
          width: node.size.width,
          height: node.size.height,
        },
        lockRatio,
      });
    },
    [beginGesture],
  );

  const beginConnect = useCallback(
    (
      event: React.PointerEvent,
      nodeId: string,
      handleType: "source" | "target",
    ) => {
      if (event.button !== 0) return;
      event.stopPropagation();
      setConnectPreview(toWorld(event.clientX, event.clientY));
      beginGesture(event, { kind: "connect", fromId: nodeId, handleType });
    },
    [beginGesture, toWorld],
  );

  // Wheel zoom: non-passive listener registered once; reads live viewport.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onWheel = (event: WheelEvent) => {
      // Canvas-scoped modals (CanvasModal) opt out of wheel-zoom so their
      // content scrolls natively instead of zooming the canvas underneath.
      const target = event.target as HTMLElement | null;
      if (target?.closest("[data-canvas-wheel-exempt]")) return;
      event.preventDefault();
      const rect = el.getBoundingClientRect();
      const pointer = {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      };
      const live = getCanvasState().viewport;
      const factor = Math.exp(-event.deltaY * 0.0015);
      setViewport(zoomAtPoint(live, pointer, live.scale * factor));
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, []);

  // Keyboard shortcuts + paste (active while the canvas is mounted; skipped
  // when typing into inputs/textareas so node editors keep native behavior).
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return;
      const meta = event.metaKey || event.ctrlKey;
      if (meta && event.key.toLowerCase() === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (meta && event.key.toLowerCase() === "y") {
        event.preventDefault();
        redo();
      } else if (meta && event.key.toLowerCase() === "a") {
        event.preventDefault();
        selectAll();
      } else if (meta && event.key.toLowerCase() === "c") {
        const copied = copySelection();
        if (copied >= 1) event.preventDefault();
      } else if (meta && event.key.toLowerCase() === "g") {
        // ⌘G groups the selection, ⌘⇧G releases it. Always preventDefault:
        // the browser's own ⌘G (find-next) is useless here and would steal
        // the key whenever the canvas selection can't be grouped.
        event.preventDefault();
        if (event.shiftKey) ungroupSelectedNodes();
        else groupSelectedNodes();
      } else if (event.key === "Delete" || event.key === "Backspace") {
        deleteSelection();
      } else if (event.key === "Escape") {
        clearSelection();
        closeFloatingMenus();
      }
    };

    const onPaste = (event: ClipboardEvent) => {
      if (isEditableTarget(event.target)) return;

      const data = event.clipboardData;
      if (!data) return;

      // Center of the current view in world coordinates.
      const rect = containerRef.current?.getBoundingClientRect();
      const centerClient = {
        x: (rect?.left ?? 0) + (rect?.width ?? 0) / 2,
        y: (rect?.top ?? 0) + (rect?.height ?? 0) / 2,
      };
      const centerWorld = toWorld(centerClient.x, centerClient.y);

      // Precedence:
      // 1. OS file items with image/* type → ingest as image nodes (screenshot Cmd+V).
      // 2. Internal node clipboard → paste copied nodes.
      // 3. OS plain text → ingest as text node.
      const imageFiles: File[] = [];
      for (const item of Array.from(data.items)) {
        if (item.kind === "file" && item.type.startsWith("image/")) {
          const file = item.getAsFile();
          if (file) imageFiles.push(file);
        }
      }

      if (imageFiles.length > 0) {
        event.preventDefault();
        void readFilesAsDataUrls(imageFiles).then((inputs) => {
          ingestFilesAsNodes(inputs, centerWorld);
        });
        return;
      }

      if (clipboardHasContent()) {
        event.preventDefault();
        pasteClipboard();
        return;
      }

      const text = data.getData("text/plain");
      if (text) {
        event.preventDefault();
        ingestTextAsNode(text, centerWorld);
      }
    };

    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("paste", onPaste);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("paste", onPaste);
    };
  }, [toWorld, closeFloatingMenus]);

  // Space-key pan mode: track via ref for capture-phase handler (zero re-render cost).
  // Cursor feedback starts with the actual drag so a missed keyup cannot leave
  // the idle canvas stuck alternating between default and grab cursors.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      if (isEditableTarget(event.target)) return;
      if (event.repeat) return;
      event.preventDefault(); // prevent scrollable ancestors from scrolling
      spaceRef.current = true;
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.code !== "Space") return;
      spaceRef.current = false;
    };
    const onBlur = () => {
      spaceRef.current = false;
    };
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const connectGesture =
    gestureRef.current?.kind === "connect" ? gestureRef.current : null;
  const connectSource = connectGesture
    ? nodeById.get(connectGesture.fromId)
    : null;
  const gridStyle =
    gridBackgroundStyle(gridMode, viewport.scale, viewport) ?? undefined;

  return (
    <div
      ref={containerRef}
      data-infinite-canvas="true"
      // Node content scales with the canvas, so a 12px label is 6px at 50%
      // zoom. Below 0.6 the cards drop their body text and keep only the
      // title, which is what a thumbnail needs to stay identifiable.
      data-canvas-lod={viewport.scale < 0.6 ? "low" : undefined}
      className={cn(
        "relative h-full w-full select-none overflow-hidden",
        gestureActive ? "cursor-grabbing" : "cursor-default",
        className,
      )}
      style={gridStyle}
      onPointerDownCapture={(event) => {
        // Space+left or middle-click: begin pan from anywhere (including over nodes).
        // beginGesture calls closeFloatingMenus() — no need to do it explicitly here.
        if ((spaceRef.current && event.button === 0) || event.button === 1) {
          event.preventDefault();
          event.stopPropagation();
          beginGesture(event, {
            kind: "pan",
            startX: event.clientX,
            startY: event.clientY,
            origin: getCanvasState().viewport,
          });
        }
      }}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        const files = Array.from(event.dataTransfer?.files ?? []);
        if (files.length === 0) return;
        const dropWorld = toWorld(event.clientX, event.clientY);
        void readFilesAsDataUrls(files).then((inputs) => {
          ingestFilesAsNodes(inputs, dropWorld);
        });
      }}
      onContextMenu={(event) => {
        // Right-click inside a node textarea/input must not open the canvas menu.
        if (isEditableTarget(event.target)) return;
        event.preventDefault();
        const rect = containerRef.current?.getBoundingClientRect();
        const cw = rect?.width ?? 0;
        const ch = rect?.height ?? 0;
        const rawX = event.clientX - (rect?.left ?? 0);
        const rawY = event.clientY - (rect?.top ?? 0);
        const { x: screenX, y: screenY } = clampMenuPosition(
          rawX,
          rawY,
          cw,
          ch,
        );
        const target = event.target as Element | null;
        const nodeEl = target?.closest("[data-canvas-node]");
        const edgeEl = target?.closest("[data-canvas-edge]");
        if (nodeEl instanceof HTMLElement) {
          const id = nodeEl.getAttribute("data-canvas-node") ?? "";
          // Select the node if it's not already selected
          if (!getCanvasState().selectedNodeIds.includes(id)) {
            selectNodes([id]);
          }
          setContextMenu({ kind: "node", id, x: screenX, y: screenY });
        } else if (edgeEl) {
          const id = edgeEl.getAttribute("data-canvas-edge") ?? "";
          setContextMenu({ kind: "edge", id, x: screenX, y: screenY });
        } else {
          const worldPoint = toWorld(event.clientX, event.clientY);
          setContextMenu({
            kind: "background",
            x: screenX,
            y: screenY,
            worldPoint,
          });
        }
      }}
      onPointerDown={(event) => {
        // Close floating menus on any pointerdown on the container background.
        // For left-click paths, beginGesture also calls closeFloatingMenus; this
        // covers non-left-click (e.g. right-click while the menu is open).
        closeFloatingMenus();
        if (event.button !== 0) return;
        if (event.metaKey || event.ctrlKey) {
          const start = toWorld(event.clientX, event.clientY);
          marqueeRef.current = { start, current: start };
          setMarqueeBox(marqueeRef.current);
          beginGesture(event, { kind: "marquee", additive: event.shiftKey });
          return;
        }
        clearSelection();
        beginGesture(event, {
          kind: "pan",
          startX: event.clientX,
          startY: event.clientY,
          origin: getCanvasState().viewport,
        });
      }}
    >
      <div
        className="absolute left-0 top-0 origin-top-left"
        style={{
          transform: `translate(${viewport.x}px, ${viewport.y}px) scale(${viewport.scale})`,
        }}
      >
        {/* Edges (world coordinates, under the nodes) */}
        <svg
          className="pointer-events-none absolute left-0 top-0 overflow-visible"
          width={1}
          height={1}
          aria-hidden="true"
        >
          <defs>
            <marker
              id="canvas-edge-arrow"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--color-canvas-edge)" />
            </marker>
            <marker
              id="canvas-edge-arrow-selected"
              viewBox="0 0 8 8"
              refX="7"
              refY="4"
              markerWidth="6"
              markerHeight="6"
              orient="auto-start-reverse"
            >
              <path d="M 0 1 L 7 4 L 0 7 z" fill="var(--color-brand-primary)" />
            </marker>
          </defs>
          {connections.map((connection) => {
            const from = nodeById.get(connection.fromNodeId);
            const to = nodeById.get(connection.toNodeId);
            if (!from || !to) return null;
            const isSelected = selectedConnectionId === connection.id;
            return (
              <path
                key={connection.id}
                data-canvas-edge={connection.id}
                d={connectionPath(sourceAnchor(from), targetAnchor(to))}
                fill="none"
                className={cn(
                  "pointer-events-auto cursor-pointer",
                  isSelected
                    ? "stroke-[var(--color-brand-primary)]"
                    : "stroke-[var(--color-canvas-edge)]",
                )}
                strokeWidth={isSelected ? 2 : 1.5}
                markerEnd={`url(#${
                  isSelected
                    ? "canvas-edge-arrow-selected"
                    : "canvas-edge-arrow"
                })`}
                onPointerDown={(event) => {
                  event.stopPropagation();
                  selectConnection(connection.id);
                }}
                onDoubleClick={() => removeConnection(connection.id)}
              />
            );
          })}
          {connectSource && connectGesture && connectPreview ? (
            <path
              d={connectionPath(
                connectHandleAnchor(connectSource, connectGesture.handleType),
                connectPreview,
              )}
              fill="none"
              className="stroke-[var(--color-brand-primary)]"
              strokeWidth={2}
              strokeDasharray="6 4"
            />
          ) : null}
        </svg>

        {/* Nodes — hidden batch children are skipped (collapsed group).
            Group nodes render first so they sit behind everything else; the
            stable sort keeps each partition's relative order (so the topmost
            group is the last group in node order — matching groupIdForPoint). */}
        {nodes
          .filter((node) => !isHiddenBatchChild(node, nodes))
          .sort((a, b) => groupRank(a) - groupRank(b))
          .map((node) => (
            <CanvasNodeView
              key={node.id}
              node={node}
              selected={selected.has(node.id)}
              onHeaderDown={beginNodeDrag}
              onResizeDown={beginResize}
              onConnectDown={beginConnect}
            />
          ))}

        {/* Per-node prompt panel — world-space, anchored under the selected node.
            Visible iff exactly ONE node is selected, type ∈ {image, video, audio},
            and the node is not a hidden batch child. */}
        {selectedNodeIds.length === 1 &&
          (() => {
            const selectedId = selectedNodeIds[0] as string;
            // While THIS node is being resized, hand the panel the snapshot
            // taken at gesture start. Identical props + memo = the panel skips
            // its whole-graph BFS for every frame of the drag; it re-anchors
            // when the gesture ends. Resizing some OTHER node still updates it.
            const panelNode =
              resizingNodeId === selectedId && frozenPanelNodeRef.current
                ? frozenPanelNodeRef.current
                : nodeById.get(selectedId);
            return panelNode &&
              !isHiddenBatchChild(panelNode, nodes) &&
              (panelNode.type === "image" ||
                panelNode.type === "video" ||
                panelNode.type === "audio") ? (
              <PromptPanel
                key={panelNode.id}
                node={panelNode}
                maxWorldWidth={
                  (containerRef.current?.clientWidth ?? 0) > 0
                    ? (containerRef.current?.clientWidth ?? 0) / viewport.scale
                    : undefined
                }
              />
            ) : null;
          })()}

        {/* Multi-select outline (reference v0.18): one dashed box around the
            whole selection. It is drawn from the SAME rect ⌘G would give the
            group, so the outline doubles as a preview of the box you get. */}
        {(() => {
          const selectedIds = new Set(selectedNodeIds);
          if (!canGroupSelection(selectedIds, nodes)) return null;
          const rect = groupWrapRect(
            groupSelectionMembers(selectedIds, nodes).filter(
              (node) => !isHiddenBatchChild(node, nodes),
            ),
          );
          if (rect.size.width <= 0 || rect.size.height <= 0) return null;
          return (
            <div
              data-canvas-selection-box="true"
              aria-hidden="true"
              className="pointer-events-none absolute z-0 rounded-2xl border border-dashed border-[var(--color-brand-primary)]/60"
              style={{
                left: rect.position.x,
                top: rect.position.y,
                width: rect.size.width,
                height: rect.size.height,
              }}
            />
          );
        })()}

        {/* Marquee rectangle */}
        {marqueeBox ? (
          <div
            data-canvas-marquee="true"
            className="absolute border border-[var(--color-brand-primary)]/70 bg-[var(--color-brand-subtle)]"
            style={{
              left: Math.min(marqueeBox.start.x, marqueeBox.current.x),
              top: Math.min(marqueeBox.start.y, marqueeBox.current.y),
              width: Math.abs(marqueeBox.current.x - marqueeBox.start.x),
              height: Math.abs(marqueeBox.current.y - marqueeBox.start.y),
            }}
          />
        ) : null}
      </div>

      <CanvasToolbar
        getContainerSize={() => ({
          width: containerRef.current?.clientWidth ?? 0,
          height: containerRef.current?.clientHeight ?? 0,
        })}
        fitViewport={fitViewport}
      />

      {/* Minimap — screen-space chrome, bottom-left, toggleable via toolbar */}
      <CanvasMinimap
        getContainerSize={() => ({
          width: containerRef.current?.clientWidth ?? 0,
          height: containerRef.current?.clientHeight ?? 0,
        })}
      />

      {/* Context menu — screen-space, outside the transform layer */}
      {contextMenu ? (
        <FloatingMenu
          x={contextMenu.x}
          y={contextMenu.y}
          dataAttr={{ name: "data-canvas-context-menu", value: "true" }}
        >
          {contextMenu.kind === "node" ? (
            <>
              <ContextMenuItem
                label="复制为副本"
                onClick={() => {
                  duplicateNodes([contextMenu.id]);
                  setContextMenu(null);
                }}
              />
              {/* Video stills (reference v0.17): pull a frame out as its own
                  image node so the next shot can reference it. */}
              {nodes.find((node) => node.id === contextMenu.id)?.type ===
                "video" &&
              nodes.find((node) => node.id === contextMenu.id)?.metadata.content
                ? (
                    [
                      ["first", "截取首帧"],
                      ["last", "截取尾帧"],
                      ["current", "截取当前帧"],
                    ] as ReadonlyArray<[VideoFramePosition, string]>
                  ).map(([position, label]) => (
                    <ContextMenuItem
                      key={position}
                      label={label}
                      onClick={() => {
                        const id = contextMenu.id;
                        setContextMenu(null);
                        void captureVideoFrameIntoNode(
                          id,
                          position,
                          currentTimeOfNodeVideo(id),
                        ).catch(() => {
                          toast.error("截帧失败，无法读取该视频画面");
                        });
                      }}
                    />
                  ))
                : null}
              {canGroupSelection(new Set(selectedNodeIds), nodes) ? (
                <ContextMenuItem
                  label={`打组（${selectedNodeIds.length} 个元素）`}
                  onClick={() => {
                    groupSelectedNodes();
                    setContextMenu(null);
                  }}
                />
              ) : null}
              {canUngroupSelection(new Set(selectedNodeIds), nodes) ? (
                <ContextMenuItem
                  label="解散组"
                  onClick={() => {
                    ungroupSelectedNodes();
                    setContextMenu(null);
                  }}
                />
              ) : null}
              <ContextMenuItem
                label={
                  selectedNodeIds.length > 1 &&
                  selectedNodeIds.includes(contextMenu.id)
                    ? `导出 ${selectedNodeIds.length} 个元素`
                    : "导出"
                }
                onClick={() => {
                  const ids =
                    selectedNodeIds.length > 1 &&
                    selectedNodeIds.includes(contextMenu.id)
                      ? selectedNodeIds
                      : [contextMenu.id];
                  void exportNodesAsZip(ids);
                  setContextMenu(null);
                }}
              />
              <ContextMenuItem
                label="删除"
                onClick={() => {
                  removeNodes([contextMenu.id]);
                  setContextMenu(null);
                }}
              />
            </>
          ) : contextMenu.kind === "edge" ? (
            <ContextMenuItem
              label="删除连线"
              onClick={() => {
                removeConnection(contextMenu.id);
                setContextMenu(null);
              }}
            />
          ) : (
            <>
              <ContextMenuItem
                label="粘贴到此处"
                disabled={!clipboardHasContent()}
                onClick={() => {
                  if (!clipboardHasContent()) return;
                  pasteClipboard(contextMenu.worldPoint);
                  setContextMenu(null);
                }}
              />
              {/* Moved off the dock: a destructive whole-board action does
                  not belong one mis-click away from the zoom controls. */}
              <ContextMenuItem
                label="清空画布"
                disabled={nodes.length === 0}
                onClick={() => {
                  setContextMenu(null);
                  if (
                    nodes.length > 0 &&
                    window.confirm("清空画布上的全部节点？")
                  ) {
                    removeNodes(nodes.map((node) => node.id));
                  }
                }}
              />
            </>
          )}
        </FloatingMenu>
      ) : null}

      {/* Connect menu — screen-space, outside the transform layer */}
      {connectMenu ? (
        <FloatingMenu
          x={connectMenu.screenX}
          y={connectMenu.screenY}
          dataAttr={{ name: "data-canvas-connect-menu", value: "true" }}
        >
          {CONNECT_MENU_ITEMS.map(({ type, label }) => (
            <button
              key={type}
              type="button"
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-text-primary hover:bg-surface-2"
              onClick={() => {
                createConnectedNode(
                  connectMenu.fromId,
                  type,
                  { x: connectMenu.worldX, y: connectMenu.worldY },
                  connectMenu.handleType,
                );
                setConnectMenu(null);
              }}
            >
              {connectMenuIcon(type)}
              {label}
            </button>
          ))}
        </FloatingMenu>
      ) : null}

      {/* Canvas overlay dialogs (crop, etc.) — screen-space, mounted once */}
      <CanvasDialogs />
    </div>
  );
}

// ── Node view (memoized frame + geometry-insensitive body) ─────

type NodeGestureHandler = (event: React.PointerEvent, nodeId: string) => void;
type ConnectGestureHandler = (
  event: React.PointerEvent,
  nodeId: string,
  handleType: "source" | "target",
) => void;
type ResizeGestureHandler = (
  event: React.PointerEvent,
  nodeId: string,
  corner: ResizeCorner,
) => void;

const CanvasNodeView = memo(function CanvasNodeView({
  node,
  selected,
  onHeaderDown,
  onResizeDown,
  onConnectDown,
}: {
  node: CanvasNode;
  selected: boolean;
  onHeaderDown: NodeGestureHandler;
  onResizeDown: ResizeGestureHandler;
  onConnectDown: ConnectGestureHandler;
}) {
  // Media with content renders full-bleed like the reference cards. a2ui
  // editor surfaces (XHSEditor/MarkdownEditor) are self-contained cards too —
  // no p-3 gap, so the editor sits flush against the node chrome (no double
  // border) and fills the node height.
  const fullBleed =
    node.type === "a2ui" ||
    node.type === "xhs" ||
    node.type === "phone" ||
    ((node.type === "image" || node.type === "video") &&
      Boolean(node.metadata.content));

  // Media with content gets "bare" chrome (reference paradigm): no card fill,
  // transparent border until selected — the rounded image IS the node.
  const bareMedia =
    (node.type === "image" || node.type === "video") &&
    Boolean(node.metadata.content);

  // Groups are inert containers: a translucent body plus a z-0 tier so they stay
  // BEHIND their members (rendered on top) even when the group itself is
  // selected — "groups render behind everything else" must hold in every state.
  const isGroup = node.type === "group";

  // team-step nodes take no upstream/downstream data — connecting to/from
  // them is a no-op wiring dead end, so don't show handles that invite it.
  // A group has no content of its own, so nothing can feed INTO it, but one
  // edge OUT of it references every valid resource it contains
  // (resource-references.ts expands group members).
  const canReceiveUpstream = node.type !== "group" && node.type !== "team-step";
  const canFeedDownstream = node.type !== "team-step";

  // Batch group state
  const batchChildIds = node.metadata.batch?.childIds;
  const isBatchRoot = batchChildIds !== undefined && batchChildIds.length > 0;
  const isCollapsed = isBatchRoot && node.metadata.batch?.expanded === false;
  const isBatchChild = node.metadata.batch?.rootId !== undefined;
  const batchTotal = isBatchRoot ? batchChildIds.length + 1 : 0;

  return (
    <div
      data-canvas-node={node.id}
      data-canvas-node-selected={selected || undefined}
      className={cn(
        // 16px / 1px, not 24px / 2px: a 24px radius around a 12px A2UI
        // CardShell leaves two non-concentric corners, and the 2px border
        // reads a weight heavier than anything inside the node.
        "group absolute flex flex-col rounded-2xl border transition-shadow duration-200",
        isGroup
          ? "border-dashed bg-surface-1/40"
          : bareMedia
            ? "bg-transparent"
            : "bg-surface-1",
        // Selection is a double ring drawn with box-shadow, not a border
        // colour swap: swapping the border would keep the box the same size
        // here but any future width change shifts the content by 1px.
        selected
          ? "border-transparent shadow-[0_0_0_2px_var(--color-brand-primary),0_0_0_6px_var(--color-brand-subtle),0_8px_24px_rgba(0,0,0,0.08)]"
          : bareMedia
            ? "border-transparent shadow-lg shadow-black/10"
            : "border-border shadow-lg shadow-black/5",
        // Groups sit behind at z-0 in every state; others use the normal
        // z-10 / z-50 (selected) tiers.
        isGroup ? "z-0" : selected ? "z-50" : "z-10",
      )}
      style={{
        transform: `translate3d(${node.position.x}px, ${node.position.y}px, 0)`,
        width: node.size.width,
        height: node.size.height,
        contain: "layout style",
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
        // Whole-card drag (reference paradigm — the header bar is gone, the
        // title floats above the card). Pointerdown anywhere on the card
        // starts a node drag EXCEPT on interactive elements and inside
        // opt-out zones (rich a2ui editors), where it only ensures selection.
        const target = event.target as HTMLElement | null;
        if (
          target?.closest(
            "button, input, textarea, select, a, label, audio, video, [contenteditable], [data-canvas-no-drag]",
          )
        ) {
          if (!getCanvasState().selectedNodeIds.includes(node.id)) {
            selectNodes([node.id], event.shiftKey);
          }
          return;
        }
        onHeaderDown(event, node.id);
      }}
    >
      {/* Floating title above the card (reference paradigm: no header bar).
          Doubles as the GUARANTEED drag handle: rich-interactive nodes (a2ui
          editors, label-covered empty-image) opt their whole body out of the
          whole-card drag, so without this they would be undraggable. */}
      <div
        className="absolute -top-7 left-3 z-20 max-w-[calc(100%-24px)] cursor-move px-1 py-1 -mx-1 -my-1"
        onPointerDown={(event) => {
          event.stopPropagation();
          onHeaderDown(event, node.id);
        }}
      >
        <span className="block truncate text-[12px] font-medium text-text-secondary">
          {node.title}
        </span>
      </div>
      <HoverToolbar node={node} selected={selected} />
      {/* Collapsed ghost: two decorative stacked cards behind the root */}
      {isCollapsed ? (
        <>
          <div
            data-canvas-batch-ghost="2"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-2xl border border-border bg-surface-2"
            style={{
              transform: "translate(6px, 6px) rotate(2deg)",
              zIndex: -1,
            }}
          />
          <div
            data-canvas-batch-ghost="1"
            aria-hidden="true"
            className="pointer-events-none absolute inset-0 rounded-2xl border border-border bg-surface-2"
            style={{
              transform: "translate(12px, 12px) rotate(4deg)",
              zIndex: -2,
            }}
          />
        </>
      ) : null}

      {/* Floating action cluster (top-right, glass chip): batch star / ×N /
          close. Replaces the old header-bar buttons; visible on hover or
          selection, but always in the DOM (opacity-only) so tests and
          assistive tech can reach them. */}
      <div
        className={cn(
          "absolute right-2 top-2 z-30 flex items-center gap-0.5 rounded-lg border border-border bg-surface-1/85 px-1 py-0.5 shadow-sm backdrop-blur transition-opacity duration-150",
          selected
            ? "pointer-events-auto opacity-100"
            : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
        )}
      >
        {/* Batch child: promote-to-primary star */}
        {isBatchChild ? (
          <button
            type="button"
            aria-label="set as primary"
            data-canvas-batch-primary={node.id}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setBatchPrimary(node.id)}
            className="rounded p-0.5 text-text-tertiary hover:bg-surface-3 hover:text-text-primary"
          >
            <Star size={12} />
          </button>
        ) : null}
        {/* Batch root: toggle expand/collapse badge */}
        {isBatchRoot ? (
          <button
            type="button"
            aria-label="toggle batch group"
            data-canvas-batch-toggle={node.id}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => toggleBatchExpanded(node.id)}
            className="rounded px-1 py-0.5 text-[10px] font-medium text-text-tertiary hover:bg-surface-3 hover:text-text-primary"
          >
            ×{batchTotal}
          </button>
        ) : null}
        <button
          type="button"
          aria-label="close node"
          onClick={() => removeNodes([node.id])}
          onPointerDown={(event) => event.stopPropagation()}
          className="rounded p-0.5 text-text-tertiary hover:bg-surface-3 hover:text-text-primary"
        >
          <X size={12} />
        </button>
      </div>
      <div
        {...(node.type === "a2ui" ||
        node.type === "xhs" ||
        node.type === "phone"
          ? { "data-canvas-no-drag": "true" }
          : {})}
        data-canvas-node-body="true"
        className={cn(
          "min-h-0 flex-1",
          fullBleed ? "overflow-hidden rounded-2xl" : "overflow-y-auto p-3",
        )}
      >
        <NodeBody node={node} />
      </div>
      {/* Reference-parity bottom fade: text blends into the card instead of
          clipping hard at the edge. */}
      {node.type === "text" ? (
        <div
          aria-hidden="true"
          className="pointer-events-none absolute inset-x-0.5 bottom-0.5 z-10 h-10 rounded-b-[22px] bg-gradient-to-t from-surface-1 to-transparent"
        />
      ) : null}

      {/* Connect handles: 48px hit zone with a 12px dot on each side
          (reference paradigm) — left = target (drag out for an upstream
          feed), right = source (drag out to feed a downstream node). Shown
          on hover/selection, drag to another node. team-step nodes don't
          participate in the connection graph at all; a group gets only the
          source handle — see `canReceiveUpstream` / `canFeedDownstream`. */}
      {canReceiveUpstream ? (
        <>
          <button
            type="button"
            aria-label="connect into node"
            data-canvas-connect-handle-target={node.id}
            className={cn(
              "absolute -left-6 top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150",
              selected
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
            )}
            onPointerDown={(event) => onConnectDown(event, node.id, "target")}
          >
            <span className="size-3.5 rounded-full border-2 border-[var(--color-brand-primary)] bg-surface-1 transition-transform hover:scale-125" />
          </button>
        </>
      ) : null}
      {canFeedDownstream ? (
        <>
          <button
            type="button"
            aria-label="connect from node"
            data-canvas-connect-handle-source={node.id}
            className={cn(
              "absolute -right-6 top-1/2 z-30 flex size-12 -translate-y-1/2 cursor-crosshair items-center justify-center transition-opacity duration-150",
              selected
                ? "pointer-events-auto opacity-100"
                : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100",
            )}
            onPointerDown={(event) => onConnectDown(event, node.id, "source")}
          >
            <span className="size-3.5 rounded-full border-2 border-[var(--color-brand-primary)] bg-surface-1 transition-transform hover:scale-125" />
          </button>
        </>
      ) : null}
      {/* Resize: four invisible 28px corner zones (cursor is the affordance). */}
      <div
        data-canvas-resize-handle={node.id}
        data-resize-corner="nw"
        className="absolute -left-3.5 -top-3.5 z-40 size-7 cursor-nwse-resize"
        onPointerDown={(event) => onResizeDown(event, node.id, "nw")}
      />
      <div
        data-canvas-resize-handle={node.id}
        data-resize-corner="ne"
        className="absolute -right-3.5 -top-3.5 z-40 size-7 cursor-nesw-resize"
        onPointerDown={(event) => onResizeDown(event, node.id, "ne")}
      />
      <div
        data-canvas-resize-handle={node.id}
        data-resize-corner="sw"
        className="absolute -bottom-3.5 -left-3.5 z-40 size-7 cursor-nesw-resize"
        onPointerDown={(event) => onResizeDown(event, node.id, "sw")}
      />
      <div
        data-canvas-resize-handle={node.id}
        data-resize-corner="se"
        className="absolute -bottom-3.5 -right-3.5 z-40 size-7 cursor-nwse-resize"
        onPointerDown={(event) => onResizeDown(event, node.id, "se")}
      />
    </div>
  );
});

function ContextMenuItem({
  label,
  onClick,
  disabled,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full px-3 py-1.5 text-left text-xs text-text-primary hover:bg-surface-2",
        disabled && "cursor-not-allowed opacity-50 hover:bg-transparent",
      )}
    >
      {label}
    </button>
  );
}
