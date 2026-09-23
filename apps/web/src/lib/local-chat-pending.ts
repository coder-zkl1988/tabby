export interface PendingSessionParams {
  botId: string;
  sessionKey: string;
  runId?: string;
}

export function buildPendingSessionPath({
  botId,
  sessionKey,
  runId,
}: PendingSessionParams): string {
  const params = new URLSearchParams({
    botId,
    sessionKey,
  });
  const trimmedRunId = runId?.trim();
  if (trimmedRunId) {
    params.set("runId", trimmedRunId);
  }
  return `/workspace/sessions/pending?${params.toString()}`;
}

export function parsePendingSessionParams(
  searchParams: URLSearchParams,
): PendingSessionParams | null {
  const botId = searchParams.get("botId")?.trim();
  const sessionKey = searchParams.get("sessionKey")?.trim();
  if (!botId || !sessionKey) {
    return null;
  }

  const runId = searchParams.get("runId")?.trim();
  return {
    botId,
    sessionKey,
    ...(runId ? { runId } : {}),
  };
}

export function getPendingSessionText(state: unknown): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const pendingText = (state as { pendingText?: unknown }).pendingText;
  if (typeof pendingText !== "string") {
    return null;
  }
  const trimmed = pendingText.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * The raw text the sender typed, without the `[Image]` / `[File]` placeholders
 * `pendingText` falls back to. Only real text can be echoed as an optimistic
 * bubble on the session page, because that is what history dedupes against.
 */
export function getPendingSessionUserText(state: unknown): string {
  if (!state || typeof state !== "object") {
    return "";
  }
  const pendingUserText = (state as { pendingUserText?: unknown })
    .pendingUserText;
  return typeof pendingUserText === "string" ? pendingUserText : "";
}

export function getPendingSessionBotName(state: unknown): string | null {
  if (!state || typeof state !== "object") {
    return null;
  }
  const pendingBotName = (state as { pendingBotName?: unknown }).pendingBotName;
  if (typeof pendingBotName !== "string") {
    return null;
  }
  const trimmed = pendingBotName.trim();
  return trimmed.length > 0 ? trimmed : null;
}
