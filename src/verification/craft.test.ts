import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CRAFT_CHECKS, MAX_BLOCKING_CRAFT, renderCraftChecklist } from "./craft.ts";
import { verifyDeterministic } from "./deterministic.ts";
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
    {
      id: "fact-2",
      entity: "char-hale",
      attribute: "eye_colour",
      value: "grey",
      source: "s-001",
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
      [{ entity: "char-hale", attribute: "eye_colour", value: "brown", quote: "q" }],
      canon,
    );
    assert.equal(rows[0]!.verdict, "conflicts");
    assert.equal(rows[0]!.canon, "grey");
  });

  it("calls a character walking somewhere a move, not a contradiction", () => {
    /**
     * Measured on `runs-070/lbw070` s-002: two children walk from a house to the
     * street, the deterministic layer raised `geographical_contradictions` at
     * severity `error` twice — with the same finding id, because both quoted the
     * same sentence — and the repair loop stalled and committed the scene carrying
     * two recorded defects. Neither was one. The prompt that produced the claim is
     * the writer's own, which gives `location` as the model standing property.
     */
    const rows = compareClaims(
      [{ entity: "char-hale", attribute: "location", value: "the study", quote: "q" }],
      canon,
    );
    assert.equal(rows[0]!.verdict, "moved");

    const findings = verifyDeterministic({
      delta: {
        sceneId: "s-003",
        claims: [
          { entity: "char-hale", attribute: "location", value: "the study", quote: "q" },
          { entity: "char-hale", attribute: "knows_about_note", value: "true", quote: "q" },
        ],
        presentEntities: ["char-hale"],
      },
      canon: [
        ...canon,
        {
          id: "fact-3",
          entity: "char-hale",
          attribute: "knows_about_note",
          value: "false",
          source: "s-002",
        },
      ],
      knownEntities: new Set(["char-hale"]),
    });
    assert.equal(findings.findings.length, 0);
    // Counted rather than silently dropped: this is the number of findings that
    // used to be raised here, every one of them a blocking false positive.
    assert.equal(findings.coverage.volatileChanges, 2);
  });

  it("still blocks a change to something intrinsic", () => {
    const findings = verifyDeterministic({
      delta: {
        sceneId: "s-003",
        claims: [{ entity: "char-hale", attribute: "eye_colour", value: "brown", quote: "q" }],
        presentEntities: ["char-hale"],
      },
      canon,
      knownEntities: new Set(["char-hale"]),
    });
    assert.equal(findings.findings.length, 1);
    assert.equal(findings.findings[0]!.severity, "error");
    assert.equal(findings.coverage.volatileChanges, 0);
  });

  it("shows the verifier the move, since the comparison no longer reports it", () => {
    const text = renderDossier({
      delta: {
        sceneId: "s-003",
        claims: [{ entity: "char-hale", attribute: "location", value: "the study", quote: "q" }],
        presentEntities: [],
      },
      canon,
      knownEntities: new Set(["char-hale"]),
      deterministic: [],
      words: { draft: 900, sceneTarget: null },
    });
    assert.match(text, /not\*\* a contradiction and no declaration is/);
    assert.match(text, /whether the prose \*shows\* it happening/);
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

describe("a value that is a sentence", () => {
  /**
   * Measured on `runs-r1/lbw079`, and the third false positive of this family.
   *
   * Canon held `char-narrator.keeps_written_records = "timestamps and records events
   * in notebook"`; the scene declared `"records timestamps and findings in
   * notebook"`. The same fact, reworded — and this check reported it as a blocking
   * `quantitative_mismatches`, a subtype about counts, reached only because the
   * attribute matched no pattern and that is the fallback.
   *
   * The taxonomy's comparisons are built for *atomic* facts, where two strings
   * really are two claims. A phrase describing behaviour has no canonical wording,
   * so restating it diffs on every scene it appears in, and the writer cannot spend
   * a repair round usefully on it: it has no way to know which phrasing canon
   * prefers.
   */
  const canon = [
    {
      id: "fact-habit",
      entity: "char-narrator",
      attribute: "keeps_written_records",
      value: "timestamps and records events in notebook",
      source: "s-001",
    },
    { id: "fact-eyes", entity: "char-narrator", attribute: "eye_colour", value: "grey", source: "s-001" },
  ];

  const check = (attribute: string, value: string) =>
    verifyDeterministic({
      delta: {
        sceneId: "s-002",
        claims: [{ entity: "char-narrator", attribute, value, quote: "q" }],
        presentEntities: ["char-narrator"],
      },
      canon,
      knownEntities: new Set(["char-narrator"]),
    }).findings;

  it("warns instead of blocking when both sides are phrases", () => {
    const [f] = check("keeps_written_records", "records timestamps and findings in notebook");
    assert.ok(f);
    assert.equal(f!.severity, "warning");
    assert.match(f!.reasoning, /same fact reworded/);
  });

  it("still blocks when the value is atomic", () => {
    // An eye colour has a canonical wording, so two strings are two claims.
    const [f] = check("eye_colour", "brown");
    assert.ok(f);
    assert.equal(f!.severity, "error");
  });

  it("hands the judgement to the verifier rather than dropping it", () => {
    // Degraded, not discarded: the meaning may genuinely have moved, and only a
    // reader can tell. What it must not do is cost a repair round automatically.
    const [f] = check("keeps_written_records", "no longer keeps any notebook at all");
    assert.ok(f, "a phrase-valued change is still reported");
    assert.equal(f!.severity, "warning");
    assert.ok(f!.contradicts, "both sides are quoted so the verifier can compare them");
  });
});
