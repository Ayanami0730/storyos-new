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

  readonly systemPrompt: string;
  readonly toolNames: readonly string[];
  readonly model: string;
  /** What the provider claims it received; drives the compaction thresholds. */
  reportedInput = 100;
  /** Model calls this turn, as a tool loop produces. Each reports its own usage. */
  callsPerTurn = 1;

  constructor(systemPrompt: string, toolNames: readonly string[], model: string) {
    this.systemPrompt = systemPrompt;
    this.toolNames = toolNames;
    this.model = model;
    this.#state = { messages: [], systemPrompt };
  }

  /**
   * A single object, not a fresh one per read: a pi `Agent` exposes mutable
   * state, and a fake whose getter returns a new literal would silently drop
   * every assignment the system makes to it — including the compacted
   * transcript, which is the thing most of these tests are about.
   */
  readonly #state: {
    messages: AgentLike["state"]["messages"][number][];
    systemPrompt: string;
  };

  get state() {
    return this.#state;
  }

  get messages() {
    return this.#state.messages;
  }

  set messages(value: AgentLike["state"]["messages"][number][]) {
    this.#state.messages = value;
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    const call = {
      role: "assistant",
      content: [
        { type: "toolCall", name: "run_command" },
        { type: "text", text: `did: ${input}` },
      ],
      usage: {
        input: this.reportedInput,
        output: 40,
        cacheRead: 10,
        reasoning: 5,
        totalTokens: 155,
      },
      model: this.model,
      stopReason: "endTurn",
    };
    this.messages = [
      ...this.messages,
      { role: "user", content: input },
      ...Array.from({ length: this.callsPerTurn }, () => ({ ...call })),
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

describe("a turn that stops responding", () => {
  /** An agent whose turn never settles until it is aborted. */
  class HangingAgent extends FakeAgent {
    aborted = false;
    #release: (() => void) | null = null;

    override async prompt(input: string): Promise<void> {
      this.prompts.push(input);
      await new Promise<void>((resolve) => {
        this.#release = resolve;
      });
      await super.prompt(input);
    }

    abort(): void {
      this.aborted = true;
      this.#release?.();
    }
  }

  function hanging(turnTimeoutMs: number) {
    const built: HangingAgent[] = [];
    const registry = new ResidentAgents({
      agentsRoot: AGENTS_ROOT,
      personas: PERSONAS,
      turnTimeoutMs,
      factory: (persona, systemPrompt, toolNames) => {
        const agent = new HangingAgent(systemPrompt, toolNames, persona.model);
        built.push(agent);
        return agent;
      },
    });
    return { registry, built };
  }

  it("aborts and reports rather than waiting indefinitely", async () => {
    const { registry, built } = hanging(20);
    await assert.rejects(() => registry.invoke("writer", "draft", ctx), /TurnTimeout|did not finish/);
    assert.equal(built[0]!.aborted, true, "the turn must be aborted, not merely abandoned");
  });

  it("still leaves a ledger entry for what the stalled turn cost", async () => {
    // A run that omits its expensive failures reports a cheaper system than
    // the one we actually have.
    const { registry } = hanging(20);
    await registry.invoke("writer", "draft", ctx).catch(() => {});
    const entry = registry.ledger().at(-1)!;
    assert.equal(entry.role, "writer");
    assert.equal(entry.stopReason, "timeout");
  });
});

describe("the memory section of a resident's prompt", () => {
  function withSuffix(suffix: () => string) {
    const built: FakeAgent[] = [];
    const registry = new ResidentAgents({
      agentsRoot: AGENTS_ROOT,
      personas: PERSONAS,
      promptSuffix: suffix,
      factory: (persona, systemPrompt, toolNames) => {
        const agent = new FakeAgent(systemPrompt, toolNames, persona.model);
        built.push(agent);
        return agent;
      },
    });
    return { registry, built };
  }

  it("composes the suffix into the prompt an agent is built with", async () => {
    const { registry, built } = withSuffix(() => "## Your memory\n\n- [A](a.md) — hook");
    await registry.invoke("writer", "draft", ctx);
    assert.match(built[0]!.systemPrompt, /- \[A\]\(a\.md\) — hook/);
    // The role's own contract is still there; the suffix is added, not swapped.
    assert.match(built[0]!.systemPrompt, /write_staged_scene/);
  });

  it("puts a newly written memory into a session that is already running", async () => {
    // An agent that writes a memory and cannot see it until the next process
    // has no reason to write a second one. The index lives in the system
    // prompt rather than in a message precisely so that compaction, which is
    // about to fold the transcript, cannot eat it.
    let index = "";
    const { registry, built } = withSuffix(() => (index ? `remembered: ${index}` : "nothing yet"));
    await registry.invoke("writer", "draft", ctx);
    assert.match(built[0]!.state.systemPrompt!, /nothing yet/);

    index = "- [A](a.md) — hook";
    registry.refreshSystemPrompt("writer");
    assert.match(built[0]!.state.systemPrompt!, /remembered: - \[A\]/);
  });

  it("is a no-op for a role that has not been invoked yet", () => {
    const { registry, built } = withSuffix(() => "anything");
    registry.refreshSystemPrompt("verifier");
    assert.deepEqual(built, [], "refreshing must not be what brings an agent into being");
  });
});

describe("compaction", () => {
  /** An agent whose reported input size we control, to drive the thresholds. */
  function withCompaction(inputTokens: number) {
    const summaries: string[] = [];
    let clock = 1_000;
    const built: FakeAgent[] = [];
    const registry = new ResidentAgents({
      agentsRoot: AGENTS_ROOT,
      personas: PERSONAS,
      now: () => (clock += 250),
      compaction: {
        thresholds: {
          contextWindow: 1_000,
          maxOutput: 200,
          level1Fraction: 0.7,
          level2Fraction: 0.85,
          level2Reserve: 130,
          blockReserve: 30,
          keepRecentToolResults: 1,
          keepRecentMessages: 2,
        },
        summarise: (role, input) => {
          summaries.push(`${role}:${input.canonDigest}`);
          return "SUMMARY OF EARLIER WORK";
        },
        context: () => ({
          canonDigest: "3 facts",
          openPromises: ["the box"],
          recentSceneIds: ["s-001"],
        }),
      },
      factory: (persona, systemPrompt, toolNames) => {
        const agent = new FakeAgent(systemPrompt, toolNames, persona.model);
        agent.reportedInput = inputTokens;
        built.push(agent);
        return agent;
      },
    });
    return { registry, built, summaries };
  }

  it("does nothing while there is room", async () => {
    const { registry } = withCompaction(100);
    await registry.invoke("writer", "draft", ctx);
    assert.deepEqual(registry.compactions(), []);
  });

  it("fires level 1 once the reported context crosses the fraction", async () => {
    // Effective budget is 1000 - 200 = 800; level 1 at 560.
    const { registry } = withCompaction(600);
    await registry.invoke("writer", "draft", ctx);
    const [record] = registry.compactions();
    assert.equal(record!.level, "level1");
    // 600 fresh + 10 cached. A cached prompt token still occupies the window,
    // and under prompt caching most of a resident's transcript arrives that
    // way — a policy watching only the fresh half watches the small half.
    assert.equal(record!.inputTokens, 610);
  });

  it("measures the last call of a turn, not the sum of the turn", async () => {
    // A turn with tool calls is several model calls. Summing their inputs is
    // right for the bill and wrong for "how big is the context now": in
    // runs/v1 a writer turn reported 83,185 input tokens for a transcript that
    // was never larger than about 15k, and compaction read that as pressure.
    const { registry, built } = withCompaction(300);
    await registry.invoke("writer", "draft", ctx);
    const agent = built[0]!;
    agent.callsPerTurn = 3;
    await registry.invoke("writer", "draft again", ctx);

    const entry = registry.ledger().at(-1)!;
    assert.equal(entry.usage.input, 900, "the bill sees all three calls");
    assert.equal(entry.contextTokens, 310, "the policy sees only the last one");
    assert.deepEqual(registry.compactions(), [], "three small calls are not pressure");
  });

  it("does not recurse when summarising is itself a turn by the same agent", async () => {
    // Summarising goes back through invoke, so without a re-entrancy guard the
    // first level-2 compaction loops forever: summarise → invoke → still over
    // threshold → summarise. It never fired before only because the trigger
    // was never reached, which is how a latent infinite loop survives review.
    let summarisations = 0;
    const registry: ResidentAgents = new ResidentAgents({
      agentsRoot: AGENTS_ROOT,
      personas: PERSONAS,
      compaction: {
        thresholds: {
          contextWindow: 1_000,
          maxOutput: 200,
          level1Fraction: 0.7,
          level2Fraction: 0.85,
          level2Reserve: 130,
          blockReserve: 30,
          keepRecentToolResults: 1,
          keepRecentMessages: 2,
        },
        summarise: async (role) => {
          summarisations += 1;
          if (summarisations > 5) throw new Error("compaction recursed");
          const { text } = await registry.invoke(role, "summarise yourself", ctx);
          return text;
        },
        context: () => ({ canonDigest: "3 facts", openPromises: [], recentSceneIds: [] }),
      },
      factory: (persona, systemPrompt, toolNames) => {
        const agent = new FakeAgent(systemPrompt, toolNames, persona.model);
        agent.reportedInput = 700;
        return agent;
      },
    });

    await registry.invoke("writer", "draft one", ctx);
    await registry.invoke("writer", "draft two", ctx);
    assert.equal(summarisations, 1);
    assert.equal(registry.compactions().length, 2);
  });

  it("escalates to level 2 near the ceiling and writes a summary", async () => {
    const { registry, summaries } = withCompaction(700);
    await registry.invoke("writer", "draft one", ctx);
    await registry.invoke("writer", "draft two", ctx);
    const record = registry.compactions().at(-1)!;
    assert.equal(record.level, "level2");
    assert.ok(record.summarised > 0);
    // The summariser is handed a freshly read canon digest, not a cached one:
    // canon moves while the agent works, and a stale digest misleads.
    // The role is passed through so each agent compresses its own memory with
    // its own model, rather than one agent summarising another's session.
    assert.deepEqual(summaries.at(-1), "writer:3 facts");
  });

  it("uses the size the provider reported rather than estimating it", async () => {
    const { registry } = withCompaction(600);
    await registry.invoke("writer", "draft", ctx);
    // The fake's messages are tiny; only the reported input can have triggered
    // this, which is the point — a policy that estimates fires late on a long
    // transcript and never on a short one full of huge tool payloads.
    assert.equal(registry.compactions().length, 1);
  });

  it("stays off entirely when no policy is configured", async () => {
    const { registry } = residents();
    await registry.invoke("writer", "draft", ctx);
    assert.deepEqual(registry.compactions(), []);
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
