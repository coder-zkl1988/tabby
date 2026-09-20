import { describe, expect, it } from "vitest";
import {
  type ActionSettleReport,
  buildObservation,
  drainFrames,
  parseCommandFrame,
  parseRunEndedFrame,
} from "../../apps/desktop/main/services/agent-browser-protocol";

const quiet: ActionSettleReport = {
  navigated: false,
  inPageNavigated: false,
  loading: false,
  dialogs: [],
  pageErrors: [],
};
const page = (url: string, title = "Page") => ({ url, title });

describe("parseCommandFrame", () => {
  it("reads a command envelope", () => {
    const frame = [
      "event: command",
      `data: ${JSON.stringify({
        requestId: "r1",
        sessionKey: "agent:bot:main",
        command: { action: "snapshot" },
      })}`,
    ].join("\n");

    expect(parseCommandFrame(frame)).toEqual({
      requestId: "r1",
      sessionKey: "agent:bot:main",
      command: { action: "snapshot" },
    });
  });

  it("ignores the stream's own keepalive traffic", () => {
    // The controller sends `connected` and `ping` on the same stream; treating
    // either as a command would dispatch garbage into the browser.
    expect(parseCommandFrame("event: ping\ndata: ping")).toBeNull();
    expect(parseCommandFrame("event: connected\ndata: connected")).toBeNull();
    expect(parseCommandFrame("event: command\ndata: not-json")).toBeNull();
    expect(parseCommandFrame("event: command")).toBeNull();
  });
});

describe("parseRunEndedFrame", () => {
  it("reads a run-ended signal and rejects everything else", () => {
    expect(
      parseRunEndedFrame(
        'event: run-ended\ndata: {"sessionKey":"agent:bot:main"}',
      ),
    ).toEqual({ sessionKey: "agent:bot:main" });
    // A command frame is not a run end; treating one as the other would
    // release the panel pin mid-task.
    expect(
      parseRunEndedFrame('event: command\ndata: {"sessionKey":"x"}'),
    ).toBeNull();
    expect(parseRunEndedFrame("event: run-ended\ndata: not-json")).toBeNull();
  });
});

describe("drainFrames", () => {
  it("keeps a partial frame for the next chunk", () => {
    // A command split across two TCP reads must not be parsed as two halves.
    const first = drainFrames("event: command\ndata: {}\n\nevent: com");
    expect(first.frames).toEqual(["event: command\ndata: {}"]);
    expect(first.rest).toBe("event: com");

    const second = drainFrames(`${first.rest}mand\ndata: {}\n\n`);
    expect(second.frames).toEqual(["event: command\ndata: {}"]);
    expect(second.rest).toBe("");
  });
});

describe("buildObservation", () => {
  it("reports the element that was acted on when the page stayed put", () => {
    const observation = buildObservation({
      before: page("https://example.com/"),
      after: page("https://example.com/"),
      settle: quiet,
      element: {
        ref: "e7",
        role: "textbox",
        name: "Search",
        value: "badminton",
        depth: 3,
      },
    });

    expect(observation).toEqual({
      url: "https://example.com/",
      title: "Page",
      navigated: false,
      element: {
        ref: "e7",
        role: "textbox",
        name: "Search",
        value: "badminton",
        depth: 3,
      },
    });
  });

  it("reports no element once a navigation has reset the refs", () => {
    // e5 on the new page is a different element entirely. Returning it would
    // answer "here is what you acted on" with something never touched — the
    // exact false evidence this observation exists to rule out.
    const observation = buildObservation({
      before: page("https://example.com/"),
      after: page("https://iana.org/", "IANA"),
      settle: { ...quiet, navigated: true },
      element: { ref: "e5", role: "image", name: "Homepage", depth: 7 },
    });

    expect(observation.navigated).toBe(true);
    expect(observation.changedInPlace).toBeUndefined();
    expect(observation.element).toBeUndefined();
  });

  it("treats a reload as a navigation even though the URL is unchanged", () => {
    // Same URL, new document: the refs are gone all the same. Comparing URLs
    // called this "nothing happened" and handed back a stale element.
    const observation = buildObservation({
      before: page("https://example.com/"),
      after: page("https://example.com/"),
      settle: { ...quiet, navigated: true },
      element: { ref: "e7", role: "button", name: "Go", depth: 3 },
    });

    expect(observation.navigated).toBe(true);
    expect(observation.element).toBeUndefined();
  });

  it("reports an in-place change when the document survived but moved on", () => {
    // Baidu's home page runs a search without leaving the document: the URL
    // stays, the title flips to the results page. That is not a navigation —
    // the refs still resolve — but it is not "nothing happened" either.
    const observation = buildObservation({
      before: page("https://www.baidu.com/", "百度一下，你就知道"),
      after: page("https://www.baidu.com/", "evidence check_百度搜索"),
      settle: quiet,
      element: { ref: "e400", role: "RootWebArea", name: "results", depth: 0 },
    });

    expect(observation.navigated).toBe(false);
    expect(observation.changedInPlace).toBe(true);
    expect(observation.element?.ref).toBe("e400");
  });

  it("reports a pushState route as an in-place change with the element kept", () => {
    const observation = buildObservation({
      before: page("https://app.example/inbox"),
      after: page("https://app.example/inbox/42"),
      settle: { ...quiet, inPageNavigated: true },
      element: { ref: "e9", role: "link", name: "Thread 42", depth: 2 },
    });

    expect(observation.navigated).toBe(false);
    expect(observation.changedInPlace).toBe(true);
    expect(observation.element?.ref).toBe("e9");
  });

  it("treats a URL change with no event behind it as a missed navigation", () => {
    // The load started after the settle window closed. Reporting "in place"
    // would let the agent keep acting on refs of a document that is gone.
    const observation = buildObservation({
      before: page("https://example.com/"),
      after: page("https://example.com/next"),
      settle: quiet,
      element: { ref: "e7", role: "button", name: "Next", depth: 3 },
    });

    expect(observation.navigated).toBe(true);
    expect(observation.element).toBeUndefined();
  });

  it("reports no element when the click removed it", () => {
    const observation = buildObservation({
      before: page("https://example.com/"),
      after: page("https://example.com/"),
      settle: quiet,
      element: null,
    });

    expect(observation.navigated).toBe(false);
    expect(observation.element).toBeUndefined();
  });

  it("carries dialogs, a still-loading page and the scroll position through", () => {
    const observation = buildObservation({
      before: page("https://example.com/"),
      after: page("https://example.com/"),
      settle: {
        ...quiet,
        loading: true,
        dialogs: [{ type: "confirm", message: "Delete this item?" }],
      },
      element: null,
      scroll: { y: 800, maxY: 800 },
    });

    expect(observation.loading).toBe(true);
    expect(observation.dialogs).toEqual([
      { type: "confirm", message: "Delete this item?" },
    ]);
    expect(observation.scroll).toEqual({ y: 800, maxY: 800 });
  });

  it("carries page errors through, which is the only trace a dead handler leaves", () => {
    // The click landed on the right element and the element did not change,
    // because the page's handler threw part way. Without the error that is
    // indistinguishable from a click that missed.
    const observation = buildObservation({
      before: page("https://example.com/"),
      after: page("https://example.com/"),
      settle: {
        ...quiet,
        pageErrors: [
          { message: "Error: prompt() is not supported.", source: "app.js:12" },
        ],
      },
      element: { ref: "e9", role: "button", name: "Rename", depth: 2 },
    });

    expect(observation.pageErrors).toEqual([
      { message: "Error: prompt() is not supported.", source: "app.js:12" },
    ]);
    expect(observation.element?.ref).toBe("e9");
  });
});
