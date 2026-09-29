import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ControllerEnv } from "../../apps/controller/src/app/env.js";
import { WorkspaceTemplateWriter } from "../../apps/controller/src/runtime/workspace-template-writer.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, copyFile: vi.fn(fs.copyFile) };
});

const START = "<!-- NEXU-PLATFORM-START -->";
const END = "<!-- NEXU-PLATFORM-END -->";

const template = (block: string) =>
  `# Agent\n\nIntro text.\n\n${START}\n${block}\n${END}\n`;

/** What an agent's copy looks like after it has edited around the block. */
const workspaceDoc = (block: string, agentNotes: string) =>
  `# Agent\n\nIntro text.\n\n${START}\n${block}\n${END}\n\n${agentNotes}\n`;

describe("platform block sync", () => {
  let root: string;
  let templatesDir: string;
  let stateDir: string;
  let writer: WorkspaceTemplateWriter;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), "block-sync-"));
    templatesDir = path.join(root, "templates");
    stateDir = path.join(root, "state");
    await mkdir(path.join(templatesDir, "en"), { recursive: true });
    writer = new WorkspaceTemplateWriter({
      platformTemplatesDir: templatesDir,
      openclawStateDir: stateDir,
    } as ControllerEnv);
  });

  const seedTemplate = (block: string) =>
    writeFile(
      path.join(templatesDir, "en", "AGENTS.md"),
      template(block),
      "utf8",
    );

  const seedWorkspace = async (botId: string, content: string) => {
    await mkdir(path.join(stateDir, "agents", botId), { recursive: true });
    await writeFile(
      path.join(stateDir, "agents", botId, "AGENTS.md"),
      content,
      "utf8",
    );
  };

  const read = (botId: string) =>
    readFile(path.join(stateDir, "agents", botId, "AGENTS.md"), "utf8");

  const sync = (botId = "bot-1") =>
    writer.syncPlatformBlocks([{ id: botId, status: "active", lang: "en" }]);

  it("updates the platform block without touching what the agent wrote", async () => {
    await seedTemplate("New platform rule.");
    // The agent has rewritten the intro AND appended its own conventions —
    // both must survive, or self-evolution is silently destroyed.
    const agentEdited = `# Agent\n\nIntro the agent rewrote itself.\n\n${START}\nOld platform rule.\n${END}\n\n## My conventions\n\nAlways greet in Cantonese.\n`;
    await seedWorkspace("bot-1", agentEdited);

    const report = await sync();

    const after = await read("bot-1");
    expect(report.updated).toEqual([{ botId: "bot-1", file: "AGENTS.md" }]);
    expect(after).toContain("New platform rule.");
    expect(after).not.toContain("Old platform rule.");
    expect(after).toContain("Intro the agent rewrote itself.");
    expect(after).toContain("Always greet in Cantonese.");
  });

  it("is idempotent — a second run rewrites nothing", async () => {
    await seedTemplate("Stable rule.");
    await seedWorkspace("bot-1", workspaceDoc("Stable rule.", "## Mine"));

    const report = await sync();

    expect(report.updated).toHaveLength(0);
    expect(report.unchanged).toEqual([{ botId: "bot-1", file: "AGENTS.md" }]);
  });

  it("appends a block to a doc that predates the marked layout", async () => {
    await seedTemplate("New rule.");
    const legacy = "# Agent\n\nAn older doc with no platform block at all.\n";
    await seedWorkspace("bot-1", legacy);

    const report = await sync();

    const after = await read("bot-1");
    expect(report.repaired).toEqual([{ botId: "bot-1", file: "AGENTS.md" }]);
    expect(after).toContain("An older doc with no platform block at all.");
    expect(after).toContain("New rule.");
    expect(after.indexOf(START)).toBeGreaterThan(after.indexOf("older doc"));
  });

  it("repair is idempotent — the block is appended once, then updated in place", async () => {
    await seedTemplate("First rule.");
    await seedWorkspace("bot-1", "# Agent\n\nLegacy doc.\n");

    await sync();
    await seedTemplate("Second rule.");
    const second = await sync();

    const after = await read("bot-1");
    // One marker pair, not two — the second pass updated rather than re-appended.
    expect(after.split(START)).toHaveLength(2);
    expect(after.split(END)).toHaveLength(2);
    expect(second.repaired).toHaveLength(0);
    expect(second.updated).toEqual([{ botId: "bot-1", file: "AGENTS.md" }]);
    expect(after).toContain("Second rule.");
    expect(after).not.toContain("First rule.");
  });

  it("never appends to a doc with a broken marker pair, however many syncs run", async () => {
    await seedTemplate("New rule.");
    // A stray END. Appending a full block here would leave two ENDs, the parse
    // would still fail, and every sync would append again — unbounded growth.
    const broken = `# Agent\n\nSome text.\n${END}\nMore text.\n`;
    await seedWorkspace("bot-1", broken);

    await sync();
    await sync();
    await sync();

    expect(await read("bot-1")).toBe(broken);
  });

  it("writes a doc the bot never received, since seeding only runs at creation", async () => {
    // A template added after a bot was created reached nobody: seeding runs
    // once, and this sync used to only count the doc as missing. On one install
    // that left AGENTS.md absent for 8 of 15 bots, permanently.
    await seedTemplate("New rule.");
    await mkdir(path.join(stateDir, "agents", "bot-1"), { recursive: true });

    const report = await sync();

    expect(report.seeded).toEqual([{ botId: "bot-1", file: "AGENTS.md" }]);
    expect(report.missing).toEqual([]);
    expect(await read("bot-1")).toBe(template("New rule."));
  });

  it("preserves a workspace doc created between the missing read and the copy", async () => {
    await seedTemplate("New platform rule.");
    vi.mocked(copyFile).mockImplementationOnce(async (source, target, mode) => {
      await writeFile(target, "Concurrent agent notes.", "utf8");
      const fs =
        await vi.importActual<typeof import("node:fs/promises")>(
          "node:fs/promises",
        );
      await fs.copyFile(source, target, mode);
    });
    const report = await sync();
    expect(await read("bot-1")).toBe("Concurrent agent notes.");
    expect(report.seeded).toEqual([]);
    expect(report.unchanged).toEqual([{ botId: "bot-1", file: "AGENTS.md" }]);
  });

  it("restores a doc the agent deleted, and keeps it current afterwards", async () => {
    // Platform docs are a contract, not an agent draft, so a deleted one comes
    // back. Once restored it is an ordinary marked doc: the next sync updates
    // the block in place rather than rewriting the file.
    await seedTemplate("First rule.");
    await mkdir(path.join(stateDir, "agents", "bot-1"), { recursive: true });

    await sync();
    expect(await read("bot-1")).toBe(template("First rule."));

    await seedTemplate("Second rule.");
    const second = await sync();

    expect(second.seeded).toEqual([]);
    expect(second.updated).toEqual([{ botId: "bot-1", file: "AGENTS.md" }]);
    expect(await read("bot-1")).toContain("Second rule.");
  });

  it("creates the workspace directory for a bot that has none yet", async () => {
    await seedTemplate("New rule.");

    const report = await sync();

    expect(report.seeded).toEqual([{ botId: "bot-1", file: "AGENTS.md" }]);
    expect(await read("bot-1")).toBe(template("New rule."));
  });

  it("leaves a retired doc absent instead of seeding a file nothing reads", async () => {
    // OpenClaw 2026.9.4 dropped TOOLS.md from its bootstrap filenames and from
    // the sub-agent allowlist, and ships a migration folding it into AGENTS.md.
    // Seeding it would put 17KB in every workspace for no reader.
    await seedTemplate("New rule.");
    await writeFile(
      path.join(templatesDir, "en", "TOOLS.md"),
      template("Tool rule."),
      "utf8",
    );
    await mkdir(path.join(stateDir, "agents", "bot-1"), { recursive: true });

    const report = await sync();

    expect(report.missing).toEqual([{ botId: "bot-1", file: "TOOLS.md" }]);
    expect(report.seeded).toEqual([{ botId: "bot-1", file: "AGENTS.md" }]);
    await expect(
      readFile(path.join(stateDir, "agents", "bot-1", "TOOLS.md"), "utf8"),
    ).rejects.toThrow();
  });

  it("ignores template files that are not platform-managed", async () => {
    await seedTemplate("New rule.");
    // SOUL.md has no markers in the template, so it is the agent's entirely.
    await writeFile(
      path.join(templatesDir, "en", "SOUL.md"),
      "# Soul\n\nTemplate soul.\n",
      "utf8",
    );
    await seedWorkspace("bot-1", workspaceDoc("New rule.", "## Mine"));
    const soulPath = path.join(stateDir, "agents", "bot-1", "SOUL.md");
    await writeFile(soulPath, "# Soul\n\nThe agent's own soul.\n", "utf8");

    const report = await sync();

    expect(await readFile(soulPath, "utf8")).toBe(
      "# Soul\n\nThe agent's own soul.\n",
    );
    expect(
      [
        ...report.updated,
        ...report.unchanged,
        ...report.unmarked,
        ...report.missing,
      ].every((e) => e.file === "AGENTS.md"),
    ).toBe(true);
  });

  it("syncs a doc that only the English templates carry", async () => {
    // zh-CN translates the docs worth translating; TOOLS.md lives only under
    // en/. Resolving one directory for the whole set dropped it entirely, so a
    // zh-CN bot never received it and edits to it reached nobody.
    await mkdir(path.join(templatesDir, "zh-CN"), { recursive: true });
    await writeFile(
      path.join(templatesDir, "zh-CN", "AGENTS.md"),
      template("翻译过的平台规则。"),
      "utf8",
    );
    await writeFile(
      path.join(templatesDir, "en", "TOOLS.md"),
      template("English-only tool notes."),
      "utf8",
    );
    await mkdir(path.join(stateDir, "agents", "bot-1"), { recursive: true });
    await writeFile(
      path.join(stateDir, "agents", "bot-1", "AGENTS.md"),
      workspaceDoc("旧的平台规则。", "## 我的笔记"),
      "utf8",
    );
    await writeFile(
      path.join(stateDir, "agents", "bot-1", "TOOLS.md"),
      workspaceDoc("Stale tool notes.", "## My own notes"),
      "utf8",
    );

    const report = await writer.syncPlatformBlocks([
      { id: "bot-1", status: "active", lang: "zh-CN" },
    ]);

    const files = report.updated.map((e) => e.file).sort();
    expect(files).toEqual(["AGENTS.md", "TOOLS.md"]);

    // The translated doc wins for its own name; the English-only doc is still
    // delivered, and neither loses the agent's own writing.
    const agents = await readFile(
      path.join(stateDir, "agents", "bot-1", "AGENTS.md"),
      "utf8",
    );
    expect(agents).toContain("翻译过的平台规则。");
    expect(agents).toContain("## 我的笔记");

    const tools = await readFile(
      path.join(stateDir, "agents", "bot-1", "TOOLS.md"),
      "utf8",
    );
    expect(tools).toContain("English-only tool notes.");
    expect(tools).not.toContain("Stale tool notes.");
    expect(tools).toContain("## My own notes");
  });

  it("skips paused and deleted bots", async () => {
    await seedTemplate("New rule.");
    await seedWorkspace("bot-1", workspaceDoc("Old rule.", "## Mine"));

    const report = await writer.syncPlatformBlocks([
      { id: "bot-1", status: "paused", lang: "en" },
    ]);

    expect(report.updated).toHaveLength(0);
    expect(await read("bot-1")).toContain("Old rule.");
  });
});
