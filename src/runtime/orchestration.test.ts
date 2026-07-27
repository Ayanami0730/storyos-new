import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { allocate } from "./allocation.ts";
import { sceneBrief } from "./orchestration.ts";
import { closingLines, openPromisesFrom } from "./story.ts";

function brief(overrides: Partial<Parameters<typeof sceneBrief>[0]> = {}) {
  return sceneBrief({
    sceneId: "s-005",
    intent: "Hale confronts the steward",
    presentEntities: ["char-hale", "char-steward"],
    targetWords: 1200,
    chapter: "ch-02",
    position: { index: 5, total: 10 },
    committed: ["s-001", "s-002", "s-003", "s-004"],
    failed: [],
    allocation: allocate({ sceneIndex: 5, total: 10 }),
    words: { committed: 4800, target: 12000 },
    state: {
      lastSceneClose: "She closed the ledger and did not look at him again.",
      lastScene: { id: "s-004", words: 900, target: 1200 },
      openPromises: [
        { id: "pc-ledger", promise: "the altered ledger line must be explained", dueByScene: "s-006" },
      ],
      upcoming: [{ id: "s-006", intent: "The reveal" }],
      tierBoundary: false,
    },
    ...overrides,
  });
}

describe("the orchestrator's scene brief", () => {
  /**
   * What this pins, and why it is a test rather than a comment.
   *
   * The brief has told the orchestrator to look at the project since the tools
   * existed. Measured on `runs/v062/lbw081`: one `read` call in a whole run, zero
   * `update_plan`, zero `abandon_scene` — nineteen delegations and two plan
   * submissions were its entire output. So the material has to arrive rather than
   * be fetched, exactly as it did for the verifier, and these assertions are the
   * difference between that being true and it being intended.
   */
  it("carries how the last scene ended, verbatim", () => {
    const text = brief();
    assert.match(text, /She closed the ledger and did not look at him again\./);
    assert.match(text, /That is what this scene follows from/);
  });

  it("carries the per-scene length gap, not only the whole-task total", () => {
    // The whole-task number was already here and is not actionable on its own: a
    // scene that came in 300 words short is the thing to say in the next brief.
    assert.match(brief(), /s-004, 900 words against a target of 1200 \(-300\)/);
  });

  it("lists what the story still owes the reader, with its deadline", () => {
    const text = brief();
    assert.match(text, /pc-ledger: the altered ledger line must be explained \(due by s-006\)/);
    assert.match(text, /cannot see this ledger/);
  });

  it("shows the scenes ahead, so a stale plan is checkable", () => {
    assert.match(brief(), /s-006: The reveal/);
  });

  it("demands a plan review when the allowance tier changes", () => {
    const text = brief({ state: { ...stateOf(), tierBoundary: true } });
    assert.match(text, /begins a new allowance tier/);
    assert.match(text, /update_plan` has never been called in any run/);
  });

  it("does not demand a plan review on the first scene", () => {
    // Scene 1 is a tier boundary by definition and there is nothing behind it to
    // review, so the demand would be noise on every run.
    const text = sceneBrief({
      sceneId: "s-001",
      intent: "Open",
      presentEntities: [],
      targetWords: 1200,
      chapter: "ch-01",
      position: { index: 1, total: 10 },
      committed: [],
      failed: [],
      allocation: allocate({ sceneIndex: 1, total: 10 }),
      words: { committed: 0, target: 12000 },
      state: {
        lastSceneClose: null,
        lastScene: null,
        openPromises: [],
        upcoming: [{ id: "s-002", intent: "next" }],
        tierBoundary: true,
      },
    });
    assert.ok(!text.includes("begins a new allowance tier"));
    assert.match(text, /Nothing committed yet/);
  });

  it("says the story has to end on the last scene", () => {
    const text = brief({
      position: { index: 10, total: 10 },
      state: { ...stateOf(), upcoming: [] },
    });
    assert.match(text, /it has to end the story/);
    assert.match(text, /Nothing is planned after this one/);
  });
});

function stateOf(): Parameters<typeof sceneBrief>[0]["state"] {
  return {
    lastSceneClose: "She closed the ledger and did not look at him again.",
    lastScene: { id: "s-004", words: 900, target: 1200 },
    openPromises: [],
    upcoming: [{ id: "s-006", intent: "The reveal" }],
    tierBoundary: false,
  };
}

describe("open promises", () => {
  it("drops a promise once some scene pays it off", () => {
    const open = openPromisesFrom([
      {
        sceneId: "s-001",
        claims: [],
        presentEntities: [],
        promises: [
          { id: "pc-a", promise: "a", quote: "q", dueByScene: "s-003" },
          { id: "pc-b", promise: "b", quote: "q", dueByScene: null },
        ],
      },
      {
        sceneId: "s-002",
        claims: [],
        presentEntities: [],
        paysOff: [{ contractId: "pc-a", quote: "q" }],
      },
    ]);
    assert.deepEqual(
      open.map((p) => p.id),
      ["pc-b"],
    );
  });
});

describe("closing lines", () => {
  it("returns the tail rather than the head", () => {
    const text = Array.from({ length: 100 }, (_, i) => `w${i}`).join(" ");
    const tail = closingLines(text, 5);
    assert.equal(tail, "w95 w96 w97 w98 w99");
  });

  it("is null when there is no previous scene", () => {
    assert.equal(closingLines(null), null);
    assert.equal(closingLines("   "), null);
  });
});
