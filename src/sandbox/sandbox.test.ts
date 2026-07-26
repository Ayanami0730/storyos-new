/**
 * The write gate, tested by trying to get through it.
 *
 * Every test here attempts a forbidden write and asserts it failed, rather than
 * asserting that some flag was set. That is the only form of test worth having
 * for this: the claim is "an agent could not write canonical state", and the
 * evidence for it has to be an agent failing to write canonical state.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { CanonicalIndex } from "../index/commit.ts";
import { DockerSandbox, dockerAvailable } from "./docker.ts";
import { LocalSandbox } from "./local.ts";
import { selectSandbox } from "./backends.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) {
    // Unlocked first: a read-only tree resists its own cleanup.
    await rm(root, { recursive: true, force: true }).catch(async () => {
      await new LocalSandbox(root).dispose();
      await rm(root, { recursive: true, force: true });
    });
  }
});

/** A project with just enough tree to lock. */
async function freshProject() {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-sandbox-"));
  roots.push(root);
  await mkdir(path.join(root, "world"), { recursive: true });
  await mkdir(path.join(root, "characters/char-mira"), { recursive: true });
  await mkdir(path.join(root, "runtime"), { recursive: true });
  await mkdir(path.join(root, ".writer/drafts"), { recursive: true });
  await writeFile(path.join(root, "world/rules.yaml"), "rules: []\n", "utf8");
  await writeFile(path.join(root, "HEAD"), "commit-0", "utf8");
  return root;
}

describe("the local backend", () => {
  it("refuses a write to canonical state once engaged", async () => {
    const root = await freshProject();
    const sandbox = new LocalSandbox(root);
    await sandbox.engage();

    const probe = await sandbox.probe();
    assert.equal(probe.writeRefused, true);
    assert.match(probe.detail, /EACCES|EPERM|EROFS/);

    // And through the shell, which is the surface an agent actually has.
    const result = await sandbox.shell.exec("echo x > world/rules.yaml");
    assert.notEqual(result.exitCode, 0);
    assert.equal(await readFile(path.join(root, "world/rules.yaml"), "utf8"), "rules: []\n");

    await sandbox.dispose();
  });

  it("leaves the roles' own directories writable", async () => {
    const root = await freshProject();
    const sandbox = new LocalSandbox(root);
    await sandbox.engage();

    // `.writer/drafts`, `staging/` and `runtime/` are where working artefacts
    // live. Locking those would break the harness to protect nothing: the
    // harness contract already says only canon is index-manager's.
    await writeFile(path.join(root, ".writer/drafts/s-001.md"), "draft", "utf8");
    await writeFile(path.join(root, "runtime/events.jsonl"), "{}\n", "utf8");

    await sandbox.dispose();
  });

  it("opens the gate for a commit and shuts it again afterwards", async () => {
    const root = await freshProject();
    const sandbox = new LocalSandbox(root);
    await sandbox.engage();

    const index = new CanonicalIndex(root, {
      writeGate: (fn) => sandbox.withWriteAccess(fn),
    });
    const commit = await index.commit({
      txid: "tx-1",
      sceneId: "s-001",
      baseCommitId: "commit-0",
      actor: "index-manager",
      prose: { relPath: "novel/chapters/ch-01/scenes/s-001.md", content: "prose" },
      stateDelta: [{ relPath: "continuity/deltas/s-001.json", content: "{}" }],
    });
    assert.ok(commit.commitId);

    // Shut again the moment the commit returns. A gate that stays open after
    // the one operation it was opened for is a gate in name only.
    assert.equal((await sandbox.probe()).writeRefused, true);
    await sandbox.dispose();
  });

  it("refuses a commit before opening the gate, so a rejected write never unlocks", async () => {
    const root = await freshProject();
    const sandbox = new LocalSandbox(root);
    await sandbox.engage();
    const index = new CanonicalIndex(root, {
      writeGate: (fn) => sandbox.withWriteAccess(fn),
    });

    await assert.rejects(
      () =>
        index.commit({
          txid: "tx-1",
          sceneId: "s-001",
          baseCommitId: "commit-0",
          actor: "writer",
          prose: { relPath: "novel/chapters/ch-01/scenes/s-001.md", content: "prose" },
          stateDelta: [{ relPath: "continuity/deltas/s-001.json", content: "{}" }],
        }),
      /may not write canonical state/,
    );
    assert.equal((await sandbox.probe()).writeRefused, true);
    await sandbox.dispose();
  });

  it("hands the tree back as an ordinary directory on dispose", async () => {
    const root = await freshProject();
    const sandbox = new LocalSandbox(root);
    await sandbox.engage();
    await sandbox.dispose();
    // A run's output should be something a person can read, copy and delete
    // without fighting it.
    await writeFile(path.join(root, "world/rules.yaml"), "rules: [a]\n", "utf8");
  });
});

describe("selecting a backend", () => {
  it("says so loudly when the requested backend was not available", async () => {
    const root = await freshProject();
    // Asking for a backend and silently getting a weaker one would make the
    // summary report a guarantee the run does not have.
    const selection = await selectSandbox("docker", path.join(root, "does-not-exist"));
    if (selection.fellBackFrom) {
      assert.equal(selection.backend.id, "local");
      assert.ok(selection.reason);
    } else {
      assert.equal(selection.backend.id, "docker");
    }
    await selection.backend.dispose();
  });

  it("admits the null backend enforces nothing", async () => {
    const selection = await selectSandbox("none", await freshProject());
    assert.equal(selection.backend.enforcement, "prompt");
    const probe = await selection.backend.probe();
    assert.equal(probe.writeRefused, false);
    assert.match(probe.detail, /commands we thought of/);
  });
});

describe("the docker backend", { skip: !(await dockerAvailable()) }, () => {
  it("makes a write to canonical state impossible rather than refused", async () => {
    const root = await freshProject();
    const sandbox = new DockerSandbox({ root });
    await sandbox.start();
    try {
      const probe = await sandbox.probe();
      // The strong claim: not our refusal list, the kernel. A read-only mount
      // has no permission for the process to reclaim.
      assert.equal(probe.writeRefused, true);
      assert.match(probe.detail, /read-only|Read-only|denied/);
      assert.equal(await readFile(path.join(root, "world/rules.yaml"), "utf8"), "rules: []\n");
    } finally {
      await sandbox.dispose();
    }
  });

  it("still lets an agent read the whole tree", async () => {
    const root = await freshProject();
    const sandbox = new DockerSandbox({ root });
    await sandbox.start();
    try {
      // Uniform read reach is a design guarantee; confinement must not cost it.
      const result = await sandbox.shell.exec("cat world/rules.yaml");
      assert.equal(result.exitCode, 0);
      assert.match(result.stdout, /rules: \[\]/);
    } finally {
      await sandbox.dispose();
    }
  });

  it("reports a non-zero exit as output, since that is ordinary for a shell", async () => {
    const root = await freshProject();
    const sandbox = new DockerSandbox({ root });
    await sandbox.start();
    try {
      // `grep` finding nothing exits 1. Throwing on that would end the turn
      // over a normal answer.
      const result = await sandbox.shell.exec("grep -r nonexistent-token .");
      assert.notEqual(result.exitCode, 0);
      assert.equal(result.stdout, "");
    } finally {
      await sandbox.dispose();
    }
  });

  it("commits through the harness, which was never inside the mount", async () => {
    const root = await freshProject();
    const sandbox = new DockerSandbox({ root });
    await sandbox.start();
    try {
      const index = new CanonicalIndex(root, {
        writeGate: (fn) => sandbox.withWriteAccess(fn),
      });
      await index.commit({
        txid: "tx-1",
        sceneId: "s-001",
        baseCommitId: "commit-0",
        actor: "index-manager",
        prose: { relPath: "novel/chapters/ch-01/scenes/s-001.md", content: "prose" },
        stateDelta: [{ relPath: "continuity/deltas/s-001.json", content: "{}" }],
      });
      // The gate is on the agents. index-manager runs in the harness process on
      // the host, so it never needed to be let in.
      const written = await sandbox.shell.exec("cat novel/chapters/ch-01/scenes/s-001.md");
      assert.match(written.stdout, /prose/);
    } finally {
      await sandbox.dispose();
    }
  });
});
