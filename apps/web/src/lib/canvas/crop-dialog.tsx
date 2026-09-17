/**
 * crop-dialog.tsx — interactive crop dialog (W3.2, W4.0).
 *
 * CanvasDialogs mount point has moved to canvas-dialogs-mount.tsx (W4.0).
 *
 * Media bytes loading strategy: uses the shared loadImageBitmap helper from
 * ./load-image-bitmap (fetch → blob → createImageBitmap + objectUrl).
 */

import { Crop } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { type CanvasDialogState, closeCanvasDialog } from "./canvas-dialogs";
import { applyCrop } from "./canvas-image-ops";
import { CanvasModal } from "./canvas-modal";
import { getCanvasState } from "./canvas-store";
import {
  type CropBox,
  type CropHandle,
  applyCropDrag,
  fitScale,
} from "./crop-geometry";
import { loadImageBitmap } from "./load-image-bitmap";

// ── Constants ──────────────────────────────────────────────────────────────

const PREVIEW_MAX_W = 640;
const PREVIEW_MAX_H = 400;
const HANDLE_SIZE = 10; // px, visual dot

// ── CropDialog ─────────────────────────────────────────────────────────────

export function CropDialog({
  state,
}: {
  state: NonNullable<CanvasDialogState> & { kind: "crop" };
}) {
  const { nodeId } = state;
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [objUrl, setObjUrl] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [box, setBox] = useState<CropBox>({ x: 0, y: 0, width: 0, height: 0 });
  const [lockRatio, setLockRatio] = useState(false);

  // Drag state kept in ref to avoid closure identity issues
  const dragRef = useRef<{
    handle: CropHandle;
    startX: number;
    startY: number;
    startBox: CropBox;
    scale: number;
  } | null>(null);

  // Preview container ref for pointer capture
  const previewContainerRef = useRef<HTMLDivElement>(null);

  // Resolve the media URL for this node
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
        setBox({
          x: 0,
          y: 0,
          width: result.bitmap.width,
          height: result.bitmap.height,
        });
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

  // Cleanup bitmap when dialog unmounts
  useEffect(() => {
    return () => {
      bitmap?.close();
    };
  }, [bitmap]);

  const scale = bitmap
    ? fitScale(bitmap.width, bitmap.height, PREVIEW_MAX_W, PREVIEW_MAX_H)
    : 1;

  const displayW = bitmap ? Math.round(bitmap.width * scale) : 0;
  const displayH = bitmap ? Math.round(bitmap.height * scale) : 0;

  // ── Drag handlers ────────────────────────────────────────────────

  const onHandlePointerDown = useCallback(
    (e: React.PointerEvent<HTMLDivElement>, handle: CropHandle) => {
      e.preventDefault();
      e.stopPropagation();
      // Capture on the preview container so subsequent move/up events keep
      // firing there even when the pointer leaves the tiny handle dot.
      try {
        previewContainerRef.current?.setPointerCapture(e.pointerId);
      } catch {
        // pointer capture is best-effort
      }
      dragRef.current = {
        handle,
        startX: e.clientX,
        startY: e.clientY,
        startBox: box,
        scale,
      };
    },
    [box, scale],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      const drag = dragRef.current;
      if (!drag || !bitmap) return;
      const rawDx = e.clientX - drag.startX;
      const rawDy = e.clientY - drag.startY;
      const dx = rawDx / drag.scale;
      const dy = rawDy / drag.scale;
      const newBox = applyCropDrag({
        handle: drag.handle,
        box: drag.startBox,
        dx,
        dy,
        bounds: { width: bitmap.width, height: bitmap.height },
        lockRatio,
      });
      setBox(newBox);
    },
    [bitmap, lockRatio],
  );

  const onPointerUp = useCallback(() => {
    dragRef.current = null;
  }, []);

  // ── Confirm: delegate to the headless applier, then toast + close ───

  const handleConfirm = useCallback(async () => {
    if (!bitmap) return;
    const created = await applyCrop(nodeId, box);
    if (!created) {
      toast.error("裁剪失败");
      return;
    }
    closeCanvasDialog();
    toast.success("已生成裁剪节点");
  }, [bitmap, box, nodeId]);

  // ── Overlay mask: four shaded divs around the crop box ──────────

  function renderMask() {
    if (!displayW || !displayH) return null;
    const bx = Math.round(box.x * scale);
    const by = Math.round(box.y * scale);
    const bw = Math.round(box.width * scale);
    const bh = Math.round(box.height * scale);

    const maskStyle: React.CSSProperties = {
      position: "absolute",
      background: "rgba(0,0,0,0.5)",
      pointerEvents: "none",
    };

    return (
      <>
        {/* top */}
        <div
          style={{ ...maskStyle, left: 0, top: 0, width: displayW, height: by }}
        />
        {/* bottom */}
        <div
          style={{
            ...maskStyle,
            left: 0,
            top: by + bh,
            width: displayW,
            height: displayH - by - bh,
          }}
        />
        {/* left */}
        <div
          style={{ ...maskStyle, left: 0, top: by, width: bx, height: bh }}
        />
        {/* right */}
        <div
          style={{
            ...maskStyle,
            left: bx + bw,
            top: by,
            width: displayW - bx - bw,
            height: bh,
          }}
        />
      </>
    );
  }

  // ── Handle dots positions ────────────────────────────────────────

  function renderHandles() {
    if (!displayW || !displayH) return null;
    const bx = Math.round(box.x * scale);
    const by = Math.round(box.y * scale);
    const bw = Math.round(box.width * scale);
    const bh = Math.round(box.height * scale);
    const half = HANDLE_SIZE / 2;

    const handles: Array<{
      handle: CropHandle;
      cx: number;
      cy: number;
      cursor: string;
    }> = [
      { handle: "nw", cx: bx, cy: by, cursor: "nwse-resize" },
      { handle: "n", cx: bx + bw / 2, cy: by, cursor: "ns-resize" },
      { handle: "ne", cx: bx + bw, cy: by, cursor: "nesw-resize" },
      { handle: "e", cx: bx + bw, cy: by + bh / 2, cursor: "ew-resize" },
      { handle: "se", cx: bx + bw, cy: by + bh, cursor: "nwse-resize" },
      { handle: "s", cx: bx + bw / 2, cy: by + bh, cursor: "ns-resize" },
      { handle: "sw", cx: bx, cy: by + bh, cursor: "nesw-resize" },
      { handle: "w", cx: bx, cy: by + bh / 2, cursor: "ew-resize" },
    ];

    return (
      <>
        {/* Move area (the inner crop box itself) */}
        <div
          style={{
            position: "absolute",
            left: bx,
            top: by,
            width: bw,
            height: bh,
            cursor: "move",
            boxSizing: "border-box",
            border: "1.5px solid rgba(255,255,255,0.8)",
          }}
          onPointerDown={(e) => onHandlePointerDown(e, "move")}
        />
        {/* 8 handle dots */}
        {handles.map(({ handle, cx, cy, cursor }) => (
          <div
            key={handle}
            data-crop-handle={handle}
            style={{
              position: "absolute",
              left: cx - half,
              top: cy - half,
              width: HANDLE_SIZE,
              height: HANDLE_SIZE,
              borderRadius: "50%",
              background: "white",
              border: "1.5px solid #1890ff",
              cursor,
              boxSizing: "border-box",
              zIndex: 10,
            }}
            onPointerDown={(e) => onHandlePointerDown(e, handle)}
          />
        ))}
      </>
    );
  }

  // ── Render ───────────────────────────────────────────────────────

  return (
    <CanvasModal title="裁剪图片" maxWidth={760} onClose={closeCanvasDialog}>
      <div data-canvas-crop-dialog="true" className="px-6 pb-6">
        {loading ? (
          <div className="flex h-48 items-center justify-center text-text-secondary">
            加载中…
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Preview area */}
            <div
              ref={previewContainerRef}
              className="relative mx-auto overflow-hidden rounded-lg bg-surface-2"
              style={{ width: displayW, height: displayH }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerLeave={onPointerUp}
            >
              {/* Background image (objectURL for cross-origin safety) */}
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
              {/* Mask + handles */}
              {renderMask()}
              {renderHandles()}
            </div>

            {/* Controls */}
            <div className="flex items-center justify-between gap-4 text-sm">
              <label className="flex cursor-pointer items-center gap-2 text-text-primary">
                <input
                  type="checkbox"
                  checked={lockRatio}
                  onChange={(e) => setLockRatio(e.target.checked)}
                  className="cursor-pointer"
                />
                锁定比例
              </label>

              <span className="text-text-secondary">
                {Math.round(box.width)} × {Math.round(box.height)} px
              </span>

              <button
                type="button"
                data-canvas-crop-confirm="true"
                onClick={handleConfirm}
                className="flex items-center gap-1.5 rounded-lg bg-[var(--color-accent)] px-4 py-1.5 text-sm font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
              >
                <Crop size={14} />
                裁剪并生成节点
              </button>
            </div>
          </div>
        )}
      </div>
    </CanvasModal>
  );
}
