import {
  type BotItem,
  ChatInputArea,
  type PendingAttachment,
} from "@/components/chat-input-area";
import { invokeDesktopHost } from "@/lib/desktop-host";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import { toast } from "sonner";
import {
  getApiV1Bots,
  getApiV1BotsDefault,
  getApiV1ChatSession,
  patchApiV1BotsByBotId,
  postApiV1ChatLocalStart,
  putApiV1BotsDefault,
} from "../../lib/api/sdk.gen";
import { buildPendingSessionPath } from "../lib/local-chat-pending";

const DESKPET_TYPING_DURATION_MS = 1600;
const DESKPET_TYPING_NOTIFY_INTERVAL_MS = 700;
const DESKPET_SUBMIT_DURATION_MS = 2200;
const DESKPET_REPLYING_DURATION_MS = 8000;
const DESKPET_ERROR_DURATION_MS = 4200;

export function LocalChatPage() {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const urlBotId = searchParams.get("botId");

  const [selectedBot, setSelectedBot] = useState<BotItem | null>(null);
  const [waitingReply, setWaitingReply] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  const contextKeyRef = useRef<string>("");
  const lastDeskpetTypingNotifyAtRef = useRef(0);
  const urlBotResolvedRef = useRef(false);
  // Unique per visit to this page, so starting a new conversation never
  // resumes an existing session for the same bot. The page navigates away as
  // soon as a real session is established (see sendMessage below), so a
  // fresh key is generated the next time this page is visited.
  const sessionUuidRef = useRef<string>(crypto.randomUUID());
  const voiceSessionKey = selectedBot
    ? `agent:${selectedBot.id}:${sessionUuidRef.current}`
    : null;

  const handleVoiceSessionEnded = useCallback(async () => {
    if (!selectedBot || !voiceSessionKey) return;
    try {
      const { data, error } = await getApiV1ChatSession({
        query: { botId: selectedBot.id, sessionKey: voiceSessionKey },
      });
      if (error) throw error;
      void queryClient.invalidateQueries({ queryKey: ["sidebar-sessions"] });
      if (data?.session?.id) navigate(`/workspace/sessions/${data.session.id}`);
    } catch {
      toast.error(t("sessions.chat.talkFailed"));
    }
  }, [navigate, queryClient, selectedBot, t, voiceSessionKey]);

  // Fetch bots
  const { data: botsData, isLoading: botsLoading } = useQuery({
    queryKey: ["bots"],
    queryFn: async () => {
      const { data } = await getApiV1Bots();
      return data;
    },
  });
  const bots = (botsData?.bots ?? []) as BotItem[];
  const activeBots = bots.filter((b) => b.status === "active");

  // Resolver-selected default bot (explicit defaultBotId → system bot →
  // slug order). Only fetched once bots exist — with zero active bots the
  // createDefaultBot mutation below owns the lazy-create path.
  const { data: defaultBotData, isError: defaultBotFailed } = useQuery({
    queryKey: ["bots", "default"],
    queryFn: async () => {
      const { data } = await getApiV1BotsDefault();
      return data;
    },
    enabled: activeBots.length > 0,
  });

  // Auto-create a default bot when none exist
  const createDefaultBot = useMutation({
    mutationFn: async () => {
      const { data } = await getApiV1BotsDefault();
      return data;
    },
    onSuccess: (newBot) => {
      void queryClient.invalidateQueries({ queryKey: ["bots"] });
      setSelectedBot(newBot as BotItem);
    },
  });

  const noActiveBots = activeBots.length === 0;
  const isCreatingBot = botsLoading || createDefaultBot.isPending;
  const createError = createDefaultBot.error;

  // Automatically create a default bot when none exist
  useEffect(() => {
    if (
      noActiveBots &&
      !botsLoading &&
      !createDefaultBot.isPending &&
      !createError
    ) {
      createDefaultBot.mutate();
    }
  }, [noActiveBots, botsLoading, createDefaultBot, createError]);

  // Auto-select bot: prefer URL botId, then the resolver-selected default
  useEffect(() => {
    if (activeBots.length === 0 || selectedBot) return;

    // Resolve URL botId once
    if (urlBotId && !urlBotResolvedRef.current) {
      const target = activeBots.find((b) => b.id === urlBotId);
      if (target) {
        urlBotResolvedRef.current = true;
        setSelectedBot(target);
        return;
      }
    }

    // Fall back to the desktop default bot; first active bot only when the
    // default lookup failed (keeps the page usable if the endpoint errors).
    if (defaultBotData) {
      const inList = activeBots.find((b) => b.id === defaultBotData.id);
      setSelectedBot(inList ?? (defaultBotData as BotItem));
      return;
    }
    if (defaultBotFailed && activeBots[0]) {
      setSelectedBot(activeBots[0]);
    }
  }, [activeBots, selectedBot, urlBotId, defaultBotData, defaultBotFailed]);

  // Bot selection
  const handleSelectBot = useCallback((bot: BotItem) => {
    setSelectedBot(bot);
  }, []);

  /**
   * Binds a model to a bot, or clears it back to following the global default.
   *
   * Selection lives in local state here, so the persist has to be explicit —
   * mutating the selected bot alone would show the new model until the next
   * refetch and then quietly revert.
   */
  const updateBotModel = useCallback(
    async (botId: string, modelId: string | null): Promise<void> => {
      const { error } = await patchApiV1BotsByBotId({
        path: { botId },
        body: { modelId },
      });
      if (error) return;
      setSelectedBot((current) =>
        current && current.id === botId ? { ...current, modelId } : current,
      );
      await queryClient.invalidateQueries({ queryKey: ["bots"] });
    },
    [queryClient],
  );

  const setDefaultBot = useMutation({
    mutationFn: async (botId: string) => {
      const { data } = await putApiV1BotsDefault({ body: { botId } });
      return data;
    },
    onSuccess: () => {
      // Prefix match also refreshes ["bots", "default"].
      void queryClient.invalidateQueries({ queryKey: ["bots"] });
    },
  });
  const handleSetDefaultBot = useCallback(
    (bot: BotItem) => {
      setDefaultBot.mutate(bot.id);
    },
    [setDefaultBot],
  );

  const handleDeskpetTyping = useCallback(
    (text: string) => {
      if (waitingReply || !text.trim()) {
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
        durationMs: DESKPET_TYPING_DURATION_MS,
      });
    },
    [waitingReply],
  );

  // Send message, then leave the new-conversation page as soon as OpenClaw
  // acknowledges chat.send. PendingSessionPage resolves the real session later.
  const sendMessage = useCallback(
    async (
      text: string,
      atts: PendingAttachment[],
      skillSlug: string | null,
    ) => {
      if (!selectedBot) return false;

      const botId = selectedBot.id;
      const ctxKey = botId;
      contextKeyRef.current = ctxKey;
      const newSessionKey = `agent:${botId}:${sessionUuidRef.current}`;

      try {
        setSendError(null);
        setWaitingReply(true);
        invokeDesktopHost("desktop:deskpet-activity", {
          mood: "working",
          durationMs: DESKPET_SUBMIT_DURATION_MS,
        });

        const onlyImage = atts.length === 1 ? atts[0] : undefined;
        const isImageOnly =
          onlyImage?.type === "image" &&
          Boolean(onlyImage.content) &&
          !text.trim();
        const msgContent =
          isImageOnly && onlyImage
            ? {
                type: "image" as const,
                content: onlyImage.content,
                metadata: { mimeType: onlyImage.mimeType },
              }
            : {
                type: "text" as const,
                content: text,
                ...(skillSlug ? { skillSlug } : {}),
                attachments:
                  atts.length > 0
                    ? atts.map((a) => ({
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

        const result = await postApiV1ChatLocalStart({
          body: {
            botId,
            sessionKey: newSessionKey,
            message: msgContent,
          },
        });

        if (result.error) {
          throw result.error;
        }

        const responseData = result.data;

        if (contextKeyRef.current !== ctxKey) {
          setWaitingReply(false);
          return true;
        }

        const runId =
          typeof responseData?.message?.runId === "string"
            ? responseData.message.runId
            : undefined;
        invokeDesktopHost("desktop:deskpet-activity", {
          mood: "lobster-replying",
          durationMs: DESKPET_REPLYING_DURATION_MS,
        });

        const session = responseData?.session ?? null;
        if (session?.id) {
          navigate(`/workspace/sessions/${session.id}`, {
            state: {
              deskpetPendingRunId: runId,
              deskpetPendingSessionKey:
                responseData?.sessionKey ?? newSessionKey,
            },
          });
          return true;
        }

        const pendingText = text.trim()
          ? text
          : isImageOnly
            ? "[Image]"
            : atts.length > 0
              ? "[File]"
              : "";
        navigate(
          buildPendingSessionPath({
            botId,
            sessionKey: responseData?.sessionKey ?? newSessionKey,
            runId,
          }),
          {
            state: { pendingText, pendingBotName: selectedBot.name },
          },
        );
        return true;
      } catch (error) {
        setWaitingReply(false);
        setSendError(
          typeof error === "object" &&
            error !== null &&
            "message" in error &&
            typeof error.message === "string"
            ? error.message
            : "",
        );
        invokeDesktopHost("desktop:deskpet-activity", {
          mood: "error",
          durationMs: DESKPET_ERROR_DURATION_MS,
        });
        return false;
      }
    },
    [selectedBot, navigate],
  );

  const placeholder = createError
    ? t("localChat.createDefaultBotError")
    : isCreatingBot
      ? t("localChat.creatingDefaultBot")
      : !selectedBot
        ? t("localChat.selectBotFirst")
        : waitingReply
          ? t("localChat.waiting")
          : t("localChat.inputPlaceholder");

  return (
    <div className="h-full overflow-hidden">
      <main className="h-full w-full overflow-hidden relative flex flex-col">
        <div className="flex-1 overflow-y-auto overflow-x-hidden h-full">
          <div className="flex flex-col items-center justify-center min-h-full px-4 py-6 md:py-10">
            <div className="flex w-full flex-col items-center">
              <div className="mb-5 md:mb-6 relative w-[144px] h-[144px] md:w-[176px] md:h-[176px]">
                <img
                  src="/images/tabby-mascot.png"
                  alt="Tabby mascot"
                  className="w-full h-full object-contain transition-opacity duration-300 hover:opacity-0"
                />
                <img
                  src="/images/tabby-mascot-colorful.png"
                  alt="Tabby mascot colorful"
                  className="absolute inset-0 w-full h-full object-contain opacity-0 transition-opacity duration-300 hover:opacity-100"
                />
              </div>
              <h2
                className="text-[26px] font-normal tracking-tight text-[var(--color-tabby-foreground)] mb-6 md:mb-8"
                style={{ fontFamily: "var(--font-script)" }}
              >
                Happy Tabby
              </h2>
              <div className="w-full max-w-xl md:max-w-2xl">
                <ChatInputArea
                  bots={bots}
                  selectedBot={selectedBot}
                  onSelectBot={handleSelectBot}
                  onSelectModel={(botId, modelId) => {
                    void updateBotModel(botId, modelId);
                  }}
                  defaultBotId={defaultBotData?.id ?? null}
                  onSetDefaultBot={handleSetDefaultBot}
                  onSend={sendMessage}
                  voiceSessionKey={voiceSessionKey}
                  onVoiceSessionEnded={handleVoiceSessionEnded}
                  onTyping={handleDeskpetTyping}
                  sending={false}
                  waitingReply={waitingReply}
                  disabled={!selectedBot || isCreatingBot}
                  placeholder={placeholder}
                  showAddBot
                />
                {sendError !== null && (
                  <div
                    role="alert"
                    className="mt-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300"
                  >
                    <p>{t("localChat.sendFailed")}</p>
                    {sendError && (
                      <p className="mt-1 break-words text-xs">{sendError}</p>
                    )}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
