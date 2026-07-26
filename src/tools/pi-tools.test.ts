import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { nativeTools } from "./pi-tools.ts";
import { readIndexTool } from "./read-index.ts";
import { DEFAULT_SHELL_LIMITS, refusalFor } from "./shell.ts";

interface Tool {
  name: string;
  execute: (id: string, params: unknown) => Promise<{ content: { text?: string }[] }>;
}

async function project(limits?: { maxCallsPerTransaction?: number }) {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-pitools-"));
  await writeFile(path.join(root, "note.md"), "the harbour warden keeps a ledger\n", "utf8");
  const reads: { command: string }[] = [];
  let key = "tx-1";
  const tools = nativeTools({
    projectRoot: root,
    budgetKey: () => key,
    ...(limits ? { limits } : {}),
    onRead: (entry) => reads.push(entry),
  }).tools as Tool[];
  return {
    root,
    reads,
    setKey: (k: string) => {
      key = k;
    },
    bash: tools.find((t) => t.name === "bash")!,
    read: tools.find((t) => t.name === "read")!,
  };
}

const text = (r: { content: { text?: string }[] }) =>
  r.content.map((c) => c.text ?? "").join("\n");

describe("the refusal policy", () => {
  it("names what it refuses and why, so the agent can choose differently", () => {
    for (const [command, expected] of [
      ["rm note.md", /commit path/],
      ["echo x > note.md", /typed write tools/],
      ["python -c 'print(1)'", /escapes every check/],
      ["curl http://example.com", /reproducible from the index/],
      ["git commit -m x", /engine owning every commit/],
      ["cat runtime/transcripts/writer/run-1.jsonl", /another agent's private session/],
    ] as const) {
      const reason = refusalFor(command, DEFAULT_SHELL_LIMITS);
      assert.ok(reason, command);
      assert.match(reason, expected, command);
    }
  });

  it("allows the reads the index is there to support", () => {
    for (const command of [
      "grep -rn char-mira novel/chapters/",
      "cat characters/char-mira/state.jsonl",
      "ls relations/",
      "sed -n '1,40p' continuity/plot-contracts.jsonl",
    ]) {
      assert.equal(refusalFor(command, DEFAULT_SHELL_LIMITS), null, command);
    }
  });
});

describe("pi's bash, with our policy in its prepare hook", () => {
  it("runs a read", async () => {
    const { bash } = await project();
    assert.match(text(await bash.execute("t1", { command: "grep -n ledger note.md" })), /ledger/);
  });

  it("refuses a write and leaves the file alone", async () => {
    const { root, bash } = await project();
    const result = await bash.execute("t1", { command: "rm note.md" });
    assert.match(text(result), /refused/);
    assert.match(await readFile(path.join(root, "note.md"), "utf8"), /ledger/);
  });

  it("answers the refusal instead of ending the turn", async () => {
    // A tool that throws ends the turn; one that says "no, and here is why"
    // lets the agent try a different command immediately.
    const { bash } = await project();
    await assert.doesNotReject(() => bash.execute("t1", { command: "curl http://example.com" }));
  });

  it("records every read for the 'was the grep worth it' question", async () => {
    const { bash, reads } = await project();
    await bash.execute("t1", { command: "ls" });
    assert.deepEqual(reads.map((r) => r.command), ["ls"]);
  });

  it("bounds reads per transaction and gives the next one its own budget", async () => {
    const { bash, setKey } = await project({ maxCallsPerTransaction: 1 });
    await bash.execute("t1", { command: "ls" });
    assert.match(text(await bash.execute("t2", { command: "ls" })), /budget exhausted/);
    setKey("tx-2");
    assert.doesNotMatch(text(await bash.execute("t3", { command: "ls" })), /budget/);
  });

  it("does not spend budget on a refused command", async () => {
    const { bash } = await project({ maxCallsPerTransaction: 1 });
    await bash.execute("t1", { command: "rm note.md" });
    assert.doesNotMatch(text(await bash.execute("t2", { command: "ls" })), /budget exhausted/);
  });
});

describe("one read budget across every way of reading", () => {
  /** All three read tools, sharing a counter. */
  async function reader(maxCallsPerTransaction: number) {
    const root = await mkdtemp(path.join(tmpdir(), "storyos-pitools-budget-"));
    await writeFile(path.join(root, "note.md"), "a line\n", "utf8");
    const native = nativeTools({
      projectRoot: root,
      budgetKey: () => "tx-1",
      limits: { maxCallsPerTransaction },
    });
    const tools = native.tools as Tool[];
    return {
      root,
      bash: tools.find((t) => t.name === "bash")!,
      read: tools.find((t) => t.name === "read")!,
      readIndex: readIndexTool({
        read: async (rel) => (await import("node:fs/promises")).readFile(path.join(root, rel), "utf8"),
        spend: native.spend,
      }) as Tool,
    };
  }

  it("charges bash, read and read_index against the same allowance", async () => {
    const { root, bash, read, readIndex } = await reader(2);

    await bash.execute("1", { command: "cat note.md" });
    await read.execute("2", { path: path.join(root, "note.md") });
    // Two reads spent through two different tools; the third must be refused
    // whichever tool it comes through. A cap only one tool respects is not a cap
    // — the agent that over-read used all three.
    const third = await readIndex.execute("3", { path: "note.md", purpose: "one more" });
    assert.match(text(third), /read budget exhausted/);
  });

  it("does not spend a read on a command the policy refused", async () => {
    const { bash, read } = await reader(1);
    await bash.execute("1", { command: "rm -rf ." });
    // The refusal is about policy, so it should not also cost the agent its
    // remaining budget — and it must hear why it was refused, not that it is
    // out of room.
    const allowed = await read.execute("2", { path: "note.md" });
    assert.doesNotMatch(text(allowed), /budget exhausted/);
  });
});

describe("bash routed through a sandbox", () => {
  /** A stand-in backend that records what it was asked to run. */
  function recordingShell() {
    const ran: string[] = [];
    return {
      ran,
      exec: async (command: string) => {
        ran.push(command);
        return { stdout: "from the sandbox", stderr: "", exitCode: 0 };
      },
    };
  }

  it("sends the command to the backend instead of the host", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "storyos-pitools-sb-"));
    await writeFile(path.join(root, "note.md"), "on the host\n", "utf8");
    const shell = recordingShell();
    const tools = nativeTools({
      projectRoot: root,
      budgetKey: () => "tx-1",
      shell,
    }).tools as Tool[];

    const out = await tools
      .find((t) => t.name === "bash")!
      .execute("1", { command: "cat note.md" });

    // The integration point that makes the whole gate real: the tool the agent
    // holds must run where the confinement is, not next to it.
    assert.deepEqual(shell.ran, ["cat note.md"]);
    assert.match(text(out), /from the sandbox/);
  });

  it("still refuses a forbidden command before it reaches the backend", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "storyos-pitools-sb2-"));
    const shell = recordingShell();
    const tools = nativeTools({
      projectRoot: root,
      budgetKey: () => "tx-1",
      shell,
    }).tools as Tool[];

    const out = await tools
      .find((t) => t.name === "bash")!
      .execute("1", { command: "echo x > world/rules.yaml" });

    // Two independent barriers, in the right order. The sandbox is what makes
    // the guarantee true; the policy is what makes the refusal *legible* — an
    // agent told "writes go through the typed tools" tries the typed tool,
    // where one told "Read-only file system" tries something else.
    assert.deepEqual(shell.ran, []);
    assert.match(text(out), /typed write tools|redirection/);
  });

  it("runs on the host when no backend is supplied, which is the control arm", async () => {
    const { bash } = await project();
    const out = await bash.execute("1", { command: "cat note.md" });
    assert.match(text(out), /harbour warden/);
  });
});

describe("pi's read", () => {
  it("reads a file, and can page rather than truncating blindly", async () => {
    const { root, read } = await project();
    await writeFile(
      path.join(root, "long.md"),
      Array.from({ length: 200 }, (_, i) => `line ${i + 1}`).join("\n"),
      "utf8",
    );
    const whole = text(await read.execute("t1", { path: "long.md" }));
    assert.match(whole, /line 1\b/);
    const paged = text(await read.execute("t2", { path: "long.md", offset: 100, limit: 5 }));
    assert.match(paged, /line 10[0-5]/);
    assert.doesNotMatch(paged, /line 1\n/);
  });

  it("answers that a missing file is missing instead of ending the turn", async () => {
    // pi throws a FileError here. For us a missing file is ordinary — a scene
    // not written yet, a character with no profile — and the answer matters:
    // it is the difference between moving on and inventing the contents.
    const { read } = await project();
    const result = await read.execute("t1", { path: "nope.md" });
    assert.match(text(result), /nope\.md does not exist/);
    assert.match(text(result), /not a reason to invent its contents/);
  });
});
