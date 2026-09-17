/**
 * canvas-text-alternatives.ts
 *
 * Several generated texts held in ONE node (reference v0.17). Images fan out
 * into sibling nodes (canvas-batch.ts) because you want to see them side by
 * side; text alternatives are read one at a time, so they stay in the node and
 * the user switches between them.
 *
 * `metadata.content` is always a mirror of `items[activeIndex]` — every other
 * reader (generation upstream, export, the agent mirror) keeps working without
 * knowing alternatives exist.
 */

import { getCanvasState, updateNode } from "./canvas-store";

/** Upper bound on alternatives — one utility-lane call each. */
export const MAX_TEXT_ALTERNATIVES = 4;

/**
 * Store `texts` on the node, showing the first.
 *
 * A single text is written as plain content with no alternatives block, so a
 * count-1 generation leaves the node exactly as it was before this existed.
 * `requested` is recorded only when fewer came back than were asked for.
 */
export function attachTextAlternatives(
  nodeId: string,
  texts: ReadonlyArray<string>,
  requested: number,
): void {
  const items = texts.filter((text) => text.trim() !== "");
  if (items.length === 0) return;
  if (items.length === 1) {
    updateNode(nodeId, { metadata: { content: items[0] } });
    return;
  }
  updateNode(nodeId, {
    metadata: {
      content: items[0],
      textAlternatives: {
        items: [...items],
        activeIndex: 0,
        ...(items.length < requested ? { requested } : {}),
      },
    },
  });
}

/** Show alternative `index`. Out-of-range indexes are ignored. */
export function setActiveTextAlternative(nodeId: string, index: number): void {
  const node = getCanvasState().nodes.find((n) => n.id === nodeId);
  const alternatives = node?.metadata.textAlternatives;
  if (!alternatives) return;
  const next = alternatives.items[index];
  if (next === undefined) return;
  updateNode(nodeId, {
    metadata: {
      content: next,
      textAlternatives: { ...alternatives, activeIndex: index },
    },
  });
}

/**
 * Write an edit back into the active alternative as well as `content`.
 *
 * Without this, editing an alternative and then switching away would silently
 * discard the edit — the switch reads from `items`, which would still hold the
 * generated text.
 */
export function updateTextNodeContent(nodeId: string, content: string): void {
  const node = getCanvasState().nodes.find((n) => n.id === nodeId);
  const alternatives = node?.metadata.textAlternatives;
  if (!alternatives) {
    updateNode(nodeId, { metadata: { content } });
    return;
  }
  const items = [...alternatives.items];
  items[alternatives.activeIndex] = content;
  updateNode(nodeId, {
    metadata: { content, textAlternatives: { ...alternatives, items } },
  });
}
