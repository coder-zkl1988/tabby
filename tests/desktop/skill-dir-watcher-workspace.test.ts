import {
  mkdirSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SkillDb } from "#controller/services/skillhub/skill-db";
import { SkillDirWatcher } from "#controller/services/skillhub/skill-dir-watcher";

describe("SkillDirWatcher workspace reconciliation", () => {
  let tmpDir: string;
  let skillsDir: string;
  let stateDir: string;
  let db: SkillDb;
  let dbPath: string;

  beforeEach(async () => {
    // realpathSync.native expands Windows 8.3 short paths (C:\Users\RUNNER~1\...)
    // to their long form. Recursive fs.watch on a short-path dir trips a libuv
    // assertion (src/win/fs-event.c: !_wcsnicmp(filename, dir, dirlen)) because
    // ReadDirectoryChangesW reports long-form filenames.
    tmpDir = realpathSync.native(
      await mkdtemp(path.join(tmpdir(), "watcher-ws-")),
    );
    skillsDir = path.join(tmpDir, "skills");
    stateDir = tmpDir;
    mkdirSync(skillsDir, { recursive: true });
    dbPath = path.join(tmpDir, "ledger.json");
    db = await SkillDb.create(dbPath);
  });

  afterEach(async () => {
    // Windows' recursive fs.watch() can still have in-flight native events
    // when a test's watcher.stop() returns; deleting the watched dir before
    // they drain crashes the process (libuv fs-event.c assertion). Give it a tick.
    await new Promise((resolve) => setTimeout(resolve, 50));
    db.close();
    await rm(tmpDir, { recursive: true, force: true });
  });

  function createWorkspaceSkill(botId: string, slug: string): void {
    const dir = path.join(stateDir, "agents", botId, "skills", slug);
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${slug}\n---\nTest.`);
  }

  function removeWorkspaceSkill(botId: string, slug: string): void {
    const skillDir = path.join(stateDir, "agents", botId, "skills", slug);
    unlinkSync(path.join(skillDir, "SKILL.md"));
    rmSync(skillDir, {
      recursive: true,
      force: true,
    });
  }

  function writeWorkspaceFile(relativePath: string, content = "data"): void {
    const fullPath = path.join(stateDir, relativePath);
    mkdirSync(path.dirname(fullPath), { recursive: true });
    writeFileSync(fullPath, content);
  }

  /**
   * Starts a watcher and waits for its recursive watches to arm.
   *
   * macOS backs recursive fs.watch with FSEvents, whose stream starts on a run
   * loop rather than synchronously. A write issued in the same tick as start()
   * lands before the stream is listening and is never delivered — measured at
   * roughly one failure in five, locally and on the macOS runner.
   */
  async function startWatcher(watcher: { start: () => void }): Promise<void> {
    watcher.start();
    await new Promise((resolve) => setTimeout(resolve, 250));
  }

  /**
   * `retrigger` re-issues the filesystem change on every poll. A single event
   * can still be lost to stream setup or coalesced away; what these tests mean
   * is "a write under agents/<bot>/skills reconciles", not "this one event is
   * delivered".
   */
  async function waitUntil(
    predicate: () => boolean,
    timeoutMs = 5_000,
    intervalMs = 50,
    retrigger?: () => void,
  ): Promise<void> {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      if (predicate()) return;
      retrigger?.();
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new Error("Timed out waiting for watcher state");
  }

  it("records workspace skills with agentId on syncNow", () => {
    createWorkspaceSkill("bot-1", "agent-tool");

    const watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      openclawStateDir: stateDir,
      botIds: ["bot-1"],
    });

    watcher.syncNow();

    const wsSkills = db.getInstalledByAgent("bot-1");
    expect(wsSkills).toHaveLength(1);
    expect(wsSkills[0].slug).toBe("agent-tool");
    expect(wsSkills[0].source).toBe("workspace");
    expect(wsSkills[0].agentId).toBe("bot-1");
  });

  it("marks workspace skill as uninstalled when removed from disk", () => {
    db.recordInstall("removed-tool", "workspace", undefined, "bot-1");

    const watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      openclawStateDir: stateDir,
      botIds: ["bot-1"],
    });

    watcher.syncNow();

    const wsSkills = db.getInstalledByAgent("bot-1");
    expect(wsSkills).toHaveLength(0);
  });

  it("does not duplicate existing workspace records", () => {
    createWorkspaceSkill("bot-1", "my-tool");
    db.recordInstall("my-tool", "workspace", undefined, "bot-1");

    const watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      openclawStateDir: stateDir,
      botIds: ["bot-1"],
    });

    watcher.syncNow();

    const all = db.getAllInstalled().filter((r) => r.source === "workspace");
    expect(all).toHaveLength(1);
  });

  it("reconciles multiple agents", () => {
    createWorkspaceSkill("bot-1", "tool-a");
    createWorkspaceSkill("bot-2", "tool-b");

    const watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      openclawStateDir: stateDir,
      botIds: ["bot-1", "bot-2"],
    });

    watcher.syncNow();

    expect(db.getInstalledByAgent("bot-1")).toHaveLength(1);
    expect(db.getInstalledByAgent("bot-2")).toHaveLength(1);
  });

  it("skips workspace reconciliation when openclawStateDir not provided", () => {
    createWorkspaceSkill("bot-1", "tool-a");

    const watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
    });

    watcher.syncNow();

    const wsSkills = db.getInstalledByAgent("bot-1");
    expect(wsSkills).toHaveLength(0);
  });

  it("does not mark workspace skills as missing during shared-dir reconciliation", () => {
    // Workspace skill exists in ledger but NOT in shared skillsDir
    db.recordInstall("ws-only-tool", "workspace", undefined, "bot-1");
    createWorkspaceSkill("bot-1", "ws-only-tool");

    const watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      openclawStateDir: stateDir,
      botIds: ["bot-1"],
    });

    watcher.syncNow();

    // Should still be installed — shared-dir reconciliation must skip workspace records
    const wsSkills = db.getInstalledByAgent("bot-1");
    expect(wsSkills).toHaveLength(1);
    expect(wsSkills[0].slug).toBe("ws-only-tool");
  });

  it("discovers workspace botIds from disk even before setBotIds", () => {
    createWorkspaceSkill("bot-3", "dynamic-tool");

    const watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      openclawStateDir: stateDir,
      botIds: [],
    });

    watcher.syncNow();
    expect(db.getInstalledByAgent("bot-3")).toHaveLength(1);

    watcher.setBotIds(["bot-3"]);
    watcher.syncNow();
    expect(db.getInstalledByAgent("bot-3")).toHaveLength(1);
  });

  it("only marks workspace removals for the matching agent", () => {
    createWorkspaceSkill("bot-2", "shared-tool");
    db.recordInstall("shared-tool", "workspace", undefined, "bot-1");
    db.recordInstall("shared-tool", "workspace", undefined, "bot-2");

    const watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      openclawStateDir: stateDir,
      botIds: ["bot-1", "bot-2"],
    });

    watcher.syncNow();

    expect(db.getInstalledByAgent("bot-1")).toHaveLength(0);
    const bot2Skills = db.getInstalledByAgent("bot-2");
    expect(bot2Skills).toHaveLength(1);
    expect(bot2Skills[0].slug).toBe("shared-tool");
  });

  it(
    "watches workspace directories after start and reconciles removals",
    { timeout: 10_000 },
    async () => {
      createWorkspaceSkill("bot-1", "live-tool");

      const watcher = new SkillDirWatcher({
        skillsDir,
        skillDb: db,
        openclawStateDir: stateDir,
        botIds: ["bot-1"],
        debounceMs: 50,
      });

      watcher.syncNow();
      expect(db.getInstalledByAgent("bot-1")).toHaveLength(1);
      await startWatcher(watcher);

      removeWorkspaceSkill("bot-1", "live-tool");
      writeWorkspaceFile("agents/bot-1/skills/watch-trigger.txt", "trigger");

      await waitUntil(
        () => db.getInstalledByAgent("bot-1").length === 0,
        8_000,
        50,
        () =>
          writeWorkspaceFile(
            "agents/bot-1/skills/watch-trigger.txt",
            `trigger-${Date.now()}`,
          ),
      );
      watcher.stop();
    },
  );

  it(
    "ignores non-skill workspace writes under openclawStateDir",
    { timeout: 10_000 },
    async () => {
      const watcher = new SkillDirWatcher({
        skillsDir,
        skillDb: db,
        openclawStateDir: stateDir,
        botIds: ["bot-1"],
        debounceMs: 50,
      });

      const syncSpy = vi.spyOn(watcher as never, "syncNow");
      await startWatcher(watcher);
      // The shared-directory watcher has no path filter, so FSEvents replaying
      // the beforeEach creation of skillsDir into the fresh stream counts as a
      // sync (seen on CI: "called 1 times"). Drop those before measuring, or
      // this asserts "nothing ever syncs" rather than "noise does not sync".
      syncSpy.mockClear();

      writeWorkspaceFile("agents/bot-1/runtime/logs.txt", "noise");
      await new Promise((resolve) => setTimeout(resolve, 250));

      expect(syncSpy).not.toHaveBeenCalled();
      watcher.stop();
    },
  );

  it(
    "processes workspace skill path writes under agents/<bot>/skills",
    { timeout: 10_000 },
    async () => {
      createWorkspaceSkill("bot-1", "agent-tool");

      const watcher = new SkillDirWatcher({
        skillsDir,
        skillDb: db,
        openclawStateDir: stateDir,
        botIds: ["bot-1"],
        debounceMs: 50,
      });

      await startWatcher(watcher);

      writeWorkspaceFile(
        "agents/bot-1/skills/agent-tool/README.md",
        "touch to trigger watcher",
      );

      await waitUntil(
        () =>
          db
            .getInstalledByAgent("bot-1")
            .some((skill) => skill.slug === "agent-tool"),
        5_000,
        50,
        () =>
          writeWorkspaceFile(
            "agents/bot-1/skills/agent-tool/README.md",
            `touch ${Date.now()}`,
          ),
      );
      watcher.stop();
    },
  );

  it("normalizes workspace paths from the agents/<bot>/skills segment", () => {
    const watcher = new SkillDirWatcher({
      skillsDir,
      skillDb: db,
      openclawStateDir: stateDir,
      botIds: ["bot-1"],
    });

    const normalized = (
      watcher as unknown as {
        normalizeWorkspaceWatchPath: (filePath: string) => string;
      }
    ).normalizeWorkspaceWatchPath(
      "/tmp/agents/cache/agents/bot-1/skills/agent-tool/README.md",
    );

    expect(normalized).toBe("agents/bot-1/skills/agent-tool/README.md");
  });
});
