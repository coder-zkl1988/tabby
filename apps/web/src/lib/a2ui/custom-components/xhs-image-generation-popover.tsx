import { useCanvasModelOptions } from "@/lib/canvas/canvas-model-options";
import { ParamPill, SettingsGroup } from "@/lib/canvas/param-pills";
import {
  type ImageQuality,
  imageQualityLabel,
} from "@/lib/canvas/prompt-panel-utils";
import {
  ImagePlus,
  LoaderCircle,
  Sparkles,
  WandSparkles,
  X,
} from "lucide-react";
import {
  type RefObject,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { toast } from "sonner";
import {
  type XhsPostPromptContext,
  generateXhsImagePrompt,
} from "../../media/image-prompt-optimization";
import type { XHSImageGenerationRequest } from "./xhs-image-generation";

type XHSImageGenerationPopoverProps = {
  open: boolean;
  anchorRef: RefObject<HTMLButtonElement | null>;
  onOpenChange: (open: boolean) => void;
  onGenerate: (request: XHSImageGenerationRequest) => void;
  postContext: XhsPostPromptContext;
};

type PopoverPosition = {
  top: number;
  left: number;
  width: number;
  maxHeight: number;
};

const PANEL_WIDTH = 420;
const PANEL_MAX_HEIGHT = 560;
const VIEWPORT_MARGIN = 12;
const ANCHOR_GAP = 10;

function resolvePopoverPosition(
  anchor: DOMRect,
  viewportWidth: number,
  viewportHeight: number,
): PopoverPosition {
  const width = Math.min(PANEL_WIDTH, viewportWidth - VIEWPORT_MARGIN * 2);
  const maxHeight = Math.min(
    PANEL_MAX_HEIGHT,
    viewportHeight - VIEWPORT_MARGIN * 2,
  );
  const rightLeft = anchor.right + ANCHOR_GAP;
  const fitsRight = rightLeft + width <= viewportWidth - VIEWPORT_MARGIN;
  const left = fitsRight
    ? rightLeft
    : Math.max(VIEWPORT_MARGIN, anchor.left - width - ANCHOR_GAP);
  const top = Math.min(
    Math.max(VIEWPORT_MARGIN, anchor.top),
    Math.max(VIEWPORT_MARGIN, viewportHeight - maxHeight - VIEWPORT_MARGIN),
  );
  return { top, left, width, maxHeight };
}

export function XHSImageGenerationPopover({
  open,
  anchorRef,
  onOpenChange,
  onGenerate,
  postContext,
}: XHSImageGenerationPopoverProps) {
  const models = useCanvasModelOptions("image");
  const panelRef = useRef<HTMLDialogElement>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const [prompt, setPrompt] = useState("");
  const [model, setModel] = useState("");
  const [quality, setQuality] = useState<ImageQuality>("auto");
  const [aspectRatio, setAspectRatio] = useState("");
  const [size, setSize] = useState("");
  const [count, setCount] = useState(1);
  const [transparentBackground, setTransparentBackground] = useState(false);
  const [isGeneratingPrompt, setIsGeneratingPrompt] = useState(false);

  useLayoutEffect(() => {
    if (!open) {
      setPosition(null);
      return;
    }

    const updatePosition = () => {
      const anchor = anchorRef.current;
      if (!anchor) return;
      setPosition(
        resolvePopoverPosition(
          anchor.getBoundingClientRect(),
          window.innerWidth,
          window.innerHeight,
        ),
      );
    };

    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [anchorRef, open]);

  useEffect(() => {
    if (!open) return;

    const handlePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (
        panelRef.current?.contains(target) ||
        anchorRef.current?.contains(target)
      ) {
        return;
      }
      onOpenChange(false);
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };

    document.addEventListener("pointerdown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [anchorRef, onOpenChange, open]);

  if (!open || !position || typeof document === "undefined") return null;

  const handleSubmit = () => {
    const normalizedPrompt = prompt.trim();
    if (!normalizedPrompt) return;

    onOpenChange(false);
    onGenerate({
      prompt: normalizedPrompt,
      model,
      quality,
      aspectRatio,
      size,
      count,
      transparentBackground,
    });
  };

  const handleGeneratePrompt = async () => {
    if (isGeneratingPrompt) return;
    setIsGeneratingPrompt(true);
    try {
      setPrompt(await generateXhsImagePrompt(postContext));
      toast.success("已根据帖子生成图片提示词");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "AI 提示词生成失败");
    } finally {
      setIsGeneratingPrompt(false);
    }
  };

  const hasPostContent = Boolean(
    postContext.title.trim() || postContext.content.trim(),
  );

  return createPortal(
    <dialog
      ref={panelRef}
      open
      aria-label="AI 生成帖子图片"
      className="fixed z-[120] flex flex-col overflow-hidden rounded-lg border border-border bg-surface-1 shadow-xl"
      style={position}
    >
      <div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-semibold text-text-primary">
          <Sparkles size={16} className="text-[var(--color-xhs)]" />
          AI 生成帖子图片
        </div>
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          title="关闭"
          aria-label="关闭"
          className="flex size-7 items-center justify-center rounded-md text-text-secondary hover:bg-surface-2 hover:text-text-primary"
        >
          <X size={15} />
        </button>
      </div>

      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto px-4 py-3">
        <div className="space-y-2">
          <span className="flex items-center justify-between gap-3">
            <span className="text-xs font-medium text-text-secondary">
              画面描述
            </span>
            <button
              type="button"
              onClick={() => void handleGeneratePrompt()}
              disabled={!hasPostContent || isGeneratingPrompt}
              className="flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-[var(--color-xhs)] transition-colors hover:bg-[var(--color-xhs-wash)] disabled:cursor-not-allowed disabled:opacity-45"
            >
              {isGeneratingPrompt ? (
                <LoaderCircle size={13} className="animate-spin" />
              ) : (
                <WandSparkles size={13} />
              )}
              {isGeneratingPrompt ? "生成中" : "根据帖子生成"}
            </button>
          </span>
          <textarea
            aria-label="画面描述"
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="例如：清晨咖啡馆窗边的手账与拿铁，自然光，生活方式摄影"
            rows={3}
            className="w-full resize-none rounded-lg border border-border bg-surface-1 px-3 py-2 text-sm text-text-primary outline-none transition-colors placeholder:text-text-muted focus:border-text-secondary"
          />
        </div>

        <label className="flex items-center justify-between gap-4">
          <span className="text-xs font-medium text-text-secondary">
            生成模型
          </span>
          <select
            value={model}
            onChange={(event) => setModel(event.target.value)}
            className="h-8 min-w-44 rounded-lg border border-border bg-surface-1 px-2 text-xs text-text-primary outline-none"
          >
            <option value="">默认模型</option>
            {models.map((option) => (
              <option key={option.id} value={option.id}>
                {option.name}
              </option>
            ))}
          </select>
        </label>

        <div className="rounded-lg border border-border bg-surface-2 p-3">
          <SettingsGroup label="质量">
            {(["auto", "high", "medium", "low"] as const).map((option) => (
              <ParamPill
                key={option}
                active={quality === option}
                onClick={() => setQuality(option)}
              >
                {imageQualityLabel(option)}
              </ParamPill>
            ))}
          </SettingsGroup>
          <SettingsGroup label="宽高比">
            {["", "1:1", "3:4", "4:3", "9:16", "16:9"].map((option) => (
              <ParamPill
                key={option || "default"}
                active={aspectRatio === option}
                onClick={() => setAspectRatio(option)}
              >
                {option || "默认"}
              </ParamPill>
            ))}
          </SettingsGroup>
          <SettingsGroup label="尺寸">
            {["", "1K", "2K", "4K"].map((option) => (
              <ParamPill
                key={option || "default"}
                active={size === option}
                onClick={() => setSize(option)}
              >
                {option || "默认"}
              </ParamPill>
            ))}
          </SettingsGroup>
          <SettingsGroup label="生成张数">
            {Array.from({ length: 12 }, (_, index) => index + 1).map(
              (option) => (
                <ParamPill
                  key={option}
                  active={count === option}
                  onClick={() => setCount(option)}
                >
                  {option} 张
                </ParamPill>
              ),
            )}
          </SettingsGroup>
          <SettingsGroup label="透明背景">
            <ParamPill
              active={!transparentBackground}
              onClick={() => setTransparentBackground(false)}
            >
              关
            </ParamPill>
            <ParamPill
              active={transparentBackground}
              onClick={() => setTransparentBackground(true)}
            >
              开
            </ParamPill>
          </SettingsGroup>
        </div>
      </div>

      <div className="flex shrink-0 justify-end gap-2 border-t border-border px-4 py-3">
        <button
          type="button"
          onClick={() => onOpenChange(false)}
          className="h-9 rounded-lg border border-border px-4 text-sm text-text-secondary transition-colors hover:bg-surface-2"
        >
          取消
        </button>
        <button
          type="button"
          onClick={handleSubmit}
          disabled={!prompt.trim() || isGeneratingPrompt}
          className="flex h-9 items-center gap-2 rounded-lg bg-[var(--color-xhs)] px-4 text-sm font-medium text-white transition-opacity hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          <ImagePlus size={15} />
          生成并添加
        </button>
      </div>
    </dialog>,
    document.body,
  );
}
