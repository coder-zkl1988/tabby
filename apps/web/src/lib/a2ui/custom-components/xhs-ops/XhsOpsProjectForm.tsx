import { useEffect, useState } from "react";
import type { CustomComponentProps } from "../registry";
import { describeXhsOpsError, xhsOpsApi } from "./xhs-ops-api";
import {
  type XhsOpsAudience,
  type XhsOpsBusiness,
  type XhsOpsOpsNotes,
  type XhsOpsProject,
  asString,
  emptyAudience,
  emptyBusiness,
  emptyOpsNotes,
  normalizeAudience,
  normalizeBusiness,
  normalizeOpsNotes,
} from "./xhs-ops-types";
import {
  CardShell,
  ChipInput,
  ErrorLine,
  Field,
  HintLine,
  PrimaryButton,
  SectionTitle,
  formatClock,
  inputClass,
  readProp,
} from "./xhs-ops-ui";

interface FormState {
  name: string;
  business: XhsOpsBusiness;
  audience: XhsOpsAudience;
  opsNotes: XhsOpsOpsNotes;
}

function missingProfileInputs(form: FormState): string[] {
  const missing: string[] = [];
  if (!form.business.industry.trim()) missing.push("行业");
  if (!form.business.product.trim()) missing.push("产品 / 服务");
  if (!form.audience.ageRange.trim()) missing.push("目标年龄段");
  if (!form.audience.genderRatio.trim()) missing.push("性别比例");
  if (form.audience.regions.length === 0) missing.push("目标地区");
  return missing;
}

function formFromPrefill(prefill: unknown): FormState {
  const p =
    prefill && typeof prefill === "object"
      ? (prefill as Record<string, unknown>)
      : {};
  return {
    name: asString(p.name).slice(0, 80),
    business: p.business ? normalizeBusiness(p.business) : emptyBusiness(),
    audience: p.audience ? normalizeAudience(p.audience) : emptyAudience(),
    opsNotes: p.opsNotes ? normalizeOpsNotes(p.opsNotes) : emptyOpsNotes(),
  };
}

function formFromProject(project: XhsOpsProject): FormState {
  return {
    name: project.name ?? "",
    business: normalizeBusiness(project.business),
    audience: normalizeAudience(project.audience),
    opsNotes: normalizeOpsNotes(project.opsNotes),
  };
}

/**
 * Step 1 of the 小红书账号运营 flow: grouped project form (业务信息 / 目标消费者 /
 * 运营备注). Creates or updates the project over REST, then reports
 * `xhs_ops_project_saved` so the agent can generate the audience profile.
 */
export function XhsOpsProjectForm({
  comp,
  resolve,
  onAction,
}: CustomComponentProps) {
  const propProjectId = asString(readProp(comp, resolve, "projectId")) || null;
  const prefill = readProp(comp, resolve, "prefill");

  const [form, setForm] = useState<FormState>(() => formFromPrefill(prefill));
  const [projectId, setProjectId] = useState<string | null>(propProjectId);
  const [projectUpdatedAt, setProjectUpdatedAt] = useState<string | null>(null);
  const [loading, setLoading] = useState<boolean>(Boolean(propProjectId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Editing an existing project: load it once and replace the form.
  useEffect(() => {
    if (!propProjectId) return;
    let cancelled = false;
    setLoading(true);
    xhsOpsApi
      .getProject(propProjectId)
      .then((project) => {
        if (cancelled) return;
        setForm(formFromProject(project));
        setProjectId(project.id);
        setProjectUpdatedAt(project.updatedAt);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(describeXhsOpsError(err, "项目加载失败"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [propProjectId]);

  const patchBusiness = (patch: Partial<XhsOpsBusiness>) =>
    setForm((f) => ({ ...f, business: { ...f.business, ...patch } }));
  const patchAudience = (patch: Partial<XhsOpsAudience>) =>
    setForm((f) => ({ ...f, audience: { ...f.audience, ...patch } }));
  const patchOpsNotes = (patch: Partial<XhsOpsOpsNotes>) =>
    setForm((f) => ({ ...f, opsNotes: { ...f.opsNotes, ...patch } }));

  const save = async () => {
    const name = form.name.trim();
    if (!name) {
      setError("请填写项目名称");
      return;
    }
    if (name.length > 80) {
      setError("项目名称不超过 80 字");
      return;
    }
    const missing = missingProfileInputs(form);
    if (missing.length > 0) {
      setError(`请补全生成画像所需信息：${missing.join("、")}`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        name,
        business: form.business,
        audience: form.audience,
        opsNotes: form.opsNotes,
      };
      const savedProject = projectId
        ? await xhsOpsApi.updateProject(projectId, {
            ...body,
            expectedUpdatedAt: projectUpdatedAt ?? undefined,
          })
        : await xhsOpsApi.createProject(body);
      setProjectId(savedProject.id);
      setProjectUpdatedAt(savedProject.updatedAt);
      setForm(formFromProject(savedProject));
      setSavedAt(Date.now());
      let project: XhsOpsProject;
      try {
        project = await xhsOpsApi.generateProfile(savedProject.id, {
          expectedUpdatedAt: savedProject.updatedAt,
        });
        setProjectUpdatedAt(project.updatedAt);
      } catch (err) {
        setError(
          `项目信息已保存，但画像生成失败：${describeXhsOpsError(err, "请重试")}`,
        );
        return;
      }
      onAction?.("xhs_ops_project_saved", {
        projectId: project.id,
        name: project.name,
        business: project.business,
        audience: project.audience,
        opsNotes: project.opsNotes,
        profile: project.profile,
        agentInstruction:
          "桌面已生成目标用户画像。请渲染 XhsOpsProfileCard 供运营核对；收到 xhs_ops_profile_confirmed 前不要生成人设。",
      });
    } catch (err) {
      setError(describeXhsOpsError(err, "保存失败"));
    } finally {
      setSaving(false);
    }
  };

  const disabled = loading || saving;

  return (
    <CardShell
      testId="project-form"
      title={
        projectId ? "小红书账号运营 · 编辑项目" : "小红书账号运营 · 新建项目"
      }
      subtitle="填写业务与目标消费者信息，保存后由 AI 生成目标用户画像"
      footer={
        <>
          <div className="min-w-0 text-[12px] text-text-secondary">
            {savedAt
              ? `已保存 ${formatClock(savedAt)} · 等待 AI 生成画像`
              : "只描述内容方向与受众，不会生成任何虚构个人身份"}
          </div>
          <PrimaryButton onClick={() => void save()} disabled={disabled}>
            {saving ? "保存中…" : "保存并生成画像"}
          </PrimaryButton>
        </>
      }
    >
      {loading ? <HintLine>正在加载项目…</HintLine> : null}
      <ErrorLine message={error} />

      <Field label="项目名称 *">
        <input
          className={inputClass}
          value={form.name}
          maxLength={80}
          placeholder="如：北京亲子酒店 2026 春季"
          disabled={disabled}
          onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
        />
      </Field>

      <div className="flex flex-col gap-2">
        <SectionTitle>业务信息</SectionTitle>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="行业 *">
            <input
              className={inputClass}
              value={form.business.industry}
              disabled={disabled}
              placeholder="如：酒店 / 亲子出行"
              onChange={(e) => patchBusiness({ industry: e.target.value })}
            />
          </Field>
          <Field label="产品 / 服务 *">
            <input
              className={inputClass}
              value={form.business.product}
              disabled={disabled}
              placeholder="如：亲子主题房 + 周末套餐"
              onChange={(e) => patchBusiness({ product: e.target.value })}
            />
          </Field>
          <Field label="覆盖地区">
            <ChipInput
              value={form.business.regions}
              disabled={disabled}
              placeholder="回车添加，如：北京、天津"
              onChange={(regions) => patchBusiness({ regions })}
            />
          </Field>
          <Field label="核心卖点">
            <ChipInput
              value={form.business.sellingPoints}
              disabled={disabled}
              placeholder="回车添加，如：室内乐园、含早"
              onChange={(sellingPoints) => patchBusiness({ sellingPoints })}
            />
          </Field>
          <Field label="价格带">
            <input
              className={inputClass}
              value={form.business.priceBand}
              disabled={disabled}
              placeholder="如：800–1500 元/晚"
              onChange={(e) => patchBusiness({ priceBand: e.target.value })}
            />
          </Field>
          <Field label="使用场景">
            <input
              className={inputClass}
              value={form.business.scene}
              disabled={disabled}
              placeholder="如：周末家庭短途度假"
              onChange={(e) => patchBusiness({ scene: e.target.value })}
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle hint="描述人群特征，用于生成画像与兴趣池">
          目标消费者
        </SectionTitle>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="年龄段 *">
            <input
              className={inputClass}
              value={form.audience.ageRange}
              disabled={disabled}
              placeholder="如：28–40"
              onChange={(e) => patchAudience({ ageRange: e.target.value })}
            />
          </Field>
          <Field label="性别比例 *">
            <input
              className={inputClass}
              value={form.audience.genderRatio}
              disabled={disabled}
              placeholder="如：女 7 : 男 3"
              onChange={(e) => patchAudience({ genderRatio: e.target.value })}
            />
          </Field>
          <Field label="所在地区 *">
            <ChipInput
              value={form.audience.regions}
              disabled={disabled}
              placeholder="回车添加"
              onChange={(regions) => patchAudience({ regions })}
            />
          </Field>
          <Field label="职业">
            <ChipInput
              value={form.audience.occupations}
              disabled={disabled}
              placeholder="回车添加，如：白领、自由职业"
              onChange={(occupations) => patchAudience({ occupations })}
            />
          </Field>
          <Field label="消费力">
            <input
              className={inputClass}
              value={form.audience.spendingPower}
              disabled={disabled}
              placeholder="如：中高"
              onChange={(e) => patchAudience({ spendingPower: e.target.value })}
            />
          </Field>
          <Field label="已知兴趣">
            <ChipInput
              value={form.audience.knownInterests}
              disabled={disabled}
              placeholder="回车添加，如：遛娃、露营"
              onChange={(knownInterests) => patchAudience({ knownInterests })}
            />
          </Field>
          <Field label="痛点" className="sm:col-span-2">
            <ChipInput
              value={form.audience.painPoints}
              disabled={disabled}
              placeholder="回车添加，如：周末不知道带孩子去哪"
              onChange={(painPoints) => patchAudience({ painPoints })}
            />
          </Field>
        </div>
      </div>

      <div className="flex flex-col gap-2">
        <SectionTitle>运营备注</SectionTitle>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
          <Field label="禁忌话题">
            <ChipInput
              value={form.opsNotes.forbiddenTopics}
              disabled={disabled}
              placeholder="回车添加"
              onChange={(forbiddenTopics) => patchOpsNotes({ forbiddenTopics })}
            />
          </Field>
          <Field label="重点关键词">
            <ChipInput
              value={form.opsNotes.boostKeywords}
              disabled={disabled}
              placeholder="回车添加"
              onChange={(boostKeywords) => patchOpsNotes({ boostKeywords })}
            />
          </Field>
          <Field label="避免的内容类型" className="sm:col-span-2">
            <ChipInput
              value={form.opsNotes.avoidContentTypes}
              disabled={disabled}
              placeholder="回车添加，如：低价促销、争议话题"
              onChange={(avoidContentTypes) =>
                patchOpsNotes({ avoidContentTypes })
              }
            />
          </Field>
        </div>
      </div>
    </CardShell>
  );
}
