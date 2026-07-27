/**
 * Fill the baseline comparison back into bundles that were built without it.
 *
 *   node --experimental-strip-types src/cli/patch-baselines.ts \
 *     --traces ~/popia_dmx/storyos-bench-viewer/public/data/traces
 *
 * ## Why a patch and not a rebuild
 *
 * `score.baselines` is the only part of a bundle that is pure derived data: read
 * from frozen judgement files, never translated, the same however often it is
 * computed. Everything else — prompts, prose, tool results, the project tree — is
 * either translated or read from a run directory, and rebuilding it means paying
 * the translation again.
 *
 * That distinction had a price attached. When the evaluation repo moved with the
 * lane merge, six bundles were ingested with an unresolvable `--baselines` path
 * and silently lost their comparison tables; rebuilding them would have been an
 * hour of re-translation to restore a field that costs milliseconds to read. So
 * this exists, and it deliberately does exactly one thing.
 *
 * It calls the same `readBaselines` the ingest calls. A second copy of that
 * arithmetic would drift, and the disagreement would be a results table nobody
 * could reproduce.
 */

import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { readBaselines } from "../trace/bundle.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

const tracesDir = path.resolve(
  flag("traces") ??
    path.join(process.env.HOME ?? ".", "popia_dmx/storyos-bench-viewer/public/data/traces"),
);
const lbwRoot = path.resolve(
  flag("lbw") ?? path.join(process.env.HOME ?? ".", "storyos/experiments/longbench-write"),
);
const judgementsDir = path.join(lbwRoot, "judgements/gpt-5.5");

const say = (line: string) => console.error(`[patch] ${line}`);

const judgementFiles = (await readdir(judgementsDir).catch((error: unknown) => {
  throw new Error(
    `cannot read ${judgementsDir} (${error instanceof Error ? error.message : error}); ` +
      `pass --lbw <longbench-write dir>`,
  );
}))
  .filter((f) => f.endsWith(".jsonl"))
  .map((f) => ({ system: f.replace(/\.jsonl$/, ""), file: path.join(judgementsDir, f) }));

if (judgementFiles.length === 0) throw new Error(`no .jsonl judgements in ${judgementsDir}`);
say(`${judgementFiles.length} baseline system(s) from ${judgementsDir}`);

let patched = 0;
let skipped = 0;

for (const name of (await readdir(tracesDir)).sort()) {
  if (!name.endsWith(".json") || name === "index.json") continue;
  const full = path.join(tracesDir, name);
  const bundle = JSON.parse(await readFile(full, "utf8")) as Record<string, any>;

  // A bundle with no score has nothing to compare against; leave it alone rather
  // than inventing a `score` object it never had.
  if (!bundle.score) {
    say(`skip ${name} — no score in this bundle`);
    skipped += 1;
    continue;
  }
  const taskId: string | undefined = bundle.task?.id;
  if (!taskId) {
    say(`skip ${name} — no task id, so there is nothing to match baselines on`);
    skipped += 1;
    continue;
  }

  const baselines = await readBaselines(judgementFiles, taskId);
  if (baselines.length === 0) {
    say(`skip ${name} — no baseline rows for ${taskId}`);
    skipped += 1;
    continue;
  }

  const before = bundle.score.baselines?.length ?? 0;
  bundle.score.baselines = baselines;
  await writeFile(full, JSON.stringify(bundle, null, 2) + "\n", "utf8");
  say(`${name} — ${taskId}: ${before} → ${baselines.length} baseline row(s)`);
  patched += 1;
}

say(`patched ${patched}, skipped ${skipped}`);
