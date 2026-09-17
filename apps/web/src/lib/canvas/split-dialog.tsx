/**
 * split-dialog.tsx — grid split dialog (W3.3; draggable grid lines P2).
 *
 * Splits an image into child image nodes using the pure-canvas API (offscreen
 * canvas drawImage 9-arg form → PNG dataURL per piece). The grid lines are
 * DRAGGABLE for non-uniform slices: the rows/cols steppers are the fast path
 * (they regenerate uniform cuts), and the user can then drag / add / delete /
 * reset individual lines.
 *
 * Single source of truth: `xCuts` (vertical lines) and `yCuts` (horizontal
 * lines), both in IMAGE-pixel coordinates. rows/cols are derived from the cut
 * counts. Confirm delegates to applySplitAtCuts (the non-uniform applier); the
 * uniform agent op path stays on applySplit.
 *
 * Follows crop-dialog.tsx precedent:
 *   - Uses the shared canvas-scoped CanvasModal shell (./canvas-modal)
 *   - Uses loadImageBitmap (extracted shared helper, not local fetch)
 *   - Pointer capture on the preview container so drags keep firing off the line
 *   - Adds child nodes via applySplitAtCuts + toast.success / toast.error
 *   - data-canvas-split-dialog attribute on the content container
 *   - data-canvas-split-confirm on the confirm button
 */

import { Grid3x3, Plus, RotateCcw, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { CanvasDialogState } from "./canvas-dialogs";
import { closeCanvasDialog } from "./canvas-dialogs";
import { applySplitAtCuts } from "./canvas-image-ops";
import { CanvasModal } from "./canvas-modal";
import { getCanvasState } from "./canvas-store";
import { fitScale } from "./crop-geometry";
import { loadImageBitmap } from "./load-image-bitmap";

// ── Constants ──────────────────────────────────────────────────────────────

const PREVIEW_MAX_W = 600;
const PREVIEW_MAX_H = 380;
const DEFAULT_ROWS = 2;
const DEFAULT_COLS = 2;
const MIN_GRID = 1;
const MAX_GRID = 12;
const MIN_GAP = 8; // image px kept between neighbouring lines and the edges
const HIT = 12; // px thickness of a line's draggable hit-strip (>= 8)

// ── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Uniform interior cut positions (image px) for an N-division split. Matches
 * gridPieceRects boundaries: base = floor(size / count), cuts at base·1 .. base·
 * (count-1). Returns [] for count <= 1.
 */
function buildUniformCuts(size: number, count: number): number[] {
  const base = Math.floor(size / count);
  const cuts: number[] = [];
  for (let i = 1; i < count; i++) cuts.push(base * i);
  return cuts;
}

/**
 * Midpoint (image px) of the widest gap between the existing cuts and the edges —
 * where an added line should land.
 */
function widestGapMidpoint(cuts: number[], size: number): number {
  const bounds = [0, ...cuts, size];
  let best = Math.round(size / 2);
  let widest = -1;
  for (let i = 0; i < bounds.length - 1; i++) {
    const lo = bounds[i] ?? 0;
    const hi = bounds[i + 1] ?? size;
    const gap = hi - lo;
    if (gap > widest) {
      widest = gap;
      best = Math.round(lo + gap / 2);
    }
  }
  return best;
}

// ── SplitDialog ─────────────────────────────────────────────────────────────

export function SplitDialog({
  state,
}: {
  state: NonNullable<CanvasDialogState> & { kind: "split" };
}) {
  const { nodeId } = state;
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  // Source of truth — interior grid-line positions in IMAGE pixels.
  const [xCuts, setXCuts] = useState<number[]>([]);
  const [yCuts, setYCuts] = useState<number[]>([]);

  // Active drag kept in a ref to avoid closure identity churn.
  const dragRef = useRef<{ axis: "x" | "y"; index: number } | null>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const node = getCanvasState().nodes.find((n) => n.id === nodeId);
  const srcUrl = node?.metadata.content as string | undefined;
  const srcTitle = node?.title ?? "图片";

  useEffect(() => {
    if (!srcUrl) {
      toast.error("图片加载失败");
      closeCanvasDialog();
      return;
    }

    let cancelled = false;
    let loaded: { bitmap: ImageBitmap; objectUrl: string } | null = null;

    (async () => {
      try {
        const result = await loadImageBitmap(srcUrl);
        if (cancelled) {
          result.bitmap.close();
          URL.revokeObjectURL(result.objectUrl);
          return;
        }
        loaded = result;
        setBitmap(result.bitmap);
        setObjUrl(result.objectUrl);
        // Seed uniform cuts from the default grid once dimensions are known.
        setXCuts(buildUniformCuts(result.bitmap.width, DEFAULT_COLS));
        setYCuts(buildUniformCuts(result.bitmap.height, DEFAULT_ROWS));
      } catch {
        if (cancelled) return;
        toast.error("图片加载失败");
        closeCanvasDialog();
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      if (loaded) {
        loaded.bitmap.close();
        URL.revokeObjectURL(loaded.objectUrl);
      }
    };
  }, [srcUrl]);

  useEffect(() => {
    return () => {
      bitmap?.close();
    };
  }, [bitmap]);

  // Derived values
  const scale = bitmap
    ? fitScale(bitmap.width, bitmap.height, PREVIEW_MAX_W, PREVIEW_MAX_H)
    : 1;
  const displayW = bitmap ? Math.round(bitmap.width * scale) : 0;
  const displayH = bitmap ? Math.round(bitmap.height * scale) : 0;

  const cols = xCuts.length + 1;
  const rows = yCuts.length + 1;
  const totalPieces = cols * rows;
  const avgW = bitmap ? Math.max(1, Math.floor(bitmap.width / cols)) : 0;
  const avgH = bitmap ? Math.max(1, Math.floor(bitmap.height / rows)) : 0;

  // ── Line mutations ────────────────────────────────────────────────

  // Clamp a dragged line between its neighbours (>= MIN_GAP) and the edges.
  const setCut = (axis: "x" | "y", index: number, imgPos: number) => {
    if (!bitmap) return;
    const size = axis === "x" ? bitmap.width : bitmap.height;
    const update = (cuts: number[]): number[] => {
      const next = [...cuts];
      const lo = (next[index - 1] ?? 0) + MIN_GAP;
      const hi = (next[index + 1] ?? size) - MIN_GAP;
      next[index] = Math.round(Math.min(Math.max(imgPos, lo), hi));
      return next;
    };
    if (axis === "x") setXCuts(update);
    else setYCuts(update);
  };

  const addCut = (axis: "x" | "y") => {
    if (!bitmap) return;
    const size = axis === "x" ? bitmap.width : bitmap.height;
    const update = (cuts: number[]): number[] => {
      const spot = widestGapMidpoint(cuts, size);
      // Dedupe so derived rows/cols stay consistent with cutPieceRects output.
      return [...new Set([...cuts, spot])].sort((a, b) => a - b);
    };
    if (axis === "x") setXCuts(update);
    else setYCuts(update);
  };

  const removeCut = (axis: "x" | "y", index: number) => {
    if (axis === "x") setXCuts((cuts) => cuts.filter((_, i) => i !== index));
    else setYCuts((cuts) => cuts.filter((_, i) => i !== index));
  };

  // Redistribute evenly at the CURRENT row/col count.
  const resetCuts = () => {
    if (!bitmap) return;
    setXCuts(buildUniformCuts(bitmap.width, cols));
    setYCuts(buildUniformCuts(bitmap.height, rows));
  };

  // Stepper → regenerate uniform cuts for that axis (the fast path).
  const setColCount = (value: number) => {
    if (!bitmap) return;
    const n = Math.max(MIN_GRID, Math.min(MAX_GRID, value || 1));
    setXCuts(buildUniformCuts(bitmap.width, n));
  };
  const setRowCount = (value: number) => {
    if (!bitmap) return;
    const n = Math.max(MIN_GRID, Math.min(MAX_GRID, value || 1));
    setYCuts(buildUniformCuts(bitmap.height, n));
  };

  // ── Drag handlers ─────────────────────────────────────────────────

  const onLinePointerDown = (
    e: React.PointerEvent<HTMLDivElement>,
    axis: "x" | "y",
    index: number,
  ) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      previewRef.current?.setPointerCapture(e.pointerId);
    } catch {
      // pointer capture is best-effort
    }
    dragRef.current = { axis, index };
  };

  const onPreviewPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || !bitmap) return;
    const rect = previewRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return;
    if (drag.axis === "x") {
      const imgX = ((e.clientX - rect.left) / rect.width) * bitmap.width;
      setCut("x", drag.index, imgX);
    } else {
      const imgY = ((e.clientY - rect.top) / rect.height) * bitmap.height;
      setCut("y", drag.index, imgY);
    }
  };

  const onPreviewPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    try {
      previewRef.current?.releasePointerCapture(e.pointerId);
    } catch {
      // release is best-effort
    }
  };

  // ── Confirm ───────────────────────────────────────────────────────

  const handleConfirm = useCallback(async () => {
    if (!bitmap) return;
    await applySplitAtCuts(nodeId, xCuts, yCuts);
    closeCanvasDialog();
    toast.success(`已拆分为 ${totalPieces} 个节点`);
  }, [bitmap, xCuts, yCuts, nodeId, totalPieces]);

  return (
    <CanvasModal title="拆分图片" maxWidth={760} onClose={closeCanvasDialog}>
      <div data-canvas-split-dialog="true" className="px-6 pb-6">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-text-secondary">
            加载中…
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Preview area with draggable grid lines */}
            <div
              ref={previewRef}
              className="relative mx-auto overflow-hidden rounded-lg bg-surface-2"
              style={{
                width: displayW,
                height: displayH,
                touchAction: "none",
              }}
              onPointerMove={onPreviewPointerMove}
              onPointerUp={onPreviewPointerUp}
              onPointerLeave={onPreviewPointerUp}
            >
              {objUrl ? (
                <img
                  src={objUrl}
                  alt={srcTitle}
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: displayW,
                    height: displayH,
                    userSelect: "none",
                    pointerEvents: "none",
                  }}
                  draggable={false}
                />
              ) : null}

              {/* Vertical lines (xCuts / 竖线) */}
              {bitmap
                ? xCuts.map((cut, index) => {
                    const leftPx = Math.round(cut * scale);
                    return (
                      <div
                        key={`x-${cut}`}
                        className="group absolute cursor-col-resize"
                        style={{
                          left: leftPx - HIT / 2,
                          top: 0,
                          width: HIT,
                          height: displayH,
                        }}
                        onPointerDown={(e) => onLinePointerDown(e, "x", index)}
                        onDoubleClick={() => removeCut("x", index)}
                      >
                        <div
                          className="pointer-events-none absolute top-0"
                          style={{
                            left: HIT / 2,
                            width: 1,
                            height: displayH,
                            background: "rgba(255,255,255,0.85)",
                            boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
                          }}
                        />
                        <button
                          type="button"
                          aria-label="删除竖线"
                          className="absolute left-1/2 top-1 flex h-4 w-4 -translate-x-1/2 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeCut("x", index);
                          }}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    );
                  })
                : null}

              {/* Horizontal lines (yCuts / 横线) */}
              {bitmap
                ? yCuts.map((cut, index) => {
                    const topPx = Math.round(cut * scale);
                    return (
                      <div
                        key={`y-${cut}`}
                        className="group absolute cursor-row-resize"
                        style={{
                          top: topPx - HIT / 2,
                          left: 0,
                          width: displayW,
                          height: HIT,
                        }}
                        onPointerDown={(e) => onLinePointerDown(e, "y", index)}
                        onDoubleClick={() => removeCut("y", index)}
                      >
                        <div
                          className="pointer-events-none absolute left-0"
                          style={{
                            top: HIT / 2,
                            height: 1,
                            width: displayW,
                            background: "rgba(255,255,255,0.85)",
                            boxShadow: "0 0 0 1px rgba(0,0,0,0.35)",
                          }}
                        />
                        <button
                          type="button"
                          aria-label="删除横线"
                          className="absolute top-1/2 left-1 flex h-4 w-4 -translate-y-1/2 items-center justify-center rounded-full bg-black/60 text-white opacity-0 transition-opacity group-hover:opacity-100"
                          onPointerDown={(e) => e.stopPropagation()}
                          onClick={(e) => {
                            e.stopPropagation();
                            removeCut("y", index);
                          }}
                        >
                          <X size={10} />
                        </button>
                      </div>
                    );
                  })
                : null}
            </div>

            {/* Row 1: steppers + readout */}
            <div className="flex items-center gap-6 text-sm">
              <label className="flex items-center gap-2 text-text-primary">
                行数
                <input
                  type="number"
                  min={MIN_GRID}
                  max={MAX_GRID}
                  value={rows}
                  onChange={(e) =>
                    setRowCount(Number.parseInt(e.target.value, 10) || 1)
                  }
                  className="w-14 rounded border border-border bg-surface-1 px-2 py-1 text-center text-text-primary"
                />
              </label>
              <label className="flex items-center gap-2 text-text-primary">
                列数
                <input
                  type="number"
                  min={MIN_GRID}
                  max={MAX_GRID}
                  value={cols}
                  onChange={(e) =>
                    setColCount(Number.parseInt(e.target.value, 10) || 1)
                  }
                  className="w-14 rounded border border-border bg-surface-1 px-2 py-1 text-center text-text-primary"
                />
              </label>
              <span className="text-text-secondary">
                切片 {totalPieces} 个 · 平均约 {avgW} × {avgH} px
              </span>
            </div>

            {/* Row 2: line ops + confirm */}
            <div className="flex items-center gap-2 text-sm">
              <button
                type="button"
                onClick={() => addCut("x")}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-text-primary hover:bg-surface-2"
              >
                <Plus size={14} />
                添加竖线
              </button>
              <button
                type="button"
                onClick={() => addCut("y")}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-text-primary hover:bg-surface-2"
              >
                <Plus size={14} />
                添加横线
              </button>
              <button
                type="button"
                onClick={resetCuts}
                className="flex items-center gap-1.5 rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-text-primary hover:bg-surface-2"
              >
                <RotateCcw size={14} />
                重置
              </button>

              <button
                type="button"
                data-canvas-split-confirm="true"
                disabled={totalPieces === 1}
                onClick={handleConfirm}
                className="ml-auto flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Grid3x3 size={14} />
                拆分为 {totalPieces} 个节点
              </button>
            </div>
          </div>
        )}
      </div>
    </CanvasModal>
  );
}
