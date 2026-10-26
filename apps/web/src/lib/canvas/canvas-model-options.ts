/**
 * canvas-model-options.ts
 *
 * Shared model list for the canvas generation model pickers (W5). The selected
 * model id is a best-effort HINT — the generation lane honors it only if the
 * active tool/skill supports model selection.
 */

import {
  QueryClient,
  QueryClientContext,
  useQuery,
} from "@tanstack/react-query";
import { useContext } from "react";
import { getApiV1Models } from "../../../lib/api/sdk.gen";

// Standalone fallback so the fetch works even when a picker is rendered outside
// an app-level QueryClientProvider (e.g. canvas static-markup tests). In the
// running app the provider's client is used, so the ["models"] cache is shared.
const fallbackQueryClient = new QueryClient();

export type CanvasModelOption = { id: string; name: string };

export type GenerationCapability = "image" | "video" | "audio" | "text";

/**
 * Per-capability model allowlists. The /models list is the CHAT model
 * registry; only these entries are actual generation backends for the given
 * modality — offering tabby-ultra in an image picker just produces a broken
 * hint. Modalities without an allowlist (audio/text) show the full list.
 */
const CAPABILITY_MODEL_ALLOWLIST: Partial<
  Record<GenerationCapability, Set<string>>
> = {
  image: new Set(["tabby-image"]),
  video: new Set(["tabby-video"]),
};

/** Pure filter (exported for tests). */
export function filterModelsByCapability(
  models: ReadonlyArray<CanvasModelOption>,
  capability?: GenerationCapability,
): CanvasModelOption[] {
  const allow = capability ? CAPABILITY_MODEL_ALLOWLIST[capability] : undefined;
  if (!allow) return [...models];
  return models.filter((m) => allow.has(m.id));
}

/**
 * Available generation models for the canvas model pickers, optionally
 * narrowed to the models that can actually serve `capability`.
 */
export function useCanvasModelOptions(
  capability?: GenerationCapability,
): CanvasModelOption[] {
  const ctxClient = useContext(QueryClientContext);
  const { data } = useQuery(
    {
      queryKey: ["models"],
      queryFn: async () => {
        const { data: d } = await getApiV1Models();
        return d;
      },
      staleTime: 5 * 60 * 1000,
    },
    ctxClient ?? fallbackQueryClient,
  );
  return filterModelsByCapability(data?.models ?? [], capability);
}
