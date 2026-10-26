import {
  XHS_TAKEOVER_IDENTITY_READ_TTL_MS,
  XHS_TAKEOVER_RESUME_REASON_CODES,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsAccountDiagnosis,
  type XhsOpsChangeOrder,
  type XhsOpsHeaderCounts,
  type XhsOpsPlaybookRule,
  type XhsOpsProject,
  type XhsOpsTakeoverEvent,
  type XhsOpsTakeoverGateResult,
  type XhsOpsTakeoverStage,
  xhsOpsAccountAuditedEvent,
  xhsOpsAuditManualCheckFlags,
  xhsOpsLegacyExistingVerified,
  xhsOpsTakeoverStage,
} from "@nexu/shared";
import { useCallback, useEffect, useRef, useState } from "react";
import { ZoomableImage } from "../../components/zoomable-image";
import type { CustomComponentProps } from "../registry";
import { describeXhsOpsError, xhsOpsApi } from "./xhs-ops-api";
import { ProjectPicker, useProjectResolution } from "./xhs-ops-project-picker";
import {
  AUDIT_FLAG_LABEL,
  AUDIT_PARTS,
  AUDIT_PART_STATUS_LABEL,
  AUDIT_STATUS_LABEL,
  PAUSE_CODE_LABEL,
  TAKEOVER_AUDIT_RESIDUAL_NOTICE,
  TAKEOVER_AUTHORIZATION_STATEMENT,
  TAKEOVER_DETAILS_RECOVERING,
  TAKEOVER_FEEDBACK_MAX,
  TAKEOVER_POLICY_MODE_UNKNOWN_NOTICE,
  TAKEOVER_READ_ONLY_EXPECTATION,
  TAKEOVER_RECOVERING_HINT,
  TAKEOVER_STAGE_LABEL,
  auditPartTone,
  changeOrderAwaitingFinish,
  changeOrderInFlight,
  countDisplay,
  formatDateTime,
  forwardedTakeoverEventStored,
  isTakeoverRecovering,
  loadForwardedTakeoverEvents,
  mergeRevisions,
  olderRevision,
  rememberForwardedTakeoverEvent,
  takeoverEventKey,
  takeoverPolicyModeState,
  takeoverSkillDocsState,
  takeoverStageTone,
  takeoverStep,
} from "./xhs-ops-takeover-model";
import {
  ChangeOrdersSection,
  ObservationSection,
} from "./xhs-ops-takeover-orders";
import {
  DiagnosisSection,
  PlanSection,
  type TakeoverFeedback,
} from "./xhs-ops-takeover-plan";
import {
  CheckLine,
  Notice,
  type TakeoverData,
  type TakeoverOps,
  TakeoverSection,
  type TakeoverSectionProps,
  ValueRow,
  useTakeoverAction,
} from "./xhs-ops-takeover-ui";
import { asString } from "./xhs-ops-types";
import {
  CardShell,
  EmptyState,
  ErrorLine,
  Field,
  HintLine,
  PrimaryButton,
  SecondaryButton,
  Skeleton,
  Spinner,
  StatusPill,
  type XhsOpsDevice,
  inputClass,
  readProp,
  textareaClass,
  useXhsOpsDevices,
} from "./xhs-ops-ui";

const POLL_INTERVAL_MS = 3_000;
const CLOCK_INTERVAL_MS = 30_000;
/** Read again this long after a 503 of the controller's startup recovery. */
const RECOVERY_RETRY_MS = 3_000;

/**
 * 老号接管 (takeover design §1): one card per existing account, ① authorize →
 * ② lock the identity → ③ read-only audit and baseline → ④ diagnosis → ⑤
 * item-by-item plan → ⑥ public change orders → ⑦ observation. Every write is
 * a click here; `feedbackDraft` from the agent only pre-fills the comment box.
 * The card forwards the controller's takeover events to the agent once each.
 */
export function XhsOpsTakeover({
  comp,
  resolve,
  onAction,
}: CustomComponentProps) {
  const propProjectId = asString(readProp(comp, resolve, "projectId")).trim();
  const projectName = asString(readProp(comp, resolve, "projectName")).trim();
  const accountId = asString(readProp(comp, resolve, "accountId")).trim();
  const feedbackDraft = asString(
    readProp(comp, resolve, "feedbackDraft"),
  ).slice(0, TAKEOVER_FEEDBACK_MAX);

  return (
    <CardShell
      testId="takeover"
      title="老号接管"
      subtitle="授权 → 锁定身份 → 只读盘点 → 诊断 → 逐项采纳；公开资料只通过变更单逐张确认后修改"
    >
      {accountId ? (
        <XhsOpsTakeoverContent
          accountId={accountId}
          projectId={propProjectId}
          feedbackDraft={feedbackDraft}
          onAction={onAction}
        />
      ) : (
        <TakeoverAccountPicker
          propProjectId={propProjectId}
          projectName={projectName}
          feedbackDraft={feedbackDraft}
          onAction={onAction}
        />
      )}
    </CardShell>
  );
}

/** Without accountId: pick the project, then one of its existing-mode accounts. */
function TakeoverAccountPicker({
  propProjectId,
  projectName,
  feedbackDraft,
  onAction,
}: {
  propProjectId: string;
  projectName: string;
  feedbackDraft: string;
  onAction?: CustomComponentProps["onAction"];
}) {
  const resolution = useProjectResolution(propProjectId, projectName);
  const projectId = resolution.projectId;
  const [accounts, setAccounts] = useState<XhsOpsAccount[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    setAccounts(null);
    setPicked(null);
    xhsOpsApi
      .listAccounts(projectId)
      .then((list) => {
        if (cancelled) return;
        const existing = list.filter(
          (account) => account.entryMode === "existing",
        );
        setAccounts(existing);
        if (existing.length === 1) setPicked(existing[0]?.id ?? null);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setAccounts([]);
        setError(describeXhsOpsError(err, "账号列表加载失败"));
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  if (!projectId) {
    return (
      <>
        <ErrorLine message={resolution.error} />
        <ProjectPicker
          resolution={resolution}
          wanted={projectName}
          purpose="接管账号"
        />
      </>
    );
  }
  if (picked) {
    return (
      <XhsOpsTakeoverContent
        accountId={picked}
        projectId={projectId}
        feedbackDraft={feedbackDraft}
        onAction={onAction}
      />
    );
  }
  if (accounts === null) return <Skeleton rows={2} label="正在加载接管账号" />;
  return (
    <div className="flex flex-col gap-2">
      <ErrorLine message={error} />
      {accounts.length === 0 && !error ? (
        <EmptyState>
          这个项目还没有「接管已有账号」的行；先在账号配置里新增一行，选「接管已有账号」并绑定手机。
        </EmptyState>
      ) : null}
      {accounts.length > 0 ? (
        <>
          <HintLine>选择要接管的账号：</HintLine>
          <div className="flex flex-wrap gap-1.5">
            {accounts.map((account) => (
              <SecondaryButton
                key={account.id}
                onClick={() => setPicked(account.id)}
              >
                {account.label}
                {account.deviceName ? ` · ${account.deviceName}` : ""}
              </SecondaryButton>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), CLOCK_INTERVAL_MS);
    return () => clearInterval(timer);
  }, []);
  return now;
}

/**
 * The audit section shows: a running one, else the latest; observation
 * reviews show under ⑦ instead.
 */
function displayedAudit(
  account: XhsOpsAccount,
  audits: readonly XhsOpsAccountAudit[],
): XhsOpsAccountAudit | null {
  const own = audits.filter((audit) => audit.trigger !== "observation");
  return (
    own.find((audit) => audit.status === "running") ??
    own.find((audit) => audit.id === account.takeover?.latestAuditId) ??
    own[0] ??
    null
  );
}

/**
 * The card body for one account, also embedded by the run planner for a
 * takeover account the nurture gate blocks.
 */
export function XhsOpsTakeoverContent({
  accountId,
  projectId = "",
  feedbackDraft = "",
  onAction,
  onAccountChange,
}: {
  accountId: string;
  /** The project the caller expects the account in; "" when unknown. */
  projectId?: string;
  feedbackDraft?: string;
  onAction?: CustomComponentProps["onAction"];
  onAccountChange?: (account: XhsOpsAccount) => void;
}) {
  const [account, setAccountState] = useState<XhsOpsAccount | null>(null);
  const [project, setProject] = useState<XhsOpsProject | null>(null);
  const [audits, setAudits] = useState<XhsOpsAccountAudit[]>([]);
  const [diagnosis, setDiagnosisState] =
    useState<XhsOpsAccountDiagnosis | null>(null);
  const [orders, setOrdersState] = useState<XhsOpsChangeOrder[]>([]);
  const [playbook, setPlaybook] = useState<XhsOpsPlaybookRule[]>([]);
  /** The bundle the playbook's doc rules were checked against; until it loads, PHONE_SKILLS_BUNDLE. */
  const [playbookBundle, setPlaybookBundle] = useState<number | undefined>(
    undefined,
  );
  const [loadError, setLoadError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  /** A read hit the 503 of the controller's startup recovery; re-read soon. */
  const [recovering, setRecovering] = useState(false);
  /** Re-reads the account (and then the details). */
  const [reload, setReload] = useState(0);
  /** Re-reads the audits, change orders and diagnosis of the loaded account. */
  const [detailsReload, setDetailsReload] = useState(0);
  /** Those lists were read once: until then the sections ①–⑦ wait. */
  const [detailsReady, setDetailsReady] = useState(false);
  const [detailsError, setDetailsError] = useState<string | null>(null);
  const [focus, setFocus] = useState<{ row: string; seq: number } | null>(null);
  const now = useNow();
  const { devices } = useXhsOpsDevices();

  const accountRef = useRef(account);
  accountRef.current = account;
  const auditsRef = useRef(audits);
  auditsRef.current = audits;
  const diagnosisRef = useRef(diagnosis);
  diagnosisRef.current = diagnosis;
  const ordersRef = useRef(orders);
  ordersRef.current = orders;
  const onAccountChangeRef = useRef(onAccountChange);
  onAccountChangeRef.current = onAccountChange;

  // Reads race writes (a poll that started before a click returns after it),
  // so no setter takes a revision older than the one on screen.
  const setAccount = useCallback((next: XhsOpsAccount) => {
    const previous = accountRef.current;
    if (olderRevision(next, previous)) return;
    accountRef.current = next;
    setAccountState(next);
    // The caller (the run planner) loaded this account itself: report only
    // revisions this card moved past. Echoing every read back made the
    // planner rebuild its plans and remount this card, which read again — a
    // loop.
    if (previous && previous.updatedAt !== next.updatedAt)
      onAccountChangeRef.current?.(next);
  }, []);
  const upsertAudit = useCallback((next: XhsOpsAccountAudit) => {
    setAudits((current) => {
      const known = current.find((audit) => audit.id === next.id);
      if (olderRevision(next, known)) return current;
      return known
        ? current.map((audit) => (audit.id === next.id ? next : audit))
        : [next, ...current];
    });
  }, []);
  const upsertOrder = useCallback((next: XhsOpsChangeOrder) => {
    setOrdersState((current) => {
      const known = current.find((order) => order.id === next.id);
      if (olderRevision(next, known)) return current;
      return known
        ? current.map((order) => (order.id === next.id ? next : order))
        : [next, ...current];
    });
  }, []);
  const setOrders = useCallback((next: XhsOpsChangeOrder[]) => {
    setOrdersState((current) => mergeRevisions(current, next));
  }, []);
  const setDiagnosis = useCallback((next: XhsOpsAccountDiagnosis | null) => {
    setDiagnosisState((current) =>
      next && olderRevision(next, current) ? current : next,
    );
  }, []);

  // ── Events: each reaches the agent once, across polls and remounts ──
  const forwardedRef = useRef<Set<string> | null>(null);
  if (forwardedRef.current === null)
    forwardedRef.current = loadForwardedTakeoverEvents();
  const onActionRef = useRef(onAction);
  onActionRef.current = onAction;
  const forward = useCallback(
    (
      event: XhsOpsTakeoverEvent | null | undefined,
      revision?: string | null,
    ) => {
      if (!event) return;
      const key = takeoverEventKey(event, revision);
      const seen = forwardedRef.current;
      if (!seen || seen.has(key) || forwardedTakeoverEventStored(key)) return;
      seen.add(key);
      rememberForwardedTakeoverEvent(key);
      onActionRef.current?.(event.name, event.payload);
    },
    [],
  );
  /** Records this mount saw on their way: only their polled events are announced. */
  const trackedRef = useRef(new Set<string>());
  const track = useCallback((id: string) => {
    trackedRef.current.add(id);
  }, []);

  // Every write a section makes goes through `ops` below and bumps this. A
  // list read sent before the latest write can come back after it without
  // what the write made (a fresh change order, a new diagnosis version), so
  // such a read is dropped whole and the lists are read again.
  const writeSeqRef = useRef(0);

  const loadDetails = useCallback(async (next: XhsOpsAccount) => {
    const writeSeq = writeSeqRef.current;
    const takeover = next.takeover;
    const authorized = Boolean(takeover?.authorizedAt);
    const [auditList, orderList, diagnosisView] = await Promise.all([
      authorized ? xhsOpsApi.listAudits(next.id) : Promise.resolve([]),
      authorized ? xhsOpsApi.listChangeOrders(next.id) : Promise.resolve([]),
      takeover?.activeDiagnosisId
        ? xhsOpsApi.getDiagnosis(takeover.activeDiagnosisId)
        : Promise.resolve(null),
    ]);
    return {
      writeSeq,
      audits: auditList,
      orders: orderList,
      diagnosis: diagnosisView?.diagnosis ?? null,
      diagnosisEvent: diagnosisView?.event ?? null,
    };
  }, []);
  type Details = Awaited<ReturnType<typeof loadDetails>>;

  /** False when a write landed while the read was out: nothing applied, read again. */
  const applyDetails = useCallback(
    (details: Details): boolean => {
      if (details.writeSeq !== writeSeqRef.current) {
        setDetailsReload((value) => value + 1);
        return false;
      }
      setAudits((current) => mergeRevisions(current, details.audits));
      setOrders(details.orders);
      setDiagnosis(details.diagnosis);
      // A generation can settle before any poll saw it running (a quick
      // failure): its event still reaches the agent, once.
      if (details.diagnosis && trackedRef.current.has(details.diagnosis.id))
        forward(details.diagnosisEvent);
      return true;
    },
    [forward, setDiagnosis, setOrders],
  );

  // The account first: the header, 「暂停接管」 and the banners work while
  // the lists below are on their way — or answer 503 through the
  // controller's startup recovery, which pausing is exempt from (§2.6).
  useEffect(() => {
    void reload;
    let cancelled = false;
    setLoadError(null);
    void (async () => {
      try {
        const next = await xhsOpsApi.getAccount(accountId);
        if (cancelled) return;
        if (projectId && next.projectId !== projectId) {
          setLoadError("这个账号不属于当前项目");
          return;
        }
        setAccount(next);
        setDetailsReload((value) => value + 1);
        const nextProject = await xhsOpsApi
          .getProject(next.projectId)
          .catch(() => null);
        if (cancelled) return;
        setProject(nextProject);
      } catch (err) {
        if (cancelled) return;
        if (isTakeoverRecovering(err)) setRecovering(true);
        else setLoadError(describeXhsOpsError(err, "接管信息加载失败"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [accountId, projectId, reload, setAccount]);

  // The audits, change orders and diagnosis, read on their own so a 503 or a
  // failure here never holds back the account above.
  useEffect(() => {
    if (detailsReload === 0) return;
    const owner = accountRef.current;
    if (!owner) return;
    let cancelled = false;
    void (async () => {
      try {
        const details = await loadDetails(owner);
        if (cancelled) return;
        // Whatever is still on its way gets announced once it settles.
        for (const audit of details.audits)
          if (audit.status === "running") track(audit.id);
        if (details.diagnosis?.status === "generating")
          track(details.diagnosis.id);
        for (const order of details.orders)
          if (changeOrderAwaitingFinish(order)) track(order.id);
        if (!applyDetails(details)) return;
        setDetailsReady(true);
        setDetailsError(null);
        setRecovering(false);
      } catch (err) {
        if (cancelled) return;
        // Right after a controller restart the change-order reads answer 503
        // until its recovery settled: wait and read again, not an error.
        if (isTakeoverRecovering(err)) setRecovering(true);
        else setDetailsError(describeXhsOpsError(err, "接管信息加载失败"));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [detailsReload, loadDetails, applyDetails, track]);

  // While the recovery runs, re-read every few seconds (each read that is
  // still answered 503 schedules the next one): the lists once the account
  // is in, else the account.
  useEffect(() => {
    void reload;
    void detailsReload;
    if (!recovering) return;
    const timer = setTimeout(() => {
      if (accountRef.current) setDetailsReload((value) => value + 1);
      else setReload((value) => value + 1);
    }, RECOVERY_RETRY_MS);
    return () => clearTimeout(timer);
  }, [recovering, reload, detailsReload]);

  useEffect(() => {
    let cancelled = false;
    xhsOpsApi
      .getPlaybook()
      .then((result) => {
        if (cancelled) return;
        setPlaybook(result.rules);
        setPlaybookBundle(result.bundleVersion);
      })
      .catch(() => {
        // Chips still resolve from the diagnosis' own rule snapshot.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await xhsOpsApi.getAccount(accountId);
      // The revision first: the next write sends it back as
      // expectedUpdatedAt even if a detail read below fails.
      setAccount(next);
      const details = await loadDetails(next);
      applyDetails(details);
      setPollError(null);
    } catch (err) {
      if (isTakeoverRecovering(err)) setRecovering(true);
      else setPollError(describeXhsOpsError(err, "接管信息刷新失败"));
    }
  }, [accountId, loadDetails, applyDetails, setAccount]);

  // ── Poll whatever runs in the background: an audit, a generation, a phone step ──
  // The account names its running audit (takeover.activeAuditId), one this
  // card's list has not caught up with included; until the account says
  // none runs, its next write would carry a stale updatedAt.
  const runningAuditId =
    account?.takeover?.activeAuditId ??
    audits.find((audit) => audit.status === "running")?.id ??
    "";
  const generatingId = diagnosis?.status === "generating" ? diagnosis.id : "";
  const inFlightKey = orders
    .filter(changeOrderInFlight)
    .map((order) => order.id)
    .join(",");
  const pollKey = [runningAuditId, generatingId, inFlightKey].join("|");
  useEffect(() => {
    if (pollKey === "||") return;
    let cancelled = false;
    let ticking = false;
    const tick = async () => {
      // A slow round must not overlap the next one.
      if (ticking) return;
      ticking = true;
      try {
        let settled = false;
        const runningId =
          accountRef.current?.takeover?.activeAuditId ??
          auditsRef.current.find((audit) => audit.status === "running")?.id;
        if (runningId) {
          const next = await xhsOpsApi.getAudit(runningId);
          if (cancelled) return;
          upsertAudit(next);
          if (next.status !== "running") {
            settled = true;
            // GET audits carries no event: build T3's non-baseline one here,
            // for an audit this card saw running that can become the baseline.
            const owner = accountRef.current;
            if (
              owner &&
              trackedRef.current.has(next.id) &&
              next.trigger !== "observation" &&
              (next.status === "completed" || next.status === "partial")
            )
              forward(
                xhsOpsAccountAuditedEvent({
                  account: owner,
                  audit: next,
                  baseline: false,
                }),
              );
          }
        }
        const current = diagnosisRef.current;
        if (current?.status === "generating") {
          const view = await xhsOpsApi.getDiagnosis(current.id);
          if (cancelled) return;
          setDiagnosis(view.diagnosis);
          if (view.diagnosis.status !== "generating") {
            settled = true;
            if (trackedRef.current.has(view.diagnosis.id)) forward(view.event);
          }
        }
        for (const order of ordersRef.current.filter(changeOrderInFlight)) {
          const view = await xhsOpsApi.getChangeOrder(order.id);
          if (cancelled) return;
          upsertOrder(view.order);
          if (
            view.order.status !== order.status ||
            !changeOrderInFlight(view.order)
          )
            settled = true;
          if (trackedRef.current.has(view.order.id)) forward(view.event);
        }
        // The account moves with every background step (updatedAt included,
        // which the next write has to send back).
        const next = await xhsOpsApi.getAccount(accountId);
        if (cancelled) return;
        setAccount(next);
        if (settled) {
          const details = await loadDetails(next);
          if (cancelled) return;
          applyDetails(details);
        }
        setPollError(null);
      } catch (err) {
        if (cancelled) return;
        if (isTakeoverRecovering(err)) {
          setPollError(null);
          setRecovering(true);
        } else
          setPollError(describeXhsOpsError(err, "进度读取失败，继续重试…"));
      } finally {
        ticking = false;
      }
    };
    const timer = setInterval(() => {
      void tick();
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [
    pollKey,
    accountId,
    forward,
    loadDetails,
    applyDetails,
    setAccount,
    setDiagnosis,
    upsertAudit,
    upsertOrder,
  ]);

  // ── The comment box: a draft only pre-fills it, and never over the user's typing ──
  const [feedbackText, setFeedbackText] = useState(feedbackDraft);
  const [pendingDraft, setPendingDraft] = useState<string | null>(null);
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const feedbackTextRef = useRef(feedbackText);
  feedbackTextRef.current = feedbackText;
  /** What the card itself last put in the box. */
  const prefilledRef = useRef(feedbackDraft);
  const lastDraftRef = useRef(feedbackDraft);
  useEffect(() => {
    if (feedbackDraft === lastDraftRef.current) return;
    lastDraftRef.current = feedbackDraft;
    if (!feedbackDraft) return;
    const typed = feedbackTextRef.current;
    if (typed.trim() === "" || typed === prefilledRef.current) {
      prefilledRef.current = feedbackDraft;
      setFeedbackText(feedbackDraft);
      setPendingDraft(null);
    } else {
      setPendingDraft(feedbackDraft);
    }
  }, [feedbackDraft]);
  const feedback: TakeoverFeedback = {
    text: feedbackText,
    setText: setFeedbackText,
    pendingDraft,
    acceptPendingDraft: () => {
      if (pendingDraft === null) return;
      prefilledRef.current = pendingDraft;
      setFeedbackText(pendingDraft);
      setPendingDraft(null);
    },
    answers,
    setAnswer: (questionId, answer) =>
      setAnswers((current) => {
        const next = { ...current };
        if (answer === null) delete next[questionId];
        else next[questionId] = answer;
        return next;
      }),
    submitted: () => {
      prefilledRef.current = "";
      setFeedbackText("");
      setPendingDraft(null);
      setAnswers({});
    },
  };

  const recoveringNotice = recovering ? (
    <Notice tone="info" testId="takeover-recovering">
      {TAKEOVER_RECOVERING_HINT}
    </Notice>
  ) : null;

  if (!account) {
    return loadError ? (
      <div className="flex flex-col gap-2">
        <ErrorLine message={loadError} />
        <SecondaryButton onClick={() => setReload((value) => value + 1)}>
          重新加载
        </SecondaryButton>
      </div>
    ) : (
      <div className="flex flex-col gap-2">
        {recoveringNotice}
        <Skeleton rows={3} label="正在加载接管信息" />
      </div>
    );
  }
  if (account.entryMode !== "existing") {
    return (
      <EmptyState>
        「{account.label}
        」是新建账号，不走接管流程；它的资料与素材在账号资料卡片里准备。
      </EmptyState>
    );
  }

  const device = account.deviceId
    ? (devices.find((entry) => entry.deviceId === account.deviceId) ?? null)
    : null;
  const data: TakeoverData = {
    account,
    project,
    audits,
    diagnosis,
    orders,
    playbook,
    skillDocs: takeoverSkillDocsState(device, playbookBundle),
    now,
  };
  // The sections only ever hand these a write's result.
  const wrote = () => {
    writeSeqRef.current += 1;
  };
  const ops: TakeoverOps = {
    setAccount: (next) => {
      wrote();
      setAccount(next);
    },
    upsertAudit: (next) => {
      wrote();
      upsertAudit(next);
    },
    setDiagnosis: (next) => {
      wrote();
      setDiagnosis(next);
    },
    upsertOrder: (next) => {
      wrote();
      upsertOrder(next);
    },
    setOrders: (next) => {
      wrote();
      setOrders(next);
    },
    refresh,
    forward,
    track,
    focusEvidence: (row) =>
      setFocus((current) => ({ row, seq: (current?.seq ?? 0) + 1 })),
    onAction,
  };
  const stage = xhsOpsTakeoverStage(account, now);
  const step = takeoverStep(account, now);
  const shownAudit = displayedAudit(account, audits);
  const evidenceFocusable =
    shownAudit !== null && shownAudit.id === diagnosis?.auditId;
  const takeover = account.takeover;

  return (
    <div className="flex flex-col gap-3" data-takeover-account={account.id}>
      <TakeoverHeader data={data} ops={ops} stage={stage} />
      {detailsReady ? recoveringNotice : null}
      <ErrorLine message={pollError} />
      {detailsReady ? <ErrorLine message={detailsError} /> : null}
      <DevicePolicyNotice device={device} />
      <DeviceHoldBanner data={data} ops={ops} />
      <PauseBanner data={data} ops={ops} />
      {step >= 1 && project !== null && !project.profile?.confirmedAt ? (
        <Notice tone="warning">
          <span>
            目标用户画像还没确认：诊断要拿目标人群做对照，请先确认画像。
          </span>
          {onAction ? (
            <div>
              <SecondaryButton
                onClick={() =>
                  onAction("xhs_ops_profile_review_requested", {
                    projectId: account.projectId,
                    component: "XhsOpsProfileCard",
                  })
                }
              >
                去确认目标画像
              </SecondaryButton>
            </div>
          ) : null}
        </Notice>
      ) : null}
      {takeover?.legacyVerified && !takeover.planConfirmedAt ? (
        <Notice tone="info">
          这个号已按旧流程核验过：确认接管方案之前照常日常维护；建议补一次只读盘点并确认方案。
        </Notice>
      ) : null}
      {detailsReady ? (
        <>
          <AuthorizeSection data={data} ops={ops} />
          {step >= 1 ? <IdentitySection data={data} ops={ops} /> : null}
          {step >= 2 ? (
            <AuditSection
              data={data}
              ops={ops}
              audit={shownAudit}
              focus={focus}
              initiallyOpen={step === 2}
            />
          ) : null}
          {step >= 3 ? (
            <DiagnosisSection
              data={data}
              ops={ops}
              feedback={feedback}
              evidenceFocusable={evidenceFocusable}
            />
          ) : null}
          {step >= 4 &&
          diagnosis &&
          (diagnosis.status === "ready" || diagnosis.status === "confirmed") ? (
            <PlanSection
              data={data}
              ops={ops}
              feedback={feedback}
              evidenceFocusable={evidenceFocusable}
            />
          ) : null}
          {step >= 5 || orders.length > 0 ? (
            <ChangeOrdersSection data={data} ops={ops} />
          ) : null}
          <ObservationSection data={data} ops={ops} />
        </>
      ) : (
        <TakeoverDetailsPending
          recovering={recovering}
          error={detailsError}
          onRetry={() => setDetailsReload((value) => value + 1)}
        />
      )}
    </div>
  );
}

/** Where ①–⑦ go until the audits, change orders and diagnosis were read once. */
function TakeoverDetailsPending({
  recovering,
  error,
  onRetry,
}: {
  recovering: boolean;
  error: string | null;
  onRetry: () => void;
}) {
  if (recovering)
    return (
      <Notice tone="info" testId="takeover-details-recovering">
        <span className="flex items-center gap-2">
          <Spinner />
          {TAKEOVER_DETAILS_RECOVERING}
        </span>
        <span>盘点、诊断和变更单几秒后自动重新读取；暂停接管不受影响。</span>
      </Notice>
    );
  if (error)
    return (
      <div className="flex flex-col gap-2">
        <ErrorLine message={error} />
        <div>
          <SecondaryButton onClick={onRetry}>重新加载</SecondaryButton>
        </div>
      </div>
    );
  return <Skeleton rows={3} label="正在加载接管信息" />;
}

// ── Header and banners ──────────────────────────────────────────────────────

function TakeoverHeader({
  data,
  ops,
  stage,
}: TakeoverSectionProps & { stage: XhsOpsTakeoverStage | null }) {
  const { account } = data;
  const takeover = account.takeover;
  const { busy, error, run } = useTakeoverAction(ops.refresh);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState("");
  const canPause = Boolean(takeover?.authorizedAt) && !takeover?.safetyPause;

  const pause = () =>
    void run("pause", "暂停接管失败", async () => {
      ops.setAccount(await xhsOpsApi.pauseTakeover(account.id, reason.trim()));
      setOpen(false);
      setReason("");
    });

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="truncate text-[14px] font-semibold text-text-heading">
            {account.label}
          </span>
          <span className="text-[12px] text-text-secondary">
            {account.deviceName ?? account.deviceId ?? "未绑定设备"}
          </span>
          {stage ? (
            <StatusPill tone={takeoverStageTone(stage)}>
              {TAKEOVER_STAGE_LABEL[stage]}
            </StatusPill>
          ) : null}
        </div>
        {canPause ? (
          <SecondaryButton
            danger
            onClick={() => setOpen((value) => !value)}
            disabled={busy !== null}
          >
            暂停接管
          </SecondaryButton>
        ) : null}
      </div>
      {open && canPause ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-2.5">
          <Field label="暂停原因 *">
            <input
              className={inputClass}
              value={reason}
              maxLength={200}
              aria-label="暂停原因"
              placeholder="如：客户要求先停一下"
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
          <div className="flex items-center justify-end gap-2">
            <SecondaryButton onClick={() => setOpen(false)}>
              取消
            </SecondaryButton>
            <PrimaryButton
              onClick={pause}
              disabled={!reason.trim() || busy !== null}
            >
              确认暂停
            </PrimaryButton>
          </div>
          <HintLine>
            暂停后不派任何手机任务、不跑养号；恢复时会先跑一次只读身份闸门。
          </HintLine>
        </div>
      ) : null}
      <ErrorLine message={error} />
    </div>
  );
}

/**
 * The bound phone's devicePolicyMode (§5.2): audit or off and the controller
 * refuses every takeover task, so the card says so up front; not reported
 * yet (since the phone last connected) is unknown and blocks nothing.
 */
function DevicePolicyNotice({ device }: { device: XhsOpsDevice | null }) {
  const state = takeoverPolicyModeState(device);
  if (!state) return null;
  if (state.kind === "unknown")
    return (
      <Notice tone="info" testId="device-policy-unknown">
        {TAKEOVER_POLICY_MODE_UNKNOWN_NOTICE}
      </Notice>
    );
  return (
    <Notice tone="error" testId="device-policy-blocked">
      <span className="font-medium">
        这台手机不会执行接管任务：身份读取、盘点、资料修改和养号都会被桌面拒绝。
      </span>
      <span>{state.message}</span>
    </Notice>
  );
}

const PAUSE_HINT: Record<keyof typeof PAUSE_CODE_LABEL, string> = {
  rate_limited: "风控暂停有 48 小时冷却期；期满后填写原因才能恢复。",
  account_restricted: "风控暂停有 48 小时冷却期；期满后填写原因才能恢复。",
  login_required:
    "请账号本人在手机上登录原账号（桌面不会代为登录）；处理好后点「恢复」，会先跑一次只读身份闸门。",
  account_mismatch:
    "请账号本人在手机上切换回这个号；处理好后点「恢复」，会先跑一次只读身份闸门。",
  observation_failed:
    "恢复前只允许做回滚单和手动盘点；恢复要填写原因，并先跑一次只读身份闸门。",
  manual: "恢复时会先跑一次只读身份闸门，返回正常才恢复。",
};

/** safetyPause and 「恢复」 (§6.5). */
function PauseBanner({ data, ops }: TakeoverSectionProps) {
  const { account, now } = data;
  const pause = account.takeover?.safetyPause ?? null;
  const { busy, error, run } = useTakeoverAction(ops.refresh);
  const [reason, setReason] = useState("");
  const [gate, setGate] = useState<{
    result: XhsOpsTakeoverGateResult | null;
    at: number;
  } | null>(null);
  const [resumedAt, setResumedAt] = useState<number | null>(null);

  if (!pause) {
    return resumedAt ? (
      <Notice tone="info" testId="takeover-resumed">
        <span>
          已恢复接管
          {gate?.result?.status === "ready" ? "（身份闸门通过）" : ""}
          。建议先按沉寂档参数跑一段时间；要调整请在账号配置里确认后写入，系统不会自动降档。
        </span>
        <div>
          <SecondaryButton onClick={() => setResumedAt(null)}>
            知道了
          </SecondaryButton>
        </div>
      </Notice>
    ) : null;
  }

  const needsReason = XHS_TAKEOVER_RESUME_REASON_CODES.has(pause.code);
  const cooldownUntil = pause.resumableAfter
    ? Date.parse(pause.resumableAfter)
    : Number.NaN;
  const coolingDown = Number.isFinite(cooldownUntil) && cooldownUntil > now;
  const blockedByHold = Boolean(account.takeover?.deviceHold);
  // The gate's answer explains this pause, or the one the gate itself
  // recorded; a pause raised later starts clean (a minute of slack for the
  // controller's clock).
  const gateFailure =
    gate?.result &&
    gate.result.status !== "ready" &&
    Date.parse(pause.since) <= gate.at + 60_000
      ? gate.result
      : null;

  const resume = () =>
    void run("resume", "恢复接管失败", async () => {
      setGate(null);
      const result = await xhsOpsApi.resumeTakeover(account.id, {
        expectedUpdatedAt: account.updatedAt,
        ...(reason.trim() ? { reason: reason.trim() } : {}),
      });
      setGate({ result: result.gate, at: Date.now() });
      if (result.resumed) {
        setReason("");
        setResumedAt(Date.now());
      }
      ops.setAccount(result.account);
    });

  return (
    <Notice tone="error" testId="takeover-paused">
      <span className="font-medium">
        接管已暂停（{PAUSE_CODE_LABEL[pause.code]}）：{pause.reason}
      </span>
      <span>
        {formatDateTime(pause.since)} 起暂停
        {coolingDown
          ? `；冷却期到 ${formatDateTime(pause.resumableAfter)} 结束`
          : ""}
        。{PAUSE_HINT[pause.code]}
      </span>
      {gateFailure ? (
        <span data-testid="resume-gate-reason" className="font-medium">
          身份闸门没有通过，账号保持暂停：{gateFailure.reason}
        </span>
      ) : null}
      <Field label={needsReason ? "恢复原因 *" : "恢复原因（选填）"}>
        <textarea
          className={textareaClass}
          rows={2}
          maxLength={200}
          value={reason}
          aria-label="恢复原因"
          placeholder="如：已在手机上确认账号正常"
          onChange={(event) => setReason(event.target.value)}
        />
      </Field>
      <div className="flex items-center justify-end gap-2">
        <PrimaryButton
          onClick={resume}
          disabled={
            busy !== null ||
            coolingDown ||
            blockedByHold ||
            (needsReason && !reason.trim())
          }
        >
          {busy === "resume" ? <Spinner /> : null}
          恢复
        </PrimaryButton>
      </div>
      {busy === "resume" &&
      !(
        pause.code === "rate_limited" || pause.code === "account_restricted"
      ) ? (
        <HintLine>正在手机上跑只读身份闸门，约 1–2 分钟…</HintLine>
      ) : null}
      <ErrorLine message={error} />
    </Notice>
  );
}

/** deviceHold (§3.1 表二): a stop nobody confirmed, released only by a human. */
function DeviceHoldBanner({ data, ops }: TakeoverSectionProps) {
  const { account } = data;
  const hold = account.takeover?.deviceHold ?? null;
  const { busy, error, run } = useTakeoverAction(ops.refresh);
  const [confirmed, setConfirmed] = useState(false);
  if (!hold) return null;

  const release = () =>
    void run("release", "解除手机任务占用失败", async () => {
      ops.setAccount(
        await xhsOpsApi.releaseTakeoverDeviceHold(account.id, {
          expectedUpdatedAt: account.updatedAt,
          stoppedOnPhone: true,
        }),
      );
      setConfirmed(false);
      await ops.refresh();
    });

  return (
    <Notice tone="error" testId="device-hold">
      <span className="font-medium">
        手机上的任务停止未确认（{formatDateTime(hold.since)}，任务 {hold.taskId}
        ）
      </span>
      <span>
        在你确认之前，桌面不会再给这台手机派任何任务。请到手机上确认任务已结束（TabbyApp
        里没有正在执行的任务），再回来解除。
      </span>
      <CheckLine
        checked={confirmed}
        onChange={setConfirmed}
        disabled={busy !== null}
      >
        我已在手机上确认任务已结束
      </CheckLine>
      <div className="flex justify-end">
        <PrimaryButton onClick={release} disabled={!confirmed || busy !== null}>
          解除占用
        </PrimaryButton>
      </div>
      <ErrorLine message={error} />
    </Notice>
  );
}

// ── ① 授权 ──────────────────────────────────────────────────────────────────

function AuthorizeSection({ data, ops }: TakeoverSectionProps) {
  const { account } = data;
  const takeover = account.takeover;
  const { busy, error, run } = useTakeoverAction(ops.refresh);
  const [agreed, setAgreed] = useState(false);
  const [note, setNote] = useState("");

  if (takeover?.authorizedAt) {
    return (
      <TakeoverSection index="①" title="授权" testId="authorize">
        <HintLine>
          已授权 {formatDateTime(takeover.authorizedAt)}
          {takeover.authorizationNote ? ` · ${takeover.authorizationNote}` : ""}
          。这一行的账号模式已锁定为接管，不能切回新号流程。
        </HintLine>
      </TakeoverSection>
    );
  }

  const authorize = () =>
    void run("authorize", "授权接管失败", async () => {
      ops.setAccount(
        await xhsOpsApi.authorizeTakeover(account.id, {
          expectedUpdatedAt: account.updatedAt,
          ownershipConfirmed: true,
          ...(note.trim() ? { authorizationNote: note.trim() } : {}),
        }),
      );
      await ops.refresh();
    });

  return (
    <TakeoverSection index="①" title="授权" testId="authorize">
      <Notice tone="info">{TAKEOVER_READ_ONLY_EXPECTATION}</Notice>
      {xhsOpsLegacyExistingVerified(account) ? (
        <HintLine>
          这个号已按旧流程核验通过：授权后沿用旧核验记录，定时任务不会中断。
        </HintLine>
      ) : null}
      <CheckLine checked={agreed} onChange={setAgreed} disabled={busy !== null}>
        {TAKEOVER_AUTHORIZATION_STATEMENT}
      </CheckLine>
      <Field label="授权备注（选填）">
        <input
          className={inputClass}
          value={note}
          maxLength={200}
          aria-label="授权备注"
          placeholder="如：客户 A 的品牌号，运营交接于 10 月"
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      {!account.deviceId ? (
        <HintLine>请先在账号配置里给这一行绑定手机，再授权接管。</HintLine>
      ) : null}
      <div className="flex justify-end">
        <PrimaryButton
          onClick={authorize}
          disabled={!agreed || busy !== null || !account.deviceId}
        >
          {busy === "authorize" ? <Spinner /> : null}
          确认授权，开始接管
        </PrimaryButton>
      </div>
      <ErrorLine message={error} />
    </TakeoverSection>
  );
}

// ── ② 身份 ──────────────────────────────────────────────────────────────────

function IdentitySection({ data, ops }: TakeoverSectionProps) {
  const { account, now } = data;
  const takeover = account.takeover;
  const { busy, error, run } = useTakeoverAction(ops.refresh);
  const pending = takeover?.pendingIdentity ?? null;
  const [readReason, setReadReason] = useState<string | null>(null);
  const [unavailable, setUnavailable] = useState<string | null>(null);
  const [typed, setTyped] = useState(pending?.readAccountId ?? "");
  const [override, setOverride] = useState(false);
  const pendingTaskId = pending?.taskId ?? null;
  const pendingReadId = pending?.readAccountId ?? "";
  useEffect(() => {
    if (!pendingTaskId) return;
    setTyped(pendingReadId);
    setOverride(false);
  }, [pendingTaskId, pendingReadId]);

  const locked = Boolean(
    takeover?.identityConfirmedAt && account.platformAccountId.trim(),
  );
  if (locked && takeover) {
    return (
      <TakeoverSection index="②" title="身份" testId="identity">
        <div className="flex flex-wrap items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-col">
            <ValueRow label="小红书号">{account.platformAccountId}</ValueRow>
            <ValueRow label="锁定方式">
              {takeover.identitySource === "legacy"
                ? "沿用旧流程的核验记录"
                : "对照手机截图锁定"}
            </ValueRow>
            <ValueRow label="锁定时间">
              {formatDateTime(takeover.identityConfirmedAt)}
            </ValueRow>
          </div>
          {takeover.identityScreenshotUrl ? (
            <ZoomableImage
              src={takeover.identityScreenshotUrl}
              alt="锁定身份时的编辑主页截图"
              imgClassName="h-24 w-auto rounded-md border border-border"
            />
          ) : null}
        </div>
        <HintLine>
          小红书号或绑定的手机一旦变化，身份锁定、基线和方案都会失效，需要重新锁定。
        </HintLine>
      </TakeoverSection>
    );
  }

  const read = () =>
    void run("read", "读取手机当前账号失败", async () => {
      const result = await xhsOpsApi.readTakeoverIdentity(account.id);
      ops.setAccount(result.account);
      if (result.identity.status === "unavailable") {
        setUnavailable(result.identity.reason);
        setReadReason(null);
        return;
      }
      setUnavailable(null);
      setReadReason(result.identity.reason);
      setTyped(result.identity.accountId);
      setOverride(false);
    });

  const readAt = pending ? Date.parse(pending.readAt) : Number.NaN;
  const expired =
    Number.isFinite(readAt) && now - readAt > XHS_TAKEOVER_IDENTITY_READ_TTL_MS;
  const differs = pending !== null && typed.trim() !== pending.readAccountId;
  const confirm = () =>
    void run("confirm", "锁定小红书号失败", async () => {
      if (!pending) return;
      const result = await xhsOpsApi.confirmTakeoverIdentity(account.id, {
        identityTaskId: pending.taskId,
        platformAccountId: typed.trim(),
        ...(differs ? { overrideRead: true } : {}),
      });
      ops.setAccount(result.account);
      ops.forward(result.event, result.account.takeover?.identityConfirmedAt);
    });

  return (
    <TakeoverSection
      index="②"
      title="身份"
      testId="identity"
      hint="只读读取手机上当前登录的号，由你对照截图锁定"
    >
      <div className="flex flex-wrap items-center gap-2">
        <SecondaryButton
          onClick={read}
          disabled={busy !== null || !account.deviceId}
        >
          {busy === "read" ? <Spinner /> : null}
          {pending ? "重新读取" : "读取手机当前账号"}
        </SecondaryButton>
        {busy === "read" ? (
          <HintLine>
            手机正在打开编辑主页并截图，约 1–2 分钟，期间手机被占用…
          </HintLine>
        ) : null}
      </div>
      {unavailable ? <Notice tone="warning">{unavailable}</Notice> : null}
      {pending ? (
        <div
          data-testid="identity-pending"
          className="grid grid-cols-1 gap-3 sm:grid-cols-[auto_minmax(0,1fr)]"
        >
          {pending.screenshotUrl ? (
            <ZoomableImage
              src={pending.screenshotUrl}
              alt="手机上的小红书编辑主页"
              imgClassName="max-h-64 w-auto rounded-md border border-border"
            />
          ) : (
            <span className="text-[12px] text-text-secondary">没有截图</span>
          )}
          <div className="flex flex-col gap-2">
            <Field label="小红书号">
              <input
                className={inputClass}
                value={typed}
                maxLength={80}
                aria-label="小红书号"
                disabled={busy !== null}
                onChange={(event) => setTyped(event.target.value)}
              />
            </Field>
            <HintLine>
              {readReason ??
                (pending.readAccountId
                  ? "已读到手机上的小红书号并填入；请对照截图确认就是这个号，再点锁定"
                  : "没读出小红书号；请对照截图手动填写后锁定")}
            </HintLine>
            {expired ? (
              <Notice tone="warning">
                读取结果已超过 30 分钟，请重新读取。
              </Notice>
            ) : (
              <HintLine>
                读取结果在{" "}
                {formatDateTime(
                  new Date(
                    readAt + XHS_TAKEOVER_IDENTITY_READ_TTL_MS,
                  ).toISOString(),
                )}{" "}
                之前有效。
              </HintLine>
            )}
            {differs && typed.trim() ? (
              <Notice tone="warning" testId="identity-override">
                <span>
                  {pending.readAccountId
                    ? `你填写的小红书号与手机读到的「${pending.readAccountId}」不一致。`
                    : "手机没读出小红书号，你填写的值会以你核对的截图为准。"}
                </span>
                <CheckLine checked={override} onChange={setOverride}>
                  我已对照截图核对，以我填写的为准
                </CheckLine>
              </Notice>
            ) : null}
            <div className="flex justify-end">
              <PrimaryButton
                onClick={confirm}
                disabled={
                  busy !== null ||
                  expired ||
                  !typed.trim() ||
                  (differs && !override)
                }
              >
                {busy === "confirm" ? <Spinner /> : null}
                确认就是这个号，锁定
              </PrimaryButton>
            </div>
          </div>
        </div>
      ) : null}
      <ErrorLine message={error} />
    </TakeoverSection>
  );
}

// ── ③ 盘点 ──────────────────────────────────────────────────────────────────

function AuditSection({
  data,
  ops,
  audit,
  focus,
  initiallyOpen,
}: TakeoverSectionProps & {
  audit: XhsOpsAccountAudit | null;
  focus: { row: string; seq: number } | null;
  initiallyOpen: boolean;
}) {
  const { account, audits } = data;
  const takeover = account.takeover;
  const { busy, error, run } = useTakeoverAction(ops.refresh);
  const [open, setOpen] = useState(initiallyOpen);
  const [manualChecked, setManualChecked] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const auditId = audit?.id ?? null;
  useEffect(() => {
    void auditId;
    setManualChecked(false);
  }, [auditId]);

  // An evidence chip opens the results and scrolls its row into view.
  useEffect(() => {
    if (!focus) return;
    if (!open) {
      setOpen(true);
      return;
    }
    const rows =
      containerRef.current?.querySelectorAll<HTMLElement>(
        "[data-evidence-row]",
      ) ?? [];
    for (const row of rows) {
      if (row.dataset.evidenceRow === focus.row) {
        row.scrollIntoView?.({ block: "center", behavior: "smooth" });
        break;
      }
    }
  }, [focus, open]);

  // Any running audit holds the phone, an observation review included.
  const deviceBusy =
    Boolean(takeover?.activeAuditId) ||
    audits.some((entry) => entry.status === "running");
  const running = audit?.status === "running" ? audit : null;
  const isBaseline = audit !== null && audit.id === takeover?.baselineAuditId;
  const baselinable =
    audit !== null &&
    !isBaseline &&
    (audit.status === "completed" || audit.status === "partial") &&
    audit.id === takeover?.latestAuditId &&
    !audit.flags.includes("identityStale") &&
    audit.profile?.accountMatched === true;
  const manualFlags = audit ? xhsOpsAuditManualCheckFlags(audit.flags) : [];
  const needsManualCheck = manualFlags.length > 0 && !audit?.manualCheckAt;

  const start = () =>
    void run("start", "开始只读盘点失败", async () => {
      const started = await xhsOpsApi.startAudit(account.id, {});
      ops.track(started.id);
      ops.upsertAudit(started);
      setOpen(true);
      // Starting the audit moved the account (activeAuditId, updatedAt):
      // read it before any write sends expectedUpdatedAt again.
      await ops.refresh();
    });
  const cancel = () =>
    void run("cancel", "取消盘点失败", async () => {
      if (!running) return;
      ops.upsertAudit(await xhsOpsApi.cancelAudit(running.id));
      await ops.refresh();
    });
  const baseline = () =>
    void run("baseline", "设为基线失败", async () => {
      if (!audit) return;
      const result = await xhsOpsApi.confirmBaseline(
        audit.id,
        needsManualCheck ? { manualChecked: true } : {},
      );
      ops.setAccount(result.account);
      ops.upsertAudit(result.audit);
      ops.forward(result.event);
      await ops.refresh();
    });

  return (
    <TakeoverSection
      index="③"
      title="盘点"
      testId="audit"
      hint="只读：P0 资料存档与号码核对 → A 主页与笔记 → B 创作者数据"
    >
      {!takeover?.baselineAuditId ? (
        <HintLine>
          约 5–10
          分钟，期间手机被占用；只读，不改任何资料。今天还有待执行的养号或评论任务时需要先取消或等它结束。
        </HintLine>
      ) : null}
      <Notice tone="warning">{TAKEOVER_AUDIT_RESIDUAL_NOTICE}</Notice>
      <div className="flex flex-wrap items-center gap-2">
        {running ? (
          <SecondaryButton danger onClick={cancel} disabled={busy !== null}>
            {busy === "cancel" ? <Spinner /> : null}
            取消盘点
          </SecondaryButton>
        ) : audit === null ? (
          <PrimaryButton onClick={start} disabled={busy !== null || deviceBusy}>
            {busy === "start" ? <Spinner /> : null}
            开始只读盘点
          </PrimaryButton>
        ) : (
          <SecondaryButton
            onClick={start}
            disabled={busy !== null || deviceBusy}
          >
            {busy === "start" ? <Spinner /> : null}
            {baselinable ? "有误，重新盘点" : "重新盘点"}
          </SecondaryButton>
        )}
        {audit ? (
          <span className="text-[12px] text-text-secondary">
            {AUDIT_STATUS_LABEL[audit.status]} ·{" "}
            {formatDateTime(audit.startedAt)}
            {isBaseline ? " · 当前基线" : ""}
          </span>
        ) : null}
        {audit && !running ? (
          <button
            type="button"
            aria-expanded={open}
            className="ml-auto text-[12px] text-text-secondary hover:text-text-primary"
            onClick={() => setOpen((value) => !value)}
          >
            {open ? "收起结果" : "展开结果"}
          </button>
        ) : null}
      </div>
      {audit ? (
        <div className="flex flex-wrap gap-1.5" data-testid="audit-progress">
          {AUDIT_PARTS.map((part) => {
            const status = audit[part.key]?.status ?? "pending";
            const code = audit[part.key]?.code;
            return (
              <StatusPill key={part.key} tone={auditPartTone(status)}>
                {part.title} {AUDIT_PART_STATUS_LABEL[status]}
                {code && code !== "ok" ? ` · ${code}` : ""}
              </StatusPill>
            );
          })}
        </div>
      ) : null}
      {audit?.reason ? <HintLine>{audit.reason}</HintLine> : null}
      {audit && audit.flags.length > 0 ? (
        <Notice tone="warning" testId="audit-flags">
          {audit.flags.map((flag) => (
            <span key={flag}>{AUDIT_FLAG_LABEL[flag]}</span>
          ))}
          {audit.flags.includes("cancellationUnconfirmed") ? (
            <span>请到手机上确认任务已结束，再在卡片顶部解除占用。</span>
          ) : null}
        </Notice>
      ) : null}
      {audit && open ? (
        <div ref={containerRef}>
          <AuditResults
            audit={audit}
            identityScreenshotUrl={takeover?.identityScreenshotUrl ?? null}
            focusedRow={focus?.row ?? null}
          />
        </div>
      ) : null}
      {baselinable ? (
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-2.5">
          {needsManualCheck ? (
            <CheckLine
              checked={manualChecked}
              onChange={setManualChecked}
              disabled={busy !== null}
            >
              已人工检查：我已到手机上核对，没有误关注、误点或误改资料
            </CheckLine>
          ) : null}
          <div className="flex justify-end">
            <PrimaryButton
              onClick={baseline}
              disabled={busy !== null || (needsManualCheck && !manualChecked)}
            >
              {busy === "baseline" ? <Spinner /> : null}
              数据核对无误，设为基线
            </PrimaryButton>
          </div>
        </div>
      ) : null}
      <ErrorLine message={error} />
    </TakeoverSection>
  );
}

const HEADER_ROWS: Array<[keyof XhsOpsHeaderCounts, string]> = [
  ["following", "关注"],
  ["followers", "粉丝"],
  ["likesCollects", "获赞与收藏"],
];

function AuditResults({
  audit,
  identityScreenshotUrl,
  focusedRow,
}: {
  audit: XhsOpsAccountAudit;
  identityScreenshotUrl: string | null;
  focusedRow: string | null;
}) {
  const values = audit.profile?.values ?? null;
  const home = audit.home;
  const creator = audit.creator;
  const rowClass = (key: string) =>
    focusedRow === key
      ? "bg-[var(--color-warning-ink)]/[10%] ring-1 ring-[var(--color-warning-ink)]/[40%]"
      : "";
  const creatorUnavailable =
    audit.flags.includes("creatorUnavailable") ||
    creator?.status === "unavailable";
  return (
    <div className="flex flex-col gap-3" data-testid="audit-results">
      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-text-heading">
          资料现值（与锁定身份时的截图并排核对）
        </span>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="flex flex-col">
            {values ? (
              <>
                {(
                  [
                    ["nickname", "名字", values.nickname],
                    ["bio", "简介", values.bio],
                    ["occupation", "职业", values.occupation],
                    ["gender", "性别", values.gender],
                    [
                      "birthdayFilled",
                      "生日",
                      values.birthdayFilled ? "已填" : "未填",
                    ],
                    ["region", "地区", values.region],
                  ] as const
                ).map(([key, label, value]) => (
                  <ValueRow
                    key={key}
                    label={label}
                    rowKey={`profile.${key}`}
                    highlighted={focusedRow === `profile.${key}`}
                  >
                    {value || "（空）"}
                  </ValueRow>
                ))}
              </>
            ) : (
              <HintLine>
                {audit.profile?.accountMatched === false
                  ? "号码核对不一致，这次盘点的数据已丢弃。"
                  : "资料存档还没读到。"}
              </HintLine>
            )}
          </div>
          <div className="flex gap-2">
            {identityScreenshotUrl ? (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-text-secondary">
                  锁定身份时
                </span>
                <ZoomableImage
                  src={identityScreenshotUrl}
                  alt="锁定身份时的编辑主页截图"
                  imgClassName="h-28 w-auto rounded-md border border-border"
                />
              </div>
            ) : null}
            {audit.profile?.evidence?.screenshotUrl ? (
              <div className="flex flex-col gap-1">
                <span className="text-[11px] text-text-secondary">
                  本次盘点
                </span>
                <ZoomableImage
                  src={audit.profile.evidence.screenshotUrl}
                  alt="本次盘点的编辑主页截图"
                  imgClassName="h-28 w-auto rounded-md border border-border"
                />
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-text-heading">
          头部计数（页面原文 → 解析值）
        </span>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[28rem] border-collapse text-[12px]">
            <thead className="text-text-secondary">
              <tr>
                <th className="py-1 text-left font-normal">项</th>
                <th className="py-1 text-left font-normal">A 开头</th>
                <th className="py-1 text-left font-normal">A 结尾</th>
                <th className="py-1 text-left font-normal">B 进入「我」</th>
              </tr>
            </thead>
            <tbody>
              {HEADER_ROWS.map(([key, label]) => (
                <tr
                  key={key}
                  data-evidence-row={`header.${key}`}
                  className={`border-t border-border ${rowClass(`header.${key}`)}`}
                >
                  <td className="py-1">{label}</td>
                  <td className="py-1 text-text-secondary">
                    {countDisplay(home?.header?.[key])}
                  </td>
                  <td className="py-1 text-text-secondary">
                    {countDisplay(home?.headerEnd?.[key])}
                  </td>
                  <td className="py-1 text-text-secondary">
                    {countDisplay(creator?.header?.[key])}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="flex flex-col gap-1" data-evidence-row="notes">
        <span className="text-[12px] font-medium text-text-heading">
          前 {home?.notes.length ?? 0} 张笔记卡片
          {home ? (home.notesEnd ? "（已到底）" : "（没有到底）") : ""}
        </span>
        {home && home.notes.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[28rem] border-collapse text-[12px]">
              <thead className="text-text-secondary">
                <tr>
                  <th className="w-10 py-1 text-left font-normal">序号</th>
                  <th className="py-1 text-left font-normal">标题</th>
                  <th className="py-1 text-left font-normal">数字</th>
                  <th className="w-12 py-1 text-left font-normal">置顶</th>
                  <th className="w-12 py-1 text-left font-normal">视频</th>
                </tr>
              </thead>
              <tbody>
                {home.notes.map((note) => (
                  <tr
                    key={note.i}
                    data-evidence-row={`notes[${note.i}]`}
                    className={`border-t border-border ${rowClass(`notes[${note.i}]`)}`}
                  >
                    <td className="py-1 text-text-secondary">{note.i}</td>
                    <td className="py-1">{note.title || "（无标题）"}</td>
                    <td className="py-1 text-text-secondary">
                      {countDisplay(note.likes)}
                    </td>
                    <td className="py-1 text-text-secondary">
                      {note.pinned ? "置顶" : ""}
                    </td>
                    <td className="py-1 text-text-secondary">
                      {note.video ? "视频" : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <HintLine>{home ? "没有读到笔记卡片。" : "主页还没读到。"}</HintLine>
        )}
      </div>

      <div className="flex flex-col gap-1">
        <span className="text-[12px] font-medium text-text-heading">
          近 7 日数据{creator?.periodLabel ? `（${creator.periodLabel}）` : ""}
        </span>
        {creatorUnavailable ? (
          <HintLine>创作者数据不可用（新号或未开通属正常）。</HintLine>
        ) : null}
        {creator ? (
          <div className="flex flex-col">
            {(
              [
                ["views", "观看", creator.views],
                ["interactions", "互动", creator.interactions],
                ["newFollowers", "新增关注", creator.newFollowers],
                ["profileVisitors", "主页访客", creator.profileVisitors],
              ] as const
            ).map(([key, label, value]) => (
              <ValueRow
                key={key}
                label={label}
                rowKey={`creator.${key}`}
                highlighted={focusedRow === `creator.${key}`}
              >
                {countDisplay(value)}
              </ValueRow>
            ))}
            <ValueRow
              label="账号状态"
              rowKey="creator.accountStatus"
              highlighted={focusedRow === "creator.accountStatus"}
            >
              {creator.accountStatus || "（没有读到）"}
            </ValueRow>
          </div>
        ) : (
          <HintLine>创作者数据还没读到。</HintLine>
        )}
      </div>

      {AUDIT_PARTS.some(
        (part) => audit[part.key]?.evidence?.trusted === false,
      ) ? (
        <HintLine>
          有分段的点击对账不可信（回执缺失或点击数超出预期路径），请对照截图人工核对。
        </HintLine>
      ) : null}
    </div>
  );
}
