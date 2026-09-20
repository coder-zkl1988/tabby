import { describe, expect, it } from "vitest";
import { nexuConfigSchema } from "#controller/store/schemas";

/**
 * A provider's `canonicalOpenClawId` can be renamed — google's moved off
 * `gemini` — but model refs persisted under the old `byok_<alias>` prefix are
 * already sitting in `config.json`. They have to keep resolving, or the ref
 * falls through to a bare model id that belongs to no provider and the user
 * silently drops to the default model after an upgrade.
 */
function configWithGoogleProvider(defaultModelId: string) {
  return {
    $schema: "https://tabby.picaso.studio/config.json",
    schemaVersion: 2,
    app: {},
    bots: [],
    runtime: { defaultModelId },
    models: {
      mode: "merge",
      providers: {
        google: {
          enabled: true,
          displayName: "Google AI Studio",
          baseUrl: "https://generativelanguage.googleapis.com",
          auth: "api-key",
          api: "google-generative-ai",
          apiKey: "AIza-test",
          models: [],
        },
      },
    },
    integrations: [],
    channels: [],
    templates: {},
    desktop: {},
    secrets: {},
  };
}

describe("persisted model ref normalization", () => {
  it("resolves a ref persisted under a renamed provider's old byok alias", () => {
    const parsed = nexuConfigSchema.parse(
      configWithGoogleProvider("byok_gemini/gemini-3-pro-preview"),
    );
    expect(parsed.runtime.defaultModelId).toBe("google/gemini-3-pro-preview");
  });

  it("resolves the current byok prefix", () => {
    const parsed = nexuConfigSchema.parse(
      configWithGoogleProvider("byok_google/gemini-3-pro-preview"),
    );
    expect(parsed.runtime.defaultModelId).toBe("google/gemini-3-pro-preview");
  });

  it("leaves an already-canonical ref alone", () => {
    const parsed = nexuConfigSchema.parse(
      configWithGoogleProvider("google/gemini-3-pro-preview"),
    );
    expect(parsed.runtime.defaultModelId).toBe("google/gemini-3-pro-preview");
  });
});
