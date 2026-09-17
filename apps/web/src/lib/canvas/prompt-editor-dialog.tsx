/**
 * prompt-editor-dialog.tsx — full-size prompt editor (reference v0.15).
 *
 * The panel's 3-row textarea is unusable for a long prompt. This opens the same
 * draft in a tall editor; both are bound to the prompt-drafts store, so typing
 * in either updates the other live and closing keeps whatever was typed —
 * there is no separate confirm step to lose work to.
 */

import { closeCanvasDialog } from "./canvas-dialogs";
import { CanvasModal } from "./canvas-modal";
import { getCanvasState } from "./canvas-store";
import { setDraft, useDraft } from "./prompt-drafts";

export function PromptEditorDialog({ nodeId }: { nodeId: string }) {
  const prompt = useDraft(nodeId);
  const title = getCanvasState().nodes.find((n) => n.id === nodeId)?.title;

  return (
    <CanvasModal
      title={title ? `编辑提示词 · ${title}` : "编辑提示词"}
      onClose={closeCanvasDialog}
      maxWidth={720}
      scrollable={false}
      dataAttr={{ name: "data-canvas-prompt-editor-dialog", value: nodeId }}
    >
      <textarea
        // biome-ignore lint/a11y/noAutofocus: the dialog exists only to type in
        autoFocus
        data-canvas-prompt-editor-input={nodeId}
        aria-label="提示词"
        className="h-[50vh] min-h-0 w-full select-text resize-none rounded-xl border-0 bg-surface-2 px-4 py-3 text-sm leading-relaxed outline-none placeholder:text-text-tertiary"
        placeholder="描述要生成的内容"
        value={prompt}
        onChange={(event) => setDraft(nodeId, event.target.value)}
      />
      <div className="shrink-0 text-right text-xs text-text-tertiary">
        {prompt.length} 字
      </div>
    </CanvasModal>
  );
}
