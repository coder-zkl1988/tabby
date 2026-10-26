import {
  XHS_PROFILE_FIELD_LABEL,
  XHS_TAKEOVER_TIER_LABEL,
  type XhsOpsAccount,
  type XhsOpsAccountAudit,
  type XhsOpsAccountDiagnosis,
  type XhsOpsAuditFlag,
  type XhsOpsChangeOrder,
  type XhsOpsChangeOrderField,
  type XhsOpsCount,
  type XhsOpsFinding,
  type XhsOpsMaturityTier,
  type XhsOpsProposal,
  type XhsOpsSafetyPause,
  type XhsOpsTakeover,
  type XhsOpsTakeoverProfileField,
  xhsOpsInterestWordCount,
} from "./schemas/xhs-ops.js";

// ─── 老号接管：给对话 agent 的事件（takeover design §1.2 T2–T6, D6）────────────
//
// The cards report these through onAction like every other xhs_ops_* event;
// the payloads are built here so the card and the controller agree on what
// may leave the desktop. The 小红书号, the birthday, the gender and the region
// never enter an event: they stay on the card. Untrusted page text (nickname,
// bio, note titles) goes through xhsOpsRedactContact first.

const CONTACT_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(?:https?:\/\/|www\.)[^\s，。；、]+/gi, "[链接]"],
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, "[邮箱]"],
  // A handle after its keyword. The keyword may be spaced out (微 信), carry
  // 号/号码/ID, and be followed by a colon or 是/为.
  [
    /(?<![A-Za-z])(?:微\s*信|威\s*信|薇\s*信|v\s*信|vx|wx|weixin|wechat(?:\s*id)?|qq|扣\s*扣|企鹅号|电\s*话|手\s*机|tel)\s*(?:号码|号|id)?\s*(?:[:：]|是|为)?\s*[A-Za-z0-9][-_A-Za-z0-9]{4,19}/gi,
    "[联系方式]",
  ],
  // A bare v only with its colon: 「v：xiaoming88」, never 「vlog」.
  [
    /(?<![A-Za-z0-9])v\s*[:：]\s*[A-Za-z0-9][-_A-Za-z0-9]{4,19}/gi,
    "[联系方式]",
  ],
  [/(?<!\d)(?:\+?86[-\s]?)?1[3-9]\d(?:[-\s]?\d){8}(?!\d)/g, "[电话]"],
  [/(?<!\d)\d{7,}(?!\d)/g, "[号码]"],
];

/** One character of the text: its NFKC form, which the patterns see, and the original. */
interface RedactPiece {
  norm: string;
  orig: string;
}

/**
 * Mask contact details in text read off the phone (D6, §4.2): links, mail
 * addresses, a WeChat/QQ/phone handle after its keyword, mainland mobile
 * numbers and any other run of seven or more digits. The patterns see each
 * character in its NFKC form, so full-width digits, letters and colons
 * (１３８１２３４５６７８, ｖｘ：…) are caught too, while everything outside a
 * mask comes back as it was given: text with nothing to mask is returned
 * unchanged, and callers test `redacted !== text` to tell.
 */
export function xhsOpsRedactContact(text: string): string {
  let pieces: RedactPiece[] = Array.from(text, (char) => ({
    norm: char.normalize("NFKC"),
    orig: char,
  }));
  let masked = false;
  for (const [pattern, mask] of CONTACT_PATTERNS) {
    const starts: number[] = [];
    let normalized = "";
    for (const piece of pieces) {
      starts.push(normalized.length);
      normalized += piece.norm;
    }
    const matches = [...normalized.matchAll(pattern)];
    if (matches.length === 0) continue;
    masked = true;
    const next: RedactPiece[] = [];
    let index = 0;
    const startOf = (at: number) => starts[at] ?? normalized.length;
    for (const match of matches) {
      const from = match.index;
      const to = from + match[0].length;
      // Characters before the match stay; every character it touches goes.
      while (
        index < pieces.length &&
        startOf(index) + (pieces[index]?.norm.length ?? 0) <= from
      ) {
        const piece = pieces[index];
        if (piece) next.push(piece);
        index += 1;
      }
      while (index < pieces.length && startOf(index) < to) index += 1;
      next.push({ norm: mask, orig: mask });
    }
    pieces = [...next, ...pieces.slice(index)];
  }
  return masked ? pieces.map((piece) => piece.orig).join("") : text;
}

export const XHS_OPS_TAKEOVER_IDENTITY_LOCKED_EVENT =
  "xhs_ops_takeover_identity_locked";
export const XHS_OPS_ACCOUNT_AUDITED_EVENT = "xhs_ops_account_audited";

export type XhsOpsTakeoverIdentityLockedEvent = {
  name: typeof XHS_OPS_TAKEOVER_IDENTITY_LOCKED_EVENT;
  payload: {
    projectId: string;
    accountId: string;
    accountLabel: string;
    deviceName: string | null;
    identitySource: XhsOpsTakeover["identitySource"];
    agentInstruction: string;
  };
};

/** T2: the identity is locked; deliberately without the 小红书号. */
export function xhsOpsTakeoverIdentityLockedEvent(
  account: Pick<
    XhsOpsAccount,
    "id" | "projectId" | "label" | "deviceName" | "takeover"
  >,
): XhsOpsTakeoverIdentityLockedEvent {
  return {
    name: XHS_OPS_TAKEOVER_IDENTITY_LOCKED_EVENT,
    payload: {
      projectId: account.projectId,
      accountId: account.id,
      accountLabel: account.label,
      deviceName: account.deviceName,
      identitySource: account.takeover?.identitySource ?? null,
      agentInstruction:
        "手机账号已由运营对照截图锁定；小红书号只在接管卡片上显示，不要复述或索要。告诉用户：接下来在卡片上开始一次约 5–10 分钟的只读盘点，期间手机被占用。盘点由用户在卡片上开始，不要自己派发手机任务，不要登录、退出或切换账号。",
    },
  };
}

/** A count as the page printed it, plus the parsed lower bound. */
export type XhsOpsAuditedCount = XhsOpsCount | null;

export type XhsOpsAccountAuditedEvent = {
  name: typeof XHS_OPS_ACCOUNT_AUDITED_EVENT;
  payload: {
    projectId: string;
    accountId: string;
    auditId: string;
    status: XhsOpsAccountAudit["status"];
    /** The audit was just confirmed as the takeover baseline. */
    baseline: boolean;
    /** Public profile fields only, contact details masked. */
    profile: { nickname: string; bio: string; occupation: string } | null;
    header: {
      following: XhsOpsAuditedCount;
      followers: XhsOpsAuditedCount;
      likesCollects: XhsOpsAuditedCount;
    };
    notes: Array<{
      i: number;
      title: string;
      likes: string | null;
      video: boolean;
      pinned: boolean;
    }>;
    notesEnd: boolean;
    /** 近 7 日 data card; null when it was not read (creatorUnavailable is normal for a small account). */
    creator: {
      periodLabel: string;
      views: string | null;
      interactions: string | null;
      newFollowers: string | null;
      profileVisitors: string | null;
      accountStatus: string;
    } | null;
    flags: XhsOpsAuditFlag[];
    agentInstruction: string;
  };
};

const READ_STATUSES: ReadonlySet<string> = new Set(["read", "partial"]);

/**
 * T4 (§1.2, D6): a public-field summary of one audit for the agent to explain
 * in plain words before the diagnosis. The profile archive's birthday, gender
 * and region, the expected 小红书号 and the device stay out.
 */
export function xhsOpsAccountAuditedEvent(input: {
  account: Pick<XhsOpsAccount, "id" | "projectId">;
  audit: XhsOpsAccountAudit;
  baseline: boolean;
}): XhsOpsAccountAuditedEvent {
  const { audit } = input;
  // The contact patterns only catch a 小红书号 of seven or more digits; a
  // custom one written into a bio, nickname or note title is masked by value.
  const secrets = diagnosisEventSecrets({
    platformAccountId: audit.platformAccountId,
  });
  const redact = (value: string) => diagnosisEventText(value, secrets);
  const values =
    audit.profile && READ_STATUSES.has(audit.profile.status)
      ? audit.profile.values
      : null;
  const home =
    audit.home && READ_STATUSES.has(audit.home.status) ? audit.home : null;
  const creator =
    audit.creator && READ_STATUSES.has(audit.creator.status)
      ? audit.creator
      : null;
  // A parsed count is digits and a unit; only unparseable page text could
  // carry anything else.
  const count = (value: XhsOpsCount | null): XhsOpsCount | null =>
    value && value.value === null
      ? { ...value, text: redact(value.text) }
      : value;
  const header = (key: "following" | "followers" | "likesCollects") =>
    count(
      home?.header?.[key] ??
        home?.headerEnd?.[key] ??
        creator?.header?.[key] ??
        null,
    );
  const text = (value: XhsOpsCount | null) => count(value)?.text ?? null;
  const flags = audit.flags.filter((flag) => flag !== "identityStale");
  return {
    name: XHS_OPS_ACCOUNT_AUDITED_EVENT,
    payload: {
      projectId: input.account.projectId,
      accountId: input.account.id,
      auditId: audit.id,
      status: audit.status,
      baseline: input.baseline,
      profile: values
        ? {
            nickname: redact(values.nickname),
            bio: redact(values.bio),
            occupation: redact(values.occupation),
          }
        : null,
      header: {
        following: header("following"),
        followers: header("followers"),
        likesCollects: header("likesCollects"),
      },
      notes: (home?.notes ?? []).map((note) => ({
        i: note.i,
        title: redact(note.title),
        likes: text(note.likes),
        video: note.video,
        pinned: note.pinned,
      })),
      notesEnd: home?.notesEnd ?? false,
      creator: creator
        ? {
            periodLabel: redact(creator.periodLabel),
            views: text(creator.views),
            interactions: text(creator.interactions),
            newFollowers: text(creator.newFollowers),
            profileVisitors: text(creator.profileVisitors),
            accountStatus: redact(creator.accountStatus),
          }
        : null,
      flags,
      agentInstruction: input.baseline
        ? "只读盘点已设为基线。只用本事件里的公开字段，用白话复述这个号的现状（粉丝与获赞收藏量级、前 20 篇的内容方向、置顶），再问 2–3 个经营取舍问题（例如现有昵称要不要保留、内容方向逐步加入还是整体转向）。用户回答后带 feedbackDraft 重新渲染 XhsOpsTakeover，由用户在卡片上点「按意见生成诊断」。不要复述生日、地区或小红书号，不要自己生成诊断或方案，不要派发手机任务，也不要改任何资料。"
        : "只读盘点已结束，还没有设为基线。请提醒用户在接管卡片上核对盘点结果，确认无误后设为基线；有告警时需要先到手机上人工检查。不要复述生日、地区或小红书号，不要派发手机任务。",
    },
  };
}

export const XHS_OPS_ACCOUNT_DIAGNOSED_EVENT = "xhs_ops_account_diagnosed";
export const XHS_OPS_TAKEOVER_PLAN_CONFIRMED_EVENT =
  "xhs_ops_takeover_plan_confirmed";

/** At most this many findings go to the agent (T5: 讲解最重要的 2–3 条结论). */
const DIAGNOSED_EVENT_MAX_FINDINGS = 3;

const SEVERITY_RANK: Record<XhsOpsFinding["severity"], number> = {
  high: 0,
  medium: 1,
  low: 2,
  info: 3,
};

/**
 * Diagnosis text for an event. The LLM never saw the 小红书号 (§4.2) and is
 * told to keep the region out of its text, but an event must not carry
 * either even so: the 小红书号 and the audit's region (as read, and its city)
 * are masked, contact details as everywhere.
 */
function diagnosisEventText(
  text: string,
  secrets: ReadonlyArray<{ value: string; mask: string }>,
): string {
  const unmasked = secrets.reduce(
    (current, secret) => current.split(secret.value).join(secret.mask),
    text,
  );
  return xhsOpsRedactContact(unmasked);
}

/**
 * What diagnosisEventText masks for one account, longest first so a city
 * inside its region goes last. The region also goes piece by piece — 「中国
 * 浙江 杭州」 written without its spaces, or a province on its own, is still
 * the region — except the country, which says nothing about the account.
 * `regions` are further region values masked the same way.
 */
function diagnosisEventSecrets(input: {
  platformAccountId: string;
  region?: { value: string; city: string } | null;
  regions?: readonly string[];
}): Array<{ value: string; mask: string }> {
  const id = input.platformAccountId.trim();
  const values = [input.region?.value ?? "", ...(input.regions ?? [])];
  const pieces = values
    .flatMap((value) => value.split(/\s+/))
    .filter((piece) => piece !== "中国");
  const region = [
    ...new Set(
      [
        ...values,
        ...values.map((value) => value.replace(/\s+/g, "")),
        input.region?.city ?? "",
        ...pieces,
      ]
        .map((entry) => entry.trim())
        .filter((entry) => entry.length >= 2),
    ),
  ].sort((left, right) => right.length - left.length);
  return [
    ...(id.length >= 3 ? [{ value: id, mask: "[小红书号]" }] : []),
    ...region.map((value) => ({ value, mask: "[地区]" })),
  ];
}

export type XhsOpsAccountDiagnosedEvent = {
  name: typeof XHS_OPS_ACCOUNT_DIAGNOSED_EVENT;
  payload: {
    projectId: string;
    accountId: string;
    diagnosisId: string;
    version: number;
    status: XhsOpsAccountDiagnosis["status"];
    /** Set when the generation failed: what the card shows. */
    error: string | null;
    tier: XhsOpsMaturityTier;
    tierLabel: string;
    summary: string;
    /** The inferred content line; the inferred age, gender and region stay on the card. */
    contentLine: string;
    /** Most severe first. */
    findings: Array<{
      id: string;
      dimension: XhsOpsFinding["dimension"];
      severity: XhsOpsFinding["severity"];
      summary: string;
    }>;
    /** Questions still open, for the agent to ask again in its own words. */
    questions: Array<{ id: string; text: string; options: string[] }>;
    /** What the card proposes, without any value: the agent neither restates nor adds proposals. */
    proposals: {
      total: number;
      kinds: XhsOpsProposal["kind"][];
      publicFields: XhsOpsTakeoverProfileField[];
    };
    dropped: number;
    agentInstruction: string;
  };
};

/**
 * T5 (§1.2, D6): a diagnosis that settled, for the agent to explain. Profile
 * values, the proposals' current and new values, the inferred persona's age,
 * gender and region and the 小红书号 stay on the card.
 */
export function xhsOpsAccountDiagnosedEvent(input: {
  account: Pick<XhsOpsAccount, "id" | "projectId" | "platformAccountId">;
  diagnosis: XhsOpsAccountDiagnosis;
  /**
   * The diagnosed audit's region as the phone showed it, and its city (the
   * form the LLM saw); both are masked in the free text. Omitted when the
   * audit read no region.
   */
  region?: { value: string; city: string } | null;
}): XhsOpsAccountDiagnosedEvent {
  const { account, diagnosis } = input;
  const secrets = diagnosisEventSecrets({
    platformAccountId: account.platformAccountId,
    region: input.region,
    // A region proposal's current and new values are the region too (D6),
    // and the LLM that wrote the proposal may name them in its text.
    regions: diagnosis.proposals.flatMap((entry) =>
      entry.kind === "profileField" && entry.field === "region"
        ? [entry.from, entry.to]
        : [],
    ),
  });
  const text = (value: string) => diagnosisEventText(value, secrets);
  const kinds = [...new Set(diagnosis.proposals.map((entry) => entry.kind))];
  const publicFields = diagnosis.proposals.flatMap((entry) =>
    entry.kind === "profileField" ? [entry.field] : [],
  );
  return {
    name: XHS_OPS_ACCOUNT_DIAGNOSED_EVENT,
    payload: {
      projectId: account.projectId,
      accountId: account.id,
      diagnosisId: diagnosis.id,
      version: diagnosis.version,
      status: diagnosis.status,
      error: diagnosis.error,
      tier: diagnosis.facts.tier,
      tierLabel: XHS_TAKEOVER_TIER_LABEL[diagnosis.facts.tier],
      summary: text(diagnosis.summary),
      contentLine: text(diagnosis.inferredPersona?.contentLine ?? ""),
      findings: [...diagnosis.findings]
        .sort(
          (left, right) =>
            SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity],
        )
        .slice(0, DIAGNOSED_EVENT_MAX_FINDINGS)
        .map((finding) => ({
          id: finding.id,
          dimension: finding.dimension,
          severity: finding.severity,
          summary: text(finding.summary),
        })),
      questions: diagnosis.questions
        .filter((question) => question.answer === null)
        .map((question) => ({
          id: question.id,
          text: text(question.text),
          options: question.options.map(text),
        })),
      proposals: {
        total: diagnosis.proposals.length,
        kinds,
        publicFields,
      },
      dropped: diagnosis.dropped.length,
      agentInstruction:
        diagnosis.status === "failed"
          ? "诊断这次没有生成成功（原因见 error）。请告诉用户在接管卡片上点「再生成方案」；不要自己生成诊断或方案，不要派发手机任务，也不要改任何资料。"
          : "诊断已生成，在接管卡片 ④ 上可以看到。只用本事件里的内容，用白话讲解最重要的 2–3 条结论，再把 questions 里的待决问题换个说法问一遍。用户回答后带 feedbackDraft 重新渲染 XhsOpsTakeover，由用户在卡片上逐项采纳并点「确认优化方案」。不要提出新的方案，不要复述资料的现值或建议的新值，不要复述生日、地区或小红书号，不要派发手机任务，也不要改任何资料。",
    },
  };
}

export type XhsOpsTakeoverPlanConfirmedEvent = {
  name: typeof XHS_OPS_TAKEOVER_PLAN_CONFIRMED_EVENT;
  payload: {
    projectId: string;
    accountId: string;
    diagnosisId: string;
    tier: XhsOpsMaturityTier | null;
    tierLabel: string;
    keepAllPublic: boolean;
    /** Internal (L0) items the operator adopted; now in force. */
    adopted: {
      positioning: boolean;
      interestPool: boolean;
      toneGuide: boolean;
    };
    interestWordCount: number;
    /** Public changes drafted as change orders, field names only; none has run. */
    changeOrders: Array<{
      id: string;
      batchIndex: number;
      risk: XhsOpsChangeOrder["risk"];
      fields: XhsOpsChangeOrder["fields"][number]["field"][];
    }>;
    publicFieldCount: number;
    /** Adopted public fields that did not become a draft. */
    skippedFields: Array<{ field: XhsOpsTakeoverProfileField; reason: string }>;
    agentInstruction: string;
  };
};

/**
 * T6 (§1.2, §5.1): the plan is confirmed. Internal settings are in force;
 * public changes are only drafts, each to be prechecked and confirmed on the
 * card. Field names only, never their values.
 */
export function xhsOpsTakeoverPlanConfirmedEvent(input: {
  account: Pick<
    XhsOpsAccount,
    "id" | "projectId" | "interestPool" | "takeover"
  >;
  diagnosis: XhsOpsAccountDiagnosis;
  changeOrders: readonly XhsOpsChangeOrder[];
  skippedFields: ReadonlyArray<{
    field: XhsOpsTakeoverProfileField;
    reason: string;
  }>;
}): XhsOpsTakeoverPlanConfirmedEvent {
  const { account, diagnosis } = input;
  const adoptedKinds = new Set(
    diagnosis.proposals.flatMap((proposal) => {
      const decision = diagnosis.decisions[proposal.id]?.decision;
      return decision === "adopt" || decision === "edit" ? [proposal.kind] : [];
    }),
  );
  const adopted = {
    positioning: adoptedKinds.has("positioning"),
    interestPool: adoptedKinds.has("interestPool"),
    toneGuide: adoptedKinds.has("toneGuide"),
  };
  const drafts = input.changeOrders
    .filter(
      (order) => order.diagnosisId === diagnosis.id && order.status === "draft",
    )
    .sort((left, right) => left.batchIndex - right.batchIndex)
    .map((order) => ({
      id: order.id,
      batchIndex: order.batchIndex,
      risk: order.risk,
      fields: order.fields.map((field) => field.field),
    }));
  const publicFieldCount = drafts.reduce(
    (sum, order) => sum + order.fields.length,
    0,
  );
  const tier = account.takeover?.maturity ?? null;
  const tierLabel = tier ? XHS_TAKEOVER_TIER_LABEL[tier] : "";
  const inForce = [
    tierLabel ? `养号参数（${tierLabel}）` : "养号参数",
    adopted.interestPool ? "兴趣池" : null,
    adopted.positioning ? "定位与人设" : null,
  ]
    .filter((entry): entry is string => entry !== null)
    .join("、");
  const steps = [
    `接管方案已由用户在卡片上确认。告诉用户：${inForce}已经生效，今天就能开始日常维护。`,
    adopted.toneGuide ? "调性指南是给人参考执行的，系统不会自动改帖子。" : null,
    publicFieldCount > 0
      ? `公开资料改动 ${publicFieldCount} 项稍后分批执行，每批都会先在卡片上预检并征求用户确认。`
      : "这次不改任何公开资料。",
    "然后渲染 XhsOpsRunPlanner。不要替用户预检或确认变更单，不要承诺生效时间，不要复述资料的现值或新值、生日、地区或小红书号，不要派发手机任务，也不要引导用户使用编辑器自带的发布按钮。",
  ].filter((entry): entry is string => entry !== null);
  return {
    name: XHS_OPS_TAKEOVER_PLAN_CONFIRMED_EVENT,
    payload: {
      projectId: account.projectId,
      accountId: account.id,
      diagnosisId: diagnosis.id,
      tier,
      tierLabel,
      keepAllPublic: account.takeover?.keepAllPublic ?? false,
      adopted,
      interestWordCount: xhsOpsInterestWordCount(account.interestPool),
      changeOrders: drafts,
      publicFieldCount,
      skippedFields: input.skippedFields.map((entry) => ({
        field: entry.field,
        reason: entry.reason,
      })),
      agentInstruction: steps.join(""),
    },
  };
}

export const XHS_OPS_CHANGE_ORDER_FINISHED_EVENT =
  "xhs_ops_change_order_finished";

type XhsOpsChangeOrderFinishedStatus = Extract<
  XhsOpsChangeOrder["status"],
  "observing" | "completed" | "failed" | "cancelled"
>;

/** The order is past its phone steps; anything earlier reports nothing yet. */
function changeOrderFinishedStatus(
  status: XhsOpsChangeOrder["status"],
): XhsOpsChangeOrderFinishedStatus | null {
  switch (status) {
    case "observing":
    case "completed":
    case "failed":
    case "cancelled":
      return status;
    default:
      return null;
  }
}

export type XhsOpsChangeOrderFinishedEvent = {
  name: typeof XHS_OPS_CHANGE_ORDER_FINISHED_EVENT;
  payload: {
    projectId: string;
    accountId: string;
    orderId: string;
    batchIndex: number;
    risk: XhsOpsChangeOrder["risk"];
    /** A rollback of an earlier order. */
    rollback: boolean;
    status: XhsOpsChangeOrderFinishedStatus;
    /** Field names and how each one ended; never a before, after or baseline value. */
    fields: Array<{
      field: XhsOpsChangeOrderField["field"];
      label: string;
      outcome: XhsOpsChangeOrderField["outcome"];
      /** PROFILE_JSON fieldCodes of a failed field, e.g. permission_required. */
      code: string | null;
    }>;
    /** End of the observation window (ISO); null when the order never reached one. */
    observationUntil: string | null;
    /** Observation review verdict; null before the order observed. */
    verdict: NonNullable<XhsOpsChangeOrder["observation"]>["verdict"] | null;
    /** Review notes: counts and field names only. */
    notes: string[];
    /** Why the order failed or was cancelled; contact details and the 小红书号 masked. */
    reason: string | null;
    /** Code of the takeover pause now in force; its wording stays on the card. */
    pauseCode: XhsOpsSafetyPause["code"] | null;
    agentInstruction: string;
  };
};

/**
 * T8 (§1.2, §5.2): a change order is past its phone steps — observing,
 * completed, failed or cancelled — for the agent to report the result and the
 * observation deadline, without retrying or changing a value. Field names,
 * outcomes and codes only: no before / after / baseline value, no 小红书号,
 * no birthday. null while the order is still on its way, and for an
 * observing order whose review started: that review reports as completed or
 * failed, so the observation is announced once.
 */
export function xhsOpsChangeOrderFinishedEvent(input: {
  order: XhsOpsChangeOrder;
  account: Pick<XhsOpsAccount, "takeover"> | null;
}): XhsOpsChangeOrderFinishedEvent | null {
  const { order } = input;
  const status = changeOrderFinishedStatus(order.status);
  if (!status) return null;
  if (status === "observing" && order.observation?.auditId) return null;
  const secrets = diagnosisEventSecrets({
    platformAccountId: order.platformAccountId,
  });
  const text = (value: string) => diagnosisEventText(value, secrets);
  const fields = order.fields.map((entry) => ({
    field: entry.field,
    label: XHS_PROFILE_FIELD_LABEL[entry.field],
    outcome: entry.outcome,
    code: entry.code,
  }));
  const verdict = order.observation?.verdict ?? null;
  const pauseCode = input.account?.takeover?.safetyPause?.code ?? null;
  const subject = `${
    order.rollbackOfId ? "回滚单" : `第 ${order.batchIndex} 批资料变更`
  }（${fields.map((entry) => entry.label).join("、")}）`;
  const guard =
    "不要重试或修改任何值，不要复述资料的新旧值、生日、地区或小红书号，不要替用户预检或确认变更单，也不要派发手机任务。";
  const instruction: Record<XhsOpsChangeOrderFinishedStatus, string> = {
    observing: `${subject}已在手机上执行完，各字段结果见 fields（verified 为已改成并核验，failed、skipped 为没有改成），现在进入观察期，到 observationUntil 结束（换成本地时间再说）。告诉用户本单结果和观察期截止时间；期满后由用户在接管卡片上点「复查」，观察期内不开下一批公开修改。${guard}`,
    completed: `${subject}观察期复查${verdict ? `结论为 ${verdict}` : "已结束"}，本单已完成。告诉用户结果${
      verdict === "warn"
        ? "，并提醒复查有 warn 提示（见 notes），下一批公开修改需要用户在卡片上额外确认"
        : ""
    }。${guard}`,
    failed: `${subject}没有成功，原因见 reason，各字段结果见 fields。告诉用户结果${
      pauseCode
        ? "，并说明账号已暂停接管，需要用户按卡片提示在手机上处理后，再在卡片上恢复"
        : ""
    }；如需回滚或重做，只能由用户在接管卡片上新建变更单并逐张预检、确认。${guard}`,
    cancelled: `${subject}已取消，手机上的资料没有因为这张单改动。告诉用户即可。${guard}`,
  };
  return {
    name: XHS_OPS_CHANGE_ORDER_FINISHED_EVENT,
    payload: {
      projectId: order.projectId,
      accountId: order.accountId,
      orderId: order.id,
      batchIndex: order.batchIndex,
      risk: order.risk,
      rollback: order.rollbackOfId !== null,
      status,
      fields,
      observationUntil: order.observation?.until ?? null,
      verdict,
      notes: (order.observation?.notes ?? []).map(text),
      reason: order.error ? text(order.error) : null,
      pauseCode,
      agentInstruction: instruction[status],
    },
  };
}
