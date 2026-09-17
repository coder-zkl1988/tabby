/**
 * canvas-dialogs.ts — module store for canvas overlay dialogs (W3.2).
 *
 * Pattern mirrors canvas-store (useSyncExternalStore, zero deps).
 *
 * CanvasDialogState is an extensible kind union so future tasks can add
 * split / upscale / mask / angle dialogs without touching this store.
 */

import { useSyncExternalStore } from "react";

// ── Types ──────────────────────────────────────────────────────────────────

export type CanvasDialogState =
  | { kind: "crop"; nodeId: string }
  | { kind: "split"; nodeId: string }
  | { kind: "upscale"; nodeId: string }
  | { kind: "mask"; nodeId: string }
  | { kind: "angle"; nodeId: string }
  | { kind: "preview"; nodeId: string }
  | { kind: "assets" }
  | { kind: "prompt-library"; nodeId: string }
  | { kind: "prompt-editor"; nodeId: string }
  | null;

// ── Store internals ────────────────────────────────────────────────────────

let state: CanvasDialogState = null;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

// ── Actions ────────────────────────────────────────────────────────────────

export function openCanvasDialog(
  dialogState: NonNullable<CanvasDialogState>,
): void {
  state = dialogState;
  emit();
}

export function closeCanvasDialog(): void {
  state = null;
  emit();
}

// ── Selectors ──────────────────────────────────────────────────────────────

export function getCanvasDialog(): CanvasDialogState {
  return state;
}

export function useCanvasDialog(): CanvasDialogState {
  return useSyncExternalStore(
    (callback) => {
      listeners.add(callback);
      return () => listeners.delete(callback);
    },
    () => state,
    () => state,
  );
}

// ── Test helpers ───────────────────────────────────────────────────────────

export function __resetCanvasDialogsForTests(): void {
  state = null;
  listeners.clear();
}

export function __subscribeForTests(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
