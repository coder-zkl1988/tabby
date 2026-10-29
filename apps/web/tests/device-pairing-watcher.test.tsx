/**
 * @vitest-environment jsdom
 *
 * iTabby LAN pairing: a phone that found this desktop over mDNS waits for the
 * user to compare the 6-digit code and allow or reject it. The prompt is
 * app-wide (mounted in AuthLayout) and must go away by itself when the phone
 * cancels or the request expires — i.e. when the request leaves the list.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => ({
  getApiV1DevicesPairingRequests: vi.fn(),
  postApiV1DevicesPairingRequestsByRequestIdApprove: vi.fn(),
  postApiV1DevicesPairingRequestsByRequestIdReject: vi.fn(),
}));

vi.mock("../lib/api/sdk.gen", () => sdk);
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  DevicePairingWatcher,
  deviceLabel,
} from "../src/components/device-pairing-watcher";

const REQUEST = {
  requestId: "pr_1",
  code: "482913",
  deviceId: "24094RAD4C-8a1f",
  model: "24094RAD4C",
  manufacturer: "Xiaomi",
  createdAt: 1,
  expiresAt: 2,
};

function renderWatcher() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <DevicePairingWatcher />
    </QueryClientProvider>,
  );
}

describe("DevicePairingWatcher", () => {
  let pending: (typeof REQUEST)[];

  beforeEach(() => {
    pending = [REQUEST];
    sdk.getApiV1DevicesPairingRequests.mockImplementation(async () => ({
      data: { enabled: true, requests: pending },
    }));
    sdk.postApiV1DevicesPairingRequestsByRequestIdApprove.mockImplementation(
      async () => {
        pending = [];
        return { data: { ok: true } };
      },
    );
    sdk.postApiV1DevicesPairingRequestsByRequestIdReject.mockImplementation(
      async () => {
        pending = [];
        return { data: { ok: true } };
      },
    );
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("shows the device and the verification code", async () => {
    renderWatcher();
    expect(await screen.findByText("devices.pairing.title")).toBeTruthy();
    expect(screen.getByTestId("device-pairing-code").textContent).toBe(
      "482913",
    );
    expect(screen.getByText("Xiaomi 24094RAD4C")).toBeTruthy();
  });

  it("approves the request and closes once it is no longer pending", async () => {
    renderWatcher();
    fireEvent.click(await screen.findByText("devices.pairing.approve"));
    await waitFor(() =>
      expect(
        sdk.postApiV1DevicesPairingRequestsByRequestIdApprove,
      ).toHaveBeenCalledWith({ path: { requestId: "pr_1" } }),
    );
    await waitFor(() =>
      expect(screen.queryByText("devices.pairing.title")).toBeNull(),
    );
    expect(
      sdk.postApiV1DevicesPairingRequestsByRequestIdReject,
    ).not.toHaveBeenCalled();
  });

  it("rejects the request", async () => {
    renderWatcher();
    fireEvent.click(await screen.findByText("devices.pairing.reject"));
    await waitFor(() =>
      expect(
        sdk.postApiV1DevicesPairingRequestsByRequestIdReject,
      ).toHaveBeenCalledWith({ path: { requestId: "pr_1" } }),
    );
  });

  it("disappears when the phone cancels or the request expires", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      renderWatcher();
      expect(await screen.findByText("devices.pairing.title")).toBeTruthy();
      pending = [];
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2500);
      });
      await waitFor(() =>
        expect(screen.queryByText("devices.pairing.title")).toBeNull(),
      );
      expect(
        sdk.postApiV1DevicesPairingRequestsByRequestIdReject,
      ).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("labels a device without manufacturer/model by its id", () => {
    expect(deviceLabel({ manufacturer: "", model: " ", deviceId: "d-1" })).toBe(
      "d-1",
    );
  });
});
