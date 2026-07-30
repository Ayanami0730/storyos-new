import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  type CompactableMessage,
  type CompactionThresholds,
  DEFAULT_THRESHOLDS,
  compactLevel1,
  compactLevel2,
  effectiveBudget,
  estimateTokens,
  evictablePayloadTokens,
  levelFor,
  summaryPrompt,
  thresholdsFor,
} from "./compaction.ts";

const T: CompactionThresholds = { ...DEFAULT_THRESHOLDS };

/** The one configuration every system runs under; see `budget.ts`. */
const SHARED_LIKE = { inputCeiling: 256_000, maxCompletionTokens: 32_768 };

function msg(over: Partial<CompactableMessage> = {}): CompactableMessage {
  return {
    role: "assistant",
    kind: "assistant",
    tokens: 100,
    text: "some text",
    ...over,
  };
}

function toolResult(i: number, tokens = 5_000): CompactableMessage {
  return msg({
    kind: "toolResult",
    tokens,
    toolCallId: `call-${i}`,
    toolName: "run_command",
    artifactPath: `runtime/artifacts/a-${i}.txt`,
    digest: `grep of scene ${i}`,
    text: "x".repeat(tokens * 4),
  });
}

describe("thresholds", () => {
  it("reserves output room before measuring anything", () => {
    // 256k ceiling less the output reservation, which is capped at 20k: 236k.
    assert.equal(effectiveBudget(T), 236_000);
  });

  it("escalates through the three tiers", () => {
    const E = effectiveBudget(T);
    assert.equal(levelFor(1_000, T), "none");
    assert.equal(levelFor(E * 0.7, T), "level1");
    assert.equal(levelFor(E - 12_000, T), "level2");
    assert.equal(levelFor(E - 2_000, T), "block");
  });

  it("blocks before the window is actually full, not after", () => {
    // The point of blocking early is that a turn needs room to answer in.
    assert.equal(levelFor(effectiveBudget(T) - T.blockReserve, T), "block");
  });
});

describe("the cost trigger, which asks a different question than headroom", () => {
  const bulky = (n: number, tokens: number) => [
    msg({ kind: "user", text: "build the packet", pinned: true }),
    ...Array.from({ length: n }, (_, i) => ({ ...toolResult(i), tokens })),
  ];

  it("counts only what level 1 would actually evict", () => {
    // The recent tail is kept, so it is not a saving and must not be counted as
    // one. Fifteen results at 2k with a tail of ten leaves five evictable.
    const bulk = evictablePayloadTokens(bulky(15, 2_000), T);
    assert.equal(bulk, 5 * 2_000);
  });

  it("counts nothing when everything is inside the kept tail", () => {
    assert.equal(evictablePayloadTokens(bulky(T.keepRecentToolResults, 9_000), T), 0);
  });

  it("never counts a pinned message", () => {
    const history = bulky(15, 2_000).map((m, i) =>
      i === 1 ? { ...m, pinned: true } : m,
    );
    assert.equal(evictablePayloadTokens(history, T), 4 * 2_000);
  });

  it("sees the cost that the overflow thresholds are blind to", () => {
    // The measurement behind this: the context-builder's transcript reached
    // 154k against a 165k overflow trigger — so "no compaction needed" — while
    // that turn made 30 tool calls and billed 3.6M tokens, because every call
    // re-sends the whole prompt. Headroom said fine; the bill said 81% of the
    // run. The two questions are different and only one of them was being asked.
    const history = bulky(40, 4_000);
    assert.equal(levelFor(154_000, thresholdsFor(SHARED_LIKE)), "none");
    assert.ok(evictablePayloadTokens(history, T) > T.level1PayloadTokens);
  });
});

describe("what compaction must not touch", () => {
  it("marks only the messages it evicted", () => {
    const history = [
      msg({ kind: "user", text: "build the packet", pinned: true }),
      ...Array.from({ length: 13 }, (_, i) => toolResult(i)),
      msg({ text: "done" }),
    ];
    const r = compactLevel1(history, T);
    const marked = r.messages.filter((m) => m.evicted);

    // The caller rewrites a pi message only where this flag is set. It used to
    // work out "did this change?" by joining every block's `.text` and
    // comparing — and a toolCall block has no `.text`, so an assistant message
    // that called a tool never matched itself, was flattened into plain text,
    // and lost the `tool_calls` its results were answers to. The provider then
    // rejected the whole next request. The flag exists so that inference is
    // never attempted again.
    assert.equal(marked.length, 13 - T.keepRecentToolResults);
    for (const m of marked) assert.equal(m.kind, "toolResult");
    assert.equal(r.messages.filter((m) => m.kind !== "toolResult" && m.evicted).length, 0);
  });

  it("leaves the kept tail and the pinned instruction unmarked", () => {
    const history = [
      msg({ kind: "user", text: "standing instruction", pinned: true }),
      ...Array.from({ length: 12 }, (_, i) => toolResult(i)),
    ];
    const r = compactLevel1(history, T);
    assert.equal(r.messages[0]!.evicted, undefined);
    // The last ten tool results are the working set; evicting those would make
    // the agent re-read what it just looked at.
    for (const m of r.messages.slice(-T.keepRecentToolResults)) {
      assert.equal(m.evicted, undefined);
    }
  });
});

describe("level 1 — evict what can be re-fetched", () => {
  const history = [
    msg({ kind: "user", text: "write scene 1", pinned: true }),
    ...Array.from({ length: 15 }, (_, i) => toolResult(i)),
    msg({ text: "drafted" }),
  ];

  it("keeps the most recent tool results verbatim", () => {
    const r = compactLevel1(history, T);
    const kept = r.messages.filter(
      (m) => m.kind === "toolResult" && !m.text.startsWith("[tool result evicted]"),
    );
    assert.equal(kept.length, T.keepRecentToolResults);
  });

  it("evicts the older ones and leaves a handle, not a hole", () => {
    const r = compactLevel1(history, T);
    const evictedMsg = r.messages.find((m) => m.text.startsWith("[tool result evicted]"))!;
    assert.match(evictedMsg.text, /run_command \(call-0\)/);
    assert.match(evictedMsg.text, /grep of scene 0/);
    // The agent must be able to look again; that is what makes eviction safe.
    assert.match(evictedMsg.text, /Re-read at runtime\/artifacts\/a-0\.txt/);
  });

  it("tells the agent to re-run when there is no artifact to point at", () => {
    const withoutArtifact = Array.from({ length: 13 }, (_, i) => {
      const { artifactPath: _dropped, ...rest } = toolResult(i);
      return i === 0 ? rest : toolResult(i);
    });
    const r = compactLevel1(withoutArtifact, T);
    assert.match(r.messages[0]!.text, /Re-run the call to see it again/);
  });

  it("reclaims essentially all of what it evicts", () => {
    const r = compactLevel1(history, T);
    assert.equal(r.evicted.length, 5);
    // Five results of 5,000 tokens were evicted; what replaces them is a
    // one-line handle each. The ceiling on level 1 is how many results it is
    // allowed to keep verbatim, not how well it compresses the rest.
    const reclaimed = r.tokensBefore - r.tokensAfter;
    assert.ok(reclaimed > 5 * 5_000 * 0.95, `only reclaimed ${reclaimed}`);
  });

  it("never touches a pinned message", () => {
    const r = compactLevel1(history, T);
    assert.equal(r.messages[0]!.text, "write scene 1");
  });
});

describe("level 2 — fold history, keep a tail", () => {
  const history = [
    msg({ kind: "user", text: "the standing brief", pinned: true }),
    ...Array.from({ length: 30 }, (_, i) => msg({ text: `turn ${i}`, tokens: 1_000 })),
  ];

  const context = {
    canonDigest: "12 facts across 4 entities",
    openPromises: ["the locked box is never opened"],
    recentSceneIds: ["s-009", "s-010"],
  };

  it("keeps a verbatim recent tail and folds the rest", async () => {
    const r = await compactLevel2(history, () => "SUMMARY", context, T);
    assert.equal(r.summarised, 30 - T.keepRecentMessages);
    const tail = r.messages.slice(-T.keepRecentMessages);
    assert.equal(tail.at(-1)!.text, "turn 29");
  });

  it("keeps pinned messages out of the fold", async () => {
    const r = await compactLevel2(history, () => "SUMMARY", context, T);
    assert.equal(r.messages[0]!.text, "the standing brief");
    assert.equal(r.messages[1]!.kind, "summary");
  });

  it("reclaims space", async () => {
    const r = await compactLevel2(history, () => "SUMMARY", context, T);
    assert.ok(r.tokensAfter < r.tokensBefore / 2);
  });

  it("does nothing when there is no old history to fold", async () => {
    const short = [msg({ text: "a" }), msg({ text: "b" })];
    const r = await compactLevel2(short, () => "SUMMARY", context, T);
    assert.equal(r.summarised, 0);
    assert.deepEqual(r.messages, short);
  });
});

describe("the summary prompt", () => {
  const input = {
    folded: [msg({ text: "drafted s-003" })],
    canonDigest: "12 facts across 4 entities",
    openPromises: ["the locked box is never opened"],
    recentSceneIds: ["s-003"],
  };

  it("forbids the summary from restating story facts", () => {
    const p = summaryPrompt(input);
    assert.match(p, /Do NOT restate story facts/);
    // The reason matters more than the rule; an agent given only the rule will
    // find an edge case where restating seems helpful.
    assert.match(p, /second source of truth that nobody can check/);
  });

  it("asks for the things that are genuinely unrecoverable", () => {
    const p = summaryPrompt(input);
    assert.match(p, /how to do your role better/);
    assert.match(p, /finding\s+you disagreed with and why/);
  });

  it("names canon and promises as pointers rather than restating them", () => {
    const p = summaryPrompt(input);
    assert.match(p, /Canon currently in force: 12 facts across 4 entities/);
    assert.match(p, /Open promises: the locked box is never opened/);
  });
});

describe("token estimate", () => {
  it("is rough and cheap, which is all a threshold needs", () => {
    // 3.2 ASCII characters per token, with a floor of one for any non-empty
    // string: rounding a real cost down to zero is the one error a threshold
    // cannot absorb.
    assert.equal(estimateTokens("abc"), 1);
    assert.equal(estimateTokens("a".repeat(3200)), 1000);
  });

  it("never under-counts non-ASCII, which is how a threshold stops firing", () => {
    // A flat length/4 divisor reads CJK at a quarter of its real cost, so a
    // session full of it never crosses the threshold and compaction silently
    // never runs. Popia hit exactly this and reweighted to 1.2 chars per token.
    assert.ok(estimateTokens("的".repeat(100)) > estimateTokens("a".repeat(100)) * 2);
    assert.equal(estimateTokens("的".repeat(1200)), 1012);
  });

  it("counts a short string as at least one token, and empty as none", () => {
    assert.equal(estimateTokens(""), 0);
    assert.equal(estimateTokens("a"), 1);
  });
});

describe("the per-role summary schema", () => {
  /**
   * Why one prompt for five roles was not enough.
   *
   * A summary is written under length pressure, and under pressure a model
   * compresses whatever is longest rather than whatever is load-bearing. What is
   * load-bearing differs completely by role and none of it is inferable from a
   * generic instruction: the context-builder's is a map of where things live in this
   * book's index, the verifier's is the false positives it has been talked out of,
   * the orchestrator's is why it revised the plan and which scenes carry known
   * defects.
   */
  const input = {
    folded: [{ role: "user", kind: "user" as const, tokens: 10, text: "t" }],
    canonDigest: "12 facts",
    openPromises: ["pc-a"],
    recentSceneIds: ["s-003"],
  };

  it("tells each role what it cannot recover from the index", () => {
    const orchestrator = summaryPrompt({ ...input, role: "orchestrator" });
    assert.match(orchestrator, /As the orchestrator/);
    assert.match(orchestrator, /every plan revision you made and the reason/);
    assert.match(orchestrator, /carry unresolved findings/);

    const builder = summaryPrompt({ ...input, role: "context-builder" });
    assert.match(builder, /where things live in \*this\* book's index/);
    assert.match(builder, /which searches came back empty/);

    const verifier = summaryPrompt({ ...input, role: "verifier" });
    assert.match(verifier, /false positive you were talked out of/);
  });

  it("names what each role may drop, and it is always re-readable", () => {
    // The pairing is what makes the instruction actionable: "keep everything
    // important" is not a decision, and "the prose is in the manuscript so drop it"
    // is.
    for (const role of [
      "orchestrator",
      "context-builder",
      "writer",
      "verifier",
      "index-manager",
    ] as const) {
      assert.match(summaryPrompt({ ...input, role }), /Safe to drop: /, role);
    }
  });

  it("stays the generic prompt when no role is given", () => {
    const generic = summaryPrompt(input);
    assert.ok(!generic.includes("cannot recover from the index"));
    // The shared half must survive: a summary that asserts canon becomes a second
    // source of truth nobody can check.
    assert.match(generic, /Do NOT restate story facts/);
  });

  it("keeps the never-compress list ahead of the role list", () => {
    // Order is the priority signal. Where the story stands and what the agent was
    // part-way through outrank anything role-specific, because those are what a
    // summary exists for at all.
    const p = summaryPrompt({ ...input, role: "writer" });
    assert.ok(p.indexOf("NEVER compress") < p.indexOf("As the writer"));
  });
});

describe("the orchestrator compacts on its own schedule", () => {
  /**
   * Measured on a 25-scene 60k run: its transcript reached 131,181 tokens and
   * stopped there, below the 165,200 that trips the shared level 1, so it was never
   * compacted while billing 36% of the run's tokens. The brief re-supplies its state
   * every scene, so the history it keeps is largely a staler copy of that.
   */
  it("trips level 1 at a size the shared schedule ignores", () => {
    const shared = thresholdsFor(SHARED_LIKE);
    const orch = thresholdsFor(SHARED_LIKE, "orchestrator");
    const measured = 131_181;
    assert.equal(levelFor(measured, shared), "none", "this is the bug being fixed");
    assert.notEqual(levelFor(measured, orch), "none");
  });

  it("leaves every other role on the shared schedule", () => {
    for (const role of ["writer", "verifier", "context-builder", "index-manager"]) {
      assert.deepEqual(thresholdsFor(SHARED_LIKE, role), thresholdsFor(SHARED_LIKE));
    }
  });

  it("evicts stale payload sooner, since a turn re-sends it once per tool call", () => {
    assert.ok(
      thresholdsFor(SHARED_LIKE, "orchestrator").level1PayloadTokens <
        thresholdsFor(SHARED_LIKE).level1PayloadTokens,
    );
  });
});
