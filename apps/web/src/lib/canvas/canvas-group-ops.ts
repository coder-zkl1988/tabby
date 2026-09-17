/**
 * canvas-group-ops.ts
 *
 * Group-from-selection actions (reference v0.18 paradigm): wrap the selected
 * nodes in a group container, or release them again.
 *
 * Complements the drop-to-join path in infinite-canvas.tsx, which assigns
 * membership by where a node lands. Both share the membership model in
 * canvas-groups.ts: a member carries `metadata.groupId`, groups never nest.
 *
 * Every action here issues its store writes in ONE tick, so the store's
 * history debounce folds them into a single undo step.
 */

import {
  canGroupSelection,
  canUngroupSelection,
  groupSelectionMembers,
  groupWrapRect,
} from "./canvas-groups";
import {
  addNode,
  getCanvasState,
  removeNodes,
  selectNodes,
  setGroupMemberships,
} from "./canvas-store";

/** Default title for a group created from a selection. */
const GROUP_TITLE = "组";

/**
 * Wrap the current selection in a new group node.
 *
 * Selected groups are flattened into the new one (their members carry over,
 * the old group boxes are removed). Returns the new group's id, or `null` when
 * the selection cannot be grouped.
 *
 * Order matters: the old groups are removed FIRST, because removing a group
 * clears its members' `groupId` — assigning the new membership before that
 * would undo itself.
 */
export function groupSelectedNodes(): string | null {
  const { nodes, selectedNodeIds } = getCanvasState();
  const selectedIds = new Set(selectedNodeIds);
  if (!canGroupSelection(selectedIds, nodes)) return null;

  const members = groupSelectionMembers(selectedIds, nodes);
  const memberIds = members.map((node) => node.id);
  const rect = groupWrapRect(members);
  const flattenedGroupIds = nodes
    .filter((node) => node.type === "group" && selectedIds.has(node.id))
    .map((node) => node.id);

  if (flattenedGroupIds.length > 0) {
    removeNodes(flattenedGroupIds);
  }
  const group = addNode({
    type: "group",
    title: GROUP_TITLE,
    position: rect.position,
    size: rect.size,
  });
  setGroupMemberships(memberIds.map((id) => ({ id, groupId: group.id })));
  selectNodes([group.id]);
  return group.id;
}

/**
 * Release the selection from its groups.
 *
 * Selected group nodes are removed — `removeNodes` already unbinds a removed
 * group's members rather than deleting them. Selected member nodes whose group
 * is NOT itself selected simply leave that group, which survives with its
 * remaining members.
 *
 * Returns true when something was ungrouped.
 */
export function ungroupSelectedNodes(): boolean {
  const { nodes, selectedNodeIds } = getCanvasState();
  const selectedIds = new Set(selectedNodeIds);
  if (!canUngroupSelection(selectedIds, nodes)) return false;

  const groupIds = nodes
    .filter((node) => node.type === "group" && selectedIds.has(node.id))
    .map((node) => node.id);
  const removedGroupIds = new Set(groupIds);

  // Members released individually: selected, still in a group, and that group
  // is not already being removed (removeNodes clears those on its own).
  const releasedIds = nodes
    .filter(
      (node) =>
        selectedIds.has(node.id) &&
        node.type !== "group" &&
        node.metadata.groupId !== undefined &&
        !removedGroupIds.has(node.metadata.groupId),
    )
    .map((node) => node.id);

  if (groupIds.length > 0) {
    removeNodes(groupIds);
  }
  if (releasedIds.length > 0) {
    setGroupMemberships(releasedIds.map((id) => ({ id, groupId: undefined })));
  }
  return true;
}
