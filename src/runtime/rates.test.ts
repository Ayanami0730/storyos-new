import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { RATES, costOf, priceLedger } from "./rates.ts";

describe("pricing a run at list price", () => {
  it("charges cached input at its own rate, not the input rate", () => {
    // The reason this matters here more than in most systems: 89.5% of a
    // measured run's provider-reported tokens were cache reads. At $0.25/M
    // instead of $0.025/M that one line item would overstate the cost of the
    // whole design by roughly ten times.
    const cost = costOf("gpt-5-mini", { input: 0, output: 0, cacheRead: 1_000_000 });
    assert.equal(cost.cachedUsd, 0.025);
    assert.equal(cost.inputUsd, 0);
  });

  it("prices a million of each the way the rate card reads", () => {
    const cost = costOf("gpt-5-mini", {
      input: 1_000_000,
      output: 1_000_000,
      cacheRead: 1_000_000,
    });
    assert.equal(cost.inputUsd, 0.25);
    assert.equal(cost.outputUsd, 2.0);
    assert.equal(cost.cachedUsd, 0.025);
    assert.equal(Number(cost.usd.toFixed(4)), 2.275);
  });

  it("says nothing rather than guessing for a model with no published rate", () => {
    const cost = costOf("some-internal-model", {
      input: 5_000_000,
      output: 1_000_000,
      cacheRead: 0,
    });
    // A guessed rate is worse than an absent one: it survives being copied into
    // a table, and nothing downstream can tell it was invented.
    assert.equal(cost.rate, null);
    assert.equal(cost.usd, 0);
  });

  it("names the unpriced models so an incomplete total admits it", () => {
    const priced = priceLedger([
      { model: "gpt-5-mini", usage: { input: 1_000_000, output: 0, cacheRead: 0 } },
      { model: "mystery-model", usage: { input: 9_000_000, output: 0, cacheRead: 0 } },
    ]);
    assert.deepEqual(priced.unpriced, ["mystery-model"]);
    assert.equal(priced.totalUsd, 0.25);
  });

  /**
   * The route prefix that made every run on the internal gateway report $0.00.
   *
   * That gateway needs `openai/gpt-5-mini` to reach an unsaturated upstream group
   * — the bare name returns "上游负载已饱和" — and the prefixed name matched no
   * rate, so the cost column read zero with the model filed under `unpriced`. A
   * zero that means "unknown" is the failure the word counter had: it looks like
   * a measurement.
   */
  it("prices a model reached through a gateway's routing prefix", () => {
    const prefixed = costOf("openai/gpt-5-mini", {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
    });
    const bare = costOf("gpt-5-mini", { input: 1_000_000, output: 0, cacheRead: 0 });
    assert.equal(prefixed.usd, bare.usd);
    assert.notEqual(prefixed.rate, null);
  });

  it("still refuses to guess when the name after the prefix is unknown", () => {
    // Stripping the prefix must not become a licence to price anything: the
    // promise the table makes is that no number in it is invented.
    const cost = costOf("somevendor/some-unreleased-model", {
      input: 1_000_000,
      output: 0,
      cacheRead: 0,
    });
    assert.equal(cost.rate, null);
    assert.equal(cost.usd, 0);
  });

  it("keeps the verifier on the standard Gemini tier it actually runs in", () => {
    // Gemini 3.1 Pro reprices the *whole* request above 200k prompt tokens
    // ($4/$18). Our peak context is around 64k, so the standard tier is right —
    // and if peak context ever crosses 200k this table silently understates.
    assert.equal(RATES["gemini-3.1-pro-preview"]!.input, 2.0);
    assert.equal(RATES["gemini-3.1-pro-preview"]!.output, 12.0);
    assert.match(RATES["gemini-3.1-pro-preview"]!.source, /200k/);
  });
});
