/**
 * angle-dialog.tsx — multi-angle view generation dialog (W3.6b, T6).
 *
 * Sliders: 水平角 -60..60, 俯仰角 -45..45, 距离 1..10.
 * Checkbox: 广角.
 * Live CSS 3D preview approximation:
 *   perspective(800px) rotateY(<h>deg) rotateX(<-p>deg) scale(<1.6 - distance*0.08>)
 *   NOTE: this is a visual approximation only, not a geometric model.
 *
 * Confirm: enhanceImageIntoNode with operation "multi-angle".
 */

import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { CanvasDialogState } from "./canvas-dialogs";
import { closeCanvasDialog } from "./canvas-dialogs";
import { enhanceImageIntoNode } from "./canvas-generation";
import { CanvasModal } from "./canvas-modal";
import { addNode, getCanvasState } from "./canvas-store";
import { loadImageBitmap } from "./load-image-bitmap";
import { servableSourceOf } from "./prompt-panel-utils";

// ── Constants ──────────────────────────────────────────────────────────────

const PREVIEW_MAX_W = 560;
const PREVIEW_MAX_H = 360;

// ── AngleDialog ────────────────────────────────────────────────────────────

export function AngleDialog({
  state,
}: {
  state: NonNullable<CanvasDialogState> & { kind: "angle" };
}) {
  const { nodeId } = state;
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  // Angle params
  const [horizontalDeg, setHorizontalDeg] = useState(0);
  const [pitchDeg, setPitchDeg] = useState(0);
  const [distance, setDistance] = useState(5);
  const [wideAngle, setWideAngle] = useState(false);
  const [prompt, setPrompt] = useState("");

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
        result.bitmap.close(); // we only need the objectUrl for display
        createdObjUrl = result.objectUrl;
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

  const handleConfirm = useCallback(() => {
    if (!sourceImage) return;

    const src = getCanvasState().nodes.find((n) => n.id === nodeId);
    const liveTitle = src?.title ?? "图片";
    const newNode = addNode({
      type: "image",
      title: `${liveTitle} 视角`,
      position: src
        ? { x: src.position.x + src.size.width + 40, y: src.position.y }
        : undefined,
      size: src?.size,
      metadata: {},
    });

    void enhanceImageIntoNode(newNode.id, {
      sourceImage,
      operation: "multi-angle",
      horizontalDeg,
      pitchDeg,
      distance,
      wideAngle,
      ...(prompt.trim() ? { prompt: prompt.trim() } : {}),
    });

    closeCanvasDialog();
    toast.success("已创建新视角节点");
  }, [
    sourceImage,
    nodeId,
    horizontalDeg,
    pitchDeg,
    distance,
    wideAngle,
    prompt,
  ]);

  // CSS 3D live preview approximation — not a geometric model
  const previewScale = 1.6 - distance * 0.08;
  const previewTransform = `perspective(800px) rotateY(${horizontalDeg}deg) rotateX(${-pitchDeg}deg) scale(${previewScale.toFixed(3)})`;

  // Compute display dimensions for preview container
  const displayW = Math.min(PREVIEW_MAX_W, 400);
  const displayH = Math.min(PREVIEW_MAX_H, 280);

  return (
    <CanvasModal title="生成新视角" maxWidth={680} onClose={closeCanvasDialog}>
      <div data-canvas-angle-dialog="true" className="px-6 pb-6">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-text-secondary">
            加载中…
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {/* Live 3D preview */}
            <div
              className="relative mx-auto flex items-center justify-center overflow-hidden rounded-lg bg-surface-2"
              style={{ width: displayW, height: displayH }}
            >
              {objUrl ? (
                <img
                  src={objUrl}
                  alt="preview"
                  style={{
                    maxWidth: "80%",
                    maxHeight: "80%",
                    objectFit: "contain",
                    transform: previewTransform,
                    transition: "transform 0.1s ease",
                    userSelect: "none",
                    pointerEvents: "none",
                  }}
                  draggable={false}
                />
              ) : null}
            </div>

            {/* Slider controls */}
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {/* 水平角 */}
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-text-primary">
                  水平角{" "}
                  <span className="font-normal text-text-secondary">
                    {horizontalDeg}°
                  </span>
                </span>
                <input
                  type="range"
                  min={-60}
                  max={60}
                  value={horizontalDeg}
                  onChange={(e) => setHorizontalDeg(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-text-tertiary">
                  <span>-60°</span>
                  <span>60°</span>
                </div>
              </label>

              {/* 俯仰角 */}
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-text-primary">
                  俯仰角{" "}
                  <span className="font-normal text-text-secondary">
                    {pitchDeg}°
                  </span>
                </span>
                <input
                  type="range"
                  min={-45}
                  max={45}
                  value={pitchDeg}
                  onChange={(e) => setPitchDeg(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-text-tertiary">
                  <span>-45°</span>
                  <span>45°</span>
                </div>
              </label>

              {/* 距离 */}
              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium text-text-primary">
                  距离{" "}
                  <span className="font-normal text-text-secondary">
                    {distance}
                  </span>
                </span>
                <input
                  type="range"
                  min={1}
                  max={10}
                  value={distance}
                  onChange={(e) => setDistance(Number(e.target.value))}
                  className="w-full"
                />
                <div className="flex justify-between text-xs text-text-tertiary">
                  <span>近</span>
                  <span>远</span>
                </div>
              </label>

              {/* 广角 checkbox */}
              <label className="flex items-center gap-2 text-sm text-text-primary">
                <input
                  type="checkbox"
                  checked={wideAngle}
                  onChange={(e) => setWideAngle(e.target.checked)}
                  className="cursor-pointer"
                />
                广角镜头
              </label>
            </div>

            {/* Optional prompt */}
            <div className="flex flex-col gap-1.5">
              <label className="flex flex-col gap-1.5 text-sm font-medium text-text-primary">
                描述提示词（可选）
                <input
                  type="text"
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="补充场景描述（可留空）"
                  className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm font-normal text-text-primary placeholder:text-text-tertiary focus:outline-none focus:ring-1 focus:ring-[var(--color-brand-primary)]"
                />
              </label>
            </div>

            {/* Confirm */}
            <div className="flex justify-end">
              <button
                type="button"
                data-canvas-angle-confirm="true"
                onClick={handleConfirm}
                className="rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
              >
                生成新视角
              </button>
            </div>
          </div>
        )}
      </div>
    </CanvasModal>
  );
}
