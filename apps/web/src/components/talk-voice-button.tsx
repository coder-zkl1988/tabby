import { type TalkStatus, TalkVoiceSession } from "@/lib/talk-voice";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Mic, MicOff, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getApiV1TalkCatalog,
  postApiV1TalkSessions,
} from "../../lib/api/sdk.gen";

/**
 * Start/stop control for a realtime voice conversation.
 *
 * Hidden entirely when no realtime provider is configured — an always-visible
 * mic that can only fail is worse than no mic, and the catalog tells us up
 * front rather than after the user has granted microphone access.
 */
export function TalkVoiceButton({ sessionKey }: { sessionKey?: string }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TalkStatus>("idle");
  const sessionRef = useRef<TalkVoiceSession | null>(null);

  const catalogQuery = useQuery({
    queryKey: ["talk-catalog"],
    queryFn: async () => {
      const { data, error } = await getApiV1TalkCatalog();
      if (error || !data) throw new Error("Talk catalog unavailable");
      return data;
    },
    staleTime: 60_000,
  });

  useEffect(() => {
    return () => {
      void sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  const stop = useCallback(async () => {
    await sessionRef.current?.stop();
    sessionRef.current = null;
    setStatus("idle");
  }, []);

  const start = useCallback(async () => {
    setStatus("starting");
    try {
      const { data, error } = await postApiV1TalkSessions({
        body: sessionKey ? { sessionKey } : {},
      });
      if (error || !data) throw new Error("Failed to create a voice session");

      const session = new TalkVoiceSession({
        onStatus: setStatus,
        onError: (message) => toast.error(message),
      });
      sessionRef.current = session;
      await session.start({
        sessionId: data.sessionId,
        inputSampleRateHz: data.inputSampleRateHz,
        outputSampleRateHz: data.outputSampleRateHz,
      });
    } catch (error) {
      sessionRef.current = null;
      setStatus("idle");
      toast.error(
        error instanceof Error ? error.message : t("sessions.chat.talkFailed"),
      );
    }
  }, [sessionKey, t]);

  const ready = catalogQuery.data?.ready === true;
  if (!ready) return null;

  const active = status !== "idle" && status !== "error";
  const busy = status === "starting";

  return (
    <button
      type="button"
      onClick={() => {
        if (active) void stop();
        else void start();
      }}
      disabled={busy}
      title={
        active ? t("sessions.chat.talkStop") : t("sessions.chat.talkStart")
      }
      aria-label={
        active ? t("sessions.chat.talkStop") : t("sessions.chat.talkStart")
      }
      className={`flex size-8 shrink-0 items-center justify-center rounded-md transition-colors disabled:opacity-50 ${
        active
          ? "bg-[var(--color-tabby-orange)] text-white hover:bg-[var(--color-tabby-orange-hover)]"
          : "text-text-muted hover:bg-surface-2 hover:text-text-primary"
      }`}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : status === "speaking" ? (
        <Square className="size-3.5" />
      ) : active ? (
        <Mic className="size-4" />
      ) : (
        <MicOff className="size-4" />
      )}
    </button>
  );
}
