import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyDeterministic } from "./deterministic.ts";
import { makeFinding } from "./finding.ts";
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

  /**
   * The check reaching the layer that runs it, which the tests above cannot see.
   *
   * Every test above calls the pure functions, and all of them passed while the
   * wiring threw on the first scene that actually drifted: `style_shifts` is a
   * `stylistic` subtype, `makeFinding` refuses a non-warning severity for one, and
   * the throw landed inside `verifyDeterministic` — after `verify()` had already
   * moved the scene to VALIDATING, so every later verification call was refused
   * with "there is no fresh draft to check" and the scene could never commit.
   * Two of five runs on 0.9.10 delivered a quarter of their planned scenes that
   * way, against zero occurrences in the sixty runs before it.
   */
  it("reaches the deterministic layer instead of throwing on the way there", () => {
    const result = verifyDeterministic({
      canon: [],
      knownEntities: new Set<string>(),
      delta: { sceneId: "s-002", claims: [], presentEntities: [] },
      convention: { spelling: "american", quotes: "double" },
      prose:
        "She had memorised the route before the labour of the crossing began, " +
        "and the grey light realised nothing for her.",
    });
    const drift = result.findings.filter((f) => f.subtype === "style_shifts");
    assert.ok(drift.length > 0, "a drifting draft must produce a style_shifts finding");
    assert.match(drift[0]!.reasoning, /British spelling/);
  });

  it("blocks the commit, because a spelling pair is mechanical and not a judgement", () => {
    // The taxonomy holds `style_shifts` non-blocking on the grounds that "a
    // stylistic judgement is too soft to refuse prose over". That reasoning is
    // about judgements. `labour` against `labor` is a fact, and a warning would
    // leave the drift on the page — which is the whole defect being fixed.
    const [finding] = verifyDeterministic({
      canon: [],
      knownEntities: new Set<string>(),
      delta: { sceneId: "s-002", claims: [], presentEntities: [] },
      convention: { spelling: "american", quotes: "double" },
      prose: "The harbour was grey with labour that morning.",
    }).findings;
    assert.equal(finding!.subtype, "style_shifts");
    assert.equal(finding!.severity, "error");
    assert.equal(finding!.validator, "voice");
  });

  it("still refuses a stylistic severity that no mechanism stands behind", () => {
    // The allowance must not become a general escape from the taxonomy: a
    // stylistic finding from the model verifier stays a warning.
    assert.throws(
      () =>
        makeFinding({
          subtype: "style_shifts",
          validator: "llm",
          severity: "error",
          reasoning: "the register drops in the second half",
          evidence: { quote: "the register drops", source: "s-002" },
          editLocus: { kind: "draft", quote: "the register drops" },
        }),
      /may only be a warning/,
    );
  });
});
