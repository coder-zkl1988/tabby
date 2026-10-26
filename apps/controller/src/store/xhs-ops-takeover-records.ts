import {
  XHS_TAKEOVER_CHANGE_BUDGET,
  XHS_TAKEOVER_DEVICE_HOLD_MESSAGE,
  XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE,
  XHS_TAKEOVER_RESUME_REASON_CODES,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsAccountDiagnosis,
  type XhsOpsChangeOrder,
  type XhsOpsChangeOrderStatus,
  type XhsOpsDiagnosisDecision,
  type XhsOpsDiagnosisProposal,
  type XhsOpsInterestPool,
  type XhsOpsMaturityTier,
  type XhsOpsProposal,
  type XhsOpsSafetyPause,
  type XhsOpsTakeover,
  type XhsOpsTakeoverProfileField,
  type xhsOpsAccountAuditSchema,
  type xhsOpsAccountDiagnosisSchema,
  xhsOpsBrowseDefaultsSchema,
  type xhsOpsChangeOrderSchema,
  xhsOpsInteractionConfigSchema,
  xhsOpsIsTakeoverImageField,
  xhsOpsProposalSchema,
  xhsOpsSameProfileText,
  xhsOpsTakeoverPlanIssues,
  xhsOpsToneGuideSchema,
} from "@nexu/shared";
import type { z } from "zod";
import {
  XhsOpsError,
  XhsOpsTakeoverParamError,
  localDateString,
} from "../lib/xhs-ops-common.js";

// Pure rules behind the takeover collections of XhsOpsStore (design
// docs/plans/2026-10-14-xhs-account-takeover-design.md §2.6, §5.1, §5.2, §6.5).
// The store owns the mutation queue; everything here only maps values.

const DAY_MS = 86_400_000;

/** Global audit cap (§2.6): ~5–6 KB each, so the worst case stays near 1.8 MB. */
export const XHS_OPS_MAX_AUDITS = 300;
/** Audits kept per account besides the protected ones (baseline, latest, running, today's). */
export const XHS_OPS_RECENT_AUDITS_PER_ACCOUNT = 12;
export const XHS_OPS_MAX_DIAGNOSES = 120;
/** Non-confirmed diagnoses kept per account; confirmed versions are always kept. */
export const XHS_OPS_DRAFT_DIAGNOSES_PER_ACCOUNT = 5;
/** Past this many, only terminal orders outside every budget window are dropped. */
export const XHS_OPS_MAX_CHANGE_ORDERS = 500;
/** The longest self-limit window (§8.1): an order older than this counts in no budget. */
export const XHS_TAKEOVER_LEDGER_WINDOW_MS =
  Math.max(
    ...Object.values(XHS_TAKEOVER_CHANGE_BUDGET).map(
      (budget) => budget.windowDays,
    ),
  ) * DAY_MS;
/** Cooldown of the risk-control pauses (§6.5). */
export const XHS_TAKEOVER_PAUSE_COOLDOWN_MS = 48 * 3_600_000;

/** Everything an audit carries except the store-assigned id/timestamps. */
export type XhsOpsAuditSeed = Omit<
  z.input<typeof xhsOpsAccountAuditSchema>,
  "id" | "createdAt" | "updatedAt"
>;
/** Everything a diagnosis carries except the store-assigned id/timestamps. */
export type XhsOpsDiagnosisSeed = Omit<
  z.input<typeof xhsOpsAccountDiagnosisSchema>,
  "id" | "createdAt" | "updatedAt"
>;
/** Everything a change order carries except the store-assigned id/timestamps. */
export type XhsOpsChangeOrderSeed = Omit<
  z.input<typeof xhsOpsChangeOrderSchema>,
  "id" | "createdAt" | "updatedAt"
>;

const TERMINAL_CHANGE_ORDER_STATUSES: ReadonlySet<XhsOpsChangeOrderStatus> =
  new Set(["completed", "failed", "cancelled"]);

/** Statuses `activeChangeOrderId` may point at (§5.2: prechecking … awaiting_manual_check, incl. interrupted). */
export const XHS_ACTIVE_CHANGE_ORDER_STATUSES: ReadonlySet<XhsOpsChangeOrderStatus> =
  new Set([
    "prechecking",
    "awaiting_confirm",
    "applying",
    "verifying",
    "awaiting_visual_check",
    "awaiting_manual_check",
    "interrupted",
  ]);

/** Statuses with a phone task in flight. */
export const XHS_DEVICE_TASK_CHANGE_ORDER_STATUSES: ReadonlySet<XhsOpsChangeOrderStatus> =
  new Set(["prechecking", "applying", "verifying"]);

/** An order in one of these makes plan revert / re-confirm answer 409 (§5.2 step 9). */
export const XHS_PLAN_LOCKING_CHANGE_ORDER_STATUSES: ReadonlySet<XhsOpsChangeOrderStatus> =
  new Set([
    "prechecking",
    "applying",
    "verifying",
    "awaiting_visual_check",
    "awaiting_manual_check",
  ]);

/** Newest first; equal createdAt keeps the later insertion first. */
export function newestFirst<T extends { createdAt: string }>(
  records: readonly T[],
): T[] {
  return [...records]
    .reverse()
    .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
}

function dropOldest<T extends { id: string; createdAt: string }>(
  records: T[],
  cap: number,
  isProtected: (record: T) => boolean,
): T[] | null {
  let kept = records;
  while (kept.length > cap) {
    const victim = [...kept]
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .find((record) => !isProtected(record));
    if (!victim) return null;
    kept = kept.filter((record) => record.id !== victim.id);
  }
  return kept;
}

/**
 * Audit retention (§2.6): per account the baseline plus the latest 12, then a
 * global cap of 300 dropping the oldest. Baselines, each account's latest
 * audit (the diagnosis anchor), running audits and today's are never dropped.
 */
export function evictAudits(
  audits: readonly XhsOpsAccountAudit[],
  accounts: readonly XhsOpsAccount[],
  now: string,
): XhsOpsAccountAudit[] {
  const today = localDateString(new Date(now));
  const pinned = new Set<string>();
  for (const account of accounts) {
    if (account.takeover?.baselineAuditId)
      pinned.add(account.takeover.baselineAuditId);
    if (account.takeover?.latestAuditId)
      pinned.add(account.takeover.latestAuditId);
  }
  const isProtected = (audit: XhsOpsAccountAudit) =>
    audit.status === "running" ||
    pinned.has(audit.id) ||
    localDateString(new Date(audit.createdAt)) === today ||
    localDateString(new Date(audit.updatedAt)) === today;
  const seen = new Map<string, number>();
  const keep = new Set<string>();
  for (const audit of newestFirst(audits)) {
    const count = seen.get(audit.accountId) ?? 0;
    seen.set(audit.accountId, count + 1);
    if (count < XHS_OPS_RECENT_AUDITS_PER_ACCOUNT || isProtected(audit))
      keep.add(audit.id);
  }
  const kept = dropOldest(
    audits.filter((audit) => keep.has(audit.id)),
    XHS_OPS_MAX_AUDITS,
    isProtected,
  );
  if (!kept)
    throw new XhsOpsError(
      409,
      "盘点记录已达上限，基线、当天和进行中的盘点不能自动清理",
    );
  return kept;
}

/**
 * Diagnosis retention (§2.6): every confirmed version plus each account's 5
 * newest other versions, then a global cap of 120. Confirmed, generating and
 * active diagnoses are never dropped.
 */
export function evictDiagnoses(
  diagnoses: readonly XhsOpsAccountDiagnosis[],
  accounts: readonly XhsOpsAccount[],
): XhsOpsAccountDiagnosis[] {
  const active = new Set(
    accounts
      .map((account) => account.takeover?.activeDiagnosisId)
      .filter((id): id is string => Boolean(id)),
  );
  const isProtected = (diagnosis: XhsOpsAccountDiagnosis) =>
    diagnosis.status === "confirmed" ||
    diagnosis.status === "generating" ||
    active.has(diagnosis.id);
  const drafts = new Map<string, number>();
  const keep = new Set<string>();
  for (const diagnosis of newestFirst(diagnoses)) {
    if (diagnosis.status === "confirmed") {
      keep.add(diagnosis.id);
      continue;
    }
    const count = drafts.get(diagnosis.accountId) ?? 0;
    drafts.set(diagnosis.accountId, count + 1);
    if (count < XHS_OPS_DRAFT_DIAGNOSES_PER_ACCOUNT || isProtected(diagnosis))
      keep.add(diagnosis.id);
  }
  const kept = dropOldest(
    diagnoses.filter((diagnosis) => keep.has(diagnosis.id)),
    XHS_OPS_MAX_DIAGNOSES,
    isProtected,
  );
  if (!kept)
    throw new XhsOpsError(
      409,
      "诊断记录已达上限，已确认和生成中的诊断不能自动清理",
    );
  return kept;
}

/**
 * A diagnosis generation settled (§2.3): `settled` is the new version at
 * ready or failed. The version it replaces stays ready — and confirmable —
 * until then, so only a ready result supersedes the account's other ready
 * versions. A failed one hands activeDiagnosisId back to the version it was
 * to replace — its parent, else the newest ready version on the same audit —
 * while the account still points at the failed one. Returns the account and
 * every diagnosis that changed, unstamped.
 */
export function settleDiagnosisGeneration(
  account: XhsOpsAccount,
  diagnoses: readonly XhsOpsAccountDiagnosis[],
  settled: XhsOpsAccountDiagnosis,
): { account: XhsOpsAccount; superseded: XhsOpsAccountDiagnosis[] } {
  const takeover = account.takeover;
  const others = diagnoses.filter(
    (entry) => entry.accountId === account.id && entry.id !== settled.id,
  );
  if (settled.status === "ready")
    return {
      account,
      superseded: others
        .filter((entry) => entry.status === "ready")
        .map((entry) => ({ ...entry, status: "superseded" as const })),
    };
  if (
    settled.status !== "failed" ||
    !takeover ||
    takeover.activeDiagnosisId !== settled.id
  )
    return { account, superseded: [] };
  const ready = others.filter(
    (entry) => entry.status === "ready" && entry.auditId === settled.auditId,
  );
  const previous =
    ready.find((entry) => entry.id === settled.parentId) ??
    newestFirst(ready)[0] ??
    null;
  if (!previous) return { account, superseded: [] };
  return {
    account: {
      ...account,
      takeover: { ...takeover, activeDiagnosisId: previous.id },
    },
    superseded: [],
  };
}

/**
 * Change orders are the public-change audit trail and the budget ledger
 * (§2.6): past 500, only terminal orders last touched outside every budget
 * window go, oldest first; everything else is kept even above the cap.
 */
export function evictChangeOrders(
  orders: readonly XhsOpsChangeOrder[],
  now: string,
): XhsOpsChangeOrder[] {
  const excess = orders.length - XHS_OPS_MAX_CHANGE_ORDERS;
  if (excess <= 0) return [...orders];
  const nowMs = Date.parse(now);
  const victims = new Set(
    orders
      .filter(
        (order) =>
          TERMINAL_CHANGE_ORDER_STATUSES.has(order.status) &&
          Date.parse(order.updatedAt) + XHS_TAKEOVER_LEDGER_WINDOW_MS <= nowMs,
      )
      .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      .slice(0, excess)
      .map((order) => order.id),
  );
  return orders.filter((order) => !victims.has(order.id));
}

/**
 * Only an identity change invalidates a takeover (§2.6, §5.2): a new 小红书号
 * or device clears the lock, the baseline and the plan, marks the account's
 * audits identityStale and settles its change orders by status — draft and
 * awaiting_confirm are cancelled, prechecking goes back to draft, applying and
 * verifying become interrupted (verified again after a new identity lock),
 * the awaiting_* manual steps stay as they are. The active diagnosis rests on
 * a now stale audit, so it stops being active and the stage restarts at
 * identity lock → baseline → diagnosis.
 */
export function invalidateTakeoverIdentity(
  account: XhsOpsAccount,
  collections: {
    audits: readonly XhsOpsAccountAudit[];
    changeOrders: readonly XhsOpsChangeOrder[];
  },
  stamp: (previousUpdatedAt: string) => string,
): {
  account: XhsOpsAccount;
  audits: XhsOpsAccountAudit[];
  changeOrders: XhsOpsChangeOrder[];
} {
  const takeover = account.takeover;
  if (!takeover)
    return {
      account,
      audits: [...collections.audits],
      changeOrders: [...collections.changeOrders],
    };
  let activeChangeOrderId = takeover.activeChangeOrderId;
  const changeOrders = collections.changeOrders.map((order) => {
    if (order.accountId !== account.id) return order;
    let next: XhsOpsChangeOrder | null = null;
    if (order.status === "draft" || order.status === "awaiting_confirm") {
      next = {
        ...order,
        status: "cancelled",
        precheck: null,
        error: "小红书号或设备已变化，单子已取消",
      };
    } else if (order.status === "prechecking") {
      next = { ...order, status: "draft", precheck: null };
    } else if (order.status === "applying" || order.status === "verifying") {
      next = {
        ...order,
        status: "interrupted",
        error: "小红书号或设备已变化，请重新锁定身份后补跑核验",
      };
    }
    if (!next) return order;
    if (
      activeChangeOrderId === order.id &&
      (next.status === "cancelled" || next.status === "draft")
    )
      activeChangeOrderId = null;
    return { ...next, updatedAt: stamp(order.updatedAt) };
  });
  const audits = collections.audits.map((audit) =>
    audit.accountId === account.id && !audit.flags.includes("identityStale")
      ? {
          ...audit,
          flags: [...audit.flags, "identityStale" as const],
          updatedAt: stamp(audit.updatedAt),
        }
      : audit,
  );
  const next: XhsOpsTakeover = {
    ...takeover,
    identityConfirmedAt: null,
    identitySource: null,
    identityTaskId: null,
    identityScreenshotUrl: null,
    pendingIdentity:
      takeover.pendingIdentity?.deviceId === account.deviceId
        ? takeover.pendingIdentity
        : null,
    baselineAuditId: null,
    activeDiagnosisId: null,
    planConfirmedAt: null,
    // What the plan could not draft went with the plan.
    skippedFields: [],
    // The old flow's verification belonged to the previous identity.
    legacyVerified: false,
    activeChangeOrderId,
  };
  return { account: { ...account, takeover: next }, audits, changeOrders };
}

/**
 * takeover.activeAuditId as the account's audits have it (§2.1): the id of
 * its running audit, null once none runs — so it is set when an audit
 * starts and cleared when it completes, fails, is cancelled or interrupted.
 * The same object comes back when nothing moves.
 */
export function withActiveAuditId(
  account: XhsOpsAccount,
  audits: readonly XhsOpsAccountAudit[],
): XhsOpsAccount {
  const takeover = account.takeover;
  if (!takeover) return account;
  const activeAuditId =
    audits.find(
      (audit) => audit.accountId === account.id && audit.status === "running",
    )?.id ?? null;
  if (takeover.activeAuditId === activeAuditId) return account;
  return { ...account, takeover: { ...takeover, activeAuditId } };
}

/** The parameter an issue's field path names, e.g. "interaction.like.dailyCap". */
function planParameter(account: XhsOpsAccount, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>(
      (value, key) => (isRecord(value) ? value[key] : undefined),
      account,
    );
}

/** A cap moved down and stays set: an accepted over-tier value made milder. */
function capLowered(before: unknown, after: unknown): boolean {
  return (
    typeof before === "number" &&
    typeof after === "number" &&
    after > 0 &&
    after < before
  );
}

/**
 * The takeover after a PATCH of a takeover account's interaction or
 * browseDefaults (§2.5, §6.3): the shared plan check runs again on the new
 * values. What the previous values already broke on the same field passes —
 * a hard limit the run refuses anyway, the same over-tier wording, or an
 * over-tier cap lowered but still set; a new hard issue is a 409; a new
 * over-tier issue needs `overrideReason` and is recorded in paramOverrides.
 * Either 409 is an XhsOpsTakeoverParamError carrying every new issue.
 */
export function recheckTakeoverParameters(
  previous: XhsOpsAccount,
  next: XhsOpsAccount,
  overrideReason: string | undefined,
  at: string,
): XhsOpsTakeover | null {
  const takeover = next.takeover;
  if (
    !takeover ||
    (JSON.stringify(previous.interaction) ===
      JSON.stringify(next.interaction) &&
      JSON.stringify(previous.browseDefaults) ===
        JSON.stringify(next.browseDefaults))
  )
    return takeover;
  const before = xhsOpsTakeoverPlanIssues(previous, takeover.maturity);
  const added = xhsOpsTakeoverPlanIssues(next, takeover.maturity).filter(
    (issue) =>
      !before.some(
        (old) =>
          old.field === issue.field &&
          (!issue.overridable ||
            old.message === issue.message ||
            capLowered(
              planParameter(previous, issue.field),
              planParameter(next, issue.field),
            )),
      ),
  );
  const hard = added.filter((issue) => !issue.overridable);
  if (hard.length > 0)
    throw new XhsOpsTakeoverParamError(
      "takeover_param_hard_limit",
      added,
      hard.map((issue) => issue.message).join("；"),
    );
  if (added.length === 0) return takeover;
  const reason = overrideReason?.trim();
  if (!reason)
    throw new XhsOpsTakeoverParamError(
      "takeover_override_reason_required",
      added,
      `${added.map((issue) => issue.message).join("；")}。超出接管档位的调整需要填写理由`,
    );
  return {
    ...takeover,
    paramOverrides: [
      ...takeover.paramOverrides,
      {
        at,
        reason: reason.slice(0, 200),
        fields: [...new Set(added.map((issue) => issue.field))].slice(0, 8),
      },
    ].slice(-20),
  };
}

// ─── Plan confirmation (§5.1) ───────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The proposal a decision adopts, or null when it was rejected, deferred or
 * never decided. An "edit" carries the proposal's own payload fields; they
 * are merged over the proposal and parsed again by kind, while id, kind, the
 * traceability fields (rationale, findings, evidence, rules) and what the
 * proposal is about (its profile field or note) stay the proposal's own — an
 * edit changes a value, never which field the code filtered and batched.
 */
export function resolveAdoptedProposal(
  proposal: XhsOpsDiagnosisProposal,
  decision: XhsOpsDiagnosisDecision | undefined,
): XhsOpsProposal | null {
  if (
    !decision ||
    decision.decision === "reject" ||
    decision.decision === "defer"
  )
    return null;
  if (decision.decision === "adopt")
    return xhsOpsProposalSchema.parse(proposal);
  if (!isRecord(decision.edited))
    throw new XhsOpsError(400, `${proposal.id} 选择了改后采纳，但没有修改内容`);
  const fixed: Record<string, unknown> = {
    id: proposal.id,
    kind: proposal.kind,
    rationale: proposal.rationale,
    findingIds: proposal.findingIds,
    evidence: proposal.evidence,
    ruleIds: proposal.ruleIds,
  };
  if (proposal.kind === "profileField" || proposal.kind === "keep")
    fixed.field = proposal.field;
  if (proposal.kind === "noteAction") fixed.noteIndex = proposal.noteIndex;
  const parsed = xhsOpsProposalSchema.safeParse({
    ...proposal,
    ...decision.edited,
    ...fixed,
  });
  if (!parsed.success)
    throw new XhsOpsError(400, `${proposal.id} 的修改内容不合法，请重新编辑`);
  return parsed.data;
}

/** The eight account fields a takeover plan owns, as in prePlanSnapshot. */
export type XhsOpsTakeoverPlanFields = Pick<
  XhsOpsAccount,
  | "label"
  | "positioning"
  | "persona"
  | "personaTags"
  | "interestPool"
  | "interaction"
  | "browseDefaults"
  | "toneGuide"
>;

export type XhsOpsTakeoverProfileChange = {
  proposalId: string;
  field: XhsOpsTakeoverProfileField;
  to: string;
};

export type XhsOpsTakeoverPlan = {
  fields: XhsOpsTakeoverPlanFields;
  maturity: XhsOpsMaturityTier;
  /** Adopted public profile changes; they only become change-order drafts. */
  profileChanges: XhsOpsTakeoverProfileChange[];
};

export function takeoverPlanFields(
  account: XhsOpsAccount,
): XhsOpsTakeoverPlanFields {
  return {
    label: account.label,
    positioning: account.positioning,
    persona: account.persona,
    personaTags: account.personaTags,
    interestPool: account.interestPool,
    interaction: account.interaction,
    browseDefaults: account.browseDefaults,
    toneGuide: account.toneGuide,
  };
}

/** Trimmed, non-empty and unique across the three layers, core first. */
function cleanInterestPool(pool: XhsOpsInterestPool): XhsOpsInterestPool {
  const seen = new Set<string>();
  const layer = (words: readonly string[]) =>
    words.flatMap((raw) => {
      const word = raw.trim();
      if (!word || seen.has(word)) return [];
      seen.add(word);
      return [word];
    });
  return {
    core: layer(pool.core),
    extended: layer(pool.extended),
    general: layer(pool.general),
  };
}

/**
 * What confirming `diagnosis` writes (§5.1 step 4): adopted positioning,
 * interest pool and tone guide over the current values, the code-computed
 * cadence, and the adopted profile fields for the change orders. Without an
 * adopted positioning, the inferred persona shown on the card fills only the
 * account's empty persona fields (§5.3 #8) — an operator's entries win.
 */
export function deriveTakeoverPlan(
  account: XhsOpsAccount,
  diagnosis: XhsOpsAccountDiagnosis,
  now: string,
): XhsOpsTakeoverPlan {
  const fields = takeoverPlanFields(account);
  const kinds = new Set<XhsOpsProposal["kind"]>();
  const profileFields = new Set<XhsOpsTakeoverProfileField>();
  const profileChanges: XhsOpsTakeoverProfileChange[] = [];
  const once = (kind: XhsOpsProposal["kind"], id: string) => {
    if (kinds.has(kind))
      throw new XhsOpsError(400, `${id}：同一类建议只能采纳一条`);
    kinds.add(kind);
  };
  for (const proposal of diagnosis.proposals) {
    const adopted = resolveAdoptedProposal(
      proposal,
      diagnosis.decisions[proposal.id],
    );
    if (!adopted) continue;
    switch (adopted.kind) {
      case "positioning":
        once(adopted.kind, adopted.id);
        fields.label = adopted.label;
        fields.positioning = adopted.positioning;
        fields.persona = adopted.persona;
        fields.personaTags = adopted.personaTags;
        break;
      case "interestPool":
        once(adopted.kind, adopted.id);
        fields.interestPool = cleanInterestPool(adopted);
        break;
      case "toneGuide":
        once(adopted.kind, adopted.id);
        fields.toneGuide = xhsOpsToneGuideSchema.parse({
          ...adopted.guide,
          ruleIds: adopted.ruleIds,
          sourceDiagnosisId: diagnosis.id,
          confirmedAt: now,
        });
        break;
      case "profileField":
        if (profileFields.has(adopted.field))
          throw new XhsOpsError(400, `${adopted.id}：同一字段只能采纳一条修改`);
        profileFields.add(adopted.field);
        profileChanges.push({
          proposalId: adopted.id,
          field: adopted.field,
          to: adopted.to.trim(),
        });
        break;
      case "noteAction":
      case "keep":
        // Shown to a human only; the system never acts on them.
        break;
    }
  }
  const inferred = diagnosis.inferredPersona?.persona;
  if (!kinds.has("positioning") && inferred) {
    const persona = { ...fields.persona };
    for (const key of Object.keys(persona) as Array<keyof typeof persona>) {
      if (!persona[key].trim() && inferred[key].trim())
        persona[key] = inferred[key];
    }
    fields.persona = persona;
  }
  fields.interaction = xhsOpsInteractionConfigSchema.parse(
    diagnosis.cadence.interaction,
  );
  fields.browseDefaults = xhsOpsBrowseDefaultsSchema.parse(
    diagnosis.cadence.browseDefaults,
  );
  return { fields, maturity: diagnosis.facts.tier, profileChanges };
}

/** Fixed field order inside the three batches (§5.2 step 1, MT-02). */
const CHANGE_ORDER_FIELD_ORDER: readonly XhsOpsTakeoverProfileField[] = [
  "bio",
  "occupation",
  "nickname",
  "region",
  "avatar",
  "cover",
];

export type XhsOpsTakeoverSkippedField = {
  proposalId: string;
  field: XhsOpsTakeoverProfileField;
  reason: string;
};

export type XhsOpsTakeoverTextField = Exclude<
  XhsOpsTakeoverProfileField,
  "avatar" | "cover"
>;

/**
 * What a text field should show on the phone now (§5.2 step 2): the after of
 * the newest order of this 小红书号 that dispatched an apply and whose field
 * is verified or done — whatever the order's status, so one that observed
 * and then failed, or an uncertain field a later readback settled to done,
 * still counts — else the baseline audit's value. Not an order's own
 * snapshot, so a second order on a field does not see the first as drift. A
 * baseline audit that read the phone after that order wins: re-baselining is
 * how a real drift gets resolved (§5.2 step 8).
 */
export function takeoverExpectedFieldValue(
  field: XhsOpsTakeoverTextField,
  account: Pick<XhsOpsAccount, "id" | "platformAccountId">,
  orders: readonly XhsOpsChangeOrder[],
  baseline: XhsOpsAccountAudit | null,
): string {
  const baselineAt = baseline?.startedAt ?? "";
  let newest: { at: string; value: string } | null = null;
  for (const order of orders) {
    if (
      order.accountId !== account.id ||
      order.platformAccountId !== account.platformAccountId ||
      !order.applyTaskId
    )
      continue;
    const entry = order.fields.find(
      (candidate) =>
        candidate.field === field &&
        (candidate.outcome === "verified" || candidate.outcome === "done"),
    );
    const at = order.confirmedAt ?? order.createdAt;
    if (entry && at >= baselineAt && (!newest || at > newest.at))
      newest = { at, value: entry.after };
  }
  return newest?.value ?? baseline?.profile?.values?.[field] ?? "";
}

/**
 * Change-order drafts for the adopted profile fields (§5.2 step 1): one order
 * per fixed batch — 简介+职业 → 昵称+地区 → 头像+背景图 — so never more than
 * two fields. Text fields carry the baseline value; a target the phone should
 * already show (takeoverExpectedFieldValue, e.g. after an earlier plan's
 * order) needs no order. Image fields keep baselineValue "" and need a phone
 * on Android 10+, which only the caller can tell (`imageFieldsSupported`;
 * `imageFieldsSkipReason` says why not when it is not the version, e.g. a
 * phone that could not be asked).
 */
export function draftTakeoverChangeOrders(input: {
  account: XhsOpsAccount;
  deviceId: string;
  diagnosisId: string;
  baseline: XhsOpsAccountAudit | null;
  /** Change orders on record, for what the phone should show now. */
  orders: readonly XhsOpsChangeOrder[];
  changes: readonly XhsOpsTakeoverProfileChange[];
  imageFieldsSupported: boolean;
  /** Skip reason of the image fields; defaults to the too-old-version message. */
  imageFieldsSkipReason?: string;
}): { seeds: XhsOpsChangeOrderSeed[]; skipped: XhsOpsTakeoverSkippedField[] } {
  const values = input.baseline?.profile?.values ?? null;
  const skipped: XhsOpsTakeoverSkippedField[] = [];
  const batches = new Map<
    number,
    Array<XhsOpsTakeoverProfileChange & { baselineValue: string }>
  >();
  const ordered = [...input.changes].sort(
    (left, right) =>
      CHANGE_ORDER_FIELD_ORDER.indexOf(left.field) -
      CHANGE_ORDER_FIELD_ORDER.indexOf(right.field),
  );
  for (const change of ordered) {
    let baselineValue = "";
    if (xhsOpsIsTakeoverImageField(change.field)) {
      if (!input.imageFieldsSupported) {
        skipped.push({
          proposalId: change.proposalId,
          field: change.field,
          reason:
            input.imageFieldsSkipReason ??
            XHS_TAKEOVER_IMAGE_UNSUPPORTED_MESSAGE,
        });
        continue;
      }
    } else {
      baselineValue = values?.[change.field] ?? "";
      const expected = takeoverExpectedFieldValue(
        change.field,
        input.account,
        input.orders,
        input.baseline,
      );
      if (xhsOpsSameProfileText(expected, change.to)) {
        skipped.push({
          proposalId: change.proposalId,
          field: change.field,
          reason: "手机上已是目标值",
        });
        continue;
      }
    }
    const { batch: batchIndex } = XHS_TAKEOVER_CHANGE_BUDGET[change.field];
    const batch = batches.get(batchIndex) ?? [];
    batch.push({ ...change, baselineValue });
    batches.set(batchIndex, batch);
  }
  const seeds = [...batches.entries()]
    .sort(([left], [right]) => left - right)
    .map(([batchIndex, changes]): XhsOpsChangeOrderSeed => {
      const first = changes[0];
      return {
        projectId: input.account.projectId,
        accountId: input.account.id,
        deviceId: input.deviceId,
        platformAccountId: input.account.platformAccountId,
        diagnosisId: input.diagnosisId,
        proposalIds: changes.map((change) => change.proposalId),
        batchIndex,
        risk: first ? XHS_TAKEOVER_CHANGE_BUDGET[first.field].risk : "L2",
        fields: changes.map((change) => ({
          field: change.field,
          baselineValue: change.baselineValue,
          after: change.to,
        })),
        status: "draft",
      };
    });
  return { seeds, skipped };
}

// ─── Safety pause (§6.5) ────────────────────────────────────────────────────

/** A weaker pause never masks a stronger one that is still in force. */
const PAUSE_PRIORITY: Record<XhsOpsSafetyPause["code"], number> = {
  manual: 0,
  login_required: 1,
  account_mismatch: 2,
  observation_failed: 3,
  account_restricted: 4,
  rate_limited: 4,
};

const COOLDOWN_PAUSE_CODES: ReadonlySet<XhsOpsSafetyPause["code"]> = new Set([
  "rate_limited",
  "account_restricted",
]);

export type XhsOpsTakeoverPauseInput = {
  code: XhsOpsSafetyPause["code"];
  reason: string;
  /** runId / auditId / changeOrderId that raised it. */
  sourceRef?: string;
};

/**
 * The pause after `input` is raised (§6.5): rate_limited and
 * account_restricted cool down for 48 hours, the others resume once a human
 * fixed the phone and the gate is ready. A new pause replaces a weaker or
 * equal one, a running cooldown is never shortened, and a weaker pause leaves
 * the stronger one in place.
 */
export function nextSafetyPause(
  current: XhsOpsSafetyPause | null,
  input: XhsOpsTakeoverPauseInput,
  now: string,
): XhsOpsSafetyPause {
  if (current && PAUSE_PRIORITY[input.code] < PAUSE_PRIORITY[current.code])
    return current;
  const cooldown = COOLDOWN_PAUSE_CODES.has(input.code)
    ? new Date(Date.parse(now) + XHS_TAKEOVER_PAUSE_COOLDOWN_MS).toISOString()
    : null;
  const resumableAfter =
    cooldown && current?.resumableAfter
      ? cooldown > current.resumableAfter
        ? cooldown
        : current.resumableAfter
      : (cooldown ?? current?.resumableAfter ?? null);
  return {
    code: input.code,
    reason: input.reason.trim().slice(0, 200) || "账号已暂停接管",
    sourceRef: (input.sourceRef ?? "").slice(0, 80),
    since: now,
    resumableAfter,
  };
}

/**
 * The takeover after `input` is raised (§6.5): nextSafetyPause decides the
 * pause in force. An observation_failed that ends up not in force — a
 * stronger pause already stood, or the stronger one replaced it — is kept in
 * pendingObservationFailure, so resuming that stronger pause raises it again
 * instead of losing the failed review (B6). The same object comes back when
 * nothing changes.
 */
export function raiseTakeoverPause(
  takeover: XhsOpsTakeover,
  input: XhsOpsTakeoverPauseInput,
  now: string,
): XhsOpsTakeover {
  const current = takeover.safetyPause;
  const safetyPause = nextSafetyPause(current, input, now);
  let pending = takeover.pendingObservationFailure;
  if (
    input.code === "observation_failed" &&
    safetyPause.code !== "observation_failed"
  )
    pending = {
      reason: input.reason.trim().slice(0, 200) || "观察期复查未通过",
      sourceRef: (input.sourceRef ?? "").slice(0, 80),
      since: now,
    };
  else if (
    current?.code === "observation_failed" &&
    safetyPause.code !== "observation_failed"
  )
    pending = {
      reason: current.reason,
      sourceRef: current.sourceRef,
      since: current.since,
    };
  if (safetyPause === current && pending === takeover.pendingObservationFailure)
    return takeover;
  return { ...takeover, safetyPause, pendingObservationFailure: pending };
}

/**
 * What 「恢复」 of the pause in force leaves behind (§6.5): nothing, or —
 * when that pause masked an observation failure — the failure raised again
 * as observation_failed, which needs its own 「恢复」 with a written reason
 * and the identity gate. Rollbacks of its order stay allowed meanwhile.
 */
export function takeoverAfterResume(
  takeover: Pick<XhsOpsTakeover, "safetyPause" | "pendingObservationFailure">,
): Pick<XhsOpsTakeover, "safetyPause" | "pendingObservationFailure"> {
  const pending = takeover.pendingObservationFailure;
  if (!pending || takeover.safetyPause?.code === "observation_failed")
    return { safetyPause: null, pendingObservationFailure: pending };
  return {
    safetyPause: {
      code: "observation_failed",
      reason: pending.reason,
      sourceRef: pending.sourceRef,
      since: pending.since,
      resumableAfter: null,
    },
    pendingObservationFailure: null,
  };
}

function formatLocalTime(iso: string): string {
  const date = new Date(iso);
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${localDateString(date)} ${hours}:${minutes}`;
}

/**
 * Why `takeover` cannot resume now, or null (§6.5): a held device first, then
 * the written reason the risk and observation codes need, then the cooldown.
 */
export function takeoverResumeIssue(
  takeover: XhsOpsTakeover,
  reason: string | undefined,
  now: string,
): string | null {
  const pause = takeover.safetyPause;
  if (!pause) return "账号没有暂停，无需恢复";
  if (takeover.deviceHold) return XHS_TAKEOVER_DEVICE_HOLD_MESSAGE;
  if (XHS_TAKEOVER_RESUME_REASON_CODES.has(pause.code) && !reason?.trim())
    return "恢复这类暂停需要填写原因";
  if (
    pause.resumableAfter &&
    Date.parse(pause.resumableAfter) > Date.parse(now)
  )
    return `冷却期未结束，请在 ${formatLocalTime(pause.resumableAfter)} 之后恢复`;
  return null;
}

/**
 * Whether resuming the pause in force must first see the identity gate
 * report ready: every code but the two cooldown ones — unless the resume only
 * raises a pending observation failure again (takeoverAfterResume), which
 * puts nothing back to work and so has nothing to gate yet.
 */
export function takeoverResumeNeedsGate(
  takeover: Pick<XhsOpsTakeover, "safetyPause" | "pendingObservationFailure">,
): boolean {
  const pause = takeover.safetyPause;
  if (!pause) return false;
  if (takeoverAfterResume(takeover).safetyPause) return false;
  return !COOLDOWN_PAUSE_CODES.has(pause.code);
}
