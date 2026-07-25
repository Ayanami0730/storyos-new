import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type CanonFact,
  type SceneDelta,
  verifyDeterministic,
} from "./deterministic.ts";
import { verifyGlobal } from "./global.ts";

const canon: readonly CanonFact[] = [
  {
    id: "fact-eyes",
    entity: "char-mira",
    attribute: "eye_colour",
    value: "grey",
    source: "s-003",
    span: "L18-L18",
  },
  {
    id: "fact-age",
    entity: "char-mira",
    attribute: "age",
    value: "29",
    source: "s-001",
  },
];

const known = new Set(["char-mira", "char-warden", "loc-harbour"]);

function delta(overrides: Partial<SceneDelta> = {}): SceneDelta {
  return {
    sceneId: "s-011",
    claims: [],
    presentEntities: [],
    ...overrides,
  };
}

describe("deterministic scene checks", () => {
  it("passes a claim that agrees with canon, ignoring case and spacing", () => {
    const result = verifyDeterministic({
      canon,
      knownEntities: known,
      delta: delta({
        claims: [
          {
            entity: "char-mira",
            attribute: "eye_colour",
            value: "  GREY ",
            quote: "her grey eyes",
          },
        ],
      }),
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.coverage.claimsCheckedAgainstCanon, 1);
  });

  it("flags a contradiction and reports both sides with provenance", () => {
    const [finding, ...rest] = verifyDeterministic({
      canon,
      knownEntities: known,
      delta: delta({
        claims: [
          {
            entity: "char-mira",
            attribute: "eye_colour",
            value: "green",
            quote: "her green eyes narrowed",
          },
        ],
      }),
    }).findings;
    assert.equal(rest.length, 0);
    assert.equal(finding!.subtype, "appearance_mismatches");
    assert.equal(finding!.severity, "error");
    assert.equal(finding!.contradicts?.source, "s-003");
    assert.equal(finding!.contradicts?.span, "L18-L18");
  });

  it("does not guess which side is wrong", () => {
    const [finding] = verifyDeterministic({
      canon,
      knownEntities: known,
      delta: delta({
        claims: [
          {
            entity: "char-mira",
            attribute: "eye_colour",
            value: "green",
            quote: "her green eyes narrowed",
          },
        ],
      }),
    }).findings;
    // Assuming the draft is at fault is how v2 deleted good prose to protect a
    // stale fact; the machine only knows the two disagree.
    assert.equal(finding!.editLocus.kind, "unresolved");
  });

  it("accepts a deliberate change when the writer declares what it supersedes", () => {
    const result = verifyDeterministic({
      canon,
      knownEntities: known,
      delta: delta({
        claims: [
          {
            entity: "char-mira",
            attribute: "eye_colour",
            value: "green",
            quote: "the lenses turned her eyes green",
            supersedes: { factId: "fact-eyes", reason: "she wears coloured lenses now" },
          },
        ],
      }),
    });
    assert.deepEqual(result.findings, []);
  });

  it("catches a supersedes that points at the wrong fact", () => {
    const [finding] = verifyDeterministic({
      canon,
      knownEntities: known,
      delta: delta({
        claims: [
          {
            entity: "char-mira",
            attribute: "eye_colour",
            value: "green",
            quote: "the lenses turned her eyes green",
            supersedes: { factId: "fact-age", reason: "mis-referenced" },
          },
        ],
      }),
    }).findings;
    assert.match(finding!.reasoning, /actually contradicts is fact-eyes/);
  });

  it("treats an unknown entity as fatal, because a dangling id silences later checks", () => {
    const result = verifyDeterministic({
      canon,
      knownEntities: known,
      delta: delta({
        claims: [
          {
            entity: "char-mirra",
            attribute: "eye_colour",
            value: "grey",
            quote: "Mirra blinked",
          },
        ],
      }),
    });
    assert.equal(result.findings[0]!.severity, "fatal");
    assert.match(result.findings[0]!.reasoning, /dangling reference/);
  });

  it("checks the present-entity list too, not only the claims", () => {
    const result = verifyDeterministic({
      canon,
      knownEntities: known,
      delta: delta({ presentEntities: ["char-mira", "char-ghost"] }),
    });
    assert.equal(result.findings.length, 1);
    assert.match(result.findings[0]!.evidence.quote, /char-ghost/);
  });

  it("reports coverage without capping it, unlike v2's five-claim audit", () => {
    const claims = Array.from({ length: 40 }, (_, i) => ({
      entity: "char-mira",
      attribute: `attribute_${i}`,
      value: "x",
      quote: `claim ${i}`,
    }));
    const result = verifyDeterministic({
      canon,
      knownEntities: known,
      delta: delta({ claims }),
    });
    assert.equal(result.coverage.claims, 40);
  });
});

const scenes = ["s-001", "s-002", "s-003", "s-004", "s-005"];

describe("global pass over a finished span", () => {
  it("finds a promise that was never paid off", () => {
    const result = verifyGlobal({
      scenes,
      capabilities: [],
      contracts: [
        {
          id: "pc-key",
          promise: "the locked box will be opened",
          introducedIn: "s-002",
          quote: "he pocketed the key without looking at it",
          dueBy: "s-004",
        },
      ],
    });
    assert.equal(result.findings.length, 1);
    assert.equal(result.findings[0]!.subtype, "abandoned_plot_elements");
    // It is committed prose: the layer schedules work, it cannot gate.
    assert.equal(result.findings[0]!.severity, "warning");
  });

  it("spans the revision from the promise to its deadline, not just the deadline", () => {
    const [revision] = verifyGlobal({
      scenes,
      capabilities: [],
      contracts: [
        {
          id: "pc-key",
          promise: "the locked box will be opened",
          introducedIn: "s-002",
          quote: "he pocketed the key",
          dueBy: "s-004",
        },
      ],
    }).revisions;
    // A payoff dropped in at the deadline with no preparation reads worse than
    // the abandonment it fixes.
    assert.deepEqual(revision!.targetScenes, ["s-002", "s-003", "s-004"]);
  });

  it("says nothing about a promise that was paid", () => {
    const result = verifyGlobal({
      scenes,
      capabilities: [],
      contracts: [
        {
          id: "pc-key",
          promise: "the locked box will be opened",
          introducedIn: "s-002",
          quote: "he pocketed the key",
          dueBy: "s-004",
          paidBy: { scene: "s-004", quote: "the lid gave" },
        },
      ],
    });
    assert.deepEqual(result.findings, []);
  });

  it("respects an author who left a thread open on purpose", () => {
    const result = verifyGlobal({
      scenes,
      capabilities: [],
      contracts: [
        {
          id: "pc-sequel",
          promise: "the second ship is never identified",
          introducedIn: "s-002",
          quote: "a second sail on the horizon",
          dueBy: null,
          deliberatelyOpen: "sequel hook, agreed with the author",
        },
      ],
    });
    assert.deepEqual(result.findings, []);
    assert.equal(result.coverage.contractsOpen, 0);
  });

  it("finds an established ability that is never used or taken away", () => {
    const result = verifyGlobal({
      scenes,
      contracts: [],
      capabilities: [
        {
          id: "cap-lockpick",
          entity: "char-mira",
          capability: "can pick any mechanical lock",
          establishedIn: "s-001",
          quote: "no lock had held her since she was twelve",
          exercisedIn: [],
        },
      ],
    });
    assert.equal(result.findings[0]!.subtype, "forgotten_abilities");
  });

  it("accepts an ability the text explicitly revoked", () => {
    const result = verifyGlobal({
      scenes,
      contracts: [],
      capabilities: [
        {
          id: "cap-lockpick",
          entity: "char-mira",
          capability: "can pick any mechanical lock",
          establishedIn: "s-001",
          quote: "no lock had held her since she was twelve",
          exercisedIn: [],
          revokedBy: { scene: "s-003", reason: "her hands were broken" },
        },
      ],
    });
    assert.deepEqual(result.findings, []);
  });

  it("does not blame an ability established in the final scene", () => {
    const result = verifyGlobal({
      scenes,
      contracts: [],
      capabilities: [
        {
          id: "cap-late",
          entity: "char-warden",
          capability: "reads minds",
          establishedIn: "s-005",
          quote: "he had always known what she would say",
          exercisedIn: [],
        },
      ],
    });
    // There was no later scene in which to use it, so silence proves nothing.
    assert.deepEqual(result.findings, []);
  });

  it("refuses to audit an empty span rather than reporting a clean one", () => {
    assert.throws(
      () => verifyGlobal({ scenes: [], contracts: [], capabilities: [] }),
      /at least one scene/,
    );
  });
});
