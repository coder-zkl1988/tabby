import { BudgetWarningBanner } from "@/components/budget-warning-banner";
import { PinnedA2UIPanel } from "@/components/pinned-a2ui-panel";
import { PlatformIcon } from "@/components/platform-icons";
import { SessionRecoveryDialog } from "@/components/session-recovery-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useAutoUpdate } from "@/hooks/use-auto-update";
import { useCloudConnect } from "@/hooks/use-cloud-connect";
import { useCommunitySkillStatus } from "@/hooks/use-community-catalog";
import {
  getBudgetBannerRouteVariant,
  useDesktopBudgetGuard,
} from "@/hooks/use-desktop-budget-guard";
import { useDesktopCloudStatus } from "@/hooks/use-desktop-cloud-status";
import { useDesktopRewardsStatus } from "@/hooks/use-desktop-rewards";
import {
  closePinnedPanel,
  forgetPinnedSession,
  setActivePinnedSession,
  usePinnedPanel,
} from "@/lib/a2ui/a2ui-pinned-panel-store";
import {
  A2UISidebarProvider,
  useA2UISidebar,
} from "@/lib/a2ui/a2ui-sidebar-context";
import { authClient } from "@/lib/auth-client";
import {
  closeBrowserPanel,
  closeBrowserPanelForRouting,
  closeBrowserPanelForSessionNavigation,
  syncBrowserPanelToSession,
  useBrowserPanel,
} from "@/lib/browser/browser-panel-store";
import {
  EmbeddedBrowser,
  forgetBrowserSession,
} from "@/lib/browser/embedded-browser";
import { exportBoardAsZip } from "@/lib/canvas/canvas-export";
import { setPanelOpen } from "@/lib/canvas/canvas-store";
import { CanvasBoardTitle } from "@/lib/canvas/canvas-toolbar";
import { CanvasSurface } from "@/lib/canvas/infinite-canvas";
import {
  isMacDesktopPlatform,
  isWindowsDesktopPlatform,
} from "@/lib/desktop-platform";
import { logoutToWelcome } from "@/lib/logout";
import { normalizeChannel, track } from "@/lib/tracking";
import { cn } from "@/lib/utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive,
  ArchiveRestore,
  BookOpen,
  Bot,
  ChevronRight,
  ChevronUp,
  CircleHelp,
  CirclePlus,
  Clock,
  FileDown,
  FolderInput,
  GitBranch,
  History,
  Home,
  Info,
  LogOut,
  Mail,
  MailOpen,
  Maximize2,
  MessageSquare,
  Minimize2,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  Puzzle,
  RefreshCw,
  ScrollText,
  Search,
  Settings,
  Smartphone,
  Sparkles,
  Trash2,
  UsersRound,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import {
  Link,
  Navigate,
  Outlet,
  useLocation,
  useNavigate,
} from "react-router-dom";
import "@/lib/api";
import {
  deleteApiV1SessionsById,
  getApiV1Me,
  getApiV1Sessions,
  patchApiInternalSessionsById,
  patchApiV1SessionsByIdOrganization,
  postApiV1SessionsByIdArchive,
  postApiV1SessionsByIdFork,
} from "../../lib/api/sdk.gen";

interface SidebarSession {
  id: string;
  title: string;
  channelType: string;
  lastTime: string | null;
  status: string;
  sessionKey: string;
  category: string | null;
  pinned: boolean;
  unread: boolean;
  archived: boolean;
  checkpointCount: number;
  runState: "idle" | "running" | "failed";
}

export type SidebarSessionFilter =
  | "all"
  | "conversations"
  | "scheduled"
  | "unread"
  | "running"
  | "failed"
  | "archived";

export function filterSidebarSessions(
  sessions: SidebarSession[],
  search: string,
  filter: SidebarSessionFilter,
): SidebarSession[] {
  const normalizedSearch = search.trim().toLocaleLowerCase();
  return sessions.filter((session) => {
    if (
      normalizedSearch &&
      !session.title.toLocaleLowerCase().includes(normalizedSearch) &&
      !session.category?.toLocaleLowerCase().includes(normalizedSearch)
    ) {
      return false;
    }
    const scheduled = session.sessionKey.includes(":schedule-");
    if (filter === "scheduled") return scheduled && !session.archived;
    if (filter === "conversations") return !scheduled && !session.archived;
    if (filter === "unread") return session.unread && !session.archived;
    if (filter === "running") {
      return session.runState === "running" && !session.archived;
    }
    if (filter === "failed") {
      return session.runState === "failed" && !session.archived;
    }
    if (filter === "archived") return session.archived;
    return !session.archived;
  });
}

export function sortSidebarSessions(
  sessions: SidebarSession[],
): SidebarSession[] {
  return [...sessions].sort((left, right) => {
    if (left.pinned !== right.pinned) return left.pinned ? -1 : 1;
    return (right.lastTime ?? "").localeCompare(left.lastTime ?? "");
  });
}

export function isScheduledSessionSectionExpanded(input: {
  collapsed: boolean;
  filter: SidebarSessionFilter;
  search: string;
}): boolean {
  return (
    !input.collapsed ||
    (input.filter !== "all" && input.filter !== "conversations") ||
    input.search.trim().length > 0
  );
}

// Cloud balance amounts arrive as integer US cents; show them as exact USD.
export function formatUsdCents(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

// The balance popup currently shows only remaining balance + consumed. The
// gifted/plan breakdown rows are kept (hidden) for when a gifted-credits
// system is wired up; flip this to re-enable them.
const SHOW_BALANCE_BREAKDOWN = false;

export function getSidebarCreditBreakdown(input: {
  progress: {
    earnedCredits: number;
  };
  cloudBalance: {
    totalBalance: number;
    giftedBalance?: number;
    planBalance?: number;
  } | null;
}) {
  if (!input.cloudBalance) {
    return {
      totalBalance: 0,
      giftedBalance: 0,
      planBalance: 0,
    };
  }

  const totalBalance = input.cloudBalance.totalBalance;
  const giftedBalance = Math.min(
    Math.max(input.cloudBalance.giftedBalance ?? 0, 0),
    totalBalance,
  );
  const planBalance =
    input.cloudBalance.planBalance ?? Math.max(totalBalance - giftedBalance, 0);

  return {
    totalBalance,
    giftedBalance,
    planBalance: Math.max(planBalance, 0),
  };
}

function mapDbSession(s: {
  id: string;
  title: string;
  channelType?: string | null;
  lastMessageAt?: string | null;
  updatedAt?: string;
  status?: string | null;
  sessionKey?: string;
  category?: string | null;
  pinned?: boolean;
  unread?: boolean;
  archived?: boolean;
  checkpointCount?: number;
  runState?: "idle" | "running" | "failed";
}): SidebarSession {
  return {
    id: s.id,
    title: s.title,
    channelType: s.channelType ?? "web",
    lastTime: s.lastMessageAt ?? s.updatedAt ?? null,
    status: s.status ?? "",
    sessionKey: s.sessionKey ?? "",
    category: s.category ?? null,
    pinned: s.pinned ?? false,
    unread: s.unread ?? false,
    archived: s.archived ?? false,
    checkpointCount: s.checkpointCount ?? 0,
    runState: s.runState ?? "idle",
  };
}

export async function deleteSidebarSession(sessionId: string): Promise<void> {
  const { error } = await deleteApiV1SessionsById({
    path: { id: sessionId },
  });
  if (error) {
    throw new Error("delete session failed");
  }
}

export async function renameSidebarSession(input: {
  id: string;
  title: string;
}): Promise<void> {
  const { error } = await patchApiInternalSessionsById({
    path: { id: input.id },
    body: { title: input.title },
  });
  if (error) {
    throw new Error("rename session failed");
  }
}

type Platform =
  | "slack"
  | "discord"
  | "whatsapp"
  | "telegram"
  | "feishu"
  | "dingtalk"
  | "wecom"
  | "qqbot"
  | "wechat"
  | "openclaw-weixin"
  | "web";

const PLATFORM_LABELS: Record<Platform, string> = {
  discord: "Discord",
  slack: "Slack",
  feishu: "Feishu",
  dingtalk: "DingTalk",
  wecom: "WeCom",
  qqbot: "QQ",
  wechat: "WeChat",
  "openclaw-weixin": "WeChat",
  whatsapp: "WhatsApp",
  telegram: "Telegram",
  web: "Web",
};

function SidebarPlatformIcon({ platform }: { platform: string }) {
  return (
    <span className="flex justify-center items-center w-7 h-7 rounded-xl border border-border bg-surface-1 shrink-0 shadow-[0_1px_2px_rgba(0,0,0,0.03)]">
      <PlatformIcon platform={platform} size={15} />
    </span>
  );
}

function getPlatformLabel(platform: string): string {
  return PLATFORM_LABELS[platform as Platform] ?? "Web";
}

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return "just now";
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHr = Math.floor(diffMin / 60);
  if (diffHr < 24) return `${diffHr}h ago`;
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay < 7) return `${diffDay}d ago`;
  return d.toLocaleDateString();
}

function EmptyState({ onGoConfig }: { onGoConfig: () => void }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col justify-center items-center h-full px-8">
      <div className="max-w-md text-center">
        <div className="flex justify-center items-center mx-auto mb-6 w-16 h-16 rounded-2xl bg-accent/10">
          <MessageSquare size={28} className="text-accent" />
        </div>
        <h2 className="mb-2 text-xl font-bold text-text-primary">
          {t("layout.empty.title")}
        </h2>
        <p className="mb-6 text-sm leading-relaxed text-text-muted">
          {t("layout.empty.description")}
        </p>
        <div className="flex flex-col gap-3 items-center">
          <button
            type="button"
            onClick={onGoConfig}
            className="flex gap-2 items-center px-6 py-2.5 text-sm font-medium text-white rounded-lg transition-colors bg-accent hover:bg-accent-hover"
          >
            <Settings size={14} /> {t("layout.empty.setupBot")}
          </button>
          <div className="flex gap-4 mt-2">
            {[
              { step: "1", text: t("layout.empty.step1") },
              { step: "2", text: t("layout.empty.step2") },
              { step: "3", text: t("layout.empty.step3") },
            ].map((s, i) => (
              <div
                key={s.step}
                className="flex gap-1.5 items-center text-[12px] text-text-muted"
              >
                {i > 0 && <span className="text-border mr-1">→</span>}
                <span className="flex justify-center items-center w-4 h-4 rounded-full bg-accent/10 text-[10px] font-semibold text-accent">
                  {s.step}
                </span>
                {s.text}
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const SETUP_COMPLETE_KEY = "nexu_setup_complete";
const GITHUB_URL = "https://github.com/coder-zkl1988/tabby";

const GitHubIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
    <title>GitHub</title>
    <path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0 0 24 12c0-6.63-5.37-12-12-12z" />
  </svg>
);

interface UpdateFloatCardProps {
  phase: ReturnType<typeof useAutoUpdate>["phase"];
  version: string | null;
  percent: number;
  onDownload: () => void;
  onInstall: () => void;
  onDismiss: () => void;
  t: (key: string, options?: Record<string, string>) => string;
  desktopOffsetLeft: number;
  desktopOffsetBottom: number;
  width: number;
}

function UpdateFloatCard({
  phase,
  version,
  percent,
  onDownload,
  onInstall,
  onDismiss,
  t,
  desktopOffsetLeft,
  desktopOffsetBottom,
  width,
}: UpdateFloatCardProps) {
  const updating = phase === "downloading" || phase === "installing";
  const downloadProgress = Math.round(percent);

  if (
    phase !== "available" &&
    phase !== "downloading" &&
    phase !== "installing" &&
    phase !== "ready"
  ) {
    return null;
  }

  return (
    <div
      className="fixed z-50 rounded-[14px] border border-border bg-surface-0/88 px-3.5 py-3 shadow-[0_16px_48px_rgba(0,0,0,0.16)] backdrop-blur-md animate-float"
      style={
        {
          left: desktopOffsetLeft,
          bottom: desktopOffsetBottom,
          width,
          WebkitAppRegion: "no-drag",
        } as React.CSSProperties
      }
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <span className="relative mt-0.5 flex h-2.5 w-2.5 shrink-0">
              <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--color-success)] opacity-75" />
              <span className="relative inline-flex h-2.5 w-2.5 rounded-full bg-[var(--color-success)]" />
            </span>
            <span className="text-[12px] font-medium text-text-primary">
              {phase === "installing"
                ? t("layout.update.installing")
                : updating
                  ? t("layout.update.downloading")
                  : phase === "ready"
                    ? t("layout.update.readyToInstall")
                    : t("layout.update.available", {
                        version: version ?? "",
                      })}
            </span>
          </div>
        </div>
        {!updating && (
          <button
            type="button"
            onClick={onDismiss}
            className="text-text-muted hover:text-text-primary transition-colors -mr-1"
          >
            <X size={12} />
          </button>
        )}
      </div>
      {updating && (
        <div className="flex items-center justify-between mt-3 mb-1">
          <span className="text-[10px] tabular-nums text-text-muted">
            {phase === "installing" ? "…" : `${downloadProgress}%`}
          </span>
        </div>
      )}
      {updating ? (
        <div>
          <div className="h-[6px] w-full rounded-full bg-border overflow-hidden">
            <div
              className="h-full rounded-full bg-[var(--color-brand-primary)] transition-all duration-300 ease-out"
              style={{
                width: phase === "installing" ? "100%" : `${downloadProgress}%`,
              }}
            />
          </div>
        </div>
      ) : phase === "ready" ? (
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={onInstall}
            className="rounded-[6px] px-2.5 py-1 text-[11px] font-medium bg-[var(--color-accent)] text-white hover:opacity-85 transition-opacity"
          >
            {t("layout.update.install")}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-[6px] px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary transition-colors"
          >
            {t("layout.update.later")}
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2 mt-3">
          <button
            type="button"
            onClick={onDownload}
            className="rounded-[6px] px-2.5 py-1 text-[11px] font-medium bg-[var(--color-accent)] text-white hover:opacity-85 transition-opacity"
          >
            {t("layout.update.download")}
          </button>
          <button
            type="button"
            onClick={onDismiss}
            className="rounded-[6px] px-2 py-1 text-[11px] font-medium text-text-muted hover:text-text-primary transition-colors"
          >
            {t("layout.update.later")}
          </button>
        </div>
      )}
    </div>
  );
}

export function WorkspaceLayout() {
  if (localStorage.getItem(SETUP_COMPLETE_KEY) !== "1") {
    return <Navigate to="/" replace />;
  }

  return <WorkspaceLayoutInner />;
}

function WorkspaceLayoutInner() {
  return (
    <A2UISidebarProvider>
      <WorkspaceLayoutContent />
    </A2UISidebarProvider>
  );
}

function WorkspaceLayoutContent() {
  const { t } = useTranslation();
  const isDesktopClient = useMemo(
    () =>
      typeof navigator !== "undefined" &&
      navigator.userAgent.includes("Electron"),
    [],
  );
  const navItemClass =
    "nav-item flex items-center w-full rounded-[var(--radius-6)] text-[13px] transition-colors cursor-pointer mt-0.5 py-2 whitespace-nowrap gap-2.5 px-3";
  const [showLogoutConfirm, setShowLogoutConfirm] = useState(false);
  const [showHelpMenu, setShowHelpMenu] = useState(false);
  const [scheduledCollapsed, setScheduledCollapsed] = useState(true);
  const [sessionSearch, setSessionSearch] = useState("");
  const [sessionFilter, setSessionFilter] =
    useState<SidebarSessionFilter>("all");
  const {
    status: rewardsStatus,
    loading: rewardsStatusLoading,
    resolved: rewardsStatusResolved,
  } = useDesktopRewardsStatus();
  const update = useAutoUpdate();
  const [updateDismissed, setUpdateDismissed] = useState(false);
  const queryClient = useQueryClient();
  const hasUpdate =
    update.phase === "available" ||
    update.phase === "downloading" ||
    update.phase === "installing" ||
    update.phase === "ready";
  const SIDEBAR_MIN = 160;
  const SIDEBAR_MAX = 320;
  const SIDEBAR_DEFAULT = 192;
  const MAIN_MIN = 500;
  // One-click canvas expand leaves the chat column a bit roomier than the
  // hard drag floor so the composer stays comfortable.
  const MAIN_MIN_MAXIMIZED = 600;
  const RIGHT_SIDEBAR_MIN = 320;
  // Loose hard cap — the effective limit is keeping the chat area >= MAIN_MIN.
  const RIGHT_SIDEBAR_MAX = 2400;
  const RIGHT_SIDEBAR_DEFAULT = 420;
  const [sidebarWidth, setSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("nexu_sidebar_width");
    return saved
      ? Math.max(SIDEBAR_MIN, Math.min(SIDEBAR_MAX, Number(saved)))
      : SIDEBAR_DEFAULT;
  });
  const isResizing = useRef(false);
  const { isOpen: canvasSidebarOpen, close: closeCanvasSidebar } =
    useA2UISidebar();
  const browserPanel = useBrowserPanel();
  const pinnedPanel = usePinnedPanel();
  // Listens from the layout, not the panel: the agent's first command is
  // usually the one that opens the panel.
  const rightSidebarOpen =
    canvasSidebarOpen || browserPanel.isOpen || pinnedPanel.isOpen;
  const [rightSidebarWidth, setRightSidebarWidth] = useState(() => {
    const saved = localStorage.getItem("nexu_right_sidebar_width");
    return saved
      ? Math.max(RIGHT_SIDEBAR_MIN, Math.min(RIGHT_SIDEBAR_MAX, Number(saved)))
      : RIGHT_SIDEBAR_DEFAULT;
  });
  const isRightResizing = useRef(false);
  // One-click workbench expand: grow the canvas until the chat main area is
  // exactly MAIN_MIN_MAXIMIZED wide; toggling back restores the previous width.
  const [rightSidebarMaximized, setRightSidebarMaximized] = useState(false);
  const preMaximizeWidthRef = useRef(RIGHT_SIDEBAR_DEFAULT);
  const toggleRightSidebarMaximize = useCallback(() => {
    setRightSidebarMaximized((maximized) => {
      if (maximized) {
        setRightSidebarWidth(preMaximizeWidthRef.current);
        return false;
      }
      preMaximizeWidthRef.current = rightSidebarWidth;
      setRightSidebarWidth(
        Math.max(
          RIGHT_SIDEBAR_MIN,
          window.innerWidth - sidebarWidth - MAIN_MIN_MAXIMIZED,
        ),
      );
      return true;
    });
  }, [rightSidebarWidth, sidebarWidth]);

  // Re-clamp the workbench width whenever the window shrinks (e.g. moving from
  // an external monitor to the 14" built-in display). Without this, a width
  // saved or maximized on a wider screen exceeds the current window: the chat
  // column (flex-1 min-w-0) collapses to zero and the panel's restore button
  // ends up off-screen, leaving no way to recover. Runs once on mount too, to
  // catch stale localStorage values.
  useEffect(() => {
    if (!rightSidebarOpen) return;
    const clampToWindow = () => {
      setRightSidebarWidth((width) => {
        const target = rightSidebarMaximized
          ? window.innerWidth - sidebarWidth - MAIN_MIN_MAXIMIZED
          : Math.min(width, window.innerWidth - sidebarWidth - MAIN_MIN);
        return Math.max(RIGHT_SIDEBAR_MIN, target);
      });
    };
    clampToWindow();
    window.addEventListener("resize", clampToWindow);
    return () => window.removeEventListener("resize", clampToWindow);
  }, [rightSidebarOpen, rightSidebarMaximized, sidebarWidth]);

  const handleRightResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isRightResizing.current = true;
      const startX = e.clientX;
      const startW = rightSidebarWidth;

      const onMove = (ev: MouseEvent) => {
        if (!isRightResizing.current) return;
        const containerWidth = window.innerWidth;
        const newW = Math.max(
          RIGHT_SIDEBAR_MIN,
          Math.min(RIGHT_SIDEBAR_MAX, startW - (ev.clientX - startX)),
        );
        if (containerWidth - newW >= MAIN_MIN) {
          setRightSidebarWidth(newW);
        }
      };

      const onUp = () => {
        isRightResizing.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setRightSidebarWidth((w) => {
          localStorage.setItem("nexu_right_sidebar_width", String(w));
          return w;
        });
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [rightSidebarWidth],
  );

  const handleResizeStart = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      isResizing.current = true;
      const startX = e.clientX;
      const startW = sidebarWidth;

      const onMove = (ev: MouseEvent) => {
        if (!isResizing.current) return;
        const containerWidth = window.innerWidth;
        const newW = Math.max(
          SIDEBAR_MIN,
          Math.min(SIDEBAR_MAX, startW + (ev.clientX - startX)),
        );
        if (containerWidth - newW >= MAIN_MIN) {
          setSidebarWidth(newW);
        }
      };

      const onUp = () => {
        isResizing.current = false;
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.style.cursor = "";
        document.body.style.userSelect = "";
        setSidebarWidth((w) => {
          localStorage.setItem("nexu_sidebar_width", String(w));
          return w;
        });
      };

      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [sidebarWidth],
  );

  const [showBalancePopup, setShowBalancePopup] = useState(false);
  const logoutRef = useRef<HTMLDivElement>(null);
  const helpRef = useRef<HTMLDivElement>(null);
  const balanceRef = useRef<HTMLDivElement>(null);
  const location = useLocation();
  const navigate = useNavigate();
  const previousSessionPathRef = useRef<string | null>(null);

  // The right workbench belongs to the session conversation — close every mode
  // when leaving sessions, and close the browser when switching sessions so
  // one conversation never displays another conversation's page.
  //
  // This list must cover every contributor to `rightSidebarOpen` above. The
  // pinned panel was added as a third mode and only ever cleared from the
  // sessions page's `id` effect, which fires on session-to-session moves but
  // not on unmount — so leaving for 设备 or 首页 left a conversation's pinned
  // cards on screen (reported 2026-09-20).
  const isSessionRoute = location.pathname.startsWith("/workspace/sessions");
  useEffect(() => {
    const previousSessionPath = previousSessionPathRef.current;
    previousSessionPathRef.current = isSessionRoute ? location.pathname : null;

    if (!isSessionRoute && rightSidebarOpen) {
      closeCanvasSidebar();
      closeBrowserPanelForRouting();
      // Clears the active session rather than collapsing the panel: the pins
      // themselves survive, so coming back to that conversation restores them.
      setActivePinnedSession(null);
      return;
    }

    // Leaving sessions entirely still closes a user-opened browser; switching
    // BETWEEN sessions no longer does. The panel belongs to the session that
    // opened it, so it is hidden elsewhere and restored on return — handled by
    // syncBrowserPanelToSession once the session key for this route is known.
    if (previousSessionPath === null) {
      closeBrowserPanelForSessionNavigation(
        previousSessionPath,
        location.pathname,
      );
    }
  }, [isSessionRoute, location.pathname, rightSidebarOpen, closeCanvasSidebar]);
  const { data: session } = authClient.useSession();
  const { data: skillsData } = useCommunitySkillStatus();
  const {
    data: desktopCloudStatus,
    isLoading: cloudStatusLoading,
    refetch: refetchDesktopCloudStatus,
  } = useDesktopCloudStatus();
  const installedSkillsCount = skillsData?.installedSkills?.length ?? 0;
  const cloudConnected = desktopCloudStatus?.connected ?? false;
  const { cloudConnecting, handleCloudConnect } = useCloudConnect({
    cloudConnected,
    onPoll: refetchDesktopCloudStatus,
  });

  useEffect(() => {
    track("workspace_view");
  }, []);

  useEffect(() => {
    if (!isDesktopClient) {
      return;
    }

    const root = document.getElementById("root");
    const previousHtmlBackground =
      document.documentElement.style.backgroundColor;
    const previousBodyBackground = document.body.style.backgroundColor;
    const previousRootBackground = root?.style.backgroundColor ?? "";
    document.documentElement.style.backgroundColor = "transparent";
    document.body.style.backgroundColor = "transparent";
    if (root) {
      root.style.backgroundColor = "transparent";
    }

    return () => {
      document.documentElement.style.backgroundColor = previousHtmlBackground;
      document.body.style.backgroundColor = previousBodyBackground;
      if (root) {
        root.style.backgroundColor = previousRootBackground;
      }
    };
  }, [isDesktopClient]);

  useEffect(() => {
    if (!showLogoutConfirm) return;
    const handler = (e: MouseEvent) => {
      if (logoutRef.current && !logoutRef.current.contains(e.target as Node)) {
        setShowLogoutConfirm(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showLogoutConfirm]);

  useEffect(() => {
    if (!showHelpMenu) return;
    const handler = (e: MouseEvent) => {
      if (helpRef.current && !helpRef.current.contains(e.target as Node)) {
        setShowHelpMenu(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showHelpMenu]);

  useEffect(() => {
    if (!showBalancePopup) return;
    const handler = (e: MouseEvent) => {
      const target = e.target as Node;
      const portalEl = document.querySelector(
        "[data-sidebar-rewards-balance-popup]",
      );
      if (
        balanceRef.current &&
        !balanceRef.current.contains(target) &&
        (!portalEl || !portalEl.contains(target))
      ) {
        setShowBalancePopup(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [showBalancePopup]);

  const sessionsQuery = useQuery({
    queryKey: ["sidebar-sessions"],
    queryFn: async (): Promise<SidebarSession[]> => {
      const { data, error } = await getApiV1Sessions({
        query: { limit: 500, archived: "include" },
      });
      if (error || !data) {
        throw new Error("session list unavailable");
      }
      return data.sessions.map(mapDbSession);
    },
    refetchInterval: 10_000,
  });
  const sessionsData = sessionsQuery.data;
  const { data: me } = useQuery({
    queryKey: ["me"],
    queryFn: async () => {
      const { data } = await getApiV1Me();
      return data;
    },
  });

  const deleteSessionMutation = useMutation({
    mutationFn: deleteSidebarSession,
    onSuccess: (_data, deletedId) => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-sessions"] });
      // The agent browser view lives in the main process under an id derived
      // from the session key; deleting the conversation does not reach it, so
      // without this its page outlives the session that opened it.
      const deletedKey = sessions.find(
        (candidate) => candidate.id === deletedId,
      )?.sessionKey;
      if (deletedKey) void forgetBrowserSession(deletedKey);
      forgetPinnedSession(deletedId);
      // If the deleted session is currently viewed, navigate away
      if (selectedSessionId === deletedId) {
        navigate("/workspace");
      }
    },
    onError: () => {
      setSessionActionError(t("layout.deleteSessionFailed"));
    },
  });

  // --- Session management (rename / archive / fork), OpenClaw >=2026.7.1 ---
  const [sessionMenuId, setSessionMenuId] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{
    id: string;
    title: string;
  } | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const [groupTarget, setGroupTarget] = useState<{
    id: string;
    category: string | null;
  } | null>(null);
  const [groupValue, setGroupValue] = useState("");
  const [recoveryTarget, setRecoveryTarget] = useState<SidebarSession | null>(
    null,
  );
  const [sessionActionError, setSessionActionError] = useState<string | null>(
    null,
  );

  useEffect(() => {
    if (!sessionMenuId) return;
    const close = () => setSessionMenuId(null);
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [sessionMenuId]);

  useEffect(() => {
    if (!sessionActionError) return;
    const timer = setTimeout(() => setSessionActionError(null), 5000);
    return () => clearTimeout(timer);
  }, [sessionActionError]);

  const renameSessionMutation = useMutation({
    mutationFn: renameSidebarSession,
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-sessions"] });
      queryClient.invalidateQueries({ queryKey: ["sessions-recent"] });
      setRenameTarget(null);
    },
    onError: () => {
      setSessionActionError(t("layout.renameSessionFailed"));
    },
  });

  const archiveSessionMutation = useMutation({
    mutationFn: async (input: { id: string; archived: boolean }) => {
      const { error } = await postApiV1SessionsByIdArchive({
        path: { id: input.id },
        body: { archived: input.archived },
      });
      if (error) {
        throw new Error(
          (error as { message?: string }).message ?? "archive failed",
        );
      }
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-sessions"] });
      if (input.archived && selectedSessionId === input.id) {
        navigate("/workspace");
      }
    },
    onError: (err) => {
      setSessionActionError(err instanceof Error ? err.message : String(err));
    },
  });

  const organizationSessionMutation = useMutation({
    mutationFn: async (input: {
      id: string;
      category?: string;
      clearCategory?: boolean;
      pinned?: boolean;
      unread?: boolean;
    }) => {
      const { id, ...body } = input;
      const { error } = await patchApiV1SessionsByIdOrganization({
        path: { id },
        body,
      });
      if (error) {
        throw new Error(
          (error as { message?: string }).message ??
            "session organization update failed",
        );
      }
    },
    onSuccess: (_data, input) => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-sessions"] });
      if (input.category !== undefined || input.clearCategory) {
        setGroupTarget(null);
      }
    },
    onError: (err) => {
      setSessionActionError(err instanceof Error ? err.message : String(err));
    },
  });

  const forkSessionMutation = useMutation({
    mutationFn: async (sessionId: string) => {
      const { data, error } = await postApiV1SessionsByIdFork({
        path: { id: sessionId },
      });
      if (error) {
        throw new Error(
          (error as { message?: string }).message ?? "fork failed",
        );
      }
      return data;
    },
    onSuccess: (forked) => {
      queryClient.invalidateQueries({ queryKey: ["sidebar-sessions"] });
      if (forked?.id) {
        navigate(`/workspace/sessions/${forked.id}`);
      }
    },
    onError: (err) => {
      setSessionActionError(err instanceof Error ? err.message : String(err));
    },
  });

  const sessions = sessionsData ?? [];
  const visibleSessions = sortSidebarSessions(
    filterSidebarSessions(sessions, sessionSearch, sessionFilter),
  );
  const scheduledSectionForcedOpen =
    (sessionFilter !== "all" && sessionFilter !== "conversations") ||
    sessionSearch.trim().length > 0;
  const scheduledSectionExpanded = isScheduledSessionSectionExpanded({
    collapsed: scheduledCollapsed,
    filter: sessionFilter,
    search: sessionSearch,
  });

  const sessionMatch = location.pathname.match(/\/workspace\/sessions\/(.+)/);
  const selectedSessionId = sessionMatch?.[1] ?? null;
  /**
   * The browser panel belongs to the session that opened it — above all to an
   * agent working in it. Show it only there: hiding elsewhere never disposes
   * the view, so an agent mid-task keeps running off screen and the page
   * resumes when its own session is opened again.
   */
  const selectedSessionKey =
    sessions.find((candidate) => candidate.id === selectedSessionId)
      ?.sessionKey ?? null;
  useEffect(() => {
    syncBrowserPanelToSession(selectedSessionKey);
  }, [selectedSessionKey]);

  /**
   * The canvas panel's VISIBILITY follows the conversation, the way the
   * browser and pinned panels do: opening it in one session must not leave it
   * covering the next one. Its CONTENT stays global — boards are named by the
   * user ("画布 1"), shared across conversations on purpose, so they are not
   * re-keyed per session here.
   */
  const canvasOpenBySessionRef = useRef(new Map<string, boolean>());
  const canvasOpenRef = useRef(canvasSidebarOpen);
  canvasOpenRef.current = canvasSidebarOpen;
  const previousCanvasSessionRef = useRef<string | null>(null);
  useEffect(() => {
    const previous = previousCanvasSessionRef.current;
    if (previous === selectedSessionId) return;
    previousCanvasSessionRef.current = selectedSessionId;
    if (previous) {
      canvasOpenBySessionRef.current.set(previous, canvasOpenRef.current);
    }
    setPanelOpen(
      selectedSessionId
        ? (canvasOpenBySessionRef.current.get(selectedSessionId) ?? false)
        : false,
    );
  }, [selectedSessionId]);
  const isHomePage =
    location.pathname === "/workspace" ||
    location.pathname === "/workspace/home";
  const isRewardsPage = location.pathname.includes("/rewards");
  const isSkillsPage = location.pathname.includes("/skills");
  const isExpertsPage = location.pathname.includes("/experts");
  const isTeamsPage = location.pathname.includes("/teams");
  const isLocalChatPage = location.pathname === "/workspace/chat";
  const isModelsPage =
    location.pathname.includes("/models") ||
    location.pathname.includes("/settings");
  const isDevicesPage = location.pathname.includes("/devices");

  const handleLogout = async () => {
    setShowLogoutConfirm(false);
    track("workspace_logout_click");
    await logoutToWelcome({ queryClient });
  };

  const userEmail = me?.email ?? session?.user?.email ?? "";
  const userName = me?.name?.trim() || session?.user?.name || userEmail;
  const userImage = me?.image ?? session?.user?.image ?? null;
  const userInitial = (userName[0] ?? userEmail[0] ?? "U").toUpperCase();
  const rewardsBalancePending =
    cloudConnected &&
    !rewardsStatus.cloudBalance &&
    (rewardsStatusLoading || !rewardsStatusResolved);
  const canOpenBalancePopup =
    cloudConnected || rewardsStatus.cloudBalance !== null;
  const rewardBalanceValue = rewardsStatus.cloudBalance
    ? formatUsdCents(rewardsStatus.cloudBalance.totalBalance)
    : cloudConnected
      ? rewardsBalancePending
        ? t("layout.sidebar.balancePlaceholder")
        : formatUsdCents(0)
      : t("layout.sidebar.balancePlaceholder");
  const rewardBalancePopupValue = rewardsStatus.cloudBalance
    ? formatUsdCents(rewardsStatus.cloudBalance.totalBalance)
    : rewardBalanceValue;
  const sidebarCreditBreakdown = getSidebarCreditBreakdown({
    progress: rewardsStatus.progress,
    cloudBalance: rewardsStatus.cloudBalance,
  });
  const rewardsCardLoading =
    cloudStatusLoading && desktopCloudStatus === undefined;
  const { bannerDismissible, budgetStatus, dismissBanner, shouldShowPrompt } =
    useDesktopBudgetGuard({
      pathname: location.pathname,
      cloudConnected,
    });
  const budgetBannerRouteVariant = getBudgetBannerRouteVariant(
    location.pathname,
  );

  const showEmptyState =
    sessions.length === 0 &&
    !isHomePage &&
    !isRewardsPage &&
    !isSkillsPage &&
    !isExpertsPage &&
    !isTeamsPage &&
    !isModelsPage &&
    !isDevicesPage &&
    !isLocalChatPage &&
    !location.pathname.includes("/automations") &&
    !location.pathname.includes("/integrations") &&
    !location.pathname.includes("/channels") &&
    !selectedSessionId;

  const _selectedSession = selectedSessionId
    ? sessions.find((s) => s.id === selectedSessionId)
    : null;
  const isWindowsDesktopClient = isDesktopClient && isWindowsDesktopPlatform();
  const isMacDesktopClient = isDesktopClient && isMacDesktopPlatform();
  const desktopGlassTint = isWindowsDesktopClient
    ? "#ffffff"
    : "rgba(255, 255, 255, 0.08)";
  const updateFloatLeft = 10;
  // Match the sidebar width (with a 10px gutter on each side) so the update card
  // sits inside the rail instead of overflowing into the main content area, and
  // tracks the sidebar when the user resizes it.
  const updateFloatWidth = sidebarWidth - updateFloatLeft * 2;
  const updateFloatBottom = 80;

  return (
    <div
      className="flex h-screen relative overflow-hidden"
      style={
        isDesktopClient
          ? ({ background: desktopGlassTint } as React.CSSProperties)
          : undefined
      }
    >
      {!isDesktopClient && hasUpdate && !updateDismissed && (
        <UpdateFloatCard
          phase={update.phase}
          version={update.version}
          percent={update.percent}
          onDownload={() => update.download()}
          onInstall={() => update.install()}
          onDismiss={() => setUpdateDismissed(true)}
          t={t}
          desktopOffsetLeft={updateFloatLeft}
          desktopOffsetBottom={updateFloatBottom}
          width={updateFloatWidth}
        />
      )}

      {/* Desktop sidebar — transparent bg, no border (matches design-system) */}
      <div
        className="hidden md:flex flex-col shrink-0 overflow-hidden"
        style={
          {
            width: sidebarWidth,
            transition: isResizing.current ? "none" : "width 200ms",
            WebkitAppRegion: "drag",
            background: isDesktopClient
              ? desktopGlassTint
              : "var(--color-tabby-sidebar)",
          } as React.CSSProperties
        }
      >
        {/* Traffic light clearance (desktop client) */}
        {!isWindowsDesktopClient && <div className={cn("shrink-0", "h-14")} />}

        {/* Header / Brand */}
        {!isWindowsDesktopClient && (
          <div
            className={cn(
              "flex items-center justify-between px-3 pb-2 shrink-0",
              isMacDesktopClient && "px-4 pb-1",
              !isDesktopClient && "border-b border-border py-3 px-4 gap-2.5",
            )}
            style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
          >
            {isDesktopClient ? (
              <>
                <img
                  src="/images/happytabby-logo.png"
                  alt="Tabby"
                  className="h-10 object-contain"
                />
                {hasUpdate && updateDismissed && (
                  <button
                    type="button"
                    onClick={() => setUpdateDismissed(false)}
                    className="rounded-full px-2 py-0.5 text-[10px] font-semibold bg-[var(--color-brand-primary)] text-white hover:opacity-85 transition-opacity"
                  >
                    {t("layout.update.badge")}
                  </button>
                )}
              </>
            ) : (
              <>
                <img
                  src="/images/happytabby-logo.png"
                  alt="Tabby"
                  className="h-10 w-auto shrink-0"
                />
              </>
            )}
          </div>
        )}

        {isWindowsDesktopClient && <div className="h-8 shrink-0" />}

        {/* Main nav + conversations. The nav stays fixed; only the
            conversation list scrolls (long session lists used to scroll the
            whole sidebar, hiding the nav). */}
        <div
          className="flex min-h-0 flex-1 flex-col overflow-hidden"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {/* Nav items */}
          <div className="shrink-0 px-2 pt-3 pb-1">
            <Link
              to="/workspace/home"
              title={t("layout.nav.home")}
              onClick={() => {
                track("workspace_home_click");
                track("workspace_sidebar_click", { target: "home" });
              }}
              className={cn(navItemClass, isHomePage && "nav-item-active")}
            >
              <Home size={16} className="shrink-0" />
              {t("layout.nav.home")}
            </Link>
            <Link
              to="/workspace/chat"
              title={t("layout.nav.newChat")}
              onClick={() => {
                track("workspace_sidebar_click", { target: "local-chat" });
              }}
              className={cn(navItemClass, isLocalChatPage && "nav-item-active")}
            >
              <CirclePlus size={16} className="shrink-0" />
              {t("layout.nav.newChat")}
            </Link>
            <Link
              to="/workspace/skills"
              title={t("layout.nav.skillStore")}
              onClick={() => {
                track("workspace_skills_click");
                track("workspace_sidebar_click", { target: "skills" });
              }}
              className={cn(navItemClass, isSkillsPage && "nav-item-active")}
            >
              <Puzzle size={16} className="shrink-0" />
              {t("layout.nav.skillStore")}
              {installedSkillsCount > 0 && (
                <span className="ml-auto text-[10px] text-text-tertiary font-normal">
                  {installedSkillsCount}
                </span>
              )}
            </Link>
            <Link
              to="/workspace/automations"
              title={t("layout.nav.automations")}
              onClick={() => {
                track("workspace_sidebar_click", { target: "automations" });
              }}
              className={cn(
                navItemClass,
                location.pathname.includes("/automations") && "nav-item-active",
              )}
            >
              <Sparkles size={16} className="shrink-0" />
              {t("layout.nav.automations")}
            </Link>
            <Link
              to="/workspace/experts"
              title={t("layout.nav.agents")}
              onClick={() => {
                track("workspace_experts_click");
                track("workspace_sidebar_click", { target: "experts" });
              }}
              className={cn(navItemClass, isExpertsPage && "nav-item-active")}
            >
              <Bot size={16} className="shrink-0" />
              {t("layout.nav.agents")}
            </Link>
            <Link
              to="/workspace/teams"
              title={t("layout.nav.teams")}
              onClick={() => {
                track("workspace_sidebar_click", { target: "teams" });
              }}
              className={cn(navItemClass, isTeamsPage && "nav-item-active")}
            >
              <UsersRound size={16} className="shrink-0" />
              {t("layout.nav.teams")}
            </Link>
            <Link
              to="/workspace/devices"
              title={t("layout.nav.devices")}
              onClick={() => {
                track("workspace_sidebar_click", { target: "devices" });
              }}
              className={cn(navItemClass, isDevicesPage && "nav-item-active")}
            >
              <Smartphone size={16} className="shrink-0" />
              {t("layout.nav.devices")}
            </Link>
          </div>

          {/* Conversations section */}
          <div className="flex min-h-0 flex-1 flex-col px-2 pt-6">
            <div
              data-session-controls="true"
              className="flex shrink-0 items-center gap-2"
            >
              <div className="w-[84px] shrink-0">
                <Select
                  value={sessionFilter}
                  onValueChange={(value) =>
                    setSessionFilter(value as SidebarSessionFilter)
                  }
                >
                  <SelectTrigger
                    data-session-filter="true"
                    aria-label={t("layout.sessionFilter")}
                    className="h-7 w-full border-border bg-surface-0 px-2 text-[10px] text-text-muted shadow-none focus:ring-1 focus:ring-[var(--color-brand-primary)]"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent
                    align="end"
                    className="border-border bg-surface-0 text-text-primary"
                  >
                    <SelectItem
                      value="all"
                      className="text-[11px] focus:text-accent-fg data-[highlighted]:text-accent-fg"
                    >
                      {t("layout.sessionFilterAll")}
                    </SelectItem>
                    <SelectItem
                      value="conversations"
                      className="text-[11px] focus:text-accent-fg data-[highlighted]:text-accent-fg"
                    >
                      {t("layout.sessionFilterConversations")}
                    </SelectItem>
                    <SelectItem
                      value="scheduled"
                      className="text-[11px] focus:text-accent-fg data-[highlighted]:text-accent-fg"
                    >
                      {t("layout.sessionFilterScheduled")}
                    </SelectItem>
                    <SelectItem
                      value="unread"
                      className="text-[11px] focus:text-accent-fg data-[highlighted]:text-accent-fg"
                    >
                      {t("layout.sessionFilterUnread")}
                    </SelectItem>
                    <SelectItem
                      value="running"
                      className="text-[11px] focus:text-accent-fg data-[highlighted]:text-accent-fg"
                    >
                      {t("layout.sessionFilterRunning")}
                    </SelectItem>
                    <SelectItem
                      value="failed"
                      className="text-[11px] focus:text-accent-fg data-[highlighted]:text-accent-fg"
                    >
                      {t("layout.sessionFilterFailed")}
                    </SelectItem>
                    <SelectItem
                      value="archived"
                      className="text-[11px] focus:text-accent-fg data-[highlighted]:text-accent-fg"
                    >
                      {t("layout.sessionFilterArchived")}
                    </SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <label className="relative min-w-0 flex-1">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3 -translate-y-1/2 text-text-tertiary" />
                <input
                  data-session-search="true"
                  type="search"
                  value={sessionSearch}
                  onChange={(event) => setSessionSearch(event.target.value)}
                  placeholder={t("layout.searchConversations")}
                  className="h-7 w-full rounded-md border border-border bg-surface-0 pl-7 pr-2 text-[11px] text-text-primary outline-none placeholder:text-text-tertiary focus:border-[var(--color-brand-primary)]"
                />
              </label>
            </div>
            <div className="mt-2 min-h-0 flex-1 space-y-3 overflow-y-auto">
              {sessionsQuery.isPending && (
                <div
                  data-session-list-loading="true"
                  className="px-2 py-6 text-center text-[11px] text-text-muted"
                >
                  {t("layout.sessionsLoading")}
                </div>
              )}
              {sessionsQuery.isError && (
                <div
                  data-session-list-unavailable="true"
                  className="px-2 py-6 text-center text-[11px] text-text-muted"
                >
                  <div>{t("layout.sessionsUnavailable")}</div>
                  <button
                    type="button"
                    data-session-list-retry="true"
                    onClick={() => sessionsQuery.refetch()}
                    className="mx-auto mt-2 flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-text-primary hover:bg-surface-2"
                  >
                    <RefreshCw className="size-3" />
                    {t("layout.retrySessions")}
                  </button>
                </div>
              )}
              {sessionsQuery.isSuccess && visibleSessions.length === 0 && (
                <div
                  data-session-filter-empty="true"
                  className="px-2 py-6 text-center text-[11px] text-text-muted"
                >
                  {t("layout.noMatchingConversations")}
                </div>
              )}
              {(() => {
                // Split sessions into regular and scheduled
                const regularSessions = visibleSessions.filter(
                  (s) => !s.sessionKey.includes(":schedule-"),
                );
                const scheduledSessions = visibleSessions.filter((s) =>
                  s.sessionKey.includes(":schedule-"),
                );

                // Keep meaningful user organization visible, while leaving
                // ordinary conversations as one unlabelled list.
                const regularGroups = Object.entries(
                  regularSessions.reduce(
                    (acc, s) => {
                      const key = s.pinned
                        ? "pinned"
                        : s.category
                          ? `category:${s.category}`
                          : "default";
                      const group = acc[key] ?? [];
                      group.push(s);
                      acc[key] = group;
                      return acc;
                    },
                    {} as Record<string, SidebarSession[]>,
                  ),
                );

                return (
                  <>
                    {regularGroups.map(([channelType, groupSessions]) => (
                      <div key={channelType}>
                        {channelType !== "default" && (
                          <div
                            data-session-group-heading={channelType}
                            className="mb-1 flex items-center gap-1.5 px-2 text-[10px] font-medium text-text-muted"
                          >
                            {channelType === "pinned" && (
                              <Pin className="size-3" />
                            )}
                            <span className="truncate">
                              {channelType === "pinned"
                                ? t("layout.pinnedSessions")
                                : channelType.slice("category:".length)}
                            </span>
                            <span className="ml-auto text-[9px] text-text-tertiary">
                              {groupSessions.length}
                            </span>
                          </div>
                        )}
                        <div className="space-y-0.5">
                          {groupSessions.map((s) => {
                            const isActive = selectedSessionId === s.id;
                            return (
                              <div
                                key={s.id}
                                data-sidebar-session-row={s.id}
                                data-session-channel-type={
                                  s.channelType ?? "web"
                                }
                                data-session-state={s.status || "idle"}
                                data-session-run-state={s.runState}
                                data-session-unread={
                                  s.unread ? "true" : "false"
                                }
                                data-session-pinned={
                                  s.pinned ? "true" : "false"
                                }
                                className={cn(
                                  "group flex items-center gap-2.5 w-full rounded-[10px] transition-colors cursor-pointer px-3 py-2 text-left",
                                  isActive && "nav-item-active",
                                  s.archived && "opacity-70",
                                )}
                              >
                                <button
                                  type="button"
                                  onClick={() => {
                                    if (s.archived) return;
                                    const channel = normalizeChannel(
                                      s.channelType,
                                    );
                                    track("workspace_channel_click", {
                                      channel_type: s.channelType,
                                    });
                                    track("workspace_sidebar_click", {
                                      target: "conversations",
                                      ...(channel ? { channel } : {}),
                                    });
                                    if (s.unread) {
                                      organizationSessionMutation.mutate({
                                        id: s.id,
                                        unread: false,
                                      });
                                    }
                                    navigate(`/workspace/sessions/${s.id}`);
                                  }}
                                  className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                                >
                                  <SidebarPlatformIcon
                                    platform={s.channelType ?? "web"}
                                  />
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-2 min-w-0">
                                      <div
                                        className={cn(
                                          "text-[12px] truncate whitespace-nowrap",
                                          s.unread
                                            ? "font-semibold"
                                            : "font-medium",
                                          !isActive && "text-text-primary",
                                        )}
                                      >
                                        {s.title}
                                      </div>
                                      {s.pinned && (
                                        <Pin className="size-3 shrink-0 text-text-muted" />
                                      )}
                                      {s.unread && (
                                        <span
                                          aria-label={t("layout.unreadSession")}
                                          className="size-1.5 shrink-0 rounded-full bg-[var(--color-brand-primary)]"
                                        />
                                      )}
                                      {s.runState !== "idle" && (
                                        <span
                                          className={cn(
                                            "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                                            s.runState === "running"
                                              ? "bg-[var(--color-success-subtle)] text-[var(--color-success)]"
                                              : "bg-[var(--color-danger-subtle)] text-danger",
                                          )}
                                        >
                                          {t(
                                            s.runState === "running"
                                              ? "layout.sessionRunning"
                                              : "layout.sessionFailed",
                                          )}
                                        </span>
                                      )}
                                    </div>
                                    <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted truncate whitespace-nowrap">
                                      <span>
                                        {getPlatformLabel(
                                          s.channelType ?? "web",
                                        )}
                                      </span>
                                      <span className="text-border">·</span>
                                      <span>{formatTime(s.lastTime)}</span>
                                    </div>
                                  </div>
                                </button>
                                <div className="relative flex items-center gap-1 shrink-0">
                                  {s.runState === "running" && (
                                    <div className="size-2 shrink-0 animate-pulse rounded-full bg-[var(--color-success)]" />
                                  )}
                                  {s.runState === "failed" && (
                                    <div className="size-2 shrink-0 rounded-full bg-danger" />
                                  )}
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      setSessionMenuId(
                                        sessionMenuId === s.id ? null : s.id,
                                      );
                                    }}
                                    className={cn(
                                      "opacity-0 group-hover:opacity-100 transition-opacity p-1 rounded-md hover:bg-surface-2 text-text-muted hover:text-text-primary",
                                      sessionMenuId === s.id && "opacity-100",
                                    )}
                                    title={t("layout.sessionActions")}
                                  >
                                    <MoreHorizontal className="w-3.5 h-3.5" />
                                  </button>
                                  {sessionMenuId === s.id && (
                                    <div
                                      className="absolute right-0 top-full z-50 mt-1 w-44 rounded-lg border border-border bg-surface-0 py-1 shadow-lg"
                                      onMouseDown={(e) => e.stopPropagation()}
                                    >
                                      {!s.archived && (
                                        <>
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-surface-2"
                                            onClick={() => {
                                              setSessionMenuId(null);
                                              setRenameTarget({
                                                id: s.id,
                                                title: s.title,
                                              });
                                              setRenameValue(s.title);
                                            }}
                                          >
                                            <Pencil className="size-3" />
                                            {t("layout.renameSession")}
                                          </button>
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-surface-2"
                                            onClick={() => {
                                              setSessionMenuId(null);
                                              organizationSessionMutation.mutate(
                                                {
                                                  id: s.id,
                                                  pinned: !s.pinned,
                                                },
                                              );
                                            }}
                                          >
                                            {s.pinned ? (
                                              <PinOff className="size-3" />
                                            ) : (
                                              <Pin className="size-3" />
                                            )}
                                            {t(
                                              s.pinned
                                                ? "layout.unpinSession"
                                                : "layout.pinSession",
                                            )}
                                          </button>
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-surface-2"
                                            onClick={() => {
                                              setSessionMenuId(null);
                                              organizationSessionMutation.mutate(
                                                {
                                                  id: s.id,
                                                  unread: !s.unread,
                                                },
                                              );
                                            }}
                                          >
                                            {s.unread ? (
                                              <MailOpen className="size-3" />
                                            ) : (
                                              <Mail className="size-3" />
                                            )}
                                            {t(
                                              s.unread
                                                ? "layout.markSessionRead"
                                                : "layout.markSessionUnread",
                                            )}
                                          </button>
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-surface-2"
                                            onClick={() => {
                                              setSessionMenuId(null);
                                              setGroupTarget({
                                                id: s.id,
                                                category: s.category,
                                              });
                                              setGroupValue(s.category ?? "");
                                            }}
                                          >
                                            <FolderInput className="size-3" />
                                            {t("layout.moveSessionToGroup")}
                                          </button>
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-surface-2"
                                            onClick={() => {
                                              setSessionMenuId(null);
                                              setRecoveryTarget(s);
                                            }}
                                          >
                                            <History className="size-3" />
                                            {t("layout.recoverSession")}
                                          </button>
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-surface-2"
                                            onClick={() => {
                                              setSessionMenuId(null);
                                              forkSessionMutation.mutate(s.id);
                                            }}
                                          >
                                            <GitBranch className="size-3" />
                                            {t("layout.forkSession")}
                                          </button>
                                          <button
                                            type="button"
                                            className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-surface-2"
                                            onClick={() => {
                                              setSessionMenuId(null);
                                              archiveSessionMutation.mutate({
                                                id: s.id,
                                                archived: true,
                                              });
                                            }}
                                          >
                                            <Archive className="size-3" />
                                            {t("layout.archiveSession")}
                                          </button>
                                        </>
                                      )}
                                      {s.archived && (
                                        <button
                                          type="button"
                                          className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-text-primary hover:bg-surface-2"
                                          onClick={() => {
                                            setSessionMenuId(null);
                                            archiveSessionMutation.mutate({
                                              id: s.id,
                                              archived: false,
                                            });
                                          }}
                                        >
                                          <ArchiveRestore className="size-3" />
                                          {t("layout.restoreSession")}
                                        </button>
                                      )}
                                      <button
                                        type="button"
                                        className="flex w-full items-center gap-2 px-3 py-1.5 text-[12px] text-danger hover:bg-surface-2"
                                        onClick={() => {
                                          setSessionMenuId(null);
                                          deleteSessionMutation.mutate(s.id);
                                        }}
                                      >
                                        <Trash2 className="size-3" />
                                        {t("layout.deleteSession")}
                                      </button>
                                    </div>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      </div>
                    ))}

                    {/* Scheduled tasks section */}
                    {scheduledSessions.length > 0 && (
                      <div>
                        <button
                          type="button"
                          aria-expanded={scheduledSectionExpanded}
                          disabled={scheduledSectionForcedOpen}
                          onClick={() =>
                            setScheduledCollapsed(!scheduledCollapsed)
                          }
                          className="flex w-full cursor-pointer items-center gap-2 px-1 py-1.5 text-[12px] text-text-muted transition-colors hover:text-text-primary disabled:cursor-default"
                        >
                          <ChevronRight
                            size={12}
                            className={cn(
                              "transition-transform",
                              scheduledSectionExpanded && "rotate-90",
                            )}
                          />
                          <Clock size={12} />
                          <span>{t("layout.scheduledTasks", "定时任务")}</span>
                          <span className="ml-auto text-[10px] text-text-muted/60">
                            {scheduledSessions.length}
                          </span>
                        </button>
                        {scheduledSectionExpanded && (
                          <div className="space-y-0.5 mt-1">
                            {scheduledSessions.map((s) => {
                              const isActive = selectedSessionId === s.id;
                              return (
                                <div
                                  key={s.id}
                                  data-sidebar-session-row={s.id}
                                  data-session-channel-type={
                                    s.channelType ?? "web"
                                  }
                                  data-session-state={s.status || "idle"}
                                  data-session-run-state={s.runState}
                                  className={cn(
                                    "group flex items-center gap-2.5 w-full rounded-[10px] transition-colors cursor-pointer px-3 py-2 text-left",
                                    isActive && "nav-item-active",
                                    s.archived && "opacity-70",
                                  )}
                                >
                                  <button
                                    type="button"
                                    onClick={() => {
                                      if (s.archived) return;
                                      track("workspace_sidebar_click", {
                                        target: "conversations",
                                      });
                                      if (s.unread) {
                                        organizationSessionMutation.mutate({
                                          id: s.id,
                                          unread: false,
                                        });
                                      }
                                      navigate(`/workspace/sessions/${s.id}`);
                                    }}
                                    className="flex min-w-0 flex-1 items-center gap-2.5 text-left"
                                  >
                                    <Clock
                                      size={16}
                                      className="shrink-0 text-text-muted"
                                    />
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2 min-w-0">
                                        <div
                                          className={cn(
                                            "text-[12px] truncate whitespace-nowrap font-medium",
                                            !isActive && "text-text-primary",
                                          )}
                                        >
                                          {s.title}
                                        </div>
                                        {s.runState !== "idle" && (
                                          <span
                                            className={cn(
                                              "shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold",
                                              s.runState === "running"
                                                ? "bg-[var(--color-success-subtle)] text-[var(--color-success)]"
                                                : "bg-[var(--color-danger-subtle)] text-danger",
                                            )}
                                          >
                                            {t(
                                              s.runState === "running"
                                                ? "layout.sessionRunning"
                                                : "layout.sessionFailed",
                                            )}
                                          </span>
                                        )}
                                      </div>
                                      <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-text-muted truncate whitespace-nowrap">
                                        <span>{formatTime(s.lastTime)}</span>
                                      </div>
                                    </div>
                                  </button>
                                  <div className="flex items-center gap-1 shrink-0">
                                    {s.archived ? (
                                      <button
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          archiveSessionMutation.mutate({
                                            id: s.id,
                                            archived: false,
                                          });
                                        }}
                                        className="p-1 text-text-muted transition-colors hover:text-text-primary"
                                        title={t("layout.restoreSession")}
                                      >
                                        <ArchiveRestore className="size-3.5" />
                                      </button>
                                    ) : (
                                      <button
                                        type="button"
                                        onClick={(event) => {
                                          event.stopPropagation();
                                          deleteSessionMutation.mutate(s.id);
                                        }}
                                        className="p-1 text-text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                                        title={t("layout.deleteSession")}
                                      >
                                        <Trash2 className="size-3.5" />
                                      </button>
                                    )}
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        )}
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          </div>
        </div>

        {/* Sidebar growth card */}
        <div
          className="pb-1 shrink-0"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          {rewardsCardLoading ? (
            <div data-rewards-card-loading="true" className="animate-pulse">
              <div className="mx-3 mb-2 flex items-center gap-3 rounded-[12px] border border-[#F5DFC0]/40 bg-gradient-to-br from-[#FFF8F0] via-[#FFFAF5] to-[#FFF5EB] px-3.5 py-3">
                <div className="h-7 w-7 rounded-[8px] bg-[#F6D7A8]" />
                <div className="flex-1 space-y-1.5">
                  <div className="h-3 w-28 rounded-full bg-[#E7D4B5]" />
                  <div className="h-2.5 w-14 rounded-full bg-[#F0E1C8]" />
                </div>
                <div className="h-3 w-8 rounded-full bg-[#E7D4B5]" />
              </div>
              <div className="px-3 mb-1.5">
                <div className="w-full rounded-[8px] px-2.5 py-2">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-1.5">
                      <div className="h-2.5 w-2.5 rounded-full bg-border/70" />
                      <div className="h-2.5 w-12 rounded-full bg-border/70" />
                    </div>
                    <div className="h-2.5 w-16 rounded-full bg-border/60" />
                  </div>
                </div>
              </div>
            </div>
          ) : !cloudConnected ? (
            <div className="px-3 mb-1.5">
              <button
                type="button"
                data-sidebar-growth-card="login"
                onClick={() =>
                  void handleCloudConnect(
                    isHomePage ? "home" : isModelsPage ? "settings" : "home",
                  )
                }
                className="group flex w-full items-center gap-2.5 rounded-[8px] px-2.5 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--color-brand-primary)]"
              >
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-[6px] border border-border bg-surface-2">
                  {cloudConnecting ? (
                    <Sparkles
                      size={12}
                      className="animate-pulse text-text-secondary"
                    />
                  ) : (
                    <img
                      src="/images/happytabby-logo.png"
                      alt="Tabby"
                      className="h-3.5 w-3.5"
                    />
                  )}
                </div>
                <div className="min-w-0 flex-1 text-left">
                  <div className="truncate text-[11px] font-medium text-text-secondary">
                    {t("layout.sidebar.loginTitle")}
                  </div>
                  <div className="mt-0.5 text-[10px] leading-none text-text-muted">
                    {cloudConnecting
                      ? t("layout.sidebar.loginPending")
                      : t("layout.sidebar.loginSubtitle")}
                  </div>
                </div>
                <ChevronRight
                  size={12}
                  className="shrink-0 text-text-muted transition-transform duration-200 group-hover:translate-x-0.5"
                />
              </button>
            </div>
          ) : (
            <div>
              <div className="px-3 mb-1.5 relative" ref={balanceRef}>
                <button
                  type="button"
                  data-sidebar-rewards-balance="true"
                  className="group block w-full rounded-[8px] px-2.5 py-2 transition-colors hover:bg-surface-2 text-left"
                  onClick={() => {
                    if (canOpenBalancePopup) {
                      setShowBalancePopup((prev) => !prev);
                    } else {
                      track("workspace_rewards_click");
                      track("workspace_sidebar_click", { target: "credits" });
                    }
                  }}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex min-w-0 items-center gap-1.5">
                      <span className="text-[11px] text-[var(--color-brand-primary)]">
                        ✦
                      </span>
                      <span className="truncate text-[11px] font-semibold leading-none text-text-secondary">
                        {t("layout.sidebar.balanceLabel")}
                      </span>
                    </div>
                    <span className="shrink-0 tabular-nums text-[11px] font-medium leading-none text-text-secondary">
                      {rewardBalanceValue}
                    </span>
                  </div>
                </button>
                {canOpenBalancePopup && showBalancePopup
                  ? createPortal(
                      <div
                        data-sidebar-rewards-balance-popup="true"
                        className="fixed z-[9999] pb-2"
                        style={(() => {
                          const rect =
                            balanceRef.current?.getBoundingClientRect();
                          if (!rect) return { display: "none" };
                          return {
                            left: rect.left,
                            width: Math.max(rect.width, 240),
                            bottom: window.innerHeight - rect.top,
                          };
                        })()}
                      >
                        <div className="rounded-xl border border-border bg-surface-1 p-3.5 shadow-[0_8px_30px_rgba(0,0,0,0.12)]">
                          <div className="mb-3 flex items-center justify-between">
                            <span className="text-[13px] font-semibold text-text-primary">
                              ✦ {t("layout.sidebar.balancePopup.total")}
                            </span>
                            <span className="tabular-nums text-[14px] font-bold text-text-primary">
                              {rewardBalancePopupValue}
                            </span>
                          </div>
                          <div className="space-y-2 border-t border-border/60 pt-2.5">
                            {SHOW_BALANCE_BREAKDOWN && (
                              <>
                                <div className="flex items-center justify-between">
                                  <span className="flex items-center gap-1 text-[11px] text-text-muted">
                                    {t("layout.sidebar.balancePopup.earned")}
                                    <span className="group relative inline-flex cursor-default items-center">
                                      <Info
                                        size={10}
                                        className="text-text-muted/60"
                                      />
                                      <span
                                        role="tooltip"
                                        className="pointer-events-none absolute bottom-full left-0 z-[10000] mb-1.5 w-52 rounded-md bg-neutral-800 px-2.5 py-1.5 text-left text-[11px] font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100"
                                      >
                                        {t(
                                          "layout.sidebar.balancePopup.earnedTooltip",
                                        )}
                                      </span>
                                    </span>
                                  </span>
                                  <span className="tabular-nums text-[11px] font-medium text-text-secondary">
                                    {formatUsdCents(
                                      sidebarCreditBreakdown.giftedBalance,
                                    )}
                                  </span>
                                </div>
                                <div className="flex items-center justify-between">
                                  <span className="flex items-center gap-1 text-[11px] text-text-muted">
                                    {t("layout.sidebar.balancePopup.recharged")}
                                    <span className="group relative inline-flex cursor-default items-center">
                                      <Info
                                        size={10}
                                        className="text-text-muted/60"
                                      />
                                      <span
                                        role="tooltip"
                                        className="pointer-events-none absolute bottom-full left-0 z-[10000] mb-1.5 w-52 rounded-md bg-neutral-800 px-2.5 py-1.5 text-left text-[11px] font-normal leading-snug text-white opacity-0 shadow-lg transition-opacity duration-150 group-hover:opacity-100"
                                      >
                                        {t(
                                          "layout.sidebar.balancePopup.rechargedTooltip",
                                        )}
                                      </span>
                                    </span>
                                  </span>
                                  <span className="tabular-nums text-[11px] font-medium text-text-secondary">
                                    {formatUsdCents(
                                      sidebarCreditBreakdown.planBalance,
                                    )}
                                  </span>
                                </div>
                              </>
                            )}
                            {/* This divider separates the breakdown rows from
                                the consumed total; with the breakdown hidden it
                                would stack on the container's border-t as a
                                doubled line. */}
                            <div
                              className={`flex items-center justify-between ${SHOW_BALANCE_BREAKDOWN ? "border-t border-border/60 pt-2" : ""}`}
                            >
                              <span className="text-[11px] text-text-muted">
                                {t("layout.sidebar.balancePopup.consumed")}
                              </span>
                              <span className="tabular-nums text-[11px] font-medium text-text-secondary">
                                {formatUsdCents(
                                  rewardsStatus.cloudBalance?.totalConsumed ??
                                    0,
                                )}
                              </span>
                            </div>
                          </div>
                          <button
                            type="button"
                            disabled
                            data-sidebar-rewards-balance-detail="development"
                            className="mt-2.5 flex w-full cursor-not-allowed items-center justify-between border-t border-border/60 pt-2.5 text-[11px] font-medium text-text-muted opacity-60"
                          >
                            {t("layout.sidebar.balancePopup.viewDetail")}
                            <span className="font-normal">
                              {t(
                                "layout.sidebar.balancePopup.detailDevelopment",
                              )}
                            </span>
                          </button>
                        </div>
                      </div>,
                      document.body,
                    )
                  : null}
              </div>
            </div>
          )}
        </div>

        {/* Bottom action row */}
        <div
          className="shrink-0 border-t border-border/60 pt-1.5 pb-2 px-2 flex gap-0.5 items-center"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <button
            type="button"
            onClick={() => {
              track("workspace_settings_click");
              track("workspace_sidebar_click", { target: "settings_footer" });
              navigate("/workspace/settings");
            }}
            title={t("layout.nav.settings")}
            className={cn(
              "nav-item flex flex-1 min-w-0 items-center gap-2 rounded-[var(--radius-6)] px-2.5 py-2 text-[13px] transition-colors cursor-pointer",
              isModelsPage && "nav-item-active",
            )}
          >
            <Settings size={16} className="shrink-0" />
            <span className="truncate text-left">
              {t("layout.nav.settings")}
            </span>
          </button>

          <div className="flex items-center gap-1 shrink-0">
            <div className="relative" ref={helpRef}>
              {showHelpMenu && (
                <div className="absolute z-20 bottom-full left-1/2 mb-2 w-44 -translate-x-1/2">
                  <div className="rounded-xl border bg-surface-1 border-border shadow-xl shadow-black/10 overflow-hidden">
                    <div className="p-1.5">
                      <a
                        href="https://tabby.picaso.studio/docs/"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() =>
                          track("workspace_docs_click", { type: "doc" })
                        }
                        className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-all"
                      >
                        <BookOpen size={14} />
                        {t("layout.help.docs")}
                      </a>
                      <a
                        href="mailto:work4zkl@gmail.com"
                        onClick={() =>
                          track("workspace_docs_click", { type: "contact" })
                        }
                        className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-all"
                      >
                        <Mail size={14} />
                        {t("layout.help.contact")}
                      </a>
                    </div>
                    <div className="border-t border-border p-1.5">
                      <a
                        href="https://github.com/coder-zkl1988/tabby/releases"
                        target="_blank"
                        rel="noopener noreferrer"
                        onClick={() =>
                          track("workspace_docs_click", { type: "changelog" })
                        }
                        className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[12px] font-medium text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-all"
                      >
                        <ScrollText size={14} />
                        {t("layout.help.changelog")}
                      </a>
                    </div>
                  </div>
                </div>
              )}
              <button
                type="button"
                onClick={() => {
                  if (!showHelpMenu) {
                    track("workspace_help_menu_open");
                  }
                  setShowHelpMenu(!showHelpMenu);
                }}
                className={cn(
                  "w-7 h-7 flex items-center justify-center rounded-md transition-colors cursor-pointer",
                  showHelpMenu
                    ? "text-text-primary bg-surface-2"
                    : "text-text-secondary hover:text-text-primary hover:bg-surface-2",
                )}
                title={t("layout.help.title")}
              >
                <CircleHelp size={16} />
              </button>
            </div>
            <a
              href={GITHUB_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={() =>
                track("workspace_github_click", { source: "sidebar" })
              }
              className="w-7 h-7 flex items-center justify-center rounded-md text-text-secondary hover:text-text-primary hover:bg-surface-2 transition-colors"
              title="GitHub"
            >
              <GitHubIcon />
            </a>
          </div>
        </div>

        {/* Account — hidden in desktop client */}
        {!isDesktopClient && (
          <div className="relative shrink-0" ref={logoutRef}>
            {showLogoutConfirm && (
              <div className="absolute z-20 bottom-full left-1.5 right-1.5 mb-2">
                <div className="rounded-xl border bg-surface-1 border-border shadow-xl shadow-black/10 overflow-hidden">
                  <div className="px-3.5 py-3 border-b border-border">
                    <div className="text-[12px] font-medium text-text-primary truncate whitespace-nowrap">
                      {userEmail}
                    </div>
                  </div>
                  <div className="p-1.5">
                    <button
                      type="button"
                      onClick={handleLogout}
                      className="flex items-center gap-2.5 w-full px-3 py-2 rounded-lg text-[12px] font-medium text-text-muted hover:text-red-500 hover:bg-red-500/5 transition-all cursor-pointer whitespace-nowrap"
                    >
                      <LogOut size={13} />
                      {t("layout.signOut")}
                    </button>
                  </div>
                </div>
              </div>
            )}

            <div className="border-t border-border px-2 py-2">
              <button
                type="button"
                onClick={() => setShowLogoutConfirm(!showLogoutConfirm)}
                className="flex gap-2.5 items-center w-full px-2 py-2 rounded-lg transition-all hover:bg-surface-3 cursor-pointer"
              >
                {userImage ? (
                  <img
                    src={userImage}
                    alt={userName}
                    className="w-7 h-7 rounded-md object-cover ring-1 ring-accent/10 shrink-0"
                  />
                ) : (
                  <div className="flex justify-center items-center w-7 h-7 rounded-md bg-gradient-to-br from-accent/20 to-accent/5 text-[10px] font-bold text-accent ring-1 ring-accent/10 shrink-0">
                    {userInitial}
                  </div>
                )}
                <div className="flex-1 min-w-0 text-left">
                  <div className="text-[12px] text-text-primary truncate font-medium whitespace-nowrap">
                    {userName}
                  </div>
                  <div className="text-[10px] text-text-muted truncate whitespace-nowrap">
                    {userEmail}
                  </div>
                </div>
                <ChevronUp
                  size={12}
                  className={cn(
                    "text-text-muted/50 shrink-0 transition-transform duration-150",
                    showLogoutConfirm ? "rotate-0" : "rotate-180",
                  )}
                />
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Resize handle */}
      <div
        onMouseDown={handleResizeStart}
        className="hidden md:block w-px shrink-0 cursor-col-resize group relative z-10"
        style={
          {
            WebkitAppRegion: "no-drag",
            background: desktopGlassTint,
          } as React.CSSProperties
        }
      >
        <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
      </div>

      {/* Main content */}
      <div className="relative flex-1 min-w-0">
        <div
          className={cn(
            "relative flex h-full min-w-0 flex-col bg-surface-1 rounded-l-[20px]",
          )}
          style={{ background: "var(--color-tabby-bg)" }}
        >
          <main className="flex-1 overflow-y-auto min-h-0 p-0 md:p-3">
            {budgetBannerRouteVariant === "global" &&
            shouldShowPrompt &&
            budgetStatus !== "healthy" ? (
              <div className="mx-auto max-w-4xl px-4 pb-0 pt-4 sm:px-6 md:px-8">
                <BudgetWarningBanner
                  status={budgetStatus}
                  dismissible={bannerDismissible}
                  onDismiss={dismissBanner}
                />
              </div>
            ) : null}
            {showEmptyState ? (
              <EmptyState onGoConfig={() => navigate("/workspace/settings")} />
            ) : (
              <Outlet />
            )}
          </main>
        </div>
      </div>

      {/* Right sidebar resize handle */}
      {rightSidebarOpen && (
        <div
          onMouseDown={handleRightResizeStart}
          className="hidden md:block w-px shrink-0 cursor-col-resize group relative z-10"
          style={
            {
              WebkitAppRegion: "no-drag",
              background: desktopGlassTint,
            } as React.CSSProperties
          }
        >
          <div className="absolute inset-y-0 -left-1.5 -right-1.5" />
        </div>
      )}

      {/* Right workbench: browser and canvas share one resizable panel. */}
      {rightSidebarOpen && (
        <div
          className="hidden cursor-default md:flex shrink-0 flex-col bg-[var(--color-surface-1)] [&_button]:cursor-default [&_select]:cursor-default"
          style={
            {
              width: rightSidebarWidth,
              background: "var(--color-tabby-bg)",
              // Desktop title bar (hiddenInset) makes the top strip a system
              // drag region; opt the whole panel out so its header buttons
              // remain clickable on desktop.
              WebkitAppRegion: "no-drag",
            } as React.CSSProperties
          }
        >
          {browserPanel.isOpen && browserPanel.sessionKey ? (
            <EmbeddedBrowser
              key={browserPanel.sessionKey}
              sessionKey={browserPanel.sessionKey}
              navigationRequest={browserPanel.navigationRequest}
              maximized={rightSidebarMaximized}
              onToggleMaximize={toggleRightSidebarMaximize}
              onClose={closeBrowserPanel}
            />
          ) : pinnedPanel.isOpen ? (
            /* Pinned chat cards get their own panel rather than canvas nodes:
               the whole point is that the card stays visible without panning
               or zooming to find it. */
            <>
              <div className="flex min-h-[34px] items-center justify-between border-b border-[var(--color-border-subtle)] px-4 pb-2 pt-2 md:pt-[40px]">
                <span className="min-w-0 flex-1 truncate pr-2 text-[13px] font-medium text-[var(--color-text-primary)]">
                  {t("sessions.chat.pinnedPanelTitle", {
                    defaultValue: "Pinned",
                  })}
                </span>
                <button
                  type="button"
                  onClick={closePinnedPanel}
                  aria-label="close pinned panel"
                  style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
                  className="p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
                >
                  <svg
                    aria-hidden="true"
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                  >
                    <path
                      d="M4 4L12 12M12 4L4 12"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                </button>
              </div>
              {selectedSessionId && (
                <PinnedA2UIPanel
                  sessionId={selectedSessionId}
                  surfaces={pinnedPanel.surfaces}
                />
              )}
            </>
          ) : (
            <>
              {/* Header band matches the chat header's top clearance + height so the
              two border-b dividers line up: pt compensates the chat column's
              md:p-3 top pad (12px) on top of its md:pt-7 (28px); min-h matches
              the chat header's badge row. */}
              <div className="flex min-h-[34px] items-center justify-between border-b border-[var(--color-border-subtle)] px-4 pb-2 pt-2 md:pt-[40px]">
                <div className="flex min-w-0 flex-1 items-center pr-2">
                  <CanvasBoardTitle />
                </div>
                <div className="flex items-center gap-1">
                  <button
                    type="button"
                    onClick={() => void exportBoardAsZip()}
                    title="导出画布"
                    aria-label="导出画布"
                    data-canvas-header-export="true"
                    style={
                      { WebkitAppRegion: "no-drag" } as React.CSSProperties
                    }
                    className="p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
                  >
                    <FileDown size={14} />
                  </button>
                  <button
                    type="button"
                    onClick={toggleRightSidebarMaximize}
                    title={rightSidebarMaximized ? "还原宽度" : "展开画布"}
                    aria-label={
                      rightSidebarMaximized
                        ? "restore canvas"
                        : "maximize canvas"
                    }
                    style={
                      { WebkitAppRegion: "no-drag" } as React.CSSProperties
                    }
                    className="p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
                  >
                    {rightSidebarMaximized ? (
                      <Minimize2 size={14} />
                    ) : (
                      <Maximize2 size={14} />
                    )}
                  </button>
                  <button
                    type="button"
                    onClick={closeCanvasSidebar}
                    style={
                      { WebkitAppRegion: "no-drag" } as React.CSSProperties
                    }
                    className="p-1 rounded-md hover:bg-[var(--color-surface-2)] text-[var(--color-text-tertiary)] hover:text-[var(--color-text-primary)] transition-colors"
                  >
                    <svg
                      aria-hidden="true"
                      width="16"
                      height="16"
                      viewBox="0 0 16 16"
                      fill="none"
                    >
                      <path
                        d="M4 4L12 12M12 4L4 12"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                      />
                    </svg>
                  </button>
                </div>
              </div>
              {/* Always mount the surface, even with zero nodes: the toolbar is
              the way users CREATE the first node, and mounting keeps the
              S8 mirror pushing so the chat agent's canvas_read stays live. */}
              <div className="a2ui-sidebar-host flex-1 min-h-0">
                <CanvasSurface />
              </div>
            </>
          )}
        </div>
      )}

      {/* Session rename dialog */}
      {renameTarget && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
          onMouseDown={() => setRenameTarget(null)}
        >
          <div
            className="w-80 rounded-xl border border-border bg-surface-0 p-4 shadow-xl"
            onMouseDown={(e) => e.stopPropagation()}
          >
            <div className="mb-3 text-[13px] font-semibold text-text-primary">
              {t("layout.renameSession")}
            </div>
            <input
              // biome-ignore lint/a11y/noAutofocus: focus the field when the dialog opens
              autoFocus
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && renameValue.trim()) {
                  renameSessionMutation.mutate({
                    id: renameTarget.id,
                    title: renameValue.trim(),
                  });
                }
                if (e.key === "Escape") setRenameTarget(null);
              }}
              className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-[12px] text-text-muted hover:bg-surface-2"
                onClick={() => setRenameTarget(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={
                  !renameValue.trim() || renameSessionMutation.isPending
                }
                className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-white hover:opacity-90 disabled:opacity-50"
                onClick={() =>
                  renameSessionMutation.mutate({
                    id: renameTarget.id,
                    title: renameValue.trim(),
                  })
                }
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Session group dialog */}
      {groupTarget && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center bg-black/30"
          onMouseDown={() => setGroupTarget(null)}
        >
          <div
            className="w-80 rounded-lg border border-border bg-surface-0 p-4 shadow-xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-3 text-[13px] font-semibold text-text-primary">
              {t("layout.moveSessionToGroup")}
            </div>
            <input
              // biome-ignore lint/a11y/noAutofocus: focus the field when the dialog opens
              autoFocus
              value={groupValue}
              onChange={(event) => setGroupValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  organizationSessionMutation.mutate({
                    id: groupTarget.id,
                    ...(groupValue.trim()
                      ? { category: groupValue.trim() }
                      : { clearCategory: true }),
                  });
                }
                if (event.key === "Escape") setGroupTarget(null);
              }}
              placeholder={t("layout.sessionGroupPlaceholder")}
              className="w-full rounded-lg border border-border bg-surface-1 px-3 py-2 text-[13px] text-text-primary focus:outline-none focus:ring-1 focus:ring-accent"
            />
            <div className="mt-3 flex justify-end gap-2">
              <button
                type="button"
                className="rounded-lg px-3 py-1.5 text-[12px] text-text-muted hover:bg-surface-2"
                onClick={() => setGroupTarget(null)}
              >
                {t("common.cancel")}
              </button>
              <button
                type="button"
                disabled={organizationSessionMutation.isPending}
                className="rounded-lg bg-accent px-3 py-1.5 text-[12px] text-white hover:opacity-90 disabled:opacity-50"
                onClick={() =>
                  organizationSessionMutation.mutate({
                    id: groupTarget.id,
                    ...(groupValue.trim()
                      ? { category: groupValue.trim() }
                      : { clearCategory: true }),
                  })
                }
              >
                {t("common.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {recoveryTarget && (
        <SessionRecoveryDialog
          session={recoveryTarget}
          onClose={() => setRecoveryTarget(null)}
          onContinue={(sessionId) => {
            setRecoveryTarget(null);
            navigate(`/workspace/sessions/${sessionId}`);
          }}
          onRecovered={(sessionId) => {
            setRecoveryTarget(null);
            navigate(`/workspace/sessions/${sessionId}`);
          }}
        />
      )}

      {/* Session action error toast */}
      {sessionActionError && (
        <button
          type="button"
          className="fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 rounded-lg border border-border bg-surface-0 px-4 py-2 text-[12px] text-danger shadow-lg"
          onClick={() => setSessionActionError(null)}
        >
          {sessionActionError}
        </button>
      )}
    </div>
  );
}
