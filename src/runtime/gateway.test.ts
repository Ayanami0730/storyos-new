import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { GATEWAY_BASE_URL, SUPPLIES, selectedSupply } from "./gateway.ts";

describe("choosing which route buys the tokens", () => {
  /**
   * The default has to stay the reference gateway. Every baseline in both tables
   * was generated through it, so a run that quietly used a different deployment
   * of the same model name would sit in those tables looking comparable.
   */
  it("defaults to the gateway the baselines were generated through", () => {
    assert.equal(selectedSupply({} as NodeJS.ProcessEnv).baseUrl, GATEWAY_BASE_URL);
    assert.equal(
      selectedSupply({ STORYOS_SUPPLY: "" } as NodeJS.ProcessEnv).baseUrl,
      GATEWAY_BASE_URL,
    );
  });

  it("switches route and key together, never one without the other", () => {
    const zzz = selectedSupply({ STORYOS_SUPPLY: "zzz" } as NodeJS.ProcessEnv);
    assert.equal(zzz.baseUrl, SUPPLIES.zzz!.baseUrl);
    assert.deepEqual(zzz.keyEnv, ["ZZZ_KEY"]);
    assert.notEqual(zzz.keyEnv[0], "YS_KEY");
  });

  /**
   * A typo must not silently fall back to the default: that is the same class of
   * failure as the version stamp that stopped changing, where seven releases of
   * runs carried the wrong label and nothing complained.
   */
  it("refuses a route it does not know rather than falling back", () => {
    assert.throws(
      () => selectedSupply({ STORYOS_SUPPLY: "zzzz" } as NodeJS.ProcessEnv),
      /not a known route/,
    );
  });
});
