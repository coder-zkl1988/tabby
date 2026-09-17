/**
 * upscale-dialog.tsx — interpolation upscale dialog (W3.6a, non-AI half).
 *
 * Upscales an image to 1K/2K/4K long-edge using browser Canvas interpolation.
 * AI super-resolve is NOT this dialog (that is T6, a separate channel).
 *
 * Simplification note: this uses a single drawImage call with the chosen
 * smoothing flags, NOT multi-step progressive downsampling. This is
 * intentional — single-pass is sufficient for v1 interpolation quality.
 *
 * Memory note: 4K PNG dataURLs can be tens of MB. This is acceptable for v1
 * (IDB handles it); 4K is the hard cap in this dialog.
 *
 * Follows crop-dialog.tsx precedent exactly:
 *   - Uses the shared canvas-scoped CanvasModal shell (./canvas-modal)
 *   - Uses loadImageBitmap (shared helper)
 *   - data-canvas-upscale-dialog on the content container
 *   - data-canvas-upscale-confirm on the confirm button
 */

import { ZoomIn } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import type { CanvasDialogState } from "./canvas-dialogs";
import { closeCanvasDialog } from "./canvas-dialogs";
import { enhanceImageIntoNode } from "./canvas-generation";
import { applyUpscaleInterpolate } from "./canvas-image-ops";
import { CanvasModal } from "./canvas-modal";
import { addNode, getCanvasState } from "./canvas-store";
import { loadImageBitmap } from "./load-image-bitmap";
import { servableSourceOf } from "./prompt-panel-utils";
import { upscaleTargetSize } from "./split-upscale-math";

// ── Types & constants ──────────────────────────────────────────────────────

type LongEdge = 1024 | 2048 | 4096;
type SmoothingMode = "high" | "low" | "none";
type UpscaleMode = "interpolation" | "ai";

const LONG_EDGES: LongEdge[] = [1024, 2048, 4096];

const SMOOTHING_OPTIONS: Array<{ value: SmoothingMode; label: string }> = [
  { value: "high", label: "高质量插值" },
  { value: "low", label: "双线性" },
  { value: "none", label: "最近邻/像素风" },
];

function longEdgeLabel(le: LongEdge): string {
  if (le === 1024) return "1K";
  if (le === 2048) return "2K";
  return "4K";
}

// ── UpscaleDialog ──────────────────────────────────────────────────────────

export function UpscaleDialog({
  state,
}: {
  state: NonNullable<CanvasDialogState> & { kind: "upscale" };
}) {
  const { nodeId } = state;
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [loading, setLoading] = useState(true);
  const [target, setTarget] = useState<LongEdge>(2048);
  const [smoothing, setSmoothing] = useState<SmoothingMode>("high");

  const [upscaleMode, setUpscaleMode] = useState<UpscaleMode>("interpolation");

  const node = getCanvasState().nodes.find((n) => n.id === nodeId);
  const srcUrl = node?.metadata.content as string | undefined;
  const sourceImage = node ? servableSourceOf(node) : null;

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
        // Revoke objectUrl immediately — we only need the bitmap
        URL.revokeObjectURL(result.objectUrl);
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
        // objectUrl already revoked above (or will be on cleanup path)
      }
    };
  }, [srcUrl]);

  useEffect(() => {
    return () => {
      bitmap?.close();
    };
  }, [bitmap]);

  // Compute available targets (non-null = upscaleable)
  const targetOptions = bitmap
    ? LONG_EDGES.map((le) => ({
        le,
        size: upscaleTargetSize(bitmap.width, bitmap.height, le),
      }))
    : [];

  const allNull = targetOptions.every((o) => o.size === null);
  const currentTargetSize = bitmap
    ? upscaleTargetSize(bitmap.width, bitmap.height, target)
    : null;

  // If current target becomes disabled, auto-select first available
  useEffect(() => {
    if (!bitmap) return;
    const current = upscaleTargetSize(bitmap.width, bitmap.height, target);
    if (current === null) {
      const first = LONG_EDGES.find(
        (le) => upscaleTargetSize(bitmap.width, bitmap.height, le) !== null,
      );
      if (first !== undefined) setTarget(first);
    }
  }, [bitmap, target]);

  const handleConfirm = useCallback(async () => {
    if (!bitmap || !currentTargetSize) return;

    if (upscaleMode === "ai") {
      // AI super-resolve path: create result node + fire enhance seam
      if (!sourceImage) return;
      const src = getCanvasState().nodes.find((n) => n.id === nodeId);
      const liveTitle = src?.title ?? "图片";
      const newNode = addNode({
        type: "image",
        title: `${liveTitle} 超分${longEdgeLabel(target)}`,
        position: src
          ? { x: src.position.x + src.size.width + 40, y: src.position.y }
          : undefined,
        size: src?.size ?? { width: 340, height: 240 },
        metadata: {},
      });
      void enhanceImageIntoNode(newNode.id, {
        sourceImage,
        operation: "super-resolve",
        targetLongEdge: target,
      });
      closeCanvasDialog();
      toast.success("已创建 AI 超分节点");
      return;
    }

    // Interpolation path: delegate to the headless applier, then toast + close
    const { width: outW, height: outH } = currentTargetSize;
    const algorithm = smoothing === "none" ? "pixel" : smoothing;
    const created = await applyUpscaleInterpolate(nodeId, target, algorithm);
    if (!created) {
      toast.error("放大失败");
      return;
    }

    closeCanvasDialog();
    toast.success(`已放大至 ${outW}×${outH} 并生成节点`);
  }, [
    bitmap,
    currentTargetSize,
    nodeId,
    smoothing,
    target,
    upscaleMode,
    sourceImage,
  ]);

  return (
    <CanvasModal title="放大图片" maxWidth={520} onClose={closeCanvasDialog}>
      <div data-canvas-upscale-dialog="true" className="px-6 pb-6">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-text-secondary">
            加载中…
          </div>
        ) : (
          <div className="flex flex-col gap-5">
            {/* Original size readout */}
            {bitmap ? (
              <div className="text-sm text-text-secondary">
                原始尺寸：{bitmap.width} × {bitmap.height} px
              </div>
            ) : null}

            {/* Mode radio: interpolation | AI super-resolve */}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-text-primary">
                放大方式
              </span>
              <div
                data-canvas-upscale-mode="true"
                className="flex overflow-hidden rounded-lg border border-border"
              >
                <button
                  type="button"
                  onClick={() => setUpscaleMode("interpolation")}
                  className={`flex-1 px-4 py-1.5 text-sm transition-colors ${
                    upscaleMode === "interpolation"
                      ? "bg-[var(--color-brand-wash)] text-[var(--color-brand-ink)]"
                      : "bg-surface-1 text-text-primary hover:bg-surface-2"
                  }`}
                >
                  插值放大
                </button>
                <button
                  type="button"
                  disabled
                  title="暂不支持：当前没有可用的图生图超分技能"
                  className="flex-1 cursor-not-allowed bg-surface-1 px-4 py-1.5 text-sm text-text-tertiary opacity-40 transition-colors"
                >
                  AI 超分辨率（暂不支持）
                </button>
              </div>
            </div>

            {/* Target size selector */}
            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium text-text-primary">
                目标档位
              </span>
              {allNull ? (
                <div className="rounded-lg border border-border bg-surface-2 px-4 py-3 text-sm text-text-secondary">
                  图片已达到最大档位
                </div>
              ) : (
                <div className="flex gap-2">
                  {targetOptions.map(({ le, size }) => (
                    <button
                      key={le}
                      type="button"
                      disabled={size === null}
                      onClick={() => setTarget(le)}
                      className={`rounded-lg border px-4 py-1.5 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
                        target === le && size !== null
                          ? "border-[var(--color-brand-primary)] bg-[var(--color-brand-wash)] text-[var(--color-brand-ink)]"
                          : "border-border bg-surface-1 text-text-primary hover:bg-surface-2"
                      }`}
                    >
                      {longEdgeLabel(le)}
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Algorithm selector — hidden in AI mode */}
            {upscaleMode === "interpolation" ? (
              <div className="flex flex-col gap-2">
                <span className="text-sm font-medium text-text-primary">
                  插值算法
                </span>
                <select
                  value={smoothing}
                  onChange={(e) =>
                    setSmoothing(e.target.value as SmoothingMode)
                  }
                  className="rounded border border-border bg-surface-1 px-3 py-1.5 text-sm text-text-primary"
                >
                  {SMOOTHING_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </div>
            ) : null}

            {/* Output size readout */}
            {currentTargetSize ? (
              <div className="text-sm text-text-secondary">
                输出尺寸：{currentTargetSize.width} × {currentTargetSize.height}{" "}
                px
              </div>
            ) : null}

            {/* Confirm */}
            <div className="flex justify-end">
              <button
                type="button"
                data-canvas-upscale-confirm="true"
                disabled={
                  allNull ||
                  currentTargetSize === null ||
                  (upscaleMode === "ai" && !sourceImage)
                }
                onClick={handleConfirm}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
              >
                <ZoomIn size={14} />
                {upscaleMode === "ai" ? "AI 超分并生成节点" : "放大并生成节点"}
              </button>
            </div>
          </div>
        )}
      </div>
    </CanvasModal>
  );
}
