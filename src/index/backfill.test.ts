import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { parse as fromYaml } from "yaml";

import { BackfillError, PartitionWriter, type PlotContract } from "./backfill.ts";
import { CanonicalIndex } from "./commit.ts";
import { currentState, parseJsonl, type StateEntry } from "./entities.ts";
import type { RelationRecord } from "./relations.ts";
import { initialiseProject, paths } from "./tree.ts";

async function writerFor(sceneId: string) {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-backfill-"));
  const index = new CanonicalIndex(root);
  await index.init("genesis");
  await initialiseProject(root, { premise: "p", targetWords: 4000 });
  return { index, writer: new PartitionWriter(index, sceneId), root };
}

const content = (writes: readonly { relPath: string; content: string }[], rel: string) =>
  writes.find((w) => w.relPath === rel)?.content ?? "";

describe("character identity", () => {
  it("refuses to file a state attribute as identity", async () => {
    const { writer } = await writerFor("s-001");
    const { conflicts } = await writer.upsertCharacter({
      id: "char-araine",
      name: "Araine",
      sketch: "cartographer",
      identity: { profession: "cartographer", location: "loc-docks" },
    });
    assert.equal(conflicts.length, 1);
    assert.match(conflicts[0]!, /state, not identity/);
    const profile = fromYaml(content(writer.writes(), paths.profile("char-araine"))) as {
      identity: Record<string, string>;
    };
    assert.deepEqual(Object.keys(profile.identity), ["profession"]);
  });

  it("refuses to change an established identity attribute silently", async () => {
    // Silent replacement is how a story ends up with two eye colours and no
    // record of which came first.
    const { writer } = await writerFor("s-001");
    await writer.upsertCharacter({
      id: "char-araine",
      name: "Araine",
      sketch: "s",
      identity: { appearance: "grey eyes" },
    });
    const { conflicts } = await writer.upsertCharacter({
      id: "char-araine",
      name: "Araine",
      sketch: "s",
      identity: { appearance: "green eyes" },
    });
    assert.match(conflicts[0]!, /is a retcon/);
  });

  it("stamps provenance on first write and keeps it", async () => {
    const { writer } = await writerFor("s-001");
    await writer.upsertCharacter({
      id: "char-araine",
      name: "Araine",
      sketch: "s",
      identity: { appearance: "grey eyes" },
    });
    const profile = fromYaml(content(writer.writes(), paths.profile("char-araine"))) as {
      provenance: Record<string, string>;
    };
    assert.equal(profile.provenance.appearance, "s-001");
  });
});

describe("character state", () => {
  it("appends, so moving a character in a later scene is not a contradiction", async () => {
    const { index, writer } = await writerFor("s-002");
    // Pretend s-001 already committed a location.
    const first = new PartitionWriter(index, "s-001");
    await first.appendState("char-araine", [
      { attribute: "location", value: "loc-docks", quote: "on the docks" },
    ]);
    await index.commit({
      txid: "tx-1",
      sceneId: "s-001",
      baseCommitId: await index.head(),
      actor: "index-manager",
      prose: { relPath: paths.scene("ch-01", "s-001"), content: "prose" },
      stateDelta: [{ relPath: paths.sceneDelta("s-001"), content: "{}" }],
      derived: first.writes(),
    });

    await writer.appendState("char-araine", [
      { attribute: "location", value: "loc-charthouse", quote: "through the high window" },
    ]);
    const entries = parseJsonl<StateEntry>(content(writer.writes(), paths.state("char-araine")));
    assert.equal(entries.length, 2, "the earlier observation is kept, not replaced");
    assert.equal(currentState(entries).location!.value, "loc-charthouse");
  });

  it("rejects the event-shaped attribute names the writer actually invented", async () => {
    const { writer } = await writerFor("s-011");
    await assert.rejects(
      () =>
        writer.appendState("char-araine", [
          {
            attribute: "left_market_and_crossed_to_docks",
            value: "true",
            quote: "She left the market",
          },
        ]),
      (error: unknown) => {
        assert.ok(error instanceof BackfillError);
        assert.match(error.problems[0]!, /timeline event/);
        return true;
      },
    );
  });

  it("requires a quote, because an unquoted state change is usually one that did not happen", async () => {
    const { writer } = await writerFor("s-001");
    await assert.rejects(
      () => writer.appendState("char-araine", [{ attribute: "mood", value: "shaken", quote: "" }]),
      /quote is required/,
    );
  });

  it("refuses a location that is a sentence rather than a place", async () => {
    // Observed: `location: "in the Watchhouse, reading the wardens' ledger"`.
    // It merges place with activity, cannot be compared with the next scene's
    // value, and cannot be checked against the location files — so "where is
    // she" stops being answerable by anything except reading the prose.
    const { writer } = await writerFor("s-002");
    await assert.rejects(
      () =>
        writer.appendState("char-mira", [
          {
            attribute: "location",
            value: "in the Watchhouse, reading the wardens' ledger",
            quote: "She sat with the book on her knees and read.",
          },
        ]),
      /is a sentence, not a place/,
    );
  });

  it("accepts a location id or a short place name", async () => {
    const { writer } = await writerFor("s-002");
    await writer.appendState("char-mira", [
      { attribute: "location", value: "loc-watchhouse", quote: "q" },
    ]);
    await writer.appendState("char-mira", [
      { attribute: "location", value: "the lighthouse stair", quote: "q" },
    ]);
    assert.equal(
      parseJsonl<StateEntry>(content(writer.writes(), paths.state("char-mira"))).length,
      2,
    );
  });

  it("sees its own earlier writes within one scene", async () => {
    const { writer } = await writerFor("s-001");
    await writer.appendState("char-araine", [
      { attribute: "location", value: "loc-docks", quote: "q1" },
    ]);
    await writer.appendState("char-araine", [{ attribute: "mood", value: "wary", quote: "q2" }]);
    const entries = parseJsonl<StateEntry>(content(writer.writes(), paths.state("char-araine")));
    assert.equal(entries.length, 2, "two calls in one scene must not lose the first");
  });
});

describe("relation phases — novelty 2's artefact", () => {
  it("produces a record with the transition text a label cannot carry", async () => {
    const { writer } = await writerFor("s-004");
    const { pairId } = await writer.recordRelationPhase({
      participants: ["char-araine", "char-cass"],
      relation: "wary allies",
      transition:
        "He handed her the drawer key rather than deny the ledger existed; complicity replaced suspicion.",
      span: "L44-L60",
      asymmetry: "She reads it as evidence; he reads it as containment.",
    });
    const record = fromYaml(content(writer.writes(), paths.relation(pairId))) as RelationRecord;
    assert.equal(record.phases.length, 1);
    assert.match(record.phases[0]!.transition, /drawer key/);
    assert.equal(record.phases[0]!.toScene, null, "a new phase is open");
    assert.equal(record.phases[0]!.source.span, "L44-L60");
  });

  it("closes only the latest open phase, because overlap is legal", async () => {
    // Two people can be colleagues and rivals at once; closing everything would
    // erase the distinction the schema exists to keep.
    const { writer } = await writerFor("s-004");
    await writer.recordRelationPhase({
      participants: ["char-a", "char-b"],
      relation: "colleagues",
      transition: "assigned to the same survey",
      span: "L1-L5",
    });
    await writer.recordRelationPhase({
      participants: ["char-a", "char-b"],
      relation: "rivals",
      transition: "both put in for the same posting",
      span: "L6-L9",
      closesPrevious: true,
    });
    await writer.recordRelationPhase({
      participants: ["char-a", "char-b"],
      relation: "reconciled",
      transition: "she withdrew her application",
      span: "L10-L14",
      closesPrevious: true,
    });
    const record = fromYaml(
      content(writer.writes(), paths.relation("char-a--char-b")),
    ) as RelationRecord;
    assert.deepEqual(
      record.phases.map((p) => p.toScene),
      ["s-004", "s-004", null],
    );
  });

  it("refuses to open a parallel phase with a new label while one is still open", async () => {
    // The first run produced four open phases for one pair, two with the same
    // label, which reads as "these two are simultaneously four things" and loses
    // the ordering that a phase sequence exists for.
    const { writer } = await writerFor("s-004");
    await writer.recordRelationPhase({
      participants: ["char-a", "char-b"],
      relation: "observer/observed",
      transition: "she watched him work at night",
      span: "L1-L20",
    });
    await assert.rejects(
      () =>
        writer.recordRelationPhase({
          participants: ["char-a", "char-b"],
          relation: "partners",
          transition: "he asked for her help",
          span: "L30-L40",
        }),
      /closes_previous/,
    );
  });

  it("allows continuing the same relation, and genuine simultaneity via that route", async () => {
    const { writer } = await writerFor("s-004");
    for (const span of ["L1-L20", "L30-L40"]) {
      await writer.recordRelationPhase({
        participants: ["char-a", "char-b"],
        relation: "colleagues",
        transition: `deepened at ${span}`,
        span,
      });
    }
    const record = fromYaml(
      content(writer.writes(), paths.relation("char-a--char-b")),
    ) as RelationRecord;
    assert.equal(record.phases.length, 2);
  });

  it("rejects an invalid record instead of writing it", async () => {
    const { writer } = await writerFor("s-004");
    await assert.rejects(
      () =>
        writer.recordRelationPhase({
          participants: ["char-a", "char-a"],
          relation: "self",
          transition: "t",
          span: "L1",
        }),
      /distinct/,
    );
  });
});

describe("promises", () => {
  it("registers idempotently, so a repeat is not a second promise", async () => {
    const { writer } = await writerFor("s-001");
    const promise = { id: "pc-ledger", promise: "what the ledger hides", quote: "q" };
    await writer.registerPromise(promise);
    await writer.registerPromise(promise);
    assert.equal(
      parseJsonl<PlotContract>(content(writer.writes(), paths.plotContracts())).length,
      1,
    );
  });

  it("can actually pay one off — the half that never existed before", async () => {
    const { writer } = await writerFor("s-001");
    await writer.registerPromise({ id: "pc-ledger", promise: "p", quote: "q" });
    await writer.payOffPromise("pc-ledger", "He opened the drawer and read the entry aloud.");
    const [contract] = parseJsonl<PlotContract>(content(writer.writes(), paths.plotContracts()));
    assert.equal(contract!.paidOffBy, "s-001");
    assert.match(contract!.paidOffQuote!, /read the entry aloud/);
  });

  it("says where the open promises are when the id is wrong", async () => {
    const { writer } = await writerFor("s-001");
    await assert.rejects(() => writer.payOffPromise("pc-nope", "q"), /plot-contracts\.jsonl/);
  });
});

describe("story rhythm", () => {
  it("keeps one row per scene in scene order, replacing a rewritten scene's row", async () => {
    const { index } = await writerFor("s-001");
    const w1 = new PartitionWriter(index, "s-002");
    await w1.recordRhythm({ beat: "turn", tensionTarget: 7, tensionActual: 4, note: "flat" });
    const w2 = new PartitionWriter(index, "s-002");
    await w2.recordRhythm({ beat: "turn", tensionTarget: 7, tensionActual: 7, note: "fixed" });
    const csv = content(w2.writes(), paths.rhythm());
    assert.equal(csv.split("\n").filter(Boolean).length, 2, "header plus one row");
    assert.match(csv, /fixed/);
    assert.doesNotMatch(csv, /flat/);
  });

  it("escapes commas in free text so the file stays a csv", async () => {
    const { writer } = await writerFor("s-003");
    await writer.recordRhythm({
      beat: "complication",
      tensionTarget: 6,
      tensionActual: 6,
      note: "she agrees, but only to buy time",
    });
    const row = content(writer.writes(), paths.rhythm()).split("\n")[1]!;
    assert.match(row, /"she agrees, but only to buy time"/);
  });
});

describe("everything lands in one commit", () => {
  it("collects writes across every partition the scene touched", async () => {
    const { index, writer } = await writerFor("s-001");
    await writer.upsertCharacter({
      id: "char-araine",
      name: "Araine",
      sketch: "s",
      identity: { profession: "cartographer" },
    });
    await writer.appendState("char-araine", [
      { attribute: "location", value: "loc-docks", quote: "q" },
    ]);
    await writer.appendBeliefs("char-araine", [
      { proposition: "the city moves", stance: "ignorant-of", quote: "q" },
    ]);
    await writer.recordRelationPhase({
      participants: ["char-araine", "char-cass"],
      relation: "strangers",
      transition: "they have not met",
      span: "L1-L2",
    });
    await writer.appendEvent({ summary: "she resurveys the east slip", participants: ["char-araine"] });
    await writer.recordRhythm({ beat: "setup", tensionTarget: 3, tensionActual: 3, note: "ok" });
    await writer.upsertEntity("location", { id: "loc-docks", sketch: "the working quay" });

    const commit = await index.commit({
      txid: "tx-1",
      sceneId: "s-001",
      baseCommitId: await index.head(),
      actor: "index-manager",
      prose: { relPath: paths.scene("ch-01", "s-001"), content: "prose" },
      stateDelta: [{ relPath: paths.sceneDelta("s-001"), content: "{}" }],
      derived: writer.writes(),
    });

    // One commit id covers prose and every partition: an index that lags the
    // manuscript fails in the direction hardest to notice, because the prose
    // looks right until a later scene reads a partition that never updated.
    assert.ok(commit.writtenPaths.includes(paths.relation("char-araine--char-cass")));
    assert.ok(commit.writtenPaths.includes(paths.state("char-araine")));
    assert.ok(commit.writtenPaths.includes(paths.rhythm()));
    assert.equal(await index.head(), commit.commitId);
    assert.match(await index.read(paths.timeline()), /east slip/);
  });
});
