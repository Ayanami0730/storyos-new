import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { CanonicalIndex, CommitRefused } from "./commit.ts";
import type { CommitRequest } from "./commit.ts";

let root: string;
let index: CanonicalIndex;

before(async () => {
  root = await mkdtemp(path.join(tmpdir(), "storyos-index-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function freshIndex(): Promise<CanonicalIndex> {
  const dir = await mkdtemp(path.join(root, "case-"));
  const idx = new CanonicalIndex(dir, { now: () => new Date(Date.UTC(2026, 6, 25)) });
  await idx.init("genesis");
  return idx;
}

function request(over: Partial<CommitRequest> = {}): CommitRequest {
  return {
    txid: "tx-1",
    sceneId: "s-001",
    baseCommitId: "genesis",
    actor: "index-manager",
    prose: { relPath: "manuscript/scenes/s-001.md", content: "The warden waited." },
    stateDelta: [
      {
        relPath: "index/story/bible/relations/mira--warden.yaml",
        content: "phases:\n  - relation: strangers\n",
      },
    ],
    ...over,
  };
}

describe("only index-manager may write canonical state", () => {
  for (const actor of ["writer", "verifier", "context-builder", "orchestrator"] as const) {
    it(`refuses a commit from ${actor}`, async () => {
      const idx = await freshIndex();
      await assert.rejects(
        () => idx.commit(request({ actor })),
        (e: unknown) =>
          e instanceof CommitRefused &&
          e.code === "WRONG_ACTOR" &&
          new RegExp(`${actor} may not write`).test(e.message),
      );
      assert.equal(await idx.head(), "genesis", "HEAD must not move");
    });
  }
});

describe("prose and state delta are one unit", () => {
  it("writes both and advances HEAD", async () => {
    const idx = await freshIndex();
    const result = await idx.commit(request());
    assert.notEqual(result.commitId, "genesis");
    assert.equal(await idx.head(), result.commitId);
    assert.match(await idx.read("manuscript/scenes/s-001.md"), /warden waited/);
    assert.match(
      await idx.read("index/story/bible/relations/mira--warden.yaml"),
      /relation: strangers/,
    );
    assert.deepEqual(result.writtenPaths.length, 2);
  });

  it("refuses prose with no state delta", async () => {
    const idx = await freshIndex();
    await assert.rejects(
      () => idx.commit(request({ stateDelta: [] })),
      (e: unknown) => e instanceof CommitRefused && e.code === "EMPTY_DELTA",
    );
    assert.equal(await idx.head(), "genesis");
  });
});

describe("stale base is refused, not merged", () => {
  it("refuses when HEAD has moved since the packet was built", async () => {
    const idx = await freshIndex();
    const first = await idx.commit(request());
    // A second transaction still holding the old base.
    await assert.rejects(
      () =>
        idx.commit(
          request({ txid: "tx-2", sceneId: "s-002", baseCommitId: "genesis" }),
        ),
      (e: unknown) =>
        e instanceof CommitRefused &&
        e.code === "STALE_BASE" &&
        e.message.includes(first.commitId),
    );
    assert.equal(await idx.head(), first.commitId, "HEAD must be unchanged");
  });

  it("accepts the same transaction once rebased onto the new HEAD", async () => {
    const idx = await freshIndex();
    const first = await idx.commit(request());
    const second = await idx.commit(
      request({
        txid: "tx-2",
        sceneId: "s-002",
        baseCommitId: first.commitId,
        prose: { relPath: "manuscript/scenes/s-002.md", content: "Rain, later." },
      }),
    );
    assert.equal(second.baseCommitId, first.commitId);
    assert.equal(await idx.head(), second.commitId);
  });
});

describe("path containment", () => {
  for (const relPath of ["../escape.md", "manuscript/../../escape.md"]) {
    it(`refuses to write outside the root: ${relPath}`, async () => {
      const idx = await freshIndex();
      await assert.rejects(
        () => idx.commit(request({ prose: { relPath, content: "x" } })),
        (e: unknown) => e instanceof CommitRefused && e.code === "PATH_ESCAPE",
      );
    });
  }
});

describe("commit identity", () => {
  it("is deterministic in base, scene, time and content", async () => {
    const a = await freshIndex();
    const b = await freshIndex();
    const ra = await a.commit(request());
    const rb = await b.commit(request());
    assert.equal(ra.commitId, rb.commitId, "same inputs must give the same id");
  });

  it("changes when the prose changes", async () => {
    const a = await freshIndex();
    const b = await freshIndex();
    const ra = await a.commit(request());
    const rb = await b.commit(
      request({ prose: { relPath: "manuscript/scenes/s-001.md", content: "Different." } }),
    );
    assert.notEqual(ra.commitId, rb.commitId);
  });
});

describe("staging hygiene", () => {
  it("leaves no staging directory behind after a successful commit", async () => {
    const idx = await freshIndex();
    await idx.commit(request());
    assert.deepEqual(await idx.pendingIntents(), []);
  });

  it("leaves nothing behind after a refused commit", async () => {
    const idx = await freshIndex();
    await assert.rejects(() => idx.commit(request({ stateDelta: [] })));
    assert.deepEqual(await idx.pendingIntents(), []);
  });
});

describe("durability shape", () => {
  it("moves HEAD only after every file is in place", async () => {
    const idx = await freshIndex();
    const result = await idx.commit(request());
    // Both files readable at the moment HEAD names the new commit.
    const head = await readFile(path.join(idx.root, "HEAD"), "utf8");
    assert.equal(head.trim(), result.commitId);
    for (const rel of result.writtenPaths) {
      const body = await idx.read(rel);
      assert.ok(body.length > 0, `${rel} must exist when HEAD advances`);
    }
  });
});
