import { Loader2 } from "lucide-react";

export function XHSImageGenerationPlaceholders({
  slotIds,
}: {
  slotIds: ReadonlyArray<string>;
}) {
  return slotIds.map((slotId, index) => (
    <output
      key={slotId}
      aria-label={`第 ${index + 1} 张 AI 图片生成中`}
      aria-live="polite"
      style={{
        aspectRatio: "1",
        borderRadius: 8,
        border: "1px dashed #f2b8c4",
        background: "#fff4f6",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        color: "var(--color-xhs)",
      }}
    >
      <Loader2 size={20} className="animate-spin" />
    </output>
  ));
}
