/**
 * prompt-panel-utils.test.ts
 *
 * TDD (W2.4): tests for pure helpers in prompt-panel-utils.ts.
 * Plain Node env — no jsdom, no DOM events.
 */

import { describe, expect, it } from "vitest";
import {
  buildReferenceChips,
  chipSiblingCount,
  labelUpstreamTextBlocks,
  mentionQueryAt,
  mergeUpstreamPrompt,
  resolveImagePixelSize,
  servablePathFromUrl,
  servableSourceOf,
  upstreamSummary,
  usableReferencePaths,
} from "../src/lib/canvas/prompt-panel-utils";

describe("servablePathFromUrl", () => {
  it("returns decoded path param for a valid state-file URL", () => {
    const url =
      "/api/v1/media/state-file?path=%2Fhome%2Fuser%2F.nexu%2Fimg%2Fabc.png";
    expect(servablePathFromUrl(url)).toBe("/home/user/.nexu/img/abc.png");
  });

  it("returns decoded path param for an absolute-origin state-file URL", () => {
    const url =
      "http://localhost:3000/api/v1/media/state-file?path=%2Fhome%2Fimg.png";
    expect(servablePathFromUrl(url)).toBe("/home/img.png");
  });

  it("returns path with encoded chars decoded (spaces, etc.)", () => {
    const url = "/api/v1/media/state-file?path=%2Ffoo%20bar%2Fimage.png";
    expect(servablePathFromUrl(url)).toBe("/foo bar/image.png");
  });

  it("returns null for a dataURL", () => {
    const url = "data:image/png;base64,abc123";
    expect(servablePathFromUrl(url)).toBeNull();
  });

  it("returns null for a foreign URL that is not state-file", () => {
    const url = "http://example.com/some/image.png";
    expect(servablePathFromUrl(url)).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(servablePathFromUrl("")).toBeNull();
  });

  it("returns null for a URL with extra path prefix before state-file", () => {
    const url = "http://evil.com/x/api/v1/media/state-file?path=%2Fabs%2Fp.png";
    expect(servablePathFromUrl(url)).toBeNull();
  });
});

describe("usableReferencePaths", () => {
  it("returns servable paths from a mixed list, dropping dataURLs", () => {
    const images = [
      "data:image/png;base64,abc",
      "/api/v1/media/state-file?path=%2Fimg%2Fa.png",
      "data:image/jpeg;base64,def",
      "/api/v1/media/state-file?path=%2Fimg%2Fb.png",
    ];
    expect(usableReferencePaths(images)).toEqual(["/img/a.png", "/img/b.png"]);
  });

  it("caps at 4 items", () => {
    const images = [
      "/api/v1/media/state-file?path=%2Fimg%2F1.png",
      "/api/v1/media/state-file?path=%2Fimg%2F2.png",
      "/api/v1/media/state-file?path=%2Fimg%2F3.png",
      "/api/v1/media/state-file?path=%2Fimg%2F4.png",
      "/api/v1/media/state-file?path=%2Fimg%2F5.png",
    ];
    const result = usableReferencePaths(images);
    expect(result).toHaveLength(4);
    expect(result[0]).toBe("/img/1.png");
    expect(result[3]).toBe("/img/4.png");
  });

  it("returns empty array for all dataURLs", () => {
    const images = ["data:image/png;base64,a", "data:image/png;base64,b"];
    expect(usableReferencePaths(images)).toEqual([]);
  });

  it("returns empty array for empty input", () => {
    expect(usableReferencePaths([])).toEqual([]);
  });
});

describe("mentionQueryAt", () => {
  it("returns query when @ is at start of text and caret is at end", () => {
    // "@foo" with caret at 4
    const result = mentionQueryAt("@foo", 4);
    expect(result).toEqual({ query: "foo", start: 0 });
  });

  it("returns query when @ appears after a space mid-text", () => {
    // "hello @world" — @ at index 6, caret at 12
    const result = mentionQueryAt("hello @world", 12);
    expect(result).toEqual({ query: "world", start: 6 });
  });

  it("returns null when there is no @ before the caret", () => {
    const result = mentionQueryAt("hello world", 11);
    expect(result).toBeNull();
  });

  it("returns null when @ is followed by whitespace before caret (inactive mention)", () => {
    // "@ something" — whitespace between @ and caret position (3 = 'e')
    const result = mentionQueryAt("@ something", 3);
    expect(result).toBeNull();
  });

  it("returns query with caret mid-token", () => {
    // "@fo" — caret at 3 (mid-way through "@foo")
    const result = mentionQueryAt("@foo bar", 3);
    expect(result).toEqual({ query: "fo", start: 0 });
  });

  it("returns null when caret is before the @", () => {
    const result = mentionQueryAt("@foo", 0);
    // caret at 0, before the @, so no active token
    expect(result).toBeNull();
  });

  it("returns query when caret is right after @", () => {
    // "@" — caret at 1, query is empty
    const result = mentionQueryAt("@", 1);
    expect(result).toEqual({ query: "", start: 0 });
  });

  it("picks the LAST @ before caret when multiple @ exist", () => {
    // "hello @alice @bo" — caret at 16, last @ at 13
    const result = mentionQueryAt("hello @alice @bo", 16);
    expect(result).toEqual({ query: "bo", start: 13 });
  });
});

describe("servableSourceOf", () => {
  it("returns servable path for image node with state-file content URL", () => {
    const node = {
      type: "image" as const,
      metadata: {
        content: "/api/v1/media/state-file?path=%2Fnexu%2Fimg%2Fabc.png",
      },
    };
    expect(servableSourceOf(node)).toBe("/nexu/img/abc.png");
  });

  it("returns null for image node with dataURL content (not servable)", () => {
    const node = {
      type: "image" as const,
      metadata: { content: "data:image/png;base64,abc123" },
    };
    expect(servableSourceOf(node)).toBeNull();
  });

  it("returns null for text node even with servable URL content", () => {
    const node = {
      type: "text" as const,
      metadata: { content: "/api/v1/media/state-file?path=%2Fimg%2Fx.png" },
    };
    expect(servableSourceOf(node)).toBeNull();
  });

  it("returns null for image node with no content", () => {
    const node = {
      type: "image" as const,
      metadata: {},
    };
    expect(servableSourceOf(node)).toBeNull();
  });

  it("returns null for video node with servable URL (only image supported)", () => {
    const node = {
      type: "video" as const,
      metadata: { content: "/api/v1/media/state-file?path=%2Fimg%2Fv.mp4" },
    };
    expect(servableSourceOf(node)).toBeNull();
  });
});

describe("upstreamSummary", () => {
  it("returns 无上游输入 for empty upstream", () => {
    const result = upstreamSummary(
      { prompts: [], images: [], videos: [], audios: [] },
      0,
    );
    expect(result).toBe("无上游输入");
  });

  it("all groups populated: shows all with correct counts", () => {
    const result = upstreamSummary(
      {
        prompts: ["a", "b"],
        images: ["img1", "img2", "img3"],
        videos: ["vid1"],
        audios: ["aud1", "aud2"],
      },
      3, // usable == total images → no parenthetical
    );
    // usableImages === images.length → no 可用 sub-count
    expect(result).toBe("文本 2 · 参考图 3 · 视频 1 · 音频 2");
  });

  it("shows 可用 count only when it differs from total images", () => {
    const result = upstreamSummary(
      { prompts: [], images: ["img1", "img2", "img3"], videos: [], audios: [] },
      1, // only 1 usable out of 3
    );
    expect(result).toBe("参考图 3（可用 1）");
  });

  it("omits zero groups", () => {
    const result = upstreamSummary(
      { prompts: ["hello"], images: [], videos: ["v"], audios: [] },
      0,
    );
    expect(result).toBe("文本 1 · 视频 1");
  });

  it("single group only: text only", () => {
    const result = upstreamSummary(
      { prompts: ["a", "b", "c"], images: [], videos: [], audios: [] },
      0,
    );
    expect(result).toBe("文本 3");
  });

  it("images only, usable equals total (no parenthetical)", () => {
    const result = upstreamSummary(
      { prompts: [], images: ["a", "b"], videos: [], audios: [] },
      2,
    );
    expect(result).toBe("参考图 2");
  });
});

describe("mergeUpstreamPrompt", () => {
  it("joins local prompt then labeled upstream prompts, blank-line separated", () => {
    expect(mergeUpstreamPrompt("a landscape", ["always mention a cat"])).toBe(
      "a landscape\n\n【文本1】\nalways mention a cat",
    );
  });

  it("local prompt alone (no upstream) is unchanged", () => {
    expect(mergeUpstreamPrompt("a landscape", [])).toBe("a landscape");
  });

  it("upstream text alone (empty local draft) still produces a usable prompt", () => {
    expect(mergeUpstreamPrompt("", ["always mention a cat"])).toBe(
      "【文本1】\nalways mention a cat",
    );
  });

  it("trims each part and drops empty/whitespace-only entries before numbering", () => {
    // The dropped blanks must not consume a number — 【文本1】 is the first
    // block that actually reaches the prompt, so the reference bar agrees.
    expect(mergeUpstreamPrompt("  a landscape  ", ["  ", "a cat", ""])).toBe(
      "a landscape\n\n【文本1】\na cat",
    );
  });

  it("multiple upstream text nodes join in order, numbered from 1", () => {
    expect(mergeUpstreamPrompt("base", ["one", "two"])).toBe(
      "base\n\n【文本1】\none\n\n【文本2】\ntwo",
    );
  });

  it("both empty yields an empty string", () => {
    expect(mergeUpstreamPrompt("  ", ["", "  "])).toBe("");
  });
});

describe("labelUpstreamTextBlocks", () => {
  it("numbers surviving blocks from 1 after dropping blanks", () => {
    expect(labelUpstreamTextBlocks(["  ", " one ", "", "two"])).toEqual([
      "【文本1】\none",
      "【文本2】\ntwo",
    ]);
  });

  it("labels a lone block too — a single 文本1 still needs a name to reference", () => {
    expect(labelUpstreamTextBlocks(["only"])).toEqual(["【文本1】\nonly"]);
  });
});

describe("resolveImagePixelSize", () => {
  it("resolves each tier for a given aspect ratio", () => {
    expect(resolveImagePixelSize("1K", "1:1")).toBe("1024x1024");
    expect(resolveImagePixelSize("2K", "16:9")).toBe("2048x1152");
    expect(resolveImagePixelSize("4K", "9:16")).toBe("2160x3840");
  });

  it("returns undefined when either half is unset", () => {
    expect(resolveImagePixelSize("", "16:9")).toBeUndefined();
    expect(resolveImagePixelSize("2K", "")).toBeUndefined();
  });

  it("returns undefined for a pair with no table entry", () => {
    expect(resolveImagePixelSize("8K", "1:1")).toBeUndefined();
    expect(resolveImagePixelSize("2K", "21:9")).toBeUndefined();
  });
});

describe("buildReferenceChips", () => {
  const textNode = {
    id: "t1",
    type: "text" as const,
    title: "文案",
    position: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
    metadata: { content: "  a cat  " },
  };
  const servableImage = {
    id: "i1",
    type: "image" as const,
    title: "参考图",
    position: { x: 0, y: 0 },
    size: { width: 0, height: 0 },
    metadata: {
      content: "/api/v1/media/state-file?path=%2Fabs%2Fref.png",
    },
  };
  const uploadedImage = {
    ...servableImage,
    id: "i2",
    title: "上传图",
    metadata: { content: "data:image/png;base64,AAAA" },
  };

  it("numbers text chips the same way the prompt does", () => {
    const chips = buildReferenceChips(
      [
        { node: textNode, edgeId: "e1" },
        {
          node: { ...textNode, id: "t2", metadata: { content: "b" } },
          edgeId: "e2",
        },
      ],
      true,
    );
    expect(chips.map((c) => c.label)).toEqual(["【文本1】", "【文本2】"]);
    expect(chips[0]?.preview).toBe("a cat");
  });

  it("skips empty text and empty media — nothing to reference", () => {
    const chips = buildReferenceChips(
      [
        { node: { ...textNode, metadata: { content: "   " } }, edgeId: "e1" },
        { node: { ...servableImage, metadata: {} }, edgeId: "e2" },
      ],
      true,
    );
    expect(chips).toEqual([]);
  });

  it("marks a dataURL upload unusable — the backend cannot take it", () => {
    const chips = buildReferenceChips(
      [
        { node: servableImage, edgeId: "e1" },
        { node: uploadedImage, edgeId: "e2" },
      ],
      true,
    );
    expect(chips.map((c) => c.usable)).toEqual([true, false]);
  });

  it("marks every image unusable when images are not references for this node", () => {
    const chips = buildReferenceChips(
      [{ node: servableImage, edgeId: "e1" }],
      false,
    );
    expect(chips[0]?.usable).toBe(false);
  });

  it("carries the edge id and group provenance through", () => {
    const chips = buildReferenceChips(
      [{ node: servableImage, edgeId: "e1", viaGroupId: "g1" }],
      true,
    );
    expect(chips[0]?.edgeId).toBe("e1");
    expect(chips[0]?.viaGroupId).toBe("g1");
  });

  it("chipSiblingCount counts what one cut would drop", () => {
    const chips = buildReferenceChips(
      [
        { node: textNode, edgeId: "e1", viaGroupId: "g1" },
        { node: servableImage, edgeId: "e1", viaGroupId: "g1" },
        { node: uploadedImage, edgeId: "e2" },
      ],
      true,
    );
    expect(chipSiblingCount(chips, "e1")).toBe(2);
    expect(chipSiblingCount(chips, "e2")).toBe(1);
  });
});
