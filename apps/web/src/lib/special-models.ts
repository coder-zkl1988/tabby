// Tabby Official models reserved for a specific internal purpose. They are not
// general chat models, so the model picker shows them greyed-out (non-selectable)
// with a purpose label instead of letting a bot be assigned to them.
const SPECIAL_PURPOSE_MODEL_LABEL_KEYS: Record<string, string> = {
  "tabby-phone": "models.special.phone",
  "tabby-image-pro": "models.special.image",
  "tabby-image-flash": "models.special.image",
  // Keep stale cloud-model caches non-selectable during the ID migration.
  "tabby-image": "models.special.image",
  "tabby-image-free": "models.special.image",
  "tabby-video": "models.special.video",
  // Realtime voice: it speaks over a WebSocket session, so it cannot serve a
  // chat completion at all — selecting it as a bot model would just fail.
  "tabby-audio": "models.special.voice",
  "tabby-video-free": "models.special.video",
};

/**
 * Return the i18n key for a model's purpose label if the model is reserved for a
 * specific internal use (phone control, image generation, …), otherwise null.
 * A non-null result means the model must not be selectable as a bot chat model.
 */
export function getSpecialModelLabelKey(modelId: string): string | null {
  return SPECIAL_PURPOSE_MODEL_LABEL_KEYS[modelId] ?? null;
}
