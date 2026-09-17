import { useQuery } from "@tanstack/react-query";
import { ChevronDown, ChevronUp, X } from "lucide-react";
import { useEffect, useState } from "react";
import { getApiV1Devices } from "../../../../lib/api/sdk.gen";
import { A2UIRenderer } from "../a2ui-renderer";
import { StatusPill, type StatusTone } from "../a2ui-status";
import type { A2UIComponent, A2UIMessage } from "../a2ui-types";
import type { CustomComponentProps } from "./registry";
import {
  type RowStatus,
  type XHSPost,
  seedBatch,
  setRowStatus,
  updatePost,
  useBatch,
} from "./xhs-batch-store";
import {
  type XHSPublishResultItem,
  XhsPublishStatusUnknownError,
  publishXhsPost,
  reportXhsPublishResults,
} from "./xhs-publish";

const NEXU_CATALOG = "https://nexu.app/a2ui/custom-catalog.json";

interface SeedPost {
  id?: string;
  title?: string;
  content?: string;
  images?: string[];
  hashtags?: string[];
  deviceId?: string;
}

interface XHSBatchData {
  batchId?: string;
  posts?: SeedPost[];
}

const STATUS_LABEL: Record<RowStatus, string> = {
  idle: "待发布",
  waiting: "等待设备",
  pushing: "推图中",
  publishing: "发布中",
  success: "已发布",
  unknown: "待确认",
  error: "失败",
};
const STATUS_TONE: Record<RowStatus, StatusTone> = {
  idle: "idle",
  // 等待设备 is waiting on a queue outside this row; 待确认 is a result
  // that needs a human look. XHSEditor — which this table renders inline
  // beneath the row — maps `unknown` the same way.
  waiting: "waiting",
  pushing: "running",
  publishing: "running",
  success: "done",
  unknown: "blocked",
  error: "failed",
};

/** Build an inline XHSEditor surface bound to this batch's shared store. */
function buildEditorSurface(
  surfaceId: string,
  batchId: string,
  post: XHSPost,
): A2UIMessage[] {
  return [
    { version: "v0.9", createSurface: { surfaceId, catalogId: NEXU_CATALOG } },
    {
      version: "v0.9",
      updateComponents: {
        surfaceId,
        components: [
          {
            id: "xhs-editor",
            type: "XHSEditor",
            title: post.title,
            content: post.content,
            images: post.images,
            hashtags: post.hashtags,
            deviceId: post.deviceId,
            batchId,
            postId: post.id,
            pendingImageSlots: post.pendingImageSlots,
          } as unknown as A2UIComponent,
        ],
      },
    },
  ];
}

export function XHSBatchTable({ comp, onAction }: CustomComponentProps) {
  const data = comp as unknown as XHSBatchData;
  const batchId = data.batchId ?? "default";
  const [expandedPostId, setExpandedPostId] = useState<string | null>(null);

  const { data: devicesData } = useQuery({
    queryKey: ["devices"],
    queryFn: async () => {
      const { data: d, error } = await getApiV1Devices();
      if (error || !d) throw new Error("设备列表加载失败");
      return d;
    },
    refetchInterval: 10_000,
  });
  const devices = devicesData?.devices ?? [];

  // Seed the store once from the A2UI message.
  // biome-ignore lint/correctness/useExhaustiveDependencies: seed once per batch
  useEffect(() => {
    seedBatch(
      batchId,
      (data.posts ?? []).map((p, i) => ({
        id: p.id ?? `post-${i}`,
        title: p.title ?? "",
        content: p.content ?? "",
        images: p.images ?? [],
        hashtags: p.hashtags ?? [],
        deviceId: p.deviceId ?? "",
      })),
    );
  }, [batchId]);

  const { posts } = useBatch(batchId);

  // Round-robin device assignment for posts that don't have one yet.
  useEffect(() => {
    if (devices.length === 0) return;
    posts.forEach((p, i) => {
      if (!p.deviceId) {
        const dev = devices[i % devices.length]?.deviceId;
        if (dev) updatePost(batchId, p.id, { deviceId: dev });
      }
    });
  }, [devices, posts, batchId]);

  const expandedPost = posts.find((post) => post.id === expandedPostId) ?? null;

  const toggleEditor = (post: XHSPost) => {
    setExpandedPostId((current) => (current === post.id ? null : post.id));
  };

  const publishOne = async (post: XHSPost): Promise<XHSPublishResultItem> => {
    try {
      await publishXhsPost(
        post.deviceId,
        {
          title: post.title,
          content: post.content,
          images: post.images,
          hashtags: post.hashtags,
        },
        (phase) => setRowStatus(batchId, post.id, phase),
      );
      setRowStatus(batchId, post.id, "success");
      return {
        postId: post.id,
        title: post.title,
        deviceId: post.deviceId,
        status: "success",
        message: "手机端已完成发布",
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "发布失败";
      if (err instanceof XhsPublishStatusUnknownError) {
        setRowStatus(batchId, post.id, "unknown", message);
        return {
          postId: post.id,
          title: post.title,
          deviceId: post.deviceId,
          status: "unknown",
          message,
        };
      }
      setRowStatus(batchId, post.id, "error", message);
      return {
        postId: post.id,
        title: post.title,
        deviceId: post.deviceId,
        status: "error",
        message,
      };
    }
  };

  const publishAll = async () => {
    // Posts on the SAME phone must publish serially: the device rejects a second
    // task while busy, and each post pushes its images then picks "the latest N"
    // from the gallery — running them concurrently would collide on both. Posts
    // on DIFFERENT phones run in parallel.
    const byDevice = new Map<string, XHSPost[]>();
    const preflightResults: XHSPublishResultItem[] = [];
    for (const post of posts) {
      if (
        post.status === "success" ||
        post.status === "unknown" ||
        post.status === "waiting" ||
        post.status === "pushing" ||
        post.status === "publishing"
      ) {
        continue;
      }
      if (!post.deviceId) {
        const message = "未分配在线设备";
        setRowStatus(batchId, post.id, "error", message);
        preflightResults.push({
          postId: post.id,
          title: post.title,
          deviceId: "",
          status: "error",
          message,
        });
        continue;
      }
      const group = byDevice.get(post.deviceId) ?? [];
      group.push(post);
      byDevice.set(post.deviceId, group);
    }

    const deviceResults = await Promise.all(
      [...byDevice.values()].map(async (group) => {
        const results: XHSPublishResultItem[] = [];
        for (const post of group) {
          const result = await publishOne(post);
          results.push(result);
          if (result.status === "unknown") break;
        }
        return results;
      }),
    );
    reportXhsPublishResults(onAction, {
      source: "batch",
      batchId,
      results: [...preflightResults, ...deviceResults.flat()],
    });
  };

  const batchPublishing = posts.some(
    (post) =>
      post.status === "waiting" ||
      post.status === "pushing" ||
      post.status === "publishing",
  );
  const hasPublishablePosts = posts.some(
    (post) => post.status === "idle" || post.status === "error",
  );

  return (
    <div
      style={{
        width: "100%",
        maxWidth: 720,
        border: "0.5px solid var(--color-border)",
        borderRadius: 12,
        background: "var(--color-surface-1, #fff)",
        overflow: "hidden",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "14px 20px",
          borderBottom: "1px solid var(--color-border-subtle)",
        }}
      >
        <div style={{ minWidth: 0 }}>
          <div
            style={{
              fontSize: 15,
              fontWeight: 600,
              lineHeight: 1.4,
              color: "var(--color-text-heading)",
            }}
          >
            批量发布
          </div>
          <div
            style={{
              marginTop: 4,
              fontSize: 12,
              lineHeight: 1.5,
              color: "var(--color-text-secondary)",
            }}
          >
            {posts.length} 篇
          </div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
          <button
            type="button"
            onClick={() => {
              void publishAll();
            }}
            disabled={
              posts.length === 0 || batchPublishing || !hasPublishablePosts
            }
            style={{
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              height: 36,
              padding: "0 20px",
              borderRadius: 8,
              border: "none",
              background: "var(--color-xhs)",
              color: "#fff",
              fontSize: 13,
              fontWeight: 600,
              whiteSpace: "nowrap",
              cursor: batchPublishing ? "not-allowed" : "pointer",
            }}
          >
            {batchPublishing ? "发布中…" : "全部发布"}
          </button>
        </div>
      </div>

      {/* Fixed height — shows ~5 rows, scrolls beyond. */}
      <div style={{ maxHeight: 5 * 64, overflowY: "auto" }}>
        {posts.map((post) => (
          <div
            key={post.id}
            // biome-ignore lint/a11y/useSemanticElements: row contains a <select>, so it cannot be a <button> element; role+keydown gives equivalent semantics
            role="button"
            tabIndex={0}
            onClick={() => toggleEditor(post)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return;
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                toggleEditor(post);
              }
            }}
            style={{
              display: "grid",
              gridTemplateColumns:
                "44px minmax(0, 1fr) minmax(0, 1.4fr) minmax(90px, 1fr) auto 18px",
              gap: 10,
              alignItems: "center",
              width: "100%",
              textAlign: "left",
              padding: "10px 14px",
              borderBottom: "0.5px solid var(--color-border-subtle, #eee)",
              background: "transparent",
              cursor: "pointer",
              height: 64,
            }}
          >
            <div
              style={{
                width: 40,
                height: 40,
                borderRadius: 8,
                background: "var(--color-surface-2, #f5f5f5)",
                overflow: "hidden",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#bbb",
                fontSize: 11,
              }}
            >
              {post.images[0] ? (
                <img
                  src={post.images[0]}
                  alt=""
                  style={{ width: "100%", height: "100%", objectFit: "cover" }}
                />
              ) : (
                "无图"
              )}
            </div>
            <span
              title={post.errorMessage}
              style={{
                fontSize: 13,
                fontWeight: 500,
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {post.title || "（未填标题）"}
            </span>
            <span
              style={{
                fontSize: 12,
                color: "var(--color-text-secondary, #666)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {post.content || "（未填正文）"}
            </span>
            <select
              value={
                devices.some((d) => d.deviceId === post.deviceId)
                  ? post.deviceId
                  : ""
              }
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => e.stopPropagation()}
              onChange={(e) => {
                e.stopPropagation();
                updatePost(batchId, post.id, { deviceId: e.target.value });
              }}
              style={{
                fontSize: 12,
                padding: "3px 6px",
                maxWidth: "100%",
                borderRadius: 6,
                border: "0.5px solid var(--color-border)",
                background: "var(--color-surface-1, #fff)",
                color: "var(--color-text-secondary, #666)",
                cursor: "pointer",
              }}
            >
              {!devices.some((d) => d.deviceId === post.deviceId) && (
                <option value="">未分配</option>
              )}
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.name || d.deviceId}
                </option>
              ))}
            </select>
            <StatusPill tone={STATUS_TONE[post.status]}>
              {STATUS_LABEL[post.status]}
            </StatusPill>
            {expandedPostId === post.id ? (
              <ChevronUp size={15} aria-hidden="true" />
            ) : (
              <ChevronDown size={15} aria-hidden="true" />
            )}
          </div>
        ))}
      </div>

      {expandedPost ? (
        <div
          style={{
            position: "relative",
            borderTop: "0.5px solid var(--color-border)",
          }}
        >
          <button
            type="button"
            aria-label="收起编辑器"
            onClick={() => setExpandedPostId(null)}
            style={{
              position: "absolute",
              zIndex: 2,
              top: 10,
              right: 12,
              width: 28,
              height: 28,
              display: "grid",
              placeItems: "center",
              borderRadius: 7,
              border: "0.5px solid var(--color-border)",
              color: "var(--color-text-secondary)",
              background: "var(--color-surface-1)",
              cursor: "pointer",
            }}
          >
            <X size={14} />
          </button>
          <A2UIRenderer
            messages={buildEditorSurface(
              `xhs-editor-inline-${batchId}-${expandedPost.id}`,
              batchId,
              expandedPost,
            )}
            onAction={onAction}
          />
        </div>
      ) : null}
    </div>
  );
}
