import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SCHEDULE, allocate, positionOf, renderAllocation, tierFor } from "./allocation.ts";

describe("positionOf", () => {
  /**
   * The midpoint is not a detail. `i / total` puts the last scene at exactly 1.0
   * and `(i - 1) / total` puts the first at exactly 0 — and 0 asserts that the
   * opening scene of a story carries no accumulated-consistency risk at all,
   * which is the one thing about it we can be sure is false.
   */
  it("measures a scene at its midpoint, so no scene sits on an endpoint", () => {
    assert.equal(positionOf(1, 4), 0.125);
    assert.equal(positionOf(4, 4), 0.875);
    assert.ok(positionOf(1, 100) > 0);
    assert.ok(positionOf(100, 100) < 1);
  });

  it("splits a ten-scene story into the 30/30/40 the schedule is written as", () => {
    const tiers = Array.from({ length: 10 }, (_, i) => tierFor(positionOf(i + 1, 10)).tier);
    assert.deepEqual(tiers, [
      "opening",
      "opening",
      "opening",
      "middle",
      "middle",
      "middle",
      "endgame",
      "endgame",
      "endgame",
      "endgame",
    ]);
  });

  /**
   * A one-scene story lands mid-schedule, and that is the right answer rather
   * than a rounding accident. It has to close a story, which argues for the
   * endgame allowance — but it has *nothing behind it* to be inconsistent with,
   * and accumulated prior text is the entire thing the endgame tier is paying to
   * guard against. The middle tier is the honest position for a scene that is
   * both the first and the last.
   */
  it("puts a single-scene story mid-schedule: it ends the story but accumulates nothing", () => {
    assert.equal(tierFor(positionOf(1, 1)).tier, "middle");
  });

  it("clamps rather than extrapolating when an index is out of range", () => {
    // `update_plan` can shorten the story after the loop has read an index, so an
    // index past the total is reachable. Extrapolating would produce a position
    // above 1 and a tier lookup that only works because the last rule is a
    // catch-all.
    assert.equal(positionOf(9, 4), positionOf(4, 4));
    assert.equal(positionOf(0, 4), positionOf(1, 4));
  });
});

describe("allocate", () => {
  it("gives the endgame more of all three levers than the opening", () => {
    const opening = allocate({ sceneIndex: 1, total: 10 });
    const endgame = allocate({ sceneIndex: 10, total: 10 });

    assert.ok(endgame.followUpRounds > opening.followUpRounds);
    assert.ok(endgame.repairRounds > opening.repairRounds);
    assert.ok(endgame.recentScenes > opening.recentScenes);
  });

  it("matches the schedule from the brief: 1 / 3 / 5", () => {
    assert.deepEqual(
      SCHEDULE.map((p) => p.followUpRounds),
      [1, 3, 5],
    );
    assert.deepEqual(
      SCHEDULE.map((p) => p.repairRounds),
      [1, 3, 5],
    );
  });

  /**
   * The reallocation, pinned as a test because it is the part that looks like a
   * regression when read alone. The opening tier gets *fewer* repair rounds than
   * the old flat default of two, and that is the mechanism: rounds not spent
   * where defects are rare are what pay for the tier where they are not.
   */
  it("spends less than the old flat default early, which is what pays for the endgame", () => {
    const OLD_FLAT_DEFAULT = 2;
    assert.ok(allocate({ sceneIndex: 1, total: 10 }).repairRounds < OLD_FLAT_DEFAULT);
    assert.ok(allocate({ sceneIndex: 10, total: 10 }).repairRounds > OLD_FLAT_DEFAULT);
  });

  it("carries a reason, not only a number", () => {
    const endgame = allocate({ sceneIndex: 10, total: 10 });
    // An orchestrator told "you have five rounds" spends five. The rationale is
    // what makes the ceiling a ceiling.
    assert.match(endgame.rationale, /accumulate|degradation/i);
    assert.match(renderAllocation(endgame), /ceiling, not a quota/);
  });

  describe("the uniform arm", () => {
    it("pins every scene to the same allowance and says so", () => {
      const scenes = [1, 5, 10].map((i) =>
        allocate({ sceneIndex: i, total: 10, pinnedRepairs: 2 }),
      );
      assert.deepEqual(
        scenes.map((s) => s.repairRounds),
        [2, 2, 2],
      );
      assert.deepEqual(
        scenes.map((s) => s.followUpRounds),
        [2, 2, 2],
      );
      // Recall depth is pinned too. An arm that varied one lever while pinning
      // the others would not answer "does allocating by position help" — it
      // would answer a question nobody asked.
      assert.deepEqual(
        scenes.map((s) => s.recentScenes),
        [1, 1, 1],
      );
      assert.ok(scenes.every((s) => s.pinned));
      assert.match(scenes[0]!.rationale, /uniform-allocation arm/);
    });

    it("still reports the tier, so a pinned run is comparable scene by scene", () => {
      // Without this the ablation arm produces rows that cannot be lined up
      // against the scheduled arm's, which is the entire purpose of having it.
      assert.equal(allocate({ sceneIndex: 10, total: 10, pinnedRepairs: 2 }).tier, "endgame");
    });

    it("allows a zero pin, which is the no-repair-at-all control", () => {
      const none = allocate({ sceneIndex: 5, total: 10, pinnedRepairs: 0 });
      assert.equal(none.repairRounds, 0);
      assert.ok(none.pinned, "zero is a pin, not an absent value");
    });
  });
});
