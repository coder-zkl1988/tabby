import type { SaveInboundImageResponse } from "@nexu/shared";
import { postApiV1MediaInboundImage } from "../../../lib/api/sdk.gen";

/**
 * Persist a canvas-composed PNG data URL into the OpenClaw inbound media dir.
 *
 * Generation only accepts reference images as absolute paths under the media
 * dir, so anything drawn in the browser has to land on disk before it can be
 * referenced. Returns both the path (for the request) and a servable URL (for
 * rendering the node).
 */
export async function saveInboundImage(
  dataUrl: string,
  prefix?: string,
): Promise<SaveInboundImageResponse> {
  const { data, error } = await postApiV1MediaInboundImage({
    body: { dataUrl, ...(prefix !== undefined ? { prefix } : {}) },
  });
  if (!data || error) {
    throw new Error(readError(error, "图片保存失败"));
  }
  return data;
}

function readError(error: unknown, fallback: string): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string" &&
    error.message.trim() !== ""
  ) {
    return error.message.trim().slice(0, 240);
  }
  return fallback;
}
