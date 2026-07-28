/**
 * Running many tasks from one file, resumably.
 *
 * The single-task launcher was enough while every run was something to watch.
 * It stopped being enough the moment a result needed more than one task: six runs
 * launched by hand is six chances to mistype a flag, and the one time that
 * happened tonight two processes ended up sharing an output directory and
 * interleaving their commits into one index — which produced a score for a
 * manuscript that no longer existed.
 *
 * So this file holds the parts of batching that can be wrong in a way tests can
 * catch: what a task record means, and whether a task still needs running. The
 * process spawning lives in `cli/run-batch.ts`, which is the part tests cannot
 * usefully say anything about.
 *
 * ## Why resume is decided from artefacts, not a progress file
 *
 * A batch that recorded its own progress would be a second source of truth about
 * what finished, and the two would disagree exactly when it mattered — after a
 * kill, which is the only time resume is used. The run directory already knows:
 * `summary.json` exists if and only if the harness reached the end, and
 * `run.lock` exists if and only if a process still holds the directory. Both are
 * written by the code that does the work.
 */

/**
 * One task, as it appears in the input file.
 *
 * Deliberately compatible with LongBench-Write's own `tasks.jsonl` — that file
 * uses `length` where this uses `target_words`, and accepting both means the
 * benchmark's file can be fed in unchanged. A conversion step is a place for a
 * task to be scored against a length it was never asked for, which has happened
 * in this project before.
 */
export interface BatchTask {
  /** Directory name under `runs/`, and the id every artefact is keyed on. */
  readonly id: string;
  readonly prompt: string;
  readonly targetWords: number;
  /** Everything else from the record, kept so it lands in `task.json` verbatim. */
  readonly raw: Readonly<Record<string, unknown>>;
  /** Extra `write-story` flags for this task alone. */
  readonly flags: readonly string[];
}

export class BatchInputError extends Error {}

/**
 * Parse one line of the input file.
 *
 * Every rejection names the line and what was wrong with it, because the failure
 * this prevents is a batch that runs 19 of 20 tasks and reports success.
 */
export function parseTask(line: string, lineNumber: number): BatchTask {
  let record: Record<string, unknown>;
  try {
    record = JSON.parse(line) as Record<string, unknown>;
  } catch (error) {
    throw new BatchInputError(
      `line ${lineNumber} is not valid JSON: ${error instanceof Error ? error.message : error}`,
    );
  }

  const id = record.task_id ?? record.id;
  if (typeof id !== "string" || !id.trim()) {
    throw new BatchInputError(`line ${lineNumber}: task_id (or id) must be a non-empty string`);
  }
  // A task id becomes a directory name, so anything that could escape it or
  // collide after normalisation is refused here rather than producing a run in a
  // surprising place.
  if (!/^[A-Za-z0-9._-]+$/.test(id)) {
    throw new BatchInputError(
      `line ${lineNumber}: task_id ${JSON.stringify(id)} must be letters, digits, dot, ` +
        `underscore or hyphen — it is used as a directory name`,
    );
  }

  const prompt = record.prompt ?? record.premise;
  if (typeof prompt !== "string" || !prompt.trim()) {
    throw new BatchInputError(
      `line ${lineNumber} (${id}): prompt (or premise) must be a non-empty string`,
    );
  }

  const target = record.target_words ?? record.length;
  if (typeof target !== "number" || !Number.isFinite(target) || target <= 0) {
    throw new BatchInputError(
      `line ${lineNumber} (${id}): target_words (or length) must be a positive number; got ` +
        `${JSON.stringify(target)}`,
    );
  }

  const flags = record.flags ?? [];
  if (!Array.isArray(flags) || flags.some((f) => typeof f !== "string")) {
    throw new BatchInputError(`line ${lineNumber} (${id}): flags must be an array of strings`);
  }

  return {
    id,
    prompt: prompt.trim(),
    targetWords: Math.round(target),
    raw: record,
    flags: flags as string[],
  };
}

export function parseTasks(text: string): readonly BatchTask[] {
  const tasks: BatchTask[] = [];
  const seen = new Set<string>();
  let lineNumber = 0;
  for (const line of text.split("\n")) {
    lineNumber += 1;
    if (!line.trim()) continue;
    const task = parseTask(line, lineNumber);
    if (seen.has(task.id)) {
      // Two records with one id would race for one directory, which is the exact
      // failure the run lock exists to catch — better to refuse the file.
      throw new BatchInputError(
        `line ${lineNumber}: duplicate task_id ${JSON.stringify(task.id)}; two tasks cannot ` +
          `share an output directory`,
      );
    }
    seen.add(task.id);
    tasks.push(task);
  }
  if (tasks.length === 0) throw new BatchInputError("no tasks in the input file");
  return tasks;
}

/** What the run directory says about a task, before anything is launched. */
export type TaskState =
  /** Finished with a manuscript. Skipped on resume. */
  | {
      readonly kind: "done";
      readonly words: number;
      readonly committed: number;
      /**
       * Set when the run finished but did not write the book it planned.
       *
       * Both 40,000-word runs came back `exit 0`, `fatal: null`, and the batch
       * logged `done — 28,186 words, 23 scene(s)`. Nine of thirty-two scenes had
       * aborted on a gateway 401 and the manuscript was 70% of its target, which
       * is the difference between a Table 1 cell and a truncated draft — and
       * nothing in the line you actually read said so.
       *
       * It stays `done` rather than becoming `incomplete`, because `incomplete`
       * means "delete the directory and start over" and a five-hour manuscript
       * is not something a status classifier should throw away on its own. The
       * label is loud; the decision to rerun stays with the caller.
       */
      readonly shortfall?: { readonly planned: number; readonly attainment: number };
    }
  /** Started and never finished, or finished with nothing. Rerun from scratch. */
  | { readonly kind: "incomplete"; readonly why: string }
  /** Another live process holds the directory. Left alone. */
  | { readonly kind: "held"; readonly pid: number }
  /** Never attempted. */
  | { readonly kind: "fresh" };

/**
 * Classify one task from what is on disk.
 *
 * Order matters. A live lock wins over everything, because the one thing that
 * must never happen is a second process in a directory somebody is working in. A
 * *stale* lock — the file is there and its process is gone — is the ordinary
 * aftermath of a kill and means the run is incomplete, not that it is protected;
 * treating it as protected would make a killed batch unresumable.
 */
export function classify(input: {
  readonly summary: Record<string, unknown> | null;
  readonly lockPid: number | null;
  readonly lockHolderAlive: boolean;
  /**
   * Whether an index already exists in the run directory.
   *
   * Needed because a *graceful* kill releases its lock, and the lock was the only
   * evidence that anything had ever started. Measured: the two 20k runs were
   * stopped with `SIGTERM`, each released its lock correctly, and the batch then
   * classified them `fresh` — never attempted — so `runTask` did not delete the
   * directory, and the rerun started on top of the abandoned attempt's index,
   * HEAD, transcripts and four committed scenes. It happened to come out clean
   * only because the new run reached scene 8 and overwrote the same paths; a
   * shorter second attempt would have left the earlier attempt's later scenes
   * behind, and `story.md` is assembled from what is on disk.
   *
   * A stale lock and a half-written index are the same fact — work started and
   * did not finish — and only one of them survives a clean shutdown.
   */
  readonly hasIndex: boolean;
}): TaskState {
  if (input.lockPid !== null && input.lockHolderAlive) {
    return { kind: "held", pid: input.lockPid };
  }
  if (input.summary === null) {
    if (input.lockPid !== null) {
      return {
        kind: "incomplete",
        why: `a stale lock from pid ${input.lockPid} and no summary — the run was killed`,
      };
    }
    return input.hasIndex
      ? {
          kind: "incomplete",
          why:
            "an index exists but no summary — a previous attempt started and did not finish. " +
            "Its lock is gone, which is what a graceful shutdown looks like, so the directory " +
            "is being rebuilt rather than appended to.",
        }
      : { kind: "fresh" };
  }

  const fatal = input.summary.fatal;
  if (typeof fatal === "string" && fatal.trim()) {
    return { kind: "incomplete", why: `the previous run ended fatally: ${fatal}` };
  }

  const committed = Number(input.summary.scenes_committed ?? 0);
  const words = Number(input.summary.words ?? 0);
  if (committed <= 0 || words <= 0) {
    return {
      kind: "incomplete",
      why: `the previous run produced ${committed} committed scene(s) and ${words} word(s)`,
    };
  }
  const planned = Number(input.summary.scenes_planned ?? 0);
  const attainment = Number(input.summary.attainment ?? 0);

  /**
   * A run can commit every scene it planned and still not have written the book.
   *
   * The scene-count rule below cannot see that, and something got through it:
   * three Chinese LongBench-Write cells reported `done — 1 scene(s) of 1 planned,
   * 20 words` against a 2,000-character target. The prose was fine; the harness
   * was counting Chinese by whitespace, so `attainment` read 0.01. The counter is
   * fixed in `words.ts`, and this is the check that would have caught it anyway —
   * because "delivered a tenth of the target" is a failure whatever the cause,
   * and a status classifier that only counts scenes will keep missing it.
   *
   * The floor is the same one the scene rule uses. Above it a short run is kept
   * and labelled, because a manuscript is not something to discard on a
   * classifier's own initiative; below it there is no manuscript to protect.
   */
  if (attainment > 0 && attainment < 0.5 && committed >= planned && planned > 0) {
    return {
      kind: "incomplete",
      why:
        `the previous run committed all ${planned} planned scene(s) but delivered ` +
        `${words} word(s) against its target — attainment ${attainment.toFixed(2)}, ` +
        `less than half, so it is being rerun rather than kept`,
    };
  }

  if (planned > 0 && committed < planned) {
    /**
     * Below half the book, "keep it and label it loudly" is the wrong trade.
     *
     * The gateway lost authentication for about forty minutes and three runs
     * came back at **1/17, 2/30 and 2/32 scenes — attainment 0.05 to 0.06** —
     * each with `fatal: null` and `exit 0`, because every scene after the first
     * aborted individually and no single scene failure is fatal. They landed in
     * `done`, which is the state the batch *skips*, so the next invocation would
     * have preserved three one-scene stubs and reported nothing to do.
     *
     * The argument for keeping a short run is that a five-hour manuscript is not
     * something a status classifier should throw away on its own. That argument
     * is about a manuscript. A story that delivered a twentieth of its scenes is
     * not one, and rerunning it is strictly better than keeping it.
     */
    if (committed * 2 < planned) {
      return {
        kind: "incomplete",
        why:
          `the previous run committed ${committed} of ${planned} planned scene(s) ` +
          `(attainment ${attainment.toFixed(2)}) — less than half the book, so it is being ` +
          `rerun rather than kept`,
      };
    }
    return { kind: "done", words, committed, shortfall: { planned, attainment } };
  }
  return { kind: "done", words, committed };
}

export interface BatchPlan {
  readonly toRun: readonly BatchTask[];
  readonly skipped: readonly {
    readonly task: BatchTask;
    readonly state: TaskState;
    readonly reason: string;
  }[];
}

/**
 * Decide what this invocation will run.
 *
 * `force` reruns tasks that already succeeded, which is what you want after a
 * change to the harness — and is destructive, so it is never the default: a
 * resume that silently rewrote finished runs would destroy the results it was
 * invoked to preserve.
 */
export function planBatch(
  tasks: readonly BatchTask[],
  stateOf: (task: BatchTask) => TaskState,
  options: { readonly force?: boolean } = {},
): BatchPlan {
  const toRun: BatchTask[] = [];
  const skipped: BatchPlan["skipped"] = [];

  for (const task of tasks) {
    const state = stateOf(task);
    if (state.kind === "held") {
      (skipped as BatchPlan["skipped"][number][]).push({
        task,
        state,
        reason: `another run holds this directory (pid ${state.pid})`,
      });
      continue;
    }
    if (state.kind === "done" && !options.force) {
      (skipped as BatchPlan["skipped"][number][]).push({
        task,
        state,
        reason: state.shortfall
          ? `finished SHORT and is being kept: ${state.words} words, ${state.committed} of ` +
            `${state.shortfall.planned} scene(s), attainment ` +
            `${state.shortfall.attainment.toFixed(2)} — rerun with --force to replace it`
          : `already finished: ${state.words} words, ${state.committed} scene(s)`,
      });
      continue;
    }
    toRun.push(task);
  }

  return { toRun, skipped };
}

/**
 * Run an async job over a list with a fixed number in flight.
 *
 * Written here rather than pulled in because the requirement is unusual in one
 * way: a stagger between starts. Launching four runs in the same second sends
 * four planning calls at once, and the measured consequence is a burst of 429s
 * that each run then spends minutes backing off from — so the pool is slower than
 * its own concurrency limit for the first minute of every batch.
 */
export async function pool<T, R>(
  items: readonly T[],
  limit: number,
  staggerMs: number,
  run: (item: T, index: number) => Promise<R>,
): Promise<readonly R[]> {
  const results = new Array<R>(items.length);
  let next = 0;

  const worker = async (slot: number): Promise<void> => {
    if (staggerMs > 0 && slot > 0) {
      await new Promise((resolve) => setTimeout(resolve, staggerMs * slot));
    }
    for (;;) {
      const mine = next++;
      if (mine >= items.length) return;
      results[mine] = await run(items[mine]!, mine);
    }
  };

  await Promise.all(
    Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, (_, slot) => worker(slot)),
  );
  return results;
}
