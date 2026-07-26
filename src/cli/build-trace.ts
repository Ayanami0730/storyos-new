/**
 * Ingest one run into a trace bundle the website can render.
 *
 *   YS_KEY="$(cat ~/.config/ys/key)" node --experimental-strip-types \
 *     src/cli/build-trace.ts \
 *       --run runs/lbw081/run \
 *       --task runs/lbw081/task.json \
 *       --judgement runs/lbw081/scoring/judgements/gpt-5.5/storyos-v3.jsonl \
 *       --baselines ~/work/longbench/experiments/longbench-write/judgements/gpt-5.5 \
 *       --out ~/popia_dmx/storyos-bench-viewer/public/data/traces
 *
 * `--no-translate` skips the Chinese pass, which is the only slow part and the
 * only part that costs anything.
 */

import { mkdir, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { buildBundle } from "../trace/bundle.ts";
import { countUnits, translateBundle } from "../trace/translate.ts";
import { VERSION } from "../version.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const runDir = flag("run");
if (!runDir) throw new Error("--run <dir> is required");
const outDir = path.resolve(
  flag("out") ?? path.join(process.env.HOME ?? ".", "popia_dmx/storyos-bench-viewer/public/data/traces"),
);
const concurrency = Number(flag("concurrency") ?? 100);

const say = (line: string) => console.error(`[trace] ${line}`);

/** Every other system's judgements for the same task, for context. */
async function baselineFiles(dir: string | undefined) {
  if (!dir) return [];
  const root = path.resolve(dir);
  const files = await readdir(root).catch(() => []);
  return files
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => ({ system: f.replace(/\.jsonl$/, ""), file: path.join(root, f) }));
}

let bundle = await buildBundle({
  runDir,
  ...(flag("task") ? { taskFile: path.resolve(flag("task")!) } : {}),
  ...(flag("judgement") ? { judgementFile: path.resolve(flag("judgement")!) } : {}),
  baselineJudgements: await baselineFiles(flag("baselines")),
});

/**
 * Stamp a version onto a run that predates the stamp — explicitly, and saying so.
 *
 * A run finished before `harness_version` existed in the summary reads back as
 * `unknown`, which is correct and unhelpful. Overriding it is legitimate only
 * when you know which build produced it, so the flag is opt-in and the bundle
 * records that the version was *asserted* rather than read. A silently
 * backfilled version is worse than an absent one: it is the field a later
 * reader trusts most and can least verify.
 */
const asserted = flag("version");
if (asserted) {
  if (bundle.harnessVersion !== "unknown" && bundle.harnessVersion !== asserted) {
    throw new Error(
      `the run reports version ${bundle.harnessVersion} but --version says ${asserted}. ` +
        `Refusing to overwrite a version the run recorded itself.`,
    );
  }
  bundle = {
    ...bundle,
    harnessVersion: asserted,
    versionAssertedByIngest: true,
  };
  say(
    `version ${asserted} asserted at ingest (the run itself recorded none); ` +
      `recorded as asserted, not read`,
  );
}

say(
  `built ${bundle.runId} — version ${bundle.harnessVersion}, ${bundle.scenes.length} scene(s), ` +
    `${bundle.scenes.reduce((n, s) => n + s.calls.length, 0)} model call(s), ` +
    `${bundle.memory.length} memory topic(s)`,
);
if (bundle.score) {
  say(
    `score: S-bar ${bundle.score.sBar.toFixed(1)} (S_l ${bundle.score.sLength.toFixed(1)}, ` +
      `S_q ${bundle.score.sQualityRaw.toFixed(2)}), ${bundle.score.baselines.length} baseline row(s)`,
  );
}

if (has("no-translate")) {
  say(`skipping translation (${countUnits(bundle)} unit(s) would have been sent)`);
} else {
  const apiKey = process.env.YS_KEY;
  if (!apiKey) throw new Error("YS_KEY is required to translate; pass --no-translate to skip");
  const total = countUnits(bundle);
  say(`translating ${total} unit(s) at concurrency ${concurrency} with deepseek-v4-pro`);
  const started = Date.now();
  bundle = await translateBundle(bundle, {
    apiKey,
    concurrency,
    onGlossary: (g) =>
      say(
        g
          ? `pinned ${g.split("\n").length} name(s): ${g.replace(/\n/g, " · ").slice(0, 200)}`
          : "no glossary resolved; names may render inconsistently across sections",
      ),
    onProgress: (done, all) => {
      // Every tenth, so a long ingest shows progress without flooding the log.
      if (done % 10 === 0 || done === all) say(`  ${done}/${all}`);
    },
  });
  const missing = countUnits(bundle) - total;
  say(
    `translated in ${Math.round((Date.now() - started) / 1000)}s` +
      (missing ? ` (${missing} unit(s) left in English)` : ""),
  );
}

await mkdir(outDir, { recursive: true });
const stem = bundle.task?.id ? `${bundle.task.id}-${bundle.harnessVersion}` : bundle.runId;
const outPath = path.join(outDir, `${stem}.json`);
await writeFile(outPath, JSON.stringify(bundle, null, 2) + "\n", "utf8");

/**
 * The index the website lists from.
 *
 * Rebuilt from the directory rather than appended to, so a deleted bundle
 * disappears from the index instead of becoming a link to nothing.
 */
const bundles = (await readdir(outDir))
  .filter((f) => f.endsWith(".json") && f !== "index.json")
  .sort();
const entries: Record<string, unknown>[] = [];
for (const file of bundles) {
  const b = JSON.parse(
    await (await import("node:fs/promises")).readFile(path.join(outDir, file), "utf8"),
  ) as typeof bundle;
  entries.push({
    slug: file.replace(/\.json$/, ""),
    runId: b.runId,
    harnessVersion: b.harnessVersion,
    startedAt: b.startedAt,
    task: b.task ? { id: b.task.id, benchmark: b.task.benchmark, requiredWords: b.task.requiredWords } : null,
    words: b.headline.words,
    scenesCommitted: b.headline.scenes_committed,
    scenesPlanned: b.headline.scenes_planned,
    sBar: b.score?.sBar ?? null,
    tokensBillable: b.headline.tokens_billable,
    usd: b.cost.totalUsd,
    elapsedMs: b.headline.elapsed_ms,
    translated: b.translation !== null,
  });
}
await writeFile(
  path.join(outDir, "index.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), currentVersion: VERSION, traces: entries }, null, 2) + "\n",
  "utf8",
);

say(`wrote ${outPath}`);
say(`index now lists ${entries.length} trace(s)`);
