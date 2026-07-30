import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyDeterministic } from "./deterministic.ts";
import { findEchoes } from "./echo.ts";

/**
 * The quotes here are the external detector's own `exact_quote` and
 * `contradiction_pair` fields from `storyos-60k__task-fantasy-the-book-witch`,
 * so a passing test means the check catches instances we were actually charged for.
 */
describe("restatement at short range", () => {
  it("catches a repeated scene exit", () => {
    const draft =
      "She left Vault Ivy with the ledger against her chest and the scrape and the " +
      "pencil mark burning like two small, useful clues. " +
      "Rowan waited under the arch with nothing to say. " +
      "She left Vault Ivy with the ledger against her chest and the scrape still " +
      "warm from Lumen's thumb.";
    const [echo, ...rest] = findEchoes(draft);
    assert.ok(echo);
    assert.equal(rest.length, 0);
    assert.match(echo.run, /she left vault ivy with the ledger against her chest/);
    assert.equal(echo.from, "this scene");
    assert.match(echo.quote, /still\s+warm from Lumen's thumb/);
    assert.match(echo.earlier, /two small, useful clues/);
  });

  /**
   * The shortest measured class is deliberately not caught: at seven words the
   * check fires on 21% of scenes and a good share of those are callbacks. See the
   * threshold note in `echo.ts`.
   */
  it("leaves a seven-word run to the verifier", () => {
    const draft =
      "She left Vault Ivy with the ledger against her chest and the scrape burned. " +
      "Rowan said nothing at all. " +
      "She left Vault Ivy with the ledger cupped against her ribs.";
    assert.deepEqual(findEchoes(draft), []);
  });

  it("reports the whole shared run, not the minimum", () => {
    const draft =
      "The Registrar appeared and took it away with the care of someone handling a " +
      "grave; the fingers that received it moved with a practised reverence. " +
      "Nothing else in the room moved at all. " +
      "Mira left the ring on the blotter until the Registrar appeared and took it " +
      "away with the care of someone handling a grave.";
    const [echo] = findEchoes(draft);
    assert.ok(echo!.runWords >= 15, `expected the full run, got ${echo!.runWords}`);
  });

  it("says nothing about prose that does not repeat itself", () => {
    const draft =
      "She crossed the yard and did not look back. The gate was open, which was " +
      "the first wrong thing. Rowan had promised to bolt it before the tide turned, " +
      "and Rowan kept promises the way other people kept receipts.";
    assert.deepEqual(findEchoes(draft), []);
  });

  it("ignores a run of function words, which is grammar rather than a beat", () => {
    // Seven tokens shared, none of them content: a false positive here costs a
    // repair round and damages prose that was working.
    const draft =
      "He said that it was not up to her and that was the end of it. " +
      "Later she would think that it was not up to her and that nothing had changed.";
    assert.deepEqual(findEchoes(draft), []);
  });

  it("catches a beat carried over from the preceding scene", () => {
    const preceding =
      "Mira set the brass compass on the sill beside the tide table and let the " +
      "shutter fall. The harbour went dark in one movement.";
    const draft =
      "Morning came in flat and grey. " +
      "Mira set the brass compass on the sill beside the tide table and waited for " +
      "Rowan to notice it.";
    const [echo] = findEchoes(draft, { preceding });
    assert.equal(echo!.from, "the preceding scene");
    assert.match(echo!.run, /brass compass on the sill beside the tide table/);
  });

  it("needs sixteen characters in Chinese, where the unit has no word boundary", () => {
    const repeated = "她把黄铜罗盘放在窗台上然后合上百叶窗";
    assert.deepEqual(findEchoes(`${repeated}。天亮得很慢。`), []);
    const [echo] = findEchoes(`${repeated}。天亮得很慢，海港一片漆黑。${repeated}，等着有人注意到。`);
    assert.ok(echo, "an eighteen-character repeat is past coincidence");
    assert.ok(echo!.runWords >= 16);
  });

  it("blocks the commit and reaches the layer that runs it", () => {
    const result = verifyDeterministic({
      canon: [],
      knownEntities: new Set<string>(),
      delta: { sceneId: "s-004", claims: [], presentEntities: [] },
      prose:
        "She left Vault Ivy with the ledger against her chest and the scrape burned. " +
        "Rowan said nothing at all. " +
        "She left Vault Ivy with the ledger against her chest and the scrape had not cooled.",
      preceding: { sceneId: "s-003", prose: "Nothing in this scene repeats." },
    });
    const [finding, ...rest] = result.findings;
    assert.equal(rest.length, 0);
    assert.equal(finding!.subtype, "style_shifts");
    assert.equal(finding!.severity, "error");
    assert.equal(finding!.editLocus.kind, "draft");
    assert.ok(finding!.suggestion);
    assert.equal(finding!.contradicts?.source, "s-004");
  });

  it("caps the findings so one draft cannot spend the whole repair budget", () => {
    const beats = [
      "she carried the salt lamp down the pier stairs with both hands and did not look back",
      "the harbourmaster counted the crates against his own tally sheet twice before he would sign",
      "rain came off the roof slates in one continuous sheet and filled the lower yard",
      "rowan folded the warrant into the lining of his coat and buttoned it to the throat",
    ];
    const draft = beats
      .map((beat, i) => `${beat} at dawn. A gull answered from the ${i} piling. ${beat} again.`)
      .join(" ");
    assert.ok(findEchoes(draft).length > 2);
    const result = verifyDeterministic({
      canon: [],
      knownEntities: new Set<string>(),
      delta: { sceneId: "s-004", claims: [], presentEntities: [] },
      prose: draft,
    });
    assert.equal(result.findings.length, 2);
  });
});
