// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  type XhsOpsPreparation,
  XhsOpsPreparationStatus,
} from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsPreparationStatus";

const BASE: Omit<XhsOpsPreparation, "status" | "reason"> = {
  taskId: null,
  reasonCode: null,
  startedAt: "2026-09-08T10:00:00.000Z",
  completedAt: null,
};

describe("XhsOpsPreparationStatus", () => {
  afterEach(() => cleanup());

  it.each([
    ["running", "检查安装与登录"],
    ["ready", "已就绪"],
    ["blocked", "待人工处理"],
    ["failed", "失败"],
    ["cancelled", "已取消"],
    ["interrupted", "已中断"],
  ] as const)("shows the %s preparation state", (status, label) => {
    render(
      <XhsOpsPreparationStatus
        preparation={{ ...BASE, status, reason: null }}
      />,
    );
    expect(screen.getByText(`启动检查：${label}`)).toBeTruthy();
  });

  it("shows the controller reason for a preparation that needs attention", () => {
    render(
      <XhsOpsPreparationStatus
        preparation={{
          ...BASE,
          status: "blocked",
          reason: "需要在手机上完成登录后重试",
        }}
      />,
    );
    expect(screen.getByText(/需要在手机上完成登录后重试/)).toBeTruthy();
  });

  it("renders nothing before preparation starts", () => {
    const { container } = render(
      <XhsOpsPreparationStatus preparation={null} />,
    );
    expect(container.innerHTML).toBe("");
  });
});
