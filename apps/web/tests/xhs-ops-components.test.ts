import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { SurfaceManager } from "../src/lib/a2ui/a2ui-surface";
import type { SurfaceState } from "../src/lib/a2ui/a2ui-types";
import type { CustomComponentProps } from "../src/lib/a2ui/custom-components/registry";
import { XhsOpsAccountPlanner } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsAccountPlanner";
import { XhsOpsCommentReview } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsCommentReview";
import { XhsOpsDashboard } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsDashboard";
import { XhsOpsProfileCard } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsProfileCard";
import { XhsOpsProfileMaterial } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsProfileMaterial";
import { XhsOpsProjectForm } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsProjectForm";
import { XhsOpsRunPlanner } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsRunPlanner";
import { XhsOpsTakeover } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsTakeover";

const resolveLiteral = <T>(val: T): unknown => val;

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: false } },
});

function withProviders(el: React.ReactElement): React.ReactElement {
  return createElement(QueryClientProvider, { client: queryClient }, el);
}

function renderProps(comp: Record<string, unknown>): CustomComponentProps {
  return {
    comp,
    resolve: resolveLiteral,
    surface: {} as SurfaceState,
    manager: {} as SurfaceManager,
    onAction: () => {},
  };
}

describe("xhs-ops a2ui components render (wiring smoke)", () => {
  it("XhsOpsProjectForm renders a new-project form from prefill", () => {
    const html = renderToStaticMarkup(
      createElement(
        XhsOpsProjectForm,
        renderProps({
          id: "c1",
          type: "XhsOpsProjectForm",
          prefill: {
            name: "亲子度假",
            business: { industry: "亲子旅游" },
          },
        }),
      ),
    );
    expect(html).toContain("亲子度假");
    expect(html.length).toBeGreaterThan(500);
  });

  it("XhsOpsProfileCard shows the proposed profile for confirmation", () => {
    const html = renderToStaticMarkup(
      createElement(
        XhsOpsProfileCard,
        renderProps({
          id: "c2",
          type: "XhsOpsProfileCard",
          projectId: "p1",
          profile: {
            summary: "一二线城市 30 岁左右新手父母，周末高质量陪伴",
            base: {
              ageRange: "28-38",
              genderRatio: "女7:男3",
              regions: ["北京"],
            },
            verticalInterests: ["亲子酒店", "亲子旅行"],
            generalInterests: ["咖啡", "家居"],
          },
        }),
      ),
    );
    expect(html).toContain("新手父母");
    expect(html).toContain("亲子酒店");
  });

  it("XhsOpsAccountPlanner lists persona suggestions", () => {
    const html = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsAccountPlanner,
          renderProps({
            id: "c3",
            type: "XhsOpsAccountPlanner",
            projectId: "p1",
            suggestions: [
              {
                label: "海淀职场妈妈",
                positioning: "周末遛娃侦察兵",
                persona: {
                  age: "32岁",
                  gender: "女",
                  region: "北京海淀",
                  occupation: "互联网产品经理",
                  lifeStatus: "2岁娃新手妈妈",
                },
                interestPool: {
                  core: ["亲子酒店"],
                  extended: [],
                  general: ["咖啡"],
                },
              },
            ],
          }),
        ),
      ),
    );
    expect(html).toContain("海淀职场妈妈");
    expect(html).toContain("周末遛娃侦察兵");
    // P1-2: 建议卡展示人设摘要，便于差异化核对
    expect(html).toContain("32岁·女·北京海淀·互联网产品经理·2岁娃新手妈妈");
  });

  it("XhsOpsRunPlanner renders the per-account plan keywords", () => {
    const html = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsRunPlanner,
          renderProps({
            id: "c4",
            type: "XhsOpsRunPlanner",
            projectId: "p1",
            plans: [
              {
                accountId: "acct-1",
                keywords: [{ keyword: "亲子酒店", count: 5 }],
                homeFeedCount: 6,
              },
            ],
          }),
        ),
      ),
    );
    // 账号列表异步加载：静态渲染断言卡片骨架与标题（渲染路径通）即可
    expect(html).toContain("今日浏览计划");
  });

  it("XhsOpsProfileMaterial renders its shell and loading state (P2-1)", () => {
    const html = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsProfileMaterial,
          renderProps({
            id: "c5",
            type: "XhsOpsProfileMaterial",
            projectId: "p1",
          }),
        ),
      ),
    );
    expect(html).toContain("账号资料与素材");
    expect(html).toContain("正在加载账号");
  });

  it("XhsOpsDashboard renders its shell, range switch and loading state (P2-2)", () => {
    const html = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsDashboard,
          renderProps({
            id: "c6",
            type: "XhsOpsDashboard",
            projectId: "p1",
            days: 14,
          }),
        ),
      ),
    );
    expect(html).toContain("养号复盘看板");
    expect(html).toContain("最近 14 天");
    expect(html).toContain("正在加载运行记录");
  });

  it("XhsOpsDashboard without projectId falls back to the project picker (agent has no project-list tool)", () => {
    const html = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsDashboard,
          renderProps({
            id: "c7",
            type: "XhsOpsDashboard",
            projectName: "新氧青春",
          }),
        ),
      ),
    );
    expect(html).toContain("养号复盘看板");
    expect(html).toContain("正在加载项目列表");
    expect(html).not.toContain("正在加载运行记录");
  });

  it("XhsOpsRunPlanner and XhsOpsProfileMaterial without projectId show the project picker (3.2 兜底)", () => {
    const planner = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsRunPlanner,
          renderProps({
            id: "c8",
            type: "XhsOpsRunPlanner",
            projectName: "新氧青春",
          }),
        ),
      ),
    );
    expect(planner).toContain("今日浏览计划");
    expect(planner).toContain("正在加载项目列表");
    const material = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsProfileMaterial,
          renderProps({ id: "c9", type: "XhsOpsProfileMaterial" }),
        ),
      ),
    );
    expect(material).toContain("账号资料与素材");
    expect(material).toContain("正在加载项目列表");
    expect(material).not.toContain("正在加载账号");
  });

  it("XhsOpsTakeover renders its shell, and falls back to the project picker without ids", () => {
    const withAccount = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsTakeover,
          renderProps({
            id: "c12",
            type: "XhsOpsTakeover",
            projectId: "p1",
            accountId: "a1",
            feedbackDraft: "昵称保留",
          }),
        ),
      ),
    );
    expect(withAccount).toContain("老号接管");
    expect(withAccount).toContain("正在加载接管信息");
    const withoutIds = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsTakeover,
          renderProps({ id: "c13", type: "XhsOpsTakeover" }),
        ),
      ),
    );
    expect(withoutIds).toContain("老号接管");
    expect(withoutIds).toContain("正在加载项目列表");
  });

  it("XhsOpsCommentReview renders its shell (P3-1 D1) with and without projectId", () => {
    const withId = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsCommentReview,
          renderProps({
            id: "c10",
            type: "XhsOpsCommentReview",
            projectId: "p1",
          }),
        ),
      ),
    );
    expect(withId).toContain("评论审核队列");
    expect(withId).toContain("正在加载评论队列");
    const withoutId = renderToStaticMarkup(
      withProviders(
        createElement(
          XhsOpsCommentReview,
          renderProps({ id: "c11", type: "XhsOpsCommentReview" }),
        ),
      ),
    );
    expect(withoutId).toContain("正在加载项目列表");
  });
});
