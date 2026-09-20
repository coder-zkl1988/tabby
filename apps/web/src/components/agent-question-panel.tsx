import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getApiV1RuntimeQuestions,
  postApiV1RuntimeQuestionsByQuestionIdResolve,
} from "../../lib/api/sdk.gen";

/**
 * Docks pending `ask_user` prompts above the composer.
 *
 * OpenClaw's agent parks a structured question on the Gateway and blocks its
 * turn until someone answers or it expires (default 900s). Without a surface
 * here the run just stalls for the full timeout and then continues with a
 * guess, which reads to the user as a hang.
 *
 * Multi-question prompts advance one question at a time, matching the Control
 * UI and TUI stepper; every answer is submitted together at the end because the
 * Gateway resolves a record as a whole.
 */

const QUESTIONS_QUERY_KEY = ["runtime-questions"] as const;
const POLL_INTERVAL_MS = 3000;

type RuntimeQuestionItem = {
  questionId: string;
  header: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect?: boolean;
  isSecret?: boolean;
};

type RuntimeQuestion = {
  id: string;
  questions: RuntimeQuestionItem[];
  sessionKey?: string;
  expiresAtMs: number;
};

function formatRemaining(expiresAtMs: number, now: number): string {
  const totalSeconds = Math.max(0, Math.round((expiresAtMs - now) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

export function AgentQuestionPanel({ sessionKey }: { sessionKey?: string }) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [stepIndex, setStepIndex] = useState(0);
  const [collected, setCollected] = useState<Record<string, string[]>>({});
  const [multiSelection, setMultiSelection] = useState<string[]>([]);
  const [otherText, setOtherText] = useState("");
  const [now, setNow] = useState(() => Date.now());

  const questionsQuery = useQuery({
    queryKey: QUESTIONS_QUERY_KEY,
    queryFn: async () => {
      const { data, error } = await getApiV1RuntimeQuestions();
      if (error || !data) throw new Error("Runtime questions unavailable");
      return data;
    },
    refetchInterval: POLL_INTERVAL_MS,
  });

  // Only surface a prompt that belongs to this session. Records without a
  // sessionKey are gateway-wide and shown everywhere.
  const active = useMemo<RuntimeQuestion | null>(() => {
    const records = (questionsQuery.data?.questions ?? []) as RuntimeQuestion[];
    const match = records.find(
      (record) =>
        record.sessionKey === undefined ||
        sessionKey === undefined ||
        record.sessionKey === sessionKey,
    );
    return match ?? null;
  }, [questionsQuery.data, sessionKey]);

  // Reset the stepper whenever a different prompt takes over. Adjusting state
  // during render (rather than in an effect) avoids rendering one frame of the
  // previous prompt's answers against the new question.
  const activeId = active?.id ?? null;
  const [trackedId, setTrackedId] = useState(activeId);
  if (activeId !== trackedId) {
    setTrackedId(activeId);
    setStepIndex(0);
    setCollected({});
    setMultiSelection([]);
    setOtherText("");
  }

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);

  const resolveMutation = useMutation({
    mutationFn: async (params: {
      id: string;
      answers?: Record<string, string[]>;
    }) => {
      const { error } = await postApiV1RuntimeQuestionsByQuestionIdResolve({
        path: { questionId: params.id },
        body: params.answers ? { answers: params.answers } : { skip: true },
      });
      if (error) throw new Error("Failed to resolve question");
    },
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: QUESTIONS_QUERY_KEY });
    },
  });

  if (!active) return null;

  const step = active.questions[stepIndex];
  if (!step) return null;

  const isLast = stepIndex === active.questions.length - 1;
  const busy = resolveMutation.isPending;

  const commit = (values: string[]) => {
    const next = { ...collected, [step.questionId]: values };
    if (!isLast) {
      setCollected(next);
      setStepIndex((index) => index + 1);
      setMultiSelection([]);
      setOtherText("");
      return;
    }
    resolveMutation.mutate({ id: active.id, answers: next });
  };

  const toggleMulti = (label: string) => {
    setMultiSelection((current) =>
      current.includes(label)
        ? current.filter((value) => value !== label)
        : [...current, label],
    );
  };

  return (
    <div
      data-agent-question="true"
      className="mb-2 border-l-2 border-[var(--color-tabby-orange)] px-3 py-2"
    >
      <div className="mb-1.5 flex items-center gap-2">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 text-[10px] font-medium text-text-muted">
          {step.header}
        </span>
        {active.questions.length > 1 && (
          <span className="text-[10px] text-text-muted">
            {stepIndex + 1}/{active.questions.length}
          </span>
        )}
        <span className="ml-auto text-[10px] tabular-nums text-text-muted">
          {formatRemaining(active.expiresAtMs, now)}
        </span>
      </div>

      <div className="mb-2 text-xs font-medium text-text-primary">
        {step.question}
      </div>

      <div className="flex flex-wrap gap-1.5">
        {step.options.map((option) => {
          const selected = multiSelection.includes(option.label);
          return (
            <button
              key={option.label}
              type="button"
              disabled={busy}
              title={option.description}
              onClick={() =>
                step.multiSelect
                  ? toggleMulti(option.label)
                  : commit([option.label])
              }
              className={`h-8 shrink-0 rounded-md border px-2.5 text-xs transition-colors disabled:opacity-50 ${
                selected
                  ? "border-[var(--color-tabby-orange)] bg-[var(--color-tabby-orange)] text-white"
                  : "border-border text-text-primary hover:bg-surface-2"
              }`}
            >
              {option.label}
            </button>
          );
        })}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <input
          type={step.isSecret ? "password" : "text"}
          value={otherText}
          disabled={busy}
          onChange={(event) => setOtherText(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && otherText.trim().length > 0) {
              event.preventDefault();
              commit([otherText.trim()]);
            }
          }}
          placeholder={t("sessions.chat.agentQuestionOther")}
          className="h-8 min-w-0 flex-1 rounded-md border border-border bg-transparent px-2.5 text-xs text-text-primary outline-none placeholder:text-text-muted focus:border-[var(--color-tabby-orange)]"
        />
        {step.multiSelect && (
          <button
            type="button"
            disabled={busy || multiSelection.length === 0}
            onClick={() => commit(multiSelection)}
            className="h-8 shrink-0 rounded-md bg-[var(--color-tabby-orange)] px-2.5 text-xs text-white transition-colors hover:bg-[var(--color-tabby-orange-hover)] disabled:opacity-50"
          >
            {t("sessions.chat.agentQuestionConfirm")}
          </button>
        )}
        <button
          type="button"
          disabled={busy}
          onClick={() => resolveMutation.mutate({ id: active.id })}
          className="h-8 shrink-0 rounded-md px-2.5 text-xs text-text-muted transition-colors hover:bg-surface-2 hover:text-text-primary disabled:opacity-50"
        >
          {t("sessions.chat.agentQuestionSkip")}
        </button>
      </div>
    </div>
  );
}
