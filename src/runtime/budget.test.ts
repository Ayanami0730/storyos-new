import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BudgetExhausted,
  MAX_COMPLETION_TOKENS,
  TASK_TOKEN_BUDGET,
  TokenBudget,
  INPUT_CEILING,
  SHARED_BUDGET,
} from "./budget.ts";

describe("counting by default, stopping only when asked", () => {
  it("counts past the ceiling without stopping, which is what the baselines do", () => {
    // LongBench-Write defines no per-task budget, and its runner substitutes a
    // meter for one on purpose: "enforcing it inverts what the benchmark
    // measures... Consumption belongs in the cost column, after the fact." Every
    // baseline row was produced by a system nothing stopped, so ours enforcing a
    // ceiling made a different experiment — on lbw081 it stopped at two scenes
    // of four.
    const meter = new TokenBudget(100);
    assert.equal(meter.enforced, false);
    assert.doesNotThrow(() => meter.charge(500));
    assert.doesNotThrow(() => meter.assertNotExhausted());
    // Still reports the overrun truthfully; it just does not act on it.
    assert.equal(meter.spent, 500);
    assert.equal(meter.exhausted, true);
  });

  it("stops when enforcement is asked for, and says which mode it is in", () => {
    const enforced = new TokenBudget(100, { enforce: true });
    assert.equal(enforced.enforced, true);
    assert.throws(() => enforced.charge(500), BudgetExhausted);
  });
});

describe("the hard stop actually stopping", () => {
  it("refuses before spending once the ceiling is passed", () => {
    const budget = new TokenBudget(100, { enforce: true });
    assert.throws(() => budget.charge(150), BudgetExhausted);
    // `charge` can only ever notice an overrun after the tokens are gone. This
    // is the check that makes the stop hard, and it fires without spending
    // anything at all.
    assert.equal(budget.exhausted, true);
    assert.throws(() => budget.assertNotExhausted(), BudgetExhausted);
    assert.equal(budget.spent, 150);
  });

  it("stays quiet while there is room, including exactly at the ceiling", () => {
    const budget = new TokenBudget(100, { enforce: true });
    budget.charge(100);
    assert.equal(budget.exhausted, false);
    assert.doesNotThrow(() => budget.assertNotExhausted());
  });

  it("keeps reporting the real overrun rather than the ceiling", () => {
    // The first run to reach this passed 8M at 8.1M and went on to spend 12.0M,
    // because each scene caught the throw and the next scene tried anyway. What
    // the summary reports has to stay the truth even so.
    const budget = new TokenBudget(8_000_000, { enforce: true });
    assert.throws(() => budget.charge(8_149_485), BudgetExhausted);
    assert.equal(budget.spent, 8_149_485);
    assert.equal(budget.remaining, 0);
  });
});

describe("the shared budget", () => {
  it("matches the values the baseline runners already fixed", () => {
    // experiments/novelbench-run/run_nbrun.py: WRITER_TOKEN_CAP = 32_768, passed
    // to every harness adapter. LongBench-Write uses the same number as the
    // official evaluation/pred.py max_new_tokens. Not a free parameter.
    assert.equal(MAX_COMPLETION_TOKENS, 32_768);
    assert.equal(INPUT_CEILING, 256_000);
  });

  it("does not cap the per-task total, because no baseline does either", () => {
    // Their `TOKEN_BUDGET = 20_000_000` is headroom by its own comment, and
    // measured baseline spend is 65k to 1.6M — it never binds. Total cost is
    // established from the ledger afterwards and reported beside the score.
    assert.equal(TASK_TOKEN_BUDGET, 0);
    assert.equal(SHARED_BUDGET.minTaskBudget, 0);
    assert.equal(SHARED_BUDGET.tokensPerTargetWord, 0);
    assert.equal(SHARED_BUDGET.comparableWithBaselines, true);
  });

  it("tracks spend and remaining room", () => {
    const b = new TokenBudget(1_000, { enforce: true });
    b.charge(300);
    assert.equal(b.spent, 300);
    assert.equal(b.remaining, 700);
  });

  it("fails closed rather than warning", () => {
    const b = new TokenBudget(1_000, { enforce: true });
    b.charge(900);
    // A soft warning produces runs that are over budget and still reported,
    // which is the worst of both.
    assert.throws(() => b.charge(200), BudgetExhausted);
  });

  it("says how far over it went, so the overspend is diagnosable", () => {
    const b = new TokenBudget(1_000, { enforce: true });
    try {
      b.charge(1_500);
      assert.fail("should have thrown");
    } catch (error) {
      assert.ok(error instanceof BudgetExhausted);
      assert.equal(error.spent, 1_500);
      assert.equal(error.budget, 1_000);
      assert.match(error.message, /not comparable/);
    }
  });

  it("lets a caller stop at a scene boundary instead of dying mid-scene", () => {
    const b = new TokenBudget(1_000, { enforce: true });
    b.charge(800);
    assert.equal(b.canAfford(150), true);
    assert.equal(b.canAfford(300), false);
    // Checking is optional; charging is not.
    assert.equal(b.spent, 800);
  });

  it("reports zero remaining rather than a negative number", () => {
    const b = new TokenBudget(100, { enforce: true });
    try {
      b.charge(500);
    } catch {
      /* expected */
    }
    assert.equal(b.remaining, 0);
  });
});
