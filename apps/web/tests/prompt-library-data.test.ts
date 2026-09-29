/**
 * prompt-library-data.test.ts — third-party prompt library data layer.
 *
 * Network loaders are exercised through their pure parsing helpers plus
 * applyFilters/fetch-page slicing; actual GitHub fetches are not hit here.
 *
 * Matrix:
 *  a. splitAtHeading splits markdown into per-heading blocks
 *  b. matchFirst / markdownImages / absoluteImageUrl extraction
 *  c. headingTags / splitTags normalization
 *  d. applyFilters: keyword (title/prompt/category/tags), category, tag OR
 *  e. tag options derive from the un-tag-filtered scope (fetchPromptPage)
 */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ALL_PROMPTS_OPTION,
  type LibraryPrompt,
  __resetPromptDataForTests,
  absoluteImageUrl,
  applyFilters,
  fetchPromptPage,
  headingTags,
  isBadgeImage,
  loadAllSources,
  markdownImages,
  matchFirst,
  parseFreestyleflyCases,
  promptCoverPath,
  splitAtHeading,
  splitTags,
} from "../src/lib/canvas/prompt-library-data";

afterEach(() => {
  vi.unstubAllGlobals();
  __resetPromptDataForTests();
});

function makePrompt(overrides: Partial<LibraryPrompt>): LibraryPrompt {
  return {
    id: "p-1",
    title: "标题",
    coverUrl: "",
    prompt: "提示词",
    tags: [],
    category: "awesome-gpt-image",
    githubUrl: "https://github.com/example",
    ...overrides,
  };
}

describe("markdown parsing helpers", () => {
  it("a. splitAtHeading splits blocks at heading prefix", () => {
    const md = "intro\n## 一\ncontent-a\n## 二\ncontent-b";
    const blocks = splitAtHeading(md, "## ");
    expect(blocks).toHaveLength(3);
    expect(blocks[1]).toContain("## 一");
    expect(blocks[1]).toContain("content-a");
    expect(blocks[2]).toContain("## 二");
  });

  it("b. matchFirst extracts the first capture; markdownImages absolutizes", () => {
    expect(matchFirst("### 手办化\n正文", /^###\s+(.+)$/m)).toBe("手办化");
    expect(matchFirst("无匹配", /^###\s+(.+)$/m)).toBe("");

    const base = "https://raw.example.com/repo/main";
    const md = "![a](./images/a.png)\n![b](https://cdn.example.com/b.png)";
    expect(markdownImages(base, md)).toEqual([
      `${base}/images/a.png`,
      "https://cdn.example.com/b.png",
    ]);
    expect(absoluteImageUrl(base, "")).toBe("");
    expect(absoluteImageUrl(base, "/x.png")).toBe(`${base}/x.png`);
  });

  it("c. headingTags strips decoration and splits on separators", () => {
    expect(headingTags("🎨 风格 & 材质")).toEqual(["风格", "材质"]);
    expect(headingTags("人像/写真、创意")).toEqual(["人像", "写真", "创意"]);
    expect(splitTags("A/B/c", /\//)).toEqual(["a", "b", "c"]);
    expect(splitTags("", /\//)).toEqual([]);
  });
});

describe("applyFilters", () => {
  const items: LibraryPrompt[] = [
    makePrompt({
      id: "1",
      title: "手办化",
      prompt: "把照片变成手办",
      tags: ["3d", "手办"],
      category: "awesome-gpt-image",
    }),
    makePrompt({
      id: "2",
      title: "Ghibli style",
      prompt: "宫崎骏风格插画",
      tags: ["插画"],
      category: "youmind-gpt-image-2",
    }),
  ];

  it("d. keyword matches title/prompt/category/tags, case-insensitive", () => {
    expect(
      applyFilters(items, {
        keyword: "ghibli",
        category: ALL_PROMPTS_OPTION,
        tags: [],
      }),
    ).toHaveLength(1);
    expect(
      applyFilters(items, {
        keyword: "手办",
        category: ALL_PROMPTS_OPTION,
        tags: [],
      }),
    ).toHaveLength(1);
    expect(
      applyFilters(items, {
        keyword: "",
        category: "youmind-gpt-image-2",
        tags: [],
      }),
    ).toEqual([items[1]]);
    // tag filter is an OR across selected tags
    expect(
      applyFilters(items, {
        keyword: "",
        category: ALL_PROMPTS_OPTION,
        tags: ["插画", "不存在"],
      }),
    ).toEqual([items[1]]);
    // 全部 category matches everything
    expect(
      applyFilters(items, {
        keyword: "",
        category: ALL_PROMPTS_OPTION,
        tags: [],
      }),
    ).toHaveLength(2);
  });
});

describe("bundled snapshot fallback", () => {
  it("f. snapshot is non-empty, well-formed and category-capped", async () => {
    const snapshot = (await import(
      "../src/lib/canvas/prompt-library-snapshot.json"
    )) as { default: LibraryPrompt[] };
    const items = snapshot.default;
    expect(items.length).toBeGreaterThan(50);
    for (const item of items.slice(0, 10)) {
      expect(item.id).toBeTruthy();
      expect(item.title).toBeTruthy();
      expect(item.prompt).toBeTruthy();
      expect(item.category).toBeTruthy();
    }
  });

  it("g. fetchPromptPage serves the snapshot when the network is down", async () => {
    __resetPromptDataForTests();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.reject(new Error("offline"))) as typeof fetch;
    try {
      const page = await fetchPromptPage({ page: 1, pageSize: 5 });
      expect(page.total).toBeGreaterThan(50);
      expect(page.items).toHaveLength(5);
      expect(page.categories).toContain("freestylefly-gpt-image-2");
      const source = await fetchPromptPage({
        category: "freestylefly-gpt-image-2",
      });
      expect(source.total).toBe(541);
      expect(source.items[0]?.title).toBeTruthy();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("freestylefly prompt collection", () => {
  it("retries after a fully offline refresh without caching fallback as fresh", async () => {
    const fetch = vi.fn().mockRejectedValue(new Error("offline"));
    const setItem = vi.fn();
    vi.stubGlobal("fetch", fetch);
    vi.stubGlobal("localStorage", { getItem: () => null, setItem });
    await fetchPromptPage();
    await vi.waitFor(async () => {
      await fetchPromptPage();
      expect(fetch.mock.calls.length).toBeGreaterThanOrEqual(12);
    });
    expect(setItem).not.toHaveBeenCalled();
  });

  it("keeps tags contributed by duplicate prompts in the All view", async () => {
    vi.stubGlobal("localStorage", {
      getItem: () =>
        JSON.stringify({
          fetchedAt: Date.now(),
          items: [
            makePrompt({ id: "a", tags: ["插画"] }),
            makePrompt({ id: "b", tags: ["建筑"] }),
          ],
        }),
      setItem: vi.fn(),
    });
    const page = await fetchPromptPage();
    expect(page.total).toBe(1);
    expect(page.tags).toEqual(["插画", "建筑"]);
    expect((await fetchPromptPage({ tags: ["建筑"] })).items[0]?.id).toBe("b");
  });

  const row = {
    id: 544,
    title: "词汇学习卡",
    prompt: "Create a vocabulary poster.\nKeep [FRUIT] as a placeholder.",
    image: "/images/case544.jpg",
    category: "Charts & Infographics",
    styles: ["Realistic", "Poster"],
    scenes: ["Education"],
    sourceLabel: "@example",
    sourceUrl: "https://example.com/original",
  };

  it("preserves full prompt text, original attribution and resolves repository images", () => {
    const [prompt] = parseFreestyleflyCases({ cases: [row] });
    expect(prompt).toMatchObject({
      id: "freestylefly-gpt-image-2-0544",
      prompt: row.prompt,
      coverUrl:
        "https://raw.githubusercontent.com/freestylefly/awesome-gpt-image-2/main/data/images/case544.jpg",
      githubUrl:
        "https://github.com/freestylefly/awesome-gpt-image-2/blob/main/docs/gallery-part-2.md#case-544",
      sourceLabel: "@example",
      sourceUrl: row.sourceUrl,
    });
    expect(prompt?.tags).toContain("图表与信息图");
    expect(prompt?.tags).toContain("education");
  });

  it("skips malformed cases and duplicate ids and rejects executable or traversing URLs", () => {
    expect(parseFreestyleflyCases(null)).toEqual([]);
    expect(parseFreestyleflyCases({ cases: {} })).toEqual([]);
    const items = parseFreestyleflyCases({
      cases: [
        null,
        {},
        { ...row, prompt: 3 },
        { ...row, id: -1 },
        {
          ...row,
          sourceUrl: "javascript:alert(1)",
          image: "/images/../private.png",
        },
        row,
      ],
    });
    expect(items).toHaveLength(1);
    expect(items[0]?.sourceUrl).toBeUndefined();
    expect(items[0]?.coverUrl).toBe("");
  });

  it("deduplicates identical text in 全部 while preserving each source's complete collection", () => {
    const prompts = [
      makePrompt({
        id: "new-1",
        category: "freestylefly-gpt-image-2",
        prompt: "Draw a cat",
      }),
      makePrompt({ id: "old-1", prompt: "Draw  a\ncat" }),
      makePrompt({ id: "old-2", prompt: "Draw a dog" }),
    ];
    expect(
      applyFilters(prompts, {
        keyword: "",
        category: ALL_PROMPTS_OPTION,
        tags: [],
      }).map((item) => item.id),
    ).toEqual(["new-1", "old-2"]);
    expect(
      applyFilters(prompts, {
        keyword: "",
        category: "awesome-gpt-image",
        tags: [],
      }).map((item) => item.id),
    ).toEqual(["old-1", "old-2"]);
  });

  it("keeps an unavailable collection in the snapshot when other sources refresh successfully", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        if (url.includes("freestylefly/"))
          return {
            ok: true,
            text: async () => JSON.stringify({ cases: [row] }),
          };
        throw new Error("source unavailable");
      }),
    );
    const items = await loadAllSources();
    expect(
      items.filter((item) => item.category === "freestylefly-gpt-image-2"),
    ).toHaveLength(1);
    expect(
      items.filter((item) => item.category === "awesome-gpt-image"),
    ).toHaveLength(53);
    expect(
      await loadAllSources({
        categories: ["awesome-gpt-image"],
        fallbackToSnapshot: false,
      }),
    ).toEqual([]);
  });

  it("does not let an old fresh cache hide the newly bundled source", async () => {
    vi.stubGlobal("localStorage", {
      getItem: (key: string) =>
        key === "nexu:canvas:prompt-cache"
          ? JSON.stringify({ fetchedAt: Date.now(), items: [makePrompt({})] })
          : null,
      setItem: vi.fn(),
    });
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const page = await fetchPromptPage({
      category: "freestylefly-gpt-image-2",
    });
    expect(page.total).toBe(541);
    await loadAllSources();
  });
});

describe("cover routing helpers", () => {
  it("h. badge images are never covers", () => {
    expect(isBadgeImage("https://img.shields.io/badge/x-y-blue")).toBe(true);
    expect(
      isBadgeImage("https://raw.githubusercontent.com/a/b/cover.png"),
    ).toBe(false);
    const md =
      "![badge](https://img.shields.io/badge/a-b) ![c](./images/c.png)";
    expect(markdownImages("https://raw.example.com/r/main", md)).toEqual([
      "https://raw.example.com/r/main/images/c.png",
    ]);
  });

  it("i. promptCoverPath proxies allowed hosts, passes others through", () => {
    const gh = "https://raw.githubusercontent.com/a/b/c.png";
    expect(promptCoverPath(gh)).toBe(
      `/api/v1/media/prompt-cover?url=${encodeURIComponent(gh)}`,
    );
    // twimg deliberately loads DIRECT: proxying it hangs our origin's
    // connection pool when the CDN is unreachable (see isProxyableCoverUrl).
    const twimg = "https://pbs.twimg.com/media/x.jpg";
    expect(promptCoverPath(twimg)).toBe(twimg);
    // non-allowlisted host loads direct
    expect(promptCoverPath("https://cdn.example.com/x.png")).toBe(
      "https://cdn.example.com/x.png",
    );
    // http (non-https) is not proxyable
    expect(promptCoverPath("http://raw.githubusercontent.com/x.png")).toBe(
      "http://raw.githubusercontent.com/x.png",
    );
    expect(promptCoverPath("")).toBe("");
  });
});
