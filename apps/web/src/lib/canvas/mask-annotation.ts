/**
 * mask-annotation.ts — local mask edit as a reference-image flow (reference v0.17).
 *
 * The old flow sent the painted region as the API's `mask` parameter. Most
 * backends we can actually reach don't honor it, so the feature degraded to
 * UNAVAILABLE. Upstream's answer — adopted here — is to stop asking for a mask
 * parameter at all: paint the region onto a COPY of the source image as a
 * translucent overlay, put that on the canvas as an ordinary image node, and
 * send both images as plain reference images with a prompt that says which is
 * which.
 *
 * The composite needs a real canvas, so only the prompt composer is unit-tested.
 */

/** Overlay color for the marked region — matches the in-dialog paint color. */
export const MASK_OVERLAY_COLOR = "#2f7bff";
/** Overlay opacity. High enough to read, low enough to see the content under it. */
export const MASK_OVERLAY_ALPHA = 0.45;

/**
 * Compose `source` with a translucent overlay wherever `maskCanvas` is painted.
 *
 * `maskCanvas` is the dialog's full-resolution mask: black background, white
 * strokes. Its alpha is uniform, so the marked region is selected by luminance
 * rather than by alpha — every non-black pixel becomes overlay.
 *
 * Returns a PNG data URL at the source's own resolution.
 */
export function composeMaskAnnotation(
  source: ImageBitmap,
  maskCanvas: HTMLCanvasElement,
): string {
  const out = document.createElement("canvas");
  out.width = source.width;
  out.height = source.height;
  const ctx = out.getContext("2d");
  if (!ctx) throw new Error("annotation canvas has no 2d context");
  ctx.drawImage(source, 0, 0, out.width, out.height);

  // Build the overlay: start from the mask, keep only the painted (non-black)
  // pixels, then flood those with the overlay color.
  const overlay = document.createElement("canvas");
  overlay.width = out.width;
  overlay.height = out.height;
  const overlayCtx = overlay.getContext("2d");
  if (!overlayCtx) throw new Error("overlay canvas has no 2d context");
  overlayCtx.drawImage(maskCanvas, 0, 0, overlay.width, overlay.height);

  const pixels = overlayCtx.getImageData(0, 0, overlay.width, overlay.height);
  const data = pixels.data;
  for (let i = 0; i < data.length; i += 4) {
    // Painted = white strokes on black. Anything mid-grey came from an
    // antialiased stroke edge, so treat the midpoint as the cut.
    const painted = (data[i] as number) > 127;
    data[i + 3] = painted ? 255 : 0;
  }
  overlayCtx.putImageData(pixels, 0, 0);
  overlayCtx.globalCompositeOperation = "source-in";
  overlayCtx.fillStyle = MASK_OVERLAY_COLOR;
  overlayCtx.fillRect(0, 0, overlay.width, overlay.height);

  ctx.globalAlpha = MASK_OVERLAY_ALPHA;
  ctx.drawImage(overlay, 0, 0);
  ctx.globalAlpha = 1;

  return out.toDataURL("image/png");
}

/**
 * The prompt sent with the two reference images.
 *
 * Reference order is fixed by the order the two connections are created
 * (`collectUpstream` walks `state.connections` in order), so naming them
 * 参考图1 / 参考图2 is not a guess. The last clause matters: without it the
 * model happily returns the picture with the blue patch still on it.
 */
export function composeMaskEditPrompt(instruction: string): string {
  return [
    "参考图1 是原图。参考图2 是同一张图，用半透明蓝色标出了需要修改的区域。",
    "只修改蓝色覆盖的区域，其余部分与原图保持一致；输出与原图同尺寸的完整图片，结果中不得残留任何蓝色覆盖。",
    `修改要求：${instruction.trim()}`,
  ].join("\n");
}
