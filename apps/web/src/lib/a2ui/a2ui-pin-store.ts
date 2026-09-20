import type { A2UIMessage } from "./a2ui-types";

/**
 * User-pinned A2UI surfaces (design: chat cards scroll away; the canvas
 * workbench keeps them in view).
 *
 * Keyed by COMPONENT TYPE, not surfaceId: the agent names each surface freely
 * per project ("koc-acceptance-0908-form", "xhs-badminton-account-planner"),
 * so a surfaceId never recurs and remembering one would never fire again.
 * Pinning XhsOpsRunPlanner once should pin every later planner card.
 */

const STORAGE_KEY = "nexu:a2ui:pinned-component-types:v1";

let pinnedTypes: Set<string> | null = null;
const listeners = new Set<() => void>();

function load(): Set<string> {
  if (pinnedTypes) return pinnedTypes;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    pinnedTypes = new Set(
      Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [],
    );
  } catch {
    // Storage unavailable (SSR, private mode) — pins just won't persist.
    pinnedTypes = new Set();
  }
  return pinnedTypes;
}

function persist(): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify([...load()]));
  } catch {
    // Same as above: in-memory state still works for this session.
  }
}

/**
 * Component types carried by a surface's messages, in declaration order.
 * Covers both shapes: `createSurface` may inline the tree, and later
 * `updateComponents` batches add to it.
 */
export function surfaceComponentTypes(messages: A2UIMessage[]): string[] {
  const types: string[] = [];
  const seen = new Set<string>();
  const collect = (components: unknown): void => {
    if (!Array.isArray(components)) return;
    for (const comp of components) {
      const type = (comp as { type?: unknown } | null)?.type;
      if (typeof type !== "string" || seen.has(type)) continue;
      seen.add(type);
      types.push(type);
    }
  };
  for (const msg of messages) {
    if ("createSurface" in msg) collect(msg.createSurface?.components);
    else if ("updateComponents" in msg)
      collect(msg.updateComponents?.components);
  }
  return types;
}

/**
 * The type a pin is remembered under: the surface's first component type.
 * Null when the surface declares none (nothing stable to key on).
 */
export function surfacePinKey(messages: A2UIMessage[]): string | null {
  return surfaceComponentTypes(messages)[0] ?? null;
}

export function isPinnedType(key: string | null): boolean {
  return key !== null && load().has(key);
}

/** True when this surface's type was pinned before — caller should auto-pin. */
export function isSurfaceTypePinned(messages: A2UIMessage[]): boolean {
  return isPinnedType(surfacePinKey(messages));
}

export function setTypePinned(key: string | null, pinned: boolean): void {
  if (key === null) return;
  const set = load();
  if (pinned === set.has(key)) return;
  if (pinned) set.add(key);
  else set.delete(key);
  persist();
  for (const listener of listeners) listener();
}

export function subscribePinnedTypes(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test seam: drop cached state so a fresh localStorage is re-read. */
export function resetPinnedTypesForTests(): void {
  pinnedTypes = null;
  listeners.clear();
}
