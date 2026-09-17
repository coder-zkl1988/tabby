/**
 * TEMPORARY acceptance page for the "A2UI 优化版" design pass.
 * Not wired into the app; delete after review.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { SurfaceManager } from "./lib/a2ui/a2ui-surface";
import type { SurfaceState } from "./lib/a2ui/a2ui-types";
import type { CustomComponentProps } from "./lib/a2ui/custom-components/registry";
import "./index.css";
import "./lib/a2ui/a2ui.css";
import { ExpertCardFace } from "./components/experts/expert-card";
import {
  EmptyState,
  Skeleton,
  Spinner,
  StatusMark,
  StatusPill,
  type StatusTone,
} from "./lib/a2ui/a2ui-status";
import { ExpertInstallCard } from "./lib/a2ui/custom-components/ExpertInstallCard";
import { TeamRunCard } from "./lib/a2ui/custom-components/TeamRunCard";
import { XHSEditor } from "./lib/a2ui/custom-components/XHSEditor";
import { XhsOpsDashboard } from "./lib/a2ui/custom-components/xhs-ops/XhsOpsDashboard";
import { xhsOpsApi } from "./lib/a2ui/custom-components/xhs-ops/xhs-ops-api";
import {
  CardShell,
  ChipInput,
  ErrorLine,
  Field,
  HintLine,
  PrimaryButton,
  SecondaryButton,
  SectionTitle,
  inputClass,
  selectClass,
  textareaClass,
} from "./lib/a2ui/custom-components/xhs-ops/xhs-ops-ui";

// ── Fixtures ────────────────────────────────────────────────────
const qc = new QueryClient({
  defaultOptions: { queries: { retry: false, refetchInterval: false } },
});

const TEAM_ID = "team_demo";
qc.setQueryData(["teams", TEAM_ID, "board"], {
  cards: [
    { id: "card_1", status: "done", output: "调研完成" },
    { id: "card_2", status: "running" },
    { id: "card_3", status: "pending" },
  ],
});
qc.setQueryData(["devices"], {
  devices: [
    { deviceId: "d1", name: "Pixel 7", status: "idle", lastSeen: Date.now() },
  ],
});
qc.setQueryData(["teams", TEAM_ID, "workflow-approvals"], {
  approvals: [
    {
      teamId: TEAM_ID,
      workflowId: "wf_1",
      runId: "run_1",
      stepId: "s3",
      prompt: "三篇笔记已就绪，确认口吻后再发布",
    },
  ],
});

const TEAM_RUN = {
  teamId: TEAM_ID,
  boardId: "b1",
  parentCardId: "card_0",
  title: "九月新品种草内容",
  runId: "run_1",
  workflowId: "wf_1",
  steps: [
    {
      id: "s1",
      name: "竞品与话题调研",
      assigneeName: "研究员",
      cardId: "card_1",
      dependsOn: [],
    },
    {
      id: "s2",
      name: "撰写三篇笔记",
      assigneeName: "写手",
      cardId: "card_2",
      dependsOn: ["s1"],
    },
    {
      id: "s3",
      name: "发布前审核",
      assigneeName: "主管",
      cardId: "card_3",
      dependsOn: ["s2"],
      type: "approval",
    },
  ],
};

const DATES = [
  "2026-09-06",
  "2026-09-07",
  "2026-09-08",
  "2026-09-09",
  "2026-09-10",
] as const;

function run(
  id: string,
  accountId: string,
  date: string,
  status: string,
  planned: number,
  browsed: number,
  home: number,
  interactions: number,
  anomalies: number,
) {
  return {
    id,
    projectId: "p1",
    accountId,
    date,
    status,
    createdAt: `${date}T09:00:00.000Z`,
    plan: { chunks: [] },
    summary: {
      plannedTotal: planned,
      browsedTotal: browsed,
      homeBrowsed: home,
      anomalyCount: anomalies,
      interactions: { like: interactions, collect: 0, follow: 0 },
    },
  };
}

const RUNS = [
  run("r1", "a1", DATES[1], "completed", 40, 40, 14, 12, 0),
  run("r2", "a1", DATES[2], "completed", 40, 36, 11, 8, 1),
  run("r3", "a1", DATES[3], "completed", 40, 40, 13, 10, 0),
  run("r4", "a1", DATES[4], "running", 20, 9, 0, 7, 1),
  run("r5", "a2", DATES[1], "completed", 30, 12, 4, 3, 1),
  run("r6", "a2", DATES[2], "completed", 30, 30, 9, 8, 0),
];

Object.assign(xhsOpsApi, {
  listProjects: async () => [{ id: "p1", name: "新氧青春·亲子度假" }],
  getProject: async () => ({
    id: "p1",
    name: "新氧青春·亲子度假",
    business: { industry: "亲子 / 度假" },
  }),
  listAccounts: async () => [
    { id: "a1", projectId: "p1", label: "遛娃日历", deviceId: "d1" },
    { id: "a2", projectId: "p1", label: "周末去哪儿" },
  ],
  listRuns: async () => RUNS,
  listComments: async () => [],
});

function props(comp: Record<string, unknown>): CustomComponentProps {
  return {
    comp: comp as unknown as CustomComponentProps["comp"],
    resolve: <T,>(v: T): unknown => v,
    surface: {} as SurfaceState,
    manager: {} as SurfaceManager,
    onAction: () => {},
  };
}

// ── Page chrome ─────────────────────────────────────────────────
const TONES: Array<[StatusTone, string]> = [
  ["running", "团队执行中"],
  ["done", "已完成"],
  ["blocked", "有步骤受阻"],
  ["waiting", "等待审批"],
  ["failed", "未分配在线设备"],
  ["idle", "待执行"],
];

function Section({
  n,
  title,
  note,
  children,
}: {
  n: string;
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-6">
      <div className="flex items-baseline gap-3 border-b border-border-subtle pb-3">
        <span className="font-mono text-[13px] font-semibold text-[var(--color-brand-primary)]">
          {n}
        </span>
        <h2 className="text-[24px] font-bold tracking-[-0.01em] text-text-heading">
          {title}
        </h2>
        {note ? (
          <span className="text-[12px] text-text-secondary">{note}</span>
        ) : null}
      </div>
      {children}
    </section>
  );
}

function Panel({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <span className="font-mono text-[12px] font-semibold uppercase tracking-[0.08em] text-text-secondary">
        {label}
      </span>
      <div className="flex flex-col items-start gap-4 rounded-xl border border-border-subtle bg-surface-1 p-5">
        {children}
      </div>
    </div>
  );
}

function Gallery() {
  return (
    <div className="mx-auto flex max-w-[1100px] flex-col gap-16 px-8 py-14">
      <header className="flex flex-col gap-4">
        <div className="flex items-center gap-2.5">
          <span className="size-2.5 rounded-full bg-[var(--color-brand-primary)]" />
          <span className="font-mono text-[12px] font-medium uppercase tracking-[0.14em] text-text-secondary">
            Implementation
          </span>
        </div>
        <h1 className="text-[44px] font-extrabold leading-[1.05] tracking-[-0.02em] text-text-heading">
          A2UI 优化版 · 落地验收
        </h1>
        <p className="max-w-[660px] text-[14px] leading-[1.7] text-text-secondary">
          下面每一块都是仓库里的真实组件 + 真实 index.css / a2ui.css
          渲染的，不是重新画的稿。数据是 fixture。
        </p>
      </header>

      <Section n="01" title="色彩用量" note="四个色义 + 品牌色进「进行中」">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-5">
          <Panel label="StatusPill · 六种状态">
            {TONES.map(([tone, label]) => (
              <StatusPill key={tone} tone={tone}>
                {label}
              </StatusPill>
            ))}
            <p className="text-[12px] leading-[1.6] text-text-secondary">
              形状也参与表意：实心圆 = 完成，脉冲圆 = 进行中，菱形 =
              受阻，双竖线 = 待审批，方块 = 失败，空心圆 = 未开始。
            </p>
          </Panel>
          <Panel label="StatusMark · 表格 / 步骤行复用">
            {TONES.map(([tone, label]) => (
              <span
                key={tone}
                className="flex items-center gap-2.5 text-[13px] text-text-primary"
              >
                <StatusMark tone={tone} />
                {label}
              </span>
            ))}
          </Panel>
        </div>
      </Section>

      <Section n="02" title="字号阶梯" note="7 档，全部 px">
        <Panel label="24 / 18 / 15 / 14 / 13 / 12 / 12-mono">
          <div className="flex w-full flex-col gap-3">
            {[
              [
                "页标题",
                "text-[24px] font-bold leading-[1.2]",
                "24 / 700 / 1.2",
              ],
              [
                "卡片标题",
                "text-[18px] font-semibold leading-[1.35]",
                "18 / 600 / 1.35",
              ],
              [
                "区块标题",
                "text-[15px] font-semibold leading-[1.4]",
                "15 / 600 / 1.4",
              ],
              [
                "强调正文",
                "text-[14px] font-medium leading-[1.5]",
                "14 / 500 / 1.5",
              ],
              ["正文", "text-[13px] leading-[1.55]", "13 / 400 / 1.55"],
              [
                "辅助说明",
                "text-[12px] leading-[1.5] text-text-secondary",
                "12 / 400 / 1.5",
              ],
            ].map(([label, cls, spec]) => (
              <div
                key={spec}
                className="flex items-baseline justify-between gap-3"
              >
                <span className={`${cls} text-text-heading`}>{label}</span>
                <span className="font-mono text-[12px] text-text-secondary">
                  {spec}
                </span>
              </div>
            ))}
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-[12px] font-medium text-text-primary">
                1 234 · 92%
              </span>
              <span className="font-mono text-[12px] text-text-secondary">
                12 / 500 / mono
              </span>
            </div>
          </div>
        </Panel>
      </Section>

      <Section n="03" title="控件尺寸" note="28 表格内 / 36 表单 / 44 主操作">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-5">
          <Panel label="表单组 · 全 36，label 12">
            <div className="flex w-full flex-col gap-3">
              <Field label="项目名称">
                <input
                  className={inputClass}
                  defaultValue="新氧青春·亲子度假"
                />
              </Field>
              <Field label="行业">
                <select className={selectClass} defaultValue="亲子 / 度假">
                  <option>亲子 / 度假</option>
                </select>
              </Field>
              <Field label="核心关键词">
                <ChipInput
                  value={["亲子酒店", "遛娃好去处"]}
                  onChange={() => {}}
                />
              </Field>
              <Field label="备注">
                <textarea
                  className={textareaClass}
                  rows={2}
                  defaultValue="泳池水温这点太重要了"
                />
              </Field>
            </div>
          </Panel>
          <Panel label="审批对 · 批准优先，两个都 36">
            <div className="flex flex-wrap items-center gap-2">
              <PrimaryButton onClick={() => {}}>批准</PrimaryButton>
              <SecondaryButton onClick={() => {}} danger>
                拒绝
              </SecondaryButton>
              <span className="ml-auto text-[12px] text-text-secondary">
                批准后由你手动派发
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <PrimaryButton onClick={() => {}}>
                <Spinner />
                批准中
              </PrimaryButton>
              <SecondaryButton onClick={() => {}} disabled>
                拒绝
              </SecondaryButton>
            </div>
            <div className="flex w-full flex-col gap-3 border-t border-border-subtle pt-4">
              <button
                type="button"
                className="a2ui-button a2ui-button--primary"
              >
                a2ui Primary
              </button>
              <button
                type="button"
                className="a2ui-button a2ui-button--secondary"
              >
                a2ui Secondary
              </button>
              <button
                type="button"
                className="a2ui-button a2ui-button--outlined"
              >
                a2ui Outlined · hover 加深边框
              </button>
              <button type="button" className="a2ui-button a2ui-button--text">
                a2ui Text · hover 只变底
              </button>
            </div>
          </Panel>
        </div>
      </Section>

      <Section n="04" title="加载与空态" note="骨架 / 空态 / 按钮内反馈">
        <div className="grid grid-cols-[repeat(auto-fit,minmax(320px,1fr))] gap-5">
          <Panel label="Skeleton">
            <div className="w-full">
              <Skeleton rows={3} label="正在加载运行记录" />
            </div>
          </Panel>
          <Panel label="EmptyState / ErrorLine / HintLine">
            <div className="flex w-full flex-col gap-3">
              <EmptyState>
                队列为空。从下方最近的浏览记录里挑帖子生成候选，或等手机在浏览时标注「值得评」的帖子。
              </EmptyState>
              <ErrorLine message="设备列表加载失败，稍后自动重试" />
              <HintLine>已批准的评论由你手动派发到手机</HintLine>
            </div>
          </Panel>
        </div>
      </Section>

      <Section n="05" title="业务卡片" note="真实组件 + fixture 数据">
        <div className="flex flex-wrap items-start gap-6">
          <Panel label="TeamRunCard · 360 宽 / StatusPill / 审批 36">
            <TeamRunCard
              {...props({ id: "x", type: "TeamRunCard", run: TEAM_RUN })}
            />
          </Panel>
          <Panel label="ExpertInstallCard · 动作出卡">
            <ExpertInstallCard
              {...props({
                id: "y",
                type: "ExpertInstallCard",
                expert: {
                  slug: "xhs-ops",
                  name: "小红书养号运营",
                  emoji: "🌱",
                  category: "Marketing",
                  description: "按目标人群搭建兴趣池，安排每日浏览节奏",
                  tags: ["养号", "人设"],
                  version: "1.0.0",
                  author: "nexu",
                },
                question: "怎么养号",
              })}
            />
          </Panel>
        </div>
      </Section>

      <Section
        n="06"
        title="CardShell · 八卡共壳"
        note="20/14 顶栏 · 20/16 正文 · 15+12"
      >
        <CardShell
          testId="demo"
          title="评论审核队列"
          subtitle="桌面按帖子生成候选，每条评论都要人工批准；配额 = min(每日上限, 5, 今日浏览÷8)"
          actions={<StatusPill tone="blocked">2 条待审</StatusPill>}
        >
          <SectionTitle hint="2 条待审核">待审核</SectionTitle>
          <div className="flex flex-col gap-3 rounded-[10px] border border-border bg-surface-1 p-3.5 text-[13px]">
            <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
              <span className="text-[14px] font-medium text-text-primary">
                遛娃日历
              </span>
              <span className="text-[12px] text-text-secondary">
                带娃住了三晚，这家亲子酒店真的值
              </span>
            </div>
            <textarea
              className={textareaClass}
              rows={2}
              defaultValue="泳池水温这点太重要了，我们上次去的那家水凉到娃只泡了十分钟"
            />
            <div className="flex flex-wrap items-center gap-2">
              <PrimaryButton onClick={() => {}}>批准</PrimaryButton>
              <SecondaryButton onClick={() => {}} danger>
                拒绝
              </SecondaryButton>
              <span className="ml-auto text-[12px] text-text-secondary">
                批准后由你手动派发
              </span>
            </div>
          </div>
        </CardShell>
      </Section>

      <Section
        n="07"
        title="XhsOpsDashboard"
        note="达成率领头 · 矩阵格保留首页推荐数 + 完成度条"
      >
        <XhsOpsDashboard
          {...props({
            id: "z",
            type: "XhsOpsDashboard",
            projectId: "p1",
            days: 7,
          })}
        />
      </Section>

      <Section
        n="09"
        title="布局边界 · 320px 宿主"
        note="V2 新增：侧栏可拖到 320，画布 a2ui 节点 380"
      >
        <div className="flex flex-wrap items-start gap-6">
          <Panel label="TeamRunCard · w-full max-w-[360px]">
            <div className="w-[320px] overflow-hidden rounded-[20px] border border-border bg-surface-1">
              <TeamRunCard
                {...props({ id: "x2", type: "TeamRunCard", run: TEAM_RUN })}
              />
            </div>
          </Panel>
          <Panel label="ExpertCardFace · 专家页网格下限 192px">
            <div className="w-[192px]">
              <ExpertCardFace
                expert={{
                  slug: "xhs-ops",
                  name: "小红书养号运营",
                  emoji: "\ud83c\udf31",
                  category: "Marketing",
                  description: "按目标人群搭建兴趣池，安排每日浏览节奏",
                  tags: ["养号", "人设", "复盘"],
                  version: "1.0.0",
                  author: "nexu",
                }}
                footerActions={
                  <button
                    type="button"
                    className="shrink-0 rounded-md border border-[var(--color-accent)] bg-[var(--color-accent)] px-2 py-0.5 text-[10px] font-bold text-[var(--color-accent-fg)]"
                  >
                    安装
                  </button>
                }
              />
            </div>
          </Panel>
          <Panel label="XHSEditor · auto-fill minmax(64px,1fr)">
            <div className="w-[320px] overflow-hidden rounded-xl border border-border bg-surface-1">
              <XHSEditor
                {...props({
                  id: "e1",
                  type: "XHSEditor",
                  title: "带娃住了三晚，这家亲子酒店真的值",
                  content:
                    "周五下班直接杀到酒店，前台办入住的时候娃已经冲进儿童乐园了。",
                  images: [],
                  hashtags: ["亲子酒店", "遛娃好去处"],
                  deviceId: "d1",
                })}
              />
            </div>
          </Panel>
          <Panel label="XhsOpsDashboard · @container < 480px">
            <div className="w-[320px]">
              <XhsOpsDashboard
                {...props({
                  id: "z2",
                  type: "XhsOpsDashboard",
                  projectId: "p1",
                  days: 7,
                })}
              />
            </div>
          </Panel>
        </div>
      </Section>

      <Section n="08" title="对话流嵌套" note="宿主让位，卡片贴合 20px 气泡">
        {/* 704px = the real chat column the design measured. */}
        <div className="flex w-[704px] max-w-full gap-3">
          <div className="size-9 shrink-0 rounded-full bg-gradient-to-br from-[#f9d77e] to-[#c05c28]" />
          <div className="flex min-w-0 flex-1 flex-col gap-2">
            <div className="inline-block max-w-full rounded-[20px] border border-border bg-surface-1 px-4 py-3 text-[13px] shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
              看板拉出来了。
            </div>
            <div className="a2ui-inline-host mt-1 w-full min-w-[20rem] max-w-full rounded-[20px] border border-border bg-surface-1 px-4 py-4 shadow-[0_10px_24px_rgba(15,23,42,0.04)]">
              <div className="a2ui-surfaces">
                <div className="a2ui-surface">
                  <CardShell
                    testId="nested"
                    title="养号复盘看板"
                    subtitle="最近 7 天"
                  >
                    <div className="h-9 rounded-lg bg-surface-2" />
                    <div className="h-9 rounded-lg bg-surface-2" />
                  </CardShell>
                </div>
              </div>
            </div>
            <span className="pl-1 text-[12px] text-text-secondary">
              可用宽度 672 → 704，边框只剩一圈
            </span>
          </div>
        </div>
      </Section>
    </div>
  );
}

// biome-ignore lint/style/noNonNullAssertion: gallery entry, root is in the html
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={qc}>
      <Gallery />
    </QueryClientProvider>
  </StrictMode>,
);
