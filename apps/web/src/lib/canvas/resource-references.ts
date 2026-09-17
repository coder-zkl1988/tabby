/**
 * resource-references.ts
 *
 * Pull-side semantics for canvas generation inputs (W2.1).
 *
 * An edge INTO a node means "this feeds your generation." When a node generates,
 * everything connected UPSTREAM feeds it:
 *  - text  → prompt context
 *  - image → reference images
 *  - video → reference media
 *  - audio → reference media
 *  - group → every member of the group, as if each were connected directly
 *
 * @see connection-effects.ts for push-on-connect effects (a different concern).
 */

import { type CanvasNode, getCanvasState } from "./canvas-store";

// ── Types ──────────────────────────────────────────────────────

export type UpstreamResources = {
  prompts: string[];
  images: string[];
  videos: string[];
  audios: string[];
};

/**
 * One upstream node together with how it was reached — the provenance the
 * reference bar needs to let a user drop a reference again.
 */
export type UpstreamRef = {
  node: CanvasNode;
  /**
   * Id of the DIRECT connection into the starting node that began this node's
   * path. Cutting it drops this reference — and, for a group, every member
   * reference it brought in (one edge, one removal).
   */
  edgeId: string;
  /** Set when the node was reached by expanding a group node. */
  viaGroupId?: string;
};

// ── Core traversal ─────────────────────────────────────────────

/**
 * BFS over incoming edges, carrying each node's provenance.
 *
 * Visit order:
 *  - Direct upstream first (level by level).
 *  - Within a level: order connections appear in `state.connections`; a group's
 *    members follow in node order, right after the group itself.
 *  - Dedupe visited node ids; cycle-safe via visited set.
 *  - The starting node itself is NOT included.
 *
 * Group nodes are containers, not resources: a group contributes nothing of its
 * own, and each member is queued as though it carried the group's edge. So one
 * connection from a group feeds every valid resource inside it, and a member's
 * own upstream is traversed exactly as a direct connection to it would be.
 */
export function collectUpstreamRefs(nodeId: string): UpstreamRef[] {
  const { nodes, connections } = getCanvasState();
  const nodeById = new Map(nodes.map((n) => [n.id, n]));

  type QueueEntry = { id: string; edgeId: string; viaGroupId?: string };

  const refs: UpstreamRef[] = [];
  const visited = new Set<string>();
  visited.add(nodeId); // exclude starting node

  // Queue seeded with the direct parents; each carries its own edge id.
  const queue: QueueEntry[] = [];
  for (const conn of connections) {
    if (conn.toNodeId === nodeId && !visited.has(conn.fromNodeId)) {
      visited.add(conn.fromNodeId);
      queue.push({ id: conn.fromNodeId, edgeId: conn.id });
    }
  }

  let head = 0;
  while (head < queue.length) {
    const entry = queue[head++] as QueueEntry;
    const node = nodeById.get(entry.id);
    if (!node) continue;

    refs.push({
      node,
      edgeId: entry.edgeId,
      ...(entry.viaGroupId !== undefined
        ? { viaGroupId: entry.viaGroupId }
        : {}),
    });

    // Group expansion: members inherit the group's edge id so the reference bar
    // can cut the whole group with the one connection that brought it in.
    if (node.type === "group") {
      for (const member of nodes) {
        if (member.metadata.groupId !== node.id) continue;
        if (visited.has(member.id)) continue;
        visited.add(member.id);
        queue.push({
          id: member.id,
          edgeId: entry.edgeId,
          viaGroupId: node.id,
        });
      }
    }

    // Enqueue unvisited parents (incoming edges to this node), keeping the
    // provenance of the direct edge that started the path.
    for (const conn of connections) {
      if (conn.toNodeId === entry.id && !visited.has(conn.fromNodeId)) {
        visited.add(conn.fromNodeId);
        queue.push({ id: conn.fromNodeId, edgeId: entry.edgeId });
      }
    }
  }

  return refs;
}

// ── Public API ─────────────────────────────────────────────────

/**
 * Collect all resources reachable upstream of `nodeId`, in `collectUpstreamRefs`
 * order.
 *
 * Per-node type mapping:
 *  - `text`  with non-empty trimmed `metadata.content` → `prompts`
 *  - `image` with non-empty `metadata.content`         → `images`
 *  - `video` with non-empty `metadata.content`         → `videos`
 *  - `audio` with non-empty `metadata.content`         → `audios`
 *  - `group` contributes nothing itself — its members are visited instead
 *  - `a2ui` / `team-step` contribute nothing (but ancestors still traversed)
 */
export function collectUpstream(nodeId: string): UpstreamResources {
  const result: UpstreamResources = {
    prompts: [],
    images: [],
    videos: [],
    audios: [],
  };

  for (const { node } of collectUpstreamRefs(nodeId)) {
    const content = node.metadata.content ?? "";
    if (node.type === "text") {
      if (content.trim() !== "") {
        result.prompts.push(content);
      }
    } else if (node.type === "image") {
      if (content !== "") {
        result.images.push(content);
      }
    } else if (node.type === "video") {
      if (content !== "") {
        result.videos.push(content);
      }
    } else if (node.type === "audio") {
      if (content !== "") {
        result.audios.push(content);
      }
    }
  }

  return result;
}

/**
 * Collect all nodes reachable upstream of `nodeId`, in the same order as
 * `collectUpstream`.
 *
 * Group nodes are dropped from the result — a group carries no content of its
 * own, so `@`-mentioning it would reference nothing; its members are listed
 * instead. Useful for mention candidates in the prompt panel.
 */
export function collectUpstreamNodes(nodeId: string): CanvasNode[] {
  return collectUpstreamRefs(nodeId)
    .map((ref) => ref.node)
    .filter((node) => node.type !== "group");
}

/**
 * Cheap check: does any connection point INTO `nodeId`?
 * Use this to guard generation before calling `collectUpstream`.
 */
export function hasUpstream(nodeId: string): boolean {
  const { connections } = getCanvasState();
  return connections.some((conn) => conn.toNodeId === nodeId);
}
