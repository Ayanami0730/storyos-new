/**
 * Run many tasks from one file, concurrently, and pick up where a kill left off.
 *
 *   export PATH="$HOME/bin/node22/bin:$PATH"
 *   YS_KEY="$(cat ~/.config/ys/key)" node --experimental-strip-types \
 *     src/cli/run-batch.ts --tasks tasks.jsonl --concurrency 3
 *
 * Run it again after a kill and it does the remaining tasks. Nothing needs to be
 * cleaned up first and nothing that finished is touched.
 *
 * ## Input
 *
 * One JSON object per line. `task_id` and `prompt` and `target_words` are the
 * whole requirement; `length` is accepted for `target_words` and `premise` for
 * `prompt`, so LongBench-Write's own `tasks.jsonl` works unchanged. Anything else
 * in the record is preserved into the run's `task.json`, which is what the trace
 * ingest and the scorer read.
 *
 *   {"task_id":"lbw081","prompt":"Write a first-person detective story…","length":2800}
 *   {"task_id":"lsb-40k-01","prompt":"…","target_words":40000,"flags":["--max-repairs","2"]}
 *
 * ## What it does not do
 *
 * It does not judge. Scoring is a separate step (`smoke/score-lbw.sh`) because a
 * judge is a different budget, a different failure mode, and something you often
 * want to redo without regenerating anything.
 */

import { spawn } from "node:child_process";
import { createWriteStream, existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  type BatchTask,
  type TaskState,
  BatchInputError,
  classify,
  planBatch,
  pool,
  parseTasks,
} from "../runtime/batch.ts";

const argv = process.argv.slice(2);
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(`--${name}`);

const tasksFile = flag("tasks");
if (!tasksFile) throw new Error("--tasks <file.jsonl> is required");

const repoRoot = path.resolve(import.meta.dirname, "../..");
const runsRoot = path.resolve(flag("runs") ?? path.join(repoRoot, "runs"));
const concurrency = Number(flag("concurrency") ?? 3);
/**
 * Seconds between starting one run and the next.
 *
 * Not politeness: four runs started in the same second put four planning calls on
 * the gateway at once, and the measured result is a burst of 429s that each run
 * then backs off from for minutes. The stagger costs less than the backoff.
 */
const staggerMs = Number(flag("stagger") ?? 20) * 1000;

/**
 * What actually limits concurrency here, and it is not this machine.
 *
 * Measured with five runs in flight: the host sat at a one-minute load of 10–60 on
 * 24 cores with every run network-bound, and the *gateway* began refusing. Two
 * distinct 429s, interleaved: per-region rate limits (`Your requests to gpt-5-mini
 * for gpt-5-mini in polandcentral have exceeded rate limit`, then swedencentral,
 * then eastus2) and a group-level one (`当前分组上游负载已饱和`). Two runs
 * accumulated 8 and 11 retry failures, the second reaching attempt 4 of 6 on a
 * single call, which converts concurrency straight into backoff.
 *
 * Nothing is lost when this happens — the retry schedule absorbs it and a
 * context-builder that finally fails degrades to the deterministic skeleton — but a
 * run bought with hours of wall clock gets a thinner packet for it. So the practical
 * ceiling is about four concurrent runs on this gateway, and the resource to budget
 * is the shared model quota, not CPU. When a long run matters, give it the quota
 * rather than starting more work beside it.
 */
const GATEWAY_CONCURRENCY_CEILING = 4;
const profile = flag("profile") ?? "generous";
const sandbox = flag("sandbox") ?? "docker";
const force = has("force");
const dryRun = has("dry-run");

const say = (line: string) =>
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

if (concurrency > GATEWAY_CONCURRENCY_CEILING) {
  say(
    `warning: concurrency ${concurrency} is above the measured gateway ceiling of ` +
      `${GATEWAY_CONCURRENCY_CEILING} — past it the 429s turn concurrency into backoff ` +
      `rather than throughput, and a long run beside them gets a thinner packet for it`,
  );
}

const tasks = parseTasks(await readFile(tasksFile, "utf8"));
say(`${tasks.length} task(s) from ${tasksFile}`);

/** Where one task's artefacts live. Same layout the single-task launcher uses. */
const dirFor = (task: BatchTask) => path.join(runsRoot, task.id);

async function readJson(p: string): Promise<Record<string, unknown> | null> {
  try {
    return JSON.parse(await readFile(p, "utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Whether the process that wrote a lock is still alive.
 *
 * `kill(pid, 0)` asks the kernel rather than trusting the file, which is the whole
 * point: a lock file outlives the process that made it, and a batch that treated
 * every lock as live would refuse to resume after exactly the event resume is for.
 * `EPERM` means a process exists that we may not signal, so it counts as alive.
 */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as { code?: string }).code === "EPERM";
  }
}

async function stateOf(task: BatchTask): Promise<TaskState> {
  const dir = dirFor(task);
  const summary = await readJson(path.join(dir, "run", "summary.json"));
  const lock = await readJson(path.join(dir, "run", "run.lock"));
  const lockPid = typeof lock?.pid === "number" ? lock.pid : null;
  // `HEAD` exists as soon as the index is initialised, which is before the first
  // scene and long before a summary. It is the earliest durable evidence that a
  // process worked in this directory, and after a graceful kill it is the only one.
  const hasIndex = existsSync(path.join(dir, "run", "project", "HEAD"));
  return classify({
    summary,
    lockPid,
    lockHolderAlive: lockPid !== null && alive(lockPid),
    hasIndex,
  });
}

const states = new Map<string, TaskState>();
for (const task of tasks) states.set(task.id, await stateOf(task));

const plan = planBatch(tasks, (task) => states.get(task.id)!, { force });

for (const { task, reason } of plan.skipped) say(`skip ${task.id} — ${reason}`);
say(
  `${plan.toRun.length} to run, ${plan.skipped.length} skipped` +
    (force ? " (--force: finished runs will be redone)" : ""),
);
for (const task of plan.toRun) {
  const state = states.get(task.id)!;
  say(
    `  ${task.id} (${task.targetWords} words)` +
      (state.kind === "incomplete" ? ` — retrying: ${state.why}` : ""),
  );
}

if (dryRun) {
  say("dry run: nothing launched");
  process.exit(0);
}
if (plan.toRun.length === 0) {
  say("nothing to do");
  process.exit(0);
}
if (!process.env.YS_KEY) throw new Error("YS_KEY is required");

/**
 * Children currently running, so a stop signal can be forwarded to them.
 *
 * Declared here rather than beside the signal handler because `runTask` writes to
 * it: keeping the declaration above its only writer means reordering the file
 * cannot silently produce a set that is read before it exists.
 */
const live = new Set<import("node:child_process").ChildProcess>();

interface Outcome {
  readonly id: string;
  readonly ok: boolean;
  /** Cut short by our own stop signal, as opposed to having failed on its own. */
  readonly interrupted: boolean;
  readonly exitCode: number | null;
  readonly detail: string;
  readonly seconds: number;
}

/**
 * Run one task as a child process.
 *
 * A child rather than an in-process call, for two reasons that both showed up in
 * practice: the harness installs a global gateway and holds per-run agent state,
 * so two runs in one process would share both; and a run that wedges can be killed
 * without taking the batch with it.
 */
async function runTask(task: BatchTask): Promise<Outcome> {
  const dir = dirFor(task);
  const state = states.get(task.id)!;
  const started = Date.now();

  /**
   * A retry starts from an empty directory.
   *
   * Resuming *inside* a run is not something the harness supports: the index is a
   * transaction log with a HEAD, and a second process appending to a half-written
   * one produces a manuscript that matches neither attempt. Deleting is therefore
   * the honest move, and it is only ever done to a directory already classified
   * incomplete — never to one with a live lock, and never to a finished run unless
   * `--force` said so.
   */
  if (state.kind === "incomplete" || (state.kind === "done" && force)) {
    await rm(path.join(dir, "run"), { recursive: true, force: true });
  }
  await mkdir(dir, { recursive: true });

  // The task record verbatim, so the scorer and the trace ingest read the same
  // numbers the run was given rather than a re-derivation of them.
  await writeFile(
    path.join(dir, "task.json"),
    JSON.stringify(task.raw, null, 2) + "\n",
    "utf8",
  );
  const premiseFile = path.join(dir, "premise.txt");
  await writeFile(premiseFile, `${task.prompt}\n`, "utf8");

  const args = [
    "--experimental-strip-types",
    path.join(repoRoot, "src/cli/write-story.ts"),
    "--premise-file",
    premiseFile,
    "--target",
    String(task.targetWords),
    "--out",
    path.join(dir, "run"),
    "--profile",
    profile,
    "--sandbox",
    sandbox,
    ...task.flags,
  ];

  const log = createWriteStream(path.join(dir, "run.log"), { flags: "w" });
  const child = spawn(process.execPath, args, {
    cwd: repoRoot,
    env: process.env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  // Registered before the first await, so a signal arriving immediately still
  // finds it.
  live.add(child);

  // The harness prints progress on stderr and the summary on stdout; both are
  // kept, because a run whose log was discarded teaches nothing when it fails.
  child.stderr.pipe(log, { end: false });
  const summaryChunks: Buffer[] = [];
  child.stdout.on("data", (chunk: Buffer) => summaryChunks.push(chunk));

  // The last progress line, so a failure report says where it got to rather than
  // only that it failed.
  let lastLine = "";
  child.stderr.on("data", (chunk: Buffer) => {
    const lines = chunk.toString("utf8").trimEnd().split("\n");
    lastLine = lines[lines.length - 1] ?? lastLine;
  });

  say(`${task.id} started (pid ${child.pid}, ${task.targetWords} words)`);

  const exitCode = await new Promise<number | null>((resolve) => {
    child.on("error", () => resolve(null));
    child.on("close", (code) => resolve(code));
  });
  live.delete(child);
  log.end();
  await writeFile(
    path.join(dir, "summary-stdout.json"),
    Buffer.concat(summaryChunks),
  ).catch(() => {});

  const seconds = Math.round((Date.now() - started) / 1000);
  const after = await stateOf(task);
  const ok = after.kind === "done";
  // A task that was cut short by our own stop signal did not fail — reporting it
  // as a failure would make every interrupted batch look like a broken one, and
  // the distinction is the difference between "investigate" and "run it again".
  const label = ok ? "done" : stopping ? "interrupted" : "FAILED";
  say(
    `${task.id} ${label} in ${seconds}s (exit ${exitCode})` +
      (after.kind === "done"
        ? ` — ${after.words} words, ${after.committed} scene(s)`
        : after.kind === "incomplete"
          ? ` — ${after.why}`
          : ""),
  );

  return {
    id: task.id,
    ok,
    interrupted: !ok && stopping,
    exitCode,
    seconds,
    detail: ok
      ? `${after.words} words, ${after.committed} scene(s)`
      : stopping
        ? "interrupted before it finished; rerun to continue"
        : `${after.kind}${after.kind === "incomplete" ? `: ${after.why}` : ""} — last log line: ${lastLine.slice(0, 200)}`,
  };
}

/**
 * Stop cleanly: start nothing new, and pass the signal on to what is running.
 *
 * The forwarding is the part that has to be explicit. A terminal Ctrl-C reaches
 * the children because the tty signals the whole foreground process group, but a
 * `kill -TERM <batch-pid>` reaches only this process — and a first version of this
 * file relied on the group and therefore hung: it refused to start new work and
 * then waited forever for children nothing had told to stop.
 *
 * Forwarding matters beyond tidiness. Each child releases its own run lock and
 * unlocks its tree as it exits, and that is precisely what lets the next
 * invocation resume instead of needing the directories cleaned up by hand.
 */
let stopping = false;
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    stopping = true;
    say(
      `${signal} — starting nothing new; forwarding to ${live.size} running task(s) so they ` +
        `release their locks`,
    );
    for (const child of live) child.kill(signal);
  });
}

const outcomes = await pool(plan.toRun, concurrency, staggerMs, async (task) => {
  if (stopping) {
    return {
      id: task.id,
      ok: false,
      interrupted: true,
      exitCode: null,
      seconds: 0,
      detail: "not attempted: the batch was interrupted",
    } satisfies Outcome;
  }
  return runTask(task);
});

const done = outcomes.filter((o) => o.ok);
const interrupted = outcomes.filter((o) => !o.ok && o.interrupted);
const failed = outcomes.filter((o) => !o.ok && !o.interrupted);

await writeFile(
  path.join(runsRoot, "batch-manifest.jsonl"),
  outcomes.map((o) => JSON.stringify({ at: new Date().toISOString(), ...o })).join("\n") + "\n",
  "utf8",
);

say("");
say(
  `batch finished: ${done.length} done, ${failed.length} failed, ` +
    `${interrupted.length} interrupted, ${plan.skipped.length} skipped`,
);
for (const o of failed) say(`  FAILED ${o.id} — ${o.detail}`);

const unfinished = failed.length + interrupted.length;
if (unfinished > 0) {
  say("");
  // The most useful thing to say after a partial batch is the command that
  // finishes it, because the answer is "the same one again".
  say(
    `rerun the same command to continue: ${unfinished} task(s) still to do, and the ` +
      `${done.length + plan.skipped.length} finished run(s) will be skipped`,
  );
}

// An interrupted batch is not a failed one — it exits 0 so a wrapper script that
// stops on error does not treat a deliberate Ctrl-C as a broken pipeline.
process.exitCode = failed.length > 0 ? 1 : 0;
