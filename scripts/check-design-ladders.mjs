#!/usr/bin/env node
/**
 * Guards the A2UI design ladders documented at the top of
 * apps/web/src/lib/a2ui/a2ui.css.
 *
 * The colour tokens converged on their own because they live in `@theme`
 * and become real Tailwind utilities — writing an off-palette colour means
 * writing a visibly different class. The type ladder and the two text-colour
 * rules have no such compile-time backstop: `text-[11px]` and `text-[13px]`
 * are the same syntax, so drift is invisible in review. This script is that
 * backstop.
 *
 * Escape hatch: put `design-ladder-ignore` in a comment on the same line.
 */
import { readFileSync } from "node:fs";
import { globSync } from "node:fs";
import { join, relative } from "node:path";

const ROOT = new URL("..", import.meta.url).pathname;

/**
 * The a2ui tree is where the ladders are the contract.
 *
 * Deliberately NOT included: components/experts/expert-card.tsx. That is a
 * trading-card artifact with its own miniature scale, and the design doc
 * exempts it by name — "小于 12px 只留在专家卡的装饰性标签上". Widening the
 * scope to it would mean nine suppression comments and no new signal.
 */
const SCOPES = ["apps/web/src/lib/a2ui/**/*.tsx"];

/** type ladder: 24 / 18 / 15 / 14 / 13 / 12 (px, nothing below 12). */
const TYPE_LADDER = new Set([12, 13, 14, 15, 18, 24]);

/** Raw Tailwind palette families. `neutral-*` is the design system's own. */
const PALETTE =
  /\b(?:text|bg|border|from|to|via|ring|stroke|fill|decoration|outline|shadow|accent)-(sky|emerald|amber|rose|violet|slate|cyan|teal|blue|green|red|indigo|purple|orange|yellow|pink|lime|fuchsia|gray|zinc|stone)-\d{2,3}\b/;

const RULES = [
  {
    id: "type-ladder",
    test: (line) => {
      for (const m of line.matchAll(/text-\[(\d+(?:\.\d+)?)px\]/g)) {
        const px = Number(m[1]);
        if (!TYPE_LADDER.has(px)) return `text-[${m[1]}px]`;
      }
      return null;
    },
    why: "off the type ladder (24/18/15/14/13/12)",
  },
  {
    id: "palette",
    test: (line) => line.match(PALETTE)?.[0] ?? null,
    why: "raw Tailwind palette — use a design-system token",
  },
  {
    id: "tertiary-text",
    test: (line) =>
      line.includes("text-text-tertiary") ? "text-text-tertiary" : null,
    why: "tertiary is retired for text (4.2:1) — use text-text-secondary",
  },
];

let failures = 0;
const files = SCOPES.flatMap((pattern) =>
  globSync(pattern, { cwd: ROOT }).map((f) => join(ROOT, f)),
);

for (const file of files.sort()) {
  const lines = readFileSync(file, "utf8").split("\n");
  lines.forEach((line, i) => {
    if (line.includes("design-ladder-ignore")) return;
    for (const rule of RULES) {
      const hit = rule.test(line);
      if (hit) {
        console.error(
          `${relative(ROOT, file)}:${i + 1}  ${hit}  — ${rule.why}`,
        );
        failures++;
      }
    }
  });
}

if (failures > 0) {
  console.error(
    `\n${failures} design-ladder violation(s). See the ladder comment at the top of apps/web/src/lib/a2ui/a2ui.css.`,
  );
  process.exit(1);
}
console.log(`design ladders clean (${files.length} files)`);
