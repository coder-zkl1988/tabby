/**
 * mask-dialog.tsx — local mask edit dialog (W3.5, T6; reworked per reference v0.17).
 *
 * Sanctioned approach: ONE offscreen mask canvas at full bitmap resolution.
 * On each pointer stroke, paint into BOTH the display overlay (for visual
 * feedback) and the full-res mask (with coords scaled up by 1/fitScale).
 *
 * On confirm the mask does NOT become an API `mask` parameter any more — see
 * mask-annotation.ts. It is composited onto a copy of the source as a
 * translucent overlay, saved into the media dir, and placed on the canvas as an
 * ordinary image node; source + annotation then feed the result node as two
 * plain reference images. Confirm is split in two: 导出到画布 writes the nodes
 * and prefills the prompt for review, 立刻生成 also fires the request.
 *
 * Container pointer capture follows crop-dialog precedent:
 * capture on the painting container, NOT the cursor dot.
 */

import { saveInboundImage } from "@/lib/media/inbound-image";
import { Brush, Eraser } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import type { CanvasDialogState } from "./canvas-dialogs";
import { closeCanvasDialog } from "./canvas-dialogs";
import { generateImageIntoNode } from "./canvas-generation";
import { CanvasModal } from "./canvas-modal";
import {
  addNode,
  connectNodes,
  getCanvasState,
  selectNodes,
} from "./canvas-store";
import { fitScale } from "./crop-geometry";
import { loadImageBitmap } from "./load-image-bitmap";
import {
  composeMaskAnnotation,
  composeMaskEditPrompt,
} from "./mask-annotation";
import { setDraft } from "./prompt-drafts";
import { servableSourceOf, usableReferencePaths } from "./prompt-panel-utils";

// ── Constants ──────────────────────────────────────────────────────────────

const PREVIEW_MAX_W = 640;
const PREVIEW_MAX_H = 400;
const DEFAULT_BRUSH_SIZE = 24;

// ── MaskDialog ─────────────────────────────────────────────────────────────

export function MaskDialog({
  state,
}: {
  state: NonNullable<CanvasDialogState> & { kind: "mask" };
}) {
  const { nodeId } = state;
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [brushMode, setBrushMode] = useState<"brush" | "eraser">("brush");
  const [brushSize, setBrushSize] = useState(DEFAULT_BRUSH_SIZE);
  const [prompt, setPrompt] = useState("");
  const [painted, setPainted] = useState(false);
  const [saving, setSaving] = useState(false);

  // Canvas refs
  const overlayRef = useRef<HTMLCanvasElement>(null);
  const maskRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Drawing state ref (avoids closure identity issues)
  const drawingRef = useRef<{
    active: boolean;
    lastX: number;
    lastY: number;
    scale: number;
  } | null>(null);

  const node = getCanvasState().nodes.find((n) => n.id === nodeId);
  const srcUrl = node?.metadata.content as string | undefined;
  const sourceImage = node ? servableSourceOf(node) : null;

  useEffect(() => {
    if (!srcUrl || !sourceImage) {
      toast.error("图片加载失败");
      closeCanvasDialog();
      return;
    }

    let cancelled = false;
    let createdObjUrl: string | null = null;

    (async () => {
      try {
        const result = await loadImageBitmap(srcUrl);
        if (cancelled) {
          result.bitmap.close();
          URL.revokeObjectURL(result.objectUrl);
          return;
        }
        createdObjUrl = result.objectUrl;
        setBitmap(result.bitmap);
        setObjUrl(createdObjUrl);
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
      if (createdObjUrl) URL.revokeObjectURL(createdObjUrl);
    };
  }, [srcUrl, sourceImage]);

  useEffect(() => {
    return () => {
      bitmap?.close();
    };
  }, [bitmap]);

  // Initialize the full-res mask canvas (black background) when bitmap loads
  useEffect(() => {
    const maskCanvas = maskRef.current;
    if (!bitmap || !maskCanvas) return;
    maskCanvas.width = bitmap.width;
    maskCanvas.height = bitmap.height;
    const ctx = maskCanvas.getContext("2d");
    if (!ctx) return;
    ctx.fillStyle = "black";
    ctx.fillRect(0, 0, bitmap.width, bitmap.height);
  }, [bitmap]);

  const scale = bitmap
    ? fitScale(bitmap.width, bitmap.height, PREVIEW_MAX_W, PREVIEW_MAX_H)
    : 1;
  const displayW = bitmap ? Math.round(bitmap.width * scale) : 0;
  const displayH = bitmap ? Math.round(bitmap.height * scale) : 0;

  // Initialize the overlay canvas dimensions when display size is known
  useEffect(() => {
    const overlay = overlayRef.current;
    if (!overlay || !displayW || !displayH) return;
    overlay.width = displayW;
    overlay.height = displayH;
  }, [displayW, displayH]);

  const doPaint = useCallback(
    (
      x: number,
      y: number,
      fromX: number,
      fromY: number,
      mode: "brush" | "eraser",
      size: number,
    ) => {
      const overlay = overlayRef.current;
      const maskCanvas = maskRef.current;
      if (!overlay || !maskCanvas) return;

      const overlayCtx = overlay.getContext("2d");
      const maskCtx = maskCanvas.getContext("2d");
      if (!overlayCtx || !maskCtx) return;

      const dispSize = size;
      const fullSize = size / scale;

      // Paint onto display overlay
      overlayCtx.save();
      overlayCtx.globalCompositeOperation =
        mode === "eraser" ? "destination-out" : "source-over";
      overlayCtx.strokeStyle = "rgba(255, 60, 60, 0.55)";
      overlayCtx.lineWidth = dispSize;
      overlayCtx.lineCap = "round";
      overlayCtx.lineJoin = "round";
      overlayCtx.beginPath();
      overlayCtx.moveTo(fromX, fromY);
      overlayCtx.lineTo(x, y);
      overlayCtx.stroke();
      overlayCtx.restore();

      // Paint onto full-res mask canvas (white for brush, black for eraser)
      const fullX = x / scale;
      const fullY = y / scale;
      const fullFromX = fromX / scale;
      const fullFromY = fromY / scale;

      maskCtx.save();
      maskCtx.globalCompositeOperation = "source-over";
      maskCtx.strokeStyle = mode === "eraser" ? "black" : "white";
      maskCtx.lineWidth = fullSize;
      maskCtx.lineCap = "round";
      maskCtx.lineJoin = "round";
      maskCtx.beginPath();
      maskCtx.moveTo(fullFromX, fullFromY);
      maskCtx.lineTo(fullX, fullY);
      maskCtx.stroke();
      maskCtx.restore();
    },
    [scale],
  );

  const onPointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      try {
        containerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // best-effort pointer capture
      }
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      drawingRef.current = { active: true, lastX: x, lastY: y, scale };

      // Paint a single dot on click
      doPaint(x, y, x, y, brushMode, brushSize);
      setPainted(true);
    },
    [brushMode, brushSize, doPaint, scale],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const dr = drawingRef.current;
      if (!dr?.active) return;
      const rect = containerRef.current?.getBoundingClientRect();
      if (!rect) return;
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      doPaint(x, y, dr.lastX, dr.lastY, brushMode, brushSize);
      dr.lastX = x;
      dr.lastY = y;
      setPainted(true);
    },
    [brushMode, brushSize, doPaint],
  );

  const onPointerUp = useCallback(() => {
    if (drawingRef.current) drawingRef.current.active = false;
  }, []);

  const handleClear = useCallback(() => {
    const overlay = overlayRef.current;
    const maskCanvas = maskRef.current;
    if (!overlay || !maskCanvas || !bitmap) return;

    const overlayCtx = overlay.getContext("2d");
    const maskCtx = maskCanvas.getContext("2d");
    if (!overlayCtx || !maskCtx) return;

    overlayCtx.clearRect(0, 0, overlay.width, overlay.height);
    maskCtx.fillStyle = "black";
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height);
    setPainted(false);
  }, [bitmap]);

  /**
   * Write the annotation + result nodes, wire both images into the result, and
   * prefill its prompt. `generateNow` decides whether the request also fires.
   *
   * Connection order is load-bearing: source first, annotation second, so
   * `collectUpstream` yields them in that order and 参考图1 / 参考图2 in the
   * prompt point at the right pictures.
   */
  const applyMask = useCallback(
    async (generateNow: boolean) => {
      const maskCanvas = maskRef.current;
      if (!bitmap || !maskCanvas || !sourceImage) return;

      setSaving(true);
      try {
        const annotationDataUrl = composeMaskAnnotation(bitmap, maskCanvas);
        const saved = await saveInboundImage(
          annotationDataUrl,
          "mask-annotation",
        );

        const src = getCanvasState().nodes.find((n) => n.id === nodeId);
        const liveTitle = src?.title ?? "图片";

        const annotationNode = addNode({
          type: "image",
          title: `${liveTitle} 遮罩标注`,
          position: src
            ? { x: src.position.x, y: src.position.y + src.size.height + 48 }
            : undefined,
          size: src?.size,
          metadata: { content: saved.url },
        });
        const resultNode = addNode({
          type: "image",
          title: `${liveTitle} 重绘`,
          position: src
            ? { x: src.position.x + src.size.width + 40, y: src.position.y }
            : undefined,
          size: src?.size,
          metadata: {},
        });
        connectNodes(nodeId, resultNode.id);
        connectNodes(annotationNode.id, resultNode.id);

        const composed = composeMaskEditPrompt(prompt);
        setDraft(resultNode.id, composed);

        if (generateNow) {
          void generateImageIntoNode(resultNode.id, composed, {
            referenceImages: usableReferencePaths([
              src?.metadata.content ?? "",
              saved.url,
            ]),
          });
        } else {
          // Leave the result node selected so its panel opens with the composed
          // prompt ready to edit — that is the whole point of not generating.
          selectNodes([resultNode.id]);
        }

        closeCanvasDialog();
        toast.success(
          generateNow ? "已创建重绘节点" : "已导出到画布，可修改提示词后生成",
        );
      } catch (error) {
        setSaving(false);
        toast.error(
          error instanceof Error ? error.message : "遮罩标注图保存失败",
        );
      }
    },
    [bitmap, sourceImage, nodeId, prompt],
  );

  const canConfirm = prompt.trim().length > 0 && painted && !saving;

  return (
    <CanvasModal title="重绘选区" maxWidth={720} onClose={closeCanvasDialog}>
      <div data-canvas-mask-dialog="true" className="px-6 pb-6">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-text-secondary">
            加载中…
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Preview + overlay painting area */}
            <div
              ref={containerRef}
              className="relative mx-auto select-none overflow-hidden rounded-lg bg-surface-2"
              style={{
                width: displayW,
                height: displayH,
                cursor: brushMode === "eraser" ? "cell" : "crosshair",
                touchAction: "none",
              }}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              {/* Base image */}
              {objUrl ? (
                <img
                  src={objUrl}
                  alt="source"
                  style={{
                    position: "absolute",
                    left: 0,
                    top: 0,
                    width: displayW,
                    height: displayH,
                    pointerEvents: "none",
                    userSelect: "none",
                  }}
                  draggable={false}
                />
              ) : null}

              {/* Paint overlay */}
              <canvas
                ref={overlayRef}
                style={{
                  position: "absolute",
                  left: 0,
                  top: 0,
                  width: displayW,
                  height: displayH,
                  pointerEvents: "none",
                }}
              />

              {/* Hidden full-res mask canvas */}
              <canvas ref={maskRef} style={{ display: "none" }} />
            </div>

            {/* Brush controls */}
            <div className="flex flex-wrap items-center gap-3 text-sm">
              {/* Brush / Eraser toggle */}
              <div className="flex overflow-hidden rounded-lg border border-border">
                <button
                  type="button"
                  title="画笔"
                  onClick={() => setBrushMode("brush")}
                  className={`flex items-center gap-1 px-3 py-1.5 text-sm transition-colors ${
                    brushMode === "brush"
                      ? "bg-[var(--color-brand-wash)] text-[var(--color-brand-ink)]"
                      : "bg-surface-1 text-text-primary hover:bg-surface-2"
                  }`}
                >
                  <Brush size={13} />
                  画笔
                </button>
                <button
                  type="button"
                  title="橡皮擦"
                  onClick={() => setBrushMode("eraser")}
                  className={`flex items-center gap-1 px-3 py-1.5 text-sm transition-colors ${
                    brushMode === "eraser"
                      ? "bg-[var(--color-brand-wash)] text-[var(--color-brand-ink)]"
                      : "bg-surface-1 text-text-primary hover:bg-surface-2"
                  }`}
                >
                  <Eraser size={13} />
                  橡皮
                </button>
              </div>

              {/* Brush size */}
              <label className="flex items-center gap-2 text-text-primary">
                笔刷大小
                <input
                  type="range"
                  min={4}
                  max={64}
                  value={brushSize}
                  onChange={(e) => setBrushSize(Number(e.target.value))}
                  className="w-24"
                />
                <span className="w-6 text-text-secondary">{brushSize}</span>
              </label>

              {/* Clear button */}
              <button
                type="button"
                onClick={handleClear}
                className="rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-sm text-text-primary hover:bg-surface-2"
              >
                清除
              </button>
            </div>

            {/* Prompt input */}
            <div className="flex flex-col gap-1.5">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
                重绘内容
                <input
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="描述要在选区内生成的内容…"
                  className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm font-normal text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-primary)]"
                />
              </label>
            </div>

            {/* Confirm — two exits: review the composed prompt on the canvas,
                or spend the request right away. */}
            <div className="flex items-center justify-end gap-2">
              <button
                type="button"
                data-canvas-mask-export="true"
                disabled={!canConfirm}
                onClick={() => void applyMask(false)}
                className="rounded-lg border border-border bg-surface-1 px-4 py-1.5 text-sm font-medium text-text-primary hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
              >
                导出到画布
              </button>
              <button
                type="button"
                data-canvas-mask-confirm="true"
                disabled={!canConfirm}
                onClick={() => void applyMask(true)}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <Brush size={14} />
                {saving ? "处理中…" : "立刻生成"}
              </button>
            </div>
          </div>
        )}
      </div>
    </CanvasModal>
  );
}
