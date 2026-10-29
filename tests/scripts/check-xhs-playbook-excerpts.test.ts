import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { XHS_OPS_PLAYBOOK_VERSION } from "../../packages/shared/src/xhs-ops-playbook.js";

// scripts/check-xhs-playbook-excerpts.mjs is step 4 of the phone-skills
// release chain (takeover design §3.5, §4.5): it blocks a bundle whose skill
// docs no longer carry the excerpts the playbook cites. These cases run it
// against a throwaway phone-skills tree.

const SCRIPT = path.resolve(
  import.meta.dirname,
  "../../scripts/check-xhs-playbook-excerpts.mjs",
);
const run = promisify(execFile);

type Rule = {
  id: string;
  source: string;
  confidence: "doc" | "device-verified" | "design" | "community-unverified";
  excerpt?: string;
  bundleVersion?: number;
};

type Problem = { ruleId: string | null; code: string; message: string };

type Report = {
  phoneSkillsDir: string;
  manifestBundle: number;
  results: Array<{
    id: string;
    matchedOn: { file: string; line: number } | null;
    problems: Array<{ code: string; message: string }>;
  }>;
  uncited: number;
  bundles: Array<{ bundle: number; ids: string[] }>;
  problems: Problem[];
  ok: boolean;
};

/** The script's exports this file uses; it is plain JS without declarations. */
type CheckScript = {
  CheckSetupError: new (message?: string) => Error;
  DEFAULT_PHONE_SKILLS_DIR: string;
  checkPlaybookExcerpts: (input: {
    rules: readonly Rule[];
    phoneSkillsDir: string;
  }) => Report;
  formatReport: (
    report: Report,
    options: {
      playbook: { path: string; version: string; count: number };
      verbose?: boolean;
    },
  ) => string;
  parseArgs: (
    argv: readonly string[],
    cwd?: string,
  ) => { phoneSkillsDir: string; verbose: boolean; help: boolean };
  parsePhoneSkillsCitations: (source: string) => Array<{
    ref: string;
    file: string;
    relPath: string;
    spec: string | null;
    lines: number[] | null;
  }>;
};

const {
  CheckSetupError,
  DEFAULT_PHONE_SKILLS_DIR,
  checkPlaybookExcerpts,
  formatReport,
  parseArgs,
  parsePhoneSkillsCitations,
}: CheckScript = await import(pathToFileURL(SCRIPT).href);

const PROFILE_MD = [
  "# 我与资料维护",
  "",
  "- 只操作当前已登录账号自己的内容。",
  "- 每次只修改一个字段 → 保存或确认自动保存。",
  "- 小红书号涉及修改次数。",
].join("\n");
const LOGIN_MD = [
  "# 登录",
  "5. 检测到其他账号已登录时，不得自动退出或切换。",
].join("\n");

const RULES: Rule[] = [
  {
    id: "ID-01",
    source: "xhs/references/profile.md:3；xhs/references/login.md:2",
    confidence: "doc",
    excerpt: "只操作当前已登录账号自己的内容",
    bundleVersion: 66,
  },
  {
    id: "PF-01",
    source: "xhs/references/profile.md:4",
    confidence: "doc",
    excerpt: "只修改一个字段 → 保存或确认自动保存",
    bundleVersion: 66,
  },
  {
    id: "PF-03",
    source:
      "apps/controller/src/services/xhs-ops-task-builder.ts（禁止改动小红书号）；xhs/references/profile.md:5（平台侧涉及修改次数）",
    confidence: "design",
  },
  { id: "MT-01", source: "本方案", confidence: "design" },
];

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

/** A phone-skills tree: manifest.json plus files under apps/xhs/. */
function phoneSkills(
  files: Record<string, string>,
  bundleVersion: unknown = 66,
): string {
  const dir = mkdtempSync(path.join(tmpdir(), "xhs-playbook-check-"));
  dirs.push(dir);
  writeFileSync(
    path.join(dir, "manifest.json"),
    JSON.stringify({ schemaVersion: 2, bundleVersion, skills: [] }),
  );
  for (const [relative, text] of Object.entries(files)) {
    const file = path.join(dir, "apps", "xhs", ...relative.split("/"));
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  return dir;
}

const goodTree = () =>
  phoneSkills({
    "references/profile.md": PROFILE_MD,
    "references/login.md": LOGIN_MD,
  });

const codes = (report: { problems: Array<{ code: string }> }) =>
  report.problems.map((problem) => problem.code);

describe("checkPlaybookExcerpts", () => {
  it("passes when every excerpt sits on a cited line and the bundle matches", () => {
    const report = checkPlaybookExcerpts({
      rules: RULES,
      phoneSkillsDir: goodTree(),
    });
    expect(report.problems).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.manifestBundle).toBe(66);
    // 本方案 cites no phone-skills file; the design rule's citation is still checked.
    expect(report.results.map((result) => result.id)).toEqual([
      "ID-01",
      "PF-01",
      "PF-03",
    ]);
    expect(report.uncited).toBe(1);
    // A second citation the excerpt does not cover does not fail the rule.
    expect(report.results[0]?.matchedOn).toEqual({
      file: "xhs/references/profile.md",
      line: 3,
    });
    expect(report.bundles).toEqual([{ bundle: 66, ids: ["ID-01", "PF-01"] }]);

    const text = formatReport(report, {
      playbook: { path: "playbook.ts", version: "v1", count: RULES.length },
      verbose: true,
    });
    expect(text).toContain("ok    ID-01  xhs/references/profile.md:3");
    expect(text).toContain(
      "xhs/references/login.md:2: 5. 检测到其他账号已登录时",
    );
    expect(text).toContain("0 problem(s).");
    expect(text).not.toContain("Release blocked");
  });

  it("fails a rule whose excerpt is gone from the cited file", () => {
    const report = checkPlaybookExcerpts({
      rules: RULES,
      phoneSkillsDir: phoneSkills({
        "references/profile.md": PROFILE_MD.replace(
          "只修改一个字段",
          "只改一个字段",
        ),
        "references/login.md": LOGIN_MD,
      }),
    });
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      {
        ruleId: "PF-01",
        code: "excerpt_missing",
        message: "excerpt not found in xhs/references/profile.md",
      },
    ]);
    expect(
      formatReport(report, {
        playbook: { path: "playbook.ts", version: "v1", count: RULES.length },
      }),
    ).toContain("Release blocked");
  });

  it("names the line an excerpt moved to when it is not on the cited line", () => {
    // A line inserted above shifts both cited lines down by one.
    const shifted = PROFILE_MD.replace(
      "\n\n",
      "\n\n- 任务写明不改权限时按 BACK 关闭。\n",
    );
    const report = checkPlaybookExcerpts({
      rules: RULES,
      phoneSkillsDir: phoneSkills({
        "references/profile.md": shifted,
        "references/login.md": LOGIN_MD,
      }),
    });
    expect(codes(report)).toEqual(["wrong_line", "wrong_line"]);
    expect(report.problems[0]).toMatchObject({ ruleId: "ID-01" });
    expect(report.problems[0]?.message).toContain(
      "xhs/references/profile.md:4",
    );
    expect(report.problems[1]).toMatchObject({ ruleId: "PF-01" });
    expect(report.problems[1]?.message).toContain(
      "xhs/references/profile.md:5",
    );
  });

  it("fails when the playbook's bundle is not the manifest's", () => {
    const report = checkPlaybookExcerpts({
      rules: RULES,
      phoneSkillsDir: phoneSkills(
        {
          "references/profile.md": PROFILE_MD,
          "references/login.md": LOGIN_MD,
        },
        67,
      ),
    });
    expect(report.ok).toBe(false);
    expect(report.problems).toEqual([
      {
        ruleId: null,
        code: "bundle_mismatch",
        message:
          "2 rule(s) record phone-skills bundle 66, manifest.json has 67: ID-01, PF-01",
      },
    ]);
    const text = formatReport(report, {
      playbook: { path: "playbook.ts", version: "v1", count: RULES.length },
    });
    expect(text).toContain(
      "FAIL  bundle 66 recorded by 2 rule(s); manifest.json has 67",
    );
  });

  it("fails missing files, lines past the end and doc rules it cannot verify", () => {
    const report = checkPlaybookExcerpts({
      rules: [
        {
          id: "RK-03",
          source: "xhs/references/post.md:49-52",
          confidence: "doc",
          excerpt: "不能自行丢弃",
          bundleVersion: 66,
        },
        {
          id: "PF-05",
          source: "xhs/references/profile.md:72",
          confidence: "doc",
          excerpt: "不得猜测旧值",
          bundleVersion: 66,
        },
        {
          id: "PF-09",
          source: "xhs/references/profile.md:3",
          confidence: "doc",
        },
        {
          id: "MX-09",
          source: "本方案",
          confidence: "design",
          excerpt: "不能推算未显示数据",
        },
      ],
      phoneSkillsDir: goodTree(),
    });
    expect(codes(report)).toEqual([
      "missing_file",
      "line_out_of_range",
      "excerpt_missing",
      "doc_without_excerpt",
      "excerpt_without_citation",
    ]);
  });

  it("refuses a directory that is not a phone-skills checkout", () => {
    expect(() =>
      checkPlaybookExcerpts({
        rules: RULES,
        phoneSkillsDir: path.join(tmpdir(), "no-such-phone-skills-dir"),
      }),
    ).toThrow(CheckSetupError);
    expect(() =>
      checkPlaybookExcerpts({
        rules: RULES,
        phoneSkillsDir: phoneSkills({}, "66"),
      }),
    ).toThrow(/no positive integer bundleVersion/);
  });
});

describe("parsePhoneSkillsCitations", () => {
  it("reads xhs references with lines and notes and skips everything else", () => {
    expect(
      parsePhoneSkillsCitations(
        'xhs/references/nurture.md:19,33-35；本方案（D5）；apps/controller/src/x.ts（y）；xhs/references/profile-notes.md:15（"永不"是本方案的策略）；xhs/skill.json',
      ).map(({ file, spec, lines }) => ({ file, spec, lines })),
    ).toEqual([
      {
        file: "xhs/references/nurture.md",
        spec: "19,33-35",
        lines: [19, 33, 34, 35],
      },
      { file: "xhs/references/profile-notes.md", spec: "15", lines: [15] },
      { file: "xhs/skill.json", spec: null, lines: null },
    ]);
  });

  it("flags line numbers it cannot read", () => {
    expect(parsePhoneSkillsCitations("xhs/references/a.md:9-3")[0]?.lines).toBe(
      null,
    );
    const report = checkPlaybookExcerpts({
      rules: [
        {
          id: "PF-01",
          source: "xhs/references/profile.md:3、4",
          confidence: "doc",
          excerpt: "只修改一个字段",
          bundleVersion: 66,
        },
      ],
      phoneSkillsDir: goodTree(),
    });
    expect(codes(report)).toEqual(["bad_citation"]);
  });
});

describe("parseArgs", () => {
  it("defaults to the sibling tabby-control checkout", () => {
    expect(parseArgs([], "/work/nexu")).toEqual({
      phoneSkillsDir: DEFAULT_PHONE_SKILLS_DIR,
      verbose: false,
      help: false,
    });
    expect(DEFAULT_PHONE_SKILLS_DIR).toBe(
      path.resolve(import.meta.dirname, "../../../tabby-control/phone-skills"),
    );
  });

  it("resolves --phone-skills against the starting directory", () => {
    const start = path.resolve("/work/nexu/apps");
    expect(
      parseArgs(["--", "--phone-skills", "../skills", "-v"], start),
    ).toMatchObject({
      phoneSkillsDir: path.resolve(start, "../skills"),
      verbose: true,
    });
    expect(
      parseArgs(["--phone-skills=/abs/skills"], start).phoneSkillsDir,
    ).toBe(path.resolve("/abs/skills"));
    expect(() => parseArgs(["--phone-skills"], start)).toThrow(CheckSetupError);
    expect(() => parseArgs(["--strict"], start)).toThrow(/unknown argument/);
  });
});

describe("check-xhs-playbook-excerpts CLI", () => {
  it("loads the working-tree playbook and exits 1 when its citations are not there", async () => {
    const dir = phoneSkills({}, 1);
    const failure = await run(process.execPath, [
      SCRIPT,
      "--phone-skills",
      dir,
    ]).then(
      () => null,
      (error: { code?: number; stdout?: string }) => error,
    );
    expect(failure?.code).toBe(1);
    expect(failure?.stdout).toContain(`version ${XHS_OPS_PLAYBOOK_VERSION}`);
    expect(failure?.stdout).toContain("missing_file");
    expect(failure?.stdout).toContain("bundle_mismatch");
  });

  it("exits 2 with the usage when the phone-skills directory is missing", async () => {
    const failure = await run(process.execPath, [
      SCRIPT,
      "--phone-skills",
      path.join(tmpdir(), "no-such-phone-skills-dir"),
    ]).then(
      () => null,
      (error: { code?: number; stderr?: string }) => error,
    );
    expect(failure?.code).toBe(2);
    expect(failure?.stderr).toContain("phone-skills directory not found");
    expect(failure?.stderr).toContain("Usage:");
  });
});
