import {
  useInstallExpert,
  useUninstallExpert,
} from "@/hooks/use-experthub-catalog";
import type { MinimalExpert } from "@nexu/shared";
import { Loader2 } from "lucide-react";
import { type ReactNode, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate } from "react-router-dom";
import { toast } from "sonner";

// ── Theme palette ──────────────────────────────────────────────────────────

interface ThemePalette {
  gradient: string;
  infoBg: string;
  tagBg: string;
  tagText: string;
  tagBorder: string;
  footerBg: string;
  barcodeColor: string;
}

const THEMES: ThemePalette[] = [
  {
    gradient: "linear-gradient(150deg, #f9d77e 0%, #e8945a 50%, #c05c28 100%)",
    infoBg: "#fdf6ee",
    tagBg: "#fcebd3",
    tagText: "#7a3a10",
    tagBorder: "#e8a870",
    footerBg: "#fdf0e0",
    barcodeColor: "#a04820",
  },
  {
    gradient: "linear-gradient(150deg, #a8ddf8 0%, #3eb0e0 50%, #0075b0 100%)",
    infoBg: "#f0f9ff",
    tagBg: "#d8f0fc",
    tagText: "#004870",
    tagBorder: "#6cc4f0",
    footerBg: "#e8f5fd",
    barcodeColor: "#005890",
  },
  {
    gradient: "linear-gradient(150deg, #d4b483 0%, #9a7040 50%, #5c3810 100%)",
    infoBg: "#fdf8f0",
    tagBg: "#f5e8d0",
    tagText: "#4a2808",
    tagBorder: "#c09050",
    footerBg: "#fbf4e8",
    barcodeColor: "#6a3818",
  },
  {
    gradient: "linear-gradient(150deg, #ffc8e8 0%, #d860a0 50%, #980060 100%)",
    infoBg: "#fff5fa",
    tagBg: "#ffe0f0",
    tagText: "#780050",
    tagBorder: "#e880c0",
    footerBg: "#fff0f8",
    barcodeColor: "#a00060",
  },
  {
    gradient: "linear-gradient(150deg, #d8c8f8 0%, #8060e0 50%, #4020a0 100%)",
    infoBg: "#f8f5ff",
    tagBg: "#ece0ff",
    tagText: "#300880",
    tagBorder: "#a080e0",
    footerBg: "#f5f0ff",
    barcodeColor: "#5030b0",
  },
  {
    gradient: "linear-gradient(150deg, #b8f0c8 0%, #30c870 50%, #008840 100%)",
    infoBg: "#f0fff5",
    tagBg: "#d0f8e0",
    tagText: "#005828",
    tagBorder: "#60d090",
    footerBg: "#e8fdf0",
    barcodeColor: "#007838",
  },
  {
    gradient: "linear-gradient(150deg, #ffe080 0%, #ff8c38 50%, #d04800 100%)",
    infoBg: "#fff8f0",
    tagBg: "#ffecd0",
    tagText: "#882000",
    tagBorder: "#ffb060",
    footerBg: "#fff4e8",
    barcodeColor: "#c05000",
  },
  {
    gradient: "linear-gradient(150deg, #80e8ff 0%, #1090e0 50%, #0040a0 100%)",
    infoBg: "#f0f8ff",
    tagBg: "#d0eeff",
    tagText: "#002870",
    tagBorder: "#50b0f0",
    footerBg: "#e8f5ff",
    barcodeColor: "#0050b8",
  },
  {
    gradient:
      "linear-gradient(150deg, #ffdc80 0%, #ff8080 35%, #d060d0 70%, #6080ff 100%)",
    infoBg: "#fff8fd",
    tagBg: "#fde8f8",
    tagText: "#700060",
    tagBorder: "#e090d0",
    footerBg: "#fdf0fc",
    barcodeColor: "#9030a0",
  },
  {
    gradient: "linear-gradient(150deg, #b0f8d8 0%, #20c880 50%, #007850 100%)",
    infoBg: "#f0fff8",
    tagBg: "#d0f8ec",
    tagText: "#005038",
    tagBorder: "#50d0a0",
    footerBg: "#e8fdf4",
    barcodeColor: "#008858",
  },
];

// ── Barcode decoration ─────────────────────────────────────────────────────

function BarcodeLines({ color }: { color: string }) {
  // CSS-rendered barcode pattern — static decorative element
  return (
    <div
      className="h-4 w-[50px] opacity-45"
      aria-hidden
      style={{
        backgroundImage: `repeating-linear-gradient(
          90deg,
          ${color} 0px,
          ${color} 1.5px,
          transparent 1.5px,
          transparent 3px
        )`,
        backgroundSize: "50px 16px",
        maskImage:
          "linear-gradient(to top, transparent 0%, black 20%, black 80%, transparent 100%)",
        WebkitMaskImage:
          "linear-gradient(to top, transparent 0%, black 20%, black 80%, transparent 100%)",
      }}
    />
  );
}

// ── Shared visual face ─────────────────────────────────────────────────────

/**
 * The trading-card visual (image zone + info zone + footer chrome), shared by
 * the experts page card and the in-chat expert-install card so the two styles
 * cannot drift. `footerActions` fills the footer's action slot.
 */
export function ExpertCardFace({
  expert,
  avatarUrl,
  footerActions,
}: {
  expert: MinimalExpert;
  avatarUrl?: string;
  footerActions?: ReactNode;
}) {
  // biome-ignore lint/style/noNonNullAssertion: THEMES is fixed-length, index bounded 0–9
  const theme = THEMES[expert.slug.charCodeAt(0) % THEMES.length]!;

  return (
    <div className="w-full h-full rounded-[20px] overflow-hidden flex flex-col border-2 border-white/10">
      {/* Image zone */}
      <div
        className="w-full h-[170px] relative overflow-hidden shrink-0"
        style={{ background: theme.gradient }}
      >
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.10) 1px, transparent 1px)",
            backgroundSize: "13px 13px",
          }}
        />
        {avatarUrl ? (
          <img
            src={avatarUrl}
            alt=""
            className="absolute bottom-0 left-1/2 -translate-x-1/2 h-[96%] w-auto object-contain object-bottom z-[2]"
          />
        ) : (
          <span
            aria-hidden
            className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[68px] leading-none z-[2]"
          >
            {expert.emoji}
          </span>
        )}
        {expert.category && (
          <span className="absolute top-3 left-1/2 -translate-x-1/2 whitespace-nowrap bg-black/35 backdrop-blur-[6px] border border-white/20 text-white text-[9px] font-black tracking-[2px] uppercase px-3 py-1 rounded-[20px] z-10">
            {expert.category}
          </span>
        )}
      </div>

      {/* Info zone */}
      <div
        className="px-4 pt-7 pb-3.5 flex flex-col items-center gap-2 -mt-7 relative z-[4] flex-1"
        style={{
          background: `linear-gradient(to bottom, transparent 0px, ${theme.infoBg} 28px)`,
        }}
      >
        <div
          className="text-[15px] font-black tracking-[0.5px] text-center"
          style={{ color: "#111" }}
        >
          {expert.name}
        </div>
        {expert.description && (
          <p
            className="text-[12px] text-[#5c5c5c] text-center leading-[1.5] px-1 line-clamp-2"
            title={expert.description}
          >
            {expert.description}
          </p>
        )}
        {expert.tags && expert.tags.length > 0 && (
          <div className="flex gap-1 mt-0.5 overflow-x-auto no-scrollbar max-w-full">
            {expert.tags.slice(0, 3).map((tag) => (
              <span
                key={tag}
                className="text-[11px] font-bold px-2.5 py-[3px] rounded-[20px] tracking-[0.2px] shrink-0"
                style={{
                  background: theme.tagBg,
                  color: theme.tagText,
                  border: `1.5px solid ${theme.tagBorder}`,
                }}
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Footer */}
      <div
        className="border-t border-black/[0.07] px-4 py-2.5 flex items-center justify-between gap-1.5 relative z-[4]"
        style={{ background: theme.footerBg }}
      >
        <span className="text-[11px] font-extrabold text-[#8a8a8a] tracking-[0.4px]">
          {expert.category ?? ""}
        </span>
        <BarcodeLines color={theme.barcodeColor} />
        {footerActions}
      </div>
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export function ExpertCard({
  expert,
  installed,
  detailTo,
  isCustom,
  customEditTo,
  customAvatarUrl,
}: {
  expert: MinimalExpert;
  installed: boolean;
  detailTo: string;
  isCustom?: boolean;
  customEditTo?: string;
  customAvatarUrl?: string;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const installMutation = useInstallExpert();
  const uninstallMutation = useUninstallExpert();
  const [pendingAction, setPendingAction] = useState<
    "install" | "uninstall" | null
  >(null);

  const isMutating = pendingAction !== null;
  const avatarUrl = customAvatarUrl || expert.avatarDataUrl;

  async function handleInstall() {
    setPendingAction("install");
    try {
      const result = await installMutation.mutateAsync(expert.slug);
      toast.success(t("experts.install_success", { botName: expert.name }));
      navigate(`/workspace/chat?botId=${encodeURIComponent(result.botId)}`);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("experts.install_error", { defaultValue: "Install failed" }),
      );
    } finally {
      setPendingAction(null);
    }
  }

  async function handleUninstall() {
    setPendingAction("uninstall");
    try {
      await uninstallMutation.mutateAsync(expert.slug);
    } catch (err) {
      toast.error(
        err instanceof Error
          ? err.message
          : t("experts.uninstall_error", { defaultValue: "Uninstall failed" }),
      );
    } finally {
      setPendingAction(null);
    }
  }

  return (
    <Link
      to={detailTo}
      draggable={false}
      className="flex flex-col items-center h-full filter drop-shadow-[0_16px_32px_rgba(0,0,0,0.45)] transition-transform duration-250 ease-[cubic-bezier(.34,1.56,.64,1)] hover:-translate-y-2 hover:scale-[1.02]"
    >
      <ExpertCardFace
        expert={expert}
        avatarUrl={avatarUrl}
        footerActions={
          <div
            className="flex items-center gap-1 shrink-0"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                e.stopPropagation();
              }
            }}
          >
            {isCustom ? (
              <>
                {customEditTo && (
                  <Link
                    to={customEditTo}
                    onClick={(e) => e.stopPropagation()}
                    className="rounded-md px-2 py-0.5 text-[10px] font-medium border border-border text-text-primary hover:bg-surface-2 transition-colors"
                  >
                    {t("experts.edit")}
                  </Link>
                )}
                <button
                  type="button"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    void handleUninstall();
                  }}
                  disabled={isMutating}
                  className="rounded-md px-2 py-0.5 text-[10px] font-medium border border-border text-[var(--color-danger)] hover:bg-[var(--color-danger)]/5 transition-colors"
                >
                  {pendingAction === "uninstall"
                    ? t("experts.removing")
                    : t("experts.remove")}
                </button>
              </>
            ) : installed ? (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleUninstall();
                }}
                disabled={isMutating}
                className="rounded-md px-2 py-0.5 text-[10px] font-medium border border-border text-[var(--color-danger)] hover:bg-[var(--color-danger)]/5 transition-colors"
              >
                {pendingAction === "uninstall"
                  ? t("experts.removing")
                  : t("experts.remove")}
              </button>
            ) : isMutating ? (
              <span className="inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[10px] font-medium border border-border text-text-muted cursor-default">
                <Loader2 size={10} className="animate-spin" />
                {t("experts.installing")}
              </span>
            ) : (
              <button
                type="button"
                onClick={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  void handleInstall();
                }}
                disabled={isMutating}
                className="rounded-md px-2 py-0.5 text-[10px] font-medium border border-border text-text-primary hover:bg-surface-2 transition-colors"
              >
                {t("experts.install")}
              </button>
            )}
          </div>
        }
      />
    </Link>
  );
}
