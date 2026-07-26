import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { ArtifactStore, artifactPaths, renderFollowUp } from "./artifacts.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshStore() {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-artifacts-"));
  roots.push(root);
  return { root, store: new ArtifactStore(root) };
}

describe("artifact paths", () => {
  it("files a packet under the chapter its scene belongs to", () => {
    assert.equal(
      artifactPaths.packet("s-001"),
      ".context-builder/history/ch-01/s-001.md",
    );
    // Scene 5 is the first of chapter 2 at four scenes per chapter, so the
    // packets for a chapter sit together — the axis someone looking for one
    // actually searches along.
    assert.equal(
      artifactPaths.packet("s-005"),
      ".context-builder/history/ch-02/s-005.md",
    );
  });

  it("keeps each attempt's audit separate", () => {
    assert.notEqual(artifactPaths.audit("s-001", 1), artifactPaths.audit("s-001", 2));
  });

  it("puts every artefact in the dot-directory of the role that produced it", () => {
    // Not cosmetic: it keeps each write inside the one directory that role is
    // allowed to write to, so none of this weakens the rule that only
    // index-manager touches canon.
    assert.match(artifactPaths.packet("s-001"), /^\.context-builder\//);
    assert.match(artifactPaths.draft("s-001"), /^\.writer\//);
    assert.match(artifactPaths.audit("s-001", 1), /^\.verifier\//);
    assert.match(artifactPaths.sceneLog("s-001"), /^\.orchestrator\//);
  });
});

describe("the artifact store", () => {
  it("reads back what it wrote, creating directories on the way", async () => {
    const { store } = await freshStore();
    await store.write(artifactPaths.packet("s-001"), "packet body");
    assert.equal(await store.read(artifactPaths.packet("s-001")), "packet body");
  });

  it("answers null for a file that was never written", async () => {
    const { store } = await freshStore();
    // Absence is an answer here, not an error: a scene that has not been
    // written yet is the ordinary case in this system.
    assert.equal(await store.read(artifactPaths.draft("s-099")), null);
  });

  it("appends a follow-up to the packet the question was about", async () => {
    const { store } = await freshStore();
    const at = artifactPaths.packet("s-001");
    await store.write(at, "# Packet\n\noriginal material");
    await store.append(
      at,
      renderFollowUp({ round: 1, question: "Have they met?", answer: "Yes, in s-002." }),
    );

    const text = (await store.read(at))!;
    // The original survives and the answer joins it. An answer returned only as
    // tool text is a reply that scrolls past; appended, it is part of the
    // material the writer is working from.
    assert.match(text, /original material/);
    assert.match(text, /Have they met\?/);
    assert.match(text, /Yes, in s-002\./);
  });

  it("creates the file when appending to one that does not exist yet", async () => {
    const { store } = await freshStore();
    await store.append("test/late.md", "first line");
    assert.equal(await store.read("test/late.md"), "first line");
  });

  it("refuses to write outside the project root", async () => {
    const { store } = await freshStore();
    await assert.rejects(
      () => store.write("../escaped.md", "nope"),
      /outside the project root/,
    );
  });
});
