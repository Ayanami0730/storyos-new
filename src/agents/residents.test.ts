import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { AgentRole } from "../transaction/types.ts";
import { PERSONAS } from "./personas.ts";
import {
  type AgentLike,
  DelegationError,
  ResidentAgents,
  delegationToolName,
  delegationTools,
} from "./residents.ts";

const AGENTS_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agents",
);

/** A scripted agent that records what it was constructed with and asked. */
class FakeAgent implements AgentLike {
  readonly prompts: string[] = [];
  messages: AgentLike["state"]["messages"][number][] = [];

  readonly systemPrompt: string;
  readonly toolNames: readonly string[];
  readonly model: string;

  constructor(systemPrompt: string, toolNames: readonly string[], model: string) {
    this.systemPrompt = systemPrompt;
    this.toolNames = toolNames;
    this.model = model;
  }

  get state() {
    return { messages: this.messages };
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    this.messages = [
      ...this.messages,
      { role: "user", content: input },
      {
        role: "assistant",
        content: [
          { type: "toolCall", name: "run_command" },
          { type: "text", text: `did: ${input}` },
        ],
        usage: { input: 100, output: 40, cacheRead: 10, reasoning: 5, totalTokens: 155 },
        model: this.model,
        stopReason: "endTurn",
      },
    ];
  }
}

function residents() {
  const built: FakeAgent[] = [];
  let clock = 1_000;
  const registry = new ResidentAgents({
    agentsRoot: AGENTS_ROOT,
    personas: PERSONAS,
    now: () => (clock += 250),
    factory: (persona, systemPrompt, toolNames) => {
      const agent = new FakeAgent(systemPrompt, toolNames, persona.model);
      built.push(agent);
      return agent;
    },
  });
  return { registry, built };
}

const ctx = { txid: "tx-1", caller: "orchestrator" as AgentRole };

describe("residency", () => {
  it("builds an agent once and reuses it, so context accumulates", async () => {
    const { registry, built } = residents();
    await registry.invoke("writer", "draft scene 1", ctx);
    await registry.invoke("writer", "draft scene 2", ctx);

    assert.equal(built.length, 1);
    assert.deepEqual(built[0]!.prompts, ["draft scene 1", "draft scene 2"]);
    // Four messages, not two: the second call saw the first one's history.
    assert.equal(built[0]!.messages.length, 4);
  });

  it("gives each role its own agent", async () => {
    const { registry, built } = residents();
    await registry.invoke("writer", "draft", ctx);
    await registry.invoke("verifier", "check", ctx);
    assert.equal(built.length, 2);
    assert.notEqual(built[0]!.systemPrompt, built[1]!.systemPrompt);
  });

  it("reports residency so a caller can tell a cold role from a warm one", async () => {
    const { registry } = residents();
    assert.equal(registry.isResident("writer"), false);
    await registry.invoke("writer", "draft", ctx);
    assert.equal(registry.isResident("writer"), true);
  });

  it("constructs each agent with its own prompt, model and allowlist", async () => {
    const { registry, built } = residents();
    await registry.invoke("verifier", "check", ctx);
    const agent = built[0]!;
    assert.equal(agent.model, "gemini-3.1-pro-preview");
    assert.ok(agent.toolNames.includes("write_findings"));
    assert.ok(!agent.toolNames.includes("commit_transaction"));
    assert.match(agent.systemPrompt, /# Verifier/);
  });
});

describe("delegation depth", () => {
  it("refuses a specialist trying to delegate", async () => {
    const { registry } = residents();
    await assert.rejects(
      registry.invoke("verifier", "check this", { txid: "tx-1", caller: "writer" }),
      DelegationError,
    );
    await assert.rejects(
      registry.invoke("writer", "draft", { txid: "tx-1", caller: "writer" }),
      /specialists never call specialists/,
    );
  });

  it("refuses the orchestrator delegating to itself", async () => {
    const { registry } = residents();
    await assert.rejects(registry.invoke("orchestrator", "think", ctx), /itself/);
  });

  it("refuses an empty task", async () => {
    const { registry } = residents();
    await assert.rejects(registry.invoke("writer", "   ", ctx), /empty task/);
  });
});

describe("delegation tools", () => {
  it("exposes exactly the four callees, never the orchestrator", () => {
    const { registry } = residents();
    assert.deepEqual(
      delegationTools(registry).map((t) => t.name).sort(),
      [
        "call_context_builder",
        "call_index_manager",
        "call_verifier",
        "call_writer",
      ],
    );
  });

  it("names the tool after the role", () => {
    assert.equal(delegationToolName("index-manager"), "call_index_manager");
  });

  it("requires a txid, because an unattributable call cannot be billed", () => {
    const { registry } = residents();
    const tool = delegationTools(registry)[0]!;
    assert.deepEqual(
      tool.validate({ txid: "", task: "do it" }).map((e) => e.path),
      ["txid"],
    );
    assert.deepEqual(tool.validate({ txid: "tx-1", task: "" }).map((e) => e.path), [
      "task",
    ]);
    assert.deepEqual(tool.validate({ txid: "tx-1", task: "do it" }), []);
  });

  it("returns the callee's answer to the orchestrator", async () => {
    const { registry } = residents();
    const writer = delegationTools(registry).find((t) => t.name === "call_writer")!;
    assert.equal(await writer.run({ txid: "tx-1", task: "draft" }), "did: draft");
  });
});

describe("ledger", () => {
  it("records tokens, time and tool calls for every invocation", async () => {
    const { registry } = residents();
    await registry.invoke("writer", "draft", ctx);
    const [entry] = registry.ledger();
    assert.equal(entry!.role, "writer");
    assert.equal(entry!.txid, "tx-1");
    assert.equal(entry!.usage.total, 155);
    assert.equal(entry!.usage.reasoning, 5);
    assert.equal(entry!.toolCalls, 1);
    assert.equal(entry!.stopReason, "endTurn");
    assert.ok(entry!.durationMs > 0);
  });

  it("charges each call once, not the whole accumulated history again", async () => {
    const { registry } = residents();
    await registry.invoke("writer", "draft 1", ctx);
    await registry.invoke("writer", "draft 2", ctx);
    const entries = registry.ledger();
    assert.equal(entries.length, 2);
    // Residency means messages accumulate; billing must not.
    assert.equal(entries[1]!.usage.total, 155);
  });

  it("rolls up per role and model for the run summary", async () => {
    const { registry } = residents();
    await registry.invoke("writer", "draft", ctx);
    await registry.invoke("writer", "revise", ctx);
    await registry.invoke("verifier", "check", ctx);
    const roll = registry.rollUp();
    assert.equal(roll["writer:gpt-5-mini"]!.calls, 2);
    assert.equal(roll["writer:gpt-5-mini"]!.tokens, 310);
    assert.equal(roll["verifier:gemini-3.1-pro-preview"]!.calls, 1);
  });
});
