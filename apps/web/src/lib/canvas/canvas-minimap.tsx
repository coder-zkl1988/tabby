/**
 * canvas-minimap.tsx — Minimap overlay for the canvas sidebar (W4.1).
 *
 * Adaptation note: the reference minimap is 240×160 on a full-page canvas.
 * Our sidebar canvas is narrower, so we use 200×132.
 *
 * Rendered from CanvasSurface as screen-space chrome inside the container
 * root (same mount point as the toolbar). Subscribes to canvas-store and
 * canvas-ui-prefs; no per-frame listeners. stopPropagation on all pointer
 * events so minimap clicks never start canvas gestures.
 *
 * Navigation: pointerdown centers the viewport on the pressed world point at
 * the current zoom, and holding + dragging keeps panning (pointer capture) —
 * the minimap acts as a joystick, not just a teleport target. The world→mini
 * layout is FROZEN at drag start: panning moves the viewport, the viewport
 * feeds the map bounds, and recomputing the mapping mid-drag would make the
 * pointer chase a moving target.
 */

import { useRef, useState } from "react";
import { isHiddenBatchChild } from "./canvas-batch";
import {
  type CanvasNode,
  getCanvasState,
  setViewport,
  useCanvas,
} from "./canvas-store";
import { useCanvasUiPrefs } from "./canvas-ui-prefs";
import {
  minimapLayout,
  minimapPointToWorld,
  worldBoundsOf,
} from "./minimap-math";

const MINI_W = 200;
const MINI_H = 132;

/**
 * World bounds shown when the board has no nodes — an arbitrary but stable
 * area around the origin (reference parity: the minimap stays visible on an
 * empty board so toggling it always has a visible effect).
 */
const EMPTY_WORLD_BOUNDS = { x: -500, y: -500, width: 1000, height: 1000 };

/**
 * Minimap blocks carry *state*, not type. Nine unlabelled hues asked the
 * reader to memorise a legend that was never shown, and reserved brand
 * teal for "audio" — the colour that now means selected / in progress
 * everywhere else on the canvas.
 */
function nodeRectClass(node: CanvasNode, selected: boolean): string {
  if (selected) return "bg-[var(--color-brand-primary)]";
  if (node.metadata.task?.status === "generating") {
    return "bg-[var(--color-brand-primary)]/60 animate-pulse";
  }
  if (node.metadata.task?.status === "error")
    return "bg-[var(--color-error)]/70";
  return "bg-[var(--color-neutral-300)]";
}

export function CanvasMinimap({
  getContainerSize,
}: {
  getContainerSize: () => { width: number; height: number };
}) {
  const { nodes, viewport, selectedNodeIds } = useCanvas();
  const { minimapVisible } = useCanvasUiPrefs();
  const [isDragging, setIsDragging] = useState(false);
  // Layout snapshot taken at drag start — see the header note on freezing.
  const dragLayoutRef = useRef<ReturnType<typeof minimapLayout> | null>(null);

  // Only render visible nodes (skip hidden batch children)
  const visibleNodes = nodes.filter((n) => !isHiddenBatchChild(n, nodes));
  const selectedIds = new Set(selectedNodeIds);

  if (!minimapVisible) {
    return null;
  }

  const { width: containerW, height: containerH } = getContainerSize();

  // Viewport rect expressed in world coordinates
  const viewportRect = {
    x: -viewport.x / viewport.scale,
    y: -viewport.y / viewport.scale,
    width: containerW / viewport.scale,
    height: containerH / viewport.scale,
  };

  const bounds = worldBoundsOf(
    visibleNodes,
    visibleNodes.length > 0 ? viewportRect : EMPTY_WORLD_BOUNDS,
  );
  if (!bounds) return null;

  const layout = minimapLayout(bounds, { width: MINI_W, height: MINI_H });

  // Map a node rect to mini px coords
  function toMini(
    worldX: number,
    worldY: number,
    worldW: number,
    worldH: number,
  ) {
    const left = (worldX - layout.offsetX) * layout.scale;
    const top = (worldY - layout.offsetY) * layout.scale;
    const width = Math.max(2, worldW * layout.scale);
    const height = Math.max(2, worldH * layout.scale);
    return { left, top, width, height };
  }

  // Viewport outline in mini coords
  const vp = toMini(
    viewportRect.x,
    viewportRect.y,
    viewportRect.width,
    viewportRect.height,
  );

  function navigateToMiniPoint(
    clientX: number,
    clientY: number,
    currentTarget: Element,
    layoutToUse: ReturnType<typeof minimapLayout>,
  ) {
    const rect = currentTarget.getBoundingClientRect();
    const miniX = clientX - rect.left;
    const miniY = clientY - rect.top;
    const world = minimapPointToWorld({ x: miniX, y: miniY }, layoutToUse);
    const { width: cw, height: ch } = getContainerSize();
    const live = getCanvasState().viewport;
    setViewport({
      scale: live.scale,
      x: cw / 2 - world.x * live.scale,
      y: ch / 2 - world.y * live.scale,
    });
  }

  return (
    <div
      data-canvas-minimap="true"
      className="absolute bottom-3 left-3 z-30 cursor-crosshair overflow-hidden rounded-lg border border-border bg-surface-1/90 shadow-md"
      style={{ width: MINI_W, height: MINI_H }}
      onPointerDown={(event) => {
        event.stopPropagation();
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragLayoutRef.current = layout;
        setIsDragging(true);
        navigateToMiniPoint(
          event.clientX,
          event.clientY,
          event.currentTarget,
          layout,
        );
      }}
      onPointerMove={(event) => {
        if (!isDragging) return;
        navigateToMiniPoint(
          event.clientX,
          event.clientY,
          event.currentTarget,
          dragLayoutRef.current ?? layout,
        );
      }}
      onPointerUp={(event) => {
        event.stopPropagation();
        setIsDragging(false);
        dragLayoutRef.current = null;
      }}
      onPointerCancel={() => {
        setIsDragging(false);
        dragLayoutRef.current = null;
      }}
    >
      {/* Node rectangles */}
      {visibleNodes.map((node) => {
        const { left, top, width, height } = toMini(
          node.position.x,
          node.position.y,
          node.size.width,
          node.size.height,
        );
        return (
          <div
            key={node.id}
            data-canvas-minimap-node={node.id}
            className={`absolute rounded-[1px] ${nodeRectClass(node, selectedIds.has(node.id))}`}
            style={{ left, top, width, height }}
          />
        );
      })}

      {/* Viewport outline */}
      <div
        data-canvas-minimap-viewport="true"
        className="pointer-events-none absolute rounded-[2px] border-[1.5px] border-[var(--color-text-primary)] bg-[var(--color-accent-subtle)]"
        style={{
          left: vp.left,
          top: vp.top,
          width: vp.width,
          height: vp.height,
        }}
      />
    </div>
  );
}
