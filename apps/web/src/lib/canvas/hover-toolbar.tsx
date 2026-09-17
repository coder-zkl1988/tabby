/**
 * hover-toolbar.tsx — per-node floating action pill (W3.1).
 *
 * Rendered inside CanvasNodeView (world-space, moves with the node).
 * Positioned absolutely above the frame. Visibility driven by the node's
 * group hover class; always visible when selected.
 *
 * Base tools: info / download / replace / lock / delete.
 * Later W3 tasks (crop/split/upscale/mask/angle) extend this component.
 */

import {
  AArrowDown,
  AArrowUp,
  Bookmark,
  Brush,
  Crop,
  Download,
  FileText,
  Grid3x3,
  ImagePlus,
  Info,
  Lock,
  Maximize2,
  MoreHorizontal,
  RefreshCw,
  Rotate3d,
  Trash2,
  Unlock,
  Upload,
  ZoomIn,
} from "lucide-react";
import { Children, useState } from "react";
import { toast } from "sonner";
import { saveNodeAsAsset } from "./canvas-assets";
import { openCanvasDialog } from "./canvas-dialogs";
import { describeImageSource } from "./canvas-generation";
import { readFilesAsDataUrls } from "./canvas-ingest";
import {
  type CanvasNode,
  removeNodes,
  setNodeTask,
  updateNode,
} from "./canvas-store";
import { servableSourceOf } from "./prompt-panel-utils";
import { nextFontSize, textNodeToImage } from "./text-node-utils";

// ── Helpers ─────────────────────────────────────────────────────

const MEDIA_TYPES = new Set(["image", "video", "audio"]);
const CONTENT_MEDIA_TYPES = new Set(["image", "video"]);
const ASSET_TYPES = new Set(["text", "image", "video", "audio"]);

/** Return a sane default extension for a media node title without a dot. */
function defaultExtension(type: string): string {
  if (type === "video") return "mp4";
  if (type === "audio") return "mp3";
  return "png";
}

/** Trigger a browser download for a data URL / servable URL. */
function triggerDownload(url: string, filename: string): void {
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

// ── Component ───────────────────────────────────────────────────

export function HoverToolbar({
  node,
  selected,
}: {
  node: CanvasNode;
  selected: boolean;
}) {
  const [describePending, setDescribePending] = useState(false);

  // Rich editors/previews, team-step and group nodes keep minimal chrome — no
  // generic media toolbar (groups are inert containers).
  if (
    node.type === "a2ui" ||
    node.type === "team-step" ||
    node.type === "xhs" ||
    node.type === "phone" ||
    node.type === "group"
  ) {
    return null;
  }

  const { id, title, type, size, metadata } = node;
  const { width, height } = size;
  const hasContent = Boolean(metadata.content);
  const isMedia = MEDIA_TYPES.has(type);
  const isContentMedia = CONTENT_MEDIA_TYPES.has(type) && hasContent;

  // Servable gate: all four T6 features require a servable backend path
  const servablePath = servableSourceOf(node);

  return (
    <ToolbarPill nodeId={id} selected={selected}>
      {/* Direct: the five things done to nearly every node, in the
          order they are actually reached. */}
      {/* preview — image WITH content only: opens the full-size lightbox */}
      {type === "image" && hasContent ? (
        <ToolbarButton
          actionKey="preview"
          label="放大预览"
          title="放大预览"
          onClick={() => {
            openCanvasDialog({ kind: "preview", nodeId: id });
          }}
        >
          <Maximize2 size={13} />
        </ToolbarButton>
      ) : null}
      {/* upload/replace — image/video/audio regardless of content.
          Empty image nodes read "上传图片" (reference parity, matches the
          node's own empty-state hint); everything else reads "替换素材". */}
      {isMedia ? (
        <ReplaceButton
          node={node}
          isEmptyImage={type === "image" && !hasContent}
        />
      ) : null}
      {/* crop — image WITH content only */}
      {type === "image" && hasContent ? (
        <ToolbarButton
          actionKey="crop"
          label="裁剪图片"
          title="裁剪图片"
          onClick={() => {
            openCanvasDialog({ kind: "crop", nodeId: id });
          }}
        >
          <Crop size={13} />
        </ToolbarButton>
      ) : null}
      {/* download — only when content present AND type in image/video/audio */}
      {hasContent && isMedia ? (
        <ToolbarButton
          actionKey="download"
          label="下载"
          title="下载"
          onClick={() => {
            const url = metadata.content as string;
            const hasDot = title.includes(".");
            const filename = hasDot
              ? title
              : `${title}.${defaultExtension(type)}`;
            triggerDownload(url, filename);
          }}
        >
          <Download size={13} />
        </ToolbarButton>
      ) : null}
      {/* save-asset — text/image/video/audio WITH non-empty content */}
      {ASSET_TYPES.has(type) && (metadata.content ?? "").trim() ? (
        <ToolbarButton
          actionKey="save-asset"
          label="存为素材"
          title="存为素材"
          onClick={() => {
            void saveNodeAsAsset(id).then((ok) =>
              ok ? toast.success("已存为素材") : toast.error("无法保存"),
            );
          }}
        >
          <Bookmark size={13} />
        </ToolbarButton>
      ) : null}

      {/* Everything below is a once-in-ten-nodes action; behind ⋯ so
          the common five keep a 28px target instead of 21px. */}
      <ToolbarOverflow>
        {/* info — ALL types */}
        <ToolbarButton
          actionKey="info"
          label="节点信息"
          title="节点信息"
          onClick={() => {
            toast.info(
              `${title} · ${type} · ${Math.round(width)}×${Math.round(height)}`,
            );
          }}
        >
          <Info size={13} />
        </ToolbarButton>
        {/* lock — image/video WITH content */}
        {isContentMedia ? (
          <ToolbarButton
            actionKey="lock"
            label="toggle aspect ratio lock"
            title={metadata.freeResize ? "锁定比例" : "解锁比例"}
            data-canvas-lock-toggle={id}
            onClick={() => {
              updateNode(id, {
                metadata: { freeResize: !metadata.freeResize },
              });
            }}
          >
            {metadata.freeResize ? <Unlock size={13} /> : <Lock size={13} />}
          </ToolbarButton>
        ) : null}
        {/* split — image WITH content only */}
        {type === "image" && hasContent ? (
          <ToolbarButton
            actionKey="split"
            label="拆分图片"
            title="拆分图片"
            onClick={() => {
              openCanvasDialog({ kind: "split", nodeId: id });
            }}
          >
            <Grid3x3 size={13} />
          </ToolbarButton>
        ) : null}
        {/* upscale — image WITH content only */}
        {type === "image" && hasContent ? (
          <ToolbarButton
            actionKey="upscale"
            label="放大图片"
            title="放大图片"
            onClick={() => {
              openCanvasDialog({ kind: "upscale", nodeId: id });
            }}
          >
            <ZoomIn size={13} />
          </ToolbarButton>
        ) : null}
        {/* mask (重绘) — image WITH servable content only */}
        {servablePath ? (
          <ToolbarButton
            actionKey="mask"
            label="重绘选区"
            title="重绘选区"
            onClick={() => {
              openCanvasDialog({ kind: "mask", nodeId: id });
            }}
          >
            <Brush size={13} />
          </ToolbarButton>
        ) : null}
        {/* angle (视角) — image WITH servable content only */}
        {servablePath ? (
          <ToolbarButton
            actionKey="angle"
            label="生成新视角"
            title="生成新视角"
            onClick={() => {
              openCanvasDialog({ kind: "angle", nodeId: id });
            }}
          >
            <Rotate3d size={13} />
          </ToolbarButton>
        ) : null}
        {/* describe (反推提示词) — image WITH servable content only */}
        {servablePath ? (
          <ToolbarButton
            actionKey="describe"
            label="反推提示词"
            title="反推提示词"
            disabled={describePending}
            onClick={() => {
              if (!servablePath || describePending) return;
              setDescribePending(true);
              void describeImageSource(servablePath).then((prompt) => {
                setDescribePending(false);
                if (prompt === null) {
                  toast.error("反推失败（后端未配置或不可用）");
                } else {
                  navigator.clipboard
                    .writeText(prompt)
                    .then(() => {
                      toast.success("提示词已复制");
                    })
                    .catch(() => {
                      toast.error("复制失败");
                    });
                }
              });
            }}
          >
            <FileText size={13} />
          </ToolbarButton>
        ) : null}
        {/* font-inc — text nodes only */}
        {type === "text" ? (
          <ToolbarButton
            actionKey="font-inc"
            label="字号+"
            title="字号+"
            onClick={() => {
              updateNode(id, {
                metadata: { fontSize: nextFontSize(metadata.fontSize, 1) },
              });
            }}
          >
            <AArrowUp size={13} />
          </ToolbarButton>
        ) : null}
        {/* font-dec — text nodes only */}
        {type === "text" ? (
          <ToolbarButton
            actionKey="font-dec"
            label="字号-"
            title="字号-"
            onClick={() => {
              updateNode(id, {
                metadata: { fontSize: nextFontSize(metadata.fontSize, -1) },
              });
            }}
          >
            <AArrowDown size={13} />
          </ToolbarButton>
        ) : null}
        {/* to-image — text nodes with non-empty content only */}
        {type === "text" && (metadata.content ?? "").trim() ? (
          <ToolbarButton
            actionKey="to-image"
            label="转图片"
            title="转图片"
            onClick={() => {
              if (textNodeToImage(id)) {
                toast.success("已创建生成节点");
              }
            }}
          >
            <ImagePlus size={13} />
          </ToolbarButton>
        ) : null}
      </ToolbarOverflow>

      {/* Delete is separated: it used to sit flush against 下载. */}
      <ToolbarDivider />
      {/* delete — ALL types */}
      <ToolbarButton
        actionKey="delete"
        label="删除节点"
        title="删除节点"
        className="text-[var(--color-error-ink)]"
        onClick={() => {
          removeNodes([id]);
        }}
      >
        <Trash2 size={13} />
      </ToolbarButton>
    </ToolbarPill>
  );
}

// ── Sub-components ───────────────────────────────────────────────

function ToolbarPill({
  nodeId,
  selected,
  children,
}: {
  nodeId: string;
  selected: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      data-canvas-hover-toolbar={nodeId}
      className={`absolute -top-12 left-1/2 z-40 -translate-x-1/2 flex items-center gap-0.5 rounded-lg border border-border bg-surface-1/95 px-1 py-0.5 shadow-md backdrop-blur transition-opacity duration-150 ${selected ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0 group-hover:pointer-events-auto group-hover:opacity-100"}`}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {children}
    </div>
  );
}

/** Hairline separator — keeps 删除 from sitting flush against 下载. */
function ToolbarDivider() {
  return <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />;
}

/**
 * "⋯" overflow. Collapses the long tail of per-node actions so the common
 * few keep a full-size target; renders nothing when every child of the tail
 * is conditioned out for this node type.
 */
function ToolbarOverflow({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const items = Children.toArray(children).filter(Boolean);
  if (items.length === 0) return null;

  return (
    <span className="relative">
      <button
        type="button"
        data-canvas-hover-action="more"
        aria-label="更多操作"
        aria-expanded={open}
        title="更多操作"
        onPointerDown={(event) => event.stopPropagation()}
        onClick={() => setOpen((v) => !v)}
        className={`grid size-7 shrink-0 place-items-center rounded-md hover:bg-surface-2 ${
          open ? "bg-surface-2 text-text-primary" : ""
        }`}
      >
        <MoreHorizontal size={13} />
      </button>
      {/* Click-away: the toolbar lives in world space, so a fixed overlay
          is the only reliable outside-click surface. */}
      {open ? (
        <span
          aria-hidden
          className="fixed inset-0 z-40"
          onPointerDown={(event) => {
            event.stopPropagation();
            setOpen(false);
          }}
        />
      ) : null}
      {/* Kept mounted and hidden rather than unmounted: which actions a node
          type offers is an invariant the toolbar tests assert on the rendered
          markup, and the point of the overflow is the hit target and the
          visual declutter, not the node count. */}
      {/* biome-ignore lint/a11y/useKeyWithClickEvents: not interactive
          itself — it closes on clicks bubbling from its buttons, which
          keyboard activation already fires. */}
      <span
        hidden={!open}
        data-canvas-hover-overflow="true"
        className="absolute top-8 right-0 z-50 flex w-max max-w-[220px] flex-wrap items-center gap-0.5 rounded-lg border border-border bg-surface-1 p-1 shadow-md"
        onClick={() => setOpen(false)}
      >
        {items}
      </span>
    </span>
  );
}

function ToolbarButton({
  actionKey,
  label,
  title,
  onClick,
  className,
  disabled,
  "data-canvas-lock-toggle": lockToggle,
  children,
}: {
  actionKey: string;
  label: string;
  title: string;
  onClick: () => void;
  className?: string;
  disabled?: boolean;
  "data-canvas-lock-toggle"?: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      data-canvas-hover-action={actionKey}
      {...(lockToggle !== undefined
        ? { "data-canvas-lock-toggle": lockToggle }
        : {})}
      aria-label={label}
      title={title}
      disabled={disabled}
      onClick={onClick}
      onPointerDown={(event) => event.stopPropagation()}
      className={`grid size-7 shrink-0 place-items-center rounded-md hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-50 ${className ?? ""}`}
    >
      {children}
    </button>
  );
}

function ReplaceButton({
  node,
  isEmptyImage,
}: {
  node: CanvasNode;
  isEmptyImage: boolean;
}) {
  const accept =
    node.type === "video"
      ? "video/*"
      : node.type === "audio"
        ? "audio/*"
        : "image/*";
  const label = isEmptyImage ? "上传图片" : "替换素材";

  return (
    <label
      data-canvas-hover-action={isEmptyImage ? "upload" : "replace"}
      aria-label={label}
      title={label}
      className="cursor-pointer rounded p-1 hover:bg-surface-2"
      onPointerDown={(event) => event.stopPropagation()}
    >
      {isEmptyImage ? <Upload size={13} /> : <RefreshCw size={13} />}
      <input
        type="file"
        accept={accept}
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files ?? []);
          if (files.length === 0) return;
          void readFilesAsDataUrls(files).then((inputs) => {
            const first = inputs[0];
            if (!first) return;
            updateNode(node.id, {
              title: first.name,
              metadata: { content: first.dataUrl, mimeType: first.type },
            });
            // Clear stale error task overlay when replacing content.
            setNodeTask(node.id, null);
          });
          // Reset so the same file can be re-selected.
          event.target.value = "";
        }}
      />
    </label>
  );
}
