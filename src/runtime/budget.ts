/**
 * The token budget every system is held to, ours included.
 *
 * These numbers are not ours to choose. The reproduction runners already fixed
 * them for the baselines — `experiments/novelbench-run/run_nbrun.py` sets
 * `WRITER_TOKEN_CAP = 32_768` per call and `TOKEN_BUDGET = 3_000_000` per task,
 * and LongBench-Write uses the same 32,768 (it is the official
 * `evaluation/pred.py` `max_new_tokens`). A harness that quietly allowed itself
 * a larger per-call output or an unbounded total would be winning on budget
 * rather than on architecture, and the difference would be invisible in the
 * results table.
 *
 * The per-task ceiling is the more important of the two for us specifically.
 * Our design spends tokens the baselines do not — a verification pass and up to
 * k repair rounds per scene — so "did the extra spend pay for itself" is a
 * question the paper has to answer, and it can only be answered against a cap
 * everyone shares.
 */

/** Per model call. Matches the baselines and LongBench-Write's official value. */
export const MAX_COMPLETION_TOKENS = 32_768;

/** Per task, across every agent and every retry. */
export const TASK_TOKEN_BUDGET = 3_000_000;

export class BudgetExhausted extends Error {
  readonly spent: number;
  readonly budget: number;
  constructor(spent: number, budget: number) {
    super(
      `per-task token budget exhausted: ${spent} of ${budget} spent. This is a hard ` +
        `stop, not a warning — a run that overspends its budget is not comparable ` +
        `with the baselines that did not.`,
    );
    this.name = "BudgetExhausted";
    this.spent = spent;
    this.budget = budget;
  }
}

/**
 * A running total with a hard stop.
 *
 * Fails closed on purpose, matching `TokenBudgetBackend` on the baseline side:
 * a soft warning produces runs that are over budget and still reported, which
 * is the worst of both.
 */
export class TokenBudget {
  #spent = 0;
  readonly #budget: number;

  constructor(budget: number = TASK_TOKEN_BUDGET) {
    this.#budget = budget;
  }

  get spent(): number {
    return this.#spent;
  }

  get remaining(): number {
    return Math.max(0, this.#budget - this.#spent);
  }

  get budget(): number {
    return this.#budget;
  }

  /** Charge a completed call. Throws once the total is past the ceiling. */
  charge(tokens: number): void {
    this.#spent += tokens;
    if (this.#spent > this.#budget) {
      throw new BudgetExhausted(this.#spent, this.#budget);
    }
  }

  /**
   * Whether there is room for another call of roughly this size.
   *
   * Lets a caller stop cleanly at a scene boundary instead of dying mid-scene
   * and leaving a transaction open. Checking is optional; charging is not.
   */
  canAfford(estimate: number): boolean {
    return this.#spent + estimate <= this.#budget;
  }
}
