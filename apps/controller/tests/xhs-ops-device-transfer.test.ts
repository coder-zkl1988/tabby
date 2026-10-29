import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenAPIHono } from "@hono/zod-openapi";
import {
  type DeviceInfo,
  XHS_TAKEOVER_DEVICE_HOLD_MESSAGE,
  XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
  type XhsOpsAccount,
  type XhsOpsTakeover,
} from "@nexu/shared";
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
      interactions: { like: 0, collect: 0, follow: 0 },
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
          refreshCount: 0,
          interactions: { like: 0, collect: 0, follow: 0 },
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

function takeoverOf(account: XhsOpsAccount | null | undefined): XhsOpsTakeover {
  if (!account?.takeover) throw new Error("fixture has no takeover");
  return account.takeover;
}

async function takeoverFixture() {
  const { store, file } = fixture();
  const project = await store.createProject({ name: "接管项目" });
  const created = await store.createAccount({
    projectId: project.id,
    entryMode: "existing",
    label: "接管·测试机",
    platformAccountId: "xhs-owner",
    deviceId: "phone-1",
  });
  const account = await store.authorizeTakeover(created.id, {
    expectedUpdatedAt: created.updatedAt,
    ownershipConfirmed: true,
  });
  return { store, file, project, account };
}

describe("exclusive device binding for takeover work (§2.5)", () => {
  it("lets a step pass its own audit or order and blocks everyone else", async () => {
    const { store, project, account } = await takeoverFixture();
    const { audit, release } = await store.startAudit({
      projectId: project.id,
      accountId: account.id,
      deviceId: "phone-1",
      platformAccountId: "xhs-owner",
      trigger: "takeover",
    });
    expect(audit).toMatchObject({ status: "running", activeTaskId: null });
    await expect(
      store.acquireExclusiveDeviceBinding(account.id, "phone-1", {
        ownAuditId: audit.id,
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "设备正在执行账号任务，请稍后重试",
    });
    release();
    // Between two parts the audit's own running record does not block it.
    const nextPart = await store.acquireExclusiveDeviceBinding(
      account.id,
      "phone-1",
      { ownAuditId: audit.id, purpose: "audit" },
    );
    nextPart();
    await expect(
      store.acquireExclusiveDeviceBinding(account.id, "phone-1", {
        purpose: "identity",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "只读盘点进行中，请等它结束或先取消",
    });
    expect(await store.listDeviceBindings()).toMatchObject([
      { canTransfer: false },
    ]);
    // The new-account apply keeps its old, lock-only binding.
    const legacyLock = await store.acquireDeviceBinding(account.id, "phone-1");
    legacyLock();

    await store.updateAudit(audit.id, (current) => ({
      ...current,
      status: "completed",
      completedAt: current.updatedAt,
    }));
    const order = await store.createChangeOrder({
      projectId: project.id,
      accountId: account.id,
      deviceId: "phone-1",
      platformAccountId: "xhs-owner",
      diagnosisId: null,
      proposalIds: [],
      batchIndex: 1,
      risk: "L1",
      fields: [{ field: "bio", baselineValue: "旧简介", after: "新简介" }],
      status: "draft",
    });
    // A draft holds nothing.
    (await store.acquireExclusiveDeviceBinding(account.id, "phone-1"))();
    await store.mutateTakeover(
      account.id,
      ({ account: current, changeOrders }) => ({
        account: {
          ...current,
          takeover: { ...takeoverOf(current), activeChangeOrderId: order.id },
        },
        changeOrders: changeOrders.map((entry) => ({
          ...entry,
          status: "prechecking" as const,
        })),
        result: null,
      }),
    );
    const ownStep = await store.acquireExclusiveDeviceBinding(
      account.id,
      "phone-1",
      { ownOrderId: order.id, purpose: "change_order" },
    );
    ownStep();
    await expect(
      store.acquireExclusiveDeviceBinding(account.id, "phone-1", {
        purpose: "audit",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "有资料变更单正在执行或待核验，请先处理完",
    });
    await expect(store.deleteAccount(account.id)).rejects.toMatchObject({
      status: 409,
    });
    await expect(store.deleteProject(project.id)).rejects.toMatchObject({
      status: 409,
    });
  });

  it("returns 409 while a planned run is queued for the account", async () => {
    const { store, project, account } = await takeoverFixture();
    await store.createRun(plannedRun(project.id, account.id, "phone-1"));
    await expect(
      store.acquireExclusiveDeviceBinding(account.id, "phone-1", {
        purpose: "audit",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "今天还有待执行的养号或评论任务，请先取消或等它结束",
    });
    await expect(
      store.acquireExclusiveDeviceBinding(account.id, "phone-1", {
        purpose: "change_order",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message:
        "今天还有待执行的养号或评论任务；要今天改资料请先取消它，否则改到明天",
    });
    await expect(
      store.startAudit({
        projectId: project.id,
        accountId: account.id,
        deviceId: "phone-1",
        platformAccountId: "xhs-owner",
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(await store.listAudits({ accountId: account.id })).toEqual([]);
    // Nothing was locked by the refusals.
    (await store.acquireDeviceBinding(account.id, "phone-1"))();
  });

  it("treats a device hold as unfinished work", async () => {
    const { store, account } = await takeoverFixture();
    await store.holdTakeoverDevice(account.id, {
      taskId: "task-1",
      sourceRef: "audit-1",
    });
    await expect(
      store.acquireExclusiveDeviceBinding(account.id, "phone-1"),
    ).rejects.toMatchObject({
      status: 409,
      message: "手机上的任务停止未确认，请到手机上确认后在接管卡片解除",
    });
    // Every 409 names the hold itself: cancelling a task cannot lift it.
    await expect(
      store.updateAccount(account.id, { deviceId: null }),
    ).rejects.toMatchObject({
      status: 409,
      message: XHS_TAKEOVER_DEVICE_HOLD_MESSAGE,
    });
    await expect(store.deleteAccount(account.id)).rejects.toMatchObject({
      status: 409,
      message: XHS_TAKEOVER_DEVICE_HOLD_MESSAGE,
    });
    expect(await store.listDeviceBindings()).toMatchObject([
      {
        canTransfer: false,
        blockingReason: XHS_TAKEOVER_DEVICE_HOLD_MESSAGE,
      },
    ]);
  });

  it("lets an identity read past an order parked between phone steps, not one in flight", async () => {
    const { store, project, account } = await takeoverFixture();
    const order = await store.createChangeOrder({
      projectId: project.id,
      accountId: account.id,
      deviceId: "phone-1",
      platformAccountId: "xhs-owner",
      diagnosisId: null,
      proposalIds: [],
      batchIndex: 1,
      risk: "L1",
      fields: [{ field: "bio", baselineValue: "旧简介", after: "新简介" }],
      status: "interrupted",
      applyTaskId: "apply-1",
    });
    await store.mutateTakeover(account.id, ({ account: current }) => ({
      account: {
        ...current,
        takeover: { ...takeoverOf(current), activeChangeOrderId: order.id },
      },
      result: null,
    }));
    // An identity change interrupted the order; its verify waits for the
    // re-lock, so the identity read must not wait for the order.
    (
      await store.acquireExclusiveDeviceBinding(account.id, "phone-1", {
        purpose: "identity",
      })
    )();
    await expect(
      store.acquireExclusiveDeviceBinding(account.id, "phone-1", {
        purpose: "audit",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "有资料变更单正在执行或待核验，请先处理完",
    });

    await store.updateChangeOrder(order.id, (current) => ({
      ...current,
      status: "verifying",
      verificationTaskId: "verify-1",
    }));
    await expect(
      store.acquireExclusiveDeviceBinding(account.id, "phone-1", {
        purpose: "identity",
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: "有资料变更单正在执行或待核验，请先处理完",
    });
  });

  it("re-checks a takeover target's cadence when a device is transferred onto it", async () => {
    const { store } = fixture();
    const project = await store.createProject({ name: "项目" });
    const source = await store.createAccount({
      projectId: project.id,
      label: "来源",
      deviceId: "phone-1",
    });
    const created = await store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "接管目标",
      deviceId: "phone-2",
    });
    const target = await store.authorizeTakeover(created.id, {
      expectedUpdatedAt: created.updatedAt,
      ownershipConfirmed: true,
    });
    const unbound = await store.updateAccount(target.id, { deviceId: null });
    if (!unbound) throw new Error("missing unbound target");
    const transfer = (follow: boolean) =>
      store.transferDevice(project.id, {
        fromAccountId: source.id,
        toAccountId: target.id,
        account: {
          label: "接管目标",
          entryMode: "existing",
          deviceId: "phone-1",
          interestPool: unbound.interestPool,
          browseDefaults: unbound.browseDefaults,
          interaction: {
            ...unbound.interaction,
            follow: { enabled: follow, dailyCap: 2, ratioPercent: 2 },
          },
        },
      });
    await expect(transfer(true)).rejects.toMatchObject({
      status: 409,
      message: expect.stringContaining("需要填写理由"),
      code: "takeover_override_reason_required",
      issues: [{ field: "interaction.follow.enabled", overridable: true }],
    });
    expect((await store.getAccount(source.id))?.deviceId).toBe("phone-1");
    await expect(transfer(false)).resolves.toMatchObject({
      id: target.id,
      deviceId: "phone-1",
      interaction: { follow: { enabled: false } },
    });
  });

  it("transfers over-tier settings onto a takeover target with an overrideReason, as the PATCH does", async () => {
    const { store } = fixture();
    const project = await store.createProject({ name: "项目" });
    const source = await store.createAccount({
      projectId: project.id,
      label: "来源",
      deviceId: "phone-1",
    });
    const created = await store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "接管目标",
      deviceId: "phone-2",
    });
    const target = await store.authorizeTakeover(created.id, {
      expectedUpdatedAt: created.updatedAt,
      ownershipConfirmed: true,
    });
    const unbound = await store.updateAccount(target.id, { deviceId: null });
    if (!unbound) throw new Error("missing unbound target");
    const body = (overrides: { dwellSecMin?: number } = {}) => ({
      fromAccountId: source.id,
      toAccountId: target.id,
      account: {
        label: "接管目标",
        entryMode: "existing" as const,
        deviceId: "phone-1",
        interestPool: unbound.interestPool,
        browseDefaults: { ...unbound.browseDefaults, ...overrides },
        interaction: {
          ...unbound.interaction,
          follow: { enabled: true, dailyCap: 2, ratioPercent: 2 },
        },
      },
    });
    // A reason never lifts a hard limit.
    await expect(
      store.transferDevice(project.id, {
        ...body({ dwellSecMin: 8 }),
        overrideReason: "客户要求回关老粉",
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "takeover_param_hard_limit",
      issues: [
        { field: "browseDefaults.dwellSecMin", overridable: false },
        { field: "interaction.follow.enabled", overridable: true },
      ],
    });
    expect((await store.getAccount(source.id))?.deviceId).toBe("phone-1");

    const moved = await store.transferDevice(project.id, {
      ...body(),
      overrideReason: "  客户要求回关老粉  ",
    });
    expect(moved).toMatchObject({
      id: target.id,
      deviceId: "phone-1",
      interaction: { follow: { enabled: true } },
    });
    expect(moved).not.toHaveProperty("overrideReason");
    expect(moved.takeover?.paramOverrides).toEqual([
      {
        at: expect.any(String),
        reason: "客户要求回关老粉",
        fields: ["interaction.follow.enabled"],
      },
    ]);
    expect((await store.getAccount(source.id))?.deviceId).toBeNull();
  });

  it("answers an over-tier transfer route with code and issues, and takes the overrideReason", async () => {
    const { store } = fixture();
    const project = await store.createProject({ name: "项目" });
    const source = await store.createAccount({
      projectId: project.id,
      label: "来源",
      deviceId: "phone-1",
    });
    const created = await store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "接管目标",
      deviceId: "phone-2",
    });
    const target = await store.authorizeTakeover(created.id, {
      expectedUpdatedAt: created.updatedAt,
      ownershipConfirmed: true,
    });
    const unbound = await store.updateAccount(target.id, { deviceId: null });
    if (!unbound) throw new Error("missing unbound target");
    const app = buildApp(store);
    const transfer = (extra: Record<string, unknown> = {}) =>
      app.request(
        `/api/v1/xhs-ops/projects/${project.id}/accounts/transfer-device`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            fromAccountId: source.id,
            toAccountId: target.id,
            account: {
              label: "接管目标",
              entryMode: "existing",
              deviceId: "phone-1",
              interestPool: unbound.interestPool,
              browseDefaults: unbound.browseDefaults,
              interaction: {
                ...unbound.interaction,
                follow: { enabled: true, dailyCap: 2, ratioPercent: 2 },
              },
            },
            ...extra,
          }),
        },
      );

    const refused = await transfer();
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({
      message:
        "开启关注超出新号默认值（默认关闭：关注列表公开，老粉看得到）。超出接管档位的调整需要填写理由",
      code: "takeover_override_reason_required",
      issues: [
        {
          field: "interaction.follow.enabled",
          message:
            "开启关注超出新号默认值（默认关闭：关注列表公开，老粉看得到）",
          overridable: true,
        },
      ],
    });
    expect((await transfer({ overrideReason: " " })).status).toBe(400);

    const moved = await transfer({ overrideReason: "客户要求回关老粉" });
    expect(moved.status).toBe(200);
    const body = (await moved.json()) as {
      account: { deviceId: string; takeover: { paramOverrides: unknown[] } };
    };
    expect(body.account.deviceId).toBe("phone-1");
    expect(body.account.takeover.paramOverrides).toHaveLength(1);

    // Any other conflict of the route stays a bare message.
    const again = await transfer({ overrideReason: "客户要求回关老粉" });
    expect(again.status).toBe(409);
    expect(Object.keys((await again.json()) as object)).toEqual(["message"]);
  });

  it("takes no lock and writes nothing when the claim fails", async () => {
    const { store, project, account } = await takeoverFixture();
    await expect(
      store.startAudit(
        {
          projectId: project.id,
          accountId: account.id,
          deviceId: "phone-1",
          platformAccountId: "xhs-owner",
        },
        {
          validate: () => {
            throw new Error("not now");
          },
        },
      ),
    ).rejects.toThrow("not now");
    // An invalid record fails the write after the lock was taken.
    await expect(
      store.claimExclusiveDevice(account.id, "phone-1", {
        claim: (current) => ({
          data: {
            ...current,
            audits: [
              ...current.audits,
              {
                id: "bad",
                projectId: project.id,
                accountId: account.id,
                deviceId: "phone-1",
                platformAccountId: "xhs-owner",
                trigger: "manual",
                changeOrderId: null,
                status: "running",
                reason: "x".repeat(201),
                activeTaskId: null,
                profile: null,
                home: null,
                creator: null,
                noteDetails: null,
                flags: [],
                manualCheckAt: null,
                startedAt: account.updatedAt,
                completedAt: null,
                createdAt: account.updatedAt,
                updatedAt: account.updatedAt,
              },
            ],
          },
          result: null,
        }),
      }),
    ).rejects.toThrow();
    expect(await store.listAudits()).toEqual([]);
    (await store.acquireExclusiveDeviceBinding(account.id, "phone-1"))();
  });

  it("invalidates a takeover's identity lock when its device moves away", async () => {
    const { store, account } = await takeoverFixture();
    const audit = await store.createAudit({
      projectId: account.projectId,
      accountId: account.id,
      deviceId: "phone-1",
      platformAccountId: "xhs-owner",
      status: "completed",
      startedAt: account.updatedAt,
    });
    await store.mutateTakeover(account.id, ({ account: current }) => ({
      account: {
        ...current,
        takeover: {
          ...takeoverOf(current),
          identityConfirmedAt: current.updatedAt,
          identitySource: "takeover",
          baselineAuditId: audit.id,
          latestAuditId: audit.id,
          planConfirmedAt: current.updatedAt,
        },
      },
      result: null,
    }));
    const targetProject = await store.createProject({ name: "新项目" });
    await store.transferDevice(targetProject.id, {
      fromAccountId: account.id,
      account: { label: "新号", deviceId: "phone-1" },
    });
    const moved = await store.getAccount(account.id);
    expect(moved?.deviceId).toBeNull();
    expect(takeoverOf(moved)).toMatchObject({
      authorizedAt: takeoverOf(account).authorizedAt,
      identityConfirmedAt: null,
      baselineAuditId: null,
      planConfirmedAt: null,
      latestAuditId: audit.id,
    });
    expect((await store.getAudit(audit.id))?.flags).toEqual(["identityStale"]);
  });

  it("refuses to switch a takeover target into the new-account flow on transfer", async () => {
    const { store } = fixture();
    const project = await store.createProject({ name: "项目" });
    const source = await store.createAccount({
      projectId: project.id,
      label: "来源",
      deviceId: "phone-1",
    });
    const created = await store.createAccount({
      projectId: project.id,
      entryMode: "existing",
      label: "接管目标",
      deviceId: "phone-2",
    });
    const target = await store.authorizeTakeover(created.id, {
      expectedUpdatedAt: created.updatedAt,
      ownershipConfirmed: true,
    });
    await store.updateAccount(target.id, { deviceId: null });
    await expect(
      store.transferDevice(project.id, {
        fromAccountId: source.id,
        toAccountId: target.id,
        account: { label: "接管目标", entryMode: "new", deviceId: "phone-1" },
      }),
    ).rejects.toMatchObject({
      status: 409,
      message: XHS_TAKEOVER_ENTRY_MODE_LOCKED_MESSAGE,
    });
    expect((await store.getAccount(source.id))?.deviceId).toBe("phone-1");
  });
});
