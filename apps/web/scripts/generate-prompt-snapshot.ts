/**
 * generate-prompt-snapshot.ts — refresh the bundled prompt-library snapshot.
 *
 * Fetches + parses GitHub prompt collections through the SAME
 * loaders the app uses at runtime (prompt-library-data.loadAllSources) and
 * writes src/lib/canvas/prompt-library-snapshot.json.
 * The snapshot is the built-in baseline the dialog shows instantly / offline;
 * live data replaces it via the background refresh.
 *
 * Run from repo root:
 *   pnpm --filter @nexu/web generate:prompt-snapshot
 *   pnpm --filter @nexu/web generate:prompt-snapshot --source freestylefly-gpt-image-2
 *
 * The snapshot carries the full text dataset — covers stay remote
 * URLs (served via the controller cover cache at runtime).
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  type LibraryPrompt,
  loadAllSources,
  promptCategories,
} from "../src/lib/canvas/prompt-library-data";

const outPath = resolve(
  dirname(fileURLToPath(import.meta.url)),
  "../src/lib/canvas/prompt-library-snapshot.json",
);

const args = process.argv.slice(2);
const requested =
  args.length === 2 && args[0] === "--source" ? args[1] : undefined;
if (
  args.length > 0 &&
  (!requested || !promptCategories().includes(requested))
) {
  throw new Error(
    `Usage: generate:prompt-snapshot [--source ${promptCategories().join("|")}]`,
  );
}
const categories = requested ? [requested] : promptCategories();
const items = await loadAllSources({ categories, fallbackToSnapshot: false });
const missing = categories.filter(
  (category) => !items.some((item) => item.category === category),
);
if (missing.length > 0)
  throw new Error(
    `Sources returned no prompts: ${missing.join(", ")}. Snapshot NOT updated.`,
  );

const previous = JSON.parse(readFileSync(outPath, "utf8")) as LibraryPrompt[];
const snapshot = promptCategories().flatMap((category) =>
  (categories.includes(category) ? items : previous).filter(
    (item) => item.category === category,
  ),
);

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`);

const kb = Math.round(JSON.stringify(snapshot).length / 1024);
console.log(
  `Snapshot written: ${snapshot.length} prompts across ${promptCategories().length} sources (${kb} KB) → ${outPath}`,
);
