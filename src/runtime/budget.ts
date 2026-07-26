/**
 * The token budget a run is held to, and the two profiles it can be held to.
 *
 * There are two different questions and they need two different settings, which
 * is why this file has profiles instead of constants.
 *
 * **"Is our architecture better than theirs?"** has to be asked under the
 * budget the baselines run under, because a harness that quietly allowed itself
 * a larger per-call output or an unbounded total would be winning on budget
 * rather than on architecture, and the difference would be invisible in the
 * results table. That is `parity`: 32,768 tokens per call (the official
 * `evaluation/pred.py` `max_new_tokens`, and what
 * `experiments/novelbench-run/run_nbrun.py` sets as `WRITER_TOKEN_CAP`) and
 * 3,000,000 per task (its `TOKEN_BUDGET`).
 *
 * **"Does the architecture work at all at novel length?"** cannot be asked
 * under that budget, because the first run to reach the end of a 4,000-word
 * story spent 997k tokens — 213 per output word — and 40,000 words at that rate
 * is 8.5M. Under `parity` every long run dies of budget exhaustion before it
 * can tell us whether the design is sound, and we learn nothing except that it
 * is expensive, which we already know. `generous` exists to get the behaviour
 * right first; cutting the cost is a separate, later problem with its own
 * levers (fewer verifier rounds, smaller packets, cache-aware ordering).
 *
 * The one thing that must never happen is a `generous` number appearing in a
 * table next to a `parity` number. So the profile is not a flag hidden in a
 * config file: it is written into every run summary along with
 * `comparableWithBaselines`, and the summary says so in words.
 */

export type BudgetProfileId = "parity" | "generous";

export interface BudgetProfile {
  readonly id: BudgetProfileId;
  /** Per model call, reasoning tokens included. */
  readonly maxCompletionTokens: number;
  /**
   * The working context ceiling — how much prompt we let an agent carry before
   * compaction intervenes. Deliberately below the model's real window: the
   * window is what fits, this is what we choose to spend.
   */
  readonly inputCeiling: number;
  /** Floor for the per-task total, whatever the target length. */
  readonly minTaskBudget: number;
  /**
   * Per target word, so the ceiling grows with the work instead of being one
   * number that is too small at 80k and absurd at 4k. Zero means fixed.
   */
  readonly tokensPerTargetWord: number;
  readonly comparableWithBaselines: boolean;
  readonly rationale: string;
}

/** Per model call under parity. Matches the baselines and LongBench-Write. */
export const MAX_COMPLETION_TOKENS = 32_768;

/** Per task under parity, across every agent and every retry. */
export const TASK_TOKEN_BUDGET = 3_000_000;

export const PROFILES: Readonly<Record<BudgetProfileId, BudgetProfile>> = {
  parity: {
    id: "parity",
    maxCompletionTokens: MAX_COMPLETION_TOKENS,
    // Effectively the model window: under parity nothing about context is ours
    // to choose, and compaction should only fire where the model would break.
    inputCeiling: 400_000,
    minTaskBudget: TASK_TOKEN_BUDGET,
    tokensPerTargetWord: 0,
    comparableWithBaselines: true,
    rationale:
      "the baselines' own numbers; the only setting under which our rows may " +
      "share a table with theirs",
  },
  generous: {
    id: "generous",
    // 64k rather than the model's 128k because the measured need is reasoning
    // headroom, not longer prose: in runs/v1 the writer never exceeded 4.9k
    // output tokens while one verifier call spent 23.6k, 23.1k of it reasoning.
    // A cap that truncates a verifier mid-reasoning produces a silent pass.
    maxCompletionTokens: 64_000,
    // 256k of prompt plus 64k of output still fits the 400k window with room to
    // spare, so the ceiling is a policy choice about spend and attention rather
    // than a limit imposed by the model.
    inputCeiling: 256_000,
    minTaskBudget: 8_000_000,
    /**
     * Measured, not extrapolated — and the first estimate here was wrong by 3×.
     *
     * It began at 400, doubling the 213 tokens-per-output-word seen in the
     * four-scene `runs/v1`. A nineteen-scene run then spent 11.6M against a 9.6M
     * ceiling and was cut off at scene 18 (`runs/v4-24k`): 485 tokens per
     * *target* word, and 1,216 per word actually delivered, because rejected
     * scenes cost their full price and contribute nothing to the word count.
     * The rate rises with scene count for two compounding reasons — each scene
     * carries more index than the last, and each resident agent carries more
     * transcript.
     *
     * 1,500 is that measured 485 with room for the repair rounds a harder
     * premise will need. It is deliberately expensive: the honest number for
     * this design today, which is what makes "did the extra spend pay for
     * itself" answerable later instead of hidden behind a ceiling that truncates
     * every long run at the same place.
     */
    tokensPerTargetWord: 1_500,
    comparableWithBaselines: false,
    rationale:
      "get the behaviour right before optimising cost; NOT comparable with any " +
      "baseline row, and any table mixing the two is wrong",
  },
};

export const DEFAULT_PROFILE: BudgetProfile = PROFILES.parity;

export function profileById(id: string): BudgetProfile {
  const profile = PROFILES[id as BudgetProfileId];
  if (!profile) {
    throw new Error(
      `unknown budget profile ${JSON.stringify(id)}; known: ${Object.keys(PROFILES).join(", ")}`,
    );
  }
  return profile;
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
    if (this.exhausted) throw new BudgetExhausted(this.#spent, this.#budget);
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
