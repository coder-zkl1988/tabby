import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DeviceExecuteTaskBody,
  type DeviceInfo,
  type DeviceTaskPolicy,
  type TaskResult,
  xhsOpsAlreadyLikedSkippedByDate,
  xhsOpsPreparationCodeSchema,
  xhsOpsRunChunkSchema,
} from "@nexu/shared";
import { afterAll, describe, expect, it } from "vitest";
import {
  buildPreparationRequest,
  buildPreparationVerificationRequest,
  buildTakeoverIdentityGateRequest,
  interpretPreparationResult,
  interpretTakeoverGateResult,
  preparationReason,
  takeoverGateReason,
} from "../src/services/xhs-ops-preparation.js";
import {
  XHS_AUDIT_TASK_POLICY,
  XHS_EXISTING_TASK_POLICY,
  XHS_PACKAGE,
  XHS_TAKEOVER_APPLY_TASK_POLICY,
  XHS_TASK_POLICY,
  XhsOpsRunService,
  chunkTaskPolicy,
  commentTaskPolicy,
  interpretTaskResult,
  summarizeRun,
} from "../src/services/xhs-ops-run-service.js";
import {
  REPORT_AUDIT_CONTRADICTED,
  XHS_ALREADY_LIKED_SKIPPED_KEY,
  XHS_AUDIT_CLICK_LIMITS,
  XHS_AUDIT_UNFOLD_HINT,
  XHS_ME_TAB_UNFOLD_HINT,
  assessAuditReceipt,
  auditReceiptStatus,
  buildAccountAuditCreatorTask,
  buildAccountAuditHomeTask,
  buildAccountIdentityTask,
  buildCommentChunkTask,
  buildHomeChunkTask,
  buildProfileApplyTask,
  buildProfileReadbackTask,
  buildProfileVerificationTask,
  buildSearchChunkTask,
  buildTakeoverIdentityTask,
  buildTakeoverProfileApplyTask,
  buildTakeoverProfileReadbackTask,
  buildTakeoverProfileVerificationTask,
  extractMarkerPayload,
  parseAccountIdentityJson,
  parseAuditCreatorJson,
  parseAuditHomeJson,
  parseHomeFeedMatch,
  parseRecordJson,
  parseTakeoverProfileJson,
  parseTakeoverProfileReadbackJson,
  parseTakeoverProfileVerificationJson,
} from "../src/services/xhs-ops-task-builder.js";
import { XhsOpsStore } from "../src/store/xhs-ops-store.js";

const tempDir = mkdtempSync(join(tmpdir(), "xhs-ops-takeover-tasks-"));
afterAll(() => rmSync(tempDir, { recursive: true, force: true }));

const ACCOUNT = "12345678";
const RECEIPT = "[回执] 各应用生效点击: com.xingin.xhs=2";
const gate = buildTakeoverIdentityGateRequest(XHS_PACKAGE, ACCOUNT);
// S6 dispatches the field verification on the gate's read-only policy, the
// way the new-account path reuses the preparation retry's (PS:789-811).
const verificationPolicy = gate.taskPolicy;

const chunkBase = {
  label: "豆豆妈的周末计划",
  positioning: "用产品经理思维做零踩坑周末遛娃攻略",
  persona: "32岁·女·北京海淀",
  dwellSecMin: 12,
  dwellSecMax: 30,
  quota: {
    like: { enabled: true, max: 2 },
    collect: { enabled: false, max: 0 },
    follow: { enabled: true, max: 1, targetTypes: ["亲子博主"] },
  },
};

// ─── Policies (§3.2, §9 #6) ─────────────────────────────────────────────────

const READ_ONLY_EXCLUDED = [
  "TYPE",
  "ENTER",
  "LONGPRESS",
  "LONGPRESSANDDRAG",
  "SLIDE",
  "FLING",
];

/** Every policy an existing account's task is dispatched with. */
const EXISTING_POLICIES: Record<string, DeviceTaskPolicy | undefined> = {
  audit: XHS_AUDIT_TASK_POLICY,
  existingNurture: chunkTaskPolicy("existing", null),
  existingComment: chunkTaskPolicy("existing", "写得很实用"),
  apply: XHS_TAKEOVER_APPLY_TASK_POLICY,
  gate: gate.taskPolicy,
  verification: verificationPolicy,
};

describe("takeover phone policies", () => {
  it("read-only policies can neither type, press nor drag", () => {
    for (const policy of [XHS_AUDIT_TASK_POLICY, gate.taskPolicy]) {
      for (const action of READ_ONLY_EXCLUDED) {
        expect(policy?.allowedActions).not.toContain(action);
      }
      expect(policy?.allowedAppRoles).toEqual(["target_app", "system_dialog"]);
      expect(policy?.confirmationPolicy?.login).toBe("forbidden");
    }
  });

  it("no existing-account policy opens system settings or SMS, and login is forbidden wherever TYPE is", () => {
    for (const [name, policy] of Object.entries(EXISTING_POLICIES)) {
      expect(policy?.allowedAppRoles, name).not.toContain("system_settings");
      expect(policy?.allowedAppRoles, name).not.toContain("default_sms");
      if (policy?.allowedActions?.includes("TYPE")) {
        expect(policy.confirmationPolicy?.login, name).toBe("forbidden");
        // The login preparation is the only account.login task that types.
        expect(policy.operationClass, name).not.toBe("account.login");
      }
    }
  });

  it("the apply policy keeps FLING for the region list and drops ENTER and the long presses", () => {
    const actions = XHS_TAKEOVER_APPLY_TASK_POLICY.allowedActions;
    expect(actions).toContain("FLING");
    expect(actions).toContain("TYPE");
    for (const action of ["ENTER", "LONGPRESS", "LONGPRESSANDDRAG"]) {
      expect(actions).not.toContain(action);
    }
  });

  it("only uses actions the phones already declare for XHS_TASK_POLICY", () => {
    const declared = new Set(XHS_TASK_POLICY.allowedActions);
    for (const policy of [
      XHS_AUDIT_TASK_POLICY,
      XHS_EXISTING_TASK_POLICY,
      XHS_TAKEOVER_APPLY_TASK_POLICY,
    ]) {
      for (const action of policy.allowedActions ?? []) {
        expect(declared.has(action), action).toBe(true);
      }
    }
  });

  it("an existing account's comment chunk still allowlists exactly the approved text", () => {
    expect(chunkTaskPolicy("existing", "写得很实用")).toEqual({
      ...XHS_EXISTING_TASK_POLICY,
      confirmationPolicy: {
        publish: "forbidden",
        payment: "forbidden",
        login: "forbidden",
        comment: "allowed",
      },
      commentAllowlist: ["写得很实用"],
    });
    expect(commentTaskPolicy("t", XHS_EXISTING_TASK_POLICY)).toEqual(
      chunkTaskPolicy("existing", "t"),
    );
  });

  it("keeps the new-account policies as they were", () => {
    expect(chunkTaskPolicy("new", null)).toBe(XHS_TASK_POLICY);
    expect(chunkTaskPolicy(undefined, null)).toBe(XHS_TASK_POLICY);
    expect(chunkTaskPolicy("new", "写得很实用")).toEqual(
      commentTaskPolicy("写得很实用"),
    );
    expect(XHS_TASK_POLICY).toEqual({
      operationClass: "app.use.xhs",
      targetPackages: [XHS_PACKAGE],
      allowedAppRoles: ["target_app", "system_dialog", "system_settings"],
      allowedActions: [
        "AWAKE",
        "CLICK",
        "TYPE",
        "ENTER",
        "WAIT",
        "BACK",
        "HOME",
        "SLIDE",
        "SCROLL",
        "FLING",
        "LONGPRESS",
        "LONGPRESSANDDRAG",
        "LOAD_SKILL",
        "COMPLETE",
        "ABORT",
        "INFO",
      ],
      allowedApps: [XHS_PACKAGE],
      confirmationPolicy: { publish: "forbidden", payment: "forbidden" },
    });
  });
});

// Every name the phone could read as an action. LONGPRESS is a prefix of
// LONGPRESSANDDRAG and HOME sits inside AUDIT_HOME_JSON, hence the boundaries.
const ACTION_VOCABULARY = [
  "AWAKE",
  "CLICK",
  "DOUBLE_CLICK",
  "TYPE",
  "ENTER",
  "WAIT",
  "BACK",
  "HOME",
  "SLIDE",
  "SCROLL",
  "FLING",
  "LONGPRESS",
  "LONGPRESSANDDRAG",
  "ZOOM",
  "LOAD_SKILL",
  "CALL_USER",
  "COMPLETE",
  "ABORT",
  "INFO",
];
// TabbyApp TaskPolicy.mandatorySafeActions: no whitelist can remove these, so
// naming one (the apply text says 「不 CALL_USER」) cannot end a task.
const PHONE_MANDATORY_ACTIONS = new Set([
  "LOAD_SKILL",
  "HOME",
  "INFO",
  "CALL_USER",
  "ABORT",
  "COMPLETE",
  "BACK",
  "WAIT",
]);

function namedActions(text: string): string[] {
  return ACTION_VOCABULARY.filter((action) =>
    new RegExp(`(?<![A-Z_])${action}(?![A-Z_])`).test(text),
  );
}

describe("every action a takeover text names is allowed by its policy", () => {
  // An action outside the whitelist ends the whole task with
  // POLICY_ACTION_NOT_ALLOWED — after the order's first field went public.
  const cases: Array<{
    name: string;
    text: string;
    policy: DeviceTaskPolicy | undefined;
  }> = [
    {
      name: "identity",
      text: buildTakeoverIdentityTask(),
      policy: XHS_AUDIT_TASK_POLICY,
    },
    {
      name: "archive",
      text: buildTakeoverProfileReadbackTask(ACCOUNT),
      policy: XHS_AUDIT_TASK_POLICY,
    },
    {
      name: "precheck",
      text: buildTakeoverProfileReadbackTask(ACCOUNT, ["avatar", "bio"]),
      policy: XHS_AUDIT_TASK_POLICY,
    },
    {
      name: "audit A",
      text: buildAccountAuditHomeTask(20),
      policy: XHS_AUDIT_TASK_POLICY,
    },
    {
      name: "audit B",
      text: buildAccountAuditCreatorTask(),
      policy: XHS_AUDIT_TASK_POLICY,
    },
    { name: "gate", text: gate.task, policy: gate.taskPolicy },
    {
      name: "existing search chunk",
      text: buildSearchChunkTask({
        ...chunkBase,
        existingAccount: { maturity: "growing" },
        keyword: "亲子酒店",
        count: 4,
      }),
      policy: chunkTaskPolicy("existing", null),
    },
    {
      name: "existing home chunk",
      text: buildHomeChunkTask({
        ...chunkBase,
        existingAccount: { maturity: null },
        count: 4,
      }),
      policy: chunkTaskPolicy("existing", null),
    },
    {
      name: "apply, every field",
      text: buildTakeoverProfileApplyTask({
        platformAccountId: ACCOUNT,
        fields: [
          { field: "nickname", after: "新名字" },
          { field: "bio", after: "新简介" },
          { field: "occupation", after: "互联网运营" },
          { field: "region", after: "中国 上海" },
          { field: "avatar", mediaAlbum: "Tabby-1a2b3c4d-a" },
          { field: "cover", mediaAlbum: "Tabby-1a2b3c4d-c" },
        ],
      }),
      policy: XHS_TAKEOVER_APPLY_TASK_POLICY,
    },
    {
      name: "verification, every field",
      text: buildTakeoverProfileVerificationTask({
        platformAccountId: ACCOUNT,
        fields: [
          { field: "bio", after: "新简介" },
          { field: "region", after: "中国 上海" },
          { field: "avatar" },
          { field: "cover" },
        ],
      }),
      policy: verificationPolicy,
    },
  ];
  for (const { name, text, policy } of cases) {
    it(name, () => {
      const allowed = new Set(policy?.allowedActions ?? []);
      for (const action of namedActions(text)) {
        expect(
          allowed.has(action) || PHONE_MANDATORY_ACTIONS.has(action),
          `${action} is named in the ${name} text but not allowed`,
        ).toBe(true);
      }
    });
  }

  it("the apply text names the gestures its steps depend on", () => {
    const named = namedActions(cases[8]?.text ?? "");
    expect(named).toEqual(expect.arrayContaining(["TYPE", "FLING", "SLIDE"]));
  });
});

// ─── New-account texts stay byte for byte (§9 #6) ───────────────────────────

const sha256 = (value: unknown) =>
  createHash("sha256")
    .update(typeof value === "string" ? value : JSON.stringify(value))
    .digest("hex");

describe("new-account task texts", () => {
  it("are unchanged by the takeover work", () => {
    // Digests taken from the builders before the takeover changes. A
    // deliberate change to a new-account text must update them here.
    const profile = {
      label: "A",
      platformAccountId: "49268961587",
      nickname: "下班练球",
      bio: "北京下班打球记录",
      occupation: "互联网运营",
      avatarFilename: "a.jpg",
      coverFilename: "c.jpg",
      mediaAlbum: "Tabby/acct-op",
      gender: "女" as const,
      birthday: "1997-01-01",
      region: "北京",
    };
    expect({
      search: sha256(
        buildSearchChunkTask({ ...chunkBase, keyword: "亲子酒店", count: 6 }),
      ),
      home: sha256(buildHomeChunkTask({ ...chunkBase, count: 4 })),
      apply: sha256(buildProfileApplyTask(profile)),
      readback: sha256(buildProfileReadbackTask()),
      identity: sha256(buildAccountIdentityTask()),
      verification: sha256(buildProfileVerificationTask(profile)),
      preparation: sha256(buildPreparationRequest(XHS_PACKAGE, "49268961587")),
      preparationVerification: sha256(
        buildPreparationVerificationRequest(XHS_PACKAGE, "49268961587"),
      ),
      comment: sha256(
        buildCommentChunkTask({
          label: "A",
          positioning: "p",
          persona: "q",
          postTitle: "周末遛娃",
          postAuthor: "某某",
          text: "写得很实用",
        }),
      ),
      policy: sha256(XHS_TASK_POLICY),
      commentPolicy: sha256(commentTaskPolicy("写得很实用")),
    }).toEqual({
      search:
        "fd94f6ae97f7463a5ba47d841c8f1bf7685277036cf6822922fe98a28728fb6c",
      home: "000a85b5283b45ba999732054e25d980597db62e88445d615a3e33153d2b9de0",
      apply: "1cf21117807c4496dd4277cd0e7dd84cc5506acabcadfe1634575a4b39fbc226",
      readback:
        "b433870ffc8162648187286a4371e850731abb6743c8d250c59314104b2231b6",
      identity:
        "4af540367f48a97d987fa6e966c41a50397caf22ee576a311855b7dd96d634be",
      verification:
        "3e925285773d499314168797d643832bc6d59ab7b17a542a31eeab82d1a56554",
      preparation:
        "858acb9d5beef6d91dbb18a42e7b853e507cb5c254e61732f3d6fcea4d96314f",
      preparationVerification:
        "3fa38f0fe07d2a037e450f8d06e8c3ee930d8095aaf1eede8b9b152130507b40",
      comment:
        "49e11c388a508e763b809584855715480395f1ea73339bfb86e9c66b1b7b77f5",
      policy:
        "2c9ed445ef767f6faf9deb52cea0aa89e6e3bbd938b8df29401206d1efa84711",
      commentPolicy:
        "a63d73917484d4b6f6030855e410e11aa899ff5bfaa01860b0fce39c00d757a0",
    });
  });

  it("only an existing account's chunks gain the stage lines and the match sentence", () => {
    const search = buildSearchChunkTask({
      ...chunkBase,
      existingAccount: { maturity: "established" },
      keyword: "亲子酒店",
      count: 6,
    }).split("\n");
    expect(search.slice(1, 3)).toEqual([
      "账号阶段：已有内容的账号（成熟档）。",
      "禁止修改资料、进入发布页、进入草稿箱、点去设置、前往设置、打开应用信息页。",
    ]);
    expect(search.join("\n")).not.toContain("推荐流匹配度");
    const home = buildHomeChunkTask({
      ...chunkBase,
      existingAccount: { maturity: null },
      count: 4,
    }).split("\n");
    expect(home[1]).toBe("账号阶段：已有内容的账号。");
    expect(home.at(-1)).toContain("observation 第一句写「推荐流匹配度：");
    expect(
      buildHomeChunkTask({ ...chunkBase, existingAccount: null, count: 4 }),
    ).toBe(buildHomeChunkTask({ ...chunkBase, count: 4 }));
  });
});

describe("identity gate texts (A12)", () => {
  it("say nothing of 养号: the gate runs before comment runs too", () => {
    for (const code of xhsOpsPreparationCodeSchema.options) {
      expect(takeoverGateReason(code), code).not.toContain("养号");
    }
    expect(takeoverGateReason("invalid_result")).toContain("本次任务未开始");
    expect(
      interpretTakeoverGateResult({
        taskId: "gate-1",
        success: true,
        status: "completed",
        message: "没有回执",
      }).reason,
    ).toBe(takeoverGateReason("invalid_result"));
  });

  it("leave the new-account preparation texts as they were", () => {
    expect(preparationReason("invalid_result")).toBe(
      "启动检查未返回有效的登录验证结果，养号未开始",
    );
    expect(preparationReason("cancelled")).toBe("启动检查已取消，养号未开始");
    expect(preparationReason("login_failed")).toBe(
      "小红书登录未完成，养号未开始",
    );
  });
});

// ─── Builders (§3.3) ────────────────────────────────────────────────────────

describe("takeover task builders", () => {
  it("identity variant keeps the receipt and drops the login wording and old hint", () => {
    const task = buildTakeoverIdentityTask();
    // The opening stays the new-account one: its 不登录 ends in 不, a negation (§3.3).
    expect(task.split("\n")[0]).toBe(buildAccountIdentityTask().split("\n")[0]);
    expect(task).toContain(XHS_AUDIT_UNFOLD_HINT);
    expect(task).not.toContain(XHS_ME_TAB_UNFOLD_HINT);
    expect(task).not.toContain("未登录");
    expect(task).not.toContain("登录页");
    expect(task).toContain("禁止尝试任何账号操作");
    expect(task).toContain("必须停留在编辑主页上直接 COMPLETE");
    expect(task).toContain(
      'IDENTITY_JSON:{"v":1,"status":"visible|unavailable"',
    );
  });

  it("the audit hint unfolds 我 without naming what loads interact", () => {
    for (const word of ["收藏", "关注", "编辑主页"]) {
      expect(XHS_AUDIT_UNFOLD_HINT).not.toContain(word);
    }
    expect(XHS_AUDIT_UNFOLD_HINT).toContain('SCROLL direction:"up"');
  });

  it("the profile archive compares the id without echoing it and only asks whether a birthday is filled", () => {
    const task = buildTakeoverProfileReadbackTask(` ${ACCOUNT} `);
    expect(task).toContain(`逐字核对“小红书号”与目标「${ACCOUNT}」完全一致`);
    expect(task).toContain("过程和回执禁止复述号码");
    // The new-account readback forbids reading the id, which would contradict the check.
    expect(task).not.toContain("不得读取或回传小红书号");
    expect(task).toContain("禁止抄写日期");
    expect(task).toContain('"birthdayFilled":true|false');
    expect(task).not.toContain('"birthday":');
    expect(task).not.toContain("header");
    expect(task).toContain("停在编辑主页上直接 COMPLETE");
  });

  it("a precheck copies the header before 编辑主页 and, with a picture, ends on 我", () => {
    const text = buildTakeoverProfileReadbackTask(ACCOUNT, ["bio"]);
    expect(text.indexOf("头部三项计数")).toBeGreaterThan(-1);
    expect(text.indexOf("头部三项计数")).toBeLessThan(
      text.indexOf("进入编辑主页"),
    );
    expect(text).toContain('"header":{"followingText":"…"');
    expect(text).toContain("停在编辑主页上直接 COMPLETE");
    const image = buildTakeoverProfileReadbackTask(ACCOUNT, ["avatar"]);
    expect(image).toContain("读完后 BACK 回到「我」页");
    expect(image).not.toContain("停在编辑主页上直接 COMPLETE");
    // 图片 loads media-picker; a read-only task must not lean on a nearby 不要.
    expect(image).not.toContain("图片");
  });

  it("part A reads the header at both ends and records at most N cards without opening one", () => {
    const task = buildAccountAuditHomeTask(7);
    expect(task).toContain("最多记录 7 张卡片");
    expect(task).toContain("不足 7 张时 note 写“只有 k 张”");
    expect(task).toContain("headerEnd");
    expect(task).toContain("打开任何笔记卡片");
    expect(task).toContain("禁止写“共N篇/张/条”之类总数");
    expect(task).not.toMatch(/已完成 \d+\//);
    expect(buildAccountAuditHomeTask(50)).toContain("最多记录 20 张卡片");
    expect(buildAccountAuditHomeTask(0)).toContain("最多记录 1 张卡片");
  });

  it("part B loads creator, uses the renamed metric keys and embeds no nickname", () => {
    const task = buildAccountAuditCreatorTask();
    expect(task.split("\n")[1]).toContain('LOAD_SKILL value:"creator"');
    expect(task).toContain("稍后再看");
    for (const key of ["engagementText", "visitorsText"]) {
      expect(task).toContain(key);
    }
    for (const old of ["interactionsText", "profileVisitorsText"]) {
      expect(task).not.toContain(old);
    }
    expect(task).toContain("creator_unavailable");
  });

  it("the gate is the read-only retry with login forbidden and no login wording", () => {
    const retry = buildPreparationVerificationRequest(XHS_PACKAGE, ACCOUNT);
    expect(gate).toMatchObject({
      maxSteps: 15,
      timeout: 120_000,
      allowedApps: [XHS_PACKAGE],
    });
    expect(gate.taskPolicy).toEqual({
      ...retry.taskPolicy,
      confirmationPolicy: {
        login: "forbidden",
        publish: "forbidden",
        payment: "forbidden",
        comment: "forbidden",
      },
    });
    // The retry inherited login:"required" from the login preparation.
    expect(retry.taskPolicy?.confirmationPolicy?.login).toBe("required");
    expect(gate.taskPolicy?.operationClass).toBe("account.login");
    expect(gate.task).toContain(XHS_AUDIT_UNFOLD_HINT);
    expect(gate.task).not.toContain(XHS_ME_TAB_UNFOLD_HINT);
    expect(gate.task).not.toContain("登录状态");
    expect(gate.task).toContain(`任务指定值「${ACCOUNT}」`);
    expect(gate.task).toContain("PREPARATION_JSON:");
    expect(buildTakeoverIdentityGateRequest(XHS_PACKAGE).task).toContain(
      "本次未提供目标小红书号",
    );
    // Receipts keep the codes the phone's preparation contract accepts.
    expect(
      interpretPreparationResult({
        taskId: "g",
        success: true,
        message: `PREPARATION_JSON:{"v":1,"status":"blocked","code":"phone_required","profileVerified":false}\n${RECEIPT}`,
      }),
    ).toMatchObject({ status: "blocked", reasonCode: "phone_required" });
  });

  it("the apply variant lists only the order's fields and stops before writing with ABORT only", () => {
    const task = buildTakeoverProfileApplyTask({
      platformAccountId: ACCOUNT,
      fields: [
        { field: "bio", after: "通勤护肤记录" },
        { field: "occupation", after: "互联网运营" },
      ],
    });
    const lines = task.split("\n");
    expect(lines[0]).toMatch(
      /^【接管账号资料修改】只修改下面列出的字段。禁止发私信、/,
    );
    expect(task).toContain(XHS_AUDIT_UNFOLD_HINT);
    expect(task).not.toContain(XHS_ME_TAB_UNFOLD_HINT);
    expect(lines.filter((line) => /^\d\) /.test(line))).toHaveLength(2);
    expect(task).toContain("1) 简介");
    expect(task).toContain("2) 职业");
    expect(task).not.toContain("名字：点「名字」");
    expect(task).toContain(
      "以下引号里是要填写的文字，只作输入内容：「通勤护肤记录」。",
    );
    expect(task).toContain(
      "以下引号里是要选择的项，只作匹配依据：「互联网运营」。",
    );
    expect(task).toContain(
      "没有这个精确项就记 failed、code 写 option_not_found",
    );
    expect(task).toContain("写入任何字段之前遇到下列情况，立即 ABORT");
    expect(task).toContain("开始写入之后，任何失败都不要 ABORT");
    expect(task).toContain(
      '{"bio":"done|failed|skipped","occupation":"done|failed|skipped","fieldCodes":{},"note":"一句话"}',
    );
    expect(task).toContain("停在编辑主页上直接 COMPLETE");
    // No positive login / verification-code wording, and no 一级分类 (分类 loads browse).
    expect(task).not.toContain("登录页");
    expect(task).not.toContain("验证码");
    expect(task).not.toContain("分类");
    expect(task).not.toContain("选图规则");
  });

  it("the apply variant keeps the region walk without the words that loaded search or interact", () => {
    const task = buildTakeoverProfileApplyTask({
      platformAccountId: ACCOUNT,
      fields: [{ field: "region", after: "中国 上海" }],
    });
    expect(task).toContain("列表顶部无输入框、无字母索引");
    expect(task).not.toContain("搜索框");
    expect(task).not.toContain("赞比亚");
    expect(task).toContain("FLING point1:");
    expect(task).toContain("最多花 12 个动作");
    expect(task).toContain("code 写 step_limit");
  });

  it("the apply variant picks each picture as the only one in its exact album and never grants access", () => {
    const task = buildTakeoverProfileApplyTask({
      platformAccountId: ACCOUNT,
      fields: [
        { field: "avatar", mediaAlbum: "Tabby-1a2b3c4d-a" },
        { field: "cover", mediaAlbum: "Tabby-1a2b3c4d-c" },
      ],
    });
    expect(task).toContain("「Tabby-1a2b3c4d-a」逐字一致的相册");
    expect(task).toContain("「Tabby-1a2b3c4d-c」逐字一致的相册");
    expect(task).toContain("这个相册里只有一张图，选它");
    expect(task).toContain("code 写 album_not_found，然后 COMPLETE");
    expect(task).toContain(
      "按 BACK 关闭弹窗，不点其中任何选项，即使参考文档另有要求",
    );
    expect(task).toContain("code 写 permission_required");
    expect(task).toContain("code 写 picker_unsupported");
    expect(task).toContain("每张图最多 15 个动作");
    expect(task).toContain("不 CALL_USER，不 INFO");
    // The new-account path grants full access and picks by describing the picture.
    expect(task).not.toContain("系统询问照片访问时选「允许访问所有照片」");
    expect(task).not.toContain("人物半身照");
    expect(task).not.toContain("横构图风景照");
    expect(task).not.toContain("未找到");
    expect(task).not.toContain("图片");
  });

  it("the verification variant only lists the order's fields and ends where the pictures show", () => {
    const text = buildTakeoverProfileVerificationTask({
      platformAccountId: ACCOUNT,
      fields: [{ field: "bio", after: "通勤护肤记录" }],
    });
    expect(text.split("\n")[0]).toBe(
      "【接管账号资料只读核验】禁止修改、保存、登录、退出、切换账号、点赞、收藏、关注、评论、浏览推荐页。",
    );
    expect(text).toContain(XHS_AUDIT_UNFOLD_HINT);
    expect(text).toContain('"fields":{"bio":true|false}');
    expect(text).toContain('"header":{"followingText"');
    expect(text).toContain("fields 只允许下列字段：bio；");
    expect(text).not.toContain("不得增加字段");
    expect(text).toContain("停在编辑主页上直接 COMPLETE");
    expect(text.indexOf("头部三项计数")).toBeLessThan(
      text.indexOf("进入编辑主页"),
    );
    const avatarOnly = buildTakeoverProfileVerificationTask({
      platformAccountId: ACCOUNT,
      fields: [{ field: "avatar" }],
    });
    expect(avatarOnly).toContain("停在编辑主页上直接 COMPLETE");
    expect(avatarOnly).toContain("是不是目标图由人对照截图确认");
    const withCover = buildTakeoverProfileVerificationTask({
      platformAccountId: ACCOUNT,
      fields: [{ field: "avatar" }, { field: "cover" }],
    });
    expect(withCover).toContain("核对完 BACK 回到「我」页");
    expect(withCover).not.toContain("图片");
    expect(withCover).toContain(
      '"fields":{"avatar":true|false,"cover":true|false}',
    );
  });
});

// ─── Receipts (§3.4, §9 #2) ─────────────────────────────────────────────────

describe("extractMarkerPayload", () => {
  const M = "PROFILE_READBACK_JSON:";

  it("keeps an escaped multi-line 简介 whole", () => {
    // Normalising \n first turned the escape into a line break and cut the
    // string there ("Unterminated string").
    const message = `已读取。\n${M}{"v":1,"bio":"第一行\\n第二行","nickname":"云朵"}\n${RECEIPT}`;
    expect(extractMarkerPayload(message, M)).toEqual({
      v: 1,
      bio: "第一行\n第二行",
      nickname: "云朵",
    });
  });

  it("ignores the collected block before the marker and the phone's trailers after it", () => {
    const message = [
      "已读取。",
      "[已收集条目 共2条]",
      "1. 第1篇｜周末去哪｜356",
      "2. 第2篇｜{特别}收藏｜12",
      `${M}{"v":1,"title":"含 } 的标题"}`,
      "[设备校验] 结束时仍有未解决的问题",
      RECEIPT,
    ].join("\n");
    expect(extractMarkerPayload(message, M)).toEqual({
      v: 1,
      title: "含 } 的标题",
    });
  });

  it("reads a single physical line that used literal \\n as line breaks", () => {
    const message = `已读取。\\n\\n${M}{"v":1,"bio":"a"}\\n${RECEIPT}`;
    expect(extractMarkerPayload(message, M)).toEqual({ v: 1, bio: "a" });
    // Literal \n between tokens only parses after normalisation.
    expect(
      extractMarkerPayload(`${M}{"v":1,\\n"bio":"b"}\\n${RECEIPT}`, M),
    ).toEqual({ v: 1, bio: "b" });
  });

  it("takes the last marker and rejects truncated or missing JSON", () => {
    expect(
      extractMarkerPayload(`${M}{"v":1,"n":1}\n${M}{"v":1,"n":2}`, M),
    ).toEqual({ v: 1, n: 2 });
    expect(extractMarkerPayload(`${M}{"v":1,"bio":"截断`, M)).toBeNull();
    expect(extractMarkerPayload(`${M} 读不到`, M)).toBeNull();
    expect(extractMarkerPayload(`${M}["v",1]`, M)).toBeNull();
    expect(extractMarkerPayload("没有标记", M)).toBeNull();
    expect(extractMarkerPayload(undefined, M)).toBeNull();
  });
});

describe("takeover readback receipt", () => {
  const values = {
    v: 1,
    status: "read",
    accountMatched: true,
    nickname: "云朵漫游簿",
    bio: "第一行\n第二行",
    occupation: "互联网运营",
    gender: "女",
    birthdayFilled: true,
    region: "中国 上海",
  };
  const message = (payload: Record<string, unknown>) =>
    `已读取。\n[已收集条目 共1条]\n1. x\nPROFILE_READBACK_JSON:${JSON.stringify(payload)}\n${RECEIPT}`;

  it("reads values, a multi-line bio and no header when none was asked for", () => {
    expect(parseTakeoverProfileReadbackJson(message(values))).toEqual({
      status: "read",
      accountMatched: true,
      values: {
        nickname: "云朵漫游簿",
        bio: "第一行\n第二行",
        occupation: "互联网运营",
        gender: "女",
        birthdayFilled: true,
        region: "中国 上海",
      },
      header: null,
    });
  });

  it("parses a precheck header, a null item and ignores unknown keys", () => {
    expect(
      parseTakeoverProfileReadbackJson(
        message({
          ...values,
          header: {
            followingText: "12",
            followersText: "1.2万",
            likesCollectsText: null,
            extra: "x",
          },
        }),
      )?.header,
    ).toEqual({
      following: { text: "12", value: 12, approx: false },
      followers: { text: "1.2万", value: 12_000, approx: true },
      likesCollects: null,
    });
    expect(
      parseTakeoverProfileReadbackJson(message({ ...values, header: null }))
        ?.header,
    ).toBeNull();
  });

  it("treats anything but a literal true as a mismatch and never keeps a birthday", () => {
    const parsed = parseTakeoverProfileReadbackJson(
      message({ ...values, accountMatched: "true", birthday: "1997-01-01" }),
    );
    expect(parsed?.accountMatched).toBe(false);
    expect(JSON.stringify(parsed)).not.toContain("1997");
    const { accountMatched: _omit, ...withoutMatch } = values;
    expect(
      parseTakeoverProfileReadbackJson(message(withoutMatch))?.accountMatched,
    ).toBe(false);
  });

  it("reads a birthday flag written as text, and a missing one as not filled", () => {
    expect(
      parseTakeoverProfileReadbackJson(
        message({ ...values, birthdayFilled: "true" }),
      )?.values.birthdayFilled,
    ).toBe(true);
    const { birthdayFilled: _filled, ...withoutFlag } = values;
    expect(
      parseTakeoverProfileReadbackJson(message(withoutFlag))?.values
        .birthdayFilled,
    ).toBe(false);
  });

  it("rejects a receipt without v:1", () => {
    const { v: _v, ...withoutV } = values;
    expect(parseTakeoverProfileReadbackJson(message(withoutV))).toBeNull();
    expect(
      parseTakeoverProfileReadbackJson(message({ ...values, v: 2 })),
    ).toBeNull();
  });
});

describe("audit receipts", () => {
  const home = {
    v: 1,
    status: "read",
    code: "ok",
    nickname: "云朵漫游簿",
    followingText: "12",
    followersText: "1.2万",
    likesCollectsText: "8.9万",
    headerEnd: {
      followingText: "13",
      followersText: "1.2万",
      likesCollectsText: "8.9万",
    },
    notesEnd: false,
    notes: [
      { i: 2, title: "第二篇", likesText: "999+", video: true, pinned: false },
      {
        i: 1,
        title: "一个超过二十个字的标题会被截断到二十个字为止的",
        likesText: "356",
        video: false,
        pinned: true,
      },
      { i: 1, title: "重复的第一篇", likesText: "1", video: false },
      { i: 0, title: "序号非法" },
      "不是卡片",
      { i: 3, title: "超出上限", likesText: "1" },
    ],
    note: "",
  };
  const homeMessage = (payload: Record<string, unknown>) =>
    `盘点完成。\nAUDIT_HOME_JSON:${JSON.stringify(payload)}\n${RECEIPT}`;

  it("part A: both header reads and the cards, deduped, capped and sorted", () => {
    const parsed = parseAuditHomeJson(homeMessage(home), 2);
    expect(parsed).toMatchObject({
      status: "read",
      code: "ok",
      nickname: "云朵漫游簿",
      header: {
        following: { text: "12", value: 12, approx: false },
        followers: { text: "1.2万", value: 12_000, approx: true },
        likesCollects: { text: "8.9万", value: 89_000, approx: true },
      },
      headerEnd: { following: { text: "13", value: 13, approx: false } },
      notesEnd: false,
    });
    expect(parsed?.notes).toEqual([
      {
        i: 1,
        title: "一个超过二十个字的标题会被截断到二十个字",
        likes: { text: "356", value: 356, approx: false },
        video: false,
        pinned: true,
      },
      {
        i: 2,
        title: "第二篇",
        likes: { text: "999+", value: 999, approx: true },
        video: true,
        pinned: false,
      },
    ]);
  });

  it("part A: missing header reads are null and an unknown code falls back on the status", () => {
    const parsed = parseAuditHomeJson(
      homeMessage({
        ...home,
        status: "unavailable",
        code: "weird",
        followingText: null,
        followersText: "",
        likesCollectsText: "null",
        headerEnd: "未读到",
        notesEnd: "true",
      }),
    );
    expect(parsed).toMatchObject({
      status: "unavailable",
      code: "load_failed",
      header: null,
      headerEnd: null,
      notesEnd: true,
    });
    expect(
      parseAuditHomeJson(homeMessage({ ...home, v: undefined })),
    ).toBeNull();
  });

  it("part B maps the renamed metrics onto the audit's creator fields", () => {
    const parsed = parseAuditCreatorJson(
      `数据已读取\nAUDIT_CREATOR_JSON:${JSON.stringify({
        v: 1,
        status: "read",
        code: "ok",
        nickname: "云朵漫游簿",
        followingText: "12",
        followersText: "1.2万",
        likesCollectsText: "8.9万",
        periodLabel: "近7日 10.13-10.19",
        viewsText: "3,456",
        engagementText: "210",
        newFollowersText: "18",
        visitorsText: "96",
        accountStatus: "正常",
        note: "",
      })}\n${RECEIPT}`,
    );
    expect(parsed).toMatchObject({
      status: "read",
      code: "ok",
      header: { following: { value: 12 } },
      periodLabel: "近7日 10.13-10.19",
      views: { text: "3,456", value: 3456, approx: false },
      interactions: { value: 210 },
      newFollowers: { value: 18 },
      profileVisitors: { value: 96 },
      accountStatus: "正常",
    });
    expect(
      parseAuditCreatorJson(
        'AUDIT_CREATOR_JSON:{"v":1,"status":"unavailable","code":"creator_unavailable"}',
      ),
    ).toMatchObject({
      status: "unavailable",
      code: "creator_unavailable",
      views: null,
      header: null,
    });
  });

  it("a contradicted report that still parses is partial and untrusted", () => {
    const result: TaskResult = {
      taskId: "a",
      success: false,
      status: "error",
      errorCode: REPORT_AUDIT_CONTRADICTED,
      message: homeMessage(home),
    };
    const parsed = parseAuditHomeJson(result.message);
    expect(parsed?.status).toBe("read");
    expect(
      auditReceiptStatus(parsed?.status ?? "unavailable", result.errorCode),
    ).toBe("partial");
    expect(auditReceiptStatus("unavailable", result.errorCode)).toBe(
      "unavailable",
    );
    expect(auditReceiptStatus("read", undefined)).toBe("read");
    expect(
      assessAuditReceipt(result, {
        packageName: XHS_PACKAGE,
        clickLimit: XHS_AUDIT_CLICK_LIMITS.auditHome,
      }),
    ).toMatchObject({ trusted: false, contradicted: true, receiptClicks: 2 });
  });

  it("click reconciliation: no [回执] line, zero or too many clicks are untrusted", () => {
    const assess = (message: string) =>
      assessAuditReceipt(
        { message },
        {
          packageName: XHS_PACKAGE,
          clickLimit: XHS_AUDIT_CLICK_LIMITS.profileArchive,
        },
      );
    expect(assess(`AUDIT_HOME_JSON:{}\n${RECEIPT}`)).toEqual({
      receiptClicks: 2,
      trusted: true,
      unexpectedClicks: false,
      contradicted: false,
      warnings: [],
    });
    expect(assess("AUDIT_HOME_JSON:{}")).toMatchObject({
      receiptClicks: null,
      trusted: false,
    });
    expect(
      assess("x\n[回执] 各应用生效点击: com.android.systemui=1"),
    ).toMatchObject({ receiptClicks: 0, trusted: false });
    expect(assess("x\n[回执] 各应用生效点击: com.xingin.xhs=4")).toMatchObject({
      receiptClicks: 4,
      trusted: false,
      unexpectedClicks: true,
    });
  });
});

describe("takeover verification receipt", () => {
  const verify = (payload: Record<string, unknown>) =>
    parseTakeoverProfileVerificationJson(
      `已核对\nPROFILE_VERIFICATION_JSON:${JSON.stringify(payload)}\n[设备校验] x\n${RECEIPT}`,
      { requiredFields: ["bio", "avatar"] },
    );
  const base = {
    v: 1,
    status: "verified",
    accountMatched: true,
    fields: { bio: true, avatar: true },
  };

  it("verifies exactly the requested fields, with or without a header", () => {
    expect(verify(base)).toEqual({
      status: "verified",
      accountMatched: true,
      fields: { bio: true, avatar: true },
      header: null,
    });
    expect(
      verify({
        ...base,
        header: {
          followingText: "12",
          followersText: null,
          likesCollectsText: "8.9万",
          extra: 1,
        },
      })?.header,
    ).toEqual({
      following: { text: "12", value: 12, approx: false },
      followers: null,
      likesCollects: { text: "8.9万", value: 89_000, approx: true },
    });
  });

  it("keeps a per-field failure and rejects inconsistent or off-contract receipts", () => {
    expect(
      verify({
        ...base,
        status: "failed",
        fields: { bio: true, avatar: false },
      })?.fields,
    ).toEqual({ bio: true, avatar: false });
    // Key set must equal the request: one missing, one extra.
    expect(verify({ ...base, fields: { bio: true } })).toBeNull();
    expect(
      verify({ ...base, fields: { bio: true, avatar: true, cover: true } }),
    ).toBeNull();
    // A mismatched account is a valid failed receipt the caller acts on.
    expect(
      verify({ ...base, status: "failed", accountMatched: false }),
    ).toMatchObject({ status: "failed", accountMatched: false });
    // Status must agree with the fields and the account match.
    expect(
      verify({ ...base, fields: { bio: true, avatar: false } }),
    ).toBeNull();
    expect(verify({ ...base, accountMatched: false })).toBeNull();
    // Strict at the top level; only header is new.
    expect(verify({ ...base, extra: "x" })).toBeNull();
    expect(verify({ ...base, v: undefined })).toBeNull();
  });
});

describe("takeover PROFILE_JSON", () => {
  const fields = ["avatar", "cover"] as const;

  it("reads a partial receipt: avatar done, cover failed with its code", () => {
    expect(
      parseTakeoverProfileJson(
        `头像已换，背景图失败。\nPROFILE_JSON:{"avatar":"done","cover":"failed","fieldCodes":{"cover":"permission_required","avatar":"step_limit"},"note":"背景图需要照片权限"}\n${RECEIPT}`,
        fields,
      ),
    ).toEqual({
      extracted: true,
      fields: [
        // A code on a done field is ignored.
        { field: "avatar", outcome: "done", code: null },
        { field: "cover", outcome: "failed", code: "permission_required" },
      ],
      note: "背景图需要照片权限",
    });
  });

  it("extracts the receipt from an aborted or blocked task's message", () => {
    for (const status of ["aborted", "blocked"]) {
      const result: TaskResult = {
        taskId: "apply",
        success: false,
        status,
        message: `已停止\\nPROFILE_JSON:{"bio":"skipped","occupation":"skipped","fieldCodes":{},"note":"号码比对不一致"}`,
      };
      expect(
        parseTakeoverProfileJson(result.message, ["bio", "occupation"]),
      ).toMatchObject({
        extracted: true,
        fields: [
          { field: "bio", outcome: "skipped" },
          { field: "occupation", outcome: "skipped" },
        ],
      });
    }
  });

  it("marks every field uncertain without a receipt, and a field the receipt leaves out", () => {
    expect(parseTakeoverProfileJson("任务中止", fields)).toEqual({
      extracted: false,
      fields: [
        { field: "avatar", outcome: "uncertain", code: null },
        { field: "cover", outcome: "uncertain", code: null },
      ],
      note: "",
    });
    expect(
      parseTakeoverProfileJson(
        'PROFILE_JSON:{"avatar":"DONE","cover":"maybe","fieldCodes":{"avatar":"x"}}',
        fields,
      ).fields,
    ).toEqual([
      { field: "avatar", outcome: "done", code: null },
      { field: "cover", outcome: "uncertain", code: null },
    ]);
    expect(
      parseTakeoverProfileJson('PROFILE_JSON:{"bio":"done"', ["bio"]).fields,
    ).toEqual([{ field: "bio", outcome: "uncertain", code: null }]);
  });

  it("keeps unknown failure codes as other", () => {
    expect(
      parseTakeoverProfileJson(
        'PROFILE_JSON:{"nickname":"failed","fieldCodes":{"nickname":"Name Taken"}}',
        ["nickname"],
      ).fields,
    ).toEqual([{ field: "nickname", outcome: "failed", code: "other" }]);
  });
});

describe("other takeover receipts", () => {
  it("the identity variant answers with the receipt parseAccountIdentityJson reads", () => {
    expect(
      parseAccountIdentityJson(
        `停在编辑主页\nIDENTITY_JSON:{"v":1,"status":"visible","accountId":"${ACCOUNT}"}\n${RECEIPT}`,
      ),
    ).toEqual({ status: "visible", accountId: ACCOUNT });
  });

  it("reads the home feed match an existing account's home chunk reports", () => {
    expect(parseHomeFeedMatch("推荐流匹配度：高。内容以亲子出游为主")).toBe(
      "high",
    );
    expect(parseHomeFeedMatch("推荐流匹配度: 低，推荐偏美妆")).toBe("low");
    expect(parseHomeFeedMatch("结果以酒店测评为主")).toBeNull();
    expect(parseHomeFeedMatch(null)).toBeNull();
  });
});

// ─── 已赞跳过 k 篇 (§6.3, NU-04) ─────────────────────────────────────────────

describe("已赞跳过 k 篇 (§6.3, NU-04)", () => {
  const ASK = `顶层 ${XHS_ALREADY_LIKED_SKIPPED_KEY} 填本块因笔记之前已点过赞而没有再点的篇数，没有就填 0`;

  /** A search chunk's RECORD_JSON as the phone writes it, plus `extra` top-level keys. */
  function record(extra: Record<string, unknown> = {}): string {
    return `汇报\nRECORD_JSON:${JSON.stringify({
      mode: "search",
      keyword: "亲子酒店",
      planned: 1,
      browsed: 1,
      refreshCount: 0,
      posts: [
        {
          title: "亲子房测评",
          author: "满哥",
          dwellSeconds: 12,
          commentsRead: 2,
          commentsComplete: true,
        },
      ],
      interactions: { like: 0, collect: 0, follow: 0 },
      anomalies: [],
      observation: null,
      ...extra,
    })}`;
  }

  function chunk(alreadyLikedSkipped?: number, mode = "search") {
    return xhsOpsRunChunkSchema.parse({
      index: 0,
      mode,
      keyword: mode === "search" ? "亲子酒店" : null,
      plannedCount: mode === "comment" ? 0 : 4,
      status: "completed",
      browsed: mode === "comment" ? 0 : 4,
      ...(alreadyLikedSkipped === undefined ? {} : { alreadyLikedSkipped }),
    });
  }

  it("is asked of an existing account's search and home chunks only", () => {
    for (const existingAccount of [
      { maturity: "established" as const },
      { maturity: null },
    ]) {
      expect(
        buildSearchChunkTask({
          ...chunkBase,
          existingAccount,
          keyword: "亲子酒店",
          count: 6,
        }),
      ).toContain(ASK);
      expect(
        buildHomeChunkTask({ ...chunkBase, existingAccount, count: 4 }),
      ).toContain(ASK);
    }
    // The new-account texts never ask; their digests above pin them whole.
    for (const existingAccount of [undefined, null]) {
      const texts = [
        buildSearchChunkTask({
          ...chunkBase,
          existingAccount,
          keyword: "亲子酒店",
          count: 6,
        }),
        buildHomeChunkTask({ ...chunkBase, existingAccount, count: 4 }),
      ];
      for (const text of texts)
        expect(text).not.toContain(XHS_ALREADY_LIKED_SKIPPED_KEY);
    }
  });

  it("parses leniently: a missing or unreadable count is 0 and spares the rest of the record", () => {
    expect(parseRecordJson(record())?.alreadyLikedSkipped).toBe(0);
    for (const [value, expected] of [
      [3, 3],
      ["4", 4],
      [2.9, 2],
      [0, 0],
      ["abc", 0],
      [-1, 0],
      [null, 0],
      [true, 0],
      [{}, 0],
      [[2], 0],
    ] as const) {
      const parsed = parseRecordJson(
        record({ [XHS_ALREADY_LIKED_SKIPPED_KEY]: value }),
      );
      expect(parsed?.alreadyLikedSkipped, JSON.stringify(value)).toBe(expected);
      expect(parsed?.browsed).toBe(1);
      expect(parsed?.posts).toHaveLength(1);
    }
  });

  it("lands on the chunk only when positive, and the run sums its browse chunks", () => {
    const expected = {
      mode: "search" as const,
      keyword: "亲子酒店",
      plannedCount: 1,
      dwellSecMin: 11,
      elapsedMs: 60_000,
      quota: chunkBase.quota,
    };
    const outcome = (extra: Record<string, unknown>) =>
      interpretTaskResult(
        {
          taskId: "chunk-1",
          success: true,
          status: "completed",
          message: record(extra),
        },
        expected,
      );
    const skipped = outcome({ [XHS_ALREADY_LIKED_SKIPPED_KEY]: 2 });
    expect(skipped).toMatchObject({
      status: "completed",
      alreadyLikedSkipped: 2,
    });
    expect(outcome({})).not.toHaveProperty("alreadyLikedSkipped");
    expect(outcome({ [XHS_ALREADY_LIKED_SKIPPED_KEY]: 0 })).not.toHaveProperty(
      "alreadyLikedSkipped",
    );

    expect(
      summarizeRun(
        [chunk(2), chunk(), chunk(3, "home"), chunk(undefined, "comment")],
        null,
        null,
      ).alreadyLikedSkipped,
    ).toBe(5);
    // Nothing skipped, or a new account's run: the summary leaves it out.
    expect(summarizeRun([chunk(), chunk(0)], null, null)).not.toHaveProperty(
      "alreadyLikedSkipped",
    );
  });
});

// ─── Run service dispatch (§3.2, §5.3 #8) ───────────────────────────────────

const interaction = {
  like: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  collect: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  follow: { enabled: false, dailyCap: 0, ratioPercent: 0 },
  comment: { enabled: true, dailyCap: 2 },
};

const existingStageLinesWithoutTier = [
  "账号阶段：已有内容的账号。",
  "禁止修改资料、进入发布页、进入草稿箱、点去设置、前往设置、打开应用信息页。",
];

/** An existing row the pre-takeover flow verified: it runs without a takeover (D5). */
async function legacyExistingAccount(file: string) {
  const store = new XhsOpsStore(join(tempDir, file));
  const created = await store.createProject({
    name: "接管执行",
    business: { industry: "亲子", product: "周末活动" },
    audience: {
      ageRange: "25–35",
      genderRatio: "女70%男30%",
      regions: ["北京"],
    },
  });
  const project = await store.confirmProfile(created.id, {
    profile: {
      summary: "北京亲子家庭",
      base: { ageRange: "25–35", genderRatio: "女70%男30%", regions: ["北京"] },
      verticalInterests: ["亲子出游"],
      generalInterests: ["咖啡"],
    },
    expectedUpdatedAt: created.updatedAt,
  });
  const account = await store.createAccount({
    projectId: project.id,
    entryMode: "existing",
    label: "已有亲子号",
    positioning: "记录周末亲子出游",
    interestPool: { core: ["亲子出游"], extended: [], general: [] },
    platformAccountId: ACCOUNT,
    deviceId: "dev-1",
    deviceName: "dev-1",
    interaction,
  });
  const verified = await store.updateAccount(
    account.id,
    {},
    {
      profileApplyResult: {
        expectedProfileDraft: account.profileDraft,
        expectedPlatformAccountId: ACCOUNT,
        appliedAt: new Date(2026, 9, 20, 9).toISOString(),
        applyStatus: "applied",
        applyResult: "legacy verified",
        verifiedAt: new Date(2026, 9, 20, 9).toISOString(),
        verifiedAccountId: ACCOUNT,
        verificationTaskId: "legacy-verification",
      },
    },
  );
  if (!verified) throw new Error("missing legacy existing account fixture");
  return { store, project, account: verified };
}

function service(
  store: XhsOpsStore,
  bodies: DeviceExecuteTaskBody[],
  respond: (body: DeviceExecuteTaskBody) => TaskResult,
  start: number,
) {
  // Each phone task takes 15 s of fake time, so a chunk's dwell is plausible.
  const clock = { now: start };
  return new XhsOpsRunService({
    store,
    deviceControl: {
      getDevice: async (id: string) =>
        ({ deviceId: id, status: "idle", lastSeen: clock.now }) as DeviceInfo,
      executeTask: async (_id: string, body: DeviceExecuteTaskBody) => {
        bodies.push(body);
        clock.now += 15_000;
        return { result: respond(body) };
      },
      cancelTask: async () => ({ cancelled: true }),
    },
    options: { idlePollIntervalMs: 1, now: () => clock.now },
  });
}

describe("existing-account run chunks", () => {
  it("dispatch nurture chunks on XHS_EXISTING_TASK_POLICY with the account-stage lines", async () => {
    const { store, project, account } =
      await legacyExistingAccount("nurture.json");
    const bodies: DeviceExecuteTaskBody[] = [];
    const svc = service(
      store,
      bodies,
      (body) =>
        body.taskPolicy?.operationClass === "account.login"
          ? {
              taskId: "prep",
              success: true,
              message:
                'PREPARATION_JSON:{"v":1,"status":"ready","code":"ready","profileVerified":true}',
            }
          : {
              taskId: `chunk-${bodies.length}`,
              success: true,
              message: `RECORD_JSON:${JSON.stringify({
                mode: body.task.includes("首页推荐流") ? "home" : "search",
                keyword: body.task.includes("首页推荐流") ? null : "亲子出游",
                planned: 1,
                browsed: 1,
                refreshCount: body.task.includes("首页推荐流") ? 1 : 0,
                posts: [
                  {
                    title: "周末遛娃",
                    dwellSeconds: 12,
                    commentsRead: 0,
                    commentsComplete: true,
                  },
                ],
                interactions: { like: 0, collect: 0, follow: 0 },
                anomalies: [],
                observation: "推荐流匹配度：中。",
              })}`,
            },
      new Date(2026, 9, 20, 12).getTime(),
    );
    const run = await svc.createRun({
      projectId: project.id,
      accountId: account.id,
      plan: {
        keywords: [{ keyword: "亲子出游", count: 1 }],
        homeFeedCount: 1,
        dwellSecMin: 11,
        dwellSecMax: 20,
        interaction: {
          ...interaction,
          comment: { enabled: false, dailyCap: 0 },
        },
      },
    });
    await svc.startRun(run.id);
    await svc.waitForRun(run.id);

    const chunks = bodies.filter(
      (body) => body.taskPolicy?.operationClass === "app.use.xhs",
    );
    expect(chunks).toHaveLength(2);
    for (const body of chunks) {
      expect(body.taskPolicy).toBe(XHS_EXISTING_TASK_POLICY);
      expect(body.task.split("\n").slice(1, 3)).toEqual(
        existingStageLinesWithoutTier,
      );
    }
    const [home, ...others] = [
      ...chunks.filter((body) => body.task.includes("首页推荐流")),
      ...chunks.filter((body) => !body.task.includes("首页推荐流")),
    ];
    expect(home?.task).toContain("推荐流匹配度：高/中/低");
    expect(others.map((body) => body.task.includes("推荐流匹配度"))).toEqual([
      false,
    ]);
    expect((await store.getRun(run.id))?.status).toBe("completed");
  });

  it("report 已赞跳过 per chunk and per run, summed per day from the run list the planner reads", async () => {
    const { store, project, account } =
      await legacyExistingAccount("already-liked.json");
    const bodies: DeviceExecuteTaskBody[] = [];
    const svc = service(
      store,
      bodies,
      (body) => {
        if (body.taskPolicy?.operationClass === "account.login")
          return {
            taskId: "gate",
            success: true,
            message:
              'PREPARATION_JSON:{"v":1,"status":"ready","code":"ready","profileVerified":true}',
          };
        const home = body.task.includes("首页推荐流");
        return {
          taskId: `chunk-${bodies.length}`,
          success: true,
          message: `RECORD_JSON:${JSON.stringify({
            mode: home ? "home" : "search",
            keyword: home ? null : "亲子出游",
            planned: 1,
            browsed: 1,
            refreshCount: home ? 1 : 0,
            posts: [
              {
                title: "周末遛娃",
                dwellSeconds: 12,
                commentsRead: 0,
                commentsComplete: true,
              },
            ],
            interactions: { like: 0, collect: 0, follow: 0 },
            anomalies: [],
            observation: "推荐流匹配度：中。",
            // The home chunk writes something unreadable: it counts as 0.
            [XHS_ALREADY_LIKED_SKIPPED_KEY]: home ? "几篇" : 3,
          })}`,
        };
      },
      new Date(2026, 9, 20, 12).getTime(),
    );
    const run = await svc.createRun({
      projectId: project.id,
      accountId: account.id,
      plan: {
        keywords: [{ keyword: "亲子出游", count: 1 }],
        homeFeedCount: 1,
        dwellSecMin: 11,
        dwellSecMax: 20,
        interaction: {
          ...interaction,
          comment: { enabled: false, dailyCap: 0 },
        },
      },
    });
    await svc.startRun(run.id);
    await svc.waitForRun(run.id);

    const chunkTasks = bodies.filter(
      (body) => body.taskPolicy?.operationClass === "app.use.xhs",
    );
    expect(chunkTasks).toHaveLength(2);
    for (const body of chunkTasks)
      expect(body.task).toContain(XHS_ALREADY_LIKED_SKIPPED_KEY);
    const stored = await store.getRun(run.id);
    expect(stored?.status).toBe("completed");
    expect(
      stored?.chunks.map((entry) => [entry.mode, entry.alreadyLikedSkipped]),
    ).toEqual([
      ["search", 3],
      ["home", undefined],
    ]);
    expect(stored?.summary.alreadyLikedSkipped).toBe(3);
    expect(
      xhsOpsAlreadyLikedSkippedByDate(
        await store.listRuns({ accountId: account.id }),
        account.id,
      ),
    ).toEqual({ [run.date]: 3 });
  });

  it("pass XHS_EXISTING_TASK_POLICY as the comment policy's base", async () => {
    const { store, project, account } =
      await legacyExistingAccount("comment.json");
    const now = new Date(2026, 9, 20, 15).getTime();
    // The comment quota is earned by browsing: one comment per 8 posts today.
    await store.createRun({
      projectId: project.id,
      accountId: account.id,
      deviceId: "dev-1",
      accountLabel: account.label,
      date: "2026-10-20",
      status: "completed",
      plan: {
        keywords: [{ keyword: "亲子出游", count: 8 }],
        homeFeedCount: 8,
        dwellSecMin: 11,
        dwellSecMax: 20,
        interaction,
      },
      segment: null,
      queuedBehindRunId: null,
      chunks: [],
      notes: "",
      error: null,
      startedAt: new Date(now - 7_200_000).toISOString(),
      completedAt: new Date(now - 3_600_000).toISOString(),
      summary: {
        plannedTotal: 16,
        browsedTotal: 16,
        searchBrowsed: 8,
        homeBrowsed: 8,
        interactions: { like: 0, collect: 0, follow: 0 },
        anomalyCount: 0,
        durationMs: 1000,
      },
    });
    await store.createComment({
      projectId: project.id,
      accountId: account.id,
      deviceId: "dev-1",
      sourceRunId: "r0",
      sourceChunkIndex: 0,
      sourcePostIndex: 0,
      post: { title: "A 帖", author: "作者", summary: "" },
      candidates: ["写得很实用"],
      text: "写得很实用",
      status: "approved",
      reviewedAt: new Date(now - 3_600_000).toISOString(),
      reviewNote: "",
      sentRunId: null,
      sentAt: null,
      sendResult: null,
    });
    const bodies: DeviceExecuteTaskBody[] = [];
    const svc = service(
      store,
      bodies,
      (body) =>
        body.taskPolicy?.operationClass === "account.login"
          ? {
              taskId: "gate",
              success: true,
              message:
                'PREPARATION_JSON:{"v":1,"status":"ready","code":"ready","profileVerified":true}',
            }
          : {
              taskId: "c1",
              success: true,
              message: `ok\nCOMMENT_JSON:{"status":"sent","detail":"评论区已出现"}\n${RECEIPT}`,
            },
      now,
    );
    const run = await svc.createCommentRun({
      projectId: project.id,
      accountId: account.id,
    });
    await svc.startRun(run.id);
    await svc.waitForRun(run.id);
    // The identity gate goes first, as before every existing account's run (§6.1).
    expect(bodies.map((body) => body.taskPolicy?.operationClass)).toEqual([
      "account.login",
      "app.use.xhs",
    ]);
    const comment = bodies[1];
    expect(comment?.taskPolicy).toEqual(
      commentTaskPolicy("写得很实用", XHS_EXISTING_TASK_POLICY),
    );
    expect(comment?.taskPolicy?.allowedAppRoles).not.toContain(
      "system_settings",
    );
    expect(comment?.taskPolicy?.confirmationPolicy?.login).toBe("forbidden");
    expect((await store.getRun(run.id))?.status).toBe("completed");
  });
});
