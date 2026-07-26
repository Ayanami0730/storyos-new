import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { AgentRole } from "../transaction/types.ts";
import { TokenBudget } from "../runtime/budget.ts";
import { SceneStage, delegationToolNameFor, orchestratorTools } from "../runtime/orchestration.ts";
import { PERSONAS } from "./personas.ts";
import {
  type AgentLike,
  DEFAULT_TURN_TIMEOUT_MS,
  DelegationError,
  ResidentAgents,
  defaultTurnTimeoutFor,
  isRetryableTurnError,
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

function residents(budget?: TokenBudget) {
  const built: FakeAgent[] = [];
  let clock = 1_000;
  const registry = new ResidentAgents({
    agentsRoot: AGENTS_ROOT,
    personas: PERSONAS,
    now: () => (clock += 250),
    ...(budget ? { budget } : {}),
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

describe("delegation", () => {
  it("names a delegation tool after the role it reaches", () => {
    assert.equal(delegationToolNameFor("index-manager"), "call_index_manager");
  });

  it("attributes every delegation to a transaction without asking the model for one", () => {
    // The delegation tools used to take a `txid` argument and validate it. They
    // no longer take one: the director owns the transaction and supplies it, so
    // a call that is not attributable to a transaction is not expressible
    // rather than merely rejected. What the orchestrator passes is a brief.
    const tools = orchestratorTools(new SceneStage()) as {
      name: string;
      parameters: { properties?: Record<string, unknown> };
    }[];
    const call = tools.find((t) => t.name === "call_writer")!;
    assert.deepEqual(Object.keys(call.parameters.properties ?? {}), ["brief"]);
  });
});

describe("a provider call that fails", () => {
  /**
   * An agent that fails a scripted number of times, the way pi actually fails.
   *
   * Not by throwing: pi appends an assistant message with empty content, zero
   * usage and `stopReason: "error"`, and the loop carries on. That shape is the
   * whole reason this class of bug is dangerous, so the fake reproduces it
   * rather than a convenient exception.
   */
  class FlakyAgent extends FakeAgent {
    failures: number;
    readonly errorMessage: string;

    constructor(
      systemPrompt: string,
      toolNames: readonly string[],
      model: string,
      failures: number,
      errorMessage: string,
    ) {
      super(systemPrompt, toolNames, model);
      this.failures = failures;
      this.errorMessage = errorMessage;
    }

    override async prompt(input: string): Promise<void> {
      this.prompts.push(input);
      if (this.failures > 0) {
        this.failures -= 1;
        this.state.messages.push({ role: "user", content: [{ type: "text", text: input }] });
        this.state.messages.push({
          role: "assistant",
          content: [],
          usage: { input: 0, output: 0, cacheRead: 0, totalTokens: 0 },
          stopReason: "error",
          errorMessage: this.errorMessage,
        });
        return;
      }
      await super.prompt(input);
    }
  }

  function flaky(failures: number, errorMessage: string) {
    const retries: { role: AgentRole; attempt: number }[] = [];
    const registry = new ResidentAgents({
      agentsRoot: AGENTS_ROOT,
      personas: PERSONAS,
      // Zero waits: the backoff durations are a policy about a provider's quota
      // window, not something a unit test should sit through.
      retryBackoffMs: [0, 0, 0],
      onRetry: ({ role, attempt }) => retries.push({ role, attempt }),
      factory: (persona, systemPrompt, toolNames) =>
        new FlakyAgent(systemPrompt, toolNames, persona.model, failures, errorMessage),
    });
    return { registry, retries };
  }

  it("classifies which failures are worth retrying", () => {
    // A rate limit is a scheduling accident and says nothing about the request;
    // a 400 will fail identically forever and retrying only spends the budget
    // more slowly.
    assert.ok(isRetryableTurnError("429: channel:model_rate_limited"));
    assert.ok(isRetryableTurnError("503 Service Unavailable"));
    assert.ok(isRetryableTurnError("Resource exhausted. Please try again later."));
    // These are the provider's actual words, and the first version of this
    // pattern matched "timeout" but not "timed out" — so a verifier that
    // reported `Request timed out.` was treated as permanently broken and
    // never retried once. The strings come from real failures, not from
    // imagining what a failure might say.
    assert.ok(isRetryableTurnError("Request timed out."));
    assert.ok(isRetryableTurnError("terminated"));
    assert.ok(isRetryableTurnError("socket hang up"));
    assert.ok(!isRetryableTurnError("400: invalid request: unknown field"));
    assert.ok(!isRetryableTurnError("404: model_not_found"));
    // A content filter is a decision about the request, not a transient fault;
    // retrying it spends the budget to be refused again in the same words.
    assert.ok(!isRetryableTurnError("Provider finish_reason: content_filter"));
  });

  it("raises rather than returning an empty turn that reads as success", async () => {
    const { registry } = flaky(99, "400: invalid request");
    // The failure this pins: our verifier reports defects by calling a tool, so
    // a turn that never happened is indistinguishable from a clean scene unless
    // somebody throws.
    await assert.rejects(
      () => registry.invoke("verifier", "check it", ctx),
      /TurnFailed|turn failed/,
    );
  });

  it("gets through a rate limit that clears, rather than reporting a clean scene", async () => {
    const { registry, retries } = flaky(2, "429: channel:model_rate_limited");
    const turn = await registry.invoke("verifier", "check it", ctx);
    // The whole point. Two 429s used to mean "APPROVED, 0 findings"; now they
    // mean two waits and then an actual verification.
    assert.match(turn.text, /did: check it/);
    assert.deepEqual(
      retries.map((r) => r.attempt),
      [1, 2],
    );
  });

  it("does not retry a failure that will never succeed", async () => {
    const { registry, retries } = flaky(99, "400: invalid request");
    await registry.invoke("verifier", "check it", ctx).catch(() => {});
    assert.deepEqual(retries, []);
  });

  it("still records what a failed turn cost, with the provider's own words", async () => {
    const { registry } = flaky(99, "429: channel:model_rate_limited");
    await registry.invoke("verifier", "check it", ctx).catch(() => {});
    const entry = registry.ledger().at(-1)!;
    assert.equal(entry.stopReason, "error");
    assert.match(entry.errorMessage!, /model_rate_limited/);
  });

  it("rewinds the transcript before retrying, so silence is not left in history", async () => {
    const { registry } = flaky(99, "429: rate limited");
    await registry.invoke("verifier", "check it", ctx).catch(() => {});
    const messages = registry.agent("verifier").state.messages;
    // A resident agent keeps its history for the whole book. Leaving three
    // copies of a question it appears to have answered with silence would
    // follow it into every later scene.
    assert.equal(messages.filter((m) => m.role === "user").length, 1);
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

  it("gives the orchestrator room for the turns its own turn contains", () => {
    // The bug this pins was one edit away from shipping. Once the orchestrator
    // drives the loop, a single `call_verifier` blocks for a whole verifier
    // turn, and one scene nests a build, a draft, a review and a commit plus up
    // to two more draft-and-review pairs. Against the slowest turns measured
    // (verifier 527s, builder 118s, index-manager 136s) a repaired scene is
    // around 2,000s of entirely legitimate work — so a specialist's ceiling
    // applied to the orchestrator would abort healthy scenes mid-commit and
    // blame a timeout.
    const slowestSpecialistTurnMs = 527_000;
    const scenesWorstCase = 118_000 + 3 * (64_000 + slowestSpecialistTurnMs) + 136_000;

    assert.ok(
      defaultTurnTimeoutFor("orchestrator") > scenesWorstCase,
      "the orchestrator must outlast a scene that spends its whole repair budget",
    );
    for (const role of PERSONAS.map((p) => p.role).filter((r) => r !== "orchestrator")) {
      assert.equal(defaultTurnTimeoutFor(role), DEFAULT_TURN_TIMEOUT_MS);
      assert.ok(
        defaultTurnTimeoutFor(role) > slowestSpecialistTurnMs,
        `${role}'s ceiling must sit above the slowest legitimate turn observed`,
      );
    }
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
          // High enough that these tests exercise the overflow trigger alone.
          level1PayloadTokens: 1_000_000,
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
          // High enough that these tests exercise the overflow trigger alone.
          level1PayloadTokens: 1_000_000,
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
    // `tokens` is input + output, which is what every baseline counts and
    // therefore the only figure a comparison may use.
    assert.equal(roll["writer:gpt-5-mini"]!.tokens, 280);
    // `reported` keeps what the provider actually said, cache reads included.
    assert.equal(roll["writer:gpt-5-mini"]!.reported, 310);
    assert.equal(roll["verifier:gemini-3.1-pro-preview"]!.calls, 1);
  });

  it("keeps cache reads out of what the budget charges", async () => {
    // The bug this pins cost most of every long run. pi's `totalTokens`
    // includes `cacheRead`, and under prompt caching that was 89.5% of a
    // measured run — 7,490,529 of 8,369,537 — against 879,008 of fresh input
    // and output. Charging it stopped runs after about a ninth of the work the
    // baselines are allowed, every one of which counts `input + output` alone.
    const budget = new TokenBudget(1_000, { enforce: true });
    const { registry } = residents(budget);
    await registry.invoke("writer", "draft", ctx);
    const [entry] = registry.ledger();
    assert.equal(entry!.usage.total, 155);
    assert.equal(entry!.usage.billable, 140);
    assert.equal(entry!.usage.cacheRead, 10);
    assert.equal(budget.spent, 140);
  });
});
