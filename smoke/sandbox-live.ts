/**
 * The write gate, through the path a real run uses.
 *
 * The unit tests exercise each backend directly. This exercises the assembled
 * thing: a project tree, a backend selected the way the CLI selects it, a
 * gated `CanonicalIndex`, and the actual `bash` tool an agent is handed — which
 * is the piece a backend test cannot reach, and the piece where a wiring
 * mistake would leave the gate open while every unit test still passed.
 *
 *   node --experimental-strip-types smoke/sandbox-live.ts [none|local|docker]
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { CanonicalIndex } from "../src/index/commit.ts";
import { initialiseProject } from "../src/index/tree.ts";
import { selectSandbox } from "../src/sandbox/backends.ts";
import type { SandboxId } from "../src/sandbox/types.ts";
import { nativeTools } from "../src/tools/pi-tools.ts";

const requested = (process.argv[2] ?? "docker") as SandboxId;
const outer = await mkdtemp(path.join(tmpdir(), "storyos-gate-"));
const projectRoot = path.join(outer, "project");

interface Tool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ content: { text?: string }[] }>;
}

try {
  await new CanonicalIndex(projectRoot).init("genesis");
  await initialiseProject(projectRoot, {
    premise: "a smoke test",
    targetWords: 1000,
    agentsRoot: path.join(import.meta.dirname, "../agents"),
  });

  const selection = await selectSandbox(requested, projectRoot);
  const sandbox = selection.backend;
  const index = new CanonicalIndex(projectRoot, {
    writeGate: (fn) => sandbox.withWriteAccess(fn),
  });

  const gate = await sandbox.probe();
  const tools = nativeTools({
    projectRoot,
    budgetKey: () => "tx-1",
    ...(sandbox.id !== "none" ? { shell: sandbox.shell } : {}),
  }).tools as Tool[];
  const bash = tools.find((t) => t.name === "bash")!;
  const say = (r: { content: { text?: string }[] }) =>
    r.content.map((c) => c.text ?? "").join("\n");

  // 1. A read must still work: uniform read reach is a design guarantee, and
  //    confinement must not quietly cost it.
  const read: string = say(
    await bash.execute("1", { command: "ls world && cat world/terminology.yaml" }),
  );

  // 2. A write the policy does not anticipate. `sort -o` writes a file and is
  //    on nobody's list of dangerous commands, which is the whole point: the
  //    refusal list is a claim about the commands we thought of, and the gate
  //    has to hold for the ones we did not. Under `none` this succeeds, and
  //    that contrast is the argument for the sandbox in one line of output.
  // pi's bash throws on a non-zero exit, with the output attached, so a blocked
  // write arrives as a rejected promise rather than a result. Inside an Agent
  // that becomes an error tool result; here it has to be caught by hand.
  const sneaky = await bash
    .execute("2", { command: "sort -o world/terminology.yaml /etc/hostname" })
    .then(say, (error: unknown) => String(error instanceof Error ? error.message : error));
  const worldAfter = await readFile(path.join(projectRoot, "world/terminology.yaml"), "utf8");
  const unanticipatedHeld = worldAfter.startsWith("terms:");

  // 3. index-manager still commits, through the harness.
  await index.commit({
    txid: "tx-1",
    sceneId: "s-001",
    baseCommitId: await index.head(),
    actor: "index-manager",
    prose: { relPath: "novel/chapters/ch-01/scenes/s-001.md", content: "the quay at dawn" },
    stateDelta: [{ relPath: "continuity/deltas/s-001.json", content: "{}" }],
  });
  const committed = await index.read("novel/chapters/ch-01/scenes/s-001.md");

  // 4. And the gate is shut again afterwards.
  const afterCommit = await sandbox.probe();

  await sandbox.dispose();

  const held = unanticipatedHeld;
  console.log(
    JSON.stringify(
      {
        requested,
        backend: sandbox.id,
        enforcement: sandbox.enforcement,
        fell_back_from: selection.fellBackFrom,
        fallback_reason: selection.reason,
        gate_probe: gate,
            agent_can_read: read.includes("terms"),
        unanticipated_write_blocked: held,
        unanticipated_write_said: sneaky.slice(0, 160),
        commit_landed: committed.includes("the quay at dawn"),
        gate_shut_after_commit: afterCommit.writeRefused,
        verdict:
          sandbox.id === "none"
            ? "control arm: nothing enforced, as declared"
            : held && afterCommit.writeRefused && committed.includes("the quay at dawn")
              ? "PASS: agents cannot write canon, index-manager can"
              : "FAIL: the gate did not hold",
      },
      null,
      2,
    ),
  );
} finally {
  await rm(outer, { recursive: true, force: true }).catch(() => {});
}
