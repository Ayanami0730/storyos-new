import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { CanonicalIndex } from "./commit.ts";
import {
  AGENT_ROLES,
  LEDGER_FILES,
  PARTITIONS,
  SCHEMAS,
  chapterFor,
  committedScenes,
  initialiseProject,
  partitionReport,
  paths,
  sceneIndexOf,
} from "./tree.ts";

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-tree-"));
  await initialiseProject(root, {
    premise: "A harbour cartographer discovers the city rearranges itself at night.",
    targetWords: 40_000,
    agentsRoot: path.join(import.meta.dirname, "../../agents"),
  });
  return root;
}

describe("initialisation", () => {
  it("creates every partition, so an agent can see the empty ones", async () => {
    // The first implementation created directories on first write, which meant
    // relations/ did not exist until something wrote a relation — and nothing
    // ever did. An empty partition an agent can list is a prompt to fill it.
    const root = await project();
    const report = await partitionReport(root);
    const missing = Object.entries(report).filter(([, n]) => n === -1);
    assert.deepEqual(missing, [], "no partition may be absent after init");
    assert.ok(PARTITIONS.includes("relations"));
  });

  it("gives every role its own dot-directory with memory and skills", async () => {
    const root = await project();
    for (const role of AGENT_ROLES) {
      const entries = await readdir(path.join(root, paths.agentDir(role)));
      assert.ok(entries.includes("memory"), `${role} memory`);
      assert.ok(entries.includes("skills"), `${role} skills`);
      const index = await readFile(path.join(root, paths.memoryIndex(role)), "utf8");
      assert.match(index, /Memory index/);
    }
  });

  it("copies each role's prompt into the project rather than referencing it", async () => {
    // A run whose prompts changed underneath it cannot be explained afterwards,
    // and the project should stay replayable after the repo moves on.
    const root = await project();
    const prompt = await readFile(path.join(root, paths.agentPrompt("writer")), "utf8");
    assert.match(prompt, /write_staged_scene/);
  });

  it("creates the append-only logs empty, so no reader handles 'absent'", async () => {
    const root = await project();
    for (const rel of LEDGER_FILES) {
      assert.equal(await readFile(path.join(root, rel), "utf8"), "", rel);
    }
  });

  it("writes the rhythm file with a header, because 起承转合 has to be checkable", async () => {
    const root = await project();
    const rhythm = await readFile(path.join(root, paths.rhythm()), "utf8");
    assert.equal(rhythm.trim(), "scene,chapter,beat,tension_target,tension_actual,note");
  });

  it("writes a schema per partition shape", async () => {
    const root = await project();
    for (const name of Object.keys(SCHEMAS)) {
      const text = await readFile(path.join(root, paths.schema(name)), "utf8");
      const parsed = JSON.parse(text) as { description?: string };
      assert.ok(parsed.description, `${name} schema needs a description, not just types`);
    }
  });

  it("states the two enforced rules in HARNESS.md", async () => {
    const root = await project();
    const harness = await readFile(path.join(root, paths.harness()), "utf8");
    assert.match(harness, /Only index-manager writes/);
    assert.match(harness, /State and identity are different things/);
  });

  it("never overwrites what an agent has already written", async () => {
    const root = await project();
    const memory = path.join(root, paths.memoryIndex("writer"));
    await writeFile(memory, "# Memory index\n\n- [A](a.md) — learnt something\n", "utf8");
    await initialiseProject(root, { premise: "same premise", targetWords: 40_000 });
    assert.match(await readFile(memory, "utf8"), /learnt something/);
  });
});

describe("where a scene lands", () => {
  it("groups scenes into chapters so eighty thousand words is navigable", () => {
    assert.equal(chapterFor(1), "ch-01");
    assert.equal(chapterFor(4), "ch-01");
    assert.equal(chapterFor(5), "ch-02");
    assert.equal(chapterFor(33), "ch-09");
  });

  it("puts prose under its chapter rather than in one flat directory", () => {
    assert.equal(paths.scene(chapterFor(13), "s-013"), "novel/chapters/ch-04/scenes/s-013.md");
  });

  it("reads a scene number back out of its id", () => {
    assert.equal(sceneIndexOf("s-013"), 13);
    assert.throws(() => sceneIndexOf("chapter-one"));
  });
});

describe("scenes on disk", () => {
  it("reads them from the chapter tree, not a flat directory", async () => {
    // The first version listed a flat `manuscript/`, which the tree had already
    // replaced. It returned nothing, and the reference check then reported every
    // state entry as pointing at a scene that did not exist: 53 "broken"
    // references over an intact index.
    const root = await project();
    const index = new CanonicalIndex(root);
    await index.init("genesis");
    for (const [chapter, scene] of [
      ["ch-01", "s-002"],
      ["ch-01", "s-001"],
      ["ch-02", "s-005"],
    ]) {
      await index.seed([{ relPath: paths.scene(chapter!, scene!), content: "prose" }]);
    }
    assert.deepEqual(
      (await committedScenes(root)).map((s) => s.sceneId),
      ["s-001", "s-002", "s-005"],
    );
  });

  it("is empty rather than throwing before anything is written", async () => {
    assert.deepEqual(await committedScenes(await project()), []);
  });
});
