import { beforeEach, describe, expect, it, vi } from "vitest";

const apiMocks = vi.hoisted(() => ({
  generateImageViaJob: vi.fn(),
}));

vi.mock("../src/lib/media/image-generation-jobs", () => apiMocks);

import { generateXhsImages } from "../src/lib/a2ui/custom-components/xhs-image-generation";

describe("XHS image generation", () => {
  beforeEach(() => {
    apiMocks.generateImageViaJob.mockReset();
  });

  it("forwards the selected parameters and returns every generated image", async () => {
    apiMocks.generateImageViaJob.mockResolvedValue({
      url: "/generated/one.png",
      path: "/tmp/one.png",
      items: [
        { url: "/generated/one.png", path: "/tmp/one.png" },
        { url: "/generated/two.png", path: "/tmp/two.png" },
      ],
    });

    await expect(
      generateXhsImages({
        prompt: "  羽毛球拍产品摄影  ",
        model: "tabby-image-pro",
        quality: "high",
        aspectRatio: "3:4",
        size: "2K",
        count: 2,
        transparentBackground: true,
      }),
    ).resolves.toEqual(["/generated/one.png", "/generated/two.png"]);

    expect(apiMocks.generateImageViaJob).toHaveBeenCalledWith({
      prompt: "羽毛球拍产品摄影",
      model: "tabby-image-pro",
      quality: "high",
      aspectRatio: "3:4",
      // Tier + aspect resolve to fixed pixels through IMAGE_SIZE_TABLE, so the
      // hint names one size instead of leaving the shape to the model.
      size: "1536x2048",
      count: 2,
      transparentBackground: true,
    });
  });

  it("uses the single-result fallback and rejects an empty response", async () => {
    apiMocks.generateImageViaJob.mockResolvedValueOnce({
      url: "/generated/fallback.png",
      path: "/tmp/fallback.png",
      items: [],
    });
    await expect(
      generateXhsImages({
        prompt: "封面",
        model: "",
        quality: "auto",
        aspectRatio: "",
        size: "",
        count: 1,
        transparentBackground: false,
      }),
    ).resolves.toEqual(["/generated/fallback.png"]);

    apiMocks.generateImageViaJob.mockResolvedValueOnce({
      url: "",
      path: "",
      items: [],
    });
    await expect(
      generateXhsImages({
        prompt: "封面",
        model: "",
        quality: "auto",
        aspectRatio: "",
        size: "",
        count: 1,
        transparentBackground: false,
      }),
    ).rejects.toThrow("生成结果中没有可用图片");
  });
});
