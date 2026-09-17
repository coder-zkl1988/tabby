import { ExpertCardFace } from "@/components/experts/expert-card";
import type { MinimalExpert } from "@nexu/shared";
import { useState } from "react";
import { Spinner } from "../a2ui-status";
import type { CustomComponentProps } from "./registry";

/**
 * In-chat expert install card. Rendered when find_expert matches an uninstalled
 * expert: reuses the experts-page card face (ExpertCardFace) so the style stays
 * unified, and wires confirm/cancel to the A2UI action channel. On confirm the
 * model receives an "install_expert" action carrying { slug, question }.
 *
 * The actions sit *below* the card, not in its footer. The footer is a
 * decorative strip (category label + barcode) with room for a ~20px control,
 * which is far too small for the card's only real action; moving the pair out
 * lets both buttons run at the 36px form height and gives the footer its
 * design back. Installing is reversible — it can be uninstalled — so 36, not
 * the 44 reserved for irreversible actions.
 */
export function ExpertInstallCard({
  comp,
  resolve,
  onAction,
}: CustomComponentProps) {
  const expert = resolve(
    (comp as { expert?: MinimalExpert }).expert,
  ) as MinimalExpert | null;
  const question =
    (resolve((comp as { question?: string }).question) as string) || "";
  const [submitted, setSubmitted] = useState<"install" | "cancel" | null>(null);

  if (!expert?.slug) return null;

  return (
    <div className="flex w-[260px] flex-col gap-3 py-1">
      <p className="text-center text-[13px] leading-[1.6] text-text-secondary">
        为更好地回答你的问题，建议安装并调用这位专家
      </p>
      <ExpertCardFace expert={expert} avatarUrl={expert.avatarDataUrl} />
      <div className="flex gap-2">
        <button
          type="button"
          disabled={submitted !== null}
          onClick={() => {
            if (submitted) return;
            setSubmitted("install");
            onAction?.("install_expert", {
              slug: expert.slug,
              name: expert.name,
              question,
            });
          }}
          className="inline-flex h-9 flex-1 items-center justify-center gap-2 rounded-lg bg-[var(--color-accent)] text-[13px] font-semibold text-[var(--color-accent-fg)] transition-colors hover:bg-[var(--color-accent-hover)] disabled:cursor-not-allowed disabled:opacity-40"
        >
          {submitted === "install" ? <Spinner /> : null}
          {submitted === "install" ? "安装中" : "安装并调用"}
        </button>
        <button
          type="button"
          disabled={submitted !== null}
          onClick={() => {
            if (submitted) return;
            setSubmitted("cancel");
            onAction?.("install_expert_cancel", { slug: expert.slug });
          }}
          className="inline-flex h-9 shrink-0 items-center justify-center rounded-lg border border-border-strong bg-surface-1 px-4 text-[13px] font-medium text-text-secondary transition-colors hover:border-[var(--color-accent)] hover:text-text-primary disabled:cursor-not-allowed disabled:opacity-40"
        >
          取消
        </button>
      </div>
    </div>
  );
}
