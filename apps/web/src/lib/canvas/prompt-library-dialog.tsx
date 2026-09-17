/**
 * prompt-library-dialog.tsx — 提示词库 picker (reference parity).
 *
 * radix Dialog wired into CanvasDialogs as { kind: "prompt-library", nodeId }.
 * Search / category tags / tag filters / cover-image card grid / scroll-to-
 * load-more, backed by prompt-library-data (five public GitHub prompt
 * collections, 1h cache). Picking a card writes the prompt into the target
 * node's draft (subscribable prompt-drafts) and closes the dialog — the open
 * PromptPanel updates immediately.
 */

import { Check, Search } from "lucide-react";
import { type UIEvent, useCallback, useEffect, useState } from "react";
import { postApiV1MediaPromptCoverGenerate } from "../../../lib/api/sdk.gen";
import { closeCanvasDialog } from "./canvas-dialogs";
import { CanvasModal } from "./canvas-modal";
import { resolveMediaUrl } from "./load-image-bitmap";
import { setDraft } from "./prompt-drafts";
import {
  ALL_PROMPTS_OPTION,
  type LibraryPrompt,
  type PromptPage,
  fetchPromptPage,
  promptCoverPath,
} from "./prompt-library-data";

const PAGE_SIZE = 20;

/**
 * Client-side dedupe for generated covers: one POST per prompt id per app
 * session, shared across dialog reopens. The server caches to disk and
 * serializes generation, so re-firing is harmless but pointless.
 * Resolves to a servable URL, or null when generation failed (placeholder).
 */
const generatedCoverRequests = new Map<string, Promise<string | null>>();

function ensureGeneratedCover(item: LibraryPrompt): Promise<string | null> {
  let request = generatedCoverRequests.get(item.id);
  if (!request) {
    request = postApiV1MediaPromptCoverGenerate({
      body: { id: item.id, prompt: item.prompt },
    })
      .then((response) => response.data?.url ?? null)
      .catch(() => null);
    generatedCoverRequests.set(item.id, request);
  }
  return request;
}

export function PromptLibraryDialog({ nodeId }: { nodeId: string }) {
  const [keyword, setKeyword] = useState("");
  const [category, setCategory] = useState(ALL_PROMPTS_OPTION);
  // Single-select tag filter ("" = 全部) — simpler than the reference's
  // multi-select, whose selected state read as a mis-click.
  const [selectedTag, setSelectedTag] = useState("");
  const [page, setPage] = useState(1);
  const [items, setItems] = useState<LibraryPrompt[]>([]);
  const [meta, setMeta] = useState<
    Pick<PromptPage, "tags" | "categories" | "total">
  >({
    tags: [],
    categories: [],
    total: 0,
  });
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);

  // (Re)load page 1 whenever a filter changes. requestId guards against a
  // slow older query overwriting a newer one.
  useEffect(() => {
    let stale = false;
    setLoading(true);
    setPage(1);
    void fetchPromptPage({
      keyword,
      tags: selectedTag ? [selectedTag] : [],
      category,
      page: 1,
      pageSize: PAGE_SIZE,
    }).then((result) => {
      if (stale) return;
      setItems(result.items);
      setMeta({
        tags: result.tags,
        categories: result.categories,
        total: result.total,
      });
      setLoading(false);
    });
    return () => {
      stale = true;
    };
  }, [keyword, selectedTag, category]);

  const loadMore = useCallback(() => {
    if (loading || loadingMore || items.length >= meta.total) return;
    const nextPage = page + 1;
    setLoadingMore(true);
    void fetchPromptPage({
      keyword,
      tags: selectedTag ? [selectedTag] : [],
      category,
      page: nextPage,
      pageSize: PAGE_SIZE,
    }).then((result) => {
      setItems((current) => [...current, ...result.items]);
      setPage(nextPage);
      setLoadingMore(false);
    });
  }, [
    loading,
    loadingMore,
    items.length,
    meta.total,
    page,
    keyword,
    selectedTag,
    category,
  ]);

  const handleListScroll = (event: UIEvent<HTMLDivElement>) => {
    const target = event.currentTarget;
    if (target.scrollTop + target.clientHeight >= target.scrollHeight - 160) {
      loadMore();
    }
  };

  const toggleTag = (tag: string) => {
    // Clicking the active tag clears it (back to 全部).
    setSelectedTag((current) => (current === tag ? "" : tag));
  };

  const selectPrompt = (prompt: string) => {
    setDraft(nodeId, prompt);
    closeCanvasDialog();
  };

  return (
    <CanvasModal
      title="提示词库"
      maxWidth={768}
      scrollable={false}
      onClose={closeCanvasDialog}
      dataAttr={{ name: "data-canvas-prompt-library-dialog", value: "true" }}
    >
      {/* Search */}
      <div className="relative">
        <Search
          size={14}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-text-tertiary"
        />
        <input
          value={keyword}
          onChange={(event) => setKeyword(event.target.value)}
          placeholder="按标题查询"
          className="w-full rounded-lg border-0 bg-surface-2 py-2.5 pl-9 pr-3 text-sm outline-none placeholder:text-text-tertiary"
        />
      </div>

      <div className="flex min-h-0 flex-1 flex-col">
        {/* Category + tag filters */}
        <div className="flex flex-col gap-2.5 pb-4">
          <FilterRow label="分类">
            {[ALL_PROMPTS_OPTION, ...meta.categories].map((item) => (
              <FilterTag
                key={item}
                active={category === item}
                onClick={() => setCategory(item)}
              >
                {item}
              </FilterTag>
            ))}
          </FilterRow>
          {meta.tags.length > 0 ? (
            <FilterRow label="标签">
              <FilterTag
                active={selectedTag === ""}
                onClick={() => setSelectedTag("")}
              >
                {ALL_PROMPTS_OPTION}
              </FilterTag>
              {meta.tags.slice(0, 24).map((tag) => (
                <FilterTag
                  key={tag}
                  active={selectedTag === tag}
                  onClick={() => toggleTag(tag)}
                >
                  {tag}
                </FilterTag>
              ))}
            </FilterRow>
          ) : null}
        </div>

        {/* Card grid — scroll near the bottom loads the next page */}
        <div
          className="no-scrollbar -mx-1 min-h-0 flex-1 overflow-y-auto border-t border-border px-1 pt-4"
          onScroll={handleListScroll}
        >
          {loading ? (
            <div className="flex h-36 items-center justify-center">
              <div className="size-6 animate-spin rounded-full border-2 border-border border-t-[var(--color-brand-primary)]" />
            </div>
          ) : items.length === 0 ? (
            <p className="py-10 text-center text-xs text-text-tertiary">
              没有找到匹配的提示词（首次加载需要访问 GitHub，失败时可稍后重试）
            </p>
          ) : (
            <div className="grid grid-cols-2 gap-3 lg:grid-cols-3">
              {items.map((item) => (
                <PromptCard
                  key={item.id}
                  item={item}
                  onSelect={() => selectPrompt(item.prompt)}
                />
              ))}
            </div>
          )}
          {loadingMore ? (
            <div className="flex justify-center py-3">
              <div className="size-4 animate-spin rounded-full border-2 border-border border-t-[var(--color-brand-primary)]" />
            </div>
          ) : null}
        </div>
      </div>
    </CanvasModal>
  );
}

function FilterRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="shrink-0 pt-1 text-[11px] font-medium text-text-tertiary">
        {label}
      </span>
      <div className="flex flex-wrap gap-1">{children}</div>
    </div>
  );
}

function FilterTag({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-full border px-2 py-0.5 text-[11px] transition-colors ${
        active
          ? "border-text-primary text-text-primary"
          : "border-border text-text-secondary hover:text-text-primary"
      }`}
    >
      {children}
    </button>
  );
}

function PromptCard({
  item,
  onSelect,
}: {
  item: LibraryPrompt;
  onSelect: () => void;
}) {
  // Covers route through the controller's disk-backed cover cache when the
  // host is proxyable (served from our server); load failures swap to the
  // same placeholder as cover-less items instead of a broken-image glyph.
  const [coverFailed, setCoverFailed] = useState(false);
  // Cover-less prompts can get one generated by OUR image backend (server-
  // side disk cache; client-side per-id dedupe above). MANUAL trigger only:
  // auto-firing on mount queued hundreds of generations that saturated the
  // image lane (user generations stuck behind them) and silently burned
  // credits.
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [generating, setGenerating] = useState(false);
  const generateCover = () => {
    if (generating) return;
    setGenerating(true);
    void ensureGeneratedCover(item).then((url) => {
      // Cache-bust so the <img> that just 404-ed retries the fresh file;
      // on failure keep the placeholder (coverFailed stays set).
      setGeneratedUrl(url ? `${url}&ts=${Date.now()}` : null);
      if (url) setCoverFailed(false);
      setGenerating(false);
    });
  };

  // Coverless prompts probe the generated-cover disk cache OPTIMISTICALLY:
  // anything generated in any earlier session shows instantly (the GET is a
  // local cache read); a 404 (never generated) lands in onError → placeholder
  // with the manual 生成预览 button. No generation is triggered by the probe.
  const generatedProbeUrl = `/api/v1/media/prompt-cover-generated?id=${encodeURIComponent(item.id)}`;
  const coverSrc = item.coverUrl
    ? resolveMediaUrl(promptCoverPath(item.coverUrl))
    : resolveMediaUrl(generatedUrl ?? generatedProbeUrl);
  return (
    <div
      data-canvas-prompt-card={item.id}
      className="flex flex-col overflow-hidden rounded-xl border border-border bg-surface-1 transition-shadow hover:shadow-md"
    >
      <div className="relative">
        <button
          type="button"
          onClick={onSelect}
          className="block w-full text-left"
        >
          {coverSrc && !coverFailed ? (
            <img
              src={coverSrc}
              alt={item.title}
              loading="lazy"
              onError={() => setCoverFailed(true)}
              className="aspect-[4/3] w-full bg-surface-2 object-cover"
            />
          ) : (
            <div className="flex aspect-[4/3] w-full flex-col items-center justify-center gap-2 bg-surface-2 text-[11px] text-text-tertiary">
              {generating ? (
                <>
                  <div className="size-4 animate-spin rounded-full border-2 border-border border-t-[var(--color-brand-primary)]" />
                  <span>生成预览中…</span>
                </>
              ) : (
                <span>无预览图</span>
              )}
            </div>
          )}
        </button>
        {coverFailed && !generating ? (
          <button
            type="button"
            data-canvas-prompt-cover-generate={item.id}
            onClick={generateCover}
            className="absolute left-1/2 top-[calc(50%+14px)] -translate-x-1/2 rounded-full border border-border px-2 py-0.5 text-[10px] text-text-secondary transition-colors hover:text-text-primary"
          >
            生成预览
          </button>
        ) : null}
      </div>
      <button type="button" onClick={onSelect} className="block text-left">
        <div className="p-3">
          <h3 className="line-clamp-1 text-xs font-semibold text-text-primary">
            {item.title}
          </h3>
          <p className="mt-1.5 line-clamp-3 text-[11px] leading-4 text-text-tertiary">
            {item.prompt}
          </p>
          {item.tags.length > 0 ? (
            <div className="mt-2 flex flex-wrap gap-1">
              {item.tags.slice(0, 4).map((tag) => (
                <span
                  key={tag}
                  className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] text-text-secondary"
                >
                  {tag}
                </span>
              ))}
            </div>
          ) : null}
        </div>
      </button>
      <button
        type="button"
        onClick={onSelect}
        className="mx-3 mb-3 mt-auto flex items-center justify-center gap-1 rounded-lg bg-[var(--color-accent)] py-1.5 text-[11px] font-medium text-[var(--color-accent-fg)] transition-opacity hover:opacity-90"
      >
        <Check size={12} />
        使用此提示词
      </button>
    </div>
  );
}
