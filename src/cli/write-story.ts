/**
 * Write one story, end to end.
 *
 *   export PATH="$HOME/bin/node22/bin:$PATH"
 *   YS_KEY="$(cat ~/.config/ys/key)" node --experimental-strip-types \
 *     src/cli/write-story.ts --premise-file p.txt --target 4000 --out runs/demo
 *
 * An entry point and nothing else: parse the flags, create the project, hand off
 * to the harness, write out what happened. It used to be 690 lines because
 * agent assembly, tool wiring and summary rendering had all accumulated here,
 * and the cost was not only length — "which tools does the verifier have" was
 * answered by reading a conditional in a file about command-line flags. Those
 * three subjects now live in `runtime/assembly.ts`, `runtime/story.ts` and
 * `runtime/summary.ts`.
 *
 * A run is not complete unless its trace, cost and timing ledger is on disk —
 * including a run that failed. An aborted run with a ledger teaches us
 * something; one without teaches us nothing. So everything is written out even
 * on the unhappy path.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { selectSandbox } from "../sandbox/backends.ts";
import type { SandboxId } from "../sandbox/types.ts";
import { ArtifactStore } from "../runtime/artifacts.ts";
import { assembleHarness, defaultAgentsRoot, transcriptPath } from "../runtime/assembly.ts";
import { TokenBudget, profileById, taskBudgetFor } from "../runtime/budget.ts";
import type { ModelId } from "../runtime/gateway.ts";
import { writeStory } from "../runtime/story.ts";
import { buildSummary, committedOnDisk } from "../runtime/summary.ts";
import { CanonicalIndex } from "../index/commit.ts";
import { chapterFor, initialiseProject, paths, sceneIndexOf } from "../index/tree.ts";
import { checkReferences, renderReferenceReport } from "../verification/references.ts";

interface Args {
  premise: string;
  target: number;
  out: string;
  backbone: ModelId | null;
  maxRepairs: number;
  /** `parity` to sit in a table with the baselines, `generous` to find out if it works. */
  profile: string;
  /**
   * Where agent memory lives. Run-scoped by default, so a run is reproducible
   * from its premise alone. Point several runs at one directory and they
   * accumulate craft across stories — useful for iteration, and disqualifying
   * for a measured run, which is why it has to be asked for and is recorded.
   */
  memoryDir: string | null;
  /**
   * How the write gate is enforced. `none` reproduces every run before this
   * existed and is the control arm; `docker` is the strong claim.
   */
  sandbox: SandboxId;
  /**
   * Stop the run at the token ceiling instead of merely reporting it.
   *
   * Off by default, matching the baselines this system is compared with:
   * LongBench-Write defines no per-task budget and its runner counts without
   * stopping. Turning it on makes the run a different experiment, so it is
   * recorded in the summary.
   */
  enforceBudget: boolean;
}

async function parseArgs(argv: readonly string[]): Promise<Args> {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const has = (flag: string) => argv.includes(flag);
  const premiseFile = get("--premise-file");
  const premise = premiseFile ? await readFile(premiseFile, "utf8") : (get("--premise") ?? "");
  if (!premise.trim()) {
    throw new Error("--premise or --premise-file is required");
  }
  return {
    premise: premise.trim(),
    target: Number(get("--target") ?? 4000),
    out: get("--out") ?? `runs/story-${Date.now()}`,
    backbone: (get("--backbone") as ModelId | undefined) ?? null,
    maxRepairs: Number(get("--max-repairs") ?? 2),
    profile: get("--profile") ?? "parity",
    memoryDir: get("--memory-dir") ?? null,
    sandbox: (get("--sandbox") as SandboxId | undefined) ?? "none",
    enforceBudget: has("--enforce-budget"),
  };
}

const args = await parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out);
await mkdir(outDir, { recursive: true });

/** Progress on stderr, so a run that prints nothing for an hour is distinguishable from a hung one. */
const say = (line: string) =>
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

const projectRoot = path.join(outDir, "project");

/**
 * The partitioned tree, before anything runs.
 *
 * Created empty but complete, because a partition an agent cannot list is a
 * partition it will not fill: `relations/` did not exist in the first
 * implementation until something wrote a relation, and nothing ever did.
 */
// Created before the gate shuts, because the tree has to exist to be locked.
await new CanonicalIndex(projectRoot).init("genesis");
const { created } = await initialiseProject(projectRoot, {
  premise: args.premise,
  targetWords: args.target,
  agentsRoot: defaultAgentsRoot(),
});
say(`project initialised: ${created.length} paths under ${projectRoot}`);

/**
 * The write gate, shut before any agent exists.
 *
 * Then demonstrated rather than asserted: the backend attempts a forbidden
 * write and reports what stopped it, and that result goes in the summary. A
 * guarantee nobody checks is a comment, and a misconfigured mount should be
 * caught in the second before a run rather than inferred from a damaged index
 * an hour later.
 */
const selection = await selectSandbox(args.sandbox, projectRoot);
const sandbox = selection.backend;
if (selection.fellBackFrom) {
  // Loud, because a run that silently downgraded would report a guarantee it
  // does not have.
  say(
    `WARNING: --sandbox ${selection.fellBackFrom} was unavailable (${selection.reason}); ` +
      `running with ${sandbox.id} enforcement instead`,
  );
}
/**
 * Hand the tree back even when the run is killed.
 *
 * `local` locks the canonical partitions to 0o555, and `dispose` is what
 * unlocks them. Without this, Ctrl-C or a `kill` leaves a run directory its
 * owner cannot delete — which is a small thing that happens at exactly the
 * moment somebody is already annoyed.
 */
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    void sandbox.dispose().finally(() => process.exit(130));
  });
}

const gate = await sandbox.probe();
say(
  `write gate: ${sandbox.id} (${sandbox.enforcement}) — ` +
    `${gate.writeRefused ? "verified" : "NOT ENFORCED"}: ${gate.detail}`,
);

const index = new CanonicalIndex(projectRoot, {
  writeGate: (fn) => sandbox.withWriteAccess(fn),
});

const profile = profileById(args.profile);
const taskBudget = taskBudgetFor(profile, args.target);
const budget = new TokenBudget(taskBudget, { enforce: args.enforceBudget });
say(
  args.enforceBudget
    ? `token ceiling ENFORCED at ${taskBudget.toLocaleString()} — the run will stop there`
    : `token ceiling ${taskBudget.toLocaleString()} is reported, not enforced (--enforce-budget to stop at it)`,
);
const artifacts = new ArtifactStore(projectRoot);

/** One id per run, so transcripts from separate runs never interleave. */
const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

const harness = await assembleHarness({
  index,
  artifacts,
  projectRoot,
  agentsRoot: defaultAgentsRoot(),
  profile,
  budget,
  targetWords: args.target,
  backbone: args.backbone,
  memoryRoot: args.memoryDir ? path.resolve(args.memoryDir) : projectRoot,
  runId,
  sandbox,
  log: say,
  // The brief asked for raw conversation on disk, and its absence has already
  // cost real time: reconstructing what an agent was told in a finished run
  // required replaying the packet, which says nothing about what it replied.
  transcriptSink: async (role, messages, meta) => {
    const full = path.join(projectRoot, transcriptPath(role, runId));
    await mkdir(path.dirname(full), { recursive: true });
    const lines = messages.map((m) =>
      JSON.stringify({ at: new Date().toISOString(), txid: meta.txid, ...(m as object) }),
    );
    await appendFile(full, `${lines.join("\n")}\n`, "utf8");
  },
});

const started = Date.now();
let result: Awaited<ReturnType<typeof writeStory>> | null = null;
let fatal: string | null = null;

try {
  result = await writeStory({
    residents: harness.residents,
    index,
    artifacts,
    premise: args.premise,
    targetWords: args.target,
    maxRepairs: args.maxRepairs,
    log: say,
    build: harness.build,
    backfill: harness.backfill,
    prosePathFor: (sceneId) => paths.scene(chapterFor(sceneIndexOf(sceneId)), sceneId),
    planSink: harness.planState,
    bus: harness.bus,
    stage: harness.stage,
    onScene: (sceneId) => {
      harness.planState.committed.add(sceneId);
      harness.storyState.scenes.push(sceneId);
    },
  });
} catch (error) {
  fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

await sandbox.dispose();

const elapsedMs = Date.now() - started;
const onDisk = await committedOnDisk(projectRoot);

/**
 * Cross-partition links, checked at the end and reported either way.
 *
 * Zero tokens, and it sees the class of defect nothing else can: every file is
 * individually well-formed, so the damage only exists between them.
 */
const referenceReport = await checkReferences(projectRoot, {
  knownScenes: new Set(onDisk.scenes),
});
say(renderReferenceReport(referenceReport));

await writeFile(
  path.join(outDir, "ledger.jsonl"),
  harness.residents.ledger().map((e) => JSON.stringify(e)).join("\n") + "\n",
  "utf8",
);

const summary = await buildSummary({
  args,
  projectRoot,
  profile,
  taskBudget,
  budget,
  residents: harness.residents,
  harness,
  result,
  fatal,
  elapsedMs,
  onDisk,
  referenceReport,
  sandbox: {
    id: sandbox.id,
    enforcement: sandbox.enforcement,
    requested: args.sandbox,
    fell_back_from: selection.fellBackFrom,
    fallback_reason: selection.reason,
    gate_verified: gate.writeRefused,
    gate_detail: gate.detail,
  },
});

await writeFile(
  path.join(outDir, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
  "utf8",
);

if (result) {
  await writeFile(path.join(outDir, "story.md"), result.manuscript + "\n", "utf8");
  await writeFile(path.join(outDir, "plan.json"), JSON.stringify(result.plan, null, 2) + "\n", "utf8");
  await writeFile(path.join(outDir, "canon.json"), JSON.stringify(result.canon, null, 2) + "\n", "utf8");
  await writeFile(
    path.join(outDir, "revision.json"),
    JSON.stringify(result.revision, null, 2) + "\n",
    "utf8",
  );
}

console.log(JSON.stringify(summary, null, 2));
if (fatal) process.exitCode = 1;
