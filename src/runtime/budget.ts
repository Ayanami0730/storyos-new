/**
 * One token configuration, the same for every system in the table.
 *
 * There used to be two named profiles and a rule that their numbers must never
 * appear in one table. The rule held; the naming is what failed. Every run of ours
 * went out under the larger of the two, the name travelled in the summary where
 * nobody read it, and the comparison it invalidated got made anyway. A setting that
 * has to be remembered is a setting that will be forgotten, so there is now nothing
 * to choose.
 *
 * **32,768 tokens per call**, which is what every baseline uses:
 * `experiments/novelbench-run/run_nbrun.py` sets `WRITER_TOKEN_CAP = 32_768` and
 * passes it to every harness adapter, and it is also LongBench-Write's official
 * `evaluation/pred.py` `max_new_tokens`.
 *
 * **256,000 tokens of working context**, the point at which compaction intervenes.
 * The baselines do not cap input at all — they send what they have, and measured
 * they never come close — so this binds only on us and only to keep a resident
 * agent's transcript from growing without limit.
 *
 * **No total-task ceiling.** The baselines carry `TOKEN_BUDGET = 20_000_000`, and
 * its own comment calls it headroom: measured spend across every baseline cell is
 * 65k to 1.6M, so it never binds and total cost is established afterwards from the
 * ledger rather than enforced during the run. Ours is accounted the same way. What
 * remains is the obligation that came with that decision — every table carrying a
 * metric carries measured tokens beside it — which is the honest form of this
 * control and the only one that survived contact with a deadline.
 */

/** Per model call, reasoning tokens included. Matches every baseline. */
export const MAX_COMPLETION_TOKENS = 32_768;

/**
 * Working context ceiling: how much prompt an agent carries before compaction
 * intervenes. Below the model's real window on purpose — the window is what fits,
 * this is what we choose to spend.
 */
export const INPUT_CEILING = 256_000;

/**
 * What a run reports about its own spend.
 *
 * Kept as a record rather than a limit. `enforced` is false and stays false: the
 * number that matters is what a run cost, printed beside what it scored.
 */
export interface BudgetProfile {
  readonly id: "shared";
  readonly maxCompletionTokens: number;
  readonly inputCeiling: number;
  readonly minTaskBudget: number;
  readonly tokensPerTargetWord: number;
  readonly comparableWithBaselines: boolean;
  readonly rationale: string;
}

/** Retained only so an old summary still parses; nothing enforces it. */
export const TASK_TOKEN_BUDGET = 0;

export const SHARED_BUDGET: BudgetProfile = {
  id: "shared",
  maxCompletionTokens: MAX_COMPLETION_TOKENS,
  inputCeiling: INPUT_CEILING,
  // No task ceiling: spend is accounted after the fact, as it is for every
  // baseline. Zero here means "not enforced" everywhere downstream.
  minTaskBudget: 0,
  tokensPerTargetWord: 0,
  comparableWithBaselines: true,
  rationale:
    "32,768 tokens per call and 256,000 of working context, the same as every " +
    "baseline; total spend is measured and reported, never capped",
};

export const DEFAULT_PROFILE: BudgetProfile = SHARED_BUDGET;

/**
 * Kept so `--profile` on an old command line does not fail, and so an archived
 * summary naming a profile still resolves. There is one configuration now; asking
 * for another gets it, with a line in the log saying so.
 */
export function profileById(id: string): BudgetProfile {
  return SHARED_BUDGET;
}

/**
 * What the budget counts.
 *
 * `input + output`, matching every baseline runner
 * (`run_lbw.py`: `used_tokens += input_tokens + output_tokens`). It deliberately
 * excludes `cacheRead`, and the reason is a measurement rather than a
 * preference: on one run 7,490,529 of 8,369,537 provider-reported tokens —
 * 89.5% — were cache reads. A budget that charges those stops a run after
 * roughly a ninth of the work its comparators are allowed, which is not a
 * stricter comparison but a broken one.
 */

/** The per-task ceiling for a target length under a profile. */
export function taskBudgetFor(profile: BudgetProfile, targetWords: number): number {
  return Math.max(profile.minTaskBudget, Math.round(targetWords * profile.tokensPerTargetWord));
}

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
  readonly #enforce: boolean;

  /**
   * Counting by default, stopping only when asked.
   *
   * This used to enforce unconditionally, and that was our own invention rather
   * than any benchmark's rule. LongBench-Write defines **no** per-task token
   * budget — `evaluation/pred.py` caps a single decode at `max_new_tokens=32768`
   * and nothing else — and the baseline runner on that benchmark reached the
   * same conclusion independently and substituted a meter for the budget, with
   * the reason written out in `run_lbw.py`:
   *
   *   > enforcing it inverts what the benchmark measures: spending tokens to
   *   > reach a length target is the harness capability under test, so failing a
   *   > system for spending them scores it on our scaffolding instead of on its
   *   > writing. Consumption belongs in the cost column, after the fact.
   *
   * So every baseline row on that table was produced by a system nothing
   * stopped, while ours stopped itself — and on `lbw081` it stopped at two
   * scenes of four. That is not a stricter comparison, it is a different
   * experiment. The system should decide when it is finished; the ceiling is a
   * posterior statistic.
   *
   * Enforcement stays available because ConStory-style comparisons against a
   * declared allowance still want it, and because an unbounded loop with a bug
   * in it should have something to hit. It is opt-in and recorded.
   */
  constructor(budget: number = TASK_TOKEN_BUDGET, options: { readonly enforce?: boolean } = {}) {
    this.#budget = budget;
    this.#enforce = options.enforce ?? false;
  }

  /** True when the ceiling stops the run rather than merely being reported. */
  get enforced(): boolean {
    return this.#enforce;
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

  /** True once the ceiling has been passed and nothing further should be spent. */
  get exhausted(): boolean {
    return this.#spent > this.#budget;
  }

  /**
   * Refuse before spending, rather than reporting after.
   *
   * `charge` can only ever notice an overrun once the tokens are gone, because
   * a call's cost is not known until it returns. That made the "hard stop" soft
   * in the only way that matters: on the first run to hit it, the ceiling was
   * passed at 8.1M of 8M and the run went on to spend **12.0M** — the loop
   * caught the throw per scene, moved to the next scene, and paid for two more
   * plus a revision pass. A 2% overrun was reported as 50%.
   */
  assertNotExhausted(): void {
    if (this.#enforce && this.exhausted) throw new BudgetExhausted(this.#spent, this.#budget);
  }

  /** Charge a completed call. Throws once the total is past the ceiling. */
  charge(tokens: number): void {
    this.#spent += tokens;
    if (this.#enforce && this.#spent > this.#budget) {
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
