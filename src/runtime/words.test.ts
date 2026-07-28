import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { countWords, isCjkDominant } from "./words.ts";

describe("counting words the way the benchmark counts them", () => {
  /** The three cases upstream's own test pins, so a drift shows up here too. */
  it("matches the official definition", () => {
    assert.equal(countWords("hello world"), 2);
    assert.equal(countWords("电池供应链"), 5);
    assert.equal(countWords("hello 电池"), 3);
  });

  /**
   * The failure this exists for. `runs-ch21/lbw066-ch` produced a legitimate
   * ~1,850-character Chinese story against a 2,000-character target and the
   * harness recorded `20 words, attainment 0.01` — because whitespace splitting
   * counts Chinese sentences, not Chinese characters. That number was the
   * writer's target, the length check's comparison, and the reported attainment.
   */
  it("reads a Chinese paragraph as characters, not as sentences", () => {
    const zh =
      "我到达提兰海岸时，潮汐把细小的盐花推到我的靴边，夜光像被撕薄的布散在潮沟里。" +
      "码头是漂流木和缝补布搭成的脊梁，桩子上挂着风铃。";
    assert.equal(zh.split(/\s+/).filter(Boolean).length, 1, "the old count saw one token");
    assert.ok(countWords(zh) > 50, `got ${countWords(zh)}`);
  });

  it("ignores punctuation and digits, as upstream does", () => {
    assert.equal(countWords("!!! ,,, 123 ---"), 0);
    // Digits are word characters, so there is no `\b` between `a` and `1` and
    // neither letter is a whole word. Upstream's behaviour, transcribed as-is.
    assert.equal(countWords("a1b"), 0);
    assert.equal(countWords("chapter 12 begins"), 2);
  });

  it("counts nothing in an empty or whitespace-only text", () => {
    assert.equal(countWords(""), 0);
    assert.equal(countWords("   \n\t "), 0);
  });

  it("says which way a text is counted, so a target is interpretable", () => {
    assert.equal(isCjkDominant("我到达提兰海岸时"), true);
    assert.equal(isCjkDominant("the tide pushed salt to my boots"), false);
  });
});
