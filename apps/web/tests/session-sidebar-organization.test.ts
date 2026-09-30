import { describe, expect, it } from "vitest";
import {
  type SidebarSessionFilter,
  filterSidebarSessions,
  isScheduledSessionKey,
  sortSidebarSessions,
} from "../src/layouts/workspace-layout";

type SidebarSessionInput = Parameters<typeof filterSidebarSessions>[0][number];

function session(
  id: string,
  overrides: Partial<SidebarSessionInput> = {},
): SidebarSessionInput {
  return {
    id,
    title: id,
    channelType: "web",
    lastTime: "2026-08-03T02:00:00.000Z",
    status: "active",
    sessionKey: `agent:bot-1:${id}`,
    category: null,
    pinned: false,
    unread: false,
    archived: false,
    checkpointCount: 0,
    runState: "idle",
    ...overrides,
  };
}

describe("sidebar session organization", () => {
  const sessions = [
    session("ordinary"),
    session("unread", { unread: true, category: "Launch" }),
    session("running", { runState: "running" }),
    session("failed", { runState: "failed" }),
    session("archived", { archived: true }),
    session("scheduled", {
      sessionKey: "agent:bot-1:schedule-daily",
    }),
    // OpenClaw's own automations (weekly skill-collection review, memory
    // dreaming) are keyed `agent:<id>:cron:<jobId>`, not `:schedule-`.
    session("automation", {
      sessionKey: "agent:bot-1:cron:job-1",
    }),
    session("archived-scheduled", {
      sessionKey: "agent:bot-1:schedule-old",
      archived: true,
    }),
  ];

  it.each<[SidebarSessionFilter, string[]]>([
    [
      "all",
      ["ordinary", "unread", "running", "failed", "scheduled", "automation"],
    ],
    ["conversations", ["ordinary", "unread", "running", "failed"]],
    ["scheduled", ["scheduled", "automation"]],
    ["unread", ["unread"]],
    ["running", ["running"]],
    ["failed", ["failed"]],
    ["archived", ["archived", "archived-scheduled"]],
  ])("filters %s sessions", (filter, expected) => {
    expect(
      filterSidebarSessions(sessions, "", filter).map((item) => item.id),
    ).toEqual(expected);
  });

  it("searches custom group names", () => {
    expect(
      filterSidebarSessions(sessions, "launch", "all").map((item) => item.id),
    ).toEqual(["unread"]);
  });

  it("keeps pinned sessions first and otherwise sorts by activity", () => {
    const sorted = sortSidebarSessions([
      session("newest", { lastTime: "2026-08-03T03:00:00.000Z" }),
      session("pinned", {
        pinned: true,
        lastTime: "2026-08-01T03:00:00.000Z",
      }),
      session("middle", { lastTime: "2026-08-03T02:30:00.000Z" }),
    ]);

    expect(sorted.map((item) => item.id)).toEqual([
      "pinned",
      "newest",
      "middle",
    ]);
  });
});

describe("isScheduledSessionKey", () => {
  it.each<[string, boolean]>([
    ["agent:bot-1:schedule-daily", true],
    ["agent:bot-1:cron:job-1", true],
    ["agent:bot-1:cron:job-1:run:run-1", true],
    ["agent:bot-1:CRON:job-1", true],
    ["agent:bot-1:main", false],
    ["agent:bot-1:12345678-1234-1234-1234-123456789abc", false],
    ["agent:bot-1:slack:channel:cron:alerts", false],
  ])("classifies %s as scheduled=%s", (sessionKey, expected) => {
    expect(isScheduledSessionKey(sessionKey)).toBe(expected);
  });
});
