/** Node content views extracted from infinite-canvas.tsx (W3.0). */
import { A2UIRenderer } from "@/lib/a2ui";
import { Group, ImagePlus, Music2, Video } from "lucide-react";
import { type ReactNode, memo, useState } from "react";
import { StatusPill } from "../a2ui/a2ui-status";
import { openCanvasDialog } from "./canvas-dialogs";
import { retryNodeTask } from "./canvas-generation";
import { memberIdsOf } from "./canvas-groups";
import { readFilesAsDataUrls } from "./canvas-ingest";
import {
  type CanvasNode,
  getA2UIPayload,
  updateNode,
  useCanvas,
} from "./canvas-store";
import {
  setActiveTextAlternative,
  updateTextNodeContent,
} from "./canvas-text-alternatives";
import { useCanvasUiPrefs } from "./canvas-ui-prefs";
import { ConfigNodeContent } from "./config-node";
import { PhoneNodeContent } from "./phone-node";
import { TeamStepNodeContent } from "./team-step-node";
import { XhsNodeContent } from "./xhs-node";

// ── shouldStoreNaturalSize ─────────────────────────────────────────

/**
 * W4.2: Pure predicate for deciding whether to write naturalWidth/naturalHeight
 * to the node metadata after an image onLoad event.
 *
 * Returns true iff:
 *  - w > 0 and h > 0 (zero dims from browser quirk → skip)
 *  - either naturalWidth/naturalHeight is absent in metadata, OR differs from w/h
 *
 * This prevents loops: the second onLoad with the same dims returns false.
 */
export function shouldStoreNaturalSize(
  metadata: { naturalWidth?: number; naturalHeight?: number },
  w: number,
  h: number,
): boolean {
  if (w <= 0 || h <= 0) return false;
  return metadata.naturalWidth !== w || metadata.naturalHeight !== h;
}

// ── TextNodeContent ────────────────────────────────────────────

/**
 * Text node content: static display mode by default; double-click to edit.
 * Local `editing` state re-renders only this component (memo boundary is NodeBody).
 */
function TextNodeContent({ node }: { node: CanvasNode }) {
  const [editing, setEditing] = useState(false);
  const fontSize = node.metadata.fontSize ?? 14;
  const content = node.metadata.content ?? "";
  const alternatives = node.metadata.textAlternatives;

  const body = editing ? (
    <textarea
      // biome-ignore lint/a11y/noAutofocus: edit mode intentionally auto-focuses
      autoFocus
      data-canvas-wheel-exempt="true"
      className="min-h-0 w-full flex-1 select-text resize-none bg-transparent font-mono text-sm outline-none"
      style={{ fontSize }}
      value={content}
      // Writes through to the active alternative too, so switching away after
      // an edit doesn't quietly restore the generated text.
      onChange={(event) => updateTextNodeContent(node.id, event.target.value)}
      onBlur={() => setEditing(false)}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.stopPropagation();
          setEditing(false);
        }
      }}
    />
  ) : (
    <div
      data-canvas-text-display
      data-canvas-wheel-exempt="true"
      className="min-h-0 w-full flex-1 select-none overflow-y-auto whitespace-pre-wrap font-mono text-sm"
      style={{ fontSize }}
      onDoubleClick={() => setEditing(true)}
    >
      {content || <span className="text-text-tertiary">双击编辑文字</span>}
    </div>
  );

  if (!alternatives || alternatives.items.length <= 1) {
    return <div className="flex h-full w-full flex-col">{body}</div>;
  }

  return (
    <div className="flex h-full w-full flex-col gap-1.5">
      {body}
      {/* Alternative switcher (reference v0.17): several generations live in
          this one node rather than fanning out like images. */}
      <div
        data-canvas-text-alternatives={node.id}
        className="flex shrink-0 flex-wrap items-center gap-1 text-[11px]"
      >
        {alternatives.items.map((_, index) => (
          <button
            // biome-ignore lint/suspicious/noArrayIndexKey: the slot IS the identity
            key={index}
            type="button"
            data-canvas-text-alternative={index}
            aria-label={`备选 ${index + 1}`}
            aria-pressed={index === alternatives.activeIndex}
            onPointerDown={(event) => event.stopPropagation()}
            onClick={() => setActiveTextAlternative(node.id, index)}
            className={
              index === alternatives.activeIndex
                ? "rounded-md bg-[var(--color-accent)] px-1.5 py-0.5 font-medium text-[var(--color-accent-fg)]"
                : "rounded-md bg-surface-2 px-1.5 py-0.5 text-text-secondary hover:text-text-primary"
            }
          >
            {index + 1}
          </button>
        ))}
        {alternatives.requested !== undefined ? (
          <span className="text-text-tertiary">
            {alternatives.items.length}/{alternatives.requested}{" "}
            条，其余生成失败
          </span>
        ) : null}
      </div>
    </div>
  );
}

/** Node content re-renders only on content changes, never on geometry. */
export const NodeBody = memo(
  function NodeBody({ node }: { node: CanvasNode }) {
    return <NodeContent node={node} />;
  },
  (prev, next) =>
    prev.node.id === next.node.id &&
    prev.node.type === next.node.type &&
    prev.node.title === next.node.title &&
    prev.node.metadata === next.node.metadata,
);

// ── Node content by type ───────────────────────────────────────

function EmptyMediaHint({
  icon,
  label,
  nodeId,
  accept,
}: {
  icon: ReactNode;
  label: string;
  nodeId?: string;
  accept?: string;
}) {
  // An empty node used to be a label and nothing else — the two ways to fill
  // it (upload, asset library) both lived elsewhere. They are 28px because
  // they sit inside the node body, not on a form.
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-2xl bg-surface-2/60 p-4 text-text-secondary">
      <span className="opacity-35">{icon}</span>
      <span className="text-[13px]">{label}</span>
      {nodeId ? (
        <div className="flex flex-wrap items-center justify-center gap-2">
          {/* Upload is the one action that can fill THIS node: the asset
              picker is a global dialog with no node target. */}
          <label
            className="inline-flex h-7 cursor-pointer items-center rounded-md border border-border-strong bg-surface-1 px-2.5 text-[12px] font-medium text-text-primary transition-colors hover:border-[var(--color-accent)]"
            onPointerDown={(event) => event.stopPropagation()}
          >
            上传
            <input
              type="file"
              accept={accept}
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length === 0) return;
                void readFilesAsDataUrls(files).then((inputs) => {
                  const first = inputs[0];
                  if (!first) return;
                  updateNode(nodeId, {
                    title: first.name,
                    metadata: {
                      content: first.dataUrl,
                      mimeType: first.type,
                    },
                  });
                });
              }}
            />
          </label>
        </div>
      ) : null}
    </div>
  );
}

/**
 * Group container body — visually a header (icon chip + member-count pill)
 * over a dashed drop zone (reference parity). Still functionally inert:
 * pointer-events-none, so pointerdown falls through to the card root (drag).
 * Member nodes are separate canvas nodes painted on top of the group — the
 * group never renders its children inside itself.
 *
 * Subscribes to useCanvas for the live member count; this is the component's
 * own subscription, so NodeBody's geometry-ignoring memo doesn't staleness it.
 */
function GroupNodeContent({ node }: { node: CanvasNode }) {
  const { nodes } = useCanvas();
  const memberCount = memberIdsOf(node.id, nodes).length;
  return (
    <div
      data-canvas-group-body="true"
      aria-hidden="true"
      className="pointer-events-none flex h-full w-full flex-col"
    >
      <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
        <span className="grid size-8 place-items-center rounded-xl bg-surface-2 text-text-secondary">
          <Group size={16} />
        </span>
        <span>组</span>
        <span className="ml-auto rounded-full bg-surface-2 px-2 py-1 text-[11px] font-medium text-text-secondary">
          {memberCount} 个节点
        </span>
      </div>
      <div className="mt-3 flex-1 rounded-2xl border border-dashed border-border/60 bg-surface-2/20" />
    </div>
  );
}

function NodeContent({ node }: { node: CanvasNode }): ReactNode {
  if (node.type === "team-step") {
    return <TeamStepNodeContent node={node} />;
  }

  // Config nodes have their own inline UI — they never get the task spinner
  // (the RESULT node carries the task, not the config node).
  if (node.type === "config") {
    return <ConfigNodeContent node={node} />;
  }

  if (node.type === "xhs") {
    return <XhsNodeContent node={node} />;
  }

  if (node.type === "phone") {
    return <PhoneNodeContent node={node} />;
  }

  // Group nodes are inert containers. This early branch is LOAD-BEARING: the
  // function falls through to the image renderer at the bottom, so a "group"
  // node without an explicit branch would render as an empty image node
  // (upload/generate UI). Members are separate nodes painted on top — the group
  // never renders its children inside itself.
  if (node.type === "group") {
    return <GroupNodeContent node={node} />;
  }

  // Task status overlay: applies before per-type media rendering for image/video/audio.
  if (node.metadata.task?.status === "generating") {
    return (
      <div
        data-canvas-node-generating={node.id}
        className="flex h-full w-full flex-col items-center justify-center gap-3"
      >
        <div className="size-10 animate-spin rounded-full border-2 border-border border-t-[var(--color-brand-primary)]" />
        <StatusPill tone="running">生成中</StatusPill>
      </div>
    );
  }
  if (node.metadata.task?.status === "error") {
    return (
      <div
        data-canvas-node-error={node.id}
        className="flex h-full w-full flex-col items-center justify-center gap-3 p-4"
      >
        <StatusPill tone="failed">生成失败</StatusPill>
        <p className="max-w-full text-center text-[12px] leading-[1.5] text-text-secondary">
          {node.metadata.task.error ?? "未返回失败原因"}
        </p>
        <button
          type="button"
          data-canvas-node-retry={node.id}
          onPointerDown={(event) => event.stopPropagation()}
          onClick={() => retryNodeTask(node.id)}
          className="inline-flex h-9 items-center rounded-lg bg-[var(--color-accent)] px-5 text-[13px] font-semibold text-[var(--color-accent-fg)] transition-colors hover:bg-[var(--color-accent-hover)]"
        >
          重试
        </button>
      </div>
    );
  }

  if (node.type === "video") {
    return node.metadata.content ? (
      // biome-ignore lint/a11y/useMediaCaption: user-provided clips have no captions
      <video
        src={node.metadata.content}
        controls
        className="h-full w-full bg-black object-contain"
      />
    ) : (
      <EmptyMediaHint
        icon={<Video size={28} />}
        label="空视频节点"
        nodeId={node.id}
        accept="video/*"
      />
    );
  }
  if (node.type === "audio") {
    return node.metadata.content ? (
      // Reference parity: labeled audio card, not a bare centered element.
      <div className="flex h-full w-full flex-col justify-center gap-3 rounded-2xl bg-surface-2/60 px-4">
        <div className="flex min-w-0 items-center gap-2 text-sm text-text-secondary opacity-70">
          <Music2 size={16} className="shrink-0" />
          <span className="truncate">{node.title || "音频"}</span>
        </div>
        {/* biome-ignore lint/a11y/useMediaCaption: user-provided clips have no captions */}
        <audio src={node.metadata.content} controls className="w-full" />
      </div>
    ) : (
      <EmptyMediaHint
        icon={<Music2 size={28} />}
        label="空音频节点"
        nodeId={node.id}
        accept="audio/*"
      />
    );
  }
  if (node.type === "a2ui") {
    const payload = node.metadata.surfaceId
      ? getA2UIPayload(node.metadata.surfaceId)
      : null;
    if (!payload) {
      return (
        <p className="text-xs text-text-tertiary">
          内容已过期 — 从原入口（运行卡/编辑器）重新打开即可恢复。
        </p>
      );
    }
    // Stretch the surface chain to the node body height so editor surfaces
    // (XHSEditor/MarkdownEditor, height:100% + flex content) fill the node —
    // and grow when the node is resized taller. The DOM is
    // body(flex-1) → this wrapper → .a2ui-surfaces → .a2ui-surface → editor.
    return (
      <div className="h-full [&_.a2ui-surface]:h-full [&_.a2ui-surfaces]:h-full">
        <A2UIRenderer messages={payload.messages} onAction={payload.onAction} />
      </div>
    );
  }
  if (node.type === "text") {
    return <TextNodeContent node={node} />;
  }
  // image
  if (node.metadata.content) {
    return <ImageNodeContent node={node} />;
  }
  return <EmptyImageNode />;
}

/**
 * W4.2: Image content renderer.
 *
 * Subscribes to the ui-prefs store (separate subscription from NodeBody's canvas-store
 * subscription) so pref changes re-render without breaking NodeBody's metadata-identity memo.
 *
 * onLoad stores naturalWidth/Height via shouldStoreNaturalSize predicate (single write).
 * Badge is rendered when showImageInfo pref is on AND dims are present.
 *
 * Theme comment: badge styling follows app global theme (--color-*); no canvas-local theme toggle by design.
 */
function ImageNodeContent({ node }: { node: CanvasNode }) {
  const { showImageInfo } = useCanvasUiPrefs();
  const { naturalWidth, naturalHeight } = node.metadata;
  const hasDims = naturalWidth !== undefined && naturalHeight !== undefined;

  return (
    <div
      className="relative h-full w-full"
      onDoubleClick={() =>
        openCanvasDialog({ kind: "preview", nodeId: node.id })
      }
    >
      <img
        src={node.metadata.content}
        alt={node.title}
        // freeResize (unlocked ratio) stretches to fill — matching the
        // resize gesture's semantics; locked-ratio images letterbox-contain.
        className={`pointer-events-none h-full w-full select-none ${node.metadata.freeResize ? "object-fill" : "object-contain"}`}
        draggable={false}
        onLoad={(event) => {
          const img = event.currentTarget;
          const w = img.naturalWidth;
          const h = img.naturalHeight;
          if (shouldStoreNaturalSize(node.metadata, w, h)) {
            updateNode(node.id, {
              metadata: { naturalWidth: w, naturalHeight: h },
            });
          }
        }}
      />
      {showImageInfo && hasDims ? (
        <span
          data-canvas-image-info="true"
          className="pointer-events-none absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1.5 py-0.5 text-[10px] font-medium text-white"
        >
          {naturalWidth}×{naturalHeight}
        </span>
      ) : null}
    </div>
  );
}

/**
 * Empty image node (reference-parity): a quiet soft-filled placeholder —
 * icon chip + label, nothing else. Generation moved entirely to the
 * PromptPanel below the selected node (model/quality/aspect/count live
 * there); upload lives on the hover toolbar's "上传图片" button (HoverToolbar
 * in hover-toolbar.tsx), matching the reference app's node-level toolbar.
 */
function EmptyImageNode() {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-3 rounded-2xl bg-surface-2/60 text-text-tertiary">
      <div className="flex size-14 items-center justify-center rounded-2xl bg-surface-2">
        <ImagePlus size={24} className="opacity-40" />
      </div>
      <span className="text-[10px] tracking-[0.18em] opacity-70">
        空图片节点
      </span>
    </div>
  );
}
