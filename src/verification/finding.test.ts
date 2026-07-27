import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FindingError,
  blocking,
  makeFinding,
  recurringSubtypes,
  renderRepairBrief,
  stalled,
  unchangedAcrossRound,
} from "./finding.ts";
import { SUBTYPES, isBlockingSubtype, subtypeSpec, subtypesForTier } from "./taxonomy.ts";

const pair = {
  subtype: "appearance_mismatches",
  validator: "continuity",
  severity: "error",
  reasoning: "her eyes were grey in scene 3",
  evidence: { quote: "her green eyes narrowed", source: "s-011", span: "L4-L4" },
  contradicts: { quote: "grey eyes", source: "s-003", span: "L18-L18" },
  editLocus: { kind: "draft", quote: "her green eyes narrowed" },
} as const;

describe("taxonomy", () => {
  it("carries ConStory's nineteen subtypes across their five categories", () => {
    assert.equal(SUBTYPES.length, 19);
    assert.equal(new Set(SUBTYPES.map((s) => s.category)).size, 5);
  });

  it("marks exactly the five negative inferences that a scene gate cannot see", () => {
    assert.deepEqual(
      subtypesForTier("negative-inference").map((s) => s.subtype).sort(),
      [
        "abandoned_plot_elements",
        "causeless_effects",
        "forgotten_abilities",
        "skill_power_fluctuations",
        "social_norms_violations",
      ],
    );
  });

  it("lets only explicit contradiction pairs block a commit", () => {
    assert.equal(isBlockingSubtype("appearance_mismatches"), true);
    assert.equal(isBlockingSubtype("abandoned_plot_elements"), false);
    assert.equal(isBlockingSubtype("style_shifts"), false);
  });

  it("refuses a subtype it does not know rather than inventing one", () => {
    assert.throws(() => subtypeSpec("vibes_are_off"), /unknown error subtype/);
  });
});

describe("makeFinding", () => {
  it("accepts a well-formed contradiction pair", () => {
    const f = makeFinding(pair);
    assert.equal(f.category, "factual_detail");
    assert.equal(f.tier, "explicit-pair");
    assert.match(f.id, /^f-[0-9a-f]{8}$/);
  });

  it("refuses a contradiction pair that only shows one side", () => {
    const { contradicts: _dropped, ...oneSided } = pair;
    assert.throws(() => makeFinding(oneSided), FindingError);
  });

  it("refuses to let a negative inference block, because it is not yet an error", () => {
    assert.throws(
      () =>
        makeFinding({
          subtype: "abandoned_plot_elements",
          validator: "global",
          severity: "error",
          reasoning: "the locked box is never opened",
          evidence: { quote: "he pocketed the key", source: "s-002" },
          editLocus: { kind: "unresolved", question: "pay it off?" },
        }),
      /may only be a warning/,
    );
  });

  it("refuses evidence that is not verbatim text", () => {
    assert.throws(
      () => makeFinding({ ...pair, evidence: { quote: "   ", source: "s-011" } }),
      /verbatim/,
    );
  });

  it("gives the same id to the same defect however the reasoning is reworded", () => {
    const a = makeFinding(pair);
    const b = makeFinding({ ...pair, reasoning: "the eye colour does not match canon" });
    assert.equal(a.id, b.id);
  });

  it("gives different ids to the same subtype in different places", () => {
    const other = makeFinding({
      ...pair,
      evidence: { quote: "his green eyes narrowed", source: "s-012" },
    });
    assert.notEqual(makeFinding(pair).id, other.id);
  });
});

describe("repair loop signals", () => {
  it("separates blocking findings from warnings", () => {
    const warn = makeFinding({
      subtype: "style_shifts",
      validator: "llm",
      severity: "warning",
      reasoning: "the register turns clinical",
      evidence: { quote: "subject exhibited distress", source: "s-011" },
      editLocus: { kind: "draft", quote: "subject exhibited distress" },
    });
    assert.deepEqual(
      blocking([makeFinding(pair), warn]).map((f) => f.subtype),
      ["appearance_mismatches"],
    );
  });

  it("detects a finding that survived a repair round, which is the livelock signal", () => {
    const before = [makeFinding(pair)];
    const after = [makeFinding({ ...pair, reasoning: "still grey in scene 3" })];
    assert.equal(unchangedAcrossRound(before, after).length, 1);
    assert.equal(
      unchangedAcrossRound(before, [
        makeFinding({ ...pair, evidence: { quote: "her blue eyes", source: "s-011" } }),
      ]).length,
      0,
    );
  });

  /**
   * The failure the id comparison above cannot see, taken from the run where it
   * happened. `lbw081` s-001 produced five blocking findings over three rounds,
   * all `causal_logic_violations` about one door and one key, with five different
   * ids because the writer rewrote the passage each time. Id-matching saw three
   * unrelated defects and paid for every round.
   */
  it("detects the same defect class surviving a rewrite, when the quote moved", () => {
    const round1 = [
      makeFinding({ ...pair, evidence: { quote: "the key sat in the lock", source: "s-001" } }),
      makeFinding({ ...pair, evidence: { quote: "cold to the touch", source: "s-001" } }),
    ];
    const round2 = [
      makeFinding({ ...pair, evidence: { quote: "Hale produced a key", source: "s-001" } }),
      makeFinding({ ...pair, evidence: { quote: "the bolt was thrown", source: "s-001" } }),
    ];

    assert.equal(unchangedAcrossRound(round1, round2).length, 0, "no id survives — that is the trap");
    assert.deepEqual(recurringSubtypes(round1, round2), ["appearance_mismatches"]);
    assert.equal(stalled(round1, round2).stalled, true);
  });

  it("does not call it stalled while the blocking count is falling", () => {
    // Three findings down to one is a writer converging, and the survivor is
    // often what the next round fixes. Stopping there would spend the detector's
    // credibility on the case it is meant to allow.
    const round1 = ["a", "b", "c"].map((q) =>
      makeFinding({ ...pair, evidence: { quote: `quote ${q}`, source: "s-001" } }),
    );
    const round2 = [makeFinding({ ...pair, evidence: { quote: "quote d", source: "s-001" } })];

    assert.deepEqual(recurringSubtypes(round1, round2), ["appearance_mismatches"]);
    assert.equal(stalled(round1, round2).stalled, false);
  });

  it("is not stalled on the first round, when there is nothing to compare against", () => {
    assert.equal(stalled([], [makeFinding(pair)]).stalled, false);
  });

  it("ignores warnings, which never blocked and so cannot have failed to clear", () => {
    const warning = makeFinding({
      subtype: "style_shifts",
      validator: "llm",
      severity: "warning",
      reasoning: "register drift",
      evidence: { quote: "subject exhibited distress", source: "s-011" },
      editLocus: { kind: "draft", quote: "subject exhibited distress" },
    });
    assert.deepEqual(recurringSubtypes([warning], [warning]), []);
    assert.equal(stalled([warning], [warning]).stalled, false);
  });
});

describe("renderRepairBrief", () => {
  it("tells the writer when its previous fix failed on the same defect class", () => {
    // Without this the writer cannot tell a third attempt at one problem from a
    // first attempt at a third problem, and it answers by varying the fix that
    // already failed.
    const brief = renderRepairBrief([makeFinding(pair)], {
      recurring: ["causal_logic_violations"],
    });
    assert.match(brief, /previous round raised causal_logic_violations/);
    assert.match(brief, /not produce another variation/);
    // And it is given the one legitimate way out: say the fix needs a decision.
    assert.match(brief, /state what needs deciding/);
  });

  it("says nothing about recurrence on a first round", () => {
    assert.doesNotMatch(renderRepairBrief([makeFinding(pair)]), /previous round/);
  });

  it("gives the writer both sides and the place to edit", () => {
    const brief = renderRepairBrief([makeFinding(pair)]);
    assert.match(brief, /in your draft: "her green eyes narrowed"  <s-011 L4-L4>/);
    assert.match(brief, /contradicts: "grey eyes"  <s-003 L18-L18>/);
    assert.match(brief, /fix here: "her green eyes narrowed"/);
  });

  it("tells the writer to leave the prose alone when canon is what is stale", () => {
    const brief = renderRepairBrief([
      makeFinding({
        ...pair,
        editLocus: {
          kind: "canon",
          path: "index/story/bible/characters/mira.yaml",
          reason: "she dyed her hair in s-009 and the fact was never updated",
        },
      }),
    ]);
    assert.match(brief, /do NOT change the prose/);
    assert.match(brief, /index-manager will correct it/);
  });

  it("puts fatal findings before warnings so the budget goes to real defects", () => {
    const brief = renderRepairBrief([
      makeFinding({
        subtype: "style_shifts",
        validator: "llm",
        severity: "warning",
        reasoning: "register drift",
        evidence: { quote: "clinical phrasing", source: "s-011" },
        editLocus: { kind: "draft", quote: "clinical phrasing" },
      }),
      makeFinding({ ...pair, severity: "fatal" }),
    ]);
    assert.ok(brief.indexOf("[fatal]") < brief.indexOf("[warning]"));
  });

  it("says so plainly when there is nothing to repair", () => {
    assert.equal(renderRepairBrief([]), "No findings.");
  });
});

describe("an absence is not the other half of a contradiction", () => {
  /**
   * Taken from a run of `lbw081` where the verifier raised eleven findings shaped
   * like "`objects/obj-note.yaml` has no `first_seen` entry", each labelled a
   * contradiction pair with the empty result standing in for the contradicting
   * passage. Every one described a scene establishing a fact for the first time.
   * That run scored 79.8 against 88.2 for one with five real findings: the writer
   * has no index access, cannot tell a spurious finding from a real one, and spent
   * its repair rounds writing provenance into prose that was fine.
   */
  it("refuses a pair whose contradicting side is empty", () => {
    assert.throws(
      () =>
        makeFinding({
          ...pair,
          contradicts: { quote: "   ", source: "objects/obj-note.yaml" },
        }),
      (error: unknown) => {
        assert.ok(error instanceof FindingError);
        assert.match((error as Error).message, /absence is not the other half/);
        return true;
      },
    );
  });

  it("still accepts a pair that quotes both sides", () => {
    const finding = makeFinding(pair);
    assert.equal(finding.contradicts!.quote, "grey eyes");
  });

  it("leaves negative inferences alone, which have no pair by definition", () => {
    // An unpaid promise is an absence *on purpose* — the whole subtype is about
    // something that did not happen — so the pair check must not reach it.
    const finding = makeFinding({
      subtype: "abandoned_plot_elements",
      validator: "global",
      severity: "warning",
      reasoning: "the locked box is never opened",
      evidence: { quote: "she pocketed the key", source: "s-002" },
      editLocus: { kind: "unresolved", question: "does the box ever open?" },
    });
    assert.equal(finding.subtype, "abandoned_plot_elements");
  });
});
