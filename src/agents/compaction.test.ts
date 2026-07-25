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
  levelFor,
  summaryPrompt,
} from "./compaction.ts";

const T: CompactionThresholds = { ...DEFAULT_THRESHOLDS };

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
    // 400k window, 128k max output, capped at 20k: 380k to work in.
    assert.equal(effectiveBudget(T), 380_000);
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
    assert.equal(estimateTokens("abcd"), 1);
    assert.equal(estimateTokens("a".repeat(4001)), 1001);
  });
});
