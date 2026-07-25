import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BudgetExhausted,
  MAX_COMPLETION_TOKENS,
  TASK_TOKEN_BUDGET,
  TokenBudget,
} from "./budget.ts";

describe("the shared budget", () => {
  it("matches the values the baseline runners already fixed", () => {
    // experiments/novelbench-run/run_nbrun.py: WRITER_TOKEN_CAP / TOKEN_BUDGET.
    // LongBench-Write uses the same 32,768, which is the official
    // evaluation/pred.py max_new_tokens. Ours are not free parameters.
    assert.equal(MAX_COMPLETION_TOKENS, 32_768);
    assert.equal(TASK_TOKEN_BUDGET, 3_000_000);
  });

  it("tracks spend and remaining room", () => {
    const b = new TokenBudget(1_000);
    b.charge(300);
    assert.equal(b.spent, 300);
    assert.equal(b.remaining, 700);
  });

  it("fails closed rather than warning", () => {
    const b = new TokenBudget(1_000);
    b.charge(900);
    // A soft warning produces runs that are over budget and still reported,
    // which is the worst of both.
    assert.throws(() => b.charge(200), BudgetExhausted);
  });

  it("says how far over it went, so the overspend is diagnosable", () => {
    const b = new TokenBudget(1_000);
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
    const b = new TokenBudget(1_000);
    b.charge(800);
    assert.equal(b.canAfford(150), true);
    assert.equal(b.canAfford(300), false);
    // Checking is optional; charging is not.
    assert.equal(b.spent, 800);
  });

  it("reports zero remaining rather than a negative number", () => {
    const b = new TokenBudget(100);
    try {
      b.charge(500);
    } catch {
      /* expected */
    }
    assert.equal(b.remaining, 0);
  });
});
