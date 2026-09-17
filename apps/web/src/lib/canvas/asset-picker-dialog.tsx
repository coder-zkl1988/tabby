/**
 * asset-picker-dialog.tsx — the 素材库 picker (W4.3).
 *
 * radix Dialog wired into the CanvasDialogs mount switch as { kind: "assets" }.
 * Kind tabs / search / pagination (8 per page) / insert (stays open for
 * multi-insert) / delete. Hydrates assets on open.
 */

import {
  AudioLines,
  Clapperboard,
  Plus,
  Tag,
  Trash2,
  Upload,
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import {
  type CanvasAsset,
  addAsset,
  collectAssetTags,
  ensureAssetsLoaded,
  filterAssets,
  insertAssetToCanvas,
  paginateAssets,
  removeAsset,
  updateAssetTags,
  useCanvasAssets,
} from "./canvas-assets";
import { closeCanvasDialog } from "./canvas-dialogs";
import { mediaTypeForMime, readFilesAsDataUrls } from "./canvas-ingest";
import { CanvasModal } from "./canvas-modal";

const KIND_TABS: ReadonlyArray<{
  value: CanvasAsset["kind"] | "all";
  label: string;
}> = [
  { value: "all", label: "全部" },
  { value: "text", label: "文本" },
  { value: "image", label: "图片" },
  { value: "video", label: "视频" },
  { value: "audio", label: "音频" },
];

export function AssetPickerDialog() {
  const { assets } = useCanvasAssets();
  const [kind, setKind] = useState<CanvasAsset["kind"] | "all">("all");
  const [query, setQuery] = useState("");
  const [tagFilter, setTagFilter] = useState<string | null>(null);
  const [page, setPage] = useState(1);

  useEffect(() => {
    void ensureAssetsLoaded();
  }, []);

  const allTags = useMemo(() => collectAssetTags(assets), [assets]);
  const filtered = useMemo(
    () => filterAssets(assets, kind, query, tagFilter),
    [assets, kind, query, tagFilter],
  );
  const {
    pageItems,
    page: currentPage,
    pageCount,
  } = paginateAssets(filtered, page);

  return (
    <CanvasModal title="素材库" maxWidth={720} onClose={closeCanvasDialog}>
      <div
        data-canvas-asset-picker="true"
        className="flex flex-col gap-3 px-6 pb-6"
      >
        {/* Kind tabs */}
        <div className="flex items-center gap-1">
          {KIND_TABS.map((tab) => (
            <button
              key={tab.value}
              type="button"
              data-asset-kind-tab={tab.value}
              onClick={() => {
                setKind(tab.value);
                setPage(1);
              }}
              className={`rounded px-2.5 py-1 text-xs border ${
                kind === tab.value
                  ? "border-[var(--color-brand-primary)] text-[var(--color-brand-ink)] bg-[var(--color-brand-subtle)]"
                  : "border-border text-text-secondary hover:bg-surface-2"
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>

        {/* Search + upload */}
        <div className="flex items-center gap-2">
          <input
            type="text"
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setPage(1);
            }}
            placeholder="搜索素材…"
            className="min-w-0 flex-1 rounded-lg border border-border bg-surface-1 px-3 py-1.5 text-sm outline-none focus:border-[var(--color-brand-primary)]"
          />
          <label
            aria-label="上传素材"
            title="上传素材"
            data-asset-upload="true"
            className="flex shrink-0 cursor-pointer items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-xs text-text-secondary hover:bg-surface-2 hover:text-text-primary"
          >
            <Upload size={13} />
            上传
            <input
              type="file"
              multiple
              accept="image/*,video/*,audio/*"
              className="hidden"
              onChange={(event) => {
                const files = Array.from(event.target.files ?? []);
                event.target.value = "";
                if (files.length === 0) return;
                void readFilesAsDataUrls(files).then((inputs) => {
                  for (const input of inputs) {
                    const uploadKind = mediaTypeForMime(input.type);
                    if (!uploadKind) continue;
                    void addAsset({
                      kind: uploadKind,
                      title: input.name.replace(/\.[^.]+$/, ""),
                      content: input.dataUrl,
                      mimeType: input.type,
                    });
                  }
                });
              }}
            />
          </label>
        </div>

        {/* Tag filter chips (only when any asset carries tags) */}
        {allTags.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <button
              type="button"
              data-asset-tag-filter="all"
              onClick={() => {
                setTagFilter(null);
                setPage(1);
              }}
              className={`rounded-full px-2 py-0.5 text-[11px] border ${
                tagFilter === null
                  ? "border-[var(--color-brand-primary)] text-[var(--color-brand-ink)] bg-[var(--color-brand-subtle)]"
                  : "border-border text-text-secondary hover:bg-surface-2"
              }`}
            >
              全部标签
            </button>
            {allTags.map((tag) => (
              <button
                key={tag}
                type="button"
                data-asset-tag-filter={tag}
                onClick={() => {
                  setTagFilter((prev) => (prev === tag ? null : tag));
                  setPage(1);
                }}
                className={`rounded-full px-2 py-0.5 text-[11px] border ${
                  tagFilter === tag
                    ? "border-[var(--color-brand-primary)] text-[var(--color-brand-ink)] bg-[var(--color-brand-subtle)]"
                    : "border-border text-text-secondary hover:bg-surface-2"
                }`}
              >
                {tag}
              </button>
            ))}
          </div>
        ) : null}

        {/* Grid */}
        {pageItems.length === 0 ? (
          <div className="flex h-40 items-center justify-center text-sm text-text-secondary">
            {assets.length === 0 ? "无素材" : "无匹配"}
          </div>
        ) : (
          <div className="grid grid-cols-4 gap-3">
            {pageItems.map((asset) => (
              <AssetCard key={asset.id} asset={asset} />
            ))}
          </div>
        )}

        {/* Pagination */}
        <div className="flex items-center justify-center gap-3 text-xs text-text-secondary">
          <button
            type="button"
            data-asset-prev="true"
            disabled={currentPage <= 1}
            onClick={() => setPage((p) => p - 1)}
            className="rounded border border-border px-2 py-1 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            上一页
          </button>
          <span className="tabular-nums">
            第 {currentPage} / {pageCount} 页
          </span>
          <button
            type="button"
            data-asset-next="true"
            disabled={currentPage >= pageCount}
            onClick={() => setPage((p) => p + 1)}
            className="rounded border border-border px-2 py-1 hover:bg-surface-2 disabled:cursor-not-allowed disabled:opacity-40"
          >
            下一页
          </button>
        </div>
      </div>
    </CanvasModal>
  );
}

function AssetCard({ asset }: { asset: CanvasAsset }) {
  const [editingTags, setEditingTags] = useState(false);
  const [tagsDraft, setTagsDraft] = useState("");

  const commitTags = () => {
    setEditingTags(false);
    void updateAssetTags(asset.id, tagsDraft.split(/[,，\s]+/).filter(Boolean));
  };

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-surface-1 p-2">
      <AssetPreview asset={asset} />
      <p className="truncate text-xs text-text-primary" title={asset.title}>
        {asset.title}
      </p>
      {editingTags ? (
        <input
          type="text"
          ref={(el) => el?.focus()}
          value={tagsDraft}
          data-asset-tags-input={asset.id}
          onChange={(e) => setTagsDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") commitTags();
            if (e.key === "Escape") setEditingTags(false);
          }}
          onBlur={commitTags}
          placeholder="标签，空格分隔"
          className="w-full rounded border border-border bg-surface-2 px-1.5 py-0.5 text-[11px] outline-none"
        />
      ) : (
        <div className="flex min-h-[18px] flex-wrap items-center gap-1">
          {(asset.tags ?? []).map((tag) => (
            <span
              key={tag}
              className="rounded-full bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary"
            >
              {tag}
            </span>
          ))}
          <button
            type="button"
            aria-label="编辑标签"
            title="编辑标签"
            data-asset-tags-edit={asset.id}
            onClick={() => {
              setTagsDraft((asset.tags ?? []).join(" "));
              setEditingTags(true);
            }}
            className="flex size-4 items-center justify-center rounded text-text-tertiary hover:bg-surface-2 hover:text-text-primary"
          >
            <Tag size={10} />
          </button>
        </div>
      )}
      <div className="flex items-center gap-1">
        <button
          type="button"
          data-asset-insert={asset.id}
          onClick={() => {
            insertAssetToCanvas(asset.id);
            toast.success("已插入画布");
          }}
          className="flex flex-1 items-center justify-center gap-1 rounded bg-[var(--color-accent)] px-2 py-1 text-xs font-medium text-[var(--color-accent-fg)] hover:bg-[var(--color-accent-hover)]"
        >
          <Plus size={12} />
          插入
        </button>
        <button
          type="button"
          data-asset-delete={asset.id}
          aria-label="删除素材"
          title="删除素材"
          onClick={() => {
            void removeAsset(asset.id);
          }}
          className="rounded p-1 text-text-tertiary hover:bg-surface-2 hover:text-danger"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}

function AssetPreview({ asset }: { asset: CanvasAsset }) {
  if (asset.kind === "image") {
    return (
      <img
        src={asset.content}
        alt={asset.title}
        className="h-20 w-full rounded object-cover"
        draggable={false}
      />
    );
  }
  if (asset.kind === "text") {
    return (
      <p className="line-clamp-3 h-20 overflow-hidden rounded bg-surface-2 p-1.5 text-[11px] leading-tight text-text-secondary">
        {asset.content}
      </p>
    );
  }
  // video / audio → type icon block
  return (
    <div className="flex h-20 w-full items-center justify-center rounded bg-surface-2 text-text-tertiary">
      {asset.kind === "video" ? (
        <Clapperboard size={24} />
      ) : (
        <AudioLines size={24} />
      )}
    </div>
  );
}
