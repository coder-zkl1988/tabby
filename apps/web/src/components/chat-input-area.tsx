import { ChatInput, ChatInputAttachButton } from "@/components/chat-input";
import { TalkVoiceButton } from "@/components/talk-voice-button";
import { useCommunitySkillStatus } from "@/hooks/use-community-catalog";
import { useTeams } from "@/hooks/use-teams";
import { subscribeExternalChatInput } from "@/lib/chat/external-chat-input";
import { requestDesktopHost } from "@/lib/desktop-host";
import { isImeComposing } from "@/lib/keyboard";
import { getProviderLabel } from "@/lib/provider-labels";
import { getSpecialModelLabelKey } from "@/lib/special-models";
import { cn } from "@/lib/utils";
import {
  CHAT_ATTACHMENT_LIMITS,
  type DesktopAttachmentPickerKind,
  type DesktopStagedAttachment,
} from "@nexu/shared";
import { useQuery } from "@tanstack/react-query";
import {
  Check,
  ChevronDown,
  File as FileIcon,
  FileImage,
  FileSpreadsheet,
  FileText,
  FileUp,
  FolderOpen,
  Image as ImageIcon,
  MessageCircleQuestion,
  Plus,
  Presentation,
  Route,
  Sparkles,
  Star,
  Users,
  X,
  Zap,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { toast } from "sonner";
import {
  getApiInternalDesktopDefaultModel,
  getApiV1Models,
} from "../../lib/api/sdk.gen";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BotItem {
  id: string;
  name: string;
  slug: string;
  status: "active" | "paused" | "deleted";
  /** Null means this bot follows the global default model. */
  modelId: string | null;
}

export interface PendingAttachment {
  id: string;
  type: "image" | "file" | "directory";
  previewUrl: string;
  content: string;
  stagedPath?: string;
  mimeType: string;
  filename?: string;
  size?: number;
}

export interface ChatInputAreaProps {
  bots: BotItem[];
  selectedBot: BotItem | null;
  onSelectBot: (bot: BotItem) => void;
  /** Id of the desktop default bot — its row shows a 默认 badge. */
  defaultBotId?: string | null;
  /** When provided, non-default bot rows expose a 设为默认 action. */
  onSetDefaultBot?: (bot: BotItem) => void;
  onSend: (
    text: string,
    attachments: PendingAttachment[],
    skillSlug: string | null,
  ) => boolean | Promise<boolean>;
  onTyping?: (text: string) => void;
  onCancel?: () => void;
  onRunMessage?: (text: string, mode: RunMessageMode) => void;
  runMessageSending?: boolean;
  sending: boolean;
  waitingReply: boolean;
  disabled: boolean;
  placeholder: string;
  /** Show "add bot" button in bot dropdown (true for new conversation page) */
  showAddBot?: boolean;
  /** Show bot selector dropdown (default true, false for session page) */
  showBotSelector?: boolean;
  /** Show model selector dropdown (default true, false for session page) */
  showModelSelector?: boolean;
  /** Show model as read-only label instead of changeable dropdown */
  modelReadOnly?: boolean;
  /**
   * Binds a model to a bot, or clears the binding (null) back to following the
   * global default.
   *
   * Separate from onSelectBot: that one switches which bot you are talking to
   * and is local to the page, while this one persists a property of the bot.
   * Overloading onSelectBot with a modified copy made the model pick look like
   * a bot switch, so pages that only tracked selection dropped it silently.
   */
  onSelectModel?: (botId: string, modelId: string | null) => void;
  /** Change this value to focus the text input from an external action. */
  focusToken?: string | null;
  /** Current session key for browser selections and annotated screenshots. */
  externalInputSessionKey?: string | null;
  /** Conversation receiving realtime voice turns, including a new chat key. */
  voiceSessionKey?: string | null;
  onVoiceSessionEnded?: () => void | Promise<void>;
}

export type RunMessageMode = "auto" | "side-question" | "steer";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function extractBase64FromDataUrl(dataUrl: string): string {
  const idx = dataUrl.indexOf(",");
  return idx >= 0 ? dataUrl.slice(idx + 1) : dataUrl;
}

// ---------------------------------------------------------------------------
// File bubble (for non-image attachments)
// ---------------------------------------------------------------------------

function FileBubble({
  filename,
  mimeType,
  size,
}: {
  filename: string;
  mimeType: string;
  size?: number;
}) {
  const ext = filename.split(".").pop()?.toLowerCase() ?? "";
  const isPdf = ext === "pdf";
  const isExcel = ["xls", "xlsx"].includes(ext);
  const isDoc = ["doc", "docx"].includes(ext);
  const isPpt = ["ppt", "pptx"].includes(ext);
  const isMd = ext === "md";
  const isTxt = ext === "txt";
  const isImage = mimeType.startsWith("image/");
  const isAudio = mimeType.startsWith("audio/");
  const isDirectory = mimeType === "application/x-directory";

  let Icon = FileIcon;
  let color = "text-gray-400";

  if (isDirectory) {
    Icon = FolderOpen;
    color = "text-amber-500";
  } else if (isPdf) {
    Icon = FileText;
    color = "text-red-500";
  } else if (isExcel) {
    Icon = FileSpreadsheet;
    color = "text-green-500";
  } else if (isDoc) {
    Icon = FileText;
    color = "text-blue-500";
  } else if (isPpt) {
    Icon = Presentation;
    color = "text-orange-500";
  } else if (isMd || isTxt) {
    Icon = FileText;
    color = "text-gray-400";
  } else if (isImage) {
    Icon = FileImage;
    color = "text-purple-500";
  } else if (isAudio) {
    Icon = FileIcon;
    color = "text-pink-500";
  }

  return (
    <div className="flex items-center gap-1.5 h-18 px-2.5 rounded-xl border border-border bg-surface-1 max-w-[160px]">
      <Icon size={24} className={`shrink-0 ${color}`} />
      <div className="min-w-0">
        <div className="text-[12px] text-text-primary truncate font-medium">
          {filename}
        </div>
        {size !== undefined && (
          <div className="text-[10px] text-text-muted">{formatBytes(size)}</div>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Attachment tray
// ---------------------------------------------------------------------------

function AttachmentTray({
  attachments,
  onRemove,
}: {
  attachments: PendingAttachment[];
  onRemove: (id: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="relative overflow-x-auto no-scrollbar px-3 pt-2.5 pb-1">
      <div className="flex gap-2 w-max">
        {attachments.map((att) => (
          <div key={att.id} className="relative group shrink-0">
            {att.type === "image" && att.previewUrl ? (
              <img
                src={att.previewUrl}
                alt=""
                className="h-16 w-16 rounded-xl object-cover border border-border"
              />
            ) : (
              <FileBubble
                filename={att.filename ?? "file"}
                mimeType={att.mimeType}
                size={att.size}
              />
            )}
            <button
              type="button"
              onClick={() => onRemove(att.id)}
              title={t("localChat.removeAttachment")}
              aria-label={t("localChat.removeAttachment")}
              className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-text-primary text-white flex items-center justify-center opacity-0 group-hover:opacity-100 transition-opacity shadow"
            >
              <X size={10} />
            </button>
          </div>
        ))}
      </div>
      {attachments.length > 0 && (
        <div className="absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-l from-[var(--color-tabby-bg)] to-transparent pointer-events-none" />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Bot selector dropdown
// ---------------------------------------------------------------------------

/**
 * Picks the chat target. A team's lead bot is a real bot, so it would otherwise
 * sit in the same flat list as the individual experts — the two are split into
 * tabs instead, and picking a team selects its lead (the orchestrator that
 * delegates to the members). The list scrolls inside the dropdown so a long
 * roster never grows the popover past the viewport.
 */
function BotSelector({
  bots,
  selected,
  onSelect,
  showAdd,
  defaultBotId,
  onSetDefault,
}: {
  bots: BotItem[];
  selected: BotItem | null;
  onSelect: (bot: BotItem) => void;
  showAdd?: boolean;
  defaultBotId?: string | null;
  onSetDefault?: (bot: BotItem) => void;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"experts" | "teams">("experts");
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  const { data: teamsData } = useTeams();
  const teams = teamsData?.teams ?? [];

  const activeBots = bots.filter((b) => b.status === "active");
  const leadBotIds = new Set(teams.map((team) => team.leadBotId));
  const expertBots = activeBots.filter((b) => !leadBotIds.has(b.id));
  const botById = new Map(bots.map((b) => [b.id, b]));

  // When a lead bot is selected, label the trigger with its team ("默认专家团")
  // rather than the bot ("默认专家团 队长").
  const selectedTeam = selected
    ? teams.find((team) => team.leadBotId === selected.id)
    : undefined;
  const triggerLabel =
    selectedTeam?.name ?? selected?.name ?? t("localChat.selectBot");

  const rowClass = (isSelected: boolean) =>
    cn(
      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors hover:bg-surface-2",
      isSelected && "font-medium text-accent",
    );

  return (
    <div ref={ref} className="relative min-w-0">
      <button
        type="button"
        title={triggerLabel}
        aria-expanded={open}
        onClick={() => {
          const next = !open;
          // Reopen on the tab the current selection lives in.
          if (next) setTab(selectedTeam ? "teams" : "experts");
          setOpen(next);
        }}
        className={cn(
          "flex h-8 max-w-[140px] items-center gap-1 rounded-lg px-2 text-sm text-[var(--color-tabby-muted)] transition-colors hover:bg-[var(--color-tabby-canvas)] sm:max-w-[220px]",
          open && "bg-[var(--color-tabby-canvas)]",
        )}
      >
        <span className="min-w-0 truncate">{triggerLabel}</span>
        <ChevronDown
          size={13}
          className={cn("shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>

      {open && (
        <div className="absolute right-0 top-full z-50 mt-1.5 flex max-h-[176px] w-[min(240px,calc(100vw-2rem))] flex-col rounded-xl border border-border bg-surface-1 shadow-[0_8px_24px_rgba(15,23,42,0.12)]">
          <div className="flex shrink-0 border-b border-border">
            {(
              [
                {
                  key: "experts",
                  label: t("localChat.tabExperts", { defaultValue: "专家" }),
                },
                {
                  key: "teams",
                  label: t("localChat.tabTeams", { defaultValue: "团队" }),
                },
              ] as const
            ).map(({ key, label }) => (
              <button
                key={key}
                type="button"
                onClick={() => setTab(key)}
                className={cn(
                  "flex-1 px-3 py-1 text-[12px] transition-colors",
                  tab === key
                    ? "border-b-2 border-accent font-medium text-text-primary"
                    : "text-text-muted hover:text-text-secondary",
                )}
              >
                {label}
              </button>
            ))}
          </div>

          {/* Scrolls inside the popover — never grows the page. */}
          <div className="min-h-0 flex-1 overflow-y-auto py-0.5">
            {tab === "experts" ? (
              expertBots.length === 0 ? (
                <div className="px-3 py-1.5 text-[12px] text-text-muted">
                  {t("localChat.noBots")}
                </div>
              ) : (
                expertBots.map((bot) => (
                  <div key={bot.id} className="group flex items-center">
                    <button
                      type="button"
                      onClick={() => {
                        onSelect(bot);
                        setOpen(false);
                      }}
                      className={cn(
                        rowClass(selected?.id === bot.id),
                        "min-w-0 flex-1",
                      )}
                    >
                      <Sparkles
                        size={13}
                        className="shrink-0 text-text-muted"
                      />
                      <span className="truncate">{bot.name}</span>
                      {bot.id === defaultBotId && (
                        <span className="ml-1 shrink-0 rounded bg-surface-2 px-1 text-[10px] leading-4 text-text-muted">
                          {t("localChat.defaultBadge", {
                            defaultValue: "默认",
                          })}
                        </span>
                      )}
                    </button>
                    {onSetDefault && bot.id !== defaultBotId && (
                      <button
                        type="button"
                        title={t("localChat.setDefault", {
                          defaultValue: "设为默认",
                        })}
                        onClick={() => onSetDefault(bot)}
                        className="mr-2 hidden shrink-0 rounded p-1 text-text-muted transition-colors hover:text-accent group-hover:block"
                      >
                        <Star size={12} />
                      </button>
                    )}
                  </div>
                ))
              )
            ) : teams.length === 0 ? (
              <div className="px-3 py-1.5 text-[12px] text-text-muted">
                {t("localChat.noTeams", { defaultValue: "暂无团队" })}
              </div>
            ) : (
              teams.map((team) => {
                // Chatting with a team means chatting with its lead, which
                // orchestrates the members. Skip a team whose lead is gone.
                const lead = botById.get(team.leadBotId);
                if (!lead) return null;
                return (
                  <button
                    key={team.id}
                    type="button"
                    onClick={() => {
                      onSelect(lead);
                      setOpen(false);
                    }}
                    className={rowClass(selected?.id === lead.id)}
                  >
                    <Users size={13} className="shrink-0 text-text-muted" />
                    <span className="truncate">{team.name}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-text-muted">
                      {team.members.length}
                    </span>
                  </button>
                );
              })
            )}
          </div>

          {showAdd && (
            <div className="shrink-0 border-t border-border">
              <button
                type="button"
                onClick={() => {
                  setOpen(false);
                  navigate(
                    tab === "teams"
                      ? "/workspace/teams"
                      : "/workspace/experts/custom",
                  );
                }}
                className="flex w-full items-center gap-2 rounded-b-xl px-3 py-1.5 text-left text-[12px] text-text-secondary transition-colors hover:bg-surface-2"
              >
                <Plus size={13} className="shrink-0" />
                {tab === "teams"
                  ? t("localChat.addTeam", { defaultValue: "新建团队" })
                  : t("localChat.addBot", { defaultValue: "添加专家" })}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function ChatInputArea({
  bots,
  selectedBot,
  onSelectBot,
  defaultBotId = null,
  onSetDefaultBot,
  onSend,
  onTyping,
  onCancel,
  onRunMessage,
  runMessageSending = false,
  sending,
  waitingReply,
  disabled,
  placeholder,
  showAddBot,
  showBotSelector = true,
  showModelSelector = true,
  modelReadOnly = false,
  onSelectModel,
  focusToken = null,
  externalInputSessionKey = null,
  voiceSessionKey = null,
  onVoiceSessionEnded,
}: ChatInputAreaProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<
    PendingAttachment[]
  >([]);
  const [skillDropdownOpen, setSkillDropdownOpen] = useState(false);
  const [selectedSkillSlug, setSelectedSkillSlug] = useState<string | null>(
    null,
  );
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);
  const [runMessageMode, setRunMessageMode] = useState<RunMessageMode>("auto");
  const [attachmentMenuOpen, setAttachmentMenuOpen] = useState(false);
  const [submitPending, setSubmitPending] = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);
  const imageRef = useRef<HTMLInputElement>(null);
  const directoryRef = useRef<HTMLInputElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const attachmentMenuRef = useRef<HTMLDivElement>(null);
  const skillDropdownRef = useRef<HTMLDivElement>(null);
  const modelDropdownRef = useRef<HTMLDivElement>(null);

  const { data: skillsData } = useCommunitySkillStatus();
  const installedSkills = skillsData?.installedSkills ?? [];

  const { data: modelsData } = useQuery({
    queryKey: ["models"],
    queryFn: async () => {
      const { data } = await getApiV1Models();
      return data;
    },
    staleTime: 5 * 60 * 1000,
  });
  // A bot with no binding of its own runs on the global default, so that is
  // the model to name here — "Default" alone tells the user nothing about
  // what will actually answer.
  const { data: defaultModelData } = useQuery({
    queryKey: ["desktop-default-model"],
    queryFn: async () => {
      const { data } = await getApiInternalDesktopDefaultModel();
      return data as { modelId: string | null } | undefined;
    },
  });
  const models = (modelsData?.models ?? []) as Array<{
    id: string;
    name: string;
    provider: string;
  }>;

  const nameForModel = (modelId: string | null | undefined): string | null => {
    if (!modelId) return null;
    return models.find((m) => m.id === modelId)?.name ?? modelId;
  };
  // Null modelId is "follow the global default", so resolve it through to the
  // model that will actually answer rather than showing a bare placeholder.
  const followsDefault = !selectedBot?.modelId;
  const modelLabel =
    nameForModel(selectedBot?.modelId) ??
    nameForModel(defaultModelData?.modelId) ??
    "Default";

  const addAttachment = useCallback((att: Omit<PendingAttachment, "id">) => {
    setPendingAttachments((prev) => [
      ...prev,
      { ...att, id: crypto.randomUUID() },
    ]);
  }, []);

  useEffect(() => {
    if (!externalInputSessionKey) return;
    return subscribeExternalChatInput(externalInputSessionKey, (external) => {
      if (external.text?.trim()) {
        setInput((current) =>
          current.trim()
            ? `${current.trimEnd()}\n\n${external.text?.trim()}`
            : (external.text?.trim() ?? ""),
        );
      }
      if (external.attachment) addAttachment(external.attachment);
      window.requestAnimationFrame(() => inputRef.current?.focus());
    });
  }, [addAttachment, externalInputSessionKey]);

  const removeAttachment = useCallback((id: string) => {
    setPendingAttachments((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const readFileBlob = useCallback(
    (file: File, displayName = file.name) => {
      const isImage = file.type.startsWith("image/");
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = reader.result as string;
        addAttachment({
          type: isImage ? "image" : "file",
          previewUrl: dataUrl,
          content: extractBase64FromDataUrl(dataUrl),
          mimeType: file.type || "application/octet-stream",
          filename: displayName,
          size: file.size,
        });
      };
      reader.readAsDataURL(file);
    },
    [addAttachment],
  );

  const addFiles = useCallback(
    (files: File[]) => {
      let nextCount = pendingAttachments.length;
      let nextOverallTotal = pendingAttachments.reduce(
        (total, attachment) => total + (attachment.size ?? 0),
        0,
      );
      let nextInlineTotal = pendingAttachments.reduce(
        (total, attachment) =>
          attachment.stagedPath ? total : total + (attachment.size ?? 0),
        0,
      );

      for (const file of files) {
        const relativePath = (
          file as File & { webkitRelativePath?: string }
        ).webkitRelativePath?.trim();
        const displayName = relativePath || file.name;
        if (nextCount >= CHAT_ATTACHMENT_LIMITS.maxCount) {
          toast.error(
            t("localChat.attachmentCountLimit", {
              count: CHAT_ATTACHMENT_LIMITS.maxCount,
            }),
          );
          break;
        }
        if (file.size > CHAT_ATTACHMENT_LIMITS.maxInlineFileBytes) {
          toast.error(
            t("localChat.attachmentTooLarge", {
              name: displayName,
              size: formatBytes(CHAT_ATTACHMENT_LIMITS.maxInlineFileBytes),
            }),
          );
          continue;
        }
        if (
          nextOverallTotal + file.size >
          CHAT_ATTACHMENT_LIMITS.maxTotalBytes
        ) {
          toast.error(
            t("localChat.attachmentTotalLimit", {
              size: formatBytes(CHAT_ATTACHMENT_LIMITS.maxTotalBytes),
            }),
          );
          break;
        }
        if (
          nextInlineTotal + file.size >
          CHAT_ATTACHMENT_LIMITS.maxInlineTotalBytes
        ) {
          toast.error(
            t("localChat.attachmentTotalLimit", {
              size: formatBytes(CHAT_ATTACHMENT_LIMITS.maxInlineTotalBytes),
            }),
          );
          break;
        }
        nextCount += 1;
        nextOverallTotal += file.size;
        nextInlineTotal += file.size;
        readFileBlob(file, displayName);
      }
    },
    [pendingAttachments, readFileBlob, t],
  );

  const addStagedAttachments = useCallback(
    (attachments: DesktopStagedAttachment[]) => {
      const currentSize = pendingAttachments.reduce(
        (total, attachment) => total + (attachment.size ?? 0),
        0,
      );
      const availableCount =
        CHAT_ATTACHMENT_LIMITS.maxCount - pendingAttachments.length;
      if (attachments.length > availableCount) {
        toast.error(
          t("localChat.attachmentCountLimit", {
            count: CHAT_ATTACHMENT_LIMITS.maxCount,
          }),
        );
        return;
      }
      const incomingSize = attachments.reduce(
        (total, attachment) => total + attachment.size,
        0,
      );
      if (currentSize + incomingSize > CHAT_ATTACHMENT_LIMITS.maxTotalBytes) {
        toast.error(
          t("localChat.attachmentTotalLimit", {
            size: formatBytes(CHAT_ATTACHMENT_LIMITS.maxTotalBytes),
          }),
        );
        return;
      }
      setPendingAttachments((current) => [
        ...current,
        ...attachments.map((attachment) => ({
          id: crypto.randomUUID(),
          type: attachment.type,
          previewUrl: "",
          content: "",
          stagedPath: attachment.stagedPath,
          mimeType: attachment.mimeType,
          filename: attachment.filename,
          size: attachment.size,
        })),
      ]);
    },
    [pendingAttachments, t],
  );

  const pickAttachments = useCallback(
    async (kind: DesktopAttachmentPickerKind, fallback: () => void) => {
      try {
        const result = await requestDesktopHost<{
          attachments: DesktopStagedAttachment[];
        }>("desktop:pick-attachments", { kind });
        if (!result) {
          fallback();
          return;
        }
        addStagedAttachments(result.attachments);
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : t("localChat.attachmentStageFailed"),
        );
      }
    },
    [addStagedAttachments, t],
  );

  const handleFiles = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      if (files.length === 0) return;
      addFiles(files);
      e.target.value = "";
    },
    [addFiles],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!selectedBot || waitingReply) return;
      const imageItem = Array.from(e.clipboardData.items).find((i) =>
        i.type.startsWith("image/"),
      );
      if (!imageItem) return;
      e.preventDefault();
      const blob = imageItem.getAsFile();
      if (!blob) return;
      const pastedFile = new File(
        [blob],
        blob.name || `pasted-image-${Date.now()}.png`,
        { type: blob.type || "image/png" },
      );
      addFiles([pastedFile]);
    },
    [addFiles, selectedBot, waitingReply],
  );

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (
        attachmentMenuRef.current &&
        !attachmentMenuRef.current.contains(e.target as Node)
      ) {
        setAttachmentMenuOpen(false);
      }
      if (
        skillDropdownRef.current &&
        !skillDropdownRef.current.contains(e.target as Node)
      ) {
        setSkillDropdownOpen(false);
      }
      if (
        modelDropdownRef.current &&
        !modelDropdownRef.current.contains(e.target as Node)
      ) {
        setModelDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, []);

  useEffect(() => {
    const directoryInput = directoryRef.current;
    if (!directoryInput) return;
    directoryInput.setAttribute("webkitdirectory", "");
    directoryInput.setAttribute("directory", "");
  }, []);

  useEffect(() => {
    if (!focusToken) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      inputRef.current?.focus();
      const valueLength = inputRef.current?.value.length ?? 0;
      inputRef.current?.setSelectionRange(valueLength, valueLength);
    });

    return () => window.cancelAnimationFrame(frame);
  }, [focusToken]);

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    // Enter while an IME is composing commits the candidate — never sends.
    if (e.key === "Enter" && !e.shiftKey && !isImeComposing(e)) {
      e.preventDefault();
      void handleSend();
    }
  }

  const canSend =
    !!selectedBot &&
    !sending &&
    !submitPending &&
    !waitingReply &&
    (input.trim().length > 0 || pendingAttachments.length > 0);
  const runMessageActive = waitingReply && onRunMessage !== undefined;
  const canSendRunMessage =
    !!selectedBot &&
    runMessageActive &&
    !runMessageSending &&
    input.trim().length > 0;
  const showRunMessageSend = canSendRunMessage || runMessageSending;

  useEffect(() => {
    if (!runMessageActive) return;
    setAttachmentMenuOpen(false);
    setSkillDropdownOpen(false);
    setModelDropdownOpen(false);
  }, [runMessageActive]);

  async function handleSend() {
    if (runMessageActive) {
      if (!canSendRunMessage) return;
      const text = input.trim();
      setInput("");
      onRunMessage?.(text, runMessageMode);
      return;
    }
    if (!canSend) return;
    const draftInput = input;
    const text = draftInput.trim();
    const atts = [...pendingAttachments];
    const skillSlug = selectedSkillSlug;
    setSubmitPending(true);
    try {
      const accepted = await onSend(text, atts, skillSlug);
      if (accepted === false) return;

      const sentIds = new Set(atts.map((attachment) => attachment.id));
      setInput((current) => (current === draftInput ? "" : current));
      setPendingAttachments((current) =>
        current.filter((attachment) => !sentIds.has(attachment.id)),
      );
      // Skill selection is single-shot only after the server accepts the send.
      setSelectedSkillSlug((current) =>
        current === skillSlug ? null : current,
      );
    } catch {
      // The owning page reports the request error; keep the draft retryable.
    } finally {
      setSubmitPending(false);
    }
  }

  function handleInputChange(nextValue: string) {
    setInput(nextValue);
    onTyping?.(nextValue);
  }

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFiles}
      />
      <input
        ref={imageRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={handleFiles}
      />
      <input
        ref={directoryRef}
        type="file"
        multiple
        className="hidden"
        onChange={handleFiles}
      />
      {pendingAttachments.length > 0 && (
        <AttachmentTray
          attachments={pendingAttachments}
          onRemove={removeAttachment}
        />
      )}
      <ChatInput
        inputRef={inputRef}
        value={input}
        onChange={handleInputChange}
        onKeyDown={handleKeyDown}
        onPaste={runMessageActive ? undefined : handlePaste}
        onSend={() => void handleSend()}
        onCancel={onCancel}
        placeholder={
          runMessageActive
            ? t("sessions.chat.runMessagePlaceholder")
            : placeholder
        }
        disabled={disabled || submitPending}
        sending={sending || submitPending}
        actionLoading={runMessageSending}
        waitingReply={runMessageActive ? !showRunMessageSend : waitingReply}
        canSend={runMessageActive ? canSendRunMessage : canSend}
        subtlePlaceholder={runMessageActive}
        leftActions={
          runMessageActive ? (
            <fieldset className="flex h-8 items-center rounded-lg bg-[var(--color-tabby-canvas)] p-0.5">
              <legend className="sr-only">
                {t("sessions.chat.runModeLabel")}
              </legend>
              {(
                [
                  ["auto", Sparkles, t("sessions.chat.runModeAuto")],
                  [
                    "side-question",
                    MessageCircleQuestion,
                    t("sessions.chat.runModeSideQuestion"),
                  ],
                  ["steer", Route, t("sessions.chat.runModeSteer")],
                ] as const
              ).map(([mode, Icon, label]) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setRunMessageMode(mode)}
                  data-run-message-mode={mode}
                  aria-pressed={runMessageMode === mode}
                  title={label}
                  className={cn(
                    "flex h-7 items-center gap-1 rounded-md px-2 text-xs transition-colors",
                    runMessageMode === mode
                      ? "bg-[var(--color-tabby-bg)] text-[var(--color-tabby-foreground)] shadow-sm"
                      : "text-[var(--color-tabby-muted)] hover:text-[var(--color-tabby-foreground)]",
                  )}
                >
                  <Icon className="size-3.5 shrink-0" />
                  <span className="hidden sm:inline">{label}</span>
                </button>
              ))}
            </fieldset>
          ) : (
            <>
              <div className="relative" ref={attachmentMenuRef}>
                <ChatInputAttachButton
                  onClick={() => setAttachmentMenuOpen((open) => !open)}
                  label={t("localChat.attachFile")}
                  active={attachmentMenuOpen}
                />
                {attachmentMenuOpen && (
                  <div className="absolute bottom-full left-0 z-50 mb-1 w-44 overflow-hidden rounded-lg border border-[var(--color-tabby-border)] bg-[var(--color-tabby-bg)] py-1 shadow-lg">
                    {[
                      {
                        key: "image",
                        label: t("localChat.attachImage"),
                        icon: ImageIcon,
                        action: () =>
                          void pickAttachments("image", () =>
                            imageRef.current?.click(),
                          ),
                      },
                      {
                        key: "file",
                        label: t("localChat.attachFiles"),
                        icon: FileUp,
                        action: () =>
                          void pickAttachments("file", () =>
                            fileRef.current?.click(),
                          ),
                      },
                      {
                        key: "directory",
                        label: t("localChat.attachDirectory"),
                        icon: FolderOpen,
                        action: () =>
                          void pickAttachments("directory", () =>
                            directoryRef.current?.click(),
                          ),
                      },
                    ].map(({ key, label, icon: Icon, action }) => (
                      <button
                        key={key}
                        type="button"
                        onClick={() => {
                          setAttachmentMenuOpen(false);
                          action();
                        }}
                        className="flex h-9 w-full items-center gap-2.5 px-3 text-left text-[13px] text-[var(--color-tabby-foreground)] transition-colors hover:bg-[var(--color-tabby-canvas)]"
                      >
                        <Icon className="size-4 text-[var(--color-tabby-muted)]" />
                        <span>{label}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              <div
                className="relative flex items-center"
                ref={skillDropdownRef}
              >
                <button
                  type="button"
                  onClick={() => setSkillDropdownOpen(!skillDropdownOpen)}
                  disabled={runMessageActive}
                  data-chat-skill="true"
                  title={
                    runMessageActive
                      ? t("sessions.chat.runToolsUnavailable")
                      : undefined
                  }
                  className={cn(
                    "flex items-center gap-1.5 px-2 h-8 rounded-lg hover:bg-[var(--color-tabby-canvas)] transition-colors text-sm disabled:cursor-not-allowed disabled:opacity-45 disabled:hover:bg-transparent",
                    selectedSkillSlug
                      ? "text-[var(--color-tabby-foreground)] font-medium"
                      : "text-[var(--color-tabby-muted)]",
                  )}
                >
                  <Sparkles className="w-4 h-4" />
                  <span className="max-w-32 truncate">
                    {selectedSkillSlug
                      ? (installedSkills.find(
                          (skill) => skill.slug === selectedSkillSlug,
                        )?.name ?? selectedSkillSlug)
                      : "Skills"}
                  </span>
                </button>
                {selectedSkillSlug && !runMessageActive && (
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedSkillSlug(null);
                      setSkillDropdownOpen(false);
                    }}
                    className="flex size-7 items-center justify-center rounded-md text-[var(--color-tabby-muted)] transition-colors hover:bg-[var(--color-tabby-canvas)] hover:text-[var(--color-tabby-foreground)]"
                    title={t("localChat.clearSkill")}
                    aria-label={t("localChat.clearSkill")}
                  >
                    <X size={13} />
                  </button>
                )}
                {skillDropdownOpen && (
                  <div className="absolute bottom-full left-0 mb-1 w-56 bg-white border border-[var(--color-tabby-border)] rounded-xl shadow-lg z-50 max-h-64 overflow-y-auto">
                    <div className="px-3 py-2 text-[11px] text-[var(--color-tabby-muted)] font-medium border-b border-[var(--color-tabby-border)]">
                      {t("skills.installed", { defaultValue: "已安装技能" })}
                    </div>
                    {installedSkills.length === 0 ? (
                      <div className="px-3 py-4 text-xs text-[var(--color-tabby-muted)] text-center">
                        {t("skills.noInstalled", {
                          defaultValue: "暂无已安装技能",
                        })}
                      </div>
                    ) : (
                      installedSkills.map((skill) => (
                        <button
                          key={skill.slug}
                          type="button"
                          onClick={() => {
                            setSelectedSkillSlug(
                              selectedSkillSlug === skill.slug
                                ? null
                                : skill.slug,
                            );
                            setSkillDropdownOpen(false);
                          }}
                          className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-tabby-canvas)] transition-colors"
                        >
                          <div className="w-6 h-6 rounded-md bg-[var(--color-tabby-canvas)] flex items-center justify-center shrink-0">
                            <Zap
                              size={12}
                              className="text-[var(--color-tabby-muted)]"
                            />
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="text-[13px] text-[var(--color-tabby-foreground)] truncate">
                              {skill.name}
                            </div>
                          </div>
                          {selectedSkillSlug === skill.slug && (
                            <Check
                              size={14}
                              className="text-[var(--color-tabby-orange)] shrink-0"
                            />
                          )}
                        </button>
                      ))
                    )}
                  </div>
                )}
              </div>
            </>
          )
        }
        rightActions={
          <>
            {showBotSelector ? (
              runMessageActive ? (
                selectedBot ? (
                  <span
                    data-chat-agent="true"
                    className="max-w-[180px] truncate text-[12px] text-text-muted"
                    title={selectedBot.name}
                  >
                    {selectedBot.name}
                  </span>
                ) : null
              ) : (
                <BotSelector
                  bots={bots}
                  selected={selectedBot}
                  onSelect={onSelectBot}
                  showAdd={showAddBot}
                  defaultBotId={defaultBotId}
                  onSetDefault={onSetDefaultBot}
                />
              )
            ) : selectedBot ? (
              <span
                data-chat-agent="true"
                className="max-w-[180px] truncate text-[12px] text-text-muted"
                title={selectedBot.name}
              >
                {selectedBot.name}
              </span>
            ) : null}
            {showModelSelector &&
              (runMessageActive || modelReadOnly ? (
                <span
                  data-chat-model="true"
                  className="max-w-[160px] truncate text-[12px] text-text-muted"
                  title={modelLabel}
                >
                  {modelLabel}
                </span>
              ) : (
                <div className="relative" ref={modelDropdownRef}>
                  <button
                    type="button"
                    onClick={() => setModelDropdownOpen(!modelDropdownOpen)}
                    className="flex items-center gap-1 px-2 h-8 rounded-lg hover:bg-[var(--color-tabby-canvas)] transition-colors text-[var(--color-tabby-muted)] text-sm"
                  >
                    {modelLabel}
                    <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  {modelDropdownOpen && (
                    <div className="absolute bottom-full right-0 mb-1 w-52 bg-white border border-[var(--color-tabby-border)] rounded-xl shadow-lg z-50 max-h-72 overflow-y-auto">
                      {/* Following the global default has to be reachable, or
                          picking a model here would be a one-way door: there
                          would be no way back to tracking the setting. */}
                      <button
                        type="button"
                        onClick={() => {
                          if (!selectedBot) return;
                          onSelectModel?.(selectedBot.id, null);
                          setModelDropdownOpen(false);
                        }}
                        className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-tabby-canvas)] transition-colors"
                      >
                        <div className="flex-1 min-w-0">
                          <div className="text-[13px] text-[var(--color-tabby-foreground)] truncate">
                            {t("models.followDefault")}
                          </div>
                          <div className="text-[11px] text-[var(--color-tabby-muted)] truncate">
                            {nameForModel(defaultModelData?.modelId) ?? "—"}
                          </div>
                        </div>
                        {followsDefault && (
                          <Check
                            size={14}
                            className="text-[var(--color-tabby-orange)] shrink-0"
                          />
                        )}
                      </button>
                      {(() => {
                        // Phone-control, image and video models are reserved
                        // for their own pipelines and cannot answer a chat
                        // turn, so they are not offered here at all. The
                        // settings pickers grey them out with a purpose label
                        // instead, where explaining them is the point.
                        const filtered = models.filter(
                          (m) =>
                            m.id &&
                            m.name &&
                            getSpecialModelLabelKey(m.id) === null,
                        );
                        const groups = new Map<string, typeof filtered>();
                        for (const m of filtered) {
                          const provider =
                            getProviderLabel(m.provider) || "Other";
                          if (!groups.has(provider)) groups.set(provider, []);
                          groups.get(provider)?.push(m);
                        }
                        return Array.from(groups.entries()).map(
                          ([provider, providerModels], gi) => (
                            <div key={provider}>
                              <div
                                className={cn(
                                  "px-3 py-1.5 text-[10px] font-semibold text-[var(--color-tabby-muted)] uppercase tracking-wide",
                                  gi > 0 &&
                                    "border-t border-[var(--color-tabby-border)]",
                                )}
                              >
                                {provider}
                              </div>
                              {providerModels.map((m) => (
                                <button
                                  key={m.id}
                                  type="button"
                                  onClick={() => {
                                    if (!selectedBot) return;
                                    onSelectModel?.(
                                      selectedBot.id,
                                      m.id ?? null,
                                    );
                                    setModelDropdownOpen(false);
                                  }}
                                  className="flex items-center gap-2 w-full px-3 py-2 text-left text-sm hover:bg-[var(--color-tabby-canvas)] transition-colors"
                                >
                                  <div className="flex-1 min-w-0">
                                    <div className="text-[13px] text-[var(--color-tabby-foreground)] truncate">
                                      {m.name}
                                    </div>
                                  </div>
                                  {selectedBot?.modelId === m.id && (
                                    <Check
                                      size={14}
                                      className="text-[var(--color-tabby-orange)] shrink-0"
                                    />
                                  )}
                                </button>
                              ))}
                            </div>
                          ),
                        );
                      })()}
                    </div>
                  )}
                </div>
              ))}
            {voiceSessionKey && (
              <TalkVoiceButton
                key={voiceSessionKey}
                sessionKey={voiceSessionKey}
                disabled={disabled || sending || submitPending || waitingReply}
                onSessionEnded={onVoiceSessionEnded}
              />
            )}
          </>
        }
      />
    </>
  );
}
