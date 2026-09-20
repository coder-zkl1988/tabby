import type { WebContents } from "electron";
import { describe, expect, it, vi } from "vitest";
import {
  BrowserRefTable,
  captureSnapshot,
  describeRef,
  readPageError,
} from "../../apps/desktop/main/services/embedded-browser-cdp";

/**
 * The element listing handed to the agent, driven through a scripted CDP
 * session.
 *
 * Measured on a search results page before the de-duplication here: 287
 * nodes, 171 of them StaticText repeating the link or heading right above
 * them. Every one of those cost tokens and pushed real elements past the cap.
 */

type Responder = unknown | ((params: Record<string, unknown>) => unknown);

function fakeContents(responses: Record<string, Responder>): {
  contents: WebContents;
  calls: Array<{ method: string; params: Record<string, unknown> }>;
} {
  const calls: Array<{ method: string; params: Record<string, unknown> }> = [];
  const contents = {
    debugger: {
      isAttached: () => true,
      attach: vi.fn(),
      detach: vi.fn(),
      on: vi.fn(),
      sendCommand: async (method: string, params: Record<string, unknown>) => {
        calls.push({ method, params });
        const responder = responses[method];
        if (responder instanceof Error) throw responder;
        return typeof responder === "function"
          ? (responder as (p: Record<string, unknown>) => unknown)(params)
          : (responder ?? {});
      },
    },
    getURL: () => "https://example.com/",
    getTitle: () => "Doc",
  } as unknown as WebContents;
  return { contents, calls };
}

const ax = (
  nodeId: string,
  role: string,
  name: string,
  backendDOMNodeId: number,
  parentId?: string,
  extra: Record<string, unknown> = {},
) => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  backendDOMNodeId,
  ...(parentId ? { parentId } : {}),
  ...extra,
});

const AX_TREE = {
  nodes: [
    ax("n1", "RootWebArea", "Doc", 1),
    ax("n2", "generic", "", 2, "n1"),
    ax("n3", "link", "Learn more", 3, "n2"),
    ax("n4", "StaticText", "Learn more", 4, "n3"),
    ax("n5", "heading", "Title", 5, "n1"),
    ax("n6", "StaticText", "Title", 6, "n5"),
    ax("n7", "StaticText", "Body text not covered", 7, "n1"),
    ax("n8", "checkbox", "Agree", 8, "n1", {
      properties: [
        { name: "checked", value: { type: "tristate", value: "true" } },
      ],
    }),
    ax("n9", "button", "Go", 9, "n1", {
      properties: [
        { name: "disabled", value: { type: "boolean", value: true } },
      ],
    }),
    ax("n10", "img", "", 10, "n1"),
    ax("n11", "link", "Footer", 11, "n1"),
    ax("n12", "InlineTextBox", "x", 12, "n7"),
  ],
};

const STRINGS = [
  "HTML",
  "DIV",
  "A",
  "href",
  "/learn",
  "https://example.com/",
  "#text",
  "H1",
  "INPUT",
  "BUTTON",
  "IMG",
  "/footer",
];

const DOM_SNAPSHOT = {
  strings: STRINGS,
  documents: [
    {
      documentURL: 5,
      nodes: {
        backendNodeId: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        nodeName: [0, 1, 2, 6, 7, 6, 6, 8, 9, 10, 2],
        attributes: [[], [], [3, 4], [], [], [], [], [], [], [], [3, 11]],
      },
      layout: {
        nodeIndex: [0, 2, 4, 6, 7, 8, 10],
        bounds: [
          [0, 0, 800, 6000],
          [10, 10, 100, 20],
          [10, 40, 200, 30],
          [10, 80, 300, 20],
          [10, 120, 20, 20],
          [10, 160, 60, 30],
          [10, 5000, 100, 20],
        ],
      },
    },
  ],
};

const LAYOUT_METRICS = {
  cssLayoutViewport: {
    pageX: 0,
    pageY: 0,
    clientWidth: 800,
    clientHeight: 600,
  },
  cssContentSize: { width: 800, height: 6000 },
  cssVisualViewport: { pageX: 0, pageY: 0 },
};

const RESPONSES: Record<string, Responder> = {
  "Accessibility.getFullAXTree": AX_TREE,
  "DOMSnapshot.captureSnapshot": DOM_SNAPSHOT,
  "Page.getLayoutMetrics": LAYOUT_METRICS,
};

describe("captureSnapshot", () => {
  it("lists elements once, with links resolved and state flagged", async () => {
    const { contents } = fakeContents(RESPONSES);
    const snapshot = await captureSnapshot(contents, new BrowserRefTable(), {
      maxNodes: 400,
      visibleOnly: false,
    });

    expect(snapshot).toEqual({
      url: "https://example.com/",
      title: "Doc",
      truncated: false,
      visibleOnly: false,
      nodes: [
        { ref: "e1", role: "RootWebArea", name: "Doc", depth: 0 },
        {
          ref: "e2",
          role: "link",
          name: "Learn more",
          href: "https://example.com/learn",
          depth: 1,
        },
        { ref: "e3", role: "heading", name: "Title", depth: 1 },
        {
          ref: "e4",
          role: "StaticText",
          name: "Body text not covered",
          depth: 1,
        },
        { ref: "e5", role: "checkbox", name: "Agree", checked: true, depth: 1 },
        { ref: "e6", role: "button", name: "Go", disabled: true, depth: 1 },
        {
          ref: "e7",
          role: "link",
          name: "Footer",
          href: "https://example.com/footer",
          depth: 1,
        },
      ],
    });
  });

  it("keeps only what intersects the viewport when asked", async () => {
    const { contents } = fakeContents(RESPONSES);
    const snapshot = await captureSnapshot(contents, new BrowserRefTable(), {
      maxNodes: 400,
      visibleOnly: true,
    });

    expect(snapshot.visibleOnly).toBe(true);
    expect(snapshot.nodes.map((node) => node.name)).toEqual([
      "Doc",
      "Learn more",
      "Title",
      "Body text not covered",
      "Agree",
      "Go",
    ]);
  });

  it("scales the viewport into the snapshot's device-pixel space", async () => {
    // Measured live on a 2x display: DOMSnapshot bounds are device pixels,
    // the layout metrics are CSS pixels, and comparing them raw listed nothing
    // once the page was scrolled. Here the page is scrolled 500 CSS px down on
    // a 2x display: the 600px-tall viewport (device 1000..2200) must catch the
    // footer at device y=1500 and drop the header at device y=10.
    const { contents } = fakeContents({
      ...RESPONSES,
      "DOMSnapshot.captureSnapshot": {
        ...DOM_SNAPSHOT,
        documents: [
          {
            ...DOM_SNAPSHOT.documents[0],
            contentWidth: 1600,
            layout: {
              nodeIndex: [0, 2, 10],
              bounds: [
                [0, 0, 1600, 12000],
                [10, 10, 100, 20],
                [10, 1500, 100, 20],
              ],
            },
          },
        ],
      },
      "Page.getLayoutMetrics": {
        cssLayoutViewport: {
          pageX: 0,
          pageY: 500,
          clientWidth: 800,
          clientHeight: 600,
        },
        cssContentSize: { width: 800, height: 6000 },
        cssVisualViewport: { pageX: 0, pageY: 500 },
      },
    });
    const snapshot = await captureSnapshot(contents, new BrowserRefTable(), {
      maxNodes: 400,
      visibleOnly: true,
    });

    expect(snapshot.visibleOnly).toBe(true);
    expect(snapshot.nodes.map((node) => node.name)).toEqual(["Doc", "Footer"]);
  });

  it("falls back to the full listing, and says so, when geometry is unavailable", async () => {
    const { contents } = fakeContents({
      ...RESPONSES,
      "DOMSnapshot.captureSnapshot": new Error("not available"),
    });
    const snapshot = await captureSnapshot(contents, new BrowserRefTable(), {
      maxNodes: 400,
      visibleOnly: true,
    });

    expect(snapshot.visibleOnly).toBe(false);
    expect(snapshot.nodes).toHaveLength(7);
    // No geometry means no attributes either; the listing stays usable.
    expect(snapshot.nodes[1]?.href).toBeUndefined();
  });

  it("cuts the listing at maxNodes and flags it", async () => {
    const { contents } = fakeContents(RESPONSES);
    const snapshot = await captureSnapshot(contents, new BrowserRefTable(), {
      maxNodes: 2,
      visibleOnly: false,
    });

    expect(snapshot.truncated).toBe(true);
    expect(snapshot.nodes.map((node) => node.ref)).toEqual(["e1", "e2"]);
  });

  it("hands the same ref to the same node across snapshots", async () => {
    const { contents } = fakeContents(RESPONSES);
    const refs = new BrowserRefTable();
    const first = await captureSnapshot(contents, refs, {
      maxNodes: 400,
      visibleOnly: false,
    });
    const second = await captureSnapshot(contents, refs, {
      maxNodes: 400,
      visibleOnly: true,
    });

    expect(second.nodes.map((node) => node.ref)).toEqual(
      first.nodes.slice(0, 6).map((node) => node.ref),
    );
  });
});

describe("describeRef", () => {
  it("reads one element back through a partial tree fetch", async () => {
    const { contents, calls } = fakeContents({
      ...RESPONSES,
      "Accessibility.getPartialAXTree": (params) => ({
        nodes: [
          {
            nodeId: "p1",
            backendDOMNodeId: params.backendNodeId,
            role: { value: "textbox" },
            name: { value: "Search" },
            value: { value: "hello" },
          },
        ],
      }),
    });
    const refs = new BrowserRefTable();
    await captureSnapshot(contents, refs, {
      maxNodes: 400,
      visibleOnly: false,
    });

    const element = await describeRef(contents, refs, "e2");
    expect(element).toEqual({
      ref: "e2",
      role: "textbox",
      name: "Search",
      value: "hello",
      depth: 0,
    });
    expect(
      calls.find((call) => call.method === "Accessibility.getPartialAXTree")
        ?.params,
    ).toEqual({ backendNodeId: 3, fetchRelatives: false });
    // The whole tree is never re-walked for one element.
    expect(
      calls.filter((call) => call.method === "Accessibility.getFullAXTree"),
    ).toHaveLength(1);
  });

  it("reports an unknown ref, and a node CDP no longer has, as gone", async () => {
    const { contents } = fakeContents({
      ...RESPONSES,
      "Accessibility.getPartialAXTree": new Error("No node with given id"),
    });
    const refs = new BrowserRefTable();
    await captureSnapshot(contents, refs, {
      maxNodes: 400,
      visibleOnly: false,
    });

    expect(await describeRef(contents, refs, "e999")).toBeNull();
    expect(await describeRef(contents, refs, "e2")).toBeNull();
  });
});

describe("readPageError", () => {
  // The payload shape measured from a real `Runtime.exceptionThrown`: the
  // useful message lives in exception.description, whose first line is the
  // error and whose rest is a stack the agent cannot act on.
  it("takes the first line of the exception description", () => {
    expect(
      readPageError({
        exceptionDetails: {
          text: "Uncaught",
          url: "http://127.0.0.1:8767/index.html?v=2",
          lineNumber: 41,
          exception: {
            description:
              "Error: prompt() is not supported.\n    at HTMLButtonElement.<anonymous> (index.html:42:19)",
          },
        },
      }),
    ).toEqual({
      message: "Error: prompt() is not supported.",
      // CDP line numbers are zero-based; the file name is all the agent needs.
      source: "index.html:42",
    });
  });

  it("falls back to text when there is no exception object", () => {
    expect(
      readPageError({ exceptionDetails: { text: "Uncaught SyntaxError" } }),
    ).toEqual({ message: "Uncaught SyntaxError" });
  });

  it("ignores payloads with nothing to say", () => {
    expect(readPageError({})).toBeNull();
    expect(readPageError({ exceptionDetails: {} })).toBeNull();
    expect(readPageError({ exceptionDetails: { text: "   " } })).toBeNull();
    expect(readPageError(undefined)).toBeNull();
  });
});
