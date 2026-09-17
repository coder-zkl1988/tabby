/**
 * canvas-groups.ts
 *
 * Pure membership math for group container nodes (P3). A group is a node of
 * type "group" (an inert container box); member nodes carry
 * `metadata.groupId = <group id>`. Groups never nest. Kept dependency-free and
 * pure so the drag path and its tests share one source of truth.
 *
 * Concept model mirrors the reference infinite-canvas app's Group node
 * (MIT since v0.15.1 — interaction paradigm only, reimplemented from scratch).
 */

import type { CanvasNode } from "./canvas-store";

type GroupRect = {
  id: string;
  position: { x: number; y: number };
  size: { width: number; height: number };
};

/**
 * Which group's rect contains `center`, or `undefined` if none does.
 *
 * Center-inside-rect test, inclusive of edges. When several groups overlap and
 * all contain the point, the LAST match in `groups` wins: callers pass groups
 * in node/render order, and groups render behind everything in that order, so
 * the last match is the topmost group. Deterministic tiebreak.
 */
export function groupIdForPoint(
  center: { x: number; y: number },
  groups: ReadonlyArray<GroupRect>,
): string | undefined {
  let match: string | undefined;
  for (const group of groups) {
    const withinX =
      center.x >= group.position.x &&
      center.x <= group.position.x + group.size.width;
    const withinY =
      center.y >= group.position.y &&
      center.y <= group.position.y + group.size.height;
    if (withinX && withinY) {
      match = group.id;
    }
  }
  return match;
}

/** Ids of every node that is a member of `groupId` (metadata.groupId match). */
export function memberIdsOf(
  groupId: string,
  nodes: ReadonlyArray<CanvasNode>,
): string[] {
  const ids: string[] = [];
  for (const node of nodes) {
    if (node.metadata.groupId === groupId) ids.push(node.id);
  }
  return ids;
}

// ── Group-from-selection (reference v0.18 paradigm) ────────────

/** Side/bottom breathing room between a wrapping group and its members. */
export const GROUP_WRAP_PADDING = 24;
/**
 * Extra room above the members. Node titles float 28px ABOVE their card
 * (see infinite-canvas.tsx), so a plain 24px inset would clip every member's
 * title against the group's top edge.
 */
export const GROUP_WRAP_TOP_PADDING = 40;

/**
 * The nodes a "group the selection" action would take in: every selected
 * non-group node, plus every member of a selected group (grouping a group
 * flattens it into the new one — groups never nest).
 *
 * Returned in `nodes` order, deduped.
 */
export function groupSelectionMembers(
  selectedIds: ReadonlySet<string>,
  nodes: ReadonlyArray<CanvasNode>,
): CanvasNode[] {
  const selectedGroupIds = new Set(
    nodes
      .filter((node) => node.type === "group" && selectedIds.has(node.id))
      .map((node) => node.id),
  );
  return nodes.filter(
    (node) =>
      node.type !== "group" &&
      (selectedIds.has(node.id) ||
        (node.metadata.groupId !== undefined &&
          selectedGroupIds.has(node.metadata.groupId))),
  );
}

/**
 * The world rect a group must occupy to wrap `members` with padding.
 * Empty input yields a zero rect — callers gate on `canGroupSelection` first.
 */
export function groupWrapRect(members: ReadonlyArray<CanvasNode>): {
  position: { x: number; y: number };
  size: { width: number; height: number };
} {
  if (members.length === 0) {
    return { position: { x: 0, y: 0 }, size: { width: 0, height: 0 } };
  }
  let left = Number.POSITIVE_INFINITY;
  let top = Number.POSITIVE_INFINITY;
  let right = Number.NEGATIVE_INFINITY;
  let bottom = Number.NEGATIVE_INFINITY;
  for (const node of members) {
    left = Math.min(left, node.position.x);
    top = Math.min(top, node.position.y);
    right = Math.max(right, node.position.x + node.size.width);
    bottom = Math.max(bottom, node.position.y + node.size.height);
  }
  return {
    position: {
      x: left - GROUP_WRAP_PADDING,
      y: top - GROUP_WRAP_TOP_PADDING,
    },
    size: {
      width: right - left + GROUP_WRAP_PADDING * 2,
      height: bottom - top + GROUP_WRAP_TOP_PADDING + GROUP_WRAP_PADDING,
    },
  };
}

/**
 * Can the selection become a group? Needs at least two members, and at least
 * one of them not already in the same single group (re-grouping an intact
 * group would just rebuild the box it already has).
 */
export function canGroupSelection(
  selectedIds: ReadonlySet<string>,
  nodes: ReadonlyArray<CanvasNode>,
): boolean {
  const members = groupSelectionMembers(selectedIds, nodes);
  if (members.length < 2) return false;
  const first = members[0]?.metadata.groupId;
  if (first === undefined) return true;
  return members.some((node) => node.metadata.groupId !== first);
}

/**
 * Can the selection be ungrouped? True when it holds a group node, or a node
 * that currently belongs to one.
 */
export function canUngroupSelection(
  selectedIds: ReadonlySet<string>,
  nodes: ReadonlyArray<CanvasNode>,
): boolean {
  return nodes.some(
    (node) =>
      selectedIds.has(node.id) &&
      (node.type === "group" || node.metadata.groupId !== undefined),
  );
}
