import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CRAFT_CHECKS, MAX_BLOCKING_CRAFT, renderCraftChecklist } from "./craft.ts";
import { compareClaims, renderDossier } from "./dossier.ts";
import { blocking, capCraftBlockers, makeCraftFinding, renderRepairBrief } from "./finding.ts";

const draftEvidence = { quote: "She said nothing for a long moment.", source: "s-003" };

describe("the craft axis", () => {
  it("keeps every check tied to a scored dimension", () => {
    // The filter that stops this list becoming a taste inventory: a check nobody
    // scores cannot justify a repair round, so it does not belong here.
    for (const check of CRAFT_CHECKS) {
      assert.ok(
        check.judgedAs.length > 0,
        `${check.id} names no scored dimension, so nothing penalises it`,
      );
      assert.ok(
        check.judgedAs.some((d) => /LongBench-Write|LongStoryEval/.test(d)),
        `${check.id} must cite one of the two rubrics we are actually graded by`,
      );
    }
  });

  it("only offers the ending check on the last scene", () => {
    assert.ok(!renderCraftChecklist({ finalScene: false }).includes("ending_not_delivered"));
    assert.ok(renderCraftChecklist({ finalScene: true }).includes("ending_not_delivered"));
  });

  it("tells the verifier which dimension penalises each check", () => {
    // The provenance is what bounds the axis for an eager model: a finite list
    // derived from two rubrics reads differently from an invitation to judge.
    assert.match(renderCraftChecklist({ finalScene: true }), /penalised by: /);
  });
});

describe("makeCraftFinding", () => {
  it("refuses a blocking finding whose evidence cannot be checked", () => {
    // `restates_prior_scene` is a pair check: without the earlier passage the
    // writer cannot tell what to cut, and neither can anyone auditing the run.
    assert.throws(
      () =>
        makeCraftFinding({
          checkId: "restates_prior_scene",
          severity: "error",
          reasoning: "this beat has already happened",
          evidence: draftEvidence,
          suggestion: "cut the paragraph",
        }),
      /both sides quoted/,
    );
  });

  it("refuses a blocking state-pair finding with no named states", () => {
    assert.throws(
      () =>
        makeCraftFinding({
          checkId: "nothing_changes",
          severity: "error",
          reasoning: "the scene does not move",
          evidence: draftEvidence,
          suggestion: "give somebody a decision to make",
        }),
      /named state pair/,
    );
  });

  it("accepts the same finding once the state pair is named", () => {
    const finding = makeCraftFinding({
      checkId: "nothing_changes",
      severity: "error",
      reasoning: "the scene does not move",
      evidence: draftEvidence,
      statePair: {
        before: "Hale suspects the steward and has no evidence",
        after: "Hale suspects the steward and has no evidence",
      },
      suggestion: "let Hale find the altered ledger line, so he leaves with one fact he lacked",
    });
    assert.equal(finding.severity, "error");
    assert.equal(finding.axis, "craft");
    // The state pair is in the reasoning the writer reads, not only in a field
    // nothing renders — it is the evidence, so it has to be visible.
    assert.match(finding.reasoning, /open\/question: Hale suspects/);
  });

  it("will not let a subjective check block at all", () => {
    assert.throws(
      () =>
        makeCraftFinding({
          checkId: "flat_diction",
          severity: "error",
          reasoning: "the prose is inert",
          evidence: draftEvidence,
          suggestion: "vary the sentence lengths",
        }),
      /may only be a warning/,
    );
  });

  it("requires an instruction even for a warning", () => {
    // A craft note with no instruction is a complaint, and the writer's only
    // answer to one is to guess — which is how a run scored 8.4 points below one
    // with fewer, better findings.
    assert.throws(
      () =>
        makeCraftFinding({
          checkId: "flat_diction",
          severity: "warning",
          reasoning: "the prose is inert",
          evidence: draftEvidence,
          suggestion: "   ",
        }),
      /suggestion is required/,
    );
  });

  it("keeps craft findings out of the consistency count", () => {
    const finding = makeCraftFinding({
      checkId: "theme_stated",
      severity: "warning",
      reasoning: "the line explains the story's meaning",
      evidence: draftEvidence,
      suggestion: "cut the sentence; the choice two paragraphs earlier already carries it",
    });
    // EID is a metric of record over ConStory's nineteen subtypes. A craft finding
    // pooled into it would inflate an error density with something that is not an
    // error in that taxonomy.
    assert.equal(finding.axis, "craft");
    assert.equal(finding.category, "craft");
  });
});

describe("the craft cap", () => {
  const blocker = (before: string) =>
    makeCraftFinding({
      checkId: "nothing_changes",
      severity: "error",
      reasoning: "the scene does not move",
      evidence: { quote: before, source: "s-003" },
      statePair: { before, after: before },
      suggestion: "give somebody a decision",
    });

  it("demotes craft blockers past the cap instead of dropping them", () => {
    const capped = capCraftBlockers([blocker("a"), blocker("b"), blocker("c"), blocker("d")]);
    assert.equal(blocking(capped.findings).length, MAX_BLOCKING_CRAFT);
    assert.equal(capped.demoted, 4 - MAX_BLOCKING_CRAFT);
    // Demoted, not discarded: the writer still sees the observation and the run
    // can still count how often the cap bound, which is the only way to find out
    // whether it is set anywhere near right.
    assert.equal(capped.findings.length, 4);
  });

  it("leaves consistency findings alone however many there are", () => {
    const consistency = {
      id: "f-1",
      subtype: "appearance_mismatches",
      axis: "consistency" as const,
      category: "factual_detail" as const,
      tier: "explicit-pair" as const,
      validator: "llm",
      severity: "error" as const,
      reasoning: "hair colour changed",
      evidence: draftEvidence,
      editLocus: { kind: "draft" as const, quote: draftEvidence.quote },
    };
    const capped = capCraftBlockers([consistency, consistency, consistency, consistency]);
    assert.equal(blocking(capped.findings).length, 4);
    assert.equal(capped.demoted, 0);
  });
});

describe("the repair brief", () => {
  it("puts consistency before craft at equal severity", () => {
    const craft = blockingCraft();
    const consistency = {
      id: "f-2",
      subtype: "knowledge_contradictions",
      axis: "consistency" as const,
      category: "characterization" as const,
      tier: "explicit-pair" as const,
      validator: "llm",
      severity: "error" as const,
      reasoning: "Kerr acts on something he was never told",
      evidence: draftEvidence,
      contradicts: { quote: "Kerr had not been told", source: "s-002" },
      editLocus: { kind: "draft" as const, quote: draftEvidence.quote },
    };
    const brief = renderRepairBrief([craft, consistency]);
    assert.ok(
      brief.indexOf("knowledge_contradictions") < brief.indexOf("nothing_changes"),
      "the axis that is counted by name should be repaired first",
    );
  });

  it("renders canon context as the writer's only source for a fact", () => {
    const brief = renderRepairBrief([
      {
        id: "f-3",
        subtype: "knowledge_contradictions",
        axis: "consistency" as const,
        category: "characterization" as const,
        tier: "explicit-pair" as const,
        validator: "llm",
        severity: "error" as const,
        reasoning: "Kerr cannot know about the note yet",
        evidence: draftEvidence,
        contradicts: { quote: "Kerr was still at the quay", source: "s-002" },
        suggestion: "have Hale tell him, or cut the reference",
        canonContext: 'characters/char-kerr/beliefs.jsonl: "knows_about_note: false as of s-002"',
        editLocus: { kind: "draft" as const, quote: draftEvidence.quote },
      },
    ]);
    assert.match(brief, /what the index says \(you cannot look this up yourself\)/);
    assert.match(brief, /knows_about_note: false/);
  });
});

function blockingCraft() {
  return makeCraftFinding({
    checkId: "nothing_changes",
    severity: "error",
    reasoning: "the scene does not move",
    evidence: draftEvidence,
    statePair: { before: "x", after: "x" },
    suggestion: "give somebody a decision",
  });
}

describe("the dossier", () => {
  const canon = [
    {
      id: "fact-1",
      entity: "char-hale",
      attribute: "location",
      value: "the quay",
      source: "s-002",
    },
  ];

  it("labels a first establishment as normal rather than leaving it as an absence", () => {
    // The whole point. Eleven findings on one run reported "the index has no entry
    // for this" as a contradiction whose other side was the absence, and the run
    // scored 8.4 points below one with five real findings. Said positively, the
    // same fact cannot be misread.
    const rows = compareClaims(
      [{ entity: "obj-note", attribute: "provenance", value: "found in the grate", quote: "q" }],
      canon,
    );
    assert.equal(rows[0]!.verdict, "new");
    const text = renderDossier({
      delta: {
        sceneId: "s-003",
        claims: [
          { entity: "obj-note", attribute: "provenance", value: "found in the grate", quote: "q" },
        ],
        presentEntities: [],
      },
      canon,
      knownEntities: new Set(["obj-note", "char-hale"]),
      deterministic: [],
      words: { draft: 900, sceneTarget: 1000 },
    });
    assert.match(text, /\*\*NEW\*\*/);
    assert.match(text, /not a defect and there is no pair to report/);
  });

  it("hands over both sides of a real conflict", () => {
    const rows = compareClaims(
      [{ entity: "char-hale", attribute: "location", value: "the study", quote: "q" }],
      canon,
    );
    assert.equal(rows[0]!.verdict, "conflicts");
    assert.equal(rows[0]!.canon, "the quay");
  });

  it("distinguishes a declared change from an undeclared one", () => {
    const rows = compareClaims(
      [
        {
          entity: "char-hale",
          attribute: "location",
          value: "the study",
          quote: "q",
          supersedes: { factId: "fact-1", reason: "he walks there in this scene" },
        },
      ],
      canon,
    );
    assert.equal(rows[0]!.verdict, "supersedes");
  });

  it("passes on what the deterministic layer already found", () => {
    // The verifier's standing instructions have always said "read their findings;
    // do not repeat them" while nothing ever passed them. A prompt that refers to
    // information the agent cannot see teaches it that its instructions describe a
    // world it has no access to.
    const text = renderDossier({
      delta: { sceneId: "s-003", claims: [], presentEntities: [] },
      canon,
      knownEntities: new Set(["char-hale"]),
      deterministic: [
        {
          id: "f-9",
          subtype: "nomenclature_confusions",
          axis: "consistency",
          category: "factual_detail",
          tier: "explicit-pair",
          validator: "reference",
          severity: "fatal",
          reasoning: "char-unknown is not in the index",
          evidence: { quote: "q", source: "s-003" },
          contradicts: { quote: "known entities: char-hale", source: "index" },
          editLocus: { kind: "unresolved", question: "create or misspelling?" },
        },
      ],
      words: { draft: 900, sceneTarget: null },
    });
    assert.match(text, /char-unknown is not in the index/);
    assert.match(text, /Do not re-report these/);
  });
});
