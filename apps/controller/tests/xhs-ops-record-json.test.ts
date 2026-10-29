import { describe, expect, it } from "vitest";
import {
  parseAccountIdentityJson,
  parseCommentJson,
  parseProfileJson,
  parseProfileReadbackJson,
  parseProfileVerificationJson,
  parseRecordJson,
} from "../src/services/xhs-ops-task-builder.js";

const RECORD =
  '{"v":1,"mode":"search","keyword":"亲子酒店","planned":2,"browsed":2,"skipped":2,"interactions":{"like":0,"collect":0,"follow":0},"anomalies":[],"posts":[{"title":"自驾1h直达","author":"未知","action":"none","commentsRead":3}],"observation":"结果以图文酒店测评为主"}';

describe("parseRecordJson tolerance (first real-device run findings)", () => {
  it("finds the marker when the phone escaped newlines as literal backslash-n", () => {
    // 实测：GLM 把整段汇报的换行写成字面 \n，RECORD_JSON: 不在真实行首。
    const message = `小红书任务已完成。\\n\\n浏览2篇。\\n\\nRECORD_JSON:${RECORD}`;
    const parsed = parseRecordJson(message);
    expect(parsed?.browsed).toBe(2);
    expect(parsed?.keyword).toBe("亲子酒店");
  });

  it("ignores the machine receipt line appended after the record", () => {
    const message = `汇报。\nRECORD_JSON:${RECORD}\n[回执] 各应用生效点击: com.xingin.xhs=11`;
    expect(parseRecordJson(message)?.browsed).toBe(2);
  });

  it("still parses the plain contract shape", () => {
    expect(parseRecordJson(`汇报\nRECORD_JSON:${RECORD}`)?.posts).toHaveLength(
      1,
    );
  });

  it("returns null without a marker", () => {
    expect(parseRecordJson("已浏览 2/2；没有结构化记录")).toBeNull();
  });
});

// ─── P1-2: 人设进任务头 ─────────────────────────────────────────────────────
import {
  buildSearchChunkTask,
  formatPersona,
} from "../src/services/xhs-ops-task-builder.js";

describe("persona in the phone task header (P1-2)", () => {
  const base = {
    label: "豆豆妈的周末计划",
    positioning: "用产品经理思维做零踩坑周末遛娃攻略",
    dwellSecMin: 10,
    dwellSecMax: 25,
    quota: {
      like: { enabled: false, max: 0 },
      collect: { enabled: false, max: 0 },
      follow: { enabled: false, max: 0 },
    },
  };

  it("formatPersona joins the non-empty demographics with ·", () => {
    expect(
      formatPersona({
        age: "32岁",
        gender: "女",
        region: "北京海淀",
        occupation: "互联网产品经理",
        lifeStatus: "2岁娃新手妈妈",
      }),
    ).toBe("32岁·女·北京海淀·互联网产品经理·2岁娃新手妈妈");
    expect(
      formatPersona({
        age: "",
        gender: " 女 ",
        region: "",
        occupation: "",
        lifeStatus: "",
      }),
    ).toBe("女");
    expect(formatPersona(null)).toBe("");
  });

  it("header carries 人设 when present and omits the segment when empty", () => {
    const withPersona = buildSearchChunkTask({
      ...base,
      persona: "32岁·女·北京海淀",
      keyword: "亲子酒店",
      count: 2,
    });
    expect(withPersona.split("\n")[0]).toBe(
      "【小红书内容研究任务｜账号定位：豆豆妈的周末计划｜人设：32岁·女·北京海淀｜用产品经理思维做零踩坑周末遛娃攻略】",
    );
    const without = buildSearchChunkTask({
      ...base,
      keyword: "亲子酒店",
      count: 2,
    });
    expect(without.split("\n")[0]).toBe(
      "【小红书内容研究任务｜账号定位：豆豆妈的周末计划｜用产品经理思维做零踩坑周末遛娃攻略】",
    );
  });
});

// ─── N2: every marker parser locates its payload the same way ───────────────

describe("marker parsers share extractMarkerPayload (takeover N2)", () => {
  const COLLECTED = "[已收集条目 共1条]\n1. 第1篇｜周末｜3";
  const TRAILERS =
    "[设备校验] 结束时仍有未解决的问题\n[回执] 各应用生效点击: com.xingin.xhs=3";
  /** The same receipt as the phone can deliver it. */
  const shapes = (line: string) => [
    line,
    `汇报一行\n${COLLECTED}\n${line}\n${TRAILERS}`,
    `汇报一行\\n${line}\\n[回执] 各应用生效点击: com.xingin.xhs=3`,
  ];
  const VERIFIED =
    'PROFILE_VERIFICATION_JSON:{"v":1,"status":"verified","accountMatched":true,"fields":{"nickname":true,"bio":true,"avatar":true,"cover":true,"gender":true,"birthday":true,"region":true}}';

  it.each([
    [
      "RECORD_JSON",
      `RECORD_JSON:${RECORD.replace("结果以图文酒店测评为主", "第一行\\n第二行")}`,
      (m: string) => parseRecordJson(m)?.observation,
      "第一行\n第二行",
    ],
    [
      "PROFILE_JSON",
      'PROFILE_JSON:{"nickname":"done","bio":"done","note":"第一行\\n第二行"}',
      (m: string) => parseProfileJson(m)?.note,
      "第一行\n第二行",
    ],
    [
      "IDENTITY_JSON",
      'IDENTITY_JSON:{"v":1,"status":"visible","accountId":"49268961587"}',
      (m: string) => parseAccountIdentityJson(m)?.accountId,
      "49268961587",
    ],
    [
      "PROFILE_READBACK_JSON",
      'PROFILE_READBACK_JSON:{"v":1,"status":"read","nickname":"云朵","bio":"第一行\\n第二行","gender":"","birthday":"","region":""}',
      (m: string) => parseProfileReadbackJson(m)?.bio,
      "第一行\n第二行",
    ],
    [
      "PROFILE_VERIFICATION_JSON",
      VERIFIED,
      (m: string) => parseProfileVerificationJson(m)?.status,
      "verified",
    ],
    [
      "COMMENT_JSON",
      'COMMENT_JSON:{"v":1,"status":"sent","detail":"第一行\\n第二行"}',
      (m: string) => parseCommentJson(m)?.detail,
      "第一行\n第二行",
    ],
  ])(
    "%s survives a multi-line value, the phone's surrounding lines and literal \\n",
    (_name, line, read, expected) => {
      for (const message of shapes(line)) expect(read(message)).toBe(expected);
    },
  );

  it("rejects a truncated payload in every parser", () => {
    const cut = (line: string) => line.slice(0, line.length - 3);
    expect(parseRecordJson(cut(`RECORD_JSON:${RECORD}`))).toBeNull();
    expect(parseProfileJson('PROFILE_JSON:{"nickname":"do')).toBeNull();
    expect(
      parseAccountIdentityJson('IDENTITY_JSON:{"v":1,"status":"visi'),
    ).toBeNull();
    expect(
      parseProfileReadbackJson('PROFILE_READBACK_JSON:{"v":1,"bio":"第一'),
    ).toBeNull();
    expect(parseProfileVerificationJson(cut(VERIFIED))).toBeNull();
    expect(parseCommentJson('COMMENT_JSON:{"status":"sent"')).toBeNull();
  });
});

// ─── A11: a short lead-in or a code fence before the object ──────────────────

describe("marker parsers tolerate a short lead-in or a fence (A11)", () => {
  const COMMENT = '{"v":1,"status":"sent","detail":"已发出","anomalies":[]}';
  const VERIFIED =
    '{"v":1,"status":"verified","accountMatched":true,"fields":{"nickname":true,"bio":true,"avatar":true,"cover":true,"gender":true,"birthday":true,"region":true}}';
  const RECEIPT = "[回执] 各应用生效点击: com.xingin.xhs=3";
  /** The ways the phone's model was seen wrapping a receipt. */
  const wrappings = (marker: string, body: string) => [
    `汇报一行\n${marker}${body}\n${RECEIPT}`,
    `汇报一行\n${marker} ${body}`,
    `汇报一行\n${marker}\n\`\`\`json\n${body}\n\`\`\`\n${RECEIPT}`,
    `汇报一行\n${marker} \`\`\`${body}\`\`\``,
    `汇报一行\n${marker} 结果如下：\n${body}\n${RECEIPT}`,
    `汇报一行\n${marker}结果如下：${body}`,
    `汇报一行\n${marker} 结果如下：\n\`\`\`json\n${body}\n\`\`\``,
    `汇报一行\\n${marker}\\n\`\`\`json\\n${body}\\n\`\`\``,
  ];

  it.each([
    [
      "COMMENT_JSON:",
      COMMENT,
      (m: string) => parseCommentJson(m)?.status,
      "sent",
    ],
    ["RECORD_JSON:", RECORD, (m: string) => parseRecordJson(m)?.browsed, 2],
    [
      "PROFILE_JSON:",
      '{"nickname":"done","note":"好"}',
      (m: string) => parseProfileJson(m)?.nickname,
      "done",
    ],
    [
      "IDENTITY_JSON:",
      '{"v":1,"status":"visible","accountId":"49268961587"}',
      (m: string) => parseAccountIdentityJson(m)?.accountId,
      "49268961587",
    ],
    [
      "PROFILE_VERIFICATION_JSON:",
      VERIFIED,
      (m: string) => parseProfileVerificationJson(m)?.status,
      "verified",
    ],
  ])("%s", (marker, body, read, expected) => {
    for (const message of wrappings(marker, body)) {
      expect(read(message), message).toBe(expected);
    }
  });

  it("skips nothing longer than one short lead-in", () => {
    // Too long to be a lead-in.
    expect(
      parseCommentJson(
        `COMMENT_JSON: 这一行说明写得太长了，已经远远超过了一句引导语该有的长度 ${COMMENT}`,
      ),
    ).toBeNull();
    // An empty marker followed by the phone's own lines, then an object.
    expect(
      parseCommentJson(`COMMENT_JSON:\n${RECEIPT}\n${COMMENT}`),
    ).toBeNull();
    expect(
      parseCommentJson(`COMMENT_JSON: 无\n[设备校验] 未通过\n${COMMENT}`),
    ).toBeNull();
    // Two lead-in lines.
    expect(
      parseCommentJson(`COMMENT_JSON: 结果如下\n见下：\n${COMMENT}`),
    ).toBeNull();
    // Another marker is not a lead-in.
    expect(
      parseProfileJson(
        'PROFILE_JSON: RECORD_JSON:{"nickname":"done","note":"好"}',
      ),
    ).toBeNull();
    // An array is not the object.
    expect(parseCommentJson(`COMMENT_JSON: [${COMMENT}]`)).toBeNull();
  });
});

// ─── A3: an existing account's sign-in code reads as login_required ──────────

describe("phone_required from an existing account's chunk (A3)", () => {
  it("parseRecordJson reads it as login_required, object or string form", () => {
    const record = (anomalies: string) =>
      parseRecordJson(
        `RECORD_JSON:${RECORD.replace('"anomalies":[]', `"anomalies":${anomalies}`)}`,
      )?.anomalies;
    expect(
      record('[{"type":"phone_required","detail":"手机号输入页"}]'),
    ).toEqual([{ type: "login_required", detail: "手机号输入页" }]);
    expect(record('["phone_required"]')).toEqual([
      { type: "login_required", detail: "" },
    ]);
    // The new-account code is unchanged.
    expect(record('[{"type":"login_required","detail":"登录页"}]')).toEqual([
      { type: "login_required", detail: "登录页" },
    ]);
  });

  it("parseCommentJson reads it as login_required", () => {
    expect(
      parseCommentJson(
        'COMMENT_JSON:{"v":1,"status":"skipped","detail":"未登录","anomalies":[{"type":"phone_required","detail":"手机号输入页"},"phone_required"]}',
      )?.anomalies,
    ).toEqual([
      { type: "login_required", detail: "手机号输入页" },
      { type: "login_required", detail: "" },
    ]);
  });
});
