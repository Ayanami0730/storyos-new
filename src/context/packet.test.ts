import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { buildContextPacket, countWords } from "./packet.ts";
import { PacketBuildError } from "./types.ts";
import type { ContextItem, PacketRequest } from "./types.ts";

function item(
  id: string,
  priority: ContextItem["priority"],
  words: number,
): ContextItem {
  return {
    id,
    priority,
    source: `index/story/${id}`,
    content: Array.from({ length: words }, (_, i) => `w${i}`).join(" "),
  };
}

/** Run `fn`, assert it threw the expected type, and return the error. */
function captureError<T extends Error>(
  fn: () => unknown,
  type: new (...args: never[]) => T,
): T {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof type, `expected ${type.name}, got ${String(error)}`);
    return error;
  }
  throw new assert.AssertionError({ message: `expected ${type.name} to be thrown` });
}

function request(over: Partial<PacketRequest> = {}): PacketRequest {
  return {
    sceneId: "s-001",
    baseCommitId: "commit-3",
    hardRequiredIds: [],
    budgetWords: 100,
    ...over,
  };
}

describe("countWords", () => {
  it("splits on whitespace and ignores empties", () => {
    assert.equal(countWords("  a   b\nc\t d "), 4);
    assert.equal(countWords(""), 0);
  });
});

describe("a missing hard-required id fails the build", () => {
  it("throws and names every missing id", () => {
    const err = captureError(
      () =>
        buildContextPacket(
          request({ hardRequiredIds: ["scene-card", "world-rules"] }),
          [item("scene-card", "P0", 10)],
        ),
      PacketBuildError,
    );
    assert.deepEqual(err.missingIds, ["world-rules"]);
    assert.match(err.message, /missing hard-required ids: world-rules/);
  });

  it("never substitutes or silently omits", () => {
    // The whole point: no packet is produced at all.
    assert.throws(
      () =>
        buildContextPacket(request({ hardRequiredIds: ["absent"] }), [
          item("something-else", "P0", 5),
        ]),
      PacketBuildError,
    );
  });
});

describe("mandatory tiers are never dropped for budget", () => {
  it("refuses to build when P0+P1 exceed the budget", () => {
    const err = captureError(
      () =>
        buildContextPacket(request({ budgetWords: 30 }), [
          item("card", "P0", 20),
          item("beliefs", "P1", 20),
        ]),
      PacketBuildError,
    );
    assert.match(err.message, /mandatory tiers need 40 words but the budget is 30/);
    assert.deepEqual([...err.overflowPriorities].sort(), ["P0", "P1"]);
  });

  it("keeps P0/P1 and drops lower tiers when the budget is tight", () => {
    const packet = buildContextPacket(request({ budgetWords: 60 }), [
      item("card", "P0", 20),
      item("beliefs", "P1", 20),
      item("prev-scene", "P2", 30),
      item("background", "P4", 30),
    ]);
    assert.deepEqual(packet.coverage.includedIds, ["card", "beliefs"]);
    assert.deepEqual(
      packet.coverage.excluded.map((e) => e.id),
      ["prev-scene", "background"],
    );
    assert.equal(packet.coverage.complete, false);
  });
});

describe("priority order, not similarity", () => {
  it("fills strictly by tier regardless of input order", () => {
    const packet = buildContextPacket(request({ budgetWords: 1000 }), [
      item("background", "P4", 1),
      item("remote", "P3", 1),
      item("card", "P0", 1),
      item("prev", "P2", 1),
      item("beliefs", "P1", 1),
    ]);
    assert.deepEqual(packet.coverage.includedIds, [
      "card",
      "beliefs",
      "prev",
      "remote",
      "background",
    ]);
  });

  it("lets a P2 item lose to the budget even when listed first", () => {
    const packet = buildContextPacket(request({ budgetWords: 25 }), [
      item("prev", "P2", 20),
      item("card", "P0", 20),
    ]);
    assert.deepEqual(packet.coverage.includedIds, ["card"]);
  });
});

describe("hard-required items survive the budget", () => {
  it("includes a hard-required low-tier item even if it overflows", () => {
    const packet = buildContextPacket(
      request({ budgetWords: 25, hardRequiredIds: ["triggered-contract"] }),
      [item("card", "P0", 20), item("triggered-contract", "P2", 20)],
    );
    assert.deepEqual(packet.coverage.includedIds, ["card", "triggered-contract"]);
    assert.equal(packet.coverage.usedWords, 40);
    assert.ok(
      packet.coverage.usedWords > packet.coverage.budgetWords,
      "an explicit hard requirement may exceed budget; the report must show it",
    );
  });
});

describe("coverage report", () => {
  it("accounts for every item per tier", () => {
    const packet = buildContextPacket(request({ budgetWords: 45 }), [
      item("card", "P0", 10),
      item("beliefs", "P1", 10),
      item("prev", "P2", 10),
      item("remote-a", "P3", 10),
      item("remote-b", "P3", 10),
    ]);
    const { byPriority, usedWords } = packet.coverage;
    assert.deepEqual(byPriority.P0, { included: 1, excluded: 0, words: 10 });
    assert.deepEqual(byPriority.P1, { included: 1, excluded: 0, words: 10 });
    assert.deepEqual(byPriority.P2, { included: 1, excluded: 0, words: 10 });
    assert.deepEqual(byPriority.P3, { included: 1, excluded: 1, words: 10 });
    assert.equal(usedWords, 40);
  });

  it("reports complete when nothing was dropped", () => {
    const packet = buildContextPacket(request({ budgetWords: 100 }), [
      item("card", "P0", 5),
    ]);
    assert.equal(packet.coverage.complete, true);
    assert.deepEqual(packet.coverage.excluded, []);
  });

  it("carries the base commit so a stale packet is detectable", () => {
    const packet = buildContextPacket(
      request({ baseCommitId: "commit-9" }),
      [item("card", "P0", 5)],
    );
    assert.equal(packet.coverage.baseCommitId, "commit-9");
    assert.match(packet.rendered, /base_commit: commit-9/);
  });
});

describe("rendering", () => {
  it("groups by tier and keeps provenance on every item", () => {
    const packet = buildContextPacket(request(), [
      item("card", "P0", 3),
      item("prev", "P2", 3),
    ]);
    assert.match(packet.rendered, /## P0[\s\S]*### card  <index\/story\/card>/);
    assert.match(packet.rendered, /## P2[\s\S]*### prev  <index\/story\/prev>/);
    assert.ok(
      packet.rendered.indexOf("## P0") < packet.rendered.indexOf("## P2"),
      "tiers must render in priority order",
    );
  });
});

describe("input validation", () => {
  it("rejects a non-positive budget", () => {
    assert.throws(() => buildContextPacket(request({ budgetWords: 0 }), []), PacketBuildError);
  });

  it("rejects duplicate item ids", () => {
    assert.throws(
      () => buildContextPacket(request(), [item("x", "P0", 1), item("x", "P1", 1)]),
      /duplicate context item id: x/,
    );
  });
});
