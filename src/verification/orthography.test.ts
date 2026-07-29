import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { verifyDeterministic } from "./deterministic.ts";
import { makeFinding } from "./finding.ts";
import {
  type OrthographyConvention,
  conventionOf,
  findOrthographyDrift,
  findScriptDrift,
  renderConvention,
  requestScriptOf,
  scriptOf,
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

  /**
   * The same defect one level coarser, and the one the judge named outright.
   *
   * `lbw119` asked for a popular history of the Qing in the manner of 《明朝那些事儿》
   * and **seven of its seventeen committed scenes came out in English**. The frozen
   * gpt-5.5 judge scored Accuracy 2 and wrote "switches inexplicably between
   * Chinese and English". Five of twenty-one manuscripts drift this way, and their
   * S_q deficit against agentwrite is -0.67 where the eleven with no known
   * mechanical defect sit at -0.44.
   */
  it("reads the book's language off the request, not off a scene", () => {
    assert.equal(requestScriptOf("请写一份有五个人搞笑的青春校园剧本，明确各角色所说话语，共五幕。"), "han");
    assert.equal(
      requestScriptOf("Write a first-person detective story featuring a locked room. ".repeat(3)),
      "latin",
    );
  });

  /**
   * The false positive that replay caught, and the reason the source is the
   * request rather than the first committed scene.
   *
   * `lbw068` asks in Chinese for five diary entries. Its first scene came out in
   * English and the remaining three in Chinese. A convention established from
   * scene one would have fixed the book to English and then demanded a rewrite of
   * the three scenes that were right — turning a one-scene defect into a
   * three-scene one. Replayed over all twenty-one manuscripts, taking the script
   * from the request instead flags that first scene and leaves the rest alone.
   */
  it("does not invert the book's language when the first scene is the one that drifted", () => {
    const fromRequest: OrthographyConvention = {
      spelling: "american",
      quotes: "double",
      script: requestScriptOf("创作五篇关于独自旅行去日本的日记，每篇400字。")!,
    };
    assert.equal(fromRequest.script, "han");
    // The drifted opening is caught...
    assert.ok(
      findScriptDrift("Day one. The train to Kyoto left before dawn. ".repeat(8), fromRequest),
    );
    // ...and the correct scenes after it are not.
    assert.equal(
      findScriptDrift("第二天。清晨的列车驶向京都，窗外是连绵的稻田。".repeat(8), fromRequest),
      null,
    );
  });

  it("says nothing about script when there is too little text to tell", () => {
    // Guessing here would make every later scene wrong half the time, which is the
    // same reason the spelling convention refuses to guess.
    assert.equal(scriptOf("短。"), null);
  });

  it("reports a scene written in the other language, once", () => {
    const drift = findScriptDrift(
      "The emperor received the embassy in the garden pavilion at Rehe. ".repeat(8),
      { spelling: "american", quotes: "double", script: "han" },
    );
    assert.ok(drift, "an English scene in a Chinese book must be reported");
    assert.match(drift!.why, /written in English while the book is in Chinese/);
  });

  it("leaves a scene in the book's own language alone", () => {
    // A Chinese book may quote an English name; weight decides, not presence.
    const drift = findScriptDrift(
      "马戛尔尼（George Macartney）的船队抵达天津，随行的礼品堆满了甲板。".repeat(6),
      { spelling: "american", quotes: "double", script: "han" },
    );
    assert.equal(drift, null);
  });

  it("blocks the commit and states the language in the convention", () => {
    const [finding] = verifyDeterministic({
      canon: [],
      knownEntities: new Set<string>(),
      delta: { sceneId: "s-004", claims: [], presentEntities: [] },
      convention: { spelling: "american", quotes: "double", script: "han" },
      prose: "The emperor received the embassy in the garden pavilion. ".repeat(8),
    }).findings;
    assert.equal(finding!.subtype, "style_shifts");
    assert.equal(finding!.severity, "error");
    assert.match(renderConvention({ spelling: "american", quotes: "double", script: "han" }),
      /Language: Chinese/);
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
