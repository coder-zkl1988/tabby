/**
 * canvas-video-frame.ts — grab a still out of a video node (reference v0.17).
 *
 * A video node's first / last / currently-shown frame becomes its own image
 * node, so a clip can seed the next shot's reference image without a round
 * trip through the file system.
 *
 * Same shape as canvas-image-ops.ts: self-contained, reads the source node from
 * the store by id, draws offscreen, adds the result node. The draw path needs a
 * real <video> and canvas, so only `frameTimeOf` is unit-testable in node env.
 */

import { type CanvasNode, addNode, getCanvasState } from "./canvas-store";

export type VideoFramePosition = "first" | "last" | "current";

/** Seeking exactly to `duration` lands past the last sample and decodes blank. */
const END_EPSILON = 0.05;

const POSITION_LABEL: Record<VideoFramePosition, string> = {
  first: "首帧",
  last: "尾帧",
  current: "当前帧",
};

/**
 * The timestamp to seek to, clamped into the clip.
 *
 * `duration` is NaN before metadata loads and Infinity for open-ended streams;
 * both collapse to 0 so a capture still produces the opening frame instead of
 * hanging on a seek that never resolves.
 */
export function frameTimeOf(
  position: VideoFramePosition,
  duration: number,
  currentTime: number,
): number {
  const usable = Number.isFinite(duration) && duration > 0 ? duration : 0;
  const end = Math.max(0, usable - END_EPSILON);
  if (position === "first") return 0;
  if (position === "last") return end;
  return Math.min(Math.max(0, currentTime), end);
}

function once(
  video: HTMLVideoElement,
  event: "loadeddata" | "seeked",
): Promise<void> {
  return new Promise((resolve, reject) => {
    const onDone = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`video ${event} failed`));
    };
    const cleanup = () => {
      video.removeEventListener(event, onDone);
      video.removeEventListener("error", onError);
    };
    video.addEventListener(event, onDone);
    video.addEventListener("error", onError);
  });
}

/**
 * Decode one frame of `src` into a PNG data URL.
 *
 * Runs on a detached <video> rather than the node's own element so a capture
 * never disturbs what the user is watching. `crossOrigin` is set so a servable
 * URL from another origin decodes untainted where CORS allows it; where it does
 * not, `toDataURL` throws and the caller reports the failure.
 */
export async function captureVideoFrame(
  src: string,
  position: VideoFramePosition,
  currentTime: number,
): Promise<string> {
  const video = document.createElement("video");
  video.crossOrigin = "anonymous";
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.src = src;

  const loaded = once(video, "loadeddata");
  video.load();
  await loaded;

  const time = frameTimeOf(position, video.duration, currentTime);
  if (Math.abs(video.currentTime - time) > 0.001) {
    const seeked = once(video, "seeked");
    video.currentTime = time;
    await seeked;
  }

  const canvas = document.createElement("canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  if (!ctx || canvas.width === 0 || canvas.height === 0) {
    throw new Error("video frame has no drawable size");
  }
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
}

/**
 * Capture `position` from the video node `nodeId` and add the still as an image
 * node to its right. Returns the new node, or null when the node has no video.
 *
 * `currentTime` comes from the node's on-canvas <video> element — the caller
 * reads it, because only the rendered element knows where playback is.
 */
export async function captureVideoFrameIntoNode(
  nodeId: string,
  position: VideoFramePosition,
  currentTime: number,
): Promise<CanvasNode | null> {
  const node = getCanvasState().nodes.find((n) => n.id === nodeId);
  const content = node?.metadata.content;
  if (!node || node.type !== "video" || !content) return null;

  const dataUrl = await captureVideoFrame(content, position, currentTime);
  // Read the node live so a rename between click and decode is reflected.
  const src = getCanvasState().nodes.find((n) => n.id === nodeId);
  const liveTitle = src?.title ?? "视频";
  return addNode({
    type: "image",
    title: `${liveTitle} ${POSITION_LABEL[position]}`,
    position: src
      ? { x: src.position.x + src.size.width + 40, y: src.position.y }
      : undefined,
    metadata: { content: dataUrl },
  });
}

/** Playback position of a node's rendered <video>, or 0 when it isn't mounted. */
export function currentTimeOfNodeVideo(nodeId: string): number {
  const el = document.querySelector(`[data-canvas-node="${nodeId}"] video`);
  return el instanceof HTMLVideoElement ? el.currentTime : 0;
}
