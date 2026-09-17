import { describe, expect, it } from "vitest";
import {
  commentTextProblem,
  emptyProfileDraft,
  isRunQueued,
  normalizeBrowseDefaults,
  normalizeInteractionConfig,
  normalizeProfileDraft,
  normalizeRunSegment,
  normalizeSchedule,
  segmentLabel,
} from "../src/lib/a2ui/custom-components/xhs-ops/xhs-ops-types";

describe("xhs-ops web normalizers (P2-3 daily segments)", () => {
  it("normalizeBrowseDefaults fills and clamps the daily target/segment fields", () => {
    expect(normalizeBrowseDefaults({})).toMatchObject({
      dwellSecMin: 11,
      dailyTargetPosts: 90,
      dailySegments: 2,
    });
    expect(normalizeBrowseDefaults({ dwellSecMin: 7 })).toMatchObject({
      dwellSecMin: 7,
    });
    expect(
      normalizeBrowseDefaults({ dailyTargetPosts: 999, dailySegments: 7 }),
    ).toMatchObject({ dailyTargetPosts: 150, dailySegments: 3 });
    expect(
      normalizeBrowseDefaults({ dailyTargetPosts: "40", dailySegments: "2" }),
    ).toMatchObject({ dailyTargetPosts: 40, dailySegments: 2 });
  });

  it("normalizeRunSegment rejects malformed segments", () => {
    expect(normalizeRunSegment({ index: 2, count: 3 })).toEqual({
      index: 2,
      count: 3,
    });
    expect(normalizeRunSegment({ index: 3, count: 2 })).toBeNull();
    expect(normalizeRunSegment({ index: 0, count: 2 })).toBeNull();
    expect(normalizeRunSegment(null)).toBeNull();
    expect(normalizeRunSegment("x")).toBeNull();
  });

  it("segmentLabel is empty for single runs", () => {
    expect(segmentLabel(null)).toBe("");
    expect(segmentLabel({ index: 1, count: 1 })).toBe("");
    expect(segmentLabel({ index: 2, count: 3 })).toBe("第 2/3 段");
  });

  it("normalizeSchedule defaults and validates HH:mm (P2-4)", () => {
    expect(normalizeSchedule(undefined)).toEqual({
      enabled: false,
      time: "10:00",
      lastTriggeredDate: null,
      lastResult: null,
    });
    expect(normalizeSchedule({ enabled: true, time: "9:30" }).time).toBe(
      "10:00",
    );
    expect(
      normalizeSchedule({
        enabled: "yes",
        time: "21:05",
        lastTriggeredDate: "2026-09-05",
        lastResult: "ok",
      }),
    ).toEqual({
      enabled: false,
      time: "21:05",
      lastTriggeredDate: "2026-09-05",
      lastResult: "ok",
    });
  });

  it("isRunQueued only for planned runs parked behind another run", () => {
    expect(isRunQueued({ status: "planned", queuedBehindRunId: "r1" })).toBe(
      true,
    );
    expect(isRunQueued({ status: "planned", queuedBehindRunId: null })).toBe(
      false,
    );
    expect(isRunQueued({ status: "running", queuedBehindRunId: "r1" })).toBe(
      false,
    );
    expect(isRunQueued(null)).toBe(false);
  });

  it("normalizeInteractionConfig upgrades the legacy comment literal and clamps the cap to 5 (P3-1)", () => {
    expect(
      normalizeInteractionConfig({ comment: { enabled: false } }).comment,
    ).toEqual({ enabled: false, dailyCap: 2 });
    expect(
      normalizeInteractionConfig({ comment: { enabled: true, dailyCap: 9 } })
        .comment,
    ).toEqual({ enabled: true, dailyCap: 5 });
    expect(normalizeInteractionConfig(undefined).comment).toEqual({
      enabled: false,
      dailyCap: 2,
    });
    expect(
      normalizeInteractionConfig({
        follow: { enabled: true, targetTypes: ["教练", "俱乐部"] },
      }).follow.targetTypes,
    ).toEqual(["教练", "俱乐部"]);
  });

  it("preserves the complete profile draft and server verification receipt", () => {
    expect(emptyProfileDraft()).toMatchObject({
      gender: "",
      birthday: "",
      region: "",
      interestTags: [],
      verifiedAt: null,
      verifiedAccountId: null,
      verificationTaskId: null,
    });
    expect(
      normalizeProfileDraft({
        gender: "女",
        birthday: "1995-01-01",
        region: "杭州",
        interestTags: ["羽毛球", "咖啡"],
        verifiedAt: "2026-09-09T12:00:00.000Z",
        verifiedAccountId: "xhs-account",
        verificationTaskId: "verify-task",
      }),
    ).toMatchObject({
      gender: "女",
      birthday: "1995-01-01",
      region: "杭州",
      interestTags: ["羽毛球", "咖啡"],
      verifiedAt: "2026-09-09T12:00:00.000Z",
      verifiedAccountId: "xhs-account",
      verificationTaskId: "verify-task",
    });
    expect(normalizeProfileDraft({ gender: "未知" }).gender).toBe("");
  });

  it("commentTextProblem mirrors the server's length rules", () => {
    expect(commentTextProblem("儿童用品齐全太省心")).toBeNull();
    expect(commentTextProblem("好")).toBe("至少 2 个字");
    expect(commentTextProblem("这家酒店的亲子房真的很不错啊")).toContain(
      "超过 10 字",
    );
    expect(commentTextProblem("好看\n真好看")).toBe("不能换行");
  });
});
