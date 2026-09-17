import {
  XhsPublishStatusUnknownError,
  publishXhsPost,
} from "@/lib/a2ui/custom-components/xhs-publish";
import { isImeComposing } from "@/lib/keyboard";
import { ImagePlus, Loader2, Send, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import {
  type CanvasConnection,
  type CanvasNode,
  type CanvasXhsPost,
  removeConnection,
  updateNode,
  useCanvas,
} from "./canvas-store";
import { generateXhsCopy } from "./xhs-copy-generation";

const EMPTY_POST: CanvasXhsPost = {
  title: "",
  content: "",
  images: [],
  hashtags: [],
};

function readFiles(files: FileList | null): Promise<string[]> {
  if (!files) return Promise.resolve([]);
  return Promise.all(
    Array.from(files).map(
      (file) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () =>
            typeof reader.result === "string"
              ? resolve(reader.result)
              : reject(new Error("图片读取失败"));
          reader.onerror = () => reject(new Error("图片读取失败"));
          reader.readAsDataURL(file);
        }),
    ),
  );
}

export function connectedImageConnectionIds(
  nodes: readonly Pick<CanvasNode, "id" | "type" | "metadata">[],
  connections: readonly CanvasConnection[],
  xhsNodeId: string,
  image: string,
): string[] {
  const sourceNodeIds = new Set(
    nodes
      .filter(
        (candidate) =>
          candidate.type === "image" && candidate.metadata.content === image,
      )
      .map((candidate) => candidate.id),
  );
  return connections
    .filter(
      (connection) =>
        connection.toNodeId === xhsNodeId &&
        sourceNodeIds.has(connection.fromNodeId),
    )
    .map((connection) => connection.id);
}

export function connectedPhoneDeviceId(
  nodes: readonly Pick<CanvasNode, "id" | "type" | "metadata">[],
  connections: readonly CanvasConnection[],
  xhsNodeId: string,
): string | null {
  const connectedNodeIds = new Set<string>();
  for (const connection of connections) {
    if (connection.fromNodeId === xhsNodeId) {
      connectedNodeIds.add(connection.toNodeId);
    } else if (connection.toNodeId === xhsNodeId) {
      connectedNodeIds.add(connection.fromNodeId);
    }
  }
  for (const candidate of nodes) {
    if (candidate.type !== "phone" || !connectedNodeIds.has(candidate.id)) {
      continue;
    }
    const deviceId = candidate.metadata.phone?.deviceId?.trim();
    if (deviceId) return deviceId;
  }
  return null;
}

export function XhsNodeContent({ node }: { node: CanvasNode }) {
  const post = node.metadata.xhs ?? EMPTY_POST;
  const { nodes, connections } = useCanvas();
  const [tagDraft, setTagDraft] = useState("");
  const [copyPending, setCopyPending] = useState(false);
  const [publishPending, setPublishPending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const publishDeviceId = connectedPhoneDeviceId(nodes, connections, node.id);

  const patchPost = (patch: Partial<CanvasXhsPost>) => {
    updateNode(node.id, {
      metadata: { xhs: { ...post, ...patch } },
    });
  };

  // Keep the node subscribed to upstream image results. This covers both
  // connect-after-generation and connect-before-generation workflows.
  useEffect(() => {
    const sourceIds = new Set(
      connections
        .filter((connection) => connection.toNodeId === node.id)
        .map((connection) => connection.fromNodeId),
    );
    const incomingImages = nodes
      .filter(
        (candidate) =>
          candidate.type === "image" && sourceIds.has(candidate.id),
      )
      .map((candidate) => candidate.metadata.content)
      .filter((content): content is string => Boolean(content));
    const missing = incomingImages.filter(
      (image) => !post.images.includes(image),
    );
    if (missing.length === 0) return;
    updateNode(node.id, {
      metadata: {
        xhs: { ...post, images: [...post.images, ...missing] },
      },
    });
  }, [connections, node.id, nodes, post]);

  const addTag = () => {
    const tag = tagDraft.trim().replace(/^#+/, "");
    if (tag && !post.hashtags.includes(tag)) {
      patchPost({ hashtags: [...post.hashtags, tag] });
    }
    setTagDraft("");
  };

  const handleCopyGeneration = async () => {
    if (!post.theme?.trim() || copyPending) return;
    setCopyPending(true);
    try {
      const generated = await generateXhsCopy(post.theme, {
        title: post.title,
        content: post.content,
        hashtags: post.hashtags,
      });
      patchPost(generated);
      toast.success("标题、正文和话题已填充");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI 文案生成失败");
    } finally {
      setCopyPending(false);
    }
  };

  const removeImage = (image: string) => {
    for (const connectionId of connectedImageConnectionIds(
      nodes,
      connections,
      node.id,
      image,
    )) {
      removeConnection(connectionId);
    }
    patchPost({ images: post.images.filter((item) => item !== image) });
  };

  const handlePublish = async () => {
    if (!publishDeviceId) {
      toast.error("请先连接已选择设备的手机节点");
      return;
    }
    if (publishPending) return;
    setPublishPending(true);
    try {
      await publishXhsPost(publishDeviceId, post);
      toast.success("手机端已完成发布");
    } catch (error) {
      const message = error instanceof Error ? error.message : "发布失败";
      if (error instanceof XhsPublishStatusUnknownError) {
        toast.warning(message);
      } else {
        toast.error(message);
      }
    } finally {
      setPublishPending(false);
    }
  };

  return (
    <div
      data-canvas-xhs-node={node.id}
      data-canvas-wheel-exempt="true"
      className="flex h-full w-full flex-col overflow-hidden bg-surface-1 text-text-primary"
    >
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-4 py-3">
        <span className="grid size-8 place-items-center rounded-lg bg-[var(--color-xhs-wash)] text-[var(--color-xhs)]">
          <Sparkles size={16} />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">小红书帖子</p>
          <p className="text-[11px] text-text-muted">画布专用编辑器</p>
        </div>
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        <div className="flex shrink-0 gap-2 border-b border-border px-4 py-3">
          <input
            value={post.theme ?? ""}
            onChange={(event) => patchPost({ theme: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !isImeComposing(event)) {
                event.preventDefault();
                void handleCopyGeneration();
              }
            }}
            placeholder="输入主题，让 AI 填写整篇文案"
            className="h-9 min-w-0 flex-1 rounded-lg border border-border bg-surface-0 px-3 text-xs outline-none focus:border-[var(--color-xhs)]"
          />
          <button
            type="button"
            onClick={() => void handleCopyGeneration()}
            disabled={copyPending || !post.theme?.trim()}
            className="flex h-9 shrink-0 items-center gap-1.5 rounded-lg bg-[var(--color-xhs)] px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
          >
            {copyPending ? (
              <Loader2 size={14} className="animate-spin" />
            ) : (
              <Sparkles size={14} />
            )}
            AI 填充
          </button>
        </div>

        <div className="shrink-0 px-4 pt-3">
          <div className="grid grid-cols-4 gap-2">
            {post.images.map((image) => (
              <div
                key={image}
                className="group/image relative aspect-square overflow-hidden rounded-lg bg-surface-2"
              >
                <img
                  src={image}
                  alt=""
                  className="h-full w-full object-cover"
                />
                <button
                  type="button"
                  aria-label="移除图片"
                  onClick={() => removeImage(image)}
                  className="absolute right-1 top-1 grid size-5 place-items-center rounded-full bg-black/55 text-white opacity-0 transition-opacity group-hover/image:opacity-100"
                >
                  <X size={11} />
                </button>
              </div>
            ))}
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              className="flex aspect-square flex-col items-center justify-center gap-1 rounded-lg border border-dashed border-border bg-surface-2/50 text-[10px] text-text-muted hover:text-text-secondary"
            >
              <ImagePlus size={17} />
              添加图片
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/*"
              className="hidden"
              onChange={(event) => {
                const input = event.currentTarget;
                void readFiles(input.files)
                  .then((images) => {
                    patchPost({
                      images: [...new Set([...post.images, ...images])],
                    });
                  })
                  .catch(() => toast.error("图片读取失败"));
                input.value = "";
              }}
            />
          </div>
          <p className="mt-1.5 text-[10px] text-text-muted">
            可上传图片，或把图片节点连接到此节点。
          </p>
        </div>

        <div className="shrink-0 px-4 pt-3">
          <div className="relative">
            <input
              value={post.title}
              maxLength={20}
              onChange={(event) => patchPost({ title: event.target.value })}
              placeholder="填写标题"
              className="h-10 w-full rounded-lg border border-border bg-surface-0 px-3 pr-12 text-sm font-medium outline-none focus:border-[var(--color-xhs)]"
            />
            <span className="absolute right-3 top-1/2 -translate-y-1/2 text-[10px] text-text-muted">
              {post.title.length}/20
            </span>
          </div>
        </div>

        <div className="flex min-h-[120px] flex-1 px-4 pt-2">
          <textarea
            value={post.content}
            onChange={(event) => patchPost({ content: event.target.value })}
            placeholder="写下帖子正文..."
            className="h-full min-h-[120px] w-full resize-none rounded-lg border border-border bg-surface-0 px-3 py-2 text-sm leading-6 outline-none focus:border-[var(--color-xhs)]"
          />
        </div>

        <div className="shrink-0 px-4 py-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {post.hashtags.map((tag) => (
              <button
                key={tag}
                type="button"
                title="点击移除"
                onClick={() =>
                  patchPost({
                    hashtags: post.hashtags.filter((item) => item !== tag),
                  })
                }
                className="rounded-md bg-[var(--color-xhs-wash)] px-2.5 py-1 text-[12px] text-[var(--color-xhs)]"
              >
                #{tag}
              </button>
            ))}
            <input
              value={tagDraft}
              onChange={(event) => setTagDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter" && !isImeComposing(event)) {
                  event.preventDefault();
                  addTag();
                }
              }}
              onBlur={addTag}
              placeholder="添加话题"
              className="h-7 w-24 rounded-full border border-border bg-surface-0 px-2 text-[11px] outline-none"
            />
          </div>
        </div>
      </div>

      <div className="flex shrink-0 justify-end border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={() => void handlePublish()}
          disabled={publishPending || !publishDeviceId}
          className="flex h-9 items-center gap-1.5 rounded-lg bg-[var(--color-xhs)] px-3 text-xs font-medium text-white disabled:cursor-not-allowed disabled:opacity-45"
        >
          {publishPending ? (
            <Loader2 size={14} className="animate-spin" />
          ) : (
            <Send size={14} />
          )}
          {publishPending ? "发布中" : "发布"}
        </button>
      </div>
    </div>
  );
}
