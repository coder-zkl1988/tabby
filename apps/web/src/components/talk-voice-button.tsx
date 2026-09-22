import { type TalkStatus, TalkVoiceSession } from "@/lib/talk-voice";
import { useQuery } from "@tanstack/react-query";
import { Loader2, Mic, Square } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { toast } from "sonner";
import {
  getApiV1TalkCatalog,
  postApiV1TalkSessions,
} from "../../lib/api/sdk.gen";

function talkErrorMessage(error: unknown, translate: (key: string) => string) {
  const exception =
    error instanceof Error || error instanceof DOMException ? error : null;
  if (exception) {
    if (exception.name === "NotAllowedError") {
      return translate("sessions.chat.talkMicrophoneDenied");
    }
    if (exception.name === "NotFoundError") {
      return translate("sessions.chat.talkMicrophoneMissing");
    }
  }

  const message =
    exception?.message ?? (typeof error === "string" ? error : "");
  switch (message) {
    case "Realtime provider error.":
    case "voice stream failed":
    case "voice stream failed to open":
    case "voice stream closed before opening":
      return translate("sessions.chat.talkConnectionFailed");
    case "Failed to create a voice session":
    case "voice session failed":
    case "":
      return translate("sessions.chat.talkFailed");
    default:
      return message;
  }
}

/**
 * Start/stop control for a realtime voice conversation.
 *
 * Hidden entirely when no realtime provider is configured — an always-visible
 * mic that can only fail is worse than no mic, and the catalog tells us up
 * front rather than after the user has granted microphone access.
 */
export function TalkVoiceButton({
  sessionKey,
  disabled = false,
  onSessionEnded,
}: {
  sessionKey?: string;
  disabled?: boolean;
  onSessionEnded?: () => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const [status, setStatus] = useState<TalkStatus>("idle");
  const sessionRef = useRef<TalkVoiceSession | null>(null);
  const mountedRef = useRef(true);
  const requestRef = useRef<AbortController | null>(null);

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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestRef.current?.abort();
      void sessionRef.current?.stop();
      sessionRef.current = null;
    };
  }, []);

  const stop = useCallback(async () => {
    await sessionRef.current?.stop();
    sessionRef.current = null;
    setStatus("idle");
    if (mountedRef.current) await onSessionEnded?.();
  }, [onSessionEnded]);

  const start = useCallback(async () => {
    if (disabled) return;
    setStatus("starting");
    const request = new AbortController();
    requestRef.current = request;
    try {
      const { data, error } = await postApiV1TalkSessions({
        body: sessionKey ? { sessionKey } : {},
        signal: request.signal,
      });
      if (!mountedRef.current || request.signal.aborted) return;
      if (error || !data) throw new Error("Failed to create a voice session");

      const session = new TalkVoiceSession({
        onStatus: setStatus,
        onError: (message) => toast.error(talkErrorMessage(message, t)),
      });
      sessionRef.current = session;
      await session.start({
        sessionId: data.sessionId,
        inputSampleRateHz: data.inputSampleRateHz,
        outputSampleRateHz: data.outputSampleRateHz,
      });
    } catch (error) {
      // `start()` can fail after the microphone is already live (a rejected
      // upgrade, a restarting controller). Dropping the reference without
      // tearing down leaves the mic hot and the gateway session open, and leaks
      // one AudioContext per retry until the browser refuses to make more.
      await sessionRef.current?.stop().catch(() => {});
      sessionRef.current = null;
      if (!mountedRef.current || request.signal.aborted) return;
      setStatus("idle");
      toast.error(talkErrorMessage(error, t));
    } finally {
      if (requestRef.current === request) requestRef.current = null;
    }
  }, [disabled, sessionKey, t]);

  const ready = catalogQuery.data?.ready === true;
  if (!ready) return null;

  const active = status !== "idle" && status !== "error";
  const busy = status === "starting";

  return (
    <button
      type="button"
      data-chat-action="voice"
      aria-pressed={active}
      onClick={() => {
        if (active) void stop();
        else void start();
      }}
      disabled={busy || (disabled && !active)}
      title={
        active ? t("sessions.chat.talkStop") : t("sessions.chat.talkStart")
      }
      aria-label={
        active ? t("sessions.chat.talkStop") : t("sessions.chat.talkStart")
      }
      className={`flex size-9 shrink-0 items-center justify-center rounded-full transition-colors disabled:cursor-not-allowed disabled:opacity-50 ${
        active
          ? "bg-[var(--color-tabby-orange)] text-white hover:bg-[var(--color-tabby-orange-hover)]"
          : "text-text-muted hover:bg-surface-2 hover:text-text-primary"
      }`}
    >
      {busy ? (
        <Loader2 className="size-4 animate-spin" />
      ) : status === "speaking" ? (
        <Square className="size-3.5" />
      ) : (
        <Mic className="size-4" />
      )}
    </button>
  );
}
