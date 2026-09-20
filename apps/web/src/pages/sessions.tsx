import {
  type BotItem,
  ChatInputArea,
  type PendingAttachment,
  type RunMessageMode,
} from "@/components/chat-input-area";
import { InlineA2UIHost } from "@/components/inline-a2ui-host";
import { PlatformIcon } from "@/components/platform-icons";
import { SessionOperationsPanel } from "@/components/session-operations-panel";
import { ChatMarkdown } from "@/components/ui/chat-markdown";
import type { A2UIMessage } from "@/lib/a2ui";
import { surfacePinKey } from "@/lib/a2ui/a2ui-pin-store";
import {
  closePinnedPanel,
  pinSurface,
  setActivePinnedSession,
  usePinnedPanel,
} from "@/lib/a2ui/a2ui-pinned-panel-store";
import {
  humanizeSurfaceId,
  sidebarSurfaceDefaultSize,
  useA2UISidebar,
} from "@/lib/a2ui/a2ui-sidebar-context";
import { createLocalStreamSSEClient } from "@/lib/api/event-source";
import {
  closeBrowserPanel,
  closeBrowserPanelForRouting,
  openBrowserPanel,
  openUrlInBrowserPanel,
  useBrowserPanel,
} from "@/lib/browser/browser-panel-store";
import {
  createPreviewAutoOpenTracker,
  observePreviewArtifact,
} from "@/lib/browser/browser-preview-auto-open";
import {
  type PreviewArtifact,
  selectLatestPreviewArtifact,
} from "@/lib/browser/embedded-browser";
import {
  type CanvasOpBatchView,
  CanvasOpCard,
} from "@/lib/canvas/canvas-op-card";
import { bindSessionToBoard } from "@/lib/canvas/canvas-session-binding";
import {
  getA2UIPayload,
  refreshA2UIPayload,
  setPanelOpen,
  useCanvas,
} from "@/lib/canvas/canvas-store";
import { getChannelChatUrl } from "@/lib/channel-links";
import { surfaceIds } from "@/lib/chat/chat-a2ui-surfaces";
import { coalesceInlineA2UISurfaces } from "@/lib/chat/chat-a2ui-surfaces";
import {
  A2UI_TOOL_NAMES,
  CANVAS_OP_TOOL_NAMES,
  type ExtractedMessage,
  type FileCardInfo,
  type ImageBlockInfo,
  type SidebarA2UIPayload,
  type ToolCallInfo,
  extractMessage,
  stripMediaMarkerLines,
} from "@/lib/chat/chat-message-extract";
import {
  type TranscriptEntry,
  buildTranscriptItems,
  stripRenderedAssistantText,
} from "@/lib/chat/chat-transcript-groups";
import {
  type MessageFileKind,
  classifyMessageFile,
} from "@/lib/chat/message-file-kind";
import { classifyExplicitRunMessage } from "@/lib/chat/run-message-intent";
import {
  type SteerRunHandoff,
  acceptSteerRunHandoff,
  beginSteerRunHandoff,
  consumePreviousRunAbort,
  consumeReplacementRunTerminal,
} from "@/lib/chat/steer-run-handoff";
import { invokeDesktopHost } from "@/lib/desktop-host";
import { openExternalUrl } from "@/lib/desktop-links";
import { normalizeChannel, track } from "@/lib/tracking";
import { cn } from "@/lib/utils";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUpRight,
  Brain,
  CheckCircle2,
  ChevronDown,
  CircleAlert,
  Download,
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileType2,
  FileVideo,
  FolderOpen,
  Gauge,
  GitBranch,
  Globe,
  Loader2,
  type LucideIcon,
  MessageCircleQuestion,
  MessageSquare,
  PanelRight,
  Presentation,
  RotateCcw,
  Shapes,
  Square,
  Terminal,
  Volume2,
  WifiOff,
  Wrench,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from "react-router-dom";
import { toast } from "sonner";
import {
  getApiV1Artifacts,
  getApiV1Bots,
  getApiV1BotsByBotId,
  getApiV1Channels,
  getApiV1ChatRunStatus,
  getApiV1SessionsById,
  getApiV1SessionsByIdMessages,
  patchApiV1BotsByBotId,
  postApiV1ChatCancel,
  postApiV1ChatIntent,
  postApiV1ChatLocal,
  postApiV1ChatSideQuestion,
  postApiV1ChatSteer,
  postApiV1SessionsByIdMessagesByMessageIdBranch,
  postApiV1SessionsByIdMessagesByMessageIdRollback,
  postApiV1SessionsByIdReset,
  postApiV1TtsSpeak,
} from "../../lib/api/sdk.gen";

const BOT_AVATAR = "/images/claw-avatar.png";
const USER_AVATAR = "/images/tabby-avatar.png";
const SIDE_QUESTION_AUTO_DISMISS_MS = 8_000;
const RUN_MESSAGE_CONFIDENCE_THRESHOLD = 0.8;

const MESSAGE_FILE_VISUALS: Record<
  MessageFileKind,
  { icon: LucideIcon; color: string }
> = {
  directory: { icon: FolderOpen, color: "text-amber-500" },
  pdf: { icon: FileText, color: "text-red-500" },
  word: { icon: FileType2, color: "text-blue-500" },
  spreadsheet: { icon: FileSpreadsheet, color: "text-green-600" },
  presentation: { icon: Presentation, color: "text-orange-500" },
  image: { icon: FileImage, color: "text-purple-500" },
  audio: { icon: FileAudio, color: "text-pink-500" },
  video: { icon: FileVideo, color: "text-indigo-500" },
  archive: { icon: FileArchive, color: "text-amber-600" },
  code: { icon: FileCode2, color: "text-cyan-600" },
  text: { icon: FileText, color: "text-text-muted" },
  file: { icon: File, color: "text-text-muted" },
};

/**
 * Speak-reply button for assistant bubbles (OpenClaw >=2026.7.1 tts.speak).
 * One shared Audio element so starting a new readout stops the previous one.
 */
let activeSpeakAudio: HTMLAudioElement | null = null;
let notifyActiveSpeakEnded: (() => void) | null = null;

function stopActiveSpeakAudio(): void {
  if (activeSpeakAudio) {
    activeSpeakAudio.pause();
    activeSpeakAudio = null;
  }
  notifyActiveSpeakEnded?.();
  notifyActiveSpeakEnded = null;
}

function SpeakButton({ text }: { text: string }) {
  const { t } = useTranslation();
  const [state, setState] = useState<"idle" | "loading" | "playing">("idle");

  const handleClick = useCallback(async () => {
    if (state === "playing" || state === "loading") {
      stopActiveSpeakAudio();
      setState("idle");
      return;
    }
    stopActiveSpeakAudio();
    setState("loading");
    try {
      const { data, error } = await postApiV1TtsSpeak({
        body: { text: text.slice(0, 4000) },
      });
      if (error || !data) {
        throw new Error(
          (error as { message?: string } | undefined)?.message ??
            "TTS unavailable",
        );
      }
      const audio = new Audio(
        `data:${data.mimeType};base64,${data.audioBase64}`,
      );
      activeSpeakAudio = audio;
      notifyActiveSpeakEnded = () => setState("idle");
      audio.onended = () => {
        if (activeSpeakAudio === audio) {
          activeSpeakAudio = null;
          notifyActiveSpeakEnded = null;
        }
        setState("idle");
      };
      await audio.play();
      setState("playing");
    } catch (err) {
      setState("idle");
      toast.error(
        `${t("sessions.speakFailed")}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }, [state, text, t]);

  return (
    <button
      type="button"
      onClick={handleClick}
      className="inline-flex items-center gap-1 rounded-md p-1 text-text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-text-primary group-hover/bubble:opacity-100 data-[state=playing]:opacity-100 data-[state=loading]:opacity-100"
      data-state={state}
      title={
        state === "idle" ? t("sessions.speakReply") : t("sessions.speakStop")
      }
    >
      {state === "loading" ? (
        <Loader2 className="h-3 w-3 animate-spin" />
      ) : state === "playing" ? (
        <Square className="h-3 w-3" />
      ) : (
        <Volume2 className="h-3 w-3" />
      )}
    </button>
  );
}

function logDeskpetHostDebug(
  message: string,
  data?: Record<string, unknown>,
): void {
  console.info("[deskpet-debug:web]", message, data ?? {});
}

const DESKPET_REPLYING_DURATION_MS = 8000;
const DESKPET_REPLYING_REFRESH_MS = 1800;
const DESKPET_SUCCESS_DURATION_MS = 5000;
const DESKPET_ERROR_DURATION_MS = 4200;
const DESKPET_TYPING_WORKING_DURATION_MS = 1600;
const DESKPET_TYPING_NOTIFY_INTERVAL_MS = 700;

function onDesktopHostCommand(
  listener: (command: Record<string, unknown>) => void,
): (() => void) | undefined {
  if (typeof window === "undefined") {
    return undefined;
  }

  const candidate = (window as Window & { nexuHost?: unknown }).nexuHost;
  if (!candidate || typeof candidate !== "object") {
    return undefined;
  }

  const onDesktopCommand = Reflect.get(candidate, "onDesktopCommand");
  if (typeof onDesktopCommand !== "function") {
    return undefined;
  }

  return onDesktopCommand.call(candidate, listener) as (() => void) | undefined;
}

function getLatestAssistantReplyTextFromMessages(
  messages: ChatMessageData[],
  options?: { afterTimestamp?: number },
): string {
  const afterTimestamp = options?.afterTimestamp ?? 0;
  for (const message of messages.slice().reverse()) {
    if (message.role !== "assistant") {
      continue;
    }

    const messageTimestamp =
      message.timestamp ??
      (message.createdAt ? new Date(message.createdAt).getTime() : 0);
    if (afterTimestamp > 0 && messageTimestamp <= afterTimestamp) {
      continue;
    }

    const extracted = extractMessage(
      message as unknown as Record<string, unknown>,
    );
    const text = stripMediaMarkerLines(extracted.text).trim();
    if (text) {
      return text.slice(0, 280);
    }
  }

  return "";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Complex document components whose surfaces always open in the side panel. */
const SIDEBAR_DOC_COMPONENT_TYPES = new Set(["MarkdownEditor"]);

/**
 * Decide where an A2UI surface renders.
 *
 * Side panel: only document editor surfaces (MarkdownEditor). Xiaohongshu
 * editors intentionally stay in the conversation that produced them. Every
 * other surface — forms, images, video/audio, status cards — also renders
 * inline. A `sidebar:` surfaceId prefix remains an explicit override.
 */
function isSidebarBoundSurface(
  surfaceId: string,
  msgs: A2UIMessage[],
): boolean {
  if (surfaceId.startsWith("sidebar:")) return true;
  for (const m of msgs) {
    const components =
      "updateComponents" in m
        ? (m.updateComponents?.components ?? [])
        : "createSurface" in m
          ? (m.createSurface?.components ?? [])
          : [];
    for (const comp of components) {
      const type = (comp as { type?: string }).type ?? "";
      if (SIDEBAR_DOC_COMPONENT_TYPES.has(type)) return true;
    }
  }
  return false;
}

/** True when the server history already contains this optimistic message. */
function isPendingMessageOnServer(
  pm: { text: string; timestamp: number; attachments: unknown[] },
  serverUserTexts: Set<string>,
  serverMediaOnlyTimes: number[],
): boolean {
  if (pm.text.trim().length > 0) {
    return serverUserTexts.has(pm.text);
  }
  if (pm.attachments.length === 0) return false;
  // Media-only: match a captionless server upload that arrived at or after
  // this send (60s skew tolerance for client/server clocks).
  return serverMediaOnlyTimes.some((t) => t >= pm.timestamp - 60_000);
}

/** Friendly label for a known A2UI action chip. */
function a2uiActionLabel(actionName: string): string {
  switch (actionName) {
    case "xhs_editor_publish":
      return "已提交小红书发布";
    case "skill_confirmation":
      return "已确认操作";
    case "install_expert":
      return "已确认安装专家";
    case "install_expert_cancel":
      return "已取消安装";
    default:
      return "已提交操作";
  }
}

/** Millisecond timestamp -> HH:mm */
function formatTs(ts?: number | null): string {
  if (!ts) return "";
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** Format relative time from ISO string */
function formatRelativeTime(iso: string | null | undefined): string {
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

function formatToolCallSummary(summary: string | null): string | null {
  if (!summary) return null;

  const uppercaseTokens = new Set([
    "api",
    "ci",
    "csv",
    "db",
    "gh",
    "pdf",
    "qa",
    "sql",
    "ui",
    "ux",
  ]);

  const formatted = summary
    .split(/[_-\s]+/)
    .filter(Boolean)
    .map((token) => {
      const normalized = token.trim();
      if (normalized.length === 0) return "";
      if (/^[A-Z0-9]+$/.test(normalized)) return normalized;
      if (uppercaseTokens.has(normalized.toLowerCase())) {
        return normalized.toUpperCase();
      }
      return normalized.charAt(0).toUpperCase() + normalized.slice(1);
    })
    .join(" ")
    .trim();

  if (formatted.length === 0 || formatted.toLowerCase() === "tool") {
    return null;
  }

  return formatted;
}

type Platform =
  | "slack"
  | "discord"
  | "whatsapp"
  | "telegram"
  | "web"
  | "feishu"
  | "dingtalk"
  | "wechat"
  | "wecom"
  | "qqbot";

interface PlatformConfig {
  badgeClass: string;
  label: string;
  openLabel: string;
}

const DEFAULT_PLATFORM_CONFIG: PlatformConfig = {
  badgeClass:
    "border-[rgba(107,114,128,0.14)] bg-[rgba(107,114,128,0.08)] text-[#6B7280]",
  label: "Web",
  openLabel: "channels.open",
};

const PLATFORM_CONFIG: Record<Platform, PlatformConfig> = {
  slack: {
    badgeClass:
      "border-[rgba(224,30,90,0.12)] bg-[rgba(224,30,90,0.06)] text-[#E01E5A]",
    label: "Slack",
    openLabel: "channels.openInSlack",
  },
  discord: {
    badgeClass:
      "border-[rgba(88,101,242,0.14)] bg-[rgba(88,101,242,0.08)] text-[#5865F2]",
    label: "Discord",
    openLabel: "channels.openInDiscord",
  },
  whatsapp: {
    badgeClass:
      "border-[rgba(37,211,102,0.14)] bg-[rgba(37,211,102,0.08)] text-[#25D366]",
    label: "WhatsApp",
    openLabel: "channels.openInWhatsApp",
  },
  telegram: {
    badgeClass:
      "border-[rgba(36,161,222,0.14)] bg-[rgba(36,161,222,0.08)] text-[#24A1DE]",
    label: "Telegram",
    openLabel: "channels.openInTelegram",
  },
  feishu: {
    badgeClass:
      "border-[rgba(51,112,255,0.14)] bg-[rgba(51,112,255,0.08)] text-[#3370FF]",
    label: "Feishu",
    openLabel: "channels.openInFeishu",
  },
  dingtalk: {
    badgeClass:
      "border-[rgba(44,44,44,0.14)] bg-[rgba(44,44,44,0.08)] text-[#2C2C2C]",
    label: "DingTalk",
    openLabel: "channels.openInDingTalk",
  },
  wecom: {
    badgeClass:
      "border-[rgba(7,193,96,0.14)] bg-[rgba(7,193,96,0.08)] text-[#07C160]",
    label: "WeCom",
    openLabel: "channels.openInWeCom",
  },
  qqbot: {
    badgeClass:
      "border-[rgba(24,144,255,0.14)] bg-[rgba(24,144,255,0.08)] text-[#1890FF]",
    label: "QQ",
    openLabel: "channels.openInQQ",
  },
  wechat: {
    badgeClass:
      "border-[rgba(141,200,27,0.14)] bg-[rgba(141,200,27,0.08)] text-[#8DC81B]",
    label: "WeChat",
    openLabel: "channels.openInWeChat",
  },
  web: DEFAULT_PLATFORM_CONFIG,
};

function getPlatformConfig(platform: string): PlatformConfig {
  return PLATFORM_CONFIG[platform as Platform] ?? DEFAULT_PLATFORM_CONFIG;
}

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function EmptyState() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-surface-3">
          <MessageSquare className="h-8 w-8 text-text-muted" />
        </div>
        <h3 className="mb-2 text-lg font-medium text-text-primary">
          {t("sessions.selectSession")}
        </h3>
        <p className="max-w-sm text-sm text-text-muted">
          {t("sessions.selectSessionDesc")}
        </p>
      </div>
    </div>
  );
}

function ChatEmpty() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center">
      <div className="text-center py-16">
        <div className="text-[13px] text-text-muted">
          {t("sessions.chat.empty")}
        </div>
      </div>
    </div>
  );
}

function ChatUnavailable() {
  const { t } = useTranslation();
  return (
    <div className="flex h-full items-center justify-center">
      <div className="flex flex-col items-center text-center">
        <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-surface-3">
          <WifiOff className="h-8 w-8 text-text-muted" />
        </div>
        <h3 className="mb-2 text-lg font-medium text-text-primary">
          {t("sessions.chat.unavailable")}
        </h3>
        <p className="max-w-sm text-sm text-text-muted">
          {t("sessions.chat.unavailableDesc")}
        </p>
      </div>
    </div>
  );
}

interface ChatMessageData {
  id: string;
  role: "user" | "assistant" | "toolResult";
  content: unknown;
  timestamp: number | null;
  createdAt: string | null;
  toolName?: string;
  toolCallId?: string;
}

function summarizeToolArguments(value: unknown): string {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return "";
  }

  const normalizeText = (text: string): string =>
    text
      .replace(/[ \t]+/g, " ")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
  const args = value as Record<string, unknown>;
  const preferredKeys = [
    "command",
    "task",
    "query",
    "path",
    "url",
    "action",
    "skill",
    "sessionId",
    "deviceId",
  ];
  const preferredValue = preferredKeys
    .map((key) => args[key])
    .find(
      (candidate) =>
        typeof candidate === "string" && candidate.trim().length > 0,
    );
  if (typeof preferredValue === "string") {
    return normalizeText(preferredValue);
  }

  if (Array.isArray(args.tasks)) {
    const taskSummaries = args.tasks.flatMap((task, index) => {
      if (!task || typeof task !== "object" || Array.isArray(task)) {
        return [];
      }
      const taskRecord = task as Record<string, unknown>;
      if (typeof taskRecord.task !== "string" || !taskRecord.task.trim()) {
        return [];
      }
      const devicePrefix =
        typeof taskRecord.deviceId === "string" && taskRecord.deviceId.trim()
          ? `${taskRecord.deviceId.trim()}: `
          : "";
      return `${index + 1}. ${devicePrefix}${normalizeText(taskRecord.task)}`;
    });
    if (taskSummaries.length > 0) {
      return taskSummaries.join("\n\n");
    }
  }

  const fallbackValue = Object.values(args).find(
    (candidate) => typeof candidate === "string" && candidate.trim().length > 0,
  );
  return typeof fallbackValue === "string" ? normalizeText(fallbackValue) : "";
}

type ExecutionStep =
  | {
      id: string;
      kind: "reasoning" | "narration";
      text: string;
      streaming?: boolean;
    }
  | {
      id: string;
      kind: "tool";
      toolCall: ToolCallInfo;
    };

function buildExecutionSteps(
  entries: TranscriptEntry<ChatMessageData>[],
): ExecutionStep[] {
  const steps: ExecutionStep[] = [];

  for (const entry of entries) {
    entry.extracted.reasoning.forEach((text, index) => {
      steps.push({
        id: `${entry.msg.id}:reasoning:${index}`,
        kind: "reasoning",
        text,
      });
    });

    const narration = entry.extracted.text.trim();
    if (narration) {
      steps.push({
        id: `${entry.msg.id}:narration`,
        kind: "narration",
        text: narration,
      });
    }

    entry.extracted.toolCalls.forEach((toolCall, index) => {
      steps.push({
        id: toolCall.id ?? `${entry.msg.id}:tool:${index}`,
        kind: "tool",
        toolCall,
      });
    });
  }

  return steps;
}

function ToolCallGlyph({ name }: { name: string }) {
  const normalized = name.toLowerCase();
  if (
    normalized === "exec" ||
    normalized === "process" ||
    normalized.includes("shell") ||
    normalized.includes("bash")
  ) {
    return <Terminal className="size-[14px]" />;
  }
  return <Wrench className="size-[14px]" />;
}

function ExecutionToolRow({
  toolCall,
  active,
}: {
  toolCall: ToolCallInfo;
  active: boolean;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const formattedSummary =
    formatToolCallSummary(toolCall.name) ?? t("sessions.chat.toolActivity");
  const argumentSummary = summarizeToolArguments(toolCall.arguments);
  const expandable = argumentSummary.length > 96;

  return (
    <div
      data-tool-card={toolCall.name}
      data-tool-card-variant="execution-row"
      className="flex min-w-0 items-start gap-2.5 py-1.5 text-[12px] leading-5"
    >
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center",
          active ? "text-[var(--color-info)]" : "text-[var(--color-success)]",
        )}
      >
        {active ? (
          <Loader2 className="size-[13px] animate-spin" />
        ) : (
          <CheckCircle2 className="size-[13px]" />
        )}
      </span>
      <span
        className={cn(
          "flex size-5 shrink-0 items-center justify-center",
          active ? "text-[var(--color-info)]" : "text-text-muted",
        )}
      >
        <ToolCallGlyph name={toolCall.name} />
      </span>
      {expandable ? (
        <button
          type="button"
          data-tool-arguments-toggle={toolCall.name}
          aria-expanded={expanded}
          title={t(
            expanded
              ? "sessions.chat.collapseToolDetails"
              : "sessions.chat.expandToolDetails",
          )}
          onClick={() => setExpanded((value) => !value)}
          className="grid min-w-0 flex-1 grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 text-left"
        >
          <span className="shrink-0 font-medium text-text-secondary">
            {formattedSummary}
          </span>
          <span
            className={cn(
              "min-w-0 font-mono text-[11px] text-text-muted",
              expanded ? "whitespace-pre-wrap break-words" : "truncate",
            )}
          >
            {argumentSummary}
          </span>
          <ChevronDown
            className={cn(
              "mt-0.5 size-4 shrink-0 text-text-muted transition-transform",
              !expanded && "-rotate-90",
            )}
          />
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-baseline gap-2">
          <span className="shrink-0 font-medium text-text-secondary">
            {formattedSummary}
          </span>
          {argumentSummary && (
            <span className="min-w-0 truncate font-mono text-[11px] text-text-muted">
              {argumentSummary}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

function ExecutionActivityGroup({
  id,
  entries,
  active,
  showAvatar,
  liveText = "",
  onOpenLink,
}: {
  id: string;
  entries: TranscriptEntry<ChatMessageData>[];
  active: boolean;
  showAvatar: boolean;
  liveText?: string;
  onOpenLink?: (url: string) => void;
}) {
  const { t } = useTranslation();
  const [manualOpen, setManualOpen] = useState<boolean | null>(null);
  const open = manualOpen ?? active;
  const persistedSteps = buildExecutionSteps(entries);
  const liveStepText =
    liveText.trim() ||
    (active && entries.length === 0 ? t("sessions.chat.thinking") : "");
  const steps: ExecutionStep[] = liveStepText
    ? [
        ...persistedSteps,
        {
          id: `${id}:streaming`,
          kind: "narration",
          text: liveStepText,
          streaming: true,
        },
      ]
    : persistedSteps;
  const toolCount = entries.reduce(
    (count, entry) => count + entry.extracted.toolCalls.length,
    0,
  );
  const stepCount = Math.max(toolCount, entries.length, 1);
  let lastToolStepIndex = -1;
  for (let index = steps.length - 1; index >= 0; index -= 1) {
    if (steps[index]?.kind === "tool") {
      lastToolStepIndex = index;
      break;
    }
  }
  const time = formatTs(entries[entries.length - 1]?.msg.timestamp);

  return (
    <div
      data-execution-group={id}
      data-execution-state={active ? "running" : "completed"}
      className="group/execution flex items-start gap-3"
    >
      {showAvatar ? (
        <img
          src={BOT_AVATAR}
          alt=""
          className="mt-0 -ml-1 h-9 w-9 shrink-0 object-contain"
        />
      ) : (
        <div aria-hidden className="-ml-1 h-9 w-9 shrink-0" />
      )}
      <div className="min-w-0 max-w-[44rem] flex-1">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setManualOpen(!open)}
          className="flex min-h-8 max-w-full items-center gap-2 py-0.5 text-left text-[13px] text-text-muted transition-colors hover:text-text-primary"
        >
          <ChevronDown
            className={cn(
              "size-4 shrink-0 transition-transform",
              !open && "-rotate-90",
            )}
          />
          <span className="flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface-1 text-[11px] font-medium text-text-secondary">
            {stepCount}
          </span>
          <span className="truncate">
            {active
              ? t("sessions.chat.stepsRunning", { count: stepCount })
              : t("sessions.chat.stepsCompleted", { count: stepCount })}
          </span>
        </button>
        <div
          hidden={!open}
          className="ml-2 mt-1 border-l border-border/80 pl-5"
        >
          {steps.map((step, index) => {
            if (step.kind === "tool") {
              return (
                <ExecutionToolRow
                  key={step.id}
                  toolCall={step.toolCall}
                  active={active && index === lastToolStepIndex}
                />
              );
            }

            return (
              <div
                key={step.id}
                data-execution-detail={step.kind}
                className="flex items-start gap-2.5 py-1.5 text-[12px] leading-5 text-text-muted"
              >
                <span
                  className={cn(
                    "mt-0.5 flex size-5 shrink-0 items-center justify-center",
                    active && index === steps.length - 1
                      ? "text-[var(--color-info)]"
                      : "text-text-muted",
                  )}
                >
                  {step.streaming ? (
                    <Loader2 className="size-[13px] animate-spin" />
                  ) : (
                    <Brain className="size-[14px]" />
                  )}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="mb-0.5 text-[11px] font-medium text-text-muted">
                    {step.kind === "reasoning"
                      ? t("sessions.chat.reasoningStep")
                      : t("sessions.chat.processNote")}
                  </div>
                  <div className="text-text-secondary">
                    <ChatMarkdown content={step.text} onOpenLink={onOpenLink} />
                    {step.streaming && (
                      <span className="inline-block h-3.5 w-1 animate-pulse bg-text-secondary align-text-bottom" />
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
        {time && (
          <div className="mt-1 pl-1 text-[10px] text-text-muted">{time}</div>
        )}
      </div>
    </div>
  );
}

function ReplyContextCard({ text, isBot }: { text: string; isBot: boolean }) {
  const { t } = useTranslation();

  return (
    <div
      data-reply-context={text}
      className={cn(
        "inline-flex max-w-full items-start gap-2 rounded-2xl border px-3 py-2 text-left shadow-[0_6px_18px_rgba(15,23,42,0.04)]",
        isBot
          ? "border-border bg-[rgba(248,250,252,0.95)] text-text-secondary"
          : "border-border/70 bg-white/80 text-text-secondary",
      )}
    >
      <span className="mt-0.5 h-8 w-1 shrink-0 rounded-full bg-[rgba(148,163,184,0.6)]" />
      <div className="min-w-0">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-text-muted">
          {t("sessions.chat.replyLabel")}
        </div>
        <div className="mt-1 max-w-[28rem] truncate text-[12px] leading-5">
          {text}
        </div>
      </div>
    </div>
  );
}

function SessionPlatformBadge({
  platform,
  className,
}: {
  platform: string;
  className?: string;
}) {
  const platformCfg = getPlatformConfig(platform);
  return (
    <span
      data-session-platform={platform}
      className={cn(
        "inline-flex items-center justify-center rounded-xl border shadow-[0_1px_2px_rgba(0,0,0,0.03)]",
        platformCfg.badgeClass,
        className,
      )}
    >
      <PlatformIcon platform={platform} size={16} />
    </span>
  );
}

function InlineImage({ mimeType, data, url }: ImageBlockInfo) {
  const [expanded, setExpanded] = useState(false);
  const src = url ?? `data:${mimeType};base64,${data ?? ""}`;
  return (
    <>
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="block max-w-[240px] cursor-pointer rounded-xl overflow-hidden border border-border hover:opacity-90 transition-opacity"
      >
        <img
          src={src}
          alt=""
          className="w-full h-auto max-h-[200px] object-cover"
        />
      </button>
      {expanded && (
        <div
          className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4"
          onClick={() => setExpanded(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setExpanded(false);
          }}
        >
          <img
            src={src}
            alt=""
            className="max-w-full max-h-full rounded-xl object-contain"
          />
        </div>
      )}
    </>
  );
}

/** Chip rendered in place of sidebar-bound A2UI — click opens the side panel. */
function SidebarA2UIButton({
  payload,
  onOpen,
}: {
  payload: SidebarA2UIPayload;
  onOpen: (payload: SidebarA2UIPayload) => void;
}) {
  const { t } = useTranslation();
  // "sidebar:xhs-editor" -> "xhs editor"
  const surfaceLabel = payload.surfaceId
    .replace(/^sidebar:/, "")
    .replace(/[-_]+/g, " ")
    .trim();
  return (
    <button
      type="button"
      data-a2ui-sidebar-trigger={payload.surfaceId}
      onClick={() => onOpen(payload)}
      className="mt-0.5 inline-flex max-w-full items-center gap-2 rounded-2xl border border-border bg-surface-1 px-3.5 py-2.5 text-[13px] shadow-[0_6px_18px_rgba(15,23,42,0.05)] transition-colors hover:bg-surface-2"
    >
      <span className="flex size-6 shrink-0 items-center justify-center rounded-lg bg-[var(--color-info-subtle)] text-[var(--color-info)]">
        <PanelRight className="size-[14px]" />
      </span>
      <span className="min-w-0 truncate font-medium text-text-primary">
        {surfaceLabel ||
          t("sessions.chat.interactivePanel", {
            defaultValue: "Interactive panel",
          })}
      </span>
      <span className="shrink-0 text-[11px] font-medium text-[var(--color-info)]">
        {t("sessions.chat.openPanel", { defaultValue: "Open" })}
      </span>
      <ArrowUpRight className="size-[14px] shrink-0 text-text-muted" />
    </button>
  );
}

function MessageFileCard({ name, mimeType, size, url }: FileCardInfo) {
  const { t } = useTranslation();
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  const { icon: FileTypeIcon, color: iconColor } =
    MESSAGE_FILE_VISUALS[classifyMessageFile(name, mimeType)];
  const content = (
    <>
      <div className="shrink-0 flex items-center justify-center w-8 h-8 rounded-lg bg-surface-2">
        <FileTypeIcon size={16} className={iconColor} />
      </div>
      <div className="min-w-0">
        <div className="text-[12px] text-text-primary truncate font-medium">
          {name}
        </div>
        <div className="text-[10px] text-text-muted">
          {ext.toUpperCase()}
          {size !== undefined && ` · ${formatBytes(size)}`}
        </div>
      </div>
      {url && <Download className="size-3.5 shrink-0 text-text-muted" />}
    </>
  );
  const className =
    "inline-flex items-center gap-2 rounded-xl border border-border bg-surface-1 px-3 py-2 max-w-[240px]";
  return url ? (
    <a
      href={url}
      download={name}
      title={t("sessions.chat.downloadFile")}
      className={`${className} transition-colors hover:bg-surface-2`}
    >
      {content}
    </a>
  ) : (
    <div className={className}>{content}</div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function ChatBubble({
  msg,
  extracted,
  onA2UIAction,
  onCanvasOpApplied,
  onOpenSidebar,
  onPinA2UI,
  showAvatar = true,
  presentation = "full",
  onOpenLink,
  onBranch,
  onRollback,
  messageAction = null,
  actionsDisabled = false,
}: {
  msg: ChatMessageData;
  extracted?: ExtractedMessage;
  onA2UIAction?: (actionName: string, context: Record<string, unknown>) => void;
  onCanvasOpApplied?: (result: { applied: number; errors: string[] }) => void;
  onOpenSidebar?: (payload: SidebarA2UIPayload) => void;
  /** Pin an inline A2UI surface onto the canvas workbench. */
  onPinA2UI?: (messages: A2UIMessage[]) => void;
  /** False for consecutive same-sender messages — renders an alignment spacer instead. */
  showAvatar?: boolean;
  presentation?: "full" | "artifacts-only";
  onOpenLink?: (url: string) => void;
  onBranch?: (messageId: string) => void;
  onRollback?: (messageId: string) => void;
  messageAction?: "branch" | "rollback" | null;
  actionsDisabled?: boolean;
}) {
  const { t } = useTranslation();
  const resolvedExtracted =
    extracted ?? extractMessage(msg as unknown as Record<string, unknown>);
  const {
    text,
    replyContextText,
    // biome-ignore lint/correctness/noUnusedVariables: used in extractMessage return shape
    senderName,
    hasA2UI,
    a2uiMessages,
    sidebarA2UI,
    a2uiAction,
    canvasOpBatch,
    canvasOpResult,
    images,
    fileCards,
  } = resolvedExtracted;
  const time = formatTs(msg.timestamp);
  const isBot = msg.role === "assistant";
  const hasText = text.trim().length > 0;
  const showText = presentation === "full" && hasText;
  const hasReplyContext = (replyContextText?.trim().length ?? 0) > 0;
  const hasMedia = images.length > 0 || fileCards.length > 0;

  return (
    <div
      data-chat-message={msg.id}
      data-chat-role={msg.role}
      data-chat-presentation={presentation}
      className="group/bubble flex gap-3 items-start"
    >
      {showAvatar ? (
        <img
          src={isBot ? BOT_AVATAR : USER_AVATAR}
          alt=""
          className="shrink-0 w-9 h-9 -ml-1 mt-0 object-contain"
        />
      ) : (
        <div aria-hidden className="shrink-0 w-9 h-9 -ml-1" />
      )}
      <div className={cn("flex max-w-[44rem] flex-col gap-2", "items-start")}>
        {hasReplyContext && replyContextText && (
          <ReplyContextCard text={replyContextText} isBot={isBot} />
        )}
        {hasMedia && (
          <div className="flex flex-col gap-1.5">
            {images.map((img, i) => (
              <InlineImage key={`img-${img.mimeType}-${i}`} {...img} />
            ))}
            {fileCards.map((fc, i) => (
              <MessageFileCard key={`fc-${fc.name}-${i}`} {...fc} />
            ))}
          </div>
        )}
        {a2uiAction && (
          <div className="inline-flex items-center gap-2 rounded-full border border-[color-mix(in_srgb,var(--color-success)_12%,transparent)] bg-[rgba(0,163,101,0.06)] px-3 py-1.5 text-[12px]">
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-success-muted)] text-[var(--color-success)]">
              <CheckCircle2 className="size-[13px]" />
            </span>
            <span className="font-medium text-text-primary">
              {a2uiActionLabel(a2uiAction.actionName)}
            </span>
          </div>
        )}
        {canvasOpResult && (
          <div
            data-canvas-op-result
            className="inline-flex items-center gap-2 rounded-full border border-[var(--color-danger)]/25 bg-[var(--color-danger-subtle)] px-3 py-1.5 text-[12px]"
          >
            <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-danger-subtle)] text-[var(--color-danger)]">
              <CircleAlert className="size-[13px]" />
            </span>
            <span className="font-medium text-text-primary">
              画布操作应用失败（{canvasOpResult.errors.length} 项）
            </span>
          </div>
        )}
        {showText && (
          <div
            data-deskpet-reply-preview={isBot ? text : undefined}
            className={cn(
              "inline-block max-w-full rounded-[20px] px-4 py-3 text-[13px] break-words shadow-[0_10px_24px_rgba(15,23,42,0.04)]",
              isBot
                ? "border border-border bg-surface-1 text-text-primary"
                : "bg-surface-3 text-text-primary",
            )}
          >
            <ChatMarkdown content={text} onOpenLink={onOpenLink} />
          </div>
        )}
        {isBot && hasA2UI && a2uiMessages && (
          <InlineA2UIHost
            messages={a2uiMessages}
            onA2UIAction={onA2UIAction}
            onPin={onPinA2UI}
          />
        )}
        {isBot && sidebarA2UI && onOpenSidebar && (
          <SidebarA2UIButton payload={sidebarA2UI} onOpen={onOpenSidebar} />
        )}
        {isBot && canvasOpBatch && (
          <CanvasOpCard batch={canvasOpBatch} onApplied={onCanvasOpApplied} />
        )}
        {presentation === "full" && (
          <div className="flex items-center gap-1 pl-1">
            {time && <div className="text-[10px] text-text-muted">{time}</div>}
            {isBot && hasText && <SpeakButton text={text} />}
            {onBranch && (
              <button
                type="button"
                data-message-action="branch"
                aria-label={t("sessions.chat.branchFromMessage", {
                  defaultValue: "Branch from this message",
                })}
                title={t("sessions.chat.branchFromMessage", {
                  defaultValue: "Branch from this message",
                })}
                disabled={actionsDisabled}
                onClick={() => onBranch(msg.id)}
                className="inline-flex rounded-md p-1 text-text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-text-primary focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-30 group-hover/bubble:opacity-100"
              >
                {messageAction === "branch" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <GitBranch className="size-3" />
                )}
              </button>
            )}
            {onRollback && (
              <button
                type="button"
                data-message-action="rollback"
                aria-label={t("sessions.chat.rollbackToMessage", {
                  defaultValue: "Roll back to this message",
                })}
                title={t("sessions.chat.rollbackToMessage", {
                  defaultValue: "Roll back to this message",
                })}
                disabled={actionsDisabled}
                onClick={() => onRollback(msg.id)}
                className="inline-flex rounded-md p-1 text-text-muted opacity-0 transition-opacity hover:bg-surface-2 hover:text-text-primary focus-visible:opacity-100 disabled:pointer-events-none disabled:opacity-30 group-hover/bubble:opacity-100"
              >
                {messageAction === "rollback" ? (
                  <Loader2 className="size-3 animate-spin" />
                ) : (
                  <RotateCcw className="size-3" />
                )}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function hasPersistentAssistantOutput(extracted: ExtractedMessage): boolean {
  return (
    extracted.hasA2UI ||
    extracted.sidebarA2UI !== null ||
    extracted.canvasOpBatch !== null ||
    extracted.images.length > 0 ||
    extracted.fileCards.length > 0
  );
}

type SideQuestionView = {
  runId: string | null;
  question: string;
  text: string;
  status: "pending" | "done" | "error";
};

function SideQuestionPanel({
  value,
  onDismiss,
}: {
  value: SideQuestionView;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-side-question-result={value.status}
      className="mb-2 rounded-lg border border-sky-200 bg-sky-50/70 px-3 py-2.5"
    >
      <div className="flex items-start gap-2">
        <MessageCircleQuestion className="mt-0.5 h-4 w-4 shrink-0 text-sky-700" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 text-xs font-medium text-sky-900">
            <span>{t("sessions.chat.sideAnswer")}</span>
            {value.status === "pending" && (
              <Loader2 className="h-3 w-3 animate-spin" />
            )}
          </div>
          <div className="mt-0.5 truncate text-[11px] text-sky-700">
            {value.question}
          </div>
          {value.text && (
            <div
              className={cn(
                "mt-2 text-sm",
                value.status === "error" ? "text-red-700" : "text-text-primary",
              )}
            >
              <ChatMarkdown content={value.text} />
            </div>
          )}
        </div>
        <button
          type="button"
          onClick={onDismiss}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded-md text-sky-700 transition-colors hover:bg-sky-100"
          aria-label={t("sessions.chat.sideAnswerDismiss")}
          title={t("sessions.chat.sideAnswerDismiss")}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  );
}

function RunMessageChoicePanel({
  message,
  onChoose,
  onDismiss,
}: {
  message: string;
  onChoose: (intent: "side-question" | "steer") => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      data-run-message-choice="true"
      className="mb-2 flex flex-wrap items-center gap-2 border-l-2 border-[var(--color-tabby-orange)] px-3 py-1.5"
    >
      <div className="min-w-0 basis-full sm:flex-1 sm:basis-auto">
        <div className="text-xs font-medium text-text-primary">
          {t("sessions.chat.runIntentConfirm")}
        </div>
        <div className="truncate text-[11px] text-text-muted">{message}</div>
      </div>
      <button
        type="button"
        onClick={() => onChoose("side-question")}
        className="h-8 shrink-0 rounded-md border border-border px-2.5 text-xs text-text-primary transition-colors hover:bg-surface-2"
      >
        {t("sessions.chat.runModeSideQuestion")}
      </button>
      <button
        type="button"
        onClick={() => onChoose("steer")}
        className="h-8 shrink-0 rounded-md bg-[var(--color-tabby-orange)] px-2.5 text-xs text-white transition-colors hover:bg-[var(--color-tabby-orange-hover)]"
      >
        {t("sessions.chat.runModeSteer")}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        className="flex size-7 shrink-0 items-center justify-center rounded-md text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary"
        aria-label={t("sessions.chat.runIntentDismiss")}
        title={t("sessions.chat.runIntentDismiss")}
      >
        <X className="size-3.5" />
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

export function SessionsPage() {
  const { t } = useTranslation();
  const { id } = useParams<{ id: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [deskpetReplyFocusToken, setDeskpetReplyFocusToken] = useState<
    string | null
  >(null);
  const endRef = useRef<HTMLDivElement>(null);
  const queryClient = useQueryClient();
  const { openWith } = useA2UISidebar();
  const browserPanel = useBrowserPanel();
  const { isOpen: pinnedPanelOpen } = usePinnedPanel();
  const [operationsOpen, setOperationsOpen] = useState(false);

  useEffect(() => {
    if (id) track("session_detail_view");
  }, [id]);

  // Session metadata
  const { data: session } = useQuery({
    queryKey: ["session-meta", id],
    queryFn: async () => {
      const { data } = await getApiV1SessionsById({ path: { id: id ?? "" } });
      return data;
    },
    enabled: !!id,
  });

  const { data: previewArtifacts = [] } = useQuery({
    queryKey: ["browser-artifacts", session?.sessionKey],
    queryFn: async () => {
      const { data, error } = await getApiV1Artifacts({
        query: {
          sessionKey: session?.sessionKey ?? "",
          limit: 50,
          offset: 0,
        },
      });
      if (error) throw new Error("Unable to load preview artifacts");
      return (data?.artifacts ?? []) as PreviewArtifact[];
    },
    enabled: Boolean(session?.sessionKey),
    refetchInterval: 2000,
  });
  const latestPreviewArtifact = selectLatestPreviewArtifact([
    ...previewArtifacts,
  ]);
  const previewAutoOpenTrackerRef = useRef(createPreviewAutoOpenTracker());

  useEffect(() => {
    const sessionKey = session?.sessionKey ?? null;
    const observation = observePreviewArtifact({
      tracker: previewAutoOpenTrackerRef.current,
      sessionKey,
      artifact: latestPreviewArtifact,
      now: Date.now(),
    });
    previewAutoOpenTrackerRef.current = observation.tracker;

    if (!observation.shouldOpen || !sessionKey) return;
    if (browserPanel.isOpen && browserPanel.sessionKey === sessionKey) return;

    setOperationsOpen(false);
    setPanelOpen(false);
    openBrowserPanel(sessionKey);
  }, [
    browserPanel.isOpen,
    browserPanel.sessionKey,
    latestPreviewArtifact,
    session?.sessionKey,
  ]);

  // Chat history — polls every 5s as reliable fallback. SSE invalidates for instant updates.
  const {
    data: chatData,
    isLoading: chatLoading,
    isError: chatError,
  } = useQuery({
    queryKey: ["chat-history", id],
    queryFn: async () => {
      const { data } = await getApiV1SessionsByIdMessages({
        path: { id: id ?? "" },
        query: { limit: 200 },
      });
      return data;
    },
    enabled: !!id,
    refetchInterval: 5000,
  });

  // SSE real-time connection — streams delta events for fast perceived response
  // and invalidates chat history on final/aborted/error.
  // Polling (5s refetchInterval above) handles the fallback regardless of SSE state.
  const [streamingText, setStreamingText] = useState("");
  const [sideQuestion, setSideQuestion] = useState<SideQuestionView | null>(
    null,
  );
  const [pendingRunMessageChoice, setPendingRunMessageChoice] = useState<
    string | null
  >(null);
  const sideRunIdsRef = useRef(new Set<string>());
  const steerRunHandoffRef = useRef<SteerRunHandoff | null>(null);
  const sideQuestionRequestRef = useRef<symbol | null>(null);
  const steerRequestRef = useRef<symbol | null>(null);
  const intentRequestRef = useRef<symbol | null>(null);

  useEffect(() => {
    if (!sideQuestion || sideQuestion.status === "pending") return;
    const completedSideQuestion = sideQuestion;
    const timer = window.setTimeout(() => {
      setSideQuestion((current) =>
        current === completedSideQuestion ? null : current,
      );
    }, SIDE_QUESTION_AUTO_DISMISS_MS);
    return () => window.clearTimeout(timer);
  }, [sideQuestion]);

  useEffect(() => {
    if (!id || !session?.botId || !session?.sessionKey) return;

    const client = createLocalStreamSSEClient({
      botId: session.botId,
      sessionKey: session.sessionKey,
      onConnected: () => {
        // Stream established — no action needed
      },
      onDelta: (delta) => {
        // Accumulate streaming text for real-time display
        setStreamingText((prev) => {
          const next = delta.replace ? delta.deltaText : prev + delta.deltaText;
          const preview = stripMediaMarkerLines(next).trim();
          if (preview) {
            latestStreamingReplyTextRef.current = preview.slice(0, 280);
          }
          return next;
        });
        invokeDesktopHost("desktop:deskpet-activity", {
          mood: "lobster-replying",
          durationMs: DESKPET_REPLYING_DURATION_MS,
        });
      },
      onFinal: (final) => {
        if (sideRunIdsRef.current.delete(final.runId)) {
          return;
        }
        if (
          consumeReplacementRunTerminal(steerRunHandoffRef.current, final.runId)
        ) {
          activeRunIdRef.current = final.runId;
        }
        void queryClient.invalidateQueries({ queryKey: ["session-meta", id] });
        void queryClient.invalidateQueries({
          queryKey: ["chat-run-status", id],
        });
        // OpenClaw emits ONE final per run, at run end (emitChatFinal fires
        // on jobState "done") — intermediate visible replies arrive only via
        // history polling.  So final IS the "whole reply finished" signal.
        if (
          activeRunIdRef.current &&
          final.runId &&
          final.runId !== activeRunIdRef.current
        ) {
          // A different run in this session (e.g. cron-triggered) finished —
          // refresh history but keep waiting for our own run.
          void queryClient.invalidateQueries({
            queryKey: ["chat-history", id],
          });
          return;
        }
        if (!deskpetReplyPendingRef.current) {
          void queryClient.invalidateQueries({
            queryKey: ["chat-history", id],
          });
          return;
        }
        const replyText =
          latestStreamingReplyTextRef.current ||
          latestAssistantReplyTextRef.current;
        logDeskpetHostDebug("run final; send success", { replyText });
        invokeDesktopHost("desktop:deskpet-activity", {
          mood: "success",
          durationMs: DESKPET_SUCCESS_DURATION_MS,
          replyText,
        });
        deskpetReplyPendingRef.current = false;
        activeRunIdRef.current = null;
        setStreamingText("");
        setWaitingForReply(false);
        sentAtRef.current = 0;
        deskpetReplyStartedAtRef.current = 0;
        latestAssistantReplyTextRef.current = "";
        latestStreamingReplyTextRef.current = "";
        setPendingMessages([]);
        void queryClient.invalidateQueries({ queryKey: ["chat-history", id] });
      },
      onAborted: (aborted) => {
        if (sideRunIdsRef.current.delete(aborted.runId)) {
          return;
        }
        void queryClient.invalidateQueries({ queryKey: ["session-meta", id] });
        void queryClient.invalidateQueries({
          queryKey: ["chat-run-status", id],
        });
        const steerHandoff = steerRunHandoffRef.current;
        if (consumePreviousRunAbort(steerHandoff, aborted.runId)) {
          setStreamingText("");
          latestAssistantReplyTextRef.current = "";
          latestStreamingReplyTextRef.current = "";
          if (steerHandoff?.accepted) {
            steerRunHandoffRef.current = null;
          }
          void queryClient.invalidateQueries({
            queryKey: ["chat-history", id],
          });
          return;
        }
        if (consumeReplacementRunTerminal(steerHandoff, aborted.runId)) {
          activeRunIdRef.current = aborted.runId;
        }
        if (
          activeRunIdRef.current &&
          aborted.runId &&
          aborted.runId !== activeRunIdRef.current
        ) {
          void queryClient.invalidateQueries({
            queryKey: ["chat-history", id],
          });
          return;
        }
        activeRunIdRef.current = null;
        deskpetReplyPendingRef.current = false;
        setStreamingText("");
        setWaitingForReply(false);
        sentAtRef.current = 0;
        deskpetReplyStartedAtRef.current = 0;
        latestAssistantReplyTextRef.current = "";
        latestStreamingReplyTextRef.current = "";
        invokeDesktopHost("desktop:deskpet-activity", {
          mood: "error",
          durationMs: DESKPET_ERROR_DURATION_MS,
        });
        void queryClient.invalidateQueries({ queryKey: ["chat-history", id] });
      },
      onError: (error) => {
        if (sideRunIdsRef.current.delete(error.runId)) {
          return;
        }
        if (
          consumeReplacementRunTerminal(steerRunHandoffRef.current, error.runId)
        ) {
          activeRunIdRef.current = error.runId;
        }
        void queryClient.invalidateQueries({ queryKey: ["session-meta", id] });
        void queryClient.invalidateQueries({
          queryKey: ["chat-run-status", id],
        });
        if (
          activeRunIdRef.current &&
          error.runId &&
          error.runId !== activeRunIdRef.current
        ) {
          void queryClient.invalidateQueries({
            queryKey: ["chat-history", id],
          });
          return;
        }
        activeRunIdRef.current = null;
        deskpetReplyPendingRef.current = false;
        setStreamingText("");
        setWaitingForReply(false);
        sentAtRef.current = 0;
        deskpetReplyStartedAtRef.current = 0;
        latestAssistantReplyTextRef.current = "";
        latestStreamingReplyTextRef.current = "";
        invokeDesktopHost("desktop:deskpet-activity", {
          mood: "error",
          durationMs: DESKPET_ERROR_DURATION_MS,
        });
        void queryClient.invalidateQueries({ queryKey: ["chat-history", id] });
      },
      onSideResult: (result) => {
        sideRunIdsRef.current.add(result.runId);
        setSideQuestion((current) => {
          if (current?.runId && current.runId !== result.runId) {
            return current;
          }
          return {
            runId: result.runId,
            question: result.question,
            text: result.text,
            status: result.isError ? "error" : "done",
          };
        });
      },
    });

    client.connect();
    return () => {
      client.disconnect();
    };
  }, [id, session?.botId, session?.sessionKey, queryClient]);

  // Bind this session to its own canvas board (W5): opening a session switches
  // the global canvas to that session's board, lazily creating one on first
  // visit. Keyed on sessionKey so it fires once per focused session, not per
  // render (title is read only to name a freshly-created board — a later title
  // change must not re-bind, so it is intentionally not a dependency).
  // bindSessionToBoard routes through the reviewed switchCanvasBoard
  // (flush-save-first) so no board content is ever lost or mixed.
  // biome-ignore lint/correctness/useExhaustiveDependencies: sessionKey keys the bind; title is a creation-only label
  useEffect(() => {
    if (!session?.sessionKey) return;
    void bindSessionToBoard(session.sessionKey, session.title ?? undefined);
  }, [session?.sessionKey]);

  const { data: channelsData } = useQuery({
    queryKey: ["channels"],
    queryFn: async () => {
      const { data } = await getApiV1Channels();
      return data;
    },
    enabled: !!id,
  });

  // Bots list (for ChatInputArea)
  const { data: botsData } = useQuery({
    queryKey: ["bots"],
    queryFn: async () => {
      const { data } = await getApiV1Bots();
      return data;
    },
  });
  const bots = (botsData?.bots ?? []) as BotItem[];

  // Selected bot for this session
  const { data: botData } = useQuery({
    queryKey: ["bot", session?.botId],
    queryFn: async () => {
      if (!session?.botId) return null;
      const { data } = await getApiV1BotsByBotId({
        path: { botId: session.botId },
      });
      return data;
    },
    enabled: !!session?.botId,
  });
  const bot = (botData as Record<string, unknown> | null) ?? null;
  const selectedBot: BotItem | null = bot
    ? ({
        id: (bot as Record<string, unknown>).id as string,
        name: (bot as Record<string, unknown>).name as string,
        slug: (bot as Record<string, unknown>).slug as string,
        status: (bot as Record<string, unknown>).status as
          | "active"
          | "paused"
          | "deleted",
        modelId: ((bot as Record<string, unknown>).modelId ?? null) as
          | string
          | null,
      } as BotItem)
    : null;

  useEffect(() => {
    const botId = selectedBot?.id ?? session?.botId;
    if (!botId || !session?.sessionKey || !id) {
      return;
    }

    invokeDesktopHost("desktop:deskpet-register-current-chat", {
      botId,
      sessionKey: session.sessionKey,
      sessionId: id,
    });
  }, [id, selectedBot?.id, session?.botId, session?.sessionKey]);

  // Stable A2UI action handler shared by inline rendering and sidebar
  const onA2UIAction = useCallback(
    (actionName: string, context: Record<string, unknown>) => {
      if (!selectedBot || !id || !session?.sessionKey) return;
      void postApiV1ChatLocal({
        body: {
          botId: selectedBot.id,
          sessionKey: session.sessionKey,
          message: {
            type: "text",
            content: JSON.stringify({
              type: "a2ui_action",
              actionName,
              data: context,
            }),
          },
        },
      });
    },
    [selectedBot, id, session?.sessionKey],
  );

  // Report a canvas-op apply failure back into the session so the agent's
  // NEXT turn can see it (the courier tool only proposes the batch — actual
  // apply happens later, client-side, when the user clicks 应用, so this is
  // the only channel back). Skipped on a clean apply: the agent already
  // assumes success per its own tool instructions, so nothing to add.
  const onCanvasOpApplied = useCallback(
    (result: { applied: number; errors: string[] }) => {
      if (result.errors.length === 0) return;
      if (!selectedBot || !id || !session?.sessionKey) return;
      void postApiV1ChatLocal({
        body: {
          botId: selectedBot.id,
          sessionKey: session.sessionKey,
          message: {
            type: "text",
            content: JSON.stringify({
              type: "canvas_op_result",
              applied: result.applied,
              errors: result.errors,
            }),
          },
        },
      });
    },
    [selectedBot, id, session?.sessionKey],
  );

  // Send message handler
  const [pendingMessages, setPendingMessages] = useState<
    {
      id: string;
      text: string;
      timestamp: number;
      attachments: PendingAttachment[];
    }[]
  >([]);
  const [waitingForReply, setWaitingForReply] = useState(false);
  const [runMessageSending, setRunMessageSending] = useState(false);
  const [newSessionDividerTime, setNewSessionDividerTime] = useState<
    number | null
  >(null);
  const sentAtRef = useRef(0);
  const deskpetReplyStartedAtRef = useRef(0);
  /** runId of the chat run this composer is waiting on (null = any run). */
  const activeRunIdRef = useRef<string | null>(null);
  const deskpetReplyPendingRef = useRef(false);
  const latestAssistantReplyTextRef = useRef("");
  const latestStreamingReplyTextRef = useRef("");
  const handledDeskpetPendingKeyRef = useRef("");
  const lastDeskpetTypingNotifyAtRef = useRef(0);

  const markDeskpetReplyWaiting = useCallback(
    ({
      pendingReplyText = "",
      runId = "",
    }: {
      pendingReplyText?: string;
      runId?: string;
    }) => {
      sentAtRef.current = Date.now();
      deskpetReplyStartedAtRef.current = sentAtRef.current;
      activeRunIdRef.current = runId || null;
      deskpetReplyPendingRef.current = true;
      latestAssistantReplyTextRef.current = "";
      latestStreamingReplyTextRef.current = pendingReplyText.slice(0, 280);
      setWaitingForReply(true);
      invokeDesktopHost("desktop:deskpet-activity", {
        mood: "lobster-replying",
        durationMs: DESKPET_REPLYING_DURATION_MS,
      });
    },
    [],
  );

  // Reset waiting state when switching sessions
  // biome-ignore lint/correctness/useExhaustiveDependencies: id triggers reset on session navigation
  useEffect(() => {
    setWaitingForReply(false);
    setRunMessageSending(false);
    sentAtRef.current = 0;
    deskpetReplyStartedAtRef.current = 0;
    activeRunIdRef.current = null;
    steerRunHandoffRef.current = null;
    sideQuestionRequestRef.current = null;
    steerRequestRef.current = null;
    intentRequestRef.current = null;
    deskpetReplyPendingRef.current = false;
    latestAssistantReplyTextRef.current = "";
    latestStreamingReplyTextRef.current = "";
    handledDeskpetPendingKeyRef.current = "";
    setPendingMessages([]);
    setStreamingText("");
    setSideQuestion(null);
    setPendingRunMessageChoice(null);
    sideRunIdsRef.current.clear();
  }, [id]);

  useEffect(() => {
    const state = location.state as {
      deskpetPendingReplyText?: unknown;
      deskpetPendingRunId?: unknown;
      deskpetPendingSessionKey?: unknown;
    } | null;
    const pendingSessionKey =
      typeof state?.deskpetPendingSessionKey === "string"
        ? state.deskpetPendingSessionKey
        : (searchParams.get("deskpetSessionKey")?.trim() ?? "");
    const pendingStartedAt = searchParams.get("deskpetStartedAt")?.trim() ?? "";
    const pendingRunIdFromQuery =
      searchParams.get("deskpetRunId")?.trim() ?? "";
    const pendingRunIdFromState =
      typeof state?.deskpetPendingRunId === "string"
        ? state.deskpetPendingRunId
        : "";
    const pendingRunId = pendingRunIdFromState || pendingRunIdFromQuery;
    const pendingReplyText =
      typeof state?.deskpetPendingReplyText === "string"
        ? stripMediaMarkerLines(state.deskpetPendingReplyText).trim()
        : "";
    const key = `${id ?? ""}:${pendingSessionKey}:${pendingRunId}:${pendingStartedAt}`;

    if (
      !id ||
      !pendingSessionKey ||
      handledDeskpetPendingKeyRef.current === key
    ) {
      return;
    }

    handledDeskpetPendingKeyRef.current = key;
    markDeskpetReplyWaiting({
      pendingReplyText,
      runId: pendingRunId,
    });
    void queryClient.invalidateQueries({ queryKey: ["chat-history", id] });
  }, [id, location.state, markDeskpetReplyWaiting, queryClient, searchParams]);

  useEffect(() => {
    return onDesktopHostCommand((command) => {
      if (
        command.type === "desktop:open-web-path" &&
        command.focusReply &&
        id &&
        command.path === `/workspace/sessions/${id}`
      ) {
        setDeskpetReplyFocusToken(String(Date.now()));
        return;
      }

      if (command.type === "deskpet:chat-started") {
        const commandSessionId =
          typeof command.sessionId === "string" ? command.sessionId : null;
        const commandSessionKey =
          typeof command.sessionKey === "string" ? command.sessionKey : null;

        if (commandSessionId) {
          if (commandSessionId !== id) {
            return;
          }
        } else if (commandSessionKey !== session?.sessionKey) {
          return;
        }

        const runId = typeof command.runId === "string" ? command.runId : "";
        const startedAt =
          typeof command.startedAt === "number"
            ? String(command.startedAt)
            : "";
        const key = `${id ?? ""}:${commandSessionKey ?? ""}:${runId}:${startedAt}`;
        if (handledDeskpetPendingKeyRef.current === key) {
          return;
        }

        handledDeskpetPendingKeyRef.current = key;
        markDeskpetReplyWaiting({ runId });
        void queryClient.invalidateQueries({ queryKey: ["chat-history", id] });
        void queryClient.invalidateQueries({ queryKey: ["session-meta", id] });
        return;
      }

      if (command.type !== "deskpet:current-chat-replied") {
        return;
      }

      const commandSessionId =
        typeof command.sessionId === "string" ? command.sessionId : null;
      const commandSessionKey =
        typeof command.sessionKey === "string" ? command.sessionKey : null;

      if (commandSessionId) {
        if (commandSessionId !== id) {
          return;
        }
      } else if (commandSessionKey !== session?.sessionKey) {
        return;
      }

      const text = typeof command.text === "string" ? command.text.trim() : "";
      if (!text || !id) {
        return;
      }

      const now = Date.now();
      activeRunIdRef.current = null;
      markDeskpetReplyWaiting({});
      setPendingMessages((prev) => {
        if (
          prev.some(
            (message) =>
              message.text === text && message.attachments.length === 0,
          )
        ) {
          return prev;
        }

        return [
          ...prev,
          {
            id: `deskpet-${now}`,
            text,
            timestamp: now,
            attachments: [],
          },
        ];
      });
      void queryClient.invalidateQueries({ queryKey: ["chat-history", id] });
      void queryClient.invalidateQueries({ queryKey: ["session-meta", id] });
    });
  }, [id, markDeskpetReplyWaiting, session?.sessionKey, queryClient]);

  const handleSend = useCallback(
    async (
      text: string,
      attachments: PendingAttachment[],
      skillSlug: string | null,
    ) => {
      if (!selectedBot || !id || !session?.sessionKey) return false;

      // Intercept /new command
      const trimmed = text.trim().toLowerCase();
      if (["/new", "/reset", "/clear"].includes(trimmed)) {
        try {
          await postApiV1SessionsByIdReset({ path: { id } });
          setNewSessionDividerTime(Date.now());
          setWaitingForReply(false);
          sentAtRef.current = 0;
          deskpetReplyStartedAtRef.current = 0;
          await queryClient.invalidateQueries({
            queryKey: ["chat-history", id],
          });
          toast.success(
            t("sessions.chat.newSession", { defaultValue: "New conversation" }),
          );
          return true;
        } catch {
          toast.error(
            t("sessions.chat.newSession", { defaultValue: "New conversation" }),
          );
          return false;
        }
      }

      const optimisticId = `pending-${Date.now()}`;
      const now = Date.now();
      sentAtRef.current = now;
      deskpetReplyStartedAtRef.current = now;
      deskpetReplyPendingRef.current = true;
      latestAssistantReplyTextRef.current = "";
      latestStreamingReplyTextRef.current = "";
      setWaitingForReply(true);
      invokeDesktopHost("desktop:deskpet-activity", {
        mood: "lobster-replying",
        durationMs: DESKPET_REPLYING_DURATION_MS,
      });

      // Format message payload with attachment support (mirrors local-chat.tsx)
      const onlyImage = attachments[0];
      const isImageOnly =
        attachments.length === 1 &&
        onlyImage?.type === "image" &&
        Boolean(onlyImage.content) &&
        !text.trim();
      const msgContent = isImageOnly
        ? {
            type: "image" as const,
            content: onlyImage?.content ?? "",
            metadata: { mimeType: onlyImage?.mimeType ?? "image/png" },
          }
        : {
            type: "text" as const,
            content: text,
            ...(skillSlug ? { skillSlug } : {}),
            attachments:
              attachments.length > 0
                ? attachments.map((a) => ({
                    type: a.type,
                    content: a.content,
                    stagedPath: a.stagedPath,
                    metadata: {
                      mimeType: a.mimeType,
                      filename: a.filename,
                      size: a.size,
                    },
                  }))
                : undefined,
          };

      setPendingMessages((prev) => [
        ...prev,
        {
          id: optimisticId,
          text,
          timestamp: now,
          attachments,
        },
      ]);

      try {
        const result = await postApiV1ChatLocal({
          body: {
            botId: selectedBot.id,
            sessionKey: session.sessionKey,
            message: msgContent,
          },
        });
        if (result.error) {
          // Send was rejected before a run started — most commonly 409 "a run
          // is already active for this session" (OpenClaw holds the session
          // write-lock for the whole in-flight turn, so a concurrent turn can't
          // start). Roll the optimistic bubble back and show a friendly notice
          // instead of leaving the composer stuck "waiting".
          activeRunIdRef.current = null;
          deskpetReplyPendingRef.current = false;
          setWaitingForReply(false);
          deskpetReplyStartedAtRef.current = 0;
          latestAssistantReplyTextRef.current = "";
          latestStreamingReplyTextRef.current = "";
          setPendingMessages((prev) =>
            prev.filter((m) => m.id !== optimisticId),
          );
          invokeDesktopHost("desktop:deskpet-activity", {
            mood: "error",
            durationMs: DESKPET_ERROR_DURATION_MS,
          });
          toast.info(
            t("sessions.chat.sessionBusy", {
              defaultValue: "上一条消息还在处理中，请等当前任务完成后再发送。",
            }),
          );
          return false;
        }
        // Remember our run id so SSE final/aborted/error events from OTHER
        // runs in this session don't prematurely re-enable the composer.
        activeRunIdRef.current = result.data?.message?.runId ?? null;
        await queryClient.invalidateQueries({
          queryKey: ["chat-history", id],
        });
        return true;
      } catch {
        activeRunIdRef.current = null;
        deskpetReplyPendingRef.current = false;
        setWaitingForReply(false);
        setPendingMessages((prev) => prev.filter((m) => m.id !== optimisticId));
        deskpetReplyStartedAtRef.current = 0;
        latestAssistantReplyTextRef.current = "";
        latestStreamingReplyTextRef.current = "";
        invokeDesktopHost("desktop:deskpet-activity", {
          mood: "error",
          durationMs: DESKPET_ERROR_DURATION_MS,
        });
        return false;
      }
    },
    [selectedBot, id, session?.sessionKey, queryClient, t],
  );

  const handleSideQuestion = useCallback(
    async (question: string) => {
      if (!selectedBot || !session?.sessionKey) return;
      const requestToken = Symbol("side-question");
      sideQuestionRequestRef.current = requestToken;
      setRunMessageSending(true);
      setSideQuestion({
        runId: null,
        question,
        text: "",
        status: "pending",
      });
      try {
        const result = await postApiV1ChatSideQuestion({
          body: {
            botId: selectedBot.id,
            sessionKey: session.sessionKey,
            question,
          },
        });
        if (result.error || !result.data?.accepted) {
          throw new Error(
            (result.error as { message?: string } | undefined)?.message ??
              t("sessions.chat.sideQuestionFailed"),
          );
        }
        if (sideQuestionRequestRef.current !== requestToken) return;
        if (result.data.runId) {
          sideRunIdsRef.current.add(result.data.runId);
        }
        setSideQuestion((current) =>
          current?.status === "pending"
            ? { ...current, runId: result.data?.runId ?? null }
            : current,
        );
      } catch (error) {
        if (sideQuestionRequestRef.current !== requestToken) return;
        setSideQuestion({
          runId: null,
          question,
          text:
            error instanceof Error
              ? error.message
              : t("sessions.chat.sideQuestionFailed"),
          status: "error",
        });
      } finally {
        if (sideQuestionRequestRef.current === requestToken) {
          sideQuestionRequestRef.current = null;
          setRunMessageSending(false);
        }
      }
    },
    [selectedBot, session?.sessionKey, t],
  );

  const handleSteer = useCallback(
    async (message: string) => {
      if (!selectedBot || !id || !session?.sessionKey) return;
      const handoff = beginSteerRunHandoff(activeRunIdRef.current);
      const requestToken = Symbol("steer");
      steerRunHandoffRef.current = handoff;
      steerRequestRef.current = requestToken;
      setRunMessageSending(true);
      try {
        const result = await postApiV1ChatSteer({
          body: {
            botId: selectedBot.id,
            sessionKey: session.sessionKey,
            message,
          },
        });
        if (result.error || !result.data?.accepted) {
          throw new Error(
            (result.error as { message?: string } | undefined)?.message ??
              t("sessions.chat.steerFailed"),
          );
        }
        if (
          steerRunHandoffRef.current !== handoff ||
          steerRequestRef.current !== requestToken
        ) {
          return;
        }
        const replacementRunId = result.data.runId ?? null;
        acceptSteerRunHandoff(handoff, replacementRunId);
        activeRunIdRef.current = handoff.replacementRunTerminated
          ? null
          : replacementRunId;
        if (handoff.previousRunAborted) {
          steerRunHandoffRef.current = null;
        }
        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["chat-history", id] }),
          queryClient.invalidateQueries({ queryKey: ["chat-run-status", id] }),
          queryClient.invalidateQueries({ queryKey: ["session-meta", id] }),
        ]);
      } catch (error) {
        if (
          steerRunHandoffRef.current !== handoff ||
          steerRequestRef.current !== requestToken
        ) {
          return;
        }
        steerRunHandoffRef.current = null;
        if (handoff.replacementRunTerminated) return;
        if (handoff.previousRunAborted) {
          activeRunIdRef.current = null;
          deskpetReplyPendingRef.current = false;
          setStreamingText("");
          setWaitingForReply(false);
          sentAtRef.current = 0;
          deskpetReplyStartedAtRef.current = 0;
          latestAssistantReplyTextRef.current = "";
          latestStreamingReplyTextRef.current = "";
          invokeDesktopHost("desktop:deskpet-activity", {
            mood: "error",
            durationMs: DESKPET_ERROR_DURATION_MS,
          });
        }
        toast.error(
          error instanceof Error
            ? error.message
            : t("sessions.chat.steerFailed"),
        );
      } finally {
        if (steerRequestRef.current === requestToken) {
          steerRequestRef.current = null;
          setRunMessageSending(false);
        }
      }
    },
    [selectedBot, id, session?.sessionKey, queryClient, t],
  );

  const handleDeskpetTyping = useCallback(
    (text: string) => {
      if (waitingForReply || !text.trim()) {
        return;
      }

      const now = Date.now();
      if (
        now - lastDeskpetTypingNotifyAtRef.current <
        DESKPET_TYPING_NOTIFY_INTERVAL_MS
      ) {
        return;
      }

      lastDeskpetTypingNotifyAtRef.current = now;
      invokeDesktopHost("desktop:deskpet-activity", {
        mood: "working",
        durationMs: DESKPET_TYPING_WORKING_DURATION_MS,
      });
    },
    [waitingForReply],
  );

  /**
   * Binds this bot to a model, or clears the binding back to following the
   * global default when `modelId` is null.
   *
   * The picker used to be inert here (a no-op handler behind modelReadOnly),
   * so the only way to change a model was the global setting — which then
   * rewrote every bot and erased any per-bot choice.
   */
  const updateBotModel = useCallback(
    async (botId: string, modelId: string | null): Promise<void> => {
      const { error } = await patchApiV1BotsByBotId({
        path: { botId },
        body: { modelId },
      });
      if (error) {
        toast.error(t("models.modelSwitchFailed"));
        return;
      }
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["bots"] }),
        queryClient.invalidateQueries({ queryKey: ["bot", botId] }),
      ]);
    },
    [queryClient, t],
  );

  const handleCancel = useCallback(async () => {
    if (!session?.sessionKey || !selectedBot) return false;
    intentRequestRef.current = null;
    setPendingRunMessageChoice(null);
    setRunMessageSending(false);
    try {
      const { data } = await postApiV1ChatCancel({
        body: {
          botId: selectedBot.id,
          sessionKey: session.sessionKey,
          // The stop button means "halt the bot" — including a phone task the
          // run dispatched, which would otherwise keep executing on-device.
          stopDeviceTasks: true,
        },
      });
      if (data) {
        steerRunHandoffRef.current = null;
        steerRequestRef.current = null;
        setRunMessageSending(false);
        activeRunIdRef.current = null;
        deskpetReplyPendingRef.current = false;
        setWaitingForReply(false);
        sentAtRef.current = 0;
        latestAssistantReplyTextRef.current = "";
        latestStreamingReplyTextRef.current = "";
        queryClient.invalidateQueries({ queryKey: ["chat-run-status", id] });
        if ((data.deviceTasksCancelled ?? 0) > 0) {
          toast.success(
            t("sessions.deviceTasksStopped", {
              count: data.deviceTasksCancelled,
            }),
          );
        }
        deskpetReplyStartedAtRef.current = 0;
        return true;
      }
    } catch {
      // Silently ignore — the reply may have already finished
    }
    return false;
  }, [session?.sessionKey, selectedBot, queryClient, id, t]);

  const dispatchRunMessage = useCallback(
    async (message: string, intent: "side-question" | "steer") => {
      setPendingRunMessageChoice(null);
      if (intent === "side-question") {
        if (sideQuestion?.status === "pending") {
          toast.info(t("sessions.chat.sideQuestionPending"));
          return;
        }
        await handleSideQuestion(message);
        return;
      }
      await handleSteer(message);
    },
    [handleSideQuestion, handleSteer, sideQuestion?.status, t],
  );

  const handleRunMessage = useCallback(
    async (input: string, mode: RunMessageMode) => {
      const explicit = classifyExplicitRunMessage(input);
      if (mode === "auto" && explicit?.intent === "abort") {
        if (await handleCancel()) {
          toast.success(t("sessions.chat.runStopped"));
        }
        return;
      }

      const message =
        mode === "auto" ? (explicit?.message ?? input.trim()) : input.trim();
      if (!message) {
        toast.info(t("sessions.chat.runMessageEmpty"));
        return;
      }

      if (mode !== "auto") {
        await dispatchRunMessage(message, mode);
        return;
      }

      if (explicit && explicit.intent !== "abort") {
        await dispatchRunMessage(message, explicit.intent);
        return;
      }

      if (!selectedBot) return;
      const requestToken = Symbol("run-message-intent");
      intentRequestRef.current = requestToken;
      setRunMessageSending(true);
      try {
        const result = await postApiV1ChatIntent({
          body: { botId: selectedBot.id, message },
        });
        if (intentRequestRef.current !== requestToken) return;
        const classification = result.data;
        if (!classification || result.error) {
          await dispatchRunMessage(message, "side-question");
          return;
        }
        if (
          classification.source === "model" &&
          classification.confidence < RUN_MESSAGE_CONFIDENCE_THRESHOLD
        ) {
          setPendingRunMessageChoice(message);
          return;
        }
        await dispatchRunMessage(message, classification.intent);
      } catch {
        if (intentRequestRef.current !== requestToken) return;
        await dispatchRunMessage(message, "side-question");
      } finally {
        if (intentRequestRef.current === requestToken) {
          intentRequestRef.current = null;
          setRunMessageSending(false);
        }
      }
    },
    [dispatchRunMessage, handleCancel, selectedBot, t],
  );

  // Poll the session's active-run state so runs this composer did NOT start
  // (A2UI actions, automations, device tasks) still surface as a stop button
  // instead of a dead send button that bounces off the 409 busy guard.
  const { data: runStatus } = useQuery({
    queryKey: ["chat-run-status", id],
    queryFn: async () => {
      if (!selectedBot || !session?.sessionKey) return { busy: false };
      const { data } = await getApiV1ChatRunStatus({
        query: { botId: selectedBot.id, sessionKey: session.sessionKey },
      });
      return data ?? { busy: false };
    },
    enabled: Boolean(selectedBot && session?.sessionKey),
    refetchInterval: 3000,
  });
  const sessionBusy = runStatus?.busy === true;
  const replyInProgress =
    waitingForReply || sessionBusy || streamingText.trim().length > 0;
  const [messageHistoryAction, setMessageHistoryAction] = useState<{
    messageId: string;
    type: "branch" | "rollback";
  } | null>(null);

  const handleBranchFromMessage = useCallback(
    async (messageId: string) => {
      if (!id || replyInProgress || messageHistoryAction) return;

      setMessageHistoryAction({ messageId, type: "branch" });
      try {
        const { data, error } =
          await postApiV1SessionsByIdMessagesByMessageIdBranch({
            path: { id, messageId },
          });
        if (error || !data?.id) {
          throw new Error(
            (error as { message?: string } | undefined)?.message ??
              t("sessions.chat.branchFailed", {
                defaultValue: "Unable to create message branch",
              }),
          );
        }

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["chat-history", id] }),
          queryClient.invalidateQueries({ queryKey: ["session-meta", id] }),
          queryClient.invalidateQueries({
            queryKey: ["chat-history", data.id],
          }),
          queryClient.invalidateQueries({
            queryKey: ["session-meta", data.id],
          }),
          queryClient.invalidateQueries({ queryKey: ["sidebar-sessions"] }),
          queryClient.invalidateQueries({ queryKey: ["sessions-recent"] }),
        ]);
        toast.success(
          t("sessions.chat.branchCreated", {
            defaultValue: "Message branch created",
          }),
        );
        navigate(`/workspace/sessions/${data.id}`);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("sessions.chat.branchFailed", {
                defaultValue: "Unable to create message branch",
              }),
        );
      } finally {
        setMessageHistoryAction(null);
      }
    },
    [id, messageHistoryAction, navigate, queryClient, replyInProgress, t],
  );

  const handleRollbackToMessage = useCallback(
    async (messageId: string) => {
      if (!id || replyInProgress || messageHistoryAction) return;
      if (
        !window.confirm(
          t("sessions.chat.rollbackConfirm", {
            defaultValue:
              "Roll back this conversation to the selected message? Later messages remain in history and can be reached from another branch.",
          }),
        )
      ) {
        return;
      }

      setMessageHistoryAction({ messageId, type: "rollback" });
      try {
        const { error } =
          await postApiV1SessionsByIdMessagesByMessageIdRollback({
            path: { id, messageId },
          });
        if (error) {
          throw new Error(
            (error as { message?: string }).message ??
              t("sessions.chat.rollbackFailed", {
                defaultValue: "Unable to roll back conversation",
              }),
          );
        }

        await Promise.all([
          queryClient.invalidateQueries({ queryKey: ["chat-history", id] }),
          queryClient.invalidateQueries({ queryKey: ["session-meta", id] }),
          queryClient.invalidateQueries({ queryKey: ["chat-run-status", id] }),
          queryClient.invalidateQueries({ queryKey: ["sidebar-sessions"] }),
          queryClient.invalidateQueries({ queryKey: ["sessions-recent"] }),
        ]);
        toast.success(
          t("sessions.chat.rollbackComplete", {
            defaultValue: "Conversation rolled back",
          }),
        );
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("sessions.chat.rollbackFailed", {
                defaultValue: "Unable to roll back conversation",
              }),
        );
      } finally {
        setMessageHistoryAction(null);
      }
    },
    [id, messageHistoryAction, queryClient, replyInProgress, t],
  );

  useEffect(() => {
    if (!replyInProgress) setPendingRunMessageChoice(null);
  }, [replyInProgress]);

  useEffect(() => {
    if (runStatus?.busy !== false || waitingForReply) return;
    setStreamingText("");
    latestStreamingReplyTextRef.current = "";
  }, [runStatus?.busy, waitingForReply]);

  useEffect(() => {
    return onDesktopHostCommand((command) => {
      if (command.type !== "deskpet:pause-current-reply") {
        return;
      }

      const commandSessionId =
        typeof command.sessionId === "string" ? command.sessionId : null;
      const commandSessionKey =
        typeof command.sessionKey === "string" ? command.sessionKey : null;

      if (commandSessionId) {
        if (commandSessionId !== id) {
          return;
        }
      } else if (commandSessionKey !== session?.sessionKey) {
        return;
      }

      void handleCancel();
    });
  }, [handleCancel, id, session?.sessionKey]);

  // null = not yet loaded, [] = loaded but empty, [...] = loaded with messages
  const messages = (
    chatData ? ((chatData as Record<string, unknown>)?.messages ?? []) : null
  ) as ChatMessageData[] | null;
  // Keep existing data during refetch so optimistic messages and Thinking remain visible
  const safeMessages = chatLoading && !chatData ? [] : (messages ?? []);

  // Build a set of server user message texts to deduplicate against optimistic messages
  const serverUserTexts = new Set<string>();
  // Arrival times of media-only (no caption) server user messages — used to
  // clear media-only optimistic messages, whose empty text would otherwise
  // match any historical captionless upload.
  const serverMediaOnlyTimes: number[] = [];
  for (const m of safeMessages) {
    if (m.role !== "user") continue;
    const extracted = extractMessage(m as unknown as Record<string, unknown>);
    if (extracted.text.trim().length > 0) {
      serverUserTexts.add(extracted.text);
    } else if (extracted.images.length > 0 || extracted.fileCards.length > 0) {
      const arrivedAt =
        m.timestamp ?? (m.createdAt ? new Date(m.createdAt).getTime() : 0);
      serverMediaOnlyTimes.push(arrivedAt);
    }
  }

  // Clear optimistic messages that already appear in server data
  useEffect(() => {
    if (pendingMessages.length === 0) return;
    const remaining = pendingMessages.filter(
      (pm) =>
        !isPendingMessageOnServer(pm, serverUserTexts, serverMediaOnlyTimes),
    );
    if (remaining.length < pendingMessages.length) {
      setPendingMessages(remaining);
    }
  }, [serverUserTexts, pendingMessages]);

  // NOTE: waiting state is intentionally NOT cleared when an assistant
  // message appears in polled history — OpenClaw runs can emit several
  // intermediate visible replies while the run is still working.  The
  // composer re-enables only on the run-level SSE final/aborted/error
  // (or the safety timeout below).

  // If the initial send was acknowledged but no terminal event arrived, clear
  // the local waiting state only after the controller also reports no active
  // run. A genuinely long run must never be presented as a timeout here.
  const waitingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (waitingForReply && !sessionBusy) {
      waitingTimerRef.current = setTimeout(() => {
        deskpetReplyPendingRef.current = false;
        setWaitingForReply(false);
        sentAtRef.current = 0;
        deskpetReplyStartedAtRef.current = 0;
        latestAssistantReplyTextRef.current = "";
        latestStreamingReplyTextRef.current = "";
        setPendingMessages([]);
        invokeDesktopHost("desktop:deskpet-activity", {
          mood: "error",
          durationMs: DESKPET_ERROR_DURATION_MS,
        });
      }, 120_000);
    }
    return () => {
      if (waitingTimerRef.current) {
        clearTimeout(waitingTimerRef.current);
        waitingTimerRef.current = null;
      }
    };
  }, [waitingForReply, sessionBusy]);

  // Optimistic messages: use text-based key so React reuses the DOM node
  // when the server message replaces the optimistic one
  const optimisticMessages: ChatMessageData[] = pendingMessages
    .filter(
      (pm) =>
        !isPendingMessageOnServer(pm, serverUserTexts, serverMediaOnlyTimes),
    )
    .map((pm) => ({
      // stable key based on text content + attachment count
      id: `user-${pm.text.slice(0, 40)}-${pm.attachments.length}`,
      role: "user" as const,
      content:
        pm.attachments.length === 0
          ? pm.text
          : [
              ...(pm.text.trim().length > 0
                ? [{ type: "text", text: pm.text }]
                : []),
              ...pm.attachments.map((a) =>
                a.type === "image"
                  ? { type: "image", data: a.content, mimeType: a.mimeType }
                  : {
                      type: "file",
                      metadata: {
                        filename: a.filename ?? "file",
                        mimeType: a.mimeType,
                        size: a.size,
                      },
                    },
              ),
            ],
      timestamp: pm.timestamp,
      createdAt: new Date(pm.timestamp).toISOString(),
    }));

  const displayMessages = [...safeMessages, ...optimisticMessages];
  const latestAssistantReplyText = getLatestAssistantReplyTextFromMessages(
    displayMessages,
    {
      afterTimestamp: deskpetReplyStartedAtRef.current,
    },
  );

  useEffect(() => {
    if (latestAssistantReplyText) {
      latestAssistantReplyTextRef.current = latestAssistantReplyText;
    }
  }, [latestAssistantReplyText]);

  useEffect(() => {
    if (!waitingForReply) {
      logDeskpetHostDebug("waitingForReply false");
      return;
    }

    logDeskpetHostDebug("waitingForReply true; send lobster-replying");
    invokeDesktopHost("desktop:deskpet-activity", {
      mood: "lobster-replying",
      durationMs: DESKPET_REPLYING_DURATION_MS,
    });

    const timer = window.setInterval(() => {
      logDeskpetHostDebug(
        "waitingForReply heartbeat; refresh lobster-replying",
      );
      invokeDesktopHost("desktop:deskpet-activity", {
        mood: "lobster-replying",
        durationMs: DESKPET_REPLYING_DURATION_MS,
      });
    }, DESKPET_REPLYING_REFRESH_MS);

    return () => {
      window.clearInterval(timer);
    };
  }, [waitingForReply]);
  // Enrich assistant messages with A2UI from matching render_a2ui toolResults.
  // render_a2ui results contain A2UI JSONL in ```a2ui code blocks, but
  // ChatBubble only renders A2UI for assistant (bot) messages.
  // Inject the A2UI into the assistant message that called render_a2ui.
  const a2uiFromToolResults = new Map<string, A2UIMessage[]>();
  // S8: canvas_op toolResults carry a fenced ```canvas-op``` batch — collect it
  // by toolCallId so it can render on the parent assistant message.
  const canvasOpFromToolResults = new Map<string, CanvasOpBatchView>();
  for (const m of displayMessages) {
    const rm = m as unknown as Record<string, unknown>;
    if (rm.role === "toolResult" && A2UI_TOOL_NAMES.has(String(rm.toolName))) {
      const te = extractMessage(rm);
      if (te.a2uiMessages?.length) {
        a2uiFromToolResults.set(String(rm.toolCallId ?? ""), te.a2uiMessages);
      }
    }
    if (
      rm.role === "toolResult" &&
      CANVAS_OP_TOOL_NAMES.has(String(rm.toolName))
    ) {
      const te = extractMessage(rm);
      if (te.canvasOpBatch) {
        canvasOpFromToolResults.set(
          String(rm.toolCallId ?? ""),
          te.canvasOpBatch,
        );
      }
    }
  }

  // Detect sidebar-bound surfaces (surfaceId starts with "sidebar:")
  const enrichedMessages = coalesceInlineA2UISurfaces(
    displayMessages
      .map((msg) => {
        const rm = msg as unknown as Record<string, unknown>;
        const extracted = extractMessage(rm);

        // Inject A2UI from matching render_a2ui toolResult
        if (rm.role === "assistant" && !extracted.hasA2UI) {
          const content = rm.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block?.type === "toolCall" &&
                A2UI_TOOL_NAMES.has(String(block?.name))
              ) {
                const a2uiFromResult = a2uiFromToolResults.get(
                  String(block.id ?? ""),
                );
                if (a2uiFromResult?.length) {
                  const createMsg = a2uiFromResult.find(
                    (m) => "createSurface" in m,
                  );
                  const sid = (
                    createMsg as
                      | { createSurface: { surfaceId: string } }
                      | undefined
                  )?.createSurface?.surfaceId;
                  if (sid && isSidebarBoundSurface(sid, a2uiFromResult)) {
                    // Sidebar-bound surface: render a jump button in the
                    // thread; opening happens on click (or automatically the
                    // first time the surface arrives — see effect below).
                    extracted.sidebarA2UI = {
                      surfaceId: sid,
                      messages: a2uiFromResult,
                    };
                  } else {
                    extracted.hasA2UI = true;
                    extracted.a2uiMessages = a2uiFromResult;
                  }
                  break;
                }
              }
            }
          }
        }

        // S8: inject the canvas-op batch from the matching canvas_op toolResult
        // onto the assistant message that called it (parallel to the a2ui path).
        if (rm.role === "assistant" && !extracted.canvasOpBatch) {
          const content = rm.content;
          if (Array.isArray(content)) {
            for (const block of content) {
              if (
                block?.type === "toolCall" &&
                CANVAS_OP_TOOL_NAMES.has(String(block?.name))
              ) {
                const batch = canvasOpFromToolResults.get(
                  String(block.id ?? ""),
                );
                if (batch) {
                  extracted.canvasOpBatch = batch;
                  break;
                }
              }
            }
          }
        }

        return { msg, extracted };
      })
      .filter(({ msg, extracted }) => {
        const rm = msg as unknown as Record<string, unknown>;
        // Hide A2UI toolResults — their payload shows on the parent assistant msg
        if (
          rm.role === "toolResult" &&
          A2UI_TOOL_NAMES.has(String(rm.toolName))
        ) {
          return false;
        }
        // Hide canvas_op toolResults — the confirm card shows on the parent msg.
        if (
          rm.role === "toolResult" &&
          CANVAS_OP_TOOL_NAMES.has(String(rm.toolName))
        ) {
          return false;
        }
        if (extracted.text.trim().length > 0) return true;
        if ((extracted.replyContextText?.trim().length ?? 0) > 0) return true;
        if (extracted.hasToolCall) return true;
        if (extracted.reasoning.length > 0) return true;
        if (extracted.sidebarA2UI) return true;
        if (extracted.a2uiAction) return true;
        if (extracted.canvasOpBatch) return true;
        if (extracted.canvasOpResult) return true;
        if (extracted.images.length > 0) return true;
        if (extracted.fileCards.length > 0) return true;
        return false;
      }),
  );
  const transcriptItems = buildTranscriptItems(enrichedMessages);

  // Auto-open the sidebar when a NEW sidebar surface arrives during a live
  // conversation.  Surfaces already present on initial load stay closed —
  // the jump button in the thread reopens them on demand.
  const sidebarPayloads = enrichedMessages
    .map(({ extracted }) => extracted.sidebarA2UI)
    .filter((p): p is SidebarA2UIPayload => p !== null);
  // Canvas workbench state: panelOpen drives the header entry button; nodes
  // feed the expired-a2ui self-heal below.
  const { panelOpen: canvasPanelOpen, nodes: canvasNodes } = useCanvas();
  useEffect(() => {
    if (browserPanel.isOpen || canvasPanelOpen) {
      setOperationsOpen(false);
    }
  }, [browserPanel.isOpen, canvasPanelOpen]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: navigating to a different session must close its local inspector state
  useEffect(() => {
    setOperationsOpen(false);
  }, [id]);

  // The pinned panel belongs to one conversation: point it at the session on
  // screen so switching away hides it and switching back restores its pins.
  useEffect(() => {
    setActivePinnedSession(id ?? null);
  }, [id]);

  const browserSelected =
    browserPanel.isOpen && browserPanel.sessionKey === session?.sessionKey;
  const canvasSelected =
    !browserPanel.isOpen && !pinnedPanelOpen && canvasPanelOpen;
  const browserHiddenWithContent =
    !browserSelected && latestPreviewArtifact !== null;
  const canvasHiddenWithContent = !canvasSelected && canvasNodes.length > 0;
  const handleOpenChatLink = useCallback(
    (url: string): void => {
      const sessionKey = session?.sessionKey;
      if (!sessionKey) {
        void openExternalUrl(url);
        return;
      }
      if (openUrlInBrowserPanel(sessionKey, url)) {
        setPanelOpen(false);
        return;
      }
      void openExternalUrl(url);
    },
    [session?.sessionKey],
  );

  const sidebarSurfaceKey = sidebarPayloads.map((p) => p.surfaceId).join("|");
  const seenSidebarSurfacesRef = useRef<Set<string> | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: sidebarSurfaceKey tracks payload identity
  useEffect(() => {
    if (!chatData) return;
    if (seenSidebarSurfacesRef.current === null) {
      seenSidebarSurfacesRef.current = new Set(
        sidebarPayloads.map((p) => p.surfaceId),
      );
      return;
    }
    const seen = seenSidebarSurfacesRef.current;
    for (const payload of sidebarPayloads) {
      if (seen.has(payload.surfaceId)) continue;
      seen.add(payload.surfaceId);
      closeBrowserPanel();
      openWith(payload.surfaceId, payload.messages, onA2UIAction, {
        size: sidebarSurfaceDefaultSize(payload.messages),
      });
    }
  }, [sidebarSurfaceKey, chatData]);

  // Self-heal expired a2ui nodes (W5 follow-up): node shells persist to IDB
  // but their payloads (messages + onAction closures) are runtime-only, so a
  // reload leaves "内容已过期" placeholders. Whenever the board's nodes and
  // the chat history are both available, re-attach payloads for any surface
  // the history still carries. refreshA2UIPayload never creates nodes and
  // never opens the panel; healing changes node identity, which re-runs this
  // effect once more and then finds nothing left to heal.
  // biome-ignore lint/correctness/useExhaustiveDependencies: heal is keyed on board nodes + payload identity
  useEffect(() => {
    if (sidebarPayloads.length === 0) return;
    for (const node of canvasNodes) {
      const sid = node.metadata.surfaceId;
      if (!sid || getA2UIPayload(sid)) continue;
      const payload = sidebarPayloads.find((p) => p.surfaceId === sid);
      if (payload) {
        refreshA2UIPayload(sid, payload.messages, onA2UIAction);
      }
    }
  }, [canvasNodes, sidebarSurfaceKey, chatData]);

  // Reset surface tracking when navigating to a different session
  // biome-ignore lint/correctness/useExhaustiveDependencies: id change resets tracking
  useEffect(() => {
    seenSidebarSurfacesRef.current = null;
  }, [id]);

  // Auto-scroll on new messages or state changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll when messages or waiting state changes
  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "instant" });
  }, [chatData, waitingForReply, pendingMessages.length]);

  // Whether the thread currently ends with an assistant message — a
  // provisional execution group then drops its avatar to read as a
  // continuation of the same reply run.
  const lastDisplayedIsAssistant =
    enrichedMessages.length > 0 &&
    enrichedMessages[enrichedMessages.length - 1]?.msg.role === "assistant";
  let latestUserTranscriptIndex = -1;
  for (let index = transcriptItems.length - 1; index >= 0; index -= 1) {
    const item = transcriptItems[index];
    const entry =
      item?.kind === "message"
        ? item.entry
        : item?.entries[item.entries.length - 1];
    if (entry?.msg.role === "user") {
      latestUserTranscriptIndex = index;
      break;
    }
  }
  let currentRunActivityIndex = -1;
  for (
    let index = transcriptItems.length - 1;
    index > latestUserTranscriptIndex;
    index -= 1
  ) {
    if (transcriptItems[index]?.kind === "activity") {
      currentRunActivityIndex = index;
      break;
    }
  }
  const renderedAssistantTextsSinceLatestUser = transcriptItems
    .slice(latestUserTranscriptIndex + 1)
    .flatMap((item) => (item.kind === "message" ? [item.entry] : item.entries))
    .filter((entry) => entry.msg.role === "assistant")
    .flatMap((entry) => [...entry.extracted.reasoning, entry.extracted.text])
    .map((text) => text.trim())
    .filter(Boolean);
  const visibleStreamingText = stripRenderedAssistantText(
    stripMediaMarkerLines(streamingText),
    renderedAssistantTextsSinceLatestUser,
  );

  const operationTools = enrichedMessages.flatMap(({ msg, extracted }) =>
    extracted.toolCalls.map((tool, index) => ({
      id: `${msg.id}:${tool.id ?? index}`,
      name: formatToolCallSummary(tool.name) ?? tool.name,
      summary: summarizeToolArguments(tool.arguments),
    })),
  );
  const operationFileCount = enrichedMessages.reduce(
    (count, entry) => count + entry.extracted.fileCards.length,
    0,
  );
  const operationImageCount = enrichedMessages.reduce(
    (count, entry) => count + entry.extracted.images.length,
    0,
  );
  let operationRetryMessage: string | null = null;
  for (let index = enrichedMessages.length - 1; index >= 0; index -= 1) {
    const entry = enrichedMessages[index];
    if (entry?.msg.role !== "user") continue;
    const text = entry.extracted.text.trim();
    if (!text) continue;
    operationRetryMessage = text;
    break;
  }

  if (!id) {
    return <EmptyState />;
  }

  const platform = (session?.channelType ?? "web") as Platform;
  const platformCfg = getPlatformConfig(platform);
  const messageCount = session?.messageCount ?? messages?.length ?? 0;
  const lastActive = session?.lastMessageAt ?? session?.updatedAt ?? null;
  const sessionMetadata =
    (session?.metadata as Record<string, unknown> | null | undefined) ?? null;
  const linkedChannel = channelsData?.channels?.find(
    (channel) => channel.id === session?.channelId,
  );
  const externalChatUrl =
    platform === "web"
      ? ""
      : getChannelChatUrl(
          platform,
          linkedChannel?.appId,
          linkedChannel?.botUserId,
          linkedChannel?.accountId,
          {
            preferExactSessionTarget: true,
            sessionMetadata,
          },
        );

  // Detect group session from title or metadata
  const isGroup =
    (session?.metadata as Record<string, unknown> | null)?.isGroup === true ||
    (session?.title ?? "").includes("(group)");

  const buttonClassName = cn(
    "inline-flex h-12 items-center justify-center gap-3 rounded-[18px] border bg-white px-5 text-[13px] font-medium text-text-primary shadow-[0_10px_24px_rgba(15,23,42,0.06)] transition-colors",
    "border-[rgba(15,23,42,0.1)] hover:bg-[rgba(248,250,252,0.9)]",
  );

  const handleUnavailableChatLink = (): void => {
    if (platform === "feishu") {
      toast.info(
        "This session is missing Feishu openChatId metadata, so the exact bot chat cannot be opened yet.",
      );
      return;
    }

    toast.info("This channel does not expose a direct chat link yet.");
  };

  return (
    <div
      className={cn(
        "relative flex h-full min-w-0 flex-col",
        operationsOpen && "sm:pr-[360px]",
      )}
    >
      {/* Chat Header */}
      <div
        className={cn(
          "shrink-0 border-b border-border py-2 md:pt-3",
          operationsOpen ? "px-2" : "px-6",
        )}
      >
        <div className="flex items-center justify-between gap-3">
          <div
            className={cn(
              "flex min-w-0 items-center gap-3 overflow-hidden",
              operationsOpen && "hidden xl:flex",
            )}
          >
            <SessionPlatformBadge
              platform={platform}
              className="h-[34px] w-[34px] shrink-0"
            />
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <h1 className="text-[15px] font-bold text-text-heading truncate">
                  {session?.title ?? id}
                </h1>
                {isGroup && (
                  <span className="inline-flex items-center rounded-full px-2 py-0.5 text-[11px] font-medium bg-[var(--color-info-subtle)] text-[var(--color-info)]">
                    Group
                  </span>
                )}
              </div>
              <div className="text-[11px] text-text-muted mt-0.5">
                {platformCfg.label} ·{" "}
                {t("sessions.chat.messages", { count: messageCount })}
                {lastActive && (
                  <>
                    {" "}
                    ·{" "}
                    {t("sessions.chat.lastActive", {
                      time: formatRelativeTime(lastActive),
                    })}
                  </>
                )}
              </div>
            </div>
          </div>
          <div
            data-session-workbench-toggles="true"
            className="flex shrink-0 items-center gap-1"
          >
            <button
              type="button"
              data-session-browser-toggle="true"
              aria-pressed={browserSelected}
              aria-label={t("sessions.chat.browser")}
              title={t("sessions.chat.browser")}
              disabled={!session?.sessionKey}
              onClick={() => {
                if (browserSelected) {
                  closeBrowserPanel();
                  return;
                }
                setOperationsOpen(false);
                setPanelOpen(false);
                openBrowserPanel(session?.sessionKey ?? "");
              }}
              className={cn(
                "relative rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-40",
                browserSelected &&
                  "bg-surface-2 text-text-primary shadow-sm ring-1 ring-border",
              )}
            >
              <Globe size={18} />
              {browserHiddenWithContent && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-emerald-500 ring-2 ring-surface-1"
                />
              )}
            </button>
            <button
              type="button"
              data-session-canvas-toggle="true"
              aria-pressed={canvasSelected}
              aria-label={t("sessions.chat.canvas")}
              title={t("sessions.chat.canvas")}
              onClick={() => {
                // The right sidebar shows exactly one of browser / pinned /
                // canvas, so opening the canvas has to step past both others.
                const shouldOpen =
                  browserPanel.isOpen || pinnedPanelOpen || !canvasPanelOpen;
                setOperationsOpen(false);
                closeBrowserPanel();
                closePinnedPanel();
                setPanelOpen(shouldOpen);
              }}
              className={cn(
                "relative rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary",
                canvasSelected &&
                  "bg-surface-2 text-text-primary shadow-sm ring-1 ring-border",
              )}
            >
              <Shapes size={18} />
              {canvasHiddenWithContent && (
                <span
                  aria-hidden="true"
                  className="absolute right-1 top-1 size-1.5 rounded-full bg-emerald-500 ring-2 ring-surface-1"
                />
              )}
            </button>
            <button
              type="button"
              data-session-operations-toggle="true"
              aria-pressed={operationsOpen}
              aria-label={t("sessions.operations.title")}
              title={t("sessions.operations.title")}
              onClick={() => {
                if (operationsOpen) {
                  setOperationsOpen(false);
                  return;
                }
                if (browserPanel.openedByAgent) {
                  toast.info(t("sessions.operations.browserBusy"));
                  return;
                }
                closeBrowserPanelForRouting();
                setPanelOpen(false);
                setOperationsOpen(true);
              }}
              className={cn(
                "rounded-lg p-2 text-text-secondary transition-colors hover:bg-surface-2 hover:text-text-primary",
                operationsOpen &&
                  "bg-surface-2 text-text-primary shadow-sm ring-1 ring-border",
              )}
            >
              <Gauge size={18} />
            </button>
            {!operationsOpen &&
              !!session?.channelId &&
              platform !== "wechat" &&
              (externalChatUrl ? (
                <a
                  href={externalChatUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={() => {
                    const channel = normalizeChannel(platform);
                    if (!channel) {
                      return;
                    }
                    track("workspace_chat_in_im_click", {
                      channel,
                      where: "conversation",
                    });
                  }}
                  className={buttonClassName}
                >
                  <PlatformIcon platform={platform} size={18} />
                  <span>{t(platformCfg.openLabel)}</span>
                  <ArrowUpRight className="size-[16px] text-text-muted" />
                </a>
              ) : (
                <button
                  type="button"
                  onClick={handleUnavailableChatLink}
                  className={buttonClassName}
                >
                  <PlatformIcon platform={platform} size={18} />
                  <span>{t(platformCfg.openLabel)}</span>
                  <ArrowUpRight className="size-[16px] text-text-muted" />
                </button>
              ))}
          </div>
        </div>
      </div>

      {/* Message List */}
      <div className="flex-1 overflow-y-auto min-h-0 flex flex-col">
        {chatError ? (
          <ChatUnavailable />
        ) : chatLoading ? null : displayMessages.length === 0 ? (
          <ChatEmpty />
        ) : (
          <div data-chat-thread={id} className="px-4 pt-12 pb-8 sm:px-6">
            <div
              data-chat-layout="centered"
              className="mx-auto flex max-w-[800px] flex-col gap-5"
            >
              {transcriptItems.flatMap((item, idx, arr) => {
                const firstEntry =
                  item.kind === "message" ? item.entry : item.entries[0];
                const lastEntry =
                  item.kind === "message"
                    ? item.entry
                    : item.entries[item.entries.length - 1];
                if (!firstEntry || !lastEntry) {
                  return [];
                }

                const previousItem = idx > 0 ? arr[idx - 1] : undefined;
                const previousLastEntry =
                  previousItem?.kind === "message"
                    ? previousItem.entry
                    : previousItem?.entries[previousItem.entries.length - 1];
                const msgTime = firstEntry.msg.timestamp ?? 0;
                const prevTime = previousLastEntry?.msg.timestamp ?? 0;
                const divider =
                  newSessionDividerTime &&
                  msgTime >= newSessionDividerTime &&
                  prevTime < newSessionDividerTime
                    ? [
                        <div
                          key="session-divider"
                          className="flex items-center gap-3 my-4"
                        >
                          <div className="flex-1 h-px bg-border" />
                          <span className="text-[11px] text-text-muted shrink-0">
                            {t("sessions.chat.newSession", {
                              defaultValue: "New conversation",
                            })}
                          </span>
                          <div className="flex-1 h-px bg-border" />
                        </div>,
                      ]
                    : [];
                const role = firstEntry.msg.role;
                const previousRole = previousLastEntry?.msg.role;
                const showAvatar =
                  role !== "assistant" ||
                  divider.length > 0 ||
                  idx === 0 ||
                  previousRole !== "assistant";
                const openSidebar = (payload: SidebarA2UIPayload): void => {
                  closeBrowserPanel();
                  openWith(payload.surfaceId, payload.messages, onA2UIAction, {
                    size: sidebarSurfaceDefaultSize(payload.messages),
                  });
                };
                // Pin an inline surface into the dedicated sidebar panel —
                // NOT the canvas, where reaching the card means panning and
                // zooming to find its node. pinSurface is idempotent per
                // surfaceId so the remembered-pin effect can re-enter safely.
                const pinInlineA2UI = (messages: A2UIMessage[]): void => {
                  const [surfaceId] = surfaceIds(messages);
                  if (!surfaceId) return;
                  closeBrowserPanel();
                  setPanelOpen(false);
                  if (!id) return;
                  pinSurface(id, {
                    surfaceId,
                    title: humanizeSurfaceId(surfaceId),
                    messages,
                    onAction: onA2UIAction,
                    pinKey: surfacePinKey(messages),
                  });
                };

                if (item.kind === "message") {
                  return [
                    ...divider,
                    <ChatBubble
                      key={item.entry.msg.id}
                      msg={item.entry.msg}
                      extracted={item.entry.extracted}
                      showAvatar={showAvatar}
                      onA2UIAction={onA2UIAction}
                      onCanvasOpApplied={onCanvasOpApplied}
                      onOpenSidebar={openSidebar}
                      onPinA2UI={pinInlineA2UI}
                      onOpenLink={handleOpenChatLink}
                      onBranch={handleBranchFromMessage}
                      onRollback={handleRollbackToMessage}
                      messageAction={
                        messageHistoryAction?.messageId === item.entry.msg.id
                          ? messageHistoryAction.type
                          : null
                      }
                      actionsDisabled={
                        replyInProgress || messageHistoryAction !== null
                      }
                    />,
                  ];
                }

                const activityActive =
                  replyInProgress && idx === currentRunActivityIndex;
                const artifactBubbles = item.entries
                  .filter((entry) =>
                    hasPersistentAssistantOutput(entry.extracted),
                  )
                  .map((entry) => (
                    <ChatBubble
                      key={`${entry.msg.id}:artifacts`}
                      msg={entry.msg}
                      extracted={entry.extracted}
                      showAvatar={false}
                      presentation="artifacts-only"
                      onA2UIAction={onA2UIAction}
                      onCanvasOpApplied={onCanvasOpApplied}
                      onOpenSidebar={openSidebar}
                      onPinA2UI={pinInlineA2UI}
                      onOpenLink={handleOpenChatLink}
                    />
                  ));

                return [
                  ...divider,
                  <ExecutionActivityGroup
                    key={item.id}
                    id={item.id}
                    entries={item.entries}
                    active={activityActive}
                    showAvatar={showAvatar}
                    liveText={activityActive ? visibleStreamingText : ""}
                    onOpenLink={handleOpenChatLink}
                  />,
                  ...artifactBubbles,
                ];
              })}
              {replyInProgress && currentRunActivityIndex < 0 && (
                <ExecutionActivityGroup
                  id={`activity:streaming:${id}`}
                  entries={[]}
                  active
                  showAvatar={!lastDisplayedIsAssistant}
                  liveText={visibleStreamingText}
                  onOpenLink={handleOpenChatLink}
                />
              )}
              <div ref={endRef} />
            </div>
          </div>
        )}
      </div>

      {/* Chat Input */}
      <div className="shrink-0 px-4 py-3">
        <div className="mx-auto w-full max-w-[800px]">
          {sideQuestion && (
            <SideQuestionPanel
              value={sideQuestion}
              onDismiss={() => setSideQuestion(null)}
            />
          )}
          {pendingRunMessageChoice && replyInProgress && (
            <RunMessageChoicePanel
              message={pendingRunMessageChoice}
              onChoose={(intent) => {
                void dispatchRunMessage(pendingRunMessageChoice, intent);
              }}
              onDismiss={() => setPendingRunMessageChoice(null)}
            />
          )}
          <ChatInputArea
            bots={bots}
            selectedBot={selectedBot}
            onSelectBot={() => {}}
            onSelectModel={(botId, modelId) => {
              void updateBotModel(botId, modelId);
            }}
            onSend={handleSend}
            onTyping={handleDeskpetTyping}
            onCancel={handleCancel}
            onRunMessage={(text, mode) => {
              void handleRunMessage(text, mode);
            }}
            runMessageSending={runMessageSending}
            sending={false}
            waitingReply={waitingForReply || sessionBusy}
            disabled={!session?.botId}
            placeholder={t("localChat.inputPlaceholder")}
            showBotSelector={false}
            focusToken={deskpetReplyFocusToken}
            externalInputSessionKey={session?.sessionKey ?? null}
          />
        </div>
      </div>
      {operationsOpen && (
        <SessionOperationsPanel
          snapshot={{
            busy: replyInProgress,
            messageCount,
            modelId: session?.model
              ? session.model.includes("/") || !session.modelProvider
                ? session.model
                : `${session.modelProvider}/${session.model}`
              : (selectedBot?.modelId ?? null),
            contextUsedTokens: session?.totalTokens ?? null,
            contextWindowTokens: session?.contextTokens ?? null,
            contextFresh: session?.totalTokensFresh ?? null,
            sessionKey: session?.sessionKey ?? null,
            agentId: session?.botId ?? null,
            startedAt:
              replyInProgress && sentAtRef.current > 0
                ? sentAtRef.current
                : null,
            tools: operationTools,
            fileCount: operationFileCount,
            imageCount: operationImageCount,
            previewCount: previewArtifacts.length,
            canvasCount: canvasNodes.length,
            browserAvailable: Boolean(session?.sessionKey),
            browserOpen: browserSelected,
            browserOwnedByAgent:
              browserPanel.openedByAgent &&
              browserPanel.sessionKey === session?.sessionKey,
          }}
          onClose={() => setOperationsOpen(false)}
          onStop={() => {
            void handleCancel();
          }}
          onRetry={
            operationRetryMessage
              ? () => {
                  void handleSend(operationRetryMessage, [], null);
                }
              : undefined
          }
          onOpenBrowser={() => {
            setOperationsOpen(false);
            setPanelOpen(false);
            openBrowserPanel(session?.sessionKey ?? "");
          }}
          onOpenCanvas={() => {
            setOperationsOpen(false);
            closeBrowserPanel();
            setPanelOpen(true);
          }}
        />
      )}
    </div>
  );
}
