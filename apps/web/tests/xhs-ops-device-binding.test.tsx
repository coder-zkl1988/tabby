// @vitest-environment jsdom

import type { XhsOpsDeviceBinding } from "@nexu/shared";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SurfaceManager } from "../src/lib/a2ui/a2ui-surface";
import type { SurfaceState } from "../src/lib/a2ui/a2ui-types";
import type { CustomComponentProps } from "../src/lib/a2ui/custom-components/registry";
import { XhsOpsAccountPlanner } from "../src/lib/a2ui/custom-components/xhs-ops/XhsOpsAccountPlanner";
import {
  type XhsOpsAccount,
  defaultBrowseDefaults,
  defaultInteractionConfig,
  emptyInterestPool,
  emptyPersona,
  emptyProfileDraft,
} from "../src/lib/a2ui/custom-components/xhs-ops/xhs-ops-types";

const apiMocks = vi.hoisted(() => ({
  getProject: vi.fn(),
  listAccounts: vi.fn(),
  listDeviceBindings: vi.fn(),
  createAccount: vi.fn(),
  updateAccount: vi.fn(),
  deleteAccount: vi.fn(),
  transferDevice: vi.fn(),
}));

const sdkMocks = vi.hoisted(() => ({ getDevices: vi.fn() }));

vi.mock("../src/lib/a2ui/custom-components/xhs-ops/xhs-ops-api", () => ({
  xhsOpsApi: apiMocks,
  describeXhsOpsError: (error: unknown, fallback: string) =>
    error instanceof Error ? error.message : fallback,
}));

vi.mock("../lib/api/sdk.gen", () => ({
  getApiV1Devices: sdkMocks.getDevices,
}));

function account(
  id: string,
  overrides: Partial<XhsOpsAccount> = {},
): XhsOpsAccount {
  return {
    id,
    projectId: "project-current",
    label: `账号 ${id}`,
    positioning: "羽毛球新手成长",
    persona: emptyPersona(),
    profileDraft: emptyProfileDraft(),
    deviceId: null,
    deviceName: null,
    interestPool: emptyInterestPool(),
    interaction: defaultInteractionConfig(),
    browseDefaults: defaultBrowseDefaults(),
    createdAt: "2026-09-08T00:00:00.000Z",
    updatedAt: "2026-09-08T00:00:00.000Z",
    ...overrides,
  };
}

function binding(
  overrides: Partial<XhsOpsDeviceBinding> = {},
): XhsOpsDeviceBinding {
  return {
    deviceId: "device-2",
    accountId: "account-old",
    accountLabel: "旧羽毛球账号",
    projectId: "project-old",
    projectName: "旧运营项目",
    canTransfer: true,
    blockingReason: null,
    ...overrides,
  };
}

function componentProps(
  overrides: Record<string, unknown> = {},
): CustomComponentProps {
  return {
    comp: {
      type: "XhsOpsAccountPlanner",
      projectId: "project-current",
      suggestions: [],
      ...overrides,
    },
    resolve: <T,>(value: T) => value,
    surface: {} as SurfaceState,
    manager: {} as SurfaceManager,
    onAction: vi.fn(),
  };
}

function renderWithQuery(element: ReactElement) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>{element}</QueryClientProvider>,
  );
}

function chooseDevice(deviceId = "device-2") {
  fireEvent.change(screen.getByRole("combobox"), {
    target: { value: deviceId },
  });
}

describe("XhsOpsAccountPlanner device bindings", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiMocks.getProject.mockResolvedValue({
      id: "project-current",
      name: "当前项目",
      profile: null,
      personaCount: 10,
      updatedAt: "2026-09-08T00:00:00.000Z",
    });
    apiMocks.listAccounts.mockResolvedValue([account("account-current")]);
    apiMocks.listDeviceBindings.mockResolvedValue([]);
    apiMocks.updateAccount.mockImplementation(async (id: string) =>
      account(id),
    );
    sdkMocks.getDevices.mockResolvedValue({
      data: {
        devices: [
          {
            deviceId: "device-1",
            name: "小红书专用1",
            status: "idle",
            lastSeen: Date.now(),
          },
          {
            deviceId: "device-2",
            name: "小红书专用2",
            status: "idle",
            lastSeen: Date.now(),
          },
        ],
      },
    });
  });

  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("shows the owning project and account for a cross-project binding", async () => {
    apiMocks.listDeviceBindings.mockResolvedValue([binding()]);
    renderWithQuery(<XhsOpsAccountPlanner {...componentProps()} />);

    await screen.findByDisplayValue("账号 account-current");
    const occupiedOption = screen.getByRole("option", {
      name: /小红书专用2.*旧运营项目 \/ 旧羽毛球账号/,
    });
    expect((occupiedOption as HTMLOptionElement).disabled).toBe(false);

    chooseDevice();
    expect(
      screen.getByText(/当前设备已绑定「旧运营项目 \/ 旧羽毛球账号」/),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "转移设备并保存此账号" }),
    ).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "保存账号配置" }));
    expect(
      await screen.findByText(/设备已绑定至「旧运营项目 \/ 旧羽毛球账号」/),
    ).toBeTruthy();
    expect(apiMocks.createAccount).not.toHaveBeenCalled();
    expect(apiMocks.updateAccount).not.toHaveBeenCalled();
  });

  it("does not write when the transfer confirmation is cancelled", async () => {
    apiMocks.listDeviceBindings.mockResolvedValue([binding()]);
    vi.spyOn(window, "confirm").mockReturnValue(false);
    renderWithQuery(<XhsOpsAccountPlanner {...componentProps()} />);

    await screen.findByDisplayValue("账号 account-current");
    chooseDevice();
    fireEvent.click(
      screen.getByRole("button", { name: "转移设备并保存此账号" }),
    );

    expect(window.confirm).toHaveBeenCalledWith(
      expect.stringContaining("旧账号及历史记录会保留"),
    );
    expect(apiMocks.transferDevice).not.toHaveBeenCalled();
    expect(apiMocks.createAccount).not.toHaveBeenCalled();
    expect(apiMocks.updateAccount).not.toHaveBeenCalled();
  });

  it("locks every card write while a device transfer is pending", async () => {
    apiMocks.listAccounts.mockResolvedValue([
      account("account-first"),
      account("account-second"),
    ]);
    apiMocks.listDeviceBindings.mockResolvedValue([
      binding({ deviceId: "device-1", accountId: "old-first" }),
      binding({ deviceId: "device-2", accountId: "old-second" }),
    ]);
    let resolveTransfer: ((value: XhsOpsAccount) => void) | undefined;
    apiMocks.transferDevice.mockImplementation(
      () =>
        new Promise<XhsOpsAccount>((resolve) => {
          resolveTransfer = resolve;
        }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithQuery(<XhsOpsAccountPlanner {...componentProps()} />);

    await screen.findByDisplayValue("账号 account-first");
    const selects = screen.getAllByRole("combobox") as HTMLSelectElement[];
    fireEvent.change(selects[0], { target: { value: "device-1" } });
    fireEvent.change(selects[1], { target: { value: "device-2" } });
    const transferButtons = screen.getAllByRole("button", {
      name: "转移设备并保存此账号",
    }) as HTMLButtonElement[];
    fireEvent.click(transferButtons[0]);
    await waitFor(() =>
      expect(apiMocks.transferDevice).toHaveBeenCalledTimes(1),
    );

    expect(
      (screen.getByDisplayValue("账号 account-first") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(selects.every((select) => select.disabled)).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "保存账号配置",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "新增账号" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "刷新设备绑定",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getAllByRole("button", {
          name: "删除账号",
        }) as HTMLButtonElement[]
      ).every((button) => button.disabled),
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "转移设备并保存此账号",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    resolveTransfer?.(
      account("account-first", {
        deviceId: "device-1",
        deviceName: "小红书专用1",
      }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "转移中…" })).toBeNull(),
    );
  });

  it("saves a transferred draft id and uses update on the next save", async () => {
    apiMocks.listAccounts.mockResolvedValue([]);
    apiMocks.listDeviceBindings
      .mockResolvedValueOnce([binding()])
      .mockResolvedValueOnce([]);
    const transferred = account("account-created", {
      label: "羽毛球新账号",
      deviceId: "device-2",
      deviceName: "小红书专用2",
    });
    apiMocks.transferDevice.mockResolvedValue(transferred);
    apiMocks.updateAccount.mockResolvedValue(transferred);
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithQuery(
      <XhsOpsAccountPlanner
        {...componentProps({
          suggestions: [
            {
              label: "羽毛球新账号",
              positioning: "羽毛球新手成长",
              persona: emptyPersona(),
              interestPool: emptyInterestPool(),
            },
          ],
        })}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: "加入" }));
    chooseDevice();
    fireEvent.click(
      screen.getByRole("button", { name: "转移设备并保存此账号" }),
    );
    await waitFor(() =>
      expect(apiMocks.transferDevice).toHaveBeenCalledTimes(1),
    );
    expect(apiMocks.transferDevice.mock.calls[0]?.[1]).toMatchObject({
      fromAccountId: "account-old",
      account: { label: "羽毛球新账号", deviceId: "device-2" },
    });
    expect(
      apiMocks.transferDevice.mock.calls[0]?.[1].account,
    ).not.toHaveProperty("profileDraft");

    await waitFor(() =>
      expect(apiMocks.listDeviceBindings).toHaveBeenCalledTimes(2),
    );
    fireEvent.click(screen.getByRole("button", { name: "保存账号配置" }));
    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledWith(
        "account-created",
        expect.objectContaining({ deviceId: "device-2" }),
      ),
    );
    expect(apiMocks.createAccount).not.toHaveBeenCalled();
  });

  it("refreshes an unfinished binding and enables transfer when it clears", async () => {
    apiMocks.listDeviceBindings
      .mockResolvedValueOnce([
        binding({
          canTransfer: false,
          blockingReason: "旧账号还有待执行或运行中的任务",
        }),
      ])
      .mockResolvedValueOnce([binding()]);
    apiMocks.transferDevice.mockResolvedValue(
      account("account-current", {
        deviceId: "device-2",
        deviceName: "小红书专用2",
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    renderWithQuery(<XhsOpsAccountPlanner {...componentProps()} />);

    await screen.findByDisplayValue("账号 account-current");
    fireEvent.change(screen.getByDisplayValue("账号 account-current"), {
      target: { value: "未保存的新账号名" },
    });
    chooseDevice();
    expect(screen.getByText(/旧账号还有待执行或运行中的任务/)).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "转移设备并保存此账号",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "刷新设备绑定" }));
    await waitFor(() =>
      expect(apiMocks.listDeviceBindings).toHaveBeenCalledTimes(2),
    );
    const transfer = screen.getByRole("button", {
      name: "转移设备并保存此账号",
    }) as HTMLButtonElement;
    expect(transfer.disabled).toBe(false);
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "device-2",
    );
    expect(screen.getByDisplayValue("未保存的新账号名")).toBeTruthy();

    fireEvent.click(transfer);
    await waitFor(() =>
      expect(apiMocks.transferDevice).toHaveBeenCalledTimes(1),
    );
  });

  it("blocks bound rows when bindings fail but still saves unbound rows", async () => {
    apiMocks.listAccounts.mockResolvedValue([
      account("account-bound", { deviceId: "device-1" }),
      account("account-unbound"),
    ]);
    apiMocks.listDeviceBindings.mockRejectedValue(
      new Error("绑定服务暂不可用"),
    );
    apiMocks.updateAccount.mockImplementation(async (id: string) =>
      account(id),
    );
    renderWithQuery(<XhsOpsAccountPlanner {...componentProps()} />);

    await screen.findByText(/绑定服务暂不可用.*绑定设备的账号暂不能保存/);
    fireEvent.click(screen.getByRole("button", { name: "保存账号配置" }));

    await waitFor(() =>
      expect(apiMocks.updateAccount).toHaveBeenCalledTimes(1),
    );
    expect(apiMocks.updateAccount).toHaveBeenCalledWith(
      "account-unbound",
      expect.objectContaining({
        deviceId: null,
        expectedUpdatedAt: "2026-09-08T00:00:00.000Z",
      }),
    );
    expect(screen.getByRole("button", { name: "刷新设备绑定" })).toBeTruthy();
    expect(
      screen.getByText(/设备绑定信息不可用，请重试加载后再保存/),
    ).toBeTruthy();
  });

  it("prevents creating accounts when the account list fails", async () => {
    apiMocks.listAccounts.mockRejectedValue(new Error("账号列表不可用"));
    renderWithQuery(
      <XhsOpsAccountPlanner
        {...componentProps({
          suggestions: [
            {
              label: "不可创建的草稿",
              positioning: "",
              persona: emptyPersona(),
              interestPool: emptyInterestPool(),
            },
          ],
        })}
      />,
    );

    await screen.findByText("账号列表不可用");
    expect(
      (screen.getByRole("button", { name: "加入" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole("button", { name: "新增账号" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "保存账号配置",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByRole("button", { name: "重新加载账号" })).toBeTruthy();
  });

  it("drops an unsaved draft when the planner switches projects", async () => {
    apiMocks.listAccounts.mockResolvedValueOnce([]).mockResolvedValueOnce([
      account("account-next", {
        projectId: "project-next",
        label: "新项目账号",
      }),
    ]);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const suggestions = [
      {
        label: "旧项目未保存草稿",
        positioning: "",
        persona: emptyPersona(),
        interestPool: emptyInterestPool(),
      },
    ];
    const { rerender } = render(
      <QueryClientProvider client={client}>
        <XhsOpsAccountPlanner {...componentProps({ suggestions })} />
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("button", { name: "加入" }));
    expect(screen.getByDisplayValue("旧项目未保存草稿")).toBeTruthy();

    rerender(
      <QueryClientProvider client={client}>
        <XhsOpsAccountPlanner
          {...componentProps({
            projectId: "project-next",
            suggestions: [],
          })}
        />
      </QueryClientProvider>,
    );

    expect(await screen.findByDisplayValue("新项目账号")).toBeTruthy();
    expect(screen.queryByDisplayValue("旧项目未保存草稿")).toBeNull();
  });
});
