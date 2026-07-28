import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { PartitionWriter } from "../index/backfill.ts";
import { CanonicalIndex } from "../index/commit.ts";
import { initialiseProject } from "../index/tree.ts";
import { indexManagerTools } from "./index-manager-tools.ts";

async function foldTool() {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-fold-"));
  const index = new CanonicalIndex(root);
  await index.init("genesis");
  await initialiseProject(root, { premise: "p", targetWords: 4000 });
  const writer = new PartitionWriter(index, "s-002");
  const tools = indexManagerTools(() => writer) as {
    name: string;
    execute: (id: string, args: unknown) => Promise<{ content: { text: string }[] }>;
  }[];
  const fold = tools.find((t) => t.name === "fold_scene")!;
  return {
    writer,
    run: async (args: unknown) => (await fold.execute("1", args)).content[0]!.text,
  };
}

describe("folding a whole scene in one call", () => {
  /**
   * The round-trip this exists to remove. Folding one scene meant
   * `record_relation_phase` 29 times, `append_event` 26, `append_state` 23,
   * `append_beliefs` 22 — 228 tool calls in 228 separate replies on a
   * 20,000-word run, 24% of its wall clock, because the array parameters were
   * scoped to one character each.
   */
  it("writes every partition from a single call", async () => {
    const { writer, run } = await foldTool();
    const reply = await run({
      characters: [
        { id: "char-rue", name: "Rue", sketch: "the ledger girl", identity: [] },
        { id: "char-loren", name: "Loren", sketch: "the tailor", identity: [] },
      ],
      entities: [{ kind: "location", id: "loc-hall", sketch: "the great hall" }],
      state: [
        {
          character: "char-rue",
          entries: [{ attribute: "location", value: "loc-hall", quote: "Rue crossed the hall." }],
        },
        {
          character: "char-loren",
          entries: [{ attribute: "mood", value: "wary", quote: "Loren watched the door." }],
        },
      ],
      beliefs: [
        {
          character: "char-rue",
          entries: [
            { proposition: "the Folio is public", stance: "knows", quote: "The list was up." },
          ],
        },
      ],
      relations: [
        {
          participants: ["char-rue", "char-loren"],
          relation: "wary allies",
          transition: "He showed her the seam and did not report her.",
          span: "L10-L20",
        },
      ],
      events: [{ summary: "Rue crosses the hall", participants: ["char-rue"] }],
      rhythm: { beat: "setup", tension_target: 3, tension_actual: 3, note: "quiet open" },
      promises: [{ id: "pc-folio", promise: "the Folio will be read", quote: "The list was up." }],
    });
    assert.match(reply, /folded: \d+ write\(s\) applied/);
    assert.doesNotMatch(reply, /refused/);

    const touched = writer.writes().map((w) => w.relPath);
    for (const expected of [
      "characters/char-rue/profile.yaml",
      "characters/char-loren/profile.yaml",
      "characters/char-rue/state.jsonl",
      "characters/char-loren/state.jsonl",
      "characters/char-rue/beliefs.jsonl",
      "locations/loc-hall.yaml",
      "relations/char-loren--char-rue.yaml",
      "events/timeline.jsonl",
      "novel/outline/rhythm.csv",
      "continuity/plot-contracts.jsonl",
    ]) {
      assert.ok(
        touched.includes(expected),
        `${expected} not written; got:\n${touched.join("\n")}`,
      );
    }
  });

  /**
   * One bad entry must cost that entry. A single call that failed whole would be
   * worse than the per-partition tools it replaces — the model would lose a
   * scene's work to one mistyped attribute name.
   */
  it("refuses the bad entry and keeps the rest", async () => {
    const { writer, run } = await foldTool();
    const reply = await run({
      characters: [{ id: "char-rue", name: "Rue", sketch: "the ledger girl", identity: [] }],
      entities: [{ kind: "spaceship", id: "obj-nope", sketch: "not a kind" }],
      state: [
        {
          character: "char-rue",
          entries: [{ attribute: "mood", value: "steady", quote: "She did not flinch." }],
        },
      ],
    });
    assert.match(reply, /1 refused/);
    assert.match(reply, /entity obj-nope/);
    assert.match(reply, /location, object or faction/);
    const touched = writer.writes().map((w) => w.relPath);
    assert.ok(touched.includes("characters/char-rue/profile.yaml"));
    assert.ok(touched.includes("characters/char-rue/state.jsonl"));
    assert.ok(!touched.some((p) => p.includes("obj-nope")));
  });

  /**
   * Order is fixed rather than left to the caller: state is appended against an
   * identity that has to exist first, and a promise has to be registered before
   * the same scene can pay it off.
   */
  it("registers a promise before paying it off in the same scene", async () => {
    const { run } = await foldTool();
    const reply = await run({
      promises: [{ id: "pc-seam", promise: "the seam will matter", quote: "He tugged the seam." }],
      payoffs: [{ contract_id: "pc-seam", quote: "The seam gave way." }],
    });
    assert.doesNotMatch(reply, /refused/);
    assert.match(reply, /pc-seam registered/);
    assert.match(reply, /pc-seam paid off/);
  });

  it("still offers the single-partition tools for corrections", async () => {
    const { run: _ } = await foldTool();
    const root = await mkdtemp(path.join(tmpdir(), "storyos-fold-"));
    const index = new CanonicalIndex(root);
    await index.init("genesis");
    await initialiseProject(root, { premise: "p", targetWords: 4000 });
    const names = (indexManagerTools(() => new PartitionWriter(index, "s-002")) as {
      name: string;
    }[]).map((t) => t.name);
    assert.ok(names.includes("fold_scene"));
    for (const t of ["append_state", "append_beliefs", "record_relation_phase", "append_event"]) {
      assert.ok(names.includes(t), `${t} should remain available`);
    }
  });
});
