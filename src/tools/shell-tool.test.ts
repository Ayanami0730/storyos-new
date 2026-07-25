import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { shellTool } from "./shell-tool.ts";

interface Tool {
  execute: (id: string, args: { command: string; purpose: string }) => Promise<{
    content: { text: string }[];
  }>;
}

async function project() {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-shell-"));
  await writeFile(path.join(root, "note.md"), "the harbour warden keeps a ledger\n", "utf8");
  const reads: unknown[] = [];
  const tool = shellTool({
    projectRoot: root,
    budgetKey: () => "tx-1",
    onRead: (entry) => reads.push(entry),
  }) as Tool;
  return { root, tool, reads };
}

const text = (result: { content: { text: string }[] }) => result.content[0]!.text;

describe("reading the project with a shell", () => {
  it("greps", async () => {
    const { tool } = await project();
    const result = await tool.execute("t1", { command: "grep -n ledger note.md", purpose: "find it" });
    assert.match(text(result), /1:the harbour warden keeps a ledger/);
  });

  it("treats no match as an answer, not a failure", async () => {
    // grep exits 1 when it finds nothing, and "nothing matched" is information
    // the agent needs rather than an error to retry.
    const { tool } = await project();
    const result = await tool.execute("t1", {
      command: "grep -n lighthouse note.md",
      purpose: "check",
    });
    assert.match(text(result), /no output|exit 1/);
  });

  it("records every read, so 'why did this run look at that' is answerable", async () => {
    const { tool, reads } = await project();
    await tool.execute("t1", { command: "ls", purpose: "orient myself" });
    assert.equal(reads.length, 1);
    assert.equal((reads[0] as { purpose: string }).purpose, "orient myself");
  });

  it("requires a purpose", async () => {
    const { tool } = await project();
    assert.match(text(await tool.execute("t1", { command: "ls", purpose: "" })), /purpose is required/);
  });
});

describe("what it refuses", () => {
  it("refuses writes, redirection, interpreters, network and git", async () => {
    const { tool } = await project();
    for (const command of [
      "rm note.md",
      "echo x > note.md",
      "python -c 'print(1)'",
      "curl http://example.com",
      "git commit -m x",
    ]) {
      const result = await tool.execute("t1", { command, purpose: "p" });
      assert.match(text(result), /refused/, command);
    }
  });

  it("leaves the file untouched when it refuses a write", async () => {
    const { root, tool } = await project();
    await tool.execute("t1", { command: "rm note.md", purpose: "p" });
    assert.match(await readFile(path.join(root, "note.md"), "utf8"), /ledger/);
  });

  it("hands the refusal back as feedback instead of failing the turn", async () => {
    const { tool } = await project();
    const result = await tool.execute("t1", { command: "rm note.md", purpose: "p" });
    assert.match(text(result), /commit path/, "the reason has to be readable, not just 'no'");
  });
});

describe("large output", () => {
  it("spills to an artefact and says so, rather than cutting silently", async () => {
    // A truncated result that reads as complete is worse than a refusal: the
    // agent draws conclusions from the head and nothing signals the gap.
    const { root, tool } = await project();
    await writeFile(path.join(root, "big.txt"), "x".repeat(50_000), "utf8");
    const result = await tool.execute("t1", { command: "cat big.txt", purpose: "read it all" });
    const body = text(result);
    assert.match(body, /\[truncated: 50000 chars total/);
    assert.match(body, /runtime\/artifacts\/shell-/);
    const spilled = /Full output at (\S+)\./.exec(body)![1]!;
    assert.equal((await readFile(path.join(root, spilled), "utf8")).length, 50_000);
  });
});

describe("the read budget", () => {
  it("stops a scene from spending an unbounded number of reads", async () => {
    const { root } = await project();
    const tool = shellTool({
      projectRoot: root,
      budgetKey: () => "tx-1",
      limits: { maxCallsPerTransaction: 2 },
    }) as Tool;
    await tool.execute("t1", { command: "ls", purpose: "p" });
    await tool.execute("t2", { command: "ls", purpose: "p" });
    assert.match(text(await tool.execute("t3", { command: "ls", purpose: "p" })), /budget exhausted/);
  });

  it("gives the next transaction its own budget", async () => {
    const { root } = await project();
    let key = "tx-1";
    const tool = shellTool({
      projectRoot: root,
      budgetKey: () => key,
      limits: { maxCallsPerTransaction: 1 },
    }) as Tool;
    await tool.execute("t1", { command: "ls", purpose: "p" });
    key = "tx-2";
    assert.doesNotMatch(text(await tool.execute("t2", { command: "ls", purpose: "p" })), /budget/);
  });
});
