import type { A2UIMessage } from "@/lib/a2ui";
import type { ExtractedMessage } from "@/lib/chat/chat-message-extract";

export interface A2UITranscriptEntry<TMessage> {
  msg: TMessage;
  extracted: ExtractedMessage;
}

export function surfaceIds(messages: A2UIMessage[]): string[] {
  const ids = new Set<string>();
  for (const message of messages) {
    if ("createSurface" in message) {
      ids.add(message.createSurface.surfaceId);
    } else if ("updateComponents" in message) {
      ids.add(message.updateComponents.surfaceId);
    } else if ("updateDataModel" in message) {
      ids.add(message.updateDataModel.surfaceId);
    } else if ("deleteSurface" in message) {
      ids.add(message.deleteSurface.surfaceId);
    }
  }
  return [...ids];
}

/**
 * Re-renders of an inline A2UI surface arrive in later chat messages. Fold
 * them into the first occurrence so a stable surfaceId behaves as one live
 * artifact instead of producing disconnected duplicate cards.
 */
export function coalesceInlineA2UISurfaces<TMessage>(
  entries: A2UITranscriptEntry<TMessage>[],
): A2UITranscriptEntry<TMessage>[] {
  const output = [...entries];
  const firstIndexBySurface = new Map<string, number>();

  for (let index = 0; index < output.length; index += 1) {
    const entry = output[index];
    const messages = entry?.extracted.a2uiMessages;
    if (
      !entry ||
      !entry.extracted.hasA2UI ||
      entry.extracted.sidebarA2UI ||
      !messages?.length
    ) {
      continue;
    }

    const ids = surfaceIds(messages);
    if (ids.length !== 1) continue;
    const surfaceId = ids[0];
    if (!surfaceId) continue;

    const firstIndex = firstIndexBySurface.get(surfaceId);
    if (firstIndex === undefined) {
      firstIndexBySurface.set(surfaceId, index);
      continue;
    }

    const firstEntry = output[firstIndex];
    if (!firstEntry) continue;
    output[firstIndex] = {
      ...firstEntry,
      extracted: {
        ...firstEntry.extracted,
        hasA2UI: true,
        a2uiMessages: [
          ...(firstEntry.extracted.a2uiMessages ?? []),
          ...messages,
        ],
      },
    };
    output[index] = {
      ...entry,
      extracted: {
        ...entry.extracted,
        hasA2UI: false,
        a2uiMessages: null,
      },
    };
  }

  return output;
}
