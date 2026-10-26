#!/usr/bin/env node
/**
 * Checks the xhs-ops playbook's phone-skills citations against a phone-skills
 * checkout. This is step 4 of the phone-skills release chain (takeover design
 * docs/plans/2026-10-14-xhs-account-takeover-design.md §3.5, §4.5, D8): run it
 * after editing tabby-control/phone-skills and before shipping the bundle.
 *
 *   pnpm check:xhs-playbook                        # ../tabby-control/phone-skills
 *   pnpm check:xhs-playbook --phone-skills <dir>   # any phone-skills checkout
 *   pnpm check:xhs-playbook --verbose              # also print every cited line
 *
 * For every rule of packages/shared/src/xhs-ops-playbook.ts it verifies that
 *   - each phone-skills file the rule cites exists (`xhs/<path>` is
 *     <phone-skills>/apps/xhs/<path>) and each cited line number is inside it;
 *   - the rule's excerpt appears verbatim in a cited file, and on one of the
 *     cited lines when the citation names lines;
 *   - a doc rule has an excerpt, and a rule with an excerpt cites a
 *     phone-skills file and records a bundleVersion;
 *   - every recorded bundleVersion (each one is set from the playbook's
 *     PHONE_SKILLS_BUNDLE) equals <phone-skills>/manifest.json bundleVersion.
 * A citation the excerpt does not cover (a second file, a further line) is
 * only checked for existence; --verbose prints its text so a person can read
 * it, and a before/after diff of that output shows any drift.
 *
 * Exit status: 0 everything matches; 1 a citation or the bundle is out of
 * step, so block the release and update the playbook; 2 usage or setup error.
 *
 * How the playbook is loaded: its TypeScript source is imported directly
 * through tsx's tsImport (tsx is a root devDependency and the repo's
 * TypeScript runner), so the check always sees the working tree and needs no
 * build. @nexu/shared's dist is deliberately not used: it is only as fresh as
 * the last build, and a stale build would check the wrong excerpts while
 * looking green. If tsx cannot be loaded, run `pnpm install`.
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
);
export const PLAYBOOK_PATH = path.join(
  REPO_ROOT,
  "packages",
  "shared",
  "src",
  "xhs-ops-playbook.ts",
);
export const DEFAULT_PHONE_SKILLS_DIR = path.resolve(
  REPO_ROOT,
  "..",
  "tabby-control",
  "phone-skills",
);

const USAGE = `Usage: node scripts/check-xhs-playbook-excerpts.mjs [--phone-skills <dir>] [--verbose]

Checks every phone-skills citation of packages/shared/src/xhs-ops-playbook.ts
against a phone-skills checkout. <dir> defaults to ../tabby-control/phone-skills
next to this repository; a relative <dir> is resolved against the directory the
command was started from.`;

/** Bad arguments or unreadable inputs, as opposed to a playbook out of step: exit 2. */
export class CheckSetupError extends Error {}

const LINE_SPEC = /^\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*$/;

function describeError(error) {
  return error instanceof Error ? error.message : String(error);
}

function unique(values) {
  return [...new Set(values)];
}

/** "19,33-35" → [19, 33, 34, 35]; null when malformed or a range runs backwards. */
export function parseLineSpec(spec) {
  if (!LINE_SPEC.test(spec)) return null;
  const lines = [];
  for (const part of spec.split(",")) {
    const [from, to = from] = part.split("-").map(Number);
    if (to < from) return null;
    for (let line = from; line <= to; line += 1) lines.push(line);
  }
  return lines;
}

/**
 * The phone-skills references of a rule's `source`: 「；」-separated, each with
 * an optional trailing （note）. Only `xhs/<path>[:lines]` points into
 * phone-skills (apps/xhs/<path>); 本方案 and nexu repo paths are not checked.
 */
export function parsePhoneSkillsCitations(source) {
  const citations = [];
  for (const part of source.split("；")) {
    const ref = part
      .trim()
      .replace(/（[^（）]*）$/u, "")
      .trim();
    const match = /^xhs\/([^\s:]+)(?::(.*))?$/u.exec(ref);
    if (!match) continue;
    const [, rest, spec = null] = match;
    citations.push({
      ref,
      file: `xhs/${rest}`,
      relPath: path.join("apps", "xhs", ...rest.split("/")),
      spec,
      lines: spec === null ? null : parseLineSpec(spec),
    });
  }
  return citations;
}

function readLines(file) {
  try {
    const lines = readFileSync(file, "utf8").split(/\r?\n/);
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines;
  } catch (error) {
    const code =
      error && typeof error === "object" && "code" in error ? error.code : "";
    if (code === "ENOENT" || code === "ENOTDIR" || code === "EISDIR")
      return null;
    throw error;
  }
}

/** manifest.json bundleVersion of a phone-skills checkout. */
export function readManifestBundle(phoneSkillsDir) {
  if (!existsSync(phoneSkillsDir) || !statSync(phoneSkillsDir).isDirectory()) {
    throw new CheckSetupError(
      `phone-skills directory not found: ${phoneSkillsDir} (pass --phone-skills <dir>)`,
    );
  }
  const manifestPath = path.join(phoneSkillsDir, "manifest.json");
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch (error) {
    throw new CheckSetupError(
      `cannot read ${manifestPath} (${describeError(error)}); is ${phoneSkillsDir} a phone-skills checkout?`,
    );
  }
  const bundle = manifest?.bundleVersion;
  if (!Number.isInteger(bundle) || bundle < 1) {
    throw new CheckSetupError(
      `${manifestPath} has no positive integer bundleVersion`,
    );
  }
  return bundle;
}

function checkRule(rule, linesOf) {
  const citations = parsePhoneSkillsCitations(rule.source);
  const { excerpt } = rule;
  const problems = [];
  if (citations.length === 0) {
    if (excerpt !== undefined) {
      problems.push({
        code: "excerpt_without_citation",
        message: "has an excerpt but cites no phone-skills file (xhs/…)",
      });
    } else if (rule.confidence === "doc") {
      problems.push({
        code: "doc_without_citation",
        message: "doc rule cites no phone-skills file (xhs/…)",
      });
    }
    return problems.length > 0
      ? {
          id: rule.id,
          citations,
          excerpt,
          matchedOn: null,
          citedLines: [],
          problems,
        }
      : null;
  }
  if (rule.confidence === "doc" && excerpt === undefined) {
    problems.push({
      code: "doc_without_excerpt",
      message: "doc rule without an excerpt: its citation cannot be verified",
    });
  }
  if (excerpt !== undefined && rule.bundleVersion === undefined) {
    problems.push({
      code: "missing_bundle_version",
      message: "has an excerpt but records no bundleVersion",
    });
  }

  const readable = [];
  for (const citation of citations) {
    if (citation.spec !== null && citation.lines === null) {
      problems.push({
        code: "bad_citation",
        message: `cannot read the line numbers of ${citation.ref}`,
      });
      continue;
    }
    const text = linesOf(citation.relPath);
    if (text === null) {
      problems.push({
        code: "missing_file",
        message: `${citation.file} does not exist in phone-skills`,
      });
      continue;
    }
    const outside = (citation.lines ?? []).filter(
      (line) => line < 1 || line > text.length,
    );
    if (outside.length > 0) {
      problems.push({
        code: "line_out_of_range",
        message: `${citation.ref}: ${citation.file} has only ${text.length} lines`,
      });
    }
    readable.push({ citation, text });
  }

  let matchedOn = null;
  if (excerpt !== undefined && readable.length > 0) {
    for (const { citation, text } of readable) {
      const candidates = citation.lines ?? text.map((_, index) => index + 1);
      const hit = candidates.find((line) => text[line - 1]?.includes(excerpt));
      if (hit !== undefined) {
        matchedOn = { file: citation.file, line: hit };
        break;
      }
    }
    if (matchedOn === null) {
      const found = unique(
        readable.flatMap(({ citation, text }) =>
          text.flatMap((line, index) =>
            line.includes(excerpt) ? [`${citation.file}:${index + 1}`] : [],
          ),
        ),
      );
      problems.push(
        found.length > 0
          ? {
              code: "wrong_line",
              message: `excerpt is on ${found.join(", ")}, not on the cited line (${readable
                .map(({ citation }) => citation.ref)
                .join("；")})`,
            }
          : {
              code: "excerpt_missing",
              message: `excerpt not found in ${unique(
                readable.map(({ citation }) => citation.file),
              ).join(", ")}`,
            },
      );
    }
  }

  const citedLines = readable.flatMap(({ citation, text }) =>
    (citation.lines ?? []).map((line) => ({
      file: citation.file,
      line,
      text: text[line - 1] ?? "(past the end of the file)",
      matched:
        matchedOn !== null &&
        matchedOn.file === citation.file &&
        matchedOn.line === line,
    })),
  );
  return { id: rule.id, citations, excerpt, matchedOn, citedLines, problems };
}

/**
 * Checks playbook rules against a phone-skills checkout. Rules that cite no
 * phone-skills file and carry no excerpt are only counted (`uncited`).
 * Throws CheckSetupError when the directory or its manifest is unusable.
 */
export function checkPlaybookExcerpts({ rules, phoneSkillsDir }) {
  const manifestBundle = readManifestBundle(phoneSkillsDir);
  const cache = new Map();
  const linesOf = (relPath) => {
    if (!cache.has(relPath))
      cache.set(relPath, readLines(path.join(phoneSkillsDir, relPath)));
    return cache.get(relPath);
  };

  const results = [];
  let uncited = 0;
  for (const rule of rules) {
    const result = checkRule(rule, linesOf);
    if (result) results.push(result);
    else uncited += 1;
  }

  const byBundle = new Map();
  for (const rule of rules) {
    if (rule.bundleVersion === undefined) continue;
    byBundle.set(rule.bundleVersion, [
      ...(byBundle.get(rule.bundleVersion) ?? []),
      rule.id,
    ]);
  }
  const bundles = [...byBundle].map(([bundle, ids]) => ({ bundle, ids }));
  const problems = [
    ...results.flatMap((result) =>
      result.problems.map((problem) => ({ ruleId: result.id, ...problem })),
    ),
    ...bundles
      .filter(({ bundle }) => bundle !== manifestBundle)
      .map(({ bundle, ids }) => ({
        ruleId: null,
        code: "bundle_mismatch",
        message: `${ids.length} rule(s) record phone-skills bundle ${bundle}, manifest.json has ${manifestBundle}: ${ids.join(", ")}`,
      })),
  ];
  return {
    phoneSkillsDir,
    manifestBundle,
    results,
    uncited,
    bundles,
    problems,
    ok: problems.length === 0,
  };
}

/** The human-readable report printed by the CLI. */
export function formatReport(report, { playbook, verbose = false }) {
  const out = [
    "xhs-ops playbook excerpt check",
    `  playbook      ${playbook.path} (version ${playbook.version}, ${playbook.count} rules)`,
    `  phone-skills  ${report.phoneSkillsDir} (manifest bundleVersion ${report.manifestBundle})`,
    "",
  ];
  for (const result of report.results) {
    const status = result.problems.length > 0 ? "FAIL" : "ok  ";
    const where = result.matchedOn
      ? `${result.matchedOn.file}:${result.matchedOn.line}`
      : result.citations.map((citation) => citation.ref).join("；") || "-";
    const what =
      result.excerpt === undefined
        ? "(no excerpt: the citation is only checked to exist)"
        : `「${result.excerpt}」`;
    out.push(`  ${status}  ${result.id.padEnd(6)} ${where}  ${what}`);
    for (const problem of result.problems) {
      out.push(`          ${problem.code}: ${problem.message}`);
    }
    if (verbose) {
      for (const cited of result.citedLines) {
        out.push(
          `          ${cited.matched ? "=" : " "} ${cited.file}:${cited.line}: ${cited.text}`,
        );
      }
    }
  }
  out.push("");
  if (report.bundles.length === 0) {
    out.push("  bundle  no rule records a phone-skills bundleVersion");
  }
  for (const { bundle, ids } of report.bundles) {
    const matches = bundle === report.manifestBundle;
    out.push(
      `  ${matches ? "ok  " : "FAIL"}  bundle ${bundle} recorded by ${ids.length} rule(s); manifest.json has ${report.manifestBundle}`,
    );
    if (!matches) out.push(`          bundle_mismatch: ${ids.join(", ")}`);
  }
  out.push("");
  const excerpts = report.results.filter(
    (result) => result.excerpt !== undefined,
  ).length;
  out.push(
    `${report.results.length} rule(s) cite phone-skills (${excerpts} with an excerpt), ${report.uncited} cite none; ${report.problems.length} problem(s).`,
  );
  if (!report.ok) {
    out.push(
      "Release blocked: update packages/shared/src/xhs-ops-playbook.ts (the excerpt, the cited line or PHONE_SKILLS_BUNDLE, bumping XHS_OPS_PLAYBOOK_VERSION with it), then re-run.",
    );
  }
  return out.join("\n");
}

/** CLI arguments; a relative --phone-skills resolves against where the command started. */
export function parseArgs(argv, cwd = process.env.INIT_CWD ?? process.cwd()) {
  const options = {
    phoneSkillsDir: DEFAULT_PHONE_SKILLS_DIR,
    verbose: false,
    help: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--") continue;
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--verbose" || arg === "-v") {
      options.verbose = true;
    } else if (arg === "--phone-skills" || arg.startsWith("--phone-skills=")) {
      const value =
        arg === "--phone-skills"
          ? argv[++index]
          : arg.slice("--phone-skills=".length);
      if (!value || value.startsWith("--")) {
        throw new CheckSetupError("--phone-skills needs a directory");
      }
      options.phoneSkillsDir = path.resolve(cwd, value);
    } else {
      throw new CheckSetupError(`unknown argument: ${arg}`);
    }
  }
  return options;
}

/** Imports the playbook from its TypeScript source (see the header). */
export async function loadPlaybook(file = PLAYBOOK_PATH) {
  const shown = path.relative(REPO_ROOT, file);
  let tsImport;
  try {
    ({ tsImport } = await import("tsx/esm/api"));
  } catch (error) {
    throw new CheckSetupError(
      `cannot load tsx to read ${shown} (${describeError(error)}); run pnpm install`,
    );
  }
  let loaded;
  try {
    loaded = await tsImport(pathToFileURL(file).href, import.meta.url);
  } catch (error) {
    throw new CheckSetupError(
      `cannot import ${shown}: ${describeError(error)}`,
    );
  }
  const { XHS_OPS_PLAYBOOK: rules, XHS_OPS_PLAYBOOK_VERSION: version } = loaded;
  if (!Array.isArray(rules) || typeof version !== "string") {
    throw new CheckSetupError(
      `${shown} does not export XHS_OPS_PLAYBOOK and XHS_OPS_PLAYBOOK_VERSION`,
    );
  }
  return { path: shown, version, rules };
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      console.log(USAGE);
      return 0;
    }
    const playbook = await loadPlaybook();
    const report = checkPlaybookExcerpts({
      rules: playbook.rules,
      phoneSkillsDir: options.phoneSkillsDir,
    });
    console.log(
      formatReport(report, {
        playbook: {
          path: playbook.path,
          version: playbook.version,
          count: playbook.rules.length,
        },
        verbose: options.verbose,
      }),
    );
    return report.ok ? 0 : 1;
  } catch (error) {
    if (!(error instanceof CheckSetupError)) throw error;
    console.error(`check-xhs-playbook-excerpts: ${error.message}`);
    console.error(USAGE);
    return 2;
  }
}

function invokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return pathToFileURL(realpathSync(entry)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (invokedDirectly()) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      console.error(error);
      process.exitCode = 2;
    },
  );
}
