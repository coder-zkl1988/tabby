import { constants, type Dirent } from "node:fs";
import {
  copyFile,
  cp,
  mkdir,
  readFile,
  readdir,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import type { ControllerEnv } from "../app/env.js";
import { logger } from "../lib/logger.js";

interface BotInfo {
  id: string;
  status: string;
  /** ISO language code (e.g. "en", "zh-CN"). Defaults to "en". */
  lang?: string;
}

/** Marks the span of a workspace doc that the platform owns and may rewrite. */
const PLATFORM_BLOCK_START = "<!-- NEXU-PLATFORM-START -->";
const PLATFORM_BLOCK_END = "<!-- NEXU-PLATFORM-END -->";

/** Per-file outcome of a platform block sync, for logging and for tests. */
export interface PlatformBlockSyncReport {
  updated: Array<{ botId: string; file: string }>;
  unchanged: Array<{ botId: string; file: string }>;
  /** Doc had no block at all; one was appended so it can be kept current from now on. */
  repaired: Array<{ botId: string; file: string }>;
  /** Doc has a broken marker pair — left untouched, since the boundary is unknowable. */
  unmarked: Array<{ botId: string; file: string }>;
  /** Doc was absent and has been written from the template. */
  seeded: Array<{ botId: string; file: string }>;
  /** Template is platform-managed but the bot still has no such file. */
  missing: Array<{ botId: string; file: string }>;
}

/**
 * Platform docs the runtime has retired. Seeding one would put a file in every
 * workspace that nothing ever reads: OpenClaw 2026.9.4 dropped TOOLS.md from
 * WORKSPACE_BOOTSTRAP_FILENAMES, narrowed SUBAGENT_BOOTSTRAP_ALLOWLIST to
 * AGENTS.md alone, and ships a migration folding TOOLS.md into AGENTS.md.
 *
 * Drop the entry — and the template — once its content has been folded into
 * AGENTS.md. Until then these stay reported as missing rather than created.
 */
const RETIRED_TEMPLATE_DOCS = new Set(["TOOLS.md"]);

/**
 * The text between the markers, or null when the document has no complete,
 * well-ordered pair. A lone or reversed marker means the document is not a
 * shape we understand, and guessing at the boundary would corrupt it.
 */
function extractPlatformBlock(content: string): string | null {
  const start = content.indexOf(PLATFORM_BLOCK_START);
  const end = content.indexOf(PLATFORM_BLOCK_END);
  if (start < 0 || end < 0 || end < start) return null;
  return content.slice(start + PLATFORM_BLOCK_START.length, end);
}

/**
 * True when the document carries no marker at all, and a block can therefore be
 * appended safely.
 *
 * A document with a stray or reversed marker is explicitly NOT safe: appending a
 * complete block would leave two of one marker, and the parse would still fail —
 * so the next sync would append again, and again. Repair has to be limited to
 * the case where the result is unambiguous.
 */
function hasNoPlatformMarkers(content: string): boolean {
  return (
    !content.includes(PLATFORM_BLOCK_START) &&
    !content.includes(PLATFORM_BLOCK_END)
  );
}

/** Append a platform block to a doc that has none, keeping one blank line before it. */
function appendPlatformBlock(content: string, block: string): string {
  const body = content.replace(/\s*$/, "");
  return `${body}\n\n${PLATFORM_BLOCK_START}${block}${PLATFORM_BLOCK_END}\n`;
}

/** Swap in a new platform block, leaving every byte outside the markers alone. */
function replacePlatformBlock(content: string, block: string): string {
  const start = content.indexOf(PLATFORM_BLOCK_START);
  const end = content.indexOf(PLATFORM_BLOCK_END);
  return (
    content.slice(0, start + PLATFORM_BLOCK_START.length) +
    block +
    content.slice(end)
  );
}

const TIMEZONE_LINE_RE = /^-\s+\*\*(Timezone:|时区：)\*\*\s*$/;

/**
 * Fill the empty Timezone/时区 placeholder in a freshly-seeded USER.md with the
 * controller's own system timezone. Nexu is desktop-first — the controller runs
 * on the same machine as the user, so its IANA timezone is the user's, and there
 * is no need to ask (AGENTS.md's "首次接触"/"First Contact" flow only asks as a
 * fallback when USER.md still has no timezone recorded).
 */
export function injectTimezone(content: string, timezone: string): string {
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const match = (lines[i]?.trim() ?? "").match(TIMEZONE_LINE_RE);
    if (match) {
      lines[i] = `- **${match[1]}** ${timezone}`;
      return lines.join("\n");
    }
  }
  return content;
}

export class WorkspaceTemplateWriter {
  constructor(private readonly env: ControllerEnv) {}

  /**
   * Seed each active bot's workspace with platform docs (AGENTS.md,
   * BOOTSTRAP.md, IDENTITY.md, SOUL.md, TOOLS.md, USER.md, HEARTBEAT.md).
   *
   * Strict seed-if-missing semantics: any file that already exists in the
   * destination is left untouched. Agents edit these files at runtime
   * (self-evolution), so re-writing would silently destroy state. Should
   * therefore only need to be invoked once per bot, at creation time.
   */
  async write(bots: BotInfo[]): Promise<void> {
    const activeBots = bots.filter((bot) => bot.status === "active");
    const templatesRoot = this.env.platformTemplatesDir;

    if (!templatesRoot) {
      logger.warn(
        {},
        "platformTemplatesDir not configured; new agents will be created without platform docs (AGENTS.md, BOOTSTRAP.md, ...)",
      );
      return;
    }

    const rootExists = await this.directoryExists(templatesRoot);
    if (!rootExists) {
      logger.warn({ templatesRoot }, "platform templates directory not found");
      return;
    }

    for (const bot of activeBots) {
      const templateFiles = await this.resolveTemplateFiles(
        templatesRoot,
        bot.lang ?? "en",
      );
      await this.copyPlatformTemplates(bot.id, templateFiles);
    }
  }

  /**
   * Refresh the platform-managed block inside each active bot's workspace docs.
   *
   * Seeding runs once, at bot creation, and never overwrites — agents edit these
   * files at runtime, so re-copying a template would destroy whatever the agent
   * has since written. That leaves platform guidance frozen at whenever the bot
   * was created: a rule added to the template today reaches no existing bot, and
   * the fleet drifts further apart with every release.
   *
   * The templates mark their own section with
   * `<!-- NEXU-PLATFORM-START -->` / `<!-- NEXU-PLATFORM-END -->`. Everything
   * inside is ours to update; everything outside belongs to the agent. Replacing
   * only the marked span keeps both true at once.
   *
   * Deliberately conservative about what it will touch:
   * - a workspace file that does not exist is written from the template. There
   *   is nothing of the agent's there to lose, and {@link write} alone cannot
   *   close the gap: it runs once at creation, so a template added later, or a
   *   doc the agent deleted, would otherwise never arrive. Docs the runtime has
   *   retired ({@link RETIRED_TEMPLATE_DOCS}) stay absent and are reported
   * - a file with no marker at all predates this layout, and gets a block
   *   appended so it can be kept current from then on. Appending adds nothing
   *   the agent wrote and is idempotent: once the block exists, later syncs
   *   update it in place
   * - a file with a stray or reversed marker is skipped. Appending there would
   *   leave a duplicate marker, the parse would still fail, and every sync would
   *   append again
   * - a file whose block already matches is not rewritten, so a steady state
   *   costs one read
   */
  async syncPlatformBlocks(bots: BotInfo[]): Promise<PlatformBlockSyncReport> {
    const report: PlatformBlockSyncReport = {
      updated: [],
      unchanged: [],
      repaired: [],
      unmarked: [],
      seeded: [],
      missing: [],
    };
    const templatesRoot = this.env.platformTemplatesDir;
    if (!templatesRoot || !(await this.directoryExists(templatesRoot))) {
      logger.warn(
        { templatesRoot },
        "platform templates unavailable; skipping block sync",
      );
      return report;
    }

    for (const bot of bots.filter((b) => b.status === "active")) {
      const templateFiles = await this.resolveTemplateFiles(
        templatesRoot,
        bot.lang ?? "en",
      );

      for (const entry of templateFiles) {
        if (!entry.name.endsWith(".md")) continue;
        const templateBlock = extractPlatformBlock(
          await readFile(entry.sourcePath, "utf8").catch(() => ""),
        );
        // Only files the template itself marks are platform-managed.
        if (templateBlock == null) continue;

        const target = path.join(
          this.env.openclawStateDir,
          "agents",
          bot.id,
          entry.name,
        );
        const current = await readFile(target, "utf8").catch(() => null);
        if (current == null) {
          // Nothing of the agent's exists here to protect, so writing the
          // template is the same safety argument as `repaired`. It is also the
          // only way a doc ever reaches a bot created before that template
          // existed — seeding runs once, at creation — and the only way a doc
          // the agent deleted comes back. Platform docs are a contract, not an
          // agent draft, so they are restored rather than left deleted.
          if (RETIRED_TEMPLATE_DOCS.has(entry.name)) {
            report.missing.push({ botId: bot.id, file: entry.name });
            continue;
          }
          const outcome = await this.seedWorkspaceDoc(target, entry.sourcePath);
          report[outcome].push({
            botId: bot.id,
            file: entry.name,
          });
          continue;
        }
        const currentBlock = extractPlatformBlock(current);
        if (currentBlock == null) {
          if (!hasNoPlatformMarkers(current)) {
            report.unmarked.push({ botId: bot.id, file: entry.name });
            continue;
          }
          await writeFile(
            target,
            appendPlatformBlock(current, templateBlock),
            "utf8",
          );
          report.repaired.push({ botId: bot.id, file: entry.name });
          continue;
        }
        if (currentBlock === templateBlock) {
          report.unchanged.push({ botId: bot.id, file: entry.name });
          continue;
        }
        await writeFile(
          target,
          replacePlatformBlock(current, templateBlock),
          "utf8",
        );
        report.updated.push({ botId: bot.id, file: entry.name });
      }
    }

    logger.info(
      {
        updated: report.updated.length,
        unchanged: report.unchanged.length,
        repaired: report.repaired.length,
        unmarked: report.unmarked.length,
        seeded: report.seeded.length,
        missing: report.missing.length,
      },
      "platform block sync complete",
    );
    if (report.unmarked.length) {
      logger.warn(
        { files: report.unmarked.slice(0, 10) },
        "workspace docs with a broken platform marker pair were left untouched; " +
          "repair them by hand, or they will never receive platform updates",
      );
    }
    return report;
  }

  /**
   * Resolve the best language-specific template directory.
   * Tries `<root>/<lang>/` first, then `<root>/en/`, then `<root>` itself
   * for backward compatibility with flat template layouts.
   */
  private async resolveTemplateDir(
    root: string,
    lang: string,
  ): Promise<string> {
    const langDir = path.join(root, lang);
    if (await this.directoryExists(langDir)) {
      return langDir;
    }
    const enDir = path.join(root, "en");
    if (await this.directoryExists(enDir)) {
      return enDir;
    }
    return root;
  }

  /**
   * Write one template into a workspace that lacks it, creating the agent
   * directory when the bot has never been initialized. An exclusive copy
   * preserves files created concurrently; other failures stay reportable
   * without taking config sync down.
   */
  private async seedWorkspaceDoc(
    targetPath: string,
    sourcePath: string,
  ): Promise<"seeded" | "unchanged" | "missing"> {
    try {
      await mkdir(path.dirname(targetPath), { recursive: true });
      await copyFile(sourcePath, targetPath, constants.COPYFILE_EXCL);
      logger.debug(
        { targetPath, sourcePath, decision: "seeded-by-block-sync" },
        "platform_template_file_decision",
      );
      return "seeded";
    } catch (err) {
      if (err instanceof Error && "code" in err && err.code === "EEXIST") {
        return "unchanged";
      }
      logger.warn(
        {
          targetPath,
          sourcePath,
          error: err instanceof Error ? err.message : err,
        },
        "failed to seed missing platform doc",
      );
      return "missing";
    }
  }

  /**
   * The platform docs for a language, each resolved to its own source file.
   *
   * A translated directory is not required to be complete: `zh-CN/` carries the
   * four docs worth translating, while TOOLS.md exists only under `en/`.
   * Resolving one directory for the whole set therefore drops every file the
   * translation happens not to have — a zh-CN bot never saw TOOLS.md at all,
   * neither at seeding nor on sync, and edits to it reached nobody. Falling back
   * per file keeps the translated copies where they exist and the English
   * original everywhere else.
   */
  private async resolveTemplateFiles(
    root: string,
    lang: string,
  ): Promise<Array<{ name: string; sourcePath: string }>> {
    const primaryDir = await this.resolveTemplateDir(root, lang);
    const fallbackDir = path.join(root, "en");
    const byName = new Map<string, string>();

    // Fallback first so a translated file of the same name overwrites it.
    for (const dir of [fallbackDir, primaryDir]) {
      if (dir !== primaryDir && !(await this.directoryExists(dir))) continue;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isFile()) continue;
        byName.set(entry.name, path.join(dir, entry.name));
      }
    }
    return [...byName].map(([name, sourcePath]) => ({ name, sourcePath }));
  }

  private async copyPlatformTemplates(
    botId: string,
    templateFiles: Array<{ name: string; sourcePath: string }>,
  ): Promise<void> {
    const workspaceDir = path.join(this.env.openclawStateDir, "agents", botId);

    // Ensure workspace directory exists before OpenClaw initializes it
    await mkdir(workspaceDir, { recursive: true });

    try {
      let seededCount = 0;
      let preservedCount = 0;

      for (const entry of templateFiles) {
        const sourcePath = entry.sourcePath;
        // Write directly to workspace root, not nexu-platform/ subdirectory
        const targetPath = path.join(workspaceDir, entry.name);

        // Strict seed-if-missing: never clobber agent-edited content.
        // Agents read/write these files at runtime; force-overwriting would
        // silently destroy self-evolution state.
        if (await this.pathExists(targetPath)) {
          preservedCount += 1;
          logger.debug(
            {
              botId,
              workspaceDir,
              sourcePath,
              targetPath,
              decision: "preserved",
            },
            "platform_template_file_decision",
          );
          continue;
        }

        await cp(sourcePath, targetPath, {
          recursive: true,
          force: false,
          errorOnExist: false,
        });
        seededCount += 1;
        logger.debug(
          {
            botId,
            workspaceDir,
            sourcePath,
            targetPath,
            decision: "seeded",
          },
          "platform_template_file_decision",
        );

        if (entry.name === "USER.md") {
          await this.seedTimezone(targetPath);
        }
      }

      logger.debug(
        { botId, workspaceDir, seededCount, preservedCount },
        "platform templates seed pass complete",
      );
    } catch (err) {
      logger.error(
        {
          botId,
          files: templateFiles.map((f) => f.name),
          error: err instanceof Error ? err.message : err,
        },
        "failed to seed platform templates",
      );
    }
  }

  private async seedTimezone(userMdPath: string): Promise<void> {
    try {
      const content = await readFile(userMdPath, "utf8");
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const next = injectTimezone(content, timezone);
      if (next !== content) {
        await writeFile(userMdPath, next);
      }
    } catch (err) {
      logger.debug(
        { userMdPath, error: err instanceof Error ? err.message : err },
        "failed to seed timezone into USER.md",
      );
    }
  }

  private async directoryExists(dirPath: string): Promise<boolean> {
    try {
      const stats = await stat(dirPath);
      return stats.isDirectory();
    } catch {
      return false;
    }
  }

  private async pathExists(filePath: string): Promise<boolean> {
    try {
      await stat(filePath);
      return true;
    } catch {
      return false;
    }
  }
}
