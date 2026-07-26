/**
 * List prices, so a run can report money as well as tokens.
 *
 * `FOUNDATION.md` says USD is left empty because "the gateway exposes no
 * verified per-model rate", and that is still true — the company gateway
 * publishes no rate card, and nothing here claims to know what it bills us.
 * What these are is the **providers' public list prices for the same models**,
 * which answers a different and still useful question: what would this run cost
 * anyone reproducing it against the public APIs?
 *
 * Every field is an estimate at list price and is labelled as one. It is not a
 * bill, and it must not be quoted as our cost.
 *
 * ## Why cached input needs its own rate
 *
 * Because it is 90% cheaper and it is most of our traffic. On a measured run,
 * 89.5% of provider-reported tokens were cache reads. Pricing those at the
 * full input rate would overstate the cost of this system by roughly an order
 * of magnitude — which is the same mistake, in the other direction, that the
 * token budget was making when it charged them at full weight.
 */

export interface ModelRate {
  /** USD per million cache-miss input tokens. */
  readonly input: number;
  /** USD per million cached input tokens. */
  readonly cachedInput: number;
  /** USD per million output tokens, reasoning tokens included. */
  readonly output: number;
  /** Where the numbers came from and when, because list prices move. */
  readonly source: string;
}

/**
 * Rates checked on 2026-07-26.
 *
 * Gemini 3.1 Pro is tiered on total prompt size — above 200k tokens the whole
 * request reprices to $4/$18. Our peak context is around 64k, so the standard
 * tier is the right one; if that changes, this table is wrong and the comment
 * is how you find out.
 */
export const RATES: Readonly<Record<string, ModelRate>> = {
  "gpt-5-mini": {
    input: 0.25,
    cachedInput: 0.025,
    output: 2.0,
    source: "OpenAI list price, checked 2026-07-26",
  },
  "gpt-5.5": {
    input: 1.25,
    cachedInput: 0.125,
    output: 10.0,
    source: "OpenAI list price, checked 2026-07-26",
  },
  "gemini-3.1-pro-preview": {
    input: 2.0,
    cachedInput: 0.2,
    output: 12.0,
    source: "Google AI list price for prompts <= 200k tokens, checked 2026-07-26",
  },
};

export interface Usage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
}

export interface CostBreakdown {
  readonly usd: number;
  readonly inputUsd: number;
  readonly cachedUsd: number;
  readonly outputUsd: number;
  /** Null when we have no published rate for the model; never guessed. */
  readonly rate: ModelRate | null;
}

/**
 * Price one model's usage.
 *
 * `input` from a provider is cache-miss input — the cached half is reported
 * separately as `cacheRead` — so the two are charged at their own rates rather
 * than summed first.
 */
export function costOf(model: string, usage: Usage): CostBreakdown {
  const rate = RATES[model] ?? null;
  if (!rate) {
    return { usd: 0, inputUsd: 0, cachedUsd: 0, outputUsd: 0, rate: null };
  }
  const inputUsd = (usage.input / 1_000_000) * rate.input;
  const cachedUsd = (usage.cacheRead / 1_000_000) * rate.cachedInput;
  const outputUsd = (usage.output / 1_000_000) * rate.output;
  return {
    usd: inputUsd + cachedUsd + outputUsd,
    inputUsd,
    cachedUsd,
    outputUsd,
    rate,
  };
}

/** Price a whole ledger, per model and in total. */
export function priceLedger(
  entries: readonly { readonly model: string; readonly usage: Usage }[],
): {
  readonly totalUsd: number;
  readonly byModel: Readonly<Record<string, CostBreakdown & { calls: number }>>;
  /** Models with no published rate, so an incomplete total says so. */
  readonly unpriced: readonly string[];
} {
  const byModel: Record<string, CostBreakdown & { calls: number }> = {};
  const unpriced = new Set<string>();
  for (const e of entries) {
    const cost = costOf(e.model, e.usage);
    if (!cost.rate) unpriced.add(e.model);
    const row = (byModel[e.model] ??= {
      usd: 0,
      inputUsd: 0,
      cachedUsd: 0,
      outputUsd: 0,
      rate: cost.rate,
      calls: 0,
    });
    byModel[e.model] = {
      usd: row.usd + cost.usd,
      inputUsd: row.inputUsd + cost.inputUsd,
      cachedUsd: row.cachedUsd + cost.cachedUsd,
      outputUsd: row.outputUsd + cost.outputUsd,
      rate: cost.rate,
      calls: row.calls + 1,
    };
  }
  return {
    totalUsd: Object.values(byModel).reduce((n, r) => n + r.usd, 0),
    byModel,
    unpriced: [...unpriced],
  };
}
