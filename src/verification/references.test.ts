import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { PartitionWriter } from "../index/backfill.ts";
import { CanonicalIndex } from "../index/commit.ts";
import { initialiseProject, paths } from "../index/tree.ts";
import { checkReferences, renderReferenceReport } from "./references.ts";

/** A project with one committed scene's worth of backfill. */
async function seeded(options: { withLocationFile: boolean }) {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-refs-"));
  const index = new CanonicalIndex(root);
  await index.init("genesis");
  await initialiseProject(root, { premise: "p", targetWords: 4000 });

  const writer = new PartitionWriter(index, "s-001");
  await writer.upsertCharacter({
    id: "char-araine",
    name: "Araine",
    sketch: "cartographer",
    identity: { profession: "cartographer" },
  });
  await writer.appendState("char-araine", [
    { attribute: "location", value: "loc-docks", quote: "on the docks" },
  ]);
  await writer.appendEvent({ summary: "she resurveys", participants: ["char-araine"] });
  if (options.withLocationFile) {
    await writer.upsertEntity("location", { id: "loc-docks", sketch: "the working quay" });
  }
  await index.commit({
    txid: "tx-1",
    sceneId: "s-001",
    baseCommitId: await index.head(),
    actor: "index-manager",
    prose: { relPath: paths.scene("ch-01", "s-001"), content: "prose" },
    stateDelta: [{ relPath: paths.sceneDelta("s-001"), content: "{}" }],
    derived: writer.writes(),
  });
  return { root, index };
}

describe("cross-partition links", () => {
  it("passes when every link resolves", async () => {
    const { root } = await seeded({ withLocationFile: true });
    const report = await checkReferences(root, { knownScenes: new Set(["s-001"]) });
    assert.deepEqual(report.dangling, []);
    assert.match(renderReferenceReport(report), /clean/);
  });

  it("finds a location nobody created — invisible to per-file validation", async () => {
    // Every file here is individually well-formed. The defect only exists
    // between them, which is why this check cannot live in a schema.
    const { root } = await seeded({ withLocationFile: false });
    const report = await checkReferences(root, { knownScenes: new Set(["s-001"]) });
    const [dangling] = report.dangling;
    assert.equal(dangling!.kind, "missing-location");
    assert.equal(dangling!.severity, "gap", "an unfilled partition must not block a commit");
    assert.match(dangling!.detail, /char-araine is at loc-docks as of s-001/);
  });

  it("does not demand a file for a prose-shaped location value", async () => {
    // Insisting on a file for "somewhere on the quay" would push writers back
    // towards prose-shaped values everywhere, which is worse than the gap.
    const { root, index } = await seeded({ withLocationFile: true });
    const writer = new PartitionWriter(index, "s-002");
    await writer.appendState("char-araine", [
      { attribute: "location", value: "somewhere on the quay", quote: "q" },
    ]);
    await index.commit({
      txid: "tx-2",
      sceneId: "s-002",
      baseCommitId: await index.head(),
      actor: "index-manager",
      prose: { relPath: paths.scene("ch-01", "s-002"), content: "prose" },
      stateDelta: [{ relPath: paths.sceneDelta("s-002"), content: "{}" }],
      derived: writer.writes(),
    });
    const report = await checkReferences(root, { knownScenes: new Set(["s-001", "s-002"]) });
    assert.deepEqual(report.dangling, []);
  });

  it("calls a relation naming a nonexistent character broken, not a gap", async () => {
    const { root, index } = await seeded({ withLocationFile: true });
    const writer = new PartitionWriter(index, "s-002");
    await writer.recordRelationPhase({
      participants: ["char-araine", "char-ghost"],
      relation: "strangers",
      transition: "they have not met",
      span: "L1-L2",
    });
    await index.commit({
      txid: "tx-2",
      sceneId: "s-002",
      baseCommitId: await index.head(),
      actor: "index-manager",
      prose: { relPath: paths.scene("ch-01", "s-002"), content: "prose" },
      stateDelta: [{ relPath: paths.sceneDelta("s-002"), content: "{}" }],
      derived: writer.writes(),
    });
    const report = await checkReferences(root, { knownScenes: new Set(["s-001", "s-002"]) });
    const broken = report.dangling.filter((d) => d.severity === "broken");
    assert.equal(broken.length, 1);
    assert.equal(broken[0]!.target, "char-ghost");
  });

  it("flags a state entry attributed to a scene that does not exist", async () => {
    const { root } = await seeded({ withLocationFile: true });
    const report = await checkReferences(root, { knownScenes: new Set(["s-999"]) });
    assert.ok(report.dangling.some((d) => d.kind === "missing-scene"));
  });

  it("counts what it walked, so an empty index is distinguishable from a clean one", async () => {
    const { root } = await seeded({ withLocationFile: true });
    const report = await checkReferences(root);
    assert.equal(report.counts.characters, 1);
    assert.equal(report.counts.state_entries, 1);
    assert.equal(report.counts.events, 1);
  });

  it("survives a malformed file rather than taking the run down with it", async () => {
    const { root } = await seeded({ withLocationFile: true });
    await writeFile(path.join(root, paths.relation("char-a--char-b")), ":::not yaml:::", "utf8");
    await assert.doesNotReject(() => checkReferences(root));
  });
});
