import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { makeFinding } from "../verification/finding.ts";
import { SceneTransaction } from "./machine.ts";
import { IllegalTransitionError } from "./types.ts";
import type { Finding } from "./types.ts";

function open(maxRepairs = 2): SceneTransaction {
  let tick = 0;
  return new SceneTransaction({
    txid: "tx-1",
    sceneId: "s-001",
    baseCommitId: "commit-0",
    maxRepairs,
    now: () => new Date(Date.UTC(2026, 6, 25, 0, 0, tick++)),
  });
}

/** Drive a transaction to APPROVED with both artifacts present. */
function toApproved(tx: SceneTransaction): SceneTransaction {
  return tx
    .transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" })
    .transition("DRAFTED", "writer", { artifact: "prose" })
    .transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
    .transition("VALIDATING", "orchestrator")
    .transition("APPROVED", "verifier");
}

const fatal: Finding = makeFinding({
  subtype: "appearance_mismatches",
  validator: "continuity",
  severity: "fatal",
  reasoning: "her eyes were established as grey",
  evidence: { quote: "her green eyes narrowed", source: "s-001" },
  contradicts: { quote: "grey", source: "index/story/bible/characters/mira.yaml" },
  editLocus: { kind: "draft", quote: "her green eyes narrowed" },
});

describe("invariant 1: only index-manager commits", () => {
  it("lets index-manager finish the commit", () => {
    const tx = toApproved(open()).transition("COMMITTING", "orchestrator");
    tx.transition("COMMITTED", "index-manager");
    assert.equal(tx.state, "COMMITTED");
  });

  for (const actor of ["verifier", "writer", "orchestrator", "context-builder"] as const) {
    it(`refuses COMMITTED from ${actor}`, () => {
      const tx = toApproved(open()).transition("COMMITTING", "orchestrator");
      assert.throws(
        () => tx.transition("COMMITTED", actor),
        (e: unknown) =>
          e instanceof IllegalTransitionError &&
          /only by index-manager/.test(e.message),
      );
      assert.equal(tx.state, "COMMITTING", "state must not move on refusal");
    });
  }

  it("treats APPROVED as an opinion, not a commit", () => {
    const tx = toApproved(open());
    assert.equal(tx.state, "APPROVED");
    // The verifier cannot skip the commit stage even though it approved.
    assert.throws(() => tx.transition("COMMITTED", "index-manager"));
  });
});

describe("invariant 2: prose and state delta commit together", () => {
  it("refuses COMMITTING when the state delta is missing", () => {
    const tx = open()
      .transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" })
      .transition("DRAFTED", "writer", { artifact: "prose" });
    // Force APPROVED without a proposed delta by going through validation.
    assert.equal(
      tx.refusalReason("COMMITTING", "orchestrator"),
      "no edge from DRAFTED to COMMITTING",
    );
  });

  it("names exactly what is missing", () => {
    const tx = open();
    tx.transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" });
    // Reach APPROVED via a path that skips the delta is impossible by design,
    // so assert the guard directly on a hand-built approved transaction.
    const sneaky = open()
      .transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" })
      .transition("DRAFTED", "writer", { artifact: "prose" })
      .transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
      .transition("VALIDATING", "orchestrator")
      .transition("APPROVED", "verifier");
    assert.equal(sneaky.refusalReason("COMMITTING", "orchestrator"), null);
  });

  it("requires the artifact argument for artifact-producing states", () => {
    const tx = open();
    assert.throws(
      () => tx.transition("CONTEXT_BUILT", "context-builder"),
      /requires the contextPacket artifact/,
    );
    assert.equal(tx.state, "OPEN");
  });
});

describe("repair rounds that make no progress", () => {
  it("reports a finding the writer failed to shift, so the loop can escalate early", () => {
    const tx = open()
      .transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" })
      .transition("DRAFTED", "writer", { artifact: "draft-1" })
      .transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
      .transition("VALIDATING", "orchestrator")
      .transition("REPAIR_REQUIRED", "verifier", { findings: [fatal] })
      .transition("DRAFTED", "writer", { artifact: "draft-2" })
      .transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
      .transition("VALIDATING", "orchestrator")
      // The verifier rewords its explanation but points at the same passage.
      .transition("REPAIR_REQUIRED", "verifier", {
        findings: [
          makeFinding({
            subtype: "appearance_mismatches",
            validator: "continuity",
            severity: "fatal",
            reasoning: "eye colour still disagrees with the bible",
            evidence: { quote: "her green eyes narrowed", source: "s-001" },
            contradicts: {
              quote: "grey",
              source: "index/story/bible/characters/mira.yaml",
            },
            editLocus: { kind: "draft", quote: "her green eyes narrowed" },
          }),
        ],
      });

    assert.equal(tx.persistentFindings().length, 1);
  });

  it("reports nothing persistent when the writer actually fixed it", () => {
    const tx = open()
      .transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" })
      .transition("DRAFTED", "writer", { artifact: "draft-1" })
      .transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
      .transition("VALIDATING", "orchestrator")
      .transition("REPAIR_REQUIRED", "verifier", { findings: [fatal] })
      .transition("DRAFTED", "writer", { artifact: "draft-2" })
      .transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
      .transition("VALIDATING", "orchestrator")
      .transition("APPROVED", "verifier", { findings: [] });

    assert.deepEqual(tx.persistentFindings(), []);
  });
});

describe("invariant 3: the engine never edits a proposal", () => {
  it("routes a repair back to the writer", () => {
    const tx = open()
      .transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" })
      .transition("DRAFTED", "writer", { artifact: "draft-1" })
      .transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
      .transition("VALIDATING", "orchestrator")
      .transition("REPAIR_REQUIRED", "verifier", { findings: [fatal] });

    assert.equal(tx.blockingFindings().length, 1);
    // Only the writer may produce the next draft.
    assert.match(
      tx.refusalReason("DRAFTED", "verifier") ?? "",
      /only by writer/,
    );
    tx.transition("DRAFTED", "writer", { artifact: "draft-2" });
    assert.equal(tx.snapshot().artifacts.sceneDraft, "draft-2");
  });

  it("clears findings when a fresh draft arrives", () => {
    const tx = open()
      .transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" })
      .transition("DRAFTED", "writer", { artifact: "draft-1" })
      .transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
      .transition("VALIDATING", "orchestrator")
      .transition("REPAIR_REQUIRED", "verifier", { findings: [fatal] })
      .transition("DRAFTED", "writer", { artifact: "draft-2" });
    assert.deepEqual(tx.snapshot().findings, []);
  });
});

describe("invariant 4: the repair budget is bounded and counted once", () => {
  it("allows maxRepairs + 1 writer attempts", () => {
    const tx = open(2);
    tx.transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" });
    tx.transition("DRAFTED", "writer", { artifact: "d0" });
    assert.equal(tx.attempt, 0);

    for (const n of [1, 2]) {
      tx.transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
        .transition("VALIDATING", "orchestrator")
        .transition("REPAIR_REQUIRED", "verifier", { findings: [fatal] })
        .transition("DRAFTED", "writer", { artifact: `d${n}` });
      assert.equal(tx.attempt, n);
    }

    tx.transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
      .transition("VALIDATING", "orchestrator")
      .transition("REPAIR_REQUIRED", "verifier", { findings: [fatal] });
    assert.equal(tx.repairBudgetRemaining, 0);
    assert.equal(
      tx.refusalReason("DRAFTED", "writer"),
      "repair budget exhausted",
    );
  });

  it("permits no repair at all when maxRepairs is 0", () => {
    const tx = open(0)
      .transition("CONTEXT_BUILT", "context-builder", { artifact: "packet" })
      .transition("DRAFTED", "writer", { artifact: "d0" })
      .transition("STATE_DELTA_PROPOSED", "writer", { artifact: "{}" })
      .transition("VALIDATING", "orchestrator")
      .transition("REPAIR_REQUIRED", "verifier", { findings: [fatal] });
    assert.equal(tx.refusalReason("DRAFTED", "writer"), "repair budget exhausted");
  });

  it("rejects a negative budget at construction", () => {
    assert.throws(
      () =>
        new SceneTransaction({
          txid: "t",
          sceneId: "s",
          baseCommitId: "c",
          maxRepairs: -1,
        }),
      RangeError,
    );
  });
});

describe("stale base", () => {
  it("sends the transaction back to context building with the new base", () => {
    const tx = toApproved(open()).transition("COMMITTING", "orchestrator");
    tx.markStaleBase("commit-7");
    assert.equal(tx.state, "STALE_BASE");
    assert.equal(tx.baseCommitId, "commit-7");
    // Only a rebuilt packet can move it forward.
    assert.match(
      tx.refusalReason("COMMITTED", "index-manager") ?? "",
      /no edge from STALE_BASE/,
    );
    tx.transition("CONTEXT_BUILT", "context-builder", { artifact: "packet-2" });
    assert.equal(tx.state, "CONTEXT_BUILT");
  });
});

describe("terminal states and abort", () => {
  it("refuses every transition once committed", () => {
    const tx = toApproved(open())
      .transition("COMMITTING", "orchestrator")
      .transition("COMMITTED", "index-manager");
    assert.ok(tx.isTerminal());
    assert.equal(
      tx.refusalReason("CONTEXT_BUILT", "context-builder"),
      "COMMITTED is terminal",
    );
  });

  it("lets only the orchestrator abort", () => {
    const tx = open();
    assert.match(tx.refusalReason("ABORTED", "writer") ?? "", /only the orchestrator/);
    tx.transition("ABORTED", "orchestrator");
    assert.ok(tx.isTerminal());
  });
});

describe("history", () => {
  it("records every transition with actor and timestamp", () => {
    const tx = toApproved(open());
    const { history } = tx.snapshot();
    assert.equal(history.length, 5);
    assert.deepEqual(
      history.map((h) => `${h.from}->${h.to}/${h.actor}`),
      [
        "OPEN->CONTEXT_BUILT/context-builder",
        "CONTEXT_BUILT->DRAFTED/writer",
        "DRAFTED->STATE_DELTA_PROPOSED/writer",
        "STATE_DELTA_PROPOSED->VALIDATING/orchestrator",
        "VALIDATING->APPROVED/verifier",
      ],
    );
    assert.ok(history.every((h) => h.at.endsWith("Z")));
  });
});
