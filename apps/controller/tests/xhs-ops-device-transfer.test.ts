import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import type { DeviceInfo } from "@nexu/shared";
import { afterEach, describe, expect, it } from "vitest";
import type { ControllerContainer } from "../src/app/container.js";
import { registerXhsOpsRoutes } from "../src/routes/xhs-ops-routes.js";
import { type XhsOpsRunSeed, XhsOpsStore } from "../src/store/xhs-ops-store.js";
import type { ControllerBindings } from "../src/types.js";

const directories: string[] = [];
const interaction = {
  like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  comment: { enabled: false, dailyCap: 0 },
};

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "xhs-device-transfer-"));
  directories.push(directory);
  const file = join(directory, "state.json");
  let id = 0;
  const store = new XhsOpsStore(file, {
    now: () => "2026-09-08T10:00:00.000Z",
    genId: () => `id-${++id}`,
  });
  return { store, file };
}

function plannedRun(
  projectId: string,
  accountId: string,
  deviceId: string,
): XhsOpsRunSeed {
  return {
    projectId,
    accountId,
    deviceId,
    accountLabel: "source",
    date: "2026-09-08",
    status: "planned",
    plan: {
      keywords: [{ keyword: "羽毛球", count: 1 }],
      homeFeedCount: 0,
      dwellSecMin: 10,
      dwellSecMax: 20,
      interaction,
    },
    segment: null,
    queuedBehindRunId: null,
    chunks: [],
    summary: {
      plannedTotal: 1,
      browsedTotal: 0,
      searchBrowsed: 0,
      homeBrowsed: 0,
      interactions: {},
      anomalyCount: 0,
      durationMs: null,
    },
    notes: "",
    error: null,
    startedAt: null,
    completedAt: null,
  };
}

function buildApp(
  store: XhsOpsStore,
  getDevice: (deviceId: string) => Promise<DeviceInfo | null> = async (
    deviceId,
  ) => ({
    deviceId,
    status: "idle",
    connectedAt: Date.now(),
    lastSeen: Date.now(),
  }),
) {
  const app = new OpenAPIHono<ControllerBindings>();
  registerXhsOpsRoutes(app, {
    xhsOpsStore: store,
    xhsOpsRunService: {},
    xhsOpsProfileService: {},
    xhsOpsScheduler: {},
    xhsOpsCommentService: {},
    deviceControlService: { getDevice },
  } as ControllerContainer);
  return app;
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("xhs ops device binding transfer", () => {
  it("lists global owners and atomically transfers a device into a new account", async () => {
    const { store } = fixture();
    const sourceProject = await store.createProject({ name: "亲子项目" });
    const targetProject = await store.createProject({ name: "羽毛球项目" });
    const source = await store.createAccount({
      projectId: sourceProject.id,
      label: "亲子账号",
      deviceId: "phone-1",
      deviceName: "测试手机",
    });
    const app = buildApp(store);

    const listResponse = await app.request("/api/v1/xhs-ops/device-bindings");
    expect(listResponse.status).toBe(200);
    expect(await listResponse.json()).toEqual({
      bindings: [
        {
          deviceId: "phone-1",
          accountId: source.id,
          accountLabel: "亲子账号",
          projectId: sourceProject.id,
          projectName: "亲子项目",
          canTransfer: true,
          blockingReason: null,
        },
      ],
    });

    const transferResponse = await app.request(
      `/api/v1/xhs-ops/projects/${targetProject.id}/accounts/transfer-device`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromAccountId: source.id,
          account: {
            label: "羽毛球账号",
            positioning: "本地球馆体验",
            deviceId: "phone-1",
            deviceName: "测试手机",
          },
        }),
      },
    );
    expect(transferResponse.status).toBe(200);
    const body = (await transferResponse.json()) as {
      account: { id: string; projectId: string; deviceId: string };
    };
    expect(body.account).toMatchObject({
      projectId: targetProject.id,
      deviceId: "phone-1",
    });
    expect((await store.getAccount(source.id))?.deviceId).toBeNull();
    expect((await store.getAccount(source.id))?.deviceName).toBeNull();
  });

  it("preserves an existing target identity and profile draft", async () => {
    const { store } = fixture();
    const sourceProject = await store.createProject({ name: "来源" });
    const targetProject = await store.createProject({ name: "目标" });
    const source = await store.createAccount({
      projectId: sourceProject.id,
      label: "来源账号",
      deviceId: "phone-1",
    });
    const target = await store.createAccount({
      projectId: targetProject.id,
      label: "旧目标",
      profileDraft: { nickname: "保留昵称", bio: "保留简介" },
    });

    const transferred = await store.transferDevice(targetProject.id, {
      fromAccountId: source.id,
      toAccountId: target.id,
      account: {
        label: "新目标",
        positioning: "更新定位",
        deviceId: "phone-1",
      },
    });

    expect(transferred.id).toBe(target.id);
    expect(transferred.createdAt).toBe(target.createdAt);
    expect(transferred.profileDraft).toEqual(target.profileDraft);
    expect(transferred).toMatchObject({
      label: "新目标",
      positioning: "更新定位",
      deviceId: "phone-1",
    });
  });

  it("does not silently release a different device already owned by the target", async () => {
    const { store, file } = fixture();
    const sourceProject = await store.createProject({ name: "来源" });
    const targetProject = await store.createProject({ name: "目标" });
    const source = await store.createAccount({
      projectId: sourceProject.id,
      label: "来源账号",
      deviceId: "phone-1",
    });
    const target = await store.createAccount({
      projectId: targetProject.id,
      label: "目标账号",
      deviceId: "phone-2",
    });
    const before = readFileSync(file, "utf8");

    await expect(
      store.transferDevice(targetProject.id, {
        fromAccountId: source.id,
        toAccountId: target.id,
        account: { label: "目标账号", deviceId: "phone-1" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it.each([
    {
      name: "busy",
      getDevice: async (): Promise<DeviceInfo> => ({
        deviceId: "phone-1",
        status: "busy",
        connectedAt: Date.now(),
        lastSeen: Date.now(),
      }),
    },
    {
      name: "current task",
      getDevice: async (): Promise<DeviceInfo> => ({
        deviceId: "phone-1",
        status: "idle",
        currentTaskId: "task-1",
        connectedAt: Date.now(),
        lastSeen: Date.now(),
      }),
    },
    {
      name: "stale heartbeat",
      getDevice: async (): Promise<DeviceInfo> => ({
        deviceId: "phone-1",
        status: "idle",
        connectedAt: Date.now() - 100_000,
        lastSeen: Date.now() - 90_001,
      }),
    },
    {
      name: "missing device",
      getDevice: async (): Promise<null> => null,
    },
  ])("rejects a $name device without changing state", async ({ getDevice }) => {
    const { store, file } = fixture();
    const sourceProject = await store.createProject({ name: "来源" });
    const targetProject = await store.createProject({ name: "目标" });
    const source = await store.createAccount({
      projectId: sourceProject.id,
      label: "来源账号",
      deviceId: "phone-1",
    });
    const before = readFileSync(file, "utf8");
    const app = buildApp(store, getDevice);

    const response = await app.request(
      `/api/v1/xhs-ops/projects/${targetProject.id}/accounts/transfer-device`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fromAccountId: source.id,
          account: { label: "目标账号", deviceId: "phone-1" },
        }),
      },
    );

    expect(response.status).toBe(409);
    expect(readFileSync(file, "utf8")).toBe(before);
  });

  it("holds a device reservation across mutations and releases it safely", async () => {
    const { store } = fixture();
    const sourceProject = await store.createProject({ name: "来源" });
    const targetProject = await store.createProject({ name: "目标" });
    const source = await store.createAccount({
      projectId: sourceProject.id,
      label: "来源账号",
      deviceId: "phone-1",
    });
    const release = await store.acquireDeviceBinding(source.id, "phone-1");

    expect(await store.listDeviceBindings()).toMatchObject([
      {
        canTransfer: false,
        blockingReason: "设备正在执行账号任务，请稍后重试",
      },
    ]);
    await expect(
      store.acquireDeviceBinding(source.id, "phone-1"),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      store.updateAccount(source.id, { deviceId: null }),
    ).rejects.toMatchObject({ status: 409 });
    await expect(store.deleteAccount(source.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(store.deleteProject(sourceProject.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      store.transferDevice(targetProject.id, {
        fromAccountId: source.id,
        account: { label: "目标账号", deviceId: "phone-1" },
      }),
    ).rejects.toMatchObject({ status: 409 });

    release();
    const laterRelease = await store.acquireDeviceBinding(source.id, "phone-1");
    release();
    await expect(
      store.updateAccount(source.id, { deviceId: null }),
    ).rejects.toMatchObject({ status: 409 });
    laterRelease();
    laterRelease();
    await expect(
      store.updateAccount(source.id, { deviceId: null }),
    ).resolves.toMatchObject({ deviceId: null });
  });

  it("rejects stale ownership and unfinished work without changing state", async () => {
    const { store, file } = fixture();
    const sourceProject = await store.createProject({ name: "来源" });
    const targetProject = await store.createProject({ name: "目标" });
    const source = await store.createAccount({
      projectId: sourceProject.id,
      label: "来源账号",
      deviceId: "phone-1",
    });
    const beforeMismatch = readFileSync(file, "utf8");
    await expect(
      store.transferDevice(targetProject.id, {
        fromAccountId: source.id,
        account: { label: "目标账号", deviceId: "phone-changed" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(file, "utf8")).toBe(beforeMismatch);

    await store.createRun(plannedRun(sourceProject.id, source.id, "phone-1"));
    const binding = (await store.listDeviceBindings())[0];
    expect(binding).toMatchObject({
      canTransfer: false,
      blockingReason: "账号或设备还有待执行任务，请先取消任务",
    });
    const beforeBlocked = readFileSync(file, "utf8");
    await expect(
      store.transferDevice(targetProject.id, {
        fromAccountId: source.id,
        account: { label: "目标账号", deviceId: "phone-1" },
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(readFileSync(file, "utf8")).toBe(beforeBlocked);
  });

  it("treats preparation and chunk recovery windows as unfinished work", async () => {
    const { store } = fixture();
    const sourceProject = await store.createProject({ name: "来源" });
    const source = await store.createAccount({
      projectId: sourceProject.id,
      label: "来源账号",
      deviceId: "phone-1",
    });
    const run = await store.createRun(
      plannedRun(sourceProject.id, source.id, "phone-1"),
    );
    await store.updateRun(run.id, (current) => ({
      ...current,
      status: "completed",
      preparation: {
        status: "running",
        reasonCode: null,
        reason: null,
        taskId: null,
        startedAt: "2026-09-08T10:00:00.000Z",
        completedAt: null,
      },
    }));
    expect((await store.listDeviceBindings())[0]).toMatchObject({
      canTransfer: false,
      blockingReason: "账号或设备还有待执行任务，请先取消任务",
    });

    await store.updateRun(run.id, (current) => ({
      ...current,
      preparation: {
        status: "ready",
        reasonCode: "ready",
        reason: null,
        taskId: null,
        startedAt: "2026-09-08T10:00:00.000Z",
        completedAt: "2026-09-08T10:00:01.000Z",
      },
      chunks: [
        {
          index: 0,
          mode: "search",
          keyword: "羽毛球",
          plannedCount: 1,
          status: "running",
          taskId: null,
          startedAt: null,
          completedAt: null,
          browsed: 0,
          skipped: 0,
          interactions: {},
          anomalies: [],
          observation: null,
          posts: [],
          message: null,
          totalSteps: null,
          finalScreenshot: null,
          error: null,
        },
      ],
    }));
    expect((await store.listDeviceBindings())[0]).toMatchObject({
      canTransfer: false,
      blockingReason: "账号或设备还有待执行任务，请先取消任务",
    });
  });

  it("marks duplicate bindings and missing projects as non-transferable", async () => {
    const { store, file } = fixture();
    const missingProject = await store.createProject({
      name: "会被删除的项目",
    });
    const validProject = await store.createProject({ name: "保留项目" });
    const missingOwner = await store.createAccount({
      projectId: missingProject.id,
      label: "孤立账号",
      deviceId: "phone-1",
    });
    const owner = await store.createAccount({
      projectId: validProject.id,
      label: "原账号",
      deviceId: "phone-2",
    });
    const duplicate = await store.createAccount({
      projectId: validProject.id,
      label: "重复账号",
    });
    const data = JSON.parse(readFileSync(file, "utf8")) as {
      projects: Array<{ id: string }>;
      accounts: Array<{ id: string; deviceId: string | null }>;
    };
    data.projects = data.projects.filter(
      (project) => project.id !== missingProject.id,
    );
    const duplicateAccount = data.accounts.find(
      (account) => account.id === duplicate.id,
    );
    if (duplicateAccount) duplicateAccount.deviceId = "phone-2";
    writeFileSync(file, JSON.stringify(data));

    const corruptedStore = new XhsOpsStore(file);
    const bindings = await corruptedStore.listDeviceBindings();
    expect(bindings).toHaveLength(3);
    expect(bindings.map((binding) => binding.accountId)).toEqual([
      missingOwner.id,
      owner.id,
      duplicate.id,
    ]);
    expect(bindings.every((binding) => !binding.canTransfer)).toBe(true);
    expect(bindings[0]).toMatchObject({
      projectName: "已删除项目",
      blockingReason: "绑定账号所属项目已不存在，请先清理异常数据",
    });
    expect(
      bindings.slice(1).every((binding) => binding.projectName === "保留项目"),
    ).toBe(true);
    expect(
      bindings
        .slice(1)
        .every(
          (binding) =>
            binding.blockingReason === "设备存在多个账号绑定，请先修复重复绑定",
        ),
    ).toBe(true);

    await expect(
      corruptedStore.transferDevice(validProject.id, {
        fromAccountId: missingOwner.id,
        account: { label: "目标账号", deviceId: "phone-1" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "源账号所属项目已不存在，无法转移",
    });
  });
});
