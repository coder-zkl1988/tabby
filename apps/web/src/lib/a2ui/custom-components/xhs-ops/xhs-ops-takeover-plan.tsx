/**
 * Takeover card ④ 诊断 and ⑤ 方案 (T4–T6): generating the diagnosis from the
 * baseline audit with the user's comments, reading it, deciding proposal by
 * proposal, and confirming or reverting the plan.
 */
import {
  XHS_PROFILE_FIELD_LABEL,
  XHS_TAKEOVER_CHANGE_BUDGET,
  XHS_TAKEOVER_TIER_LABEL,
  type XhsOpsAccountDiagnosis,
  type XhsOpsDiagnosisDecision,
  type XhsOpsDiagnosisProposal,
  type XhsOpsProposal,
  xhsOpsProposalSchema,
  xhsOpsTonePillarKeywords,
} from "@nexu/shared";
import { useState } from "react";
import { xhsOpsApi } from "./xhs-ops-api";
import {
  CONFIDENCE_LABEL,
  DECISION_LABEL,
  DIMENSION_LABEL,
  NOTE_ACTION_LABEL,
  PLAN_GROUPS,
  RATING_LABEL,
  SEVERITY_LABEL,
  TAKEOVER_FEEDBACK_MAX,
  TAKEOVER_SKILL_BUNDLE_NOTICE,
  TAKEOVER_TONE_GUIDE_NOTICE,
  changeOrderAwaitingFinish,
  formatDateTime,
  hasUnknownRule,
  ratingTone,
  severityTone,
  takeoverSkillPhoneOlderNotice,
  takeoverSkillSyncNotice,
  toneGuideLines,
} from "./xhs-ops-takeover-model";
import {
  EvidenceChips,
  Notice,
  RuleChips,
  TakeoverFieldValueInput,
  TakeoverSection,
  type TakeoverSectionProps,
  ValueRow,
  useTakeoverAction,
} from "./xhs-ops-takeover-ui";
import { personaSummary } from "./xhs-ops-types";
import {
  ChipInput,
  ConfirmDialog,
  ErrorLine,
  Field,
  HintLine,
  PrimaryButton,
  SecondaryButton,
  Spinner,
  StatusPill,
  inputClass,
  selectClass,
  textareaClass,
} from "./xhs-ops-ui";

/**
 * The comment box shared by ④ and ⑤. `feedbackDraft` from the agent only
 * pre-fills it (T4); the text and the chosen question answers go out only
 * when the user clicks generate or regenerate.
 */
export type TakeoverFeedback = {
  text: string;
  setText: (text: string) => void;
  /** A newer draft from the conversation that the user's own edits kept out. */
  pendingDraft: string | null;
  acceptPendingDraft: () => void;
  answers: Record<string, string>;
  setAnswer: (questionId: string, answer: string | null) => void;
  /** Sent with a generate or regenerate: the box and the answers empty. */
  submitted: () => void;
};

type PlanSectionProps = TakeoverSectionProps & {
  feedback: TakeoverFeedback;
  /** The audit section shows the audit this diagnosis read. */
  evidenceFocusable: boolean;
};

/** Generate on the current baseline, or regenerate the active diagnosis. */
function useDiagnosisGeneration({
  data,
  ops,
  feedback,
}: Pick<PlanSectionProps, "data" | "ops" | "feedback">) {
  const { account, diagnosis } = data;
  const takeover = account.takeover;
  const baselineId = takeover?.baselineAuditId ?? null;
  const baselineIsLatest =
    baselineId !== null && baselineId === takeover?.latestAuditId;
  const regenerates =
    diagnosis !== null &&
    (diagnosis.status === "ready" || diagnosis.status === "failed") &&
    diagnosis.auditId === baselineId;
  const action = useTakeoverAction(ops.refresh);
  const submit = async () => {
    if (!baselineId || !baselineIsLatest) {
      action.setError("最近一次盘点还没设为基线，请先在 ③ 设为基线");
      return;
    }
    const text = feedback.text.trim().slice(0, TAKEOVER_FEEDBACK_MAX);
    const answers = Object.entries(feedback.answers)
      .filter(([, answer]) => answer.trim() !== "")
      .map(([id, answer]) => ({ id, answer }));
    const body = {
      ...(text ? { feedback: text } : {}),
      ...(answers.length > 0 ? { answers } : {}),
    };
    const next = await action.run("generate", "生成诊断失败", () =>
      regenerates && diagnosis
        ? xhsOpsApi.regenerateDiagnosis(diagnosis.id, body)
        : xhsOpsApi.generateDiagnosis(account.id, {
            auditId: baselineId,
            ...body,
          }),
    );
    if (!next) return;
    ops.track(next.id);
    ops.setDiagnosis(next);
    feedback.submitted();
    // activeDiagnosisId moved with the new version.
    await ops.refresh();
  };
  return { ...action, submit, baselineIsLatest };
}

function FeedbackBox({
  feedback,
  buttonLabel,
  busy,
  disabled,
  onSubmit,
}: {
  feedback: TakeoverFeedback;
  buttonLabel: string;
  busy: boolean;
  disabled: boolean;
  onSubmit: () => void;
}) {
  const answered = Object.values(feedback.answers).filter(
    (answer) => answer.trim() !== "",
  ).length;
  return (
    <div className="flex flex-col gap-2 rounded-md border border-border bg-surface-1 p-2.5">
      <Field label="来自对话的意见（未提交）">
        <textarea
          className={textareaClass}
          rows={3}
          maxLength={TAKEOVER_FEEDBACK_MAX}
          value={feedback.text}
          disabled={disabled}
          aria-label="来自对话的意见（未提交）"
          placeholder="你在对话里说的取舍会预填到这里；也可以直接写，如：昵称保留，护肤慢慢加进来"
          onChange={(event) => feedback.setText(event.target.value)}
        />
      </Field>
      {feedback.pendingDraft ? (
        <div className="flex flex-wrap items-center gap-2 text-[12px] text-text-secondary">
          <span>对话里有新的意见，没有覆盖你正在写的内容。</span>
          <SecondaryButton onClick={feedback.acceptPendingDraft}>
            用对话里的意见替换
          </SecondaryButton>
        </div>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <HintLine>
          {answered > 0 ? `已选 ${answered} 个待决问题的答案；` : ""}
          点按钮之前什么都不会提交。
        </HintLine>
        <PrimaryButton onClick={onSubmit} disabled={disabled || busy}>
          {busy ? <Spinner /> : null}
          {buttonLabel}
        </PrimaryButton>
      </div>
    </div>
  );
}

/** ④ 诊断 (T4–T5). */
export function DiagnosisSection({
  data,
  ops,
  feedback,
  evidenceFocusable,
}: PlanSectionProps) {
  const { account, diagnosis } = data;
  const planConfirmed = Boolean(account.takeover?.planConfirmedAt);
  const generation = useDiagnosisGeneration({ data, ops, feedback });
  // A ready diagnosis regenerates from ⑤, next to the decisions it carries over.
  const showBox =
    !planConfirmed && (diagnosis === null || diagnosis.status === "failed");

  return (
    <TakeoverSection
      index="④"
      title="诊断"
      testId="diagnosis"
      hint="由桌面生成：每条结论都引用盘点证据和经验库条目"
    >
      {diagnosis?.status === "generating" ? (
        <Notice tone="info" testId="diagnosis-generating">
          <span className="flex items-center gap-2">
            <Spinner />
            诊断生成中，约 1–2 分钟（超时会自动降级重试一次）…
          </span>
        </Notice>
      ) : null}
      {diagnosis?.status === "failed" ? (
        <Notice tone="error">
          {diagnosis.error ?? "诊断这次没有生成成功"}
        </Notice>
      ) : null}
      {data.skillDocs &&
      diagnosis &&
      diagnosis.status !== "generating" &&
      diagnosis.status !== "failed" ? (
        data.skillDocs.kind === "bundle_mismatch" ? (
          <Notice tone="info" testId="skill-docs-changed">
            <span>{TAKEOVER_SKILL_BUNDLE_NOTICE}</span>
            {data.skillDocs.phoneBundle < data.skillDocs.playbookBundle ? (
              <span data-testid="skill-docs-phone-older">
                {takeoverSkillPhoneOlderNotice(
                  data.skillDocs.phoneBundle,
                  data.skillDocs.playbookBundle,
                )}
              </span>
            ) : null}
          </Notice>
        ) : (
          <HintLine>
            <span data-testid="skill-docs-unsynced">
              {takeoverSkillSyncNotice(data.skillDocs.status)}
            </span>
          </HintLine>
        )
      ) : null}
      {diagnosis &&
      (diagnosis.status === "ready" ||
        diagnosis.status === "confirmed" ||
        diagnosis.status === "superseded") ? (
        <DiagnosisBody
          diagnosis={diagnosis}
          data={data}
          ops={ops}
          feedback={feedback}
          evidenceFocusable={evidenceFocusable}
        />
      ) : null}
      {showBox ? (
        <>
          {!generation.baselineIsLatest ? (
            <Notice tone="warning">
              最近一次盘点还没设为基线，请先在 ③ 核对后设为基线。
            </Notice>
          ) : null}
          <FeedbackBox
            feedback={feedback}
            buttonLabel={
              diagnosis?.status === "failed" ? "再生成方案" : "按意见生成诊断"
            }
            busy={generation.busy === "generate"}
            disabled={generation.busy !== null || !generation.baselineIsLatest}
            onSubmit={() => void generation.submit()}
          />
        </>
      ) : null}
      <ErrorLine message={generation.error} />
    </TakeoverSection>
  );
}

function DiagnosisBody({
  diagnosis,
  data,
  ops,
  feedback,
  evidenceFocusable,
}: PlanSectionProps & { diagnosis: XhsOpsAccountDiagnosis }) {
  const persona = diagnosis.inferredPersona;
  const answerable = diagnosis.status === "ready";
  return (
    <div className="flex flex-col gap-2.5">
      <HintLine>
        第 {diagnosis.version} 版 · 生成于 {formatDateTime(diagnosis.createdAt)}
        {diagnosis.status === "confirmed" ? " · 方案已确认" : ""}
        {diagnosis.generator.model ? ` · ${diagnosis.generator.model}` : ""}
      </HintLine>
      <div className="flex flex-col">
        <ValueRow label="账号阶段">
          {XHS_TAKEOVER_TIER_LABEL[diagnosis.facts.tier]}
          {diagnosis.facts.tierReasons.length > 0
            ? `（${diagnosis.facts.tierReasons.join("；")}）`
            : ""}
        </ValueRow>
        {diagnosis.summary ? (
          <ValueRow label="一句话现状">{diagnosis.summary}</ValueRow>
        ) : null}
        {persona ? (
          <ValueRow label="推断的现有人设">
            {[personaSummary(persona.persona), persona.contentLine]
              .filter(Boolean)
              .join(" · ")}
            （置信度 {CONFIDENCE_LABEL[persona.confidence]}）
          </ValueRow>
        ) : null}
      </div>
      {diagnosis.dimensions.length > 0 ? (
        <div className="flex flex-col gap-1">
          <span className="text-[12px] font-medium text-text-secondary">
            维度评分
          </span>
          <div className="flex flex-wrap gap-1.5">
            {diagnosis.dimensions.map((entry) => (
              <StatusPill
                key={entry.dimension}
                tone={ratingTone(entry.rating)}
                title={entry.note}
              >
                {DIMENSION_LABEL[entry.dimension] ?? entry.dimension}{" "}
                {RATING_LABEL[entry.rating]}
                {entry.note ? ` · ${entry.note}` : ""}
              </StatusPill>
            ))}
          </div>
        </div>
      ) : null}
      {diagnosis.findings.length > 0 ? (
        <div className="flex flex-col gap-1.5" data-testid="diagnosis-findings">
          <span className="text-[12px] font-medium text-text-secondary">
            问题清单
          </span>
          {diagnosis.findings.map((finding) => (
            <div
              key={finding.id}
              className="flex flex-col gap-1 rounded-md border border-border bg-surface-1 px-2.5 py-2"
            >
              <div className="flex flex-wrap items-center gap-2 text-[12px]">
                <StatusPill tone={severityTone(finding.severity)}>
                  {SEVERITY_LABEL[finding.severity]}
                </StatusPill>
                <span className="text-text-secondary">
                  {finding.id} · {DIMENSION_LABEL[finding.dimension]}
                </span>
                <span className="text-text-primary">{finding.summary}</span>
              </div>
              <EvidenceChips
                refs={finding.evidence}
                ops={ops}
                focusable={evidenceFocusable}
              />
              <RuleChips ruleIds={finding.ruleIds} data={data} />
            </div>
          ))}
        </div>
      ) : null}
      {diagnosis.questions.length > 0 ? (
        <div
          className="flex flex-col gap-1.5"
          data-testid="diagnosis-questions"
        >
          <span className="text-[12px] font-medium text-text-secondary">
            待决问题（选好后随「按意见重新生成」一起提交）
          </span>
          {diagnosis.questions.map((question) => {
            const chosen = feedback.answers[question.id] ?? null;
            return (
              <div
                key={question.id}
                className="flex flex-wrap items-center gap-1.5 text-[12px]"
              >
                <span className="text-text-primary">{question.text}</span>
                {question.answer ? (
                  <span className="text-text-secondary">
                    已答：{question.answer}
                  </span>
                ) : null}
                {question.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={chosen === option}
                    disabled={!answerable}
                    onClick={() =>
                      feedback.setAnswer(
                        question.id,
                        chosen === option ? null : option,
                      )
                    }
                    className={`rounded-full border px-2.5 py-0.5 text-[12px] ${
                      chosen === option
                        ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                        : "border-border-strong bg-surface-1 text-text-secondary hover:text-text-primary"
                    } disabled:opacity-50`}
                  >
                    {option}
                  </button>
                ))}
              </div>
            );
          })}
        </div>
      ) : null}
      {diagnosis.dropped.length > 0 ? (
        <details className="text-[12px] text-text-secondary">
          <summary className="cursor-pointer">
            被过滤的模型条目 {diagnosis.dropped.length}{" "}
            条（编号是模型输出里的编号，不是上面的条目）
          </summary>
          <ul className="mt-1 flex flex-col gap-0.5 pl-4">
            {diagnosis.dropped.map((entry, index) => (
              // Model ids may repeat, so the position is part of the key.
              <li key={`${entry.ref}-${index}`}>
                模型条目 {entry.ref}：{entry.reason}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      {diagnosis.feedback.length > 0 ? (
        <div className="flex flex-col gap-0.5 text-[12px] text-text-secondary">
          <span className="font-medium">已提交的意见</span>
          {diagnosis.feedback.map((entry) => (
            <span key={entry.at}>
              {formatDateTime(entry.at)}：{entry.text}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── ⑤ 方案 ──────────────────────────────────────────────────────────────────

type Decision = XhsOpsDiagnosisDecision["decision"];

/**
 * What an edit turns the proposal into, for display: the edit merged over
 * the proposal and parsed by kind, as the controller does before applying it.
 */
function effectiveProposal(
  proposal: XhsOpsDiagnosisProposal,
  decision: XhsOpsDiagnosisDecision | undefined,
): XhsOpsProposal {
  if (
    decision?.decision !== "edit" ||
    !decision.edited ||
    typeof decision.edited !== "object"
  )
    return proposal;
  const merged = xhsOpsProposalSchema.safeParse({
    ...proposal,
    ...decision.edited,
    id: proposal.id,
    kind: proposal.kind,
  });
  return merged.success ? merged.data : proposal;
}

function riskTags(proposal: XhsOpsDiagnosisProposal): string[] {
  switch (proposal.kind) {
    case "profileField":
      return [
        "公开",
        "不可撤销",
        ...(XHS_TAKEOVER_CHANGE_BUDGET[proposal.field].risk === "L2"
          ? ["平台次数"]
          : []),
      ];
    case "positioning":
    case "interestPool":
      return ["影响推荐"];
    case "noteAction":
      return proposal.action === "keep" ? [] : ["公开", "由你在手机上操作"];
    default:
      return [];
  }
}

function proposalTitle(proposal: XhsOpsProposal): string {
  switch (proposal.kind) {
    case "positioning":
      return "定位与人设";
    case "interestPool":
      return "兴趣池";
    case "toneGuide":
      return "调性指南";
    case "profileField":
      return XHS_PROFILE_FIELD_LABEL[proposal.field];
    case "noteAction":
      return `第 ${proposal.noteIndex} 篇笔记`;
    case "keep":
      return `保留${keepFieldLabel(proposal.field)}`;
  }
}

function keepFieldLabel(field: string): string {
  return field in XHS_PROFILE_FIELD_LABEL
    ? XHS_PROFILE_FIELD_LABEL[field as keyof typeof XHS_PROFILE_FIELD_LABEL]
    : field;
}

function listText(values: readonly string[]): string {
  return values.length > 0 ? values.join("、") : "（空）";
}

/** 现值 → 建议值 of one proposal. */
function ProposalValues({
  proposal,
  original,
  data,
  diagnosis,
}: {
  proposal: XhsOpsProposal;
  original: XhsOpsDiagnosisProposal;
  data: TakeoverSectionProps["data"];
  diagnosis: XhsOpsAccountDiagnosis;
}) {
  // Before the plan the account itself holds the current values; once it is
  // confirmed, the snapshot taken at confirmation does.
  const takeover = data.account.takeover;
  const current =
    takeover?.planConfirmedAt && takeover.prePlanSnapshot
      ? takeover.prePlanSnapshot
      : data.account;
  switch (proposal.kind) {
    case "positioning":
      return (
        <>
          <ValueRow label="现值">
            {current.label}
            {current.positioning ? ` · ${current.positioning}` : ""}
          </ValueRow>
          <ValueRow label="建议值">
            {proposal.label}
            {proposal.positioning ? ` · ${proposal.positioning}` : ""}
            {personaSummary(proposal.persona)
              ? `\n人设：${personaSummary(proposal.persona)}`
              : ""}
            {`\n档案标签：${listText([...proposal.personaTags.vertical, ...proposal.personaTags.general])}`}
          </ValueRow>
        </>
      );
    case "interestPool":
      return (
        <>
          <ValueRow label="现值">
            {`核心 ${listText(current.interestPool.core)}\n扩展 ${listText(current.interestPool.extended)}\n泛 ${listText(current.interestPool.general)}`}
          </ValueRow>
          <ValueRow label="建议值">
            {`核心 ${listText(proposal.core)}\n扩展 ${listText(proposal.extended)}\n泛 ${listText(proposal.general)}`}
          </ValueRow>
        </>
      );
    case "toneGuide":
      return (
        <>
          <ValueRow label="现值">
            {toneGuideLines(current.toneGuide).length > 0
              ? toneGuideLines(current.toneGuide)
                  .map((line) => `${line.label}：${line.value}`)
                  .join("\n")
              : "（还没有调性指南）"}
          </ValueRow>
          <ValueRow label="建议值">
            {toneGuideLines(proposal.guide)
              .map((line) => `${line.label}：${line.value}`)
              .join("\n")}
          </ValueRow>
        </>
      );
    case "profileField":
      return (
        <>
          <ValueRow label="现值">
            {proposal.field === "avatar" || proposal.field === "cover"
              ? "（图片，见手机）"
              : original.from || "（空）"}
          </ValueRow>
          <ValueRow label="建议值">
            {proposal.field === "avatar" || proposal.field === "cover"
              ? `图片方向：${proposal.to}（图片由你在变更单上提供）`
              : proposal.to}
          </ValueRow>
        </>
      );
    case "noteAction": {
      const audit = data.audits.find((entry) => entry.id === diagnosis.auditId);
      const note = audit?.home?.notes.find(
        (entry) => entry.i === proposal.noteIndex,
      );
      return (
        <>
          <ValueRow label="笔记">
            {note
              ? `${note.title}${note.pinned ? "（置顶）" : ""}${note.video ? "（视频）" : ""}`
              : `第 ${proposal.noteIndex} 篇`}
          </ValueRow>
          <ValueRow label="建议">{NOTE_ACTION_LABEL[proposal.action]}</ValueRow>
        </>
      );
    }
    case "keep":
      return (
        <ValueRow label="建议">
          保留{keepFieldLabel(proposal.field)}，不改
        </ValueRow>
      );
  }
}

type NoteAction = keyof typeof NOTE_ACTION_LABEL;
const NOTE_ACTIONS: readonly NoteAction[] = [
  "keep",
  "pin",
  "unpin",
  "consider_private",
];

/** 改后采纳: the editable part of each kind; `edited` is merged over the proposal. */
function ProposalEditor({
  proposal,
  busy,
  onSave,
  onCancel,
}: {
  proposal: XhsOpsProposal;
  busy: boolean;
  onSave: (edited: Record<string, unknown>) => void;
  onCancel: () => void;
}) {
  const [label, setLabel] = useState(
    proposal.kind === "positioning" ? proposal.label : "",
  );
  const [positioning, setPositioning] = useState(
    proposal.kind === "positioning" ? proposal.positioning : "",
  );
  const [core, setCore] = useState<string[]>(
    proposal.kind === "interestPool" ? proposal.core : [],
  );
  const [extended, setExtended] = useState<string[]>(
    proposal.kind === "interestPool" ? proposal.extended : [],
  );
  const [general, setGeneral] = useState<string[]>(
    proposal.kind === "interestPool" ? proposal.general : [],
  );
  const [summary, setSummary] = useState(
    proposal.kind === "toneGuide" ? proposal.guide.summary : "",
  );
  const [commentStyle, setCommentStyle] = useState(
    proposal.kind === "toneGuide" ? proposal.guide.commentStyle : "",
  );
  const [topics, setTopics] = useState<string[]>(
    proposal.kind === "toneGuide" ? proposal.guide.topicDirections : [],
  );
  const [avoid, setAvoid] = useState<string[]>(
    proposal.kind === "toneGuide" ? proposal.guide.avoid : [],
  );
  const [to, setTo] = useState(
    proposal.kind === "profileField" ? proposal.to : "",
  );
  const [action, setAction] = useState<NoteAction>(
    proposal.kind === "noteAction" ? proposal.action : "keep",
  );

  const edited = (): Record<string, unknown> => {
    switch (proposal.kind) {
      case "positioning":
        return { label: label.trim(), positioning: positioning.trim() };
      case "interestPool":
        return { core, extended, general };
      case "toneGuide":
        return {
          guide: {
            ...proposal.guide,
            summary: summary.trim(),
            commentStyle: commentStyle.trim(),
            topicDirections: topics,
            avoid,
          },
        };
      case "profileField":
        return { to: to.trim() };
      case "noteAction":
        return { action };
      case "keep":
        return {};
    }
  };

  return (
    <div className="flex flex-col gap-2 rounded-md border border-[var(--color-brand-primary)]/[30%] bg-surface-1 p-2.5">
      {proposal.kind === "positioning" ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="账号定位名">
            <input
              className={inputClass}
              value={label}
              maxLength={40}
              onChange={(event) => setLabel(event.target.value)}
            />
          </Field>
          <Field label="内容方向与风格">
            <input
              className={inputClass}
              value={positioning}
              maxLength={200}
              onChange={(event) => setPositioning(event.target.value)}
            />
          </Field>
        </div>
      ) : null}
      {proposal.kind === "interestPool" ? (
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="核心（3–12 个）">
            <ChipInput value={core} onChange={setCore} ariaLabel="核心兴趣" />
          </Field>
          <Field label="扩展">
            <ChipInput
              value={extended}
              onChange={setExtended}
              ariaLabel="扩展兴趣"
            />
          </Field>
          <Field label="泛兴趣">
            <ChipInput
              value={general}
              onChange={setGeneral}
              ariaLabel="泛兴趣"
            />
          </Field>
        </div>
      ) : null}
      {proposal.kind === "toneGuide" ? (
        <div className="grid grid-cols-1 gap-2">
          <Field label="整体语气">
            <input
              className={inputClass}
              value={summary}
              maxLength={200}
              onChange={(event) => setSummary(event.target.value)}
            />
          </Field>
          <Field label="选题方向">
            <ChipInput
              value={topics}
              onChange={setTopics}
              ariaLabel="选题方向"
            />
          </Field>
          <Field label="回避方向">
            <ChipInput value={avoid} onChange={setAvoid} ariaLabel="回避方向" />
          </Field>
          <Field label="评论语气（注入评论候选，仍逐条人工审核）">
            <input
              className={inputClass}
              value={commentStyle}
              maxLength={80}
              onChange={(event) => setCommentStyle(event.target.value)}
            />
          </Field>
        </div>
      ) : null}
      {proposal.kind === "profileField" ? (
        <Field
          label={
            proposal.field === "avatar" || proposal.field === "cover"
              ? "图片方向说明"
              : `新的${XHS_PROFILE_FIELD_LABEL[proposal.field]}`
          }
        >
          {/* The occupation from the picker's items, the region in its hierarchy: the controller refuses anything else. */}
          <TakeoverFieldValueInput
            field={proposal.field}
            value={to}
            onChange={setTo}
          />
        </Field>
      ) : null}
      {proposal.kind === "noteAction" ? (
        <Field label="处理建议">
          <select
            className={selectClass}
            value={action}
            onChange={(event) => {
              const next = NOTE_ACTIONS.find(
                (key) => key === event.target.value,
              );
              if (next) setAction(next);
            }}
          >
            {NOTE_ACTIONS.map((key) => (
              <option key={key} value={key}>
                {NOTE_ACTION_LABEL[key]}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      <div className="flex items-center justify-end gap-2">
        <SecondaryButton onClick={onCancel} disabled={busy}>
          取消
        </SecondaryButton>
        <PrimaryButton onClick={() => onSave(edited())} disabled={busy}>
          保存修改并采纳
        </PrimaryButton>
      </div>
    </div>
  );
}

function ProposalCard({
  proposal,
  data,
  ops,
  diagnosis,
  editable,
  busy,
  evidenceFocusable,
  onDecide,
}: {
  proposal: XhsOpsDiagnosisProposal;
  data: TakeoverSectionProps["data"];
  ops: TakeoverSectionProps["ops"];
  diagnosis: XhsOpsAccountDiagnosis;
  editable: boolean;
  busy: boolean;
  evidenceFocusable: boolean;
  onDecide: (
    proposal: XhsOpsDiagnosisProposal,
    decision: Decision,
    edited?: Record<string, unknown>,
  ) => void;
}) {
  const [editing, setEditing] = useState(false);
  const decision = diagnosis.decisions[proposal.id];
  const shown = effectiveProposal(proposal, decision);
  const tags = riskTags(proposal);
  const decisions: Decision[] =
    proposal.kind === "keep"
      ? ["adopt", "reject", "defer"]
      : ["adopt", "edit", "reject", "defer"];
  return (
    <div
      data-proposal={proposal.id}
      className="flex flex-col gap-1.5 rounded-md border border-border bg-surface-1 px-2.5 py-2"
    >
      <div className="flex flex-wrap items-center gap-1.5 text-[12px]">
        <span className="font-medium text-text-primary">
          {proposal.id} · {proposalTitle(shown)}
        </span>
        {proposal.kind === "profileField" ? (
          <span className="text-text-secondary">
            {proposal.risk} · 第 {proposal.batch} 批
          </span>
        ) : null}
        {tags.map((tag) => (
          <span
            key={tag}
            className="rounded border border-[var(--color-warning-ink)]/[25%] px-1.5 text-[11px] text-[var(--color-warning-ink)]"
          >
            {tag}
          </span>
        ))}
        {proposal.budgetBlockedUntil ? (
          <span className="text-[11px] text-[var(--color-error-ink)]">
            预算：{formatDateTime(proposal.budgetBlockedUntil)} 前不能改
          </span>
        ) : null}
        {decision ? (
          <span className="ml-auto text-text-secondary">
            已选：{DECISION_LABEL[decision.decision]}
          </span>
        ) : null}
      </div>
      <div className="flex flex-col">
        <ProposalValues
          proposal={shown}
          original={proposal}
          data={data}
          diagnosis={diagnosis}
        />
        {proposal.rationale ? (
          <ValueRow label="理由">{proposal.rationale}</ValueRow>
        ) : null}
      </div>
      <EvidenceChips
        refs={proposal.evidence}
        ops={ops}
        focusable={evidenceFocusable}
      />
      <RuleChips ruleIds={proposal.ruleIds} data={data} />
      {editable ? (
        <div className="flex flex-wrap gap-1.5">
          {decisions.map((key) => (
            <button
              key={key}
              type="button"
              aria-pressed={decision?.decision === key}
              disabled={busy}
              onClick={() => {
                if (key === "edit") setEditing(true);
                else onDecide(proposal, key);
              }}
              className={`h-7 rounded-md border px-2.5 text-[12px] ${
                decision?.decision === key
                  ? "border-[var(--color-accent)] bg-[var(--color-accent)] text-[var(--color-accent-fg)]"
                  : "border-border-strong bg-surface-1 text-text-secondary hover:text-text-primary"
              } disabled:opacity-50`}
            >
              {DECISION_LABEL[key]}
            </button>
          ))}
        </div>
      ) : null}
      {editable && editing ? (
        <ProposalEditor
          proposal={shown}
          busy={busy}
          onCancel={() => setEditing(false)}
          onSave={(edited) => {
            setEditing(false);
            onDecide(proposal, "edit", edited);
          }}
        />
      ) : null}
    </div>
  );
}

function CadenceGroup({
  cadence,
}: {
  cadence: XhsOpsAccountDiagnosis["cadence"];
}) {
  const browse = cadence.browseDefaults;
  const interaction = cadence.interaction;
  const off = (enabled: boolean) => (enabled ? "开" : "关");
  return (
    <div className="flex flex-col rounded-md border border-border bg-surface-1 px-2.5 py-2">
      <ValueRow label="浏览">
        日目标 {browse.dailyTargetPosts} 篇 · 分 {browse.dailySegments} 段 ·
        搜索占比 {browse.searchRatioPercent}% · 单篇停留 {browse.dwellSecMin}–
        {browse.dwellSecMax} 秒
      </ValueRow>
      <ValueRow label="互动">
        点赞{" "}
        {interaction.like.enabled
          ? `每日 ≤${interaction.like.dailyCap}（${interaction.like.ratioPercent}%）`
          : "关"}
        {` · 收藏 ${off(interaction.collect.enabled)} · 关注 ${off(interaction.follow.enabled)} · 评论 ${off(interaction.comment.enabled)}`}
      </ValueRow>
      {cadence.rationale.length > 0 ? (
        <ValueRow label="依据">{cadence.rationale.join("\n")}</ValueRow>
      ) : null}
      <HintLine>
        确认方案时按档位写入；之后调高参数超出档位上限要填写理由。
      </HintLine>
    </div>
  );
}

/** ⑤ 方案 (T6): decisions, regenerate, confirm, and the plan once confirmed. */
export function PlanSection({
  data,
  ops,
  feedback,
  evidenceFocusable,
}: PlanSectionProps) {
  const { account, diagnosis } = data;
  const takeover = account.takeover;
  const planConfirmed = Boolean(takeover?.planConfirmedAt);
  const action = useTakeoverAction(ops.refresh);
  const generation = useDiagnosisGeneration({ data, ops, feedback });
  const [unknownRule, setUnknownRule] = useState<{
    proposal: XhsOpsDiagnosisProposal;
    decision: Decision;
    edited?: Record<string, unknown>;
  } | null>(null);
  const [confirmOpen, setConfirmOpen] = useState<"plan" | "keep" | null>(null);
  const [revertOpen, setRevertOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  // Persisted on the account: a remount still shows them, and the controller
  // drops a field's entry once an order for it exists.
  const skipped = takeover?.skippedFields ?? [];

  if (!diagnosis) return null;
  const editable = diagnosis.status === "ready" && !planConfirmed;
  const busy = action.busy !== null || generation.busy !== null;

  const decide = (
    proposal: XhsOpsDiagnosisProposal,
    decision: Decision,
    edited?: Record<string, unknown>,
  ) =>
    void action.run(`decide:${proposal.id}`, "保存采纳决定失败", async () => {
      ops.setDiagnosis(
        await xhsOpsApi.decideDiagnosis(diagnosis.id, {
          expectedUpdatedAt: diagnosis.updatedAt,
          decisions: {
            [proposal.id]:
              edited === undefined ? { decision } : { decision, edited },
          },
        }),
      );
    });

  const requestDecision = (
    proposal: XhsOpsDiagnosisProposal,
    decision: Decision,
    edited?: Record<string, unknown>,
  ) => {
    // §4.5: an item citing a rule the playbook does not know needs a second yes.
    if (
      (decision === "adopt" || decision === "edit") &&
      hasUnknownRule(proposal.ruleIds, diagnosis.citedRules, data.playbook)
    ) {
      setUnknownRule({ proposal, decision, edited });
      return;
    }
    decide(proposal, decision, edited);
  };

  const confirmPlan = (keepAllPublic: boolean) =>
    void action.run(
      keepAllPublic ? "keep" : "confirm",
      "确认接管方案失败",
      async () => {
        const result = await xhsOpsApi.confirmTakeoverPlan(diagnosis.id, {
          expectedUpdatedAt: diagnosis.updatedAt,
          ...(keepAllPublic ? { keepAllPublic: true } : {}),
        });
        ops.setAccount(result.account);
        ops.setDiagnosis(result.diagnosis);
        ops.setOrders(result.changeOrders);
        for (const order of result.changeOrders)
          if (changeOrderAwaitingFinish(order)) ops.track(order.id);
        ops.forward(result.event, result.account.takeover?.planConfirmedAt);
      },
    );

  const revert = () =>
    void action.run("revert", "撤销方案失败", async () => {
      const result = await xhsOpsApi.revertTakeoverPlan(account.id, {
        expectedUpdatedAt: account.updatedAt,
      });
      ops.setAccount(result.account);
      ops.setDiagnosis(result.diagnosis);
      ops.setOrders(result.changeOrders);
    });

  const adoptedOf = (kind: XhsOpsProposal["kind"]) =>
    diagnosis.proposals.filter((proposal) => {
      const decision = diagnosis.decisions[proposal.id]?.decision;
      return (
        proposal.kind === kind && (decision === "adopt" || decision === "edit")
      );
    }).length;
  const undecided = diagnosis.proposals.filter(
    (proposal) => !diagnosis.decisions[proposal.id],
  ).length;
  const publicAdopted = adoptedOf("profileField");
  const internalAdopted = [
    adoptedOf("positioning") > 0 ? "定位与人设" : null,
    adoptedOf("interestPool") > 0 ? "兴趣池" : null,
    adoptedOf("toneGuide") > 0 ? "调性指南" : null,
  ].filter((entry): entry is string => entry !== null);

  const guideLines = toneGuideLines(account.toneGuide);
  const pillarWords = xhsOpsTonePillarKeywords(
    account.toneGuide.pillars,
    account.interestPool,
  );
  const copyGuide = async () => {
    const text = guideLines
      .map((line) => `${line.label}：${line.value}`)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      action.setError("复制失败，请手动选中文字复制");
    }
  };

  return (
    <TakeoverSection
      index="⑤"
      title="方案"
      testId="plan"
      hint="逐项选择；内部配置确认后立即生效，公开资料另走变更单"
    >
      {planConfirmed ? (
        <Notice tone="info" testId="plan-confirmed">
          <span>
            接管方案已确认 {formatDateTime(takeover?.planConfirmedAt)}
            {takeover?.keepAllPublic ? " · 全部保留公开资料，只做维护" : ""}
            。内部定位、兴趣池和养号参数已生效。
          </span>
        </Notice>
      ) : null}
      {PLAN_GROUPS.map((group) => {
        if (group.kind === null)
          return (
            <div key={group.key} className="flex flex-col gap-1.5">
              <span className="text-[12px] font-medium text-text-heading">
                {group.title}
              </span>
              <CadenceGroup cadence={diagnosis.cadence} />
            </div>
          );
        const proposals = diagnosis.proposals.filter(
          (proposal) => proposal.kind === group.kind,
        );
        if (proposals.length === 0) return null;
        return (
          <div
            key={group.key}
            data-plan-group={group.key}
            className="flex flex-col gap-1.5"
          >
            <span className="text-[12px] font-medium text-text-heading">
              {group.title}
            </span>
            {group.key === "D" ? (
              <Notice tone="info">{TAKEOVER_TONE_GUIDE_NOTICE}</Notice>
            ) : null}
            {group.key === "E" ? (
              <HintLine>
                采纳的公开资料改动会在确认方案后转成变更单，逐批预检、确认后才会执行；确认方案本身不改任何公开资料。
              </HintLine>
            ) : null}
            {group.key === "F" ? (
              <HintLine>
                只给人看：确认后由你自己在手机上处理，桌面不派发任何手机任务。
              </HintLine>
            ) : null}
            {proposals.map((proposal) => (
              <ProposalCard
                key={proposal.id}
                proposal={proposal}
                data={data}
                ops={ops}
                diagnosis={diagnosis}
                editable={editable}
                busy={busy}
                evidenceFocusable={evidenceFocusable}
                onDecide={requestDecision}
              />
            ))}
          </div>
        );
      })}

      {editable ? (
        <>
          <FeedbackBox
            feedback={feedback}
            buttonLabel="按意见重新生成"
            busy={generation.busy === "generate"}
            disabled={busy}
            onSubmit={() => void generation.submit()}
          />
          <HintLine>
            重新生成会保留已决定的条目。
            {undecided > 0
              ? `还有 ${undecided} 项没有决定，确认方案时按未采纳处理。`
              : "所有条目都已决定。"}
          </HintLine>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <SecondaryButton
              onClick={() => setConfirmOpen("keep")}
              disabled={busy}
            >
              全部保留，只做维护
            </SecondaryButton>
            <PrimaryButton
              onClick={() => setConfirmOpen("plan")}
              disabled={busy}
            >
              {action.busy === "confirm" ? <Spinner /> : null}
              确认优化方案
            </PrimaryButton>
          </div>
        </>
      ) : null}

      {planConfirmed ? (
        <div className="flex flex-col gap-2">
          {skipped.length > 0 ? (
            <Notice tone="warning" testId="plan-skipped-fields">
              <span>采纳了但没有生成变更单的字段：</span>
              {skipped.map((entry) => (
                <span key={entry.proposalId}>
                  {XHS_PROFILE_FIELD_LABEL[entry.field]}：{entry.reason}
                </span>
              ))}
            </Notice>
          ) : null}
          {guideLines.length > 0 ? (
            <div className="flex flex-col gap-1 rounded-md border border-border bg-surface-1 px-2.5 py-2">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[12px] font-medium text-text-heading">
                  账号调性指南（给人执行，不会自动改帖子）
                </span>
                <SecondaryButton onClick={() => void copyGuide()}>
                  {copied ? "已复制" : "复制到剪贴板"}
                </SecondaryButton>
              </div>
              {guideLines.map((line) => (
                <ValueRow key={line.label} label={line.label}>
                  {line.value}
                </ValueRow>
              ))}
            </div>
          ) : null}
          {pillarWords.length > 0 ? (
            <div
              data-testid="pillar-mapping"
              className="flex flex-col gap-0.5 rounded-md border border-border bg-surface-1 px-2.5 py-2 text-[12px]"
            >
              <span className="font-medium text-text-heading">
                内容支柱 → 兴趣词
              </span>
              {pillarWords.map((entry) => (
                <span key={entry.pillar} className="text-text-secondary">
                  {entry.pillar} →{" "}
                  {entry.words.length > 0
                    ? entry.words.join("、")
                    : "（没有对应的兴趣词）"}
                </span>
              ))}
            </div>
          ) : null}
          <div className="flex justify-end">
            <SecondaryButton
              danger
              onClick={() => setRevertOpen(true)}
              disabled={busy}
            >
              撤销方案
            </SecondaryButton>
          </div>
        </div>
      ) : null}
      <ErrorLine message={action.error ?? generation.error} />

      <ConfirmDialog
        open={unknownRule !== null}
        onOpenChange={(open) => {
          if (!open) setUnknownRule(null);
        }}
        title="这条建议没有经验依据"
        confirmLabel="仍然采纳"
        description={
          <p>
            {unknownRule?.proposal.id}{" "}
            引用的经验条目不在经验库里（无经验依据）。确定要采纳吗？
          </p>
        }
        onConfirm={() => {
          if (unknownRule)
            decide(
              unknownRule.proposal,
              unknownRule.decision,
              unknownRule.edited,
            );
          setUnknownRule(null);
        }}
      />
      <ConfirmDialog
        open={confirmOpen !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmOpen(null);
        }}
        title={
          confirmOpen === "keep" ? "全部保留，只做维护？" : "确认优化方案？"
        }
        confirmLabel={confirmOpen === "keep" ? "确认，只做维护" : "确认方案"}
        description={
          confirmOpen === "keep" ? (
            <p>
              不生成任何公开资料变更单（E
              组的采纳不会执行）；已采纳的内部配置和按档位给出的养号参数照常生效，今天就能开始日常维护。
            </p>
          ) : (
            <>
              <p>
                {internalAdopted.length > 0
                  ? `已采纳的${internalAdopted.join("、")}和按档位给出的养号参数`
                  : "按档位给出的养号参数"}
                确认后立即生效，今天就能开始日常维护。
              </p>
              <p className="mt-2">
                {publicAdopted > 0
                  ? `E 组已采纳的 ${publicAdopted} 项会转成变更单草案，之后逐批预检、确认后才会执行；确认方案这一步本身不改任何公开资料。`
                  : "这次不改任何公开资料。"}
              </p>
              {undecided > 0 ? (
                <p className="mt-2">
                  还有 {undecided} 项没有决定，确认后按未采纳处理。
                </p>
              ) : null}
            </>
          )
        }
        onConfirm={() => confirmPlan(confirmOpen === "keep")}
      />
      <ConfirmDialog
        open={revertOpen}
        onOpenChange={setRevertOpen}
        title="撤销接管方案？"
        confirmLabel="撤销方案"
        danger
        description={
          <p>
            恢复确认方案之前的定位、人设、兴趣池、调性和养号参数；还没开始的变更单会被取消。已经执行过的公开修改不会被撤回。
          </p>
        }
        onConfirm={revert}
      />
    </TakeoverSection>
  );
}
