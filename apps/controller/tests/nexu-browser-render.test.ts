import { readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { EMBEDDED_BROWSER_TOOLS } from "../src/lib/openclaw-config-compiler.js";

// The browser tool surface is declared three times and none of the copies can
// import another: the plugin registers the tools, its manifest promises them
// to OpenClaw (`contracts.tools`), and the compiler grants them to every
// agent. A name missing from any one of them is a tool that silently never
// reaches the model. The rendering tests below pin the text the model reads,
// since that is the only channel through which evidence reaches it.

type Tool = { name: string };

type PluginModule = {
  default: {
    register: (api: {
      pluginConfig: Record<string, unknown>;
      logger: { info: ReturnType<typeof vi.fn> };
      on: (name: string, hook: unknown) => void;
      registerTool: (
        factory: () => Tool[],
        opts?: { names?: string[] },
      ) => void;
    }) => void;
  };
  BROWSER_TOOL_NAMES: string[];
  renderSnapshot: (snapshot: Record<string, unknown>) => string;
  renderObservation: (
    observation: Record<string, unknown>,
    options?: { expectElement?: boolean },
  ) => string;
};

async function loadPlugin(): Promise<PluginModule> {
  const pluginUrl = pathToFileURL(
    path.resolve(process.cwd(), "static/runtime-plugins/nexu-browser/index.js"),
  ).href;
  return (await import(pluginUrl)) as PluginModule;
}

describe("nexu-browser tool surface", () => {
  it("declares the same tools in the plugin, its manifest and the compiler", async () => {
    const plugin = await loadPlugin();
    const manifest = JSON.parse(
      await readFile(
        path.resolve(
          process.cwd(),
          "static/runtime-plugins/nexu-browser/openclaw.plugin.json",
        ),
        "utf8",
      ),
    ) as { contracts: { tools: string[] } };

    const sorted = (names: string[]) => [...names].sort();
    expect(sorted(manifest.contracts.tools)).toEqual(
      sorted(plugin.BROWSER_TOOL_NAMES),
    );
    expect(sorted(EMBEDDED_BROWSER_TOOLS)).toEqual(
      sorted(plugin.BROWSER_TOOL_NAMES),
    );
  });

  it("registers every declared tool under the names it declares", async () => {
    const plugin = await loadPlugin();
    let registered: { names: string[]; declared: string[] } | null = null;
    plugin.default.register({
      pluginConfig: {},
      logger: { info: vi.fn() },
      on: () => undefined,
      registerTool: (factory, opts) => {
        registered = {
          names: factory().map((tool) => tool.name),
          declared: opts?.names ?? [],
        };
      },
    });

    expect(registered).not.toBeNull();
    const { names, declared } = registered as unknown as {
      names: string[];
      declared: string[];
    };
    expect(names).toEqual(plugin.BROWSER_TOOL_NAMES);
    expect(declared).toEqual(plugin.BROWSER_TOOL_NAMES);
  });
});

describe("renderSnapshot", () => {
  it("shows each element once with its destination, state and indent", async () => {
    const { renderSnapshot } = await loadPlugin();
    const text = renderSnapshot({
      url: "https://example.com/",
      title: "Example",
      truncated: false,
      visibleOnly: false,
      nodes: [
        { ref: "e1", role: "RootWebArea", name: "Example", depth: 0 },
        {
          ref: "e2",
          role: "link",
          name: "Learn more",
          href: "https://example.com/learn",
          depth: 1,
        },
        {
          ref: "e3",
          role: "checkbox",
          name: "Agree",
          checked: false,
          depth: 1,
        },
        { ref: "e4", role: "button", name: "Go", disabled: true, depth: 1 },
      ],
    });

    expect(text).toBe(
      [
        "Example — https://example.com/",
        "Elements (act on a ref with browser_click / browser_type / browser_select / browser_press):",
        'e1 RootWebArea "Example"',
        '  e2 link "Learn more" → https://example.com/learn',
        '  e3 checkbox "Agree" [unchecked]',
        '  e4 button "Go" [disabled]',
      ].join("\n"),
    );
  });

  it("tells the agent how to get the rest of a cut-off listing", async () => {
    const { renderSnapshot } = await loadPlugin();
    const text = renderSnapshot({
      url: "https://example.com/",
      title: "Long",
      truncated: true,
      visibleOnly: false,
      nodes: [{ ref: "e1", role: "RootWebArea", name: "Long", depth: 0 }],
    });

    // The old hint said "scroll or raise maxNodes"; the tool had no maxNodes
    // and the tree is not viewport-bound, so scrolling changed nothing.
    expect(text).toContain("cut off after 1 elements");
    expect(text).toContain("larger maxNodes");
    expect(text).toContain("visibleOnly=true");
  });

  it("labels a viewport-only listing and an empty one", async () => {
    const { renderSnapshot } = await loadPlugin();
    const visible = renderSnapshot({
      url: "https://example.com/",
      title: "Canvas",
      truncated: false,
      visibleOnly: true,
      nodes: [],
    });
    expect(visible).toContain("Elements in the current viewport");
    expect(visible).toContain("browser_screenshot");
  });
});

describe("renderObservation", () => {
  it("reports a navigation and drops the element", async () => {
    const { renderObservation } = await loadPlugin();
    const text = renderObservation({
      url: "https://iana.org/",
      title: "IANA",
      navigated: true,
    });
    expect(text).toContain("navigated to a new document");
    expect(text).not.toContain("no longer on the page");
  });

  it("reports an in-place change with the element still there", async () => {
    const { renderObservation } = await loadPlugin();
    const text = renderObservation({
      url: "https://www.baidu.com/",
      title: "evidence check_百度搜索",
      navigated: false,
      changedInPlace: true,
      element: { ref: "e400", role: "RootWebArea", name: "results", depth: 0 },
    });
    expect(text).toContain("updated in place");
    expect(text).toContain('Element now: e400 RootWebArea "results"');
  });

  it("names auto-dismissed dialogs and a page that was still loading", async () => {
    const { renderObservation } = await loadPlugin();
    const text = renderObservation({
      url: "https://example.com/",
      title: "Example",
      navigated: false,
      loading: true,
      dialogs: [
        { type: "alert", message: "Saved" },
        { type: "confirm", message: "Delete this item?" },
      ],
      element: { ref: "e2", role: "button", name: "Delete", depth: 1 },
    });
    expect(text).toContain("still loading");
    expect(text).toContain(
      'A alert dialog appeared and was closed automatically: "Saved"',
    );
    expect(text).toContain(
      'A confirm dialog appeared and was dismissed automatically (treated as Cancel): "Delete this item?"',
    );
  });

  it("reports the scroll position and does not miss an element that was never targeted", async () => {
    const { renderObservation } = await loadPlugin();
    const text = renderObservation(
      {
        url: "https://example.com/",
        title: "Example",
        navigated: false,
        scroll: { y: 800, maxY: 800 },
      },
      { expectElement: false },
    );
    expect(text).toContain("Scroll position 800 of 800px (bottom of the page)");
    expect(text).not.toContain("no longer on the page");
  });

  it("explains a dead handler, and names prompt() as a browser limit rather than a broken site", async () => {
    const { renderObservation } = await loadPlugin();
    const text = renderObservation({
      url: "https://example.com/",
      title: "Example",
      navigated: false,
      element: { ref: "e9", role: "button", name: "Rename", depth: 2 },
      pageErrors: [
        { message: "Error: prompt() is not supported.", source: "app.js:12" },
      ],
    });

    expect(text).toContain("stopped part way");
    expect(text).toContain("Error: prompt() is not supported. (app.js:12)");
    // Without this the model reports the site as broken and retries the click.
    expect(text).toContain("limit of this browser");
    expect(text).toContain("Repeating the click will fail the same way");
  });

  it("reports an ordinary page error without the prompt advice", async () => {
    const { renderObservation } = await loadPlugin();
    const text = renderObservation({
      url: "https://example.com/",
      title: "Example",
      navigated: false,
      pageErrors: [{ message: "TypeError: x is not a function" }],
    });

    expect(text).toContain("TypeError: x is not a function");
    expect(text).not.toContain("limit of this browser");
  });

  it("says when a targeted element is gone", async () => {
    const { renderObservation } = await loadPlugin();
    const text = renderObservation({
      url: "https://example.com/",
      title: "Example",
      navigated: false,
    });
    expect(text).toContain("The element is no longer on the page.");
  });
});
