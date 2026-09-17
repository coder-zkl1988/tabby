/**
 * canvas-batch.ts
 *
 * Batch image group logic (W2.7). Multi-result generation fans into a root
 * node + child nodes with collapse/expand and set-primary swap.
 *
 * Removal semantics are implemented directly in canvas-store's removeNodes
 * (all deletion paths must behave). This module owns attach/toggle/swap/predicate.
 */

import {
  type CanvasNode,
  type CanvasNodeMetadata,
  addNode,
  getCanvasState,
  updateNode,
} from "./canvas-store";

/** Retry payload copied onto a failed placeholder so its 重试 button works. */
type BatchRetry = NonNullable<CanvasNodeMetadata["task"]>["retry"];

/**
 * Attach batch children to an existing root node.
 *
 * - Sets root content = items[0].url and root metadata.batch.
 * - Creates child nodes for items[1..] positioned to the right of the root
 *   with a cascading offset.
 * - No-op for batch group when items.length <= 1 (single-item stays independent).
 *
 * When `requested` exceeds `items.length`, the shortfall becomes failed
 * placeholder children (reference v0.15): the lane returned fewer pictures than
 * were asked for, and dropping them silently made a partial failure look like a
 * complete result. Each placeholder carries `retry`, so the error node's
 * existing 重试 button regenerates just that one.
 *
 * Owns both root content and child creation atomically.
 */
export function attachBatchChildren(
  rootId: string,
  items: ReadonlyArray<{ url: string }>,
  options?: { requested?: number; retry?: BatchRetry },
): void {
  const root = getCanvasState().nodes.find((n) => n.id === rootId);
  if (!root) return;

  const requested = options?.requested ?? items.length;
  const missing = Math.max(0, requested - items.length);

  // Always set root content from items[0]
  updateNode(rootId, { metadata: { content: items[0]?.url } });

  if (items.length <= 1 && missing === 0) {
    // Single item: no batch group
    return;
  }

  // Create child nodes for items[1..]
  const childIds: string[] = [];
  for (let i = 1; i < items.length; i++) {
    const childUrl = items[i]?.url;
    if (!childUrl) continue;
    const childTitle = `${root.title} #${i + 1}`;
    // Position: x = root.x + root.width + 24 + (i-1)*24, y = root.y + (i-1)*24
    const childPosition = {
      x: root.position.x + root.size.width + 24 + (i - 1) * 24,
      y: root.position.y + (i - 1) * 24,
    };
    const child = addNode({
      type: "image",
      title: childTitle,
      position: childPosition,
      size: { ...root.size },
      metadata: {
        content: childUrl,
        batch: { rootId },
      },
    });
    childIds.push(child.id);
  }

  // Failed slots: one placeholder per missing image, positioned after the real
  // children so the grid keeps the requested shape.
  for (let i = 0; i < missing; i++) {
    const slot = items.length + i;
    const child = addNode({
      type: "image",
      title: `${root.title} #${slot + 1}`,
      position: {
        x: root.position.x + root.size.width + 24 + (slot - 1) * 24,
        y: root.position.y + (slot - 1) * 24,
      },
      size: { ...root.size },
      metadata: {
        batch: { rootId },
        task: {
          status: "error",
          error: "这一张没有生成出来",
          ...(options?.retry ? { retry: options.retry } : {}),
        },
      },
    });
    childIds.push(child.id);
  }

  // Update root with batch metadata
  updateNode(rootId, {
    metadata: {
      batch: { childIds, expanded: true },
    },
  });
}

/**
 * Toggle the expanded state of a batch group root.
 * Collapsed → children hidden from surface; expanded → children visible.
 */
export function toggleBatchExpanded(rootId: string): void {
  const root = getCanvasState().nodes.find((n) => n.id === rootId);
  if (!root?.metadata.batch?.childIds) return;
  const currentExpanded = root.metadata.batch.expanded ?? true;
  updateNode(rootId, {
    metadata: {
      batch: {
        ...root.metadata.batch,
        expanded: !currentExpanded,
      },
    },
  });
}

/**
 * Promote a child node to primary by swapping content and title with the root.
 * Both nodes stay in place; batch linkage is unchanged.
 */
export function setBatchPrimary(childId: string): void {
  const state = getCanvasState();
  const child = state.nodes.find((n) => n.id === childId);
  const rootId = child?.metadata.batch?.rootId;
  if (!child || !rootId) return;
  const root = state.nodes.find((n) => n.id === rootId);
  if (!root) return;

  const rootContent = root.metadata.content;
  const rootTitle = root.title;
  const childContent = child.metadata.content;
  const childTitle = child.title;

  // Swap content on root
  updateNode(rootId, {
    title: childTitle,
    metadata: { content: childContent },
  });
  // Swap content on child
  updateNode(childId, {
    title: rootTitle,
    metadata: { content: rootContent },
  });
}

/**
 * Returns true iff the node is a batch child whose root exists and is collapsed.
 *
 * Used by the render filter to skip hidden batch children in:
 *   - CanvasSurface node render
 *   - marquee hit-test
 *   - connect-drop hit-test
 */
export function isHiddenBatchChild(
  node: CanvasNode,
  nodes: ReadonlyArray<CanvasNode>,
): boolean {
  const rootId = node.metadata.batch?.rootId;
  if (!rootId) return false;
  const root = nodes.find((n) => n.id === rootId);
  if (!root) return false;
  // expanded === false means collapsed; undefined/true means visible
  return root.metadata.batch?.expanded === false;
}
