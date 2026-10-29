import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CatalogManager,
  CatalogRevisionChangedError,
} from "../src/services/skillhub/catalog-manager.js";
import { SkillDb } from "../src/services/skillhub/skill-db.js";

describe("CatalogManager.getCatalog() workspace skills", () => {
  let tmpDir: string;
  let skillDb: SkillDb;
  let skillsDir: string;
  let stateDir: string;
  let cacheDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(path.join(tmpdir(), "nexu-catalog-ws-"));
    stateDir = path.join(tmpDir, "openclaw-state");
    skillsDir = path.join(stateDir, "skills");
    cacheDir = path.join(tmpDir, "skillhub-cache");
    mkdirSync(skillsDir, { recursive: true });
    mkdirSync(cacheDir, { recursive: true });

    const dbPath = path.join(tmpDir, "skill-ledger.json");
    skillDb = await SkillDb.create(dbPath);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    skillDb.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  it("returns agentId: null for managed skills", () => {
    // Setup: managed skill on disk
    const skillDir = path.join(skillsDir, "web-search");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(
      path.join(skillDir, "SKILL.md"),
      "---\nname: Web Search\ndescription: Search the web\n---\n",
    );
    skillDb.recordInstall("web-search", "managed");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();
    const managed = result.installedSkills.find((s) => s.slug === "web-search");

    expect(managed).toBeDefined();
    expect(managed?.agentId).toBeNull();
    expect(managed?.source).toBe("managed");
  });

  it("returns the publisher recorded for an owner-scoped install", () => {
    skillDb.recordInstall(
      "weather",
      "managed",
      "2.4.0",
      undefined,
      "publisher",
    );
    const catalog = new CatalogManager(cacheDir, { skillsDir, skillDb });

    expect(catalog.getInstalledState().installedSkills[0]).toMatchObject({
      slug: "weather",
      ownerHandle: "publisher",
      version: "2.4.0",
    });
  });

  it("returns agentId for workspace skills", () => {
    // Setup: workspace skill on disk under agents dir
    const agentSkillDir = path.join(
      stateDir,
      "agents",
      "bot-abc",
      "skills",
      "my-tool",
    );
    mkdirSync(agentSkillDir, { recursive: true });
    writeFileSync(
      path.join(agentSkillDir, "SKILL.md"),
      "---\nname: My Tool\ndescription: A workspace tool\n---\n",
    );
    skillDb.recordInstall("my-tool", "workspace", undefined, "bot-abc");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();
    const ws = result.installedSkills.find((s) => s.slug === "my-tool");

    expect(ws).toBeDefined();
    expect(ws?.agentId).toBe("bot-abc");
    expect(ws?.source).toBe("workspace");
    expect(ws?.name).toBe("My Tool");
    expect(ws?.description).toBe("A workspace tool");
  });

  it("resolves workspace skill SKILL.md from agents dir, not shared skills dir", () => {
    // The workspace skill dir is under agents/<agentId>/skills/<slug>
    // NOT under the shared skills dir
    const agentSkillDir = path.join(
      stateDir,
      "agents",
      "bot-xyz",
      "skills",
      "private-tool",
    );
    mkdirSync(agentSkillDir, { recursive: true });
    writeFileSync(
      path.join(agentSkillDir, "SKILL.md"),
      "---\nname: Private Tool\ndescription: Agent-specific tool\n---\n",
    );
    skillDb.recordInstall("private-tool", "workspace", undefined, "bot-xyz");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();
    const ws = result.installedSkills.find((s) => s.slug === "private-tool");

    expect(ws).toBeDefined();
    expect(ws?.name).toBe("Private Tool");
    expect(ws?.description).toBe("Agent-specific tool");
  });

  it("returns slug as name fallback when SKILL.md not found for workspace skill", () => {
    // No SKILL.md on disk, but DB record exists
    skillDb.recordInstall("ghost-skill", "workspace", undefined, "bot-404");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();
    const ws = result.installedSkills.find((s) => s.slug === "ghost-skill");

    expect(ws).toBeDefined();
    expect(ws?.agentId).toBe("bot-404");
    expect(ws?.name).toBe("ghost-skill");
    expect(ws?.description).toBe("");
  });

  it("mixes managed and workspace skills in one catalog result", () => {
    // Managed skill
    const managedDir = path.join(skillsDir, "calendar");
    mkdirSync(managedDir, { recursive: true });
    writeFileSync(
      path.join(managedDir, "SKILL.md"),
      "---\nname: Calendar\ndescription: Manage calendar\n---\n",
    );
    skillDb.recordInstall("calendar", "managed");

    // Workspace skill
    const wsDir = path.join(stateDir, "agents", "bot-1", "skills", "deploy");
    mkdirSync(wsDir, { recursive: true });
    writeFileSync(
      path.join(wsDir, "SKILL.md"),
      "---\nname: Deploy\ndescription: Deploy to prod\n---\n",
    );
    skillDb.recordInstall("deploy", "workspace", undefined, "bot-1");

    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
    });

    const result = catalog.getCatalog();

    expect(result.installedSkills).toHaveLength(2);
    expect(result.installedSlugs).toEqual(
      expect.arrayContaining(["calendar", "deploy"]),
    );

    const managed = result.installedSkills.find((s) => s.slug === "calendar");
    const workspace = result.installedSkills.find((s) => s.slug === "deploy");

    expect(managed?.agentId).toBeNull();
    expect(workspace?.agentId).toBe("bot-1");
  });

  it("only falls back to the local catalog for an unfiltered first page", async () => {
    writeFileSync(
      path.join(cacheDir, "catalog.json"),
      JSON.stringify([
        {
          slug: "alpha",
          name: "Alpha",
          description: "Search helper",
          downloads: 30,
          stars: 2,
          tags: ["search"],
          version: "1.0.0",
          updatedAt: "2026-01-01",
        },
        {
          slug: "beta",
          name: "Beta",
          description: "Search helper",
          downloads: 20,
          stars: 1,
          tags: ["search"],
          version: "2.0.0",
          updatedAt: "2026-01-02",
        },
        {
          slug: "gamma",
          name: "Gamma",
          description: "Calendar",
          downloads: 10,
          stars: 0,
          tags: ["productivity"],
          version: "1.0.0",
          updatedAt: "2026-01-03",
        },
      ]),
    );
    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
      catalogApiUrl: "http://127.0.0.1:1/api/v1/skill-catalog",
    });

    await expect(
      catalog.getCatalogPage({ query: "search", limit: 1 }),
    ).rejects.toThrow();

    const fallback = await catalog.getCatalogPage({ limit: 1 });
    expect(fallback.skills.map((skill) => skill.slug)).toEqual(["alpha"]);
    expect(fallback.total).toBe(3);
    expect(fallback.nextCursor).toBe("local:1");
  });

  it("preserves owner-scoped slugs returned by the server catalog", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          skills: [
            {
              identity: "@guipi888/find-skills",
              ownerHandle: "guipi888",
              slug: "find-skills",
              name: "Find Skills",
              description: "Discover skills",
              downloads: 10,
              stars: 1,
              tags: ["search"],
              version: "2.0.0",
              updatedAt: 1_785_000_000_000,
            },
          ],
          nextCursor: null,
          total: 1,
          facets: [],
          meta: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
      catalogApiUrl: "https://tabby.happywork.today/api/v1/skill-catalog",
    });

    const page = await catalog.getCatalogPage({ limit: 1 });

    expect(page.skills[0]).toMatchObject({
      identity: "@guipi888/find-skills",
      slug: "find-skills",
      ownerHandle: "guipi888",
      version: "2.0.0",
    });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not mix a remote first page with local fallback after a page failure", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("unavailable", {
        status: 503,
      }),
    );
    const catalog = new CatalogManager(cacheDir, {
      skillsDir,
      skillDb,
      catalogApiUrl: "https://tabby.happywork.today/api/v1/skill-catalog",
    });

    await expect(
      catalog.getCatalogPage({
        cursor: "remote-cursor",
        limit: 1,
      }),
    ).rejects.toThrow("catalog API returned 503");
  });

  it("surfaces a changed remote revision so clients can restart pagination", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          error: "Catalog revision changed; restart pagination",
          code: "catalog_revision_changed",
        }),
        { status: 409, headers: { "content-type": "application/json" } },
      ),
    );
    const catalog = new CatalogManager(cacheDir, { skillsDir, skillDb });

    await expect(
      catalog.getCatalogPage({ cursor: "stale-cursor", limit: 1 }),
    ).rejects.toBeInstanceOf(CatalogRevisionChangedError);
  });

  it("resolves curated skills to an owner and mirrored version", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          skills: [
            {
              identity: "@steipete/weather",
              ownerHandle: "steipete",
              slug: "weather",
              name: "Weather",
              description: "Forecasts",
              downloads: 20,
              stars: 2,
              tags: [],
              version: "3.1.0",
              updatedAt: 1_785_000_000_000,
            },
          ],
          nextCursor: null,
          total: 1,
          facets: [],
          meta: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const catalog = new CatalogManager(cacheDir, { skillsDir, skillDb });
    vi.spyOn(catalog, "getCuratedSlugsToEnqueue").mockReturnValue(["weather"]);

    await expect(catalog.getCuratedInstallRequests()).resolves.toEqual([
      {
        slug: "weather",
        ownerHandle: "steipete",
        version: "3.1.0",
      },
    ]);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.objectContaining({
        search: expect.stringContaining("ownerHandle=steipete"),
      }),
      expect.any(Object),
    );
  });

  it("skips a curated skill when the fixed publisher is missing", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          skills: [
            {
              identity: "@different/weather",
              ownerHandle: "different",
              slug: "weather",
              name: "Weather",
              description: "Forecasts",
              downloads: 20,
              stars: 2,
              tags: [],
              version: "3.1.0",
              updatedAt: 1_785_000_000_000,
            },
          ],
          nextCursor: null,
          total: 1,
          facets: [],
          meta: null,
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const catalog = new CatalogManager(cacheDir, { skillsDir, skillDb });
    vi.spyOn(catalog, "getCuratedSlugsToEnqueue").mockReturnValue(["weather"]);

    await expect(catalog.getCuratedInstallRequests()).resolves.toEqual([]);
  });

  it("normalizes and validates owner-scoped install context", () => {
    const catalog = new CatalogManager(cacheDir, { skillsDir, skillDb });

    expect(
      catalog.prepareInstall({
        slug: "alpha",
        ownerHandle: "@Publisher.Name",
        version: "2.3.4",
      }),
    ).toBe("alpha");
    expect(() =>
      catalog.prepareInstall({
        slug: "alpha",
        ownerHandle: "../publisher",
      }),
    ).toThrow("Invalid skill owner");
    expect(catalog.consumeInstalledVersion("alpha")).toBeUndefined();
    catalog.clearPreparedInstall("alpha");
  });

  it("does not apply legacy slug corrections to owner-scoped packages", () => {
    const catalog = new CatalogManager(cacheDir, { skillsDir, skillDb });

    expect(
      catalog.prepareInstall({
        slug: "find-skills",
        ownerHandle: "guipi888",
      }),
    ).toBe("find-skills");
    expect(catalog.canonicalizeSlug("find-skills")).toBe("find-skills");
    catalog.clearPreparedInstall("find-skills");
    expect(catalog.canonicalizeSlug("find-skills")).toBe("find-skill");
  });

  it("preserves an installed raw alias even when the corrected slug also exists", () => {
    for (const slug of ["find-skills", "find-skill"]) {
      const skillDir = path.join(skillsDir, slug);
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(path.join(skillDir, "SKILL.md"), `# ${slug}\n`);
    }
    skillDb.recordInstall(
      "find-skills",
      "managed",
      "1.0.0",
      undefined,
      "guipi888",
    );
    skillDb.recordInstall("find-skill", "managed", "1.0.0");
    const catalog = new CatalogManager(cacheDir, { skillsDir, skillDb });

    expect(catalog.canonicalizeSlug("find-skills")).toBe("find-skills");
  });

  it("re-enqueues a curated ledger entry when its directory is missing", () => {
    skillDb.recordInstall("weather", "managed", "3.1.0", undefined, "steipete");
    const catalog = new CatalogManager(cacheDir, { skillsDir, skillDb });

    expect(catalog.getCuratedSlugsToEnqueue()).toContain("weather");
  });
});
