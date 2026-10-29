import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  buildImageGenerationRequest,
  buildImageGenerationsUrl,
  parseImageResponse,
  readOpenclawConfig,
  resolveLinkCredential,
  resolveOutputPath,
} from "./lib.js";

test("readOpenclawConfig throws ENV_MISSING when stateDir is falsy", () => {
  assert.throws(() => readOpenclawConfig(undefined), /ENV_MISSING/);
});

test("readOpenclawConfig throws CONFIG_MISSING when the file does not exist", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabby-image-test-"));
  assert.throws(() => readOpenclawConfig(dir), /CONFIG_MISSING/);
});

test("readOpenclawConfig throws CONFIG_INVALID on unparsable JSON", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabby-image-test-"));
  fs.writeFileSync(path.join(dir, "openclaw.json"), "{not json");
  assert.throws(() => readOpenclawConfig(dir), /CONFIG_INVALID/);
});

test("readOpenclawConfig parses a valid config file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tabby-image-test-"));
  fs.writeFileSync(
    path.join(dir, "openclaw.json"),
    JSON.stringify({ foo: "bar" }),
  );
  const config = readOpenclawConfig(dir);
  assert.equal(config.foo, "bar");
});

test("resolveLinkCredential throws NOT_LOGGED_IN when the link provider is missing", () => {
  assert.throws(() => resolveLinkCredential({}), /NOT_LOGGED_IN/);
});

test("resolveLinkCredential throws NOT_LOGGED_IN when apiKey is empty", () => {
  const config = {
    models: {
      providers: { link: { baseUrl: "https://x/v1", apiKey: "", models: [] } },
    },
  };
  assert.throws(() => resolveLinkCredential(config), /NOT_LOGGED_IN/);
});

function linkConfig(models) {
  return {
    models: {
      providers: {
        link: { baseUrl: "https://x/v1", apiKey: "key123", models },
      },
    },
  };
}

test("resolveLinkCredential throws NO_IMAGE_MODEL when tabby-image is not on the account", () => {
  const config = linkConfig([
    { id: "gpt-5.5" },
    { id: "deepseek-v4-pro" },
    { id: "tabby-image-pro" },
  ]);
  assert.throws(
    () => resolveLinkCredential(config),
    /NO_IMAGE_MODEL.*tabby-image/,
  );
});

test("resolveLinkCredential returns tabby-image with the link credential", () => {
  const result = resolveLinkCredential(linkConfig([{ id: "tabby-image" }]));
  assert.equal(result.model, "tabby-image");
  assert.equal(result.baseUrl, "https://x/v1");
  assert.equal(result.apiKey, "key123");
});

test("resolveLinkCredential accepts an explicit tabby-image", () => {
  const result = resolveLinkCredential(
    linkConfig([{ id: "tabby-image" }]),
    "tabby-image",
  );
  assert.equal(result.model, "tabby-image");
});

test("resolveLinkCredential resolves legacy tier ids to tabby-image", () => {
  const config = linkConfig([{ id: "tabby-image" }]);
  for (const legacy of [
    "tabby-image-pro",
    "tabby-image-flash",
    "tabby-image-free",
  ]) {
    assert.equal(resolveLinkCredential(config, legacy).model, "tabby-image");
  }
});

test("resolveLinkCredential rejects a non-relay image model alias", () => {
  assert.throws(
    () =>
      resolveLinkCredential(linkConfig([{ id: "tabby-image" }]), "gpt-image-2"),
    /INVALID_IMAGE_MODEL/,
  );
});

test("buildImageGenerationsUrl uses the configured relay and normalizes trailing slashes", () => {
  assert.equal(
    buildImageGenerationsUrl("https://relay.example/v1///"),
    "https://relay.example/v1/images/generations",
  );
});

test("buildImageGenerationRequest builds the exact GPT Image body", () => {
  const result = buildImageGenerationRequest({
    baseUrl: "https://relay.example/v1",
    model: "tabby-image",
    prompt: "a cat on mars",
  });

  assert.equal(result.url, "https://relay.example/v1/images/generations");
  assert.deepEqual(result.body, {
    model: "tabby-image",
    prompt: "a cat on mars",
    n: 1,
    size: "1024x1024",
  });
  assert.equal(Object.hasOwn(result.body, "response_format"), false);
  assert.equal(Object.hasOwn(result.body, "extra_body"), false);
});

test("buildImageGenerationRequest maps GPT ratio and optional controls", () => {
  const result = buildImageGenerationRequest({
    baseUrl: "https://relay.example/v1/",
    model: "tabby-image",
    prompt: "product shot",
    ratio: "16:9",
    quality: "high",
    transparentBackground: true,
  });

  assert.deepEqual(result.body, {
    model: "tabby-image",
    prompt: "product shot",
    n: 1,
    size: "1536x864",
    quality: "high",
    background: "transparent",
  });
  assert.equal(Object.hasOwn(result.body, "ratio"), false);
});

test("buildImageGenerationRequest maps GPT tiers and validates exact sizes", () => {
  assert.equal(
    buildImageGenerationRequest({
      baseUrl: "https://relay.example/v1",
      model: "tabby-image",
      prompt: "a cat",
      size: "2K",
      ratio: "9:16",
    }).body.size,
    "1152x2048",
  );
  assert.equal(
    buildImageGenerationRequest({
      baseUrl: "https://relay.example/v1",
      model: "tabby-image",
      prompt: "a cat",
      size: "4K",
      ratio: "1:1",
    }).body.size,
    "2160x2160",
  );
  assert.equal(
    buildImageGenerationRequest({
      baseUrl: "https://relay.example/v1",
      model: "tabby-image",
      prompt: "a cat",
      size: "1536x864",
    }).body.size,
    "1536x864",
  );

  assert.throws(
    () =>
      buildImageGenerationRequest({
        baseUrl: "https://relay.example/v1",
        model: "tabby-image",
        prompt: "a cat",
        ratio: "5:4",
      }),
    /INVALID_RATIO/,
  );
  assert.throws(
    () =>
      buildImageGenerationRequest({
        baseUrl: "https://relay.example/v1",
        model: "tabby-image",
        prompt: "a cat",
        size: "1537x864",
      }),
    /INVALID_SIZE/,
  );
});

test("buildImageGenerationRequest rejects a model other than tabby-image", () => {
  assert.throws(
    () =>
      buildImageGenerationRequest({
        baseUrl: "https://relay.example/v1",
        model: "tabby-image-flash",
        prompt: "a cat",
      }),
    /INVALID_IMAGE_MODEL/,
  );
});

test("parseImageResponse returns a b64 payload when present", () => {
  const result = parseImageResponse({ data: [{ b64_json: "abc123" }] });
  assert.deepEqual(result, { kind: "b64", data: "abc123" });
});

test("parseImageResponse returns a url when b64_json is absent", () => {
  const result = parseImageResponse({
    data: [{ url: "https://example.com/img.png" }],
  });
  assert.deepEqual(result, {
    kind: "url",
    data: "https://example.com/img.png",
  });
});

test("parseImageResponse throws BAD_RESPONSE when neither field is present", () => {
  assert.throws(() => parseImageResponse({ data: [{}] }), /BAD_RESPONSE/);
});

test("parseImageResponse throws BAD_RESPONSE when the data array is empty", () => {
  assert.throws(() => parseImageResponse({ data: [] }), /BAD_RESPONSE/);
});

test("resolveOutputPath returns an absolute filename as-is", () => {
  const result = resolveOutputPath({
    stateDir: "/state",
    cwd: "/workspace/my-bot",
    filename: "/tmp/out.png",
    skillName: "tabby-image",
  });
  assert.equal(result, "/tmp/out.png");
});

test("resolveOutputPath builds the outbound media path for relative filenames", () => {
  const result = resolveOutputPath({
    stateDir: "/state",
    cwd: "/workspace/my-bot",
    filename: "cat.png",
    skillName: "tabby-image",
  });
  assert.equal(
    result,
    path.join(
      "/state",
      "media",
      "outbound",
      "my-bot",
      "tabby-image",
      "cat.png",
    ),
  );
});
