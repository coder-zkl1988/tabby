import { useEffect, useState } from "react";
import type { CustomComponentProps } from "../registry";
import { describeXhsOpsError, xhsOpsApi } from "./xhs-ops-api";
import {
  type XhsOpsProfileInput,
  asString,
  normalizeProfileInput,
} from "./xhs-ops-types";
import {
  CardShell,
  ChipInput,
  ErrorLine,
  Field,
  HintLine,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  formatClock,
  inputClass,
  readProp,
  textareaClass,
} from "./xhs-ops-ui";

/**
 * Step 2: the agent's proposed target-audience profile, editable in place.
 * 「确认画像」persists it with optimistic concurrency and reports
 * `xhs_ops_profile_confirmed`; 「让 AI 按我的意见重生成」only reports
 * `xhs_ops_profile_regenerate` with the user's feedback — the agent re-renders
 * this surface with a new profile.
 */
export function XhsOpsProfileCard({
  comp,
  resolve,
  onAction,
}: CustomComponentProps) {
  const projectId = asString(readProp(comp, resolve, "projectId"));
  const incomingProfile = readProp(comp, resolve, "profile");
  // The agent re-renders the same surface with a regenerated profile; a
  // serialized key tells us when the proposal actually changed.
  const incomingKey = JSON.stringify(incomingProfile ?? null);

  const [draft, setDraft] = useState<XhsOpsProfileInput>(() =>
    normalizeProfileInput(incomingProfile),
  );
  const [confirmedAt, setConfirmedAt] = useState<string | null>(
    () => normalizeProfileInput(incomingProfile).confirmedAt ?? null,
  );
  const [projectUpdatedAt, setProjectUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState(Boolean(projectId));
  const [reload, setReload] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [feedbackOpen, setFeedbackOpen] = useState(false);
  const [feedback, setFeedback] = useState("");
  const [regenerateSentAt, setRegenerateSentAt] = useState<number | null>(null);

  useEffect(() => {
    void reload;
    const proposed = normalizeProfileInput(JSON.parse(incomingKey));
    if (!projectId) {
      setDraft(proposed);
      setConfirmedAt(proposed.confirmedAt ?? null);
      setProjectUpdatedAt(null);
      setLoading(false);
      setError("缺少 projectId，无法加载最新画像");
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    xhsOpsApi
      .getProject(projectId)
      .then((project) => {
        if (cancelled) return;
        const next = project.profile
          ? normalizeProfileInput(project.profile)
          : proposed;
        setDraft(next);
        setConfirmedAt(next.confirmedAt ?? null);
        setProjectUpdatedAt(project.updatedAt);
        setRegenerateSentAt(null);
        setFeedbackOpen(false);
      })
      .catch((err) => {
        if (cancelled) return;
        setProjectUpdatedAt(null);
        setError(describeXhsOpsError(err, "最新画像加载失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, incomingKey, reload]);

  const editDraft = (
    update: (current: XhsOpsProfileInput) => XhsOpsProfileInput,
  ) => {
    setDraft(update);
    setConfirmedAt(null);
    setRegenerateSentAt(null);
  };

  const patchBase = (patch: Partial<XhsOpsProfileInput["base"]>) =>
    editDraft((d) => ({ ...d, base: { ...d.base, ...patch } }));

  const confirm = async () => {
    if (!projectId) {
      setError("缺少 projectId，无法保存画像");
      return;
    }
    if (!draft.summary.trim()) {
      setError("请填写画像概述");
      return;
    }
    const missing = [
      !draft.base.ageRange.trim() ? "年龄段" : null,
      !draft.base.genderRatio.trim() ? "性别比例" : null,
      draft.base.regions.length === 0 ? "地区" : null,
      draft.verticalInterests.length === 0 ? "垂直兴趣" : null,
      draft.generalInterests.length === 0 ? "泛兴趣" : null,
    ].filter((value): value is string => value !== null);
    if (missing.length > 0) {
      setError(`请补全画像：${missing.join("、")}`);
      return;
    }
    if (!projectUpdatedAt) {
      setError("最新画像尚未加载，无法确认");
      return;
    }
    setSaving(true);
    setError(null);
    const profile = {
      summary: draft.summary.trim(),
      base: {
        ageRange: draft.base.ageRange.trim(),
        genderRatio: draft.base.genderRatio.trim(),
        regions: draft.base.regions,
      },
      verticalInterests: draft.verticalInterests,
      generalInterests: draft.generalInterests,
    };
    try {
      const project = await xhsOpsApi.confirmProfile(projectId, {
        profile,
        expectedUpdatedAt: projectUpdatedAt,
      });
      const saved = project.profile;
      if (!saved?.confirmedAt) {
        throw new Error("画像确认未返回确认时间，请重新加载");
      }
      setDraft(normalizeProfileInput(saved));
      setConfirmedAt(saved.confirmedAt);
      setProjectUpdatedAt(project.updatedAt);
      onAction?.("xhs_ops_profile_confirmed", {
        projectId,
        profile: saved,
      });
    } catch (err) {
      setError(describeXhsOpsError(err, "画像保存失败"));
      setProjectUpdatedAt(null);
    } finally {
      setSaving(false);
    }
  };

  const sendRegenerate = () => {
    const text = feedback.trim();
    if (!text) {
      setError("请先写下你希望调整的方向");
      return;
    }
    setError(null);
    setRegenerateSentAt(Date.now());
    onAction?.("xhs_ops_profile_regenerate", { projectId, feedback: text });
  };

  const regenerate = async () => {
    if (!projectId || !projectUpdatedAt) {
      setError("最新画像尚未加载，无法重新生成");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const project = await xhsOpsApi.generateProfile(projectId, {
        expectedUpdatedAt: projectUpdatedAt,
      });
      if (!project.profile) throw new Error("画像生成未返回结果");
      const next = normalizeProfileInput(project.profile);
      setDraft(next);
      setConfirmedAt(next.confirmedAt ?? null);
      setProjectUpdatedAt(project.updatedAt);
      setRegenerateSentAt(null);
    } catch (err) {
      setError(describeXhsOpsError(err, "画像重新生成失败"));
      setProjectUpdatedAt(null);
    } finally {
      setSaving(false);
    }
  };

  const disabled = loading || saving || projectUpdatedAt === null;

  return (
    <CardShell
      testId="profile-card"
      title="目标用户画像"
      subtitle="可直接修改后确认；只描述人群内容方向，不涉及任何虚构个人身份"
      footer={
        <>
          <div className="min-w-0 text-[12px] text-text-secondary">
            {confirmedAt
              ? `已确认 ${formatClock(confirmedAt)} · 等待 AI 生成账号定位`
              : regenerateSentAt
                ? `意见已发送 ${formatClock(regenerateSentAt)} · 等待 AI 重生成…`
                : "确认后 AI 将基于画像生成账号定位与兴趣池"}
          </div>
          <div className="flex items-center gap-2">
            <SecondaryButton
              onClick={() => void regenerate()}
              disabled={disabled}
            >
              重新生成画像
            </SecondaryButton>
            <SecondaryButton
              onClick={() => setFeedbackOpen((open) => !open)}
              disabled={disabled}
            >
              让 AI 按我的意见重生成
            </SecondaryButton>
            <PrimaryButton onClick={() => void confirm()} disabled={disabled}>
              {saving ? "保存中…" : confirmedAt ? "重新确认画像" : "确认画像"}
            </PrimaryButton>
          </div>
        </>
      }
    >
      <ErrorLine message={error} />
      {loading ? <HintLine>正在加载最新画像…</HintLine> : null}
      {!loading && projectId && projectUpdatedAt === null ? (
        <SecondaryButton onClick={() => setReload((value) => value + 1)}>
          重新加载画像
        </SecondaryButton>
      ) : null}
      <HintLine>
        重新生成或确认修改画像后，已有账号人设与资料会变为待复核，养号保持锁定直至重新确认。
      </HintLine>

      <Field label="画像概述">
        <textarea
          className={textareaClass}
          rows={2}
          value={draft.summary}
          disabled={disabled}
          placeholder="一句话概括目标用户是谁、关注什么"
          onChange={(e) =>
            editDraft((d) => ({ ...d, summary: e.target.value }))
          }
        />
      </Field>

      <div className="flex flex-col gap-2">
        <SectionTitle>基础特征</SectionTitle>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label="年龄段">
            <input
              className={inputClass}
              value={draft.base.ageRange}
              disabled={disabled}
              onChange={(e) => patchBase({ ageRange: e.target.value })}
            />
          </Field>
          <Field label="性别比例">
            <input
              className={inputClass}
              value={draft.base.genderRatio}
              disabled={disabled}
              onChange={(e) => patchBase({ genderRatio: e.target.value })}
            />
          </Field>
          <Field label="地区">
            <ChipInput
              value={draft.base.regions}
              disabled={disabled}
              placeholder="回车添加"
              onChange={(regions) => patchBase({ regions })}
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle hint="与业务直接相关，建议 5–8 个">垂直兴趣</SectionTitle>
        <ChipInput
          value={draft.verticalInterests}
          disabled={disabled}
          placeholder="回车添加，如：亲子酒店测评"
          ariaLabel="垂直兴趣"
          onChange={(verticalInterests) =>
            editDraft((d) => ({ ...d, verticalInterests }))
          }
        />
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle hint="目标人群日常关注，建议 5–8 个">泛兴趣</SectionTitle>
        <ChipInput
          value={draft.generalInterests}
          disabled={disabled}
          placeholder="回车添加，如：周末去哪儿"
          ariaLabel="泛兴趣"
          onChange={(generalInterests) =>
            editDraft((d) => ({ ...d, generalInterests }))
          }
        />
      </div>

      {feedbackOpen ? (
        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface-2/60 p-2.5">
          <SectionTitle>给 AI 的修改意见</SectionTitle>
          <textarea
            className={textareaClass}
            rows={3}
            value={feedback}
            placeholder="如：人群年龄偏大了，兴趣里加入露营和短途自驾"
            onChange={(e) => setFeedback(e.target.value)}
          />
          <div className="flex items-center justify-end gap-2">
            <SecondaryButton onClick={() => setFeedbackOpen(false)}>
              收起
            </SecondaryButton>
            <PrimaryButton onClick={sendRegenerate}>发送并重生成</PrimaryButton>
          </div>
          <HintLine>AI 会按你的意见重新生成画像并更新这张卡片。</HintLine>
        </div>
      ) : null}
    </CardShell>
  );
}
