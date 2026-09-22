import { describe, expect, it } from "vitest";
import { openclawConfigSchema } from "../../packages/shared/src/schemas/openclaw-config.js";

describe("openclawConfigSchema agent skills field", () => {
  it("accepts agent with skills array", () => {
    const config = createMinimalConfig({
      agents: {
        defaults: { model: { primary: "test-model" } },
        entries: { "bot-1": { name: "Bot", skills: ["git", "npm"] } },
      },
    });
    const result = openclawConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents.entries["bot-1"].skills).toEqual([
        "git",
        "npm",
      ]);
    }
  });

  it("accepts agent without skills field (legacy)", () => {
    const config = createMinimalConfig();
    const result = openclawConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents.entries["bot-1"]).not.toHaveProperty("skills");
    }
  });

  it("accepts agent with empty skills array", () => {
    const config = createMinimalConfig({
      agents: {
        defaults: { model: { primary: "test-model" } },
        entries: { "bot-1": { name: "Bot", skills: [] } },
      },
    });
    const result = openclawConfigSchema.safeParse(config);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.agents.entries["bot-1"].skills).toEqual([]);
    }
  });
});

describe("openclawConfigSchema local automation", () => {
  it("accepts a stdio MCP server", () => {
    const result = openclawConfigSchema.safeParse(
      createMinimalConfig({
        mcp: {
          servers: {
            "custom-driver": {
              enabled: true,
              command: "/runtime/custom-driver/bin",
              args: ["mcp", "serve"],
              transport: "stdio",
            },
          },
        },
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.mcp?.servers["custom-driver"]).toBeDefined();
    }
  });

  it("drops a browser block left behind by an older install", () => {
    // Nexu used to compile a `browser` profile that drove the user's real
    // Chrome through a paired extension. The agent now gets the browser panel
    // inside the app instead, so a config still carrying the old block parses
    // fine and comes back without it — the next write clears it for good.
    const result = openclawConfigSchema.safeParse(
      createMinimalConfig({
        browser: {
          enabled: true,
          defaultProfile: "chrome",
          profiles: { chrome: { driver: "extension" } },
        },
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).not.toHaveProperty("browser");
    }
  });
});

describe("openclawConfigSchema memory search", () => {
  it("accepts the OpenClaw 2026.9.4 FTS-only contract", () => {
    const result = openclawConfigSchema.safeParse(
      createMinimalConfig({
        memory: {
          search: {
            enabled: true,
            sources: ["memory", "sessions"],
            experimental: { sessionMemory: true },
            provider: "none",
            fallback: "none",
            store: {
              fts: { tokenizer: "trigram" },
              vector: { enabled: false },
            },
          },
        },
      }),
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.memory?.search).toMatchObject({
        provider: "none",
        experimental: { sessionMemory: true },
        store: {
          fts: { tokenizer: "trigram" },
          vector: { enabled: false },
        },
      });
    }
  });

  it("accepts custom embedding providers and secret references", () => {
    const result = openclawConfigSchema.safeParse(
      createMinimalConfig({
        memory: {
          search: {
            provider: "custom-embedding-adapter",
            model: "embedding-v1",
            remote: {
              baseUrl: "https://embedding.example/v1",
              apiKey: {
                source: "env",
                provider: "default",
                id: "EMBEDDING_API_KEY",
              },
            },
          },
        },
      }),
    );

    expect(result.success).toBe(true);
  });
});

function createMinimalConfig(overrides: Record<string, unknown> = {}) {
  return {
    gateway: {
      port: 18789,
      mode: "local" as const,
      bind: "loopback" as const,
      auth: { mode: "token" as const, token: "test" },
      reload: { mode: "hybrid" as const },
      controlUi: { allowedOrigins: ["http://localhost:5173"] },
      tools: { allow: ["cron"] },
    },
    agents: {
      defaults: { model: { primary: "test-model" } },
      entries: { "bot-1": { name: "Bot" } },
    },
    channels: {},
    bindings: [],
    skills: { load: { watch: true } },
    ...overrides,
  };
}
