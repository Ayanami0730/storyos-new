import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  conventionOf,
  findOrthographyDrift,
  renderConvention,
} from "./orthography.ts";

/**
 * The sentences are the ones the frozen consistency judge charged, not invented
 * examples. On `task-literary-yesteryear` five of six `style_shifts` were this,
 * and `style_shifts` is the largest subtype across every manuscript on the fixed
 * harness — 30 of 87 instances, 1.83 per 10,000 words.
 */
describe("one book, one spelling", () => {
  it("reads the convention off a finished scene", () => {
    const scene =
      "She had memorised numbers the way other people memorised birthdays. " +
      "The settlement's ledger had changed by the weight of human labour expended.";
    const c = conventionOf(scene);
    assert.equal(c?.spelling, "british");
  });

  it("says nothing when the scene carries no evidence", () => {
    // A guessed convention would make half of every later scene wrong, which is
    // worse than having none.
    assert.equal(conventionOf("She crossed the yard and did not look back."), null);
  });

  it("reports the words that contradict the established convention", () => {
    const draft =
      "Evie realized her first day's duty was not to the audience she had lost. " +
      "She told herself the work had dignity because it was labor that paid.";
    const drifts = findOrthographyDrift(draft, { spelling: "british", quotes: "double" });
    const words = drifts.map((d) => d.why);
    assert.ok(words.some((w) => /"realized" is American/.test(w)), words.join(" | "));
    assert.ok(words.some((w) => /"labor" is American/.test(w)), words.join(" | "));
    // The counterpart has to be named: the writer must not be sent looking for a
    // judgement it has to make.
    assert.ok(drifts.every((d) => /the established form is "/.test(d.why)));
  });

  it("reports each word once, not once per occurrence", () => {
    // Nine drifting sentences are one defect the writer needs told once; the
    // repair allowance on an opening scene is two rounds.
    const draft = "realized. realized. realized. realized.";
    const drifts = findOrthographyDrift(draft, { spelling: "british", quotes: "double" });
    assert.equal(drifts.length, 1);
  });

  it("leaves a draft that matches the convention alone", () => {
    const draft = "She realised the colour of the theatre had changed.";
    assert.deepEqual(
      findOrthographyDrift(draft, { spelling: "british", quotes: "double" }),
      [],
    );
  });

  it("notices the quotation convention separately from the spelling", () => {
    // Independent choices: the yesteryear manuscript mixed ‘…’ with "…" while
    // also mixing -ise and -ize, and a checker that folded them would report one.
    const single = conventionOf("‘The well or the river?’ she asked. She realised why.");
    assert.equal(single?.quotes, "single");
    const double = conventionOf('"You will show me," Martha said. She realised why.');
    assert.equal(double?.quotes, "double");
  });

  it("states the convention in words a writer can act on", () => {
    const text = renderConvention({ spelling: "british", quotes: "single" });
    assert.match(text, /British English/);
    assert.match(text, /single quotation marks/);
    assert.match(text, /fixed for the whole book/);
  });
});
