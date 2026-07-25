import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  RelationRecordError,
  pairId,
  phasesAt,
  renderHistory,
  validateRelationRecord,
} from "./relations.ts";
import type { RelationPhase, RelationRecord } from "./relations.ts";
import { captureError } from "../testing/capture.ts";

function phase(over: Partial<RelationPhase> & { index: number }): RelationPhase {
  return {
    relation: "strangers",
    fromScene: "s-001",
    toScene: null,
    transition: "they are seated at the same table by accident",
    source: { scene: "s-001", span: "L12-L18" },
    ...over,
  };
}

/** The example from docs/02-architecture.md, with the texture a graph cannot hold. */
function miraWarden(): RelationRecord {
  return {
    pairId: pairId("char-mira", "char-warden"),
    participants: ["char-mira", "char-warden"],
    phases: [
      phase({
        index: 1,
        relation: "strangers",
        fromScene: "s-001",
        toScene: "s-004",
        transition: "she takes him for a court clerk and asks him to carry her case",
      }),
      phase({
        index: 2,
        relation: "mentor_student",
        fromScene: "s-005",
        toScene: "s-011",
        transition:
          "she kneels to the wrong man in the rain; he lets the mistake stand because correcting it would expose him",
        asymmetry: "warden mentors mira knowingly; mira suspects nothing",
        source: { scene: "s-005", span: "L44-L60" },
      }),
      phase({
        index: 3,
        relation: "enemies",
        fromScene: "s-012",
        toScene: null,
        transition: "the betrayal is revealed when she finds his seal on the warrant",
        supersedes: 2,
        source: { scene: "s-012", span: "L88-L96" },
      }),
    ],
    openQuestions: ["does mira learn warden's real faction?"],
  };
}

describe("pairId", () => {
  it("is order-independent so one pair maps to one file", () => {
    assert.equal(pairId("b", "a"), pairId("a", "b"));
    assert.equal(pairId("char-mira", "char-warden"), "char-mira--char-warden");
  });
});

describe("what a typed edge cannot hold", () => {
  it("requires a transition on every phase", () => {
    const err = captureError(
      () =>
        validateRelationRecord({
          pairId: pairId("a", "b"),
          participants: ["a", "b"],
          phases: [phase({ index: 1, transition: "   " })],
          openQuestions: [],
        }),
      RelationRecordError,
    );
    assert.ok(
      err.problems.some((p) => /transition must describe how and why/.test(p)),
      "a phase without its cause is just a typed edge",
    );
  });

  it("keeps asymmetry: A's view of B need not equal B's view of A", () => {
    const record = miraWarden();
    const mentor = record.phases.find((p) => p.index === 2);
    assert.match(mentor?.asymmetry ?? "", /mira suspects nothing/);
  });

  it("anchors provenance to a scene and line span, not a chapter", () => {
    const record = miraWarden();
    validateRelationRecord(record);
    for (const p of record.phases) {
      assert.match(p.source.scene, /^s-\d{3,}$/);
      assert.match(p.source.span, /^L\d+(-L\d+)?$/);
    }
  });
});

describe("overlapping phases are allowed", () => {
  it("accepts two relations in force at the same scene", () => {
    const record: RelationRecord = {
      pairId: pairId("a", "b"),
      participants: ["a", "b"],
      phases: [
        phase({ index: 1, relation: "colleagues", fromScene: "s-001", toScene: "s-020" }),
        phase({
          index: 2,
          relation: "rivals",
          fromScene: "s-006",
          toScene: "s-014",
          transition: "both are shortlisted for the same posting",
          source: { scene: "s-006", span: "L3-L9" },
        }),
      ],
      openQuestions: [],
    };
    validateRelationRecord(record);
    const at = phasesAt(record, "s-010").map((p) => p.relation);
    assert.deepEqual(at.sort(), ["colleagues", "rivals"]);
  });
});

describe("phasesAt", () => {
  it("returns only phases in force, excluding superseded ones", () => {
    const record = miraWarden();
    // Phase 2 is superseded by phase 3, so it is not in force even at s-008.
    assert.deepEqual(phasesAt(record, "s-008").map((p) => p.index), []);
    assert.deepEqual(phasesAt(record, "s-002").map((p) => p.relation), ["strangers"]);
    assert.deepEqual(phasesAt(record, "s-020").map((p) => p.relation), ["enemies"]);
  });

  it("treats an open phase as in force forever", () => {
    const record = miraWarden();
    assert.deepEqual(phasesAt(record, "s-999").map((p) => p.relation), ["enemies"]);
  });
});

describe("validation", () => {
  const base = (phases: RelationPhase[]): RelationRecord => ({
    pairId: pairId("a", "b"),
    participants: ["a", "b"],
    phases,
    openQuestions: [],
  });

  it("rejects a self-pair", () => {
    assert.throws(
      () =>
        validateRelationRecord({
          pairId: pairId("a", "a"),
          participants: ["a", "a"],
          phases: [phase({ index: 1 })],
          openQuestions: [],
        }),
      /two distinct entities/,
    );
  });

  it("rejects a pairId that does not match the participants", () => {
    assert.throws(
      () =>
        validateRelationRecord({
          pairId: "wrong--id",
          participants: ["a", "b"],
          phases: [phase({ index: 1 })],
          openQuestions: [],
        }),
      /does not match participants/,
    );
  });

  it("rejects an empty record", () => {
    assert.throws(() => validateRelationRecord(base([])), /at least one phase/);
  });

  it("rejects non-contiguous indices", () => {
    assert.throws(
      () => validateRelationRecord(base([phase({ index: 1 }), phase({ index: 3 })])),
      /indices must be 1\.\.n/,
    );
  });

  it("rejects an inverted interval", () => {
    assert.throws(
      () =>
        validateRelationRecord(
          base([phase({ index: 1, fromScene: "s-010", toScene: "s-002" })]),
        ),
      /toScene precedes fromScene/,
    );
  });

  it("rejects superseding a later or absent phase", () => {
    assert.throws(
      () => validateRelationRecord(base([phase({ index: 1, supersedes: 2 })])),
      /may only supersede an earlier phase/,
    );
    // With contiguous 1..n indices any `supersedes < index` necessarily exists,
    // so the "does not exist" branch is only reachable via a non-positive index.
    assert.throws(
      () => validateRelationRecord(base([phase({ index: 1, supersedes: 0 })])),
      /which does not exist/,
    );
  });

  it("rejects a chapter-style provenance", () => {
    assert.throws(
      () =>
        validateRelationRecord(
          base([phase({ index: 1, source: { scene: "chapter-3", span: "L1" } })]),
        ),
      /is not a scene id/,
    );
  });

  it("collects every problem rather than stopping at the first", () => {
    const err = captureError(
      () =>
        validateRelationRecord(
          base([phase({ index: 1, relation: "", transition: "", fromScene: "nope" })]),
        ),
      RelationRecordError,
    );
    assert.ok(err.problems.length >= 3, `expected several problems, got ${err.problems.length}`);
  });
});

describe("renderHistory", () => {
  it("gives the writer the cause of every change, in order", () => {
    const text = renderHistory(miraWarden());
    assert.match(text, /s-001\.\.s-004\s+strangers/);
    assert.match(text, /how: she kneels to the wrong man in the rain/);
    assert.match(text, /mentor_student \[superseded\]/);
    assert.match(text, /asymmetry: warden mentors mira knowingly/);
    assert.match(text, /open questions:[\s\S]*real faction/);
    assert.ok(
      text.indexOf("strangers") < text.indexOf("enemies"),
      "phases must render in order",
    );
  });
});
