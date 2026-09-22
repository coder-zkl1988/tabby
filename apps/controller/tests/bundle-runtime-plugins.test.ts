import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  patchLarkOpenClawCompatibility,
  planDependencyPlacements,
  resolveDependencyNodeModules,
} from "../scripts/bundle-runtime-plugins.mjs";

describe("patchLarkOpenClawCompatibility", () => {
  it("replaces retired Lark SDK imports without rewriting other scoped imports", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "nexu-lark-sdk-"));
    try {
      const entry = path.join(root, "index.js");
      const dispatcher = path.join(root, "src/card/reply-dispatcher.js");
      const toolUse = path.join(root, "src/card/tool-use-config.js");
      const streaming = path.join(
        root,
        "src/card/streaming-card-controller.js",
      );
      const agentConfig = path.join(root, "src/core/agent-config.js");
      const version = path.join(root, "src/core/version.js");
      const tokenStore = path.join(root, "src/core/token-store.js");
      await mkdir(path.dirname(dispatcher), { recursive: true });
      await mkdir(path.dirname(agentConfig), { recursive: true });
      await writeFile(
        entry,
        'const sdk = require("openclaw/plugin-sdk");\nconst core = require("openclaw/plugin-sdk/core");\nsdk.emptyPluginConfigSchema();\n',
      );
      await writeFile(
        dispatcher,
        "const sdk = require('openclaw/plugin-sdk/channel-runtime');\nsdk.createReplyPrefixContext();\nsdk.createTypingCallbacks();\n",
      );
      await writeFile(
        toolUse,
        'const sdk = require("openclaw/plugin-sdk/config-runtime");\nconst defaultAgentId = (0, agent_runtime_1.resolveDefaultAgentId)(cfg);',
      );
      await writeFile(
        streaming,
        "const defaultAgentId = (0, agent_runtime_1.resolveDefaultAgentId)(this.deps.cfg);",
      );
      await writeFile(
        agentConfig,
        "exports.listConfiguredAgents = (cfg) => { const agents = cfg.agents; return agents?.list ?? []; };",
      );
      await writeFile(
        version,
        "exports.getDirectory = () => { const __filename = (0, node_url_1.fileURLToPath)(import.meta.url); const __dirname = (0, node_path_1.dirname)(__filename); return __dirname; };",
      );
      await writeFile(
        tokenStore,
        "exports.filename = typeof __filename !== 'undefined' ? __filename : import.meta.url;",
      );

      await patchLarkOpenClawCompatibility(root);
      await patchLarkOpenClawCompatibility(root);

      expect(await readFile(entry, "utf8")).toBe(
        'const sdk = require("openclaw/plugin-sdk/plugin-entry");\nconst core = require("openclaw/plugin-sdk/core");\nsdk.emptyPluginConfigSchema();\n',
      );
      expect(await readFile(dispatcher, "utf8")).toBe(
        "const sdk = require('openclaw/plugin-sdk/channel-reply-pipeline');\nsdk.createReplyPrefixContext();\nsdk.createTypingCallbacks();\n",
      );
      expect(await readFile(toolUse, "utf8")).toContain(
        'require("openclaw/plugin-sdk/session-store-runtime")',
      );
      expect(await readFile(streaming, "utf8")).toContain(
        "this.deps.cfg.agents?.defaults?.systemAgent?.agentId ??",
      );
      const agentHelpers = await import(agentConfig);
      expect(
        agentHelpers.listConfiguredAgents({
          agents: {
            entries: { bot: { name: "Assistant", skills: ["search"] } },
          },
        }),
      ).toEqual([{ id: "bot", name: "Assistant", skills: ["search"] }]);
      expect((await import(version)).getDirectory()).toBe(
        await realpath(path.dirname(version)),
      );
      expect((await import(tokenStore)).filename).toBe(
        await realpath(tokenStore),
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("resolveDependencyNodeModules", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(
      tempRoots.map((rootDir) => rm(rootDir, { recursive: true, force: true })),
    );
    tempRoots.length = 0;
  });

  it("falls back to the pnpm virtual-store node_modules when the package-local directory only contains .bin", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "nexu-bundle-runtime-plugins-"),
    );
    tempRoots.push(rootDir);

    const packageRoot = path.join(
      rootDir,
      "node_modules",
      ".pnpm",
      "@scope+plugin@1.0.0",
      "node_modules",
      "@scope",
      "plugin",
    );
    const packageLocalNodeModules = path.join(packageRoot, "node_modules");
    const virtualStoreNodeModules = path.join(
      rootDir,
      "node_modules",
      ".pnpm",
      "@scope+plugin@1.0.0",
      "node_modules",
    );
    const dependencyDir = path.join(virtualStoreNodeModules, "dingtalk-stream");

    await mkdir(path.join(packageLocalNodeModules, ".bin"), {
      recursive: true,
    });
    await mkdir(dependencyDir, { recursive: true });
    await writeFile(
      path.join(dependencyDir, "package.json"),
      '{ "name": "dingtalk-stream" }\n',
      "utf8",
    );

    expect(resolveDependencyNodeModules(packageRoot)).toBe(
      virtualStoreNodeModules,
    );
  });

  it("prefers the package-local node_modules when it contains real dependencies", async () => {
    const rootDir = await mkdtemp(
      path.join(tmpdir(), "nexu-bundle-runtime-plugins-"),
    );
    tempRoots.push(rootDir);

    const packageRoot = path.join(rootDir, "plugin");
    const packageLocalNodeModules = path.join(packageRoot, "node_modules");
    const dependencyDir = path.join(packageLocalNodeModules, "silk-wasm");

    await mkdir(dependencyDir, { recursive: true });
    await writeFile(
      path.join(dependencyDir, "package.json"),
      '{ "name": "silk-wasm" }\n',
      "utf8",
    );

    expect(resolveDependencyNodeModules(packageRoot)).toBe(
      packageLocalNodeModules,
    );
  });
});

describe("planDependencyPlacements", () => {
  it("keeps a single copy when every consumer wants the same version", () => {
    const placements = planDependencyPlacements([
      {
        name: "zod",
        version: "4.3.6",
        realPath: "/store/zod",
        parentName: null,
      },
      {
        name: "zod",
        version: "4.3.6",
        realPath: "/store/zod",
        parentName: "lark",
      },
    ]);

    expect(placements).toEqual([
      { name: "zod", realPath: "/store/zod", nestUnder: null },
    ]);
  });

  it("nests a conflicting version under the package that requires it", () => {
    // dingtalk-connector pins form-data@4.0.0 while its axios needs ^4.0.5.
    // Both must survive: the pin at top level, axios's copy nested under axios.
    const placements = planDependencyPlacements([
      {
        name: "form-data",
        version: "4.0.0",
        realPath: "/store/form-data@4.0.0",
        parentName: null,
      },
      {
        name: "axios",
        version: "1.14.0",
        realPath: "/store/axios",
        parentName: null,
      },
      {
        name: "form-data",
        version: "4.0.5",
        realPath: "/store/form-data@4.0.5",
        parentName: "axios",
      },
    ]);

    expect(placements).toEqual([
      {
        name: "form-data",
        realPath: "/store/form-data@4.0.0",
        nestUnder: null,
      },
      { name: "axios", realPath: "/store/axios", nestUnder: null },
      {
        name: "form-data",
        realPath: "/store/form-data@4.0.5",
        nestUnder: "axios",
      },
    ]);
  });

  it("drops a conflicting version that has no parent to nest under", () => {
    // Without a parent there is no correct place for it; hoisting it would
    // silently override the top-level copy, which is the bug being fixed.
    const placements = planDependencyPlacements([
      {
        name: "ws",
        version: "8.20.0",
        realPath: "/store/ws@8.20.0",
        parentName: null,
      },
      {
        name: "ws",
        version: "8.21.1",
        realPath: "/store/ws@8.21.1",
        parentName: null,
      },
    ]);

    expect(placements).toEqual([
      { name: "ws", realPath: "/store/ws@8.20.0", nestUnder: null },
    ]);
  });

  it("keeps scoped package names intact", () => {
    const placements = planDependencyPlacements([
      {
        name: "@scope/pkg",
        version: "1.0.0",
        realPath: "/store/scope-pkg",
        parentName: null,
      },
    ]);

    expect(placements).toEqual([
      { name: "@scope/pkg", realPath: "/store/scope-pkg", nestUnder: null },
    ]);
  });
});
