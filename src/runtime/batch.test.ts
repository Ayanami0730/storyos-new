import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BatchInputError,
  type BatchTask,
  classify,
  parseTask,
  parseTasks,
  planBatch,
  pool,
} from "./batch.ts";

const line = (record: Record<string, unknown>) => JSON.stringify(record);

describe("the task schema", () => {
  it("takes the minimum three fields", () => {
    const task = parseTask(line({ task_id: "t1", prompt: "write it", target_words: 2800 }), 1);
    assert.equal(task.id, "t1");
    assert.equal(task.prompt, "write it");
    assert.equal(task.targetWords, 2800);
  });

  /**
   * The aliases are the point of the schema, not a convenience. LongBench-Write's
   * own `tasks.jsonl` uses `length`, and requiring a conversion step introduces a
   * place for a task to be run against a length it was never asked for — which has
   * happened in this project before, and cost a whole run's length score.
   */
  it("reads LongBench-Write's own records unchanged", () => {
    const task = parseTask(
      line({
        bucket: "[2k,4k)",
        index: 81,
        language: "en",
        length: 2800,
        prompt: "Write a first-person detective story",
        task_id: "lbw081",
        type: "Literature and Creative Writing",
      }),
      1,
    );
    assert.equal(task.id, "lbw081");
    assert.equal(task.targetWords, 2800);
    // The rest of the record survives, because `task.json` is what the scorer and
    // the trace ingest read and they need the bucket and the type.
    assert.equal(task.raw.bucket, "[2k,4k)");
    assert.equal(task.raw.type, "Literature and Creative Writing");
  });

  it("accepts id/premise as the other spelling of each", () => {
    const task = parseTask(line({ id: "t2", premise: "a premise", target_words: 500 }), 1);
    assert.equal(task.id, "t2");
    assert.equal(task.prompt, "a premise");
  });

  it("carries per-task flags", () => {
    const task = parseTask(
      line({ task_id: "t3", prompt: "p", target_words: 500, flags: ["--max-repairs", "2"] }),
      1,
    );
    assert.deepEqual(task.flags, ["--max-repairs", "2"]);
  });

  describe("refusals", () => {
    /**
     * Every rejection names the line, because the failure being prevented is a
     * batch that runs 19 of 20 tasks and reports success.
     */
    const rejects = (record: unknown, pattern: RegExp) => {
      assert.throws(() => parseTask(typeof record === "string" ? record : JSON.stringify(record), 7), (error: unknown) => {
        assert.ok(error instanceof BatchInputError);
        assert.match(error.message, /line 7/);
        assert.match(error.message, pattern);
        return true;
      });
    };

    it("refuses a missing or empty id", () => {
      rejects({ prompt: "p", target_words: 500 }, /task_id/);
      rejects({ task_id: "  ", prompt: "p", target_words: 500 }, /task_id/);
    });

    it("refuses an id that could escape its directory", () => {
      // The id becomes a directory name under runs/, so `../` in one would write
      // outside the run tree entirely.
      rejects({ task_id: "../etc", prompt: "p", target_words: 500 }, /directory name/);
      rejects({ task_id: "a/b", prompt: "p", target_words: 500 }, /directory name/);
    });

    it("refuses a missing prompt or a non-positive target", () => {
      rejects({ task_id: "t", target_words: 500 }, /prompt/);
      rejects({ task_id: "t", prompt: "p", target_words: 0 }, /target_words/);
      rejects({ task_id: "t", prompt: "p", target_words: "2800" }, /target_words/);
    });

    it("refuses malformed JSON with the line number", () => {
      rejects("{not json", /not valid JSON/);
    });

    it("refuses two tasks sharing an id, because they would share a directory", () => {
      const text = [
        line({ task_id: "same", prompt: "a", target_words: 500 }),
        line({ task_id: "same", prompt: "b", target_words: 500 }),
      ].join("\n");
      assert.throws(() => parseTasks(text), /duplicate task_id/);
    });

    it("refuses an empty file rather than reporting a successful batch of nothing", () => {
      assert.throws(() => parseTasks("\n\n  \n"), /no tasks/);
    });
  });

  it("ignores blank lines", () => {
    const text = `\n${line({ task_id: "a", prompt: "p", target_words: 1 })}\n\n${line({ task_id: "b", prompt: "p", target_words: 1 })}\n`;
    assert.deepEqual(
      parseTasks(text).map((t) => t.id),
      ["a", "b"],
    );
  });
});

describe("classifying what is on disk", () => {
  it("calls a finished run done", () => {
    const state = classify({
      summary: { fatal: null, scenes_committed: 4, words: 3046 },
      lockPid: null,
      lockHolderAlive: false,
      hasIndex: true,
    });
    assert.deepEqual(state, { kind: "done", words: 3046, committed: 4 });
  });

  it("calls an untouched directory fresh", () => {
    assert.deepEqual(
      classify({ summary: null, lockPid: null, lockHolderAlive: false, hasIndex: false }),
      { kind: "fresh" },
    );
  });

  /**
   * The case resume exists for. A killed run leaves its lock behind, and treating
   * a lock as authoritative would make the batch refuse to resume after exactly
   * the event that makes resuming necessary.
   */
  it("treats a stale lock with no summary as incomplete, not as protected", () => {
    const state = classify({ summary: null, lockPid: 4242, lockHolderAlive: false, hasIndex: false });
    assert.equal(state.kind, "incomplete");
    assert.match((state as { why: string }).why, /killed/);
  });

  /**
   * The gap the stale-lock case above does not cover, and it cost us a run.
   *
   * A *graceful* kill releases its lock — that is the shutdown path working — so
   * after `SIGTERM` there is no lock and no summary, and the only remaining
   * evidence that anything happened is the index on disk. Both 20k runs were
   * stopped this way, both released their locks correctly, and the batch then
   * classified them `fresh`: never attempted. `runTask` only deletes a directory
   * it believes is incomplete, so the rerun started on top of the abandoned
   * attempt's index, HEAD, transcripts and four committed scenes. It came out
   * clean only because the second attempt went further and overwrote the same
   * paths; a shorter one would have left the first attempt's later scenes on disk,
   * and `story.md` is assembled from what is on disk.
   */
  it("treats a released lock with an index and no summary as incomplete", () => {
    const state = classify({
      summary: null,
      lockPid: null,
      lockHolderAlive: false,
      hasIndex: true,
    });
    assert.equal(state.kind, "incomplete");
    assert.match((state as { why: string }).why, /graceful shutdown/);
  });

  it("still calls a directory with no index at all fresh", () => {
    assert.deepEqual(
      classify({ summary: null, lockPid: null, lockHolderAlive: false, hasIndex: false }),
      { kind: "fresh" },
    );
  });

  it("leaves a directory alone while a live process holds it", () => {
    // This must win over every other signal: a second process in a directory
    // somebody is working in interleaves two transaction logs into one index.
    const state = classify({
      summary: { fatal: null, scenes_committed: 4, words: 3046 },
      lockPid: 999,
      lockHolderAlive: true,
      hasIndex: true,
    });
    assert.deepEqual(state, { kind: "held", pid: 999 });
  });

  it("reruns a fatal run", () => {
    const state = classify({
      summary: { fatal: "Error: gateway unreachable", scenes_committed: 0, words: 0 },
      lockPid: null,
      lockHolderAlive: false,
      hasIndex: true,
    });
    assert.equal(state.kind, "incomplete");
    assert.match((state as { why: string }).why, /ended fatally/);
  });

  /**
   * A summary exists even when a run produced nothing — the harness writes one on
   * the unhappy path on purpose. So "the file is there" cannot be the test for
   * done, or a run that committed no scenes would be skipped forever.
   */
  it("reruns a run that finished cleanly with no manuscript", () => {
    const state = classify({
      summary: { fatal: null, scenes_committed: 0, words: 0 },
      lockPid: null,
      lockHolderAlive: false,
      hasIndex: true,
    });
    assert.equal(state.kind, "incomplete");
    assert.match((state as { why: string }).why, /0 committed scene/);
  });

  /**
   * The 40,000-word runs, exactly as they came back: `exit 0`, `fatal: null`, and
   * a third of the book missing. Nine scenes had aborted on a gateway 401 and the
   * batch logged `done — 28,186 words, 23 scene(s)`, which reads like a success
   * and was the number a Table 1 cell would have been built from.
   */
  it("marks a run that finished without writing the book it planned", () => {
    const state = classify({
      summary: {
        fatal: null,
        scenes_committed: 23,
        scenes_planned: 32,
        words: 28186,
        attainment: 0.705,
      },
      lockPid: null,
      lockHolderAlive: false,
      hasIndex: true,
    });
    assert.deepEqual(state, {
      kind: "done",
      words: 28186,
      committed: 23,
      shortfall: { planned: 32, attainment: 0.705 },
    });
  });

  /**
   * It stays `done`, because `incomplete` means "delete the directory and start
   * over" and a five-hour manuscript is not something a status classifier should
   * discard on its own. The label is loud; the rerun is the caller's call.
   */
  it("does not throw away a short run by calling it incomplete", () => {
    const state = classify({
      summary: { fatal: null, scenes_committed: 23, scenes_planned: 32, words: 28186 },
      lockPid: null,
      lockHolderAlive: false,
      hasIndex: true,
    });
    assert.equal(state.kind, "done");
  });

  /**
   * What a forty-minute gateway auth outage produced: three runs at 1/17, 2/30
   * and 2/32 scenes, each `fatal: null` and `exit 0` because no individual scene
   * failure is fatal. Left in `done` they would be silently skipped by the next
   * batch, which is how three one-scene stubs become "nothing to do".
   */
  it("reruns a run that delivered less than half the book", () => {
    const state = classify({
      summary: {
        fatal: null,
        scenes_committed: 1,
        scenes_planned: 17,
        words: 1211,
        attainment: 0.06,
      },
      lockPid: null,
      lockHolderAlive: false,
      hasIndex: true,
    });
    assert.equal(state.kind, "incomplete");
    assert.match((state as { why: string }).why, /less than half the book/);
  });

  it("leaves a run that wrote every scene unmarked", () => {
    const state = classify({
      summary: {
        fatal: null,
        scenes_committed: 32,
        scenes_planned: 32,
        words: 40100,
        attainment: 1.0,
      },
      lockPid: null,
      lockHolderAlive: false,
      hasIndex: true,
    });
    assert.deepEqual(state, { kind: "done", words: 40100, committed: 32 });
  });
});

describe("planning a batch", () => {
  const task = (id: string): BatchTask => ({
    id,
    prompt: "p",
    targetWords: 500,
    raw: {},
    flags: [],
  });
  const tasks = [task("a"), task("b"), task("c"), task("d")];
  const states: Record<string, ReturnType<typeof classify>> = {
    a: { kind: "done", words: 500, committed: 1 },
    b: { kind: "incomplete", why: "killed" },
    c: { kind: "fresh" },
    d: { kind: "held", pid: 7 },
  };

  it("runs the unfinished ones and skips the rest", () => {
    const plan = planBatch(tasks, (t) => states[t.id]!);
    assert.deepEqual(
      plan.toRun.map((t) => t.id),
      ["b", "c"],
    );
    assert.deepEqual(
      plan.skipped.map((s) => s.task.id),
      ["a", "d"],
    );
    assert.match(plan.skipped[0]!.reason, /already finished/);
    assert.match(plan.skipped[1]!.reason, /pid 7/);
  });

  it("redoes finished runs only when forced", () => {
    const plan = planBatch(tasks, (t) => states[t.id]!, { force: true });
    assert.deepEqual(
      plan.toRun.map((t) => t.id),
      ["a", "b", "c"],
    );
  });

  it("never touches a held directory, even with --force", () => {
    // Forcing is about redoing your own finished work, not about evicting a run
    // that is in progress.
    const plan = planBatch(tasks, (t) => states[t.id]!, { force: true });
    assert.ok(!plan.toRun.some((t) => t.id === "d"));
  });
});

describe("the pool", () => {
  it("never exceeds its concurrency", async () => {
    let inFlight = 0;
    let peak = 0;
    await pool([1, 2, 3, 4, 5, 6, 7, 8], 3, 0, async (item) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return item;
    });
    assert.equal(peak, 3);
  });

  it("returns results in input order, not completion order", async () => {
    // The manifest is read next to the input file, so a reordered result list
    // would make a batch report look like it ran different tasks than it did.
    const results = await pool([30, 5, 20, 1], 4, 0, async (ms) => {
      await new Promise((r) => setTimeout(r, ms));
      return ms;
    });
    assert.deepEqual(results, [30, 5, 20, 1]);
  });

  it("runs everything even when there are more items than slots", async () => {
    const seen: number[] = [];
    await pool([1, 2, 3, 4, 5], 2, 0, async (item) => {
      seen.push(item);
      return item;
    });
    assert.deepEqual(seen.sort(), [1, 2, 3, 4, 5]);
  });

  it("does not stagger the first slot, so a single task starts immediately", async () => {
    const started = Date.now();
    await pool([1], 3, 5_000, async (item) => item);
    assert.ok(Date.now() - started < 1_000, "one task must not wait for a stagger");
  });
});
