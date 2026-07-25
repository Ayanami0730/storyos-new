/**
 * Does the resident five-agent layer actually run against the gateway?
 *
 * The foundation smoke test proved one pi agent can drive our gateway with
 * native function calling. This proves the layer built on top: distinct
 * personas on distinct model families, sessions that persist across
 * invocations, a depth guard that refuses specialist-to-specialist delegation,
 * and a ledger that bills each call once rather than re-charging the
 * accumulated history.
 *
 * Run:
 *   export PATH="$HOME/bin/node22/bin:$PATH"
 *   YS_KEY="$(cat ~/.config/ys/key)" \
 *     node --experimental-strip-types smoke/residents-live.ts
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { Agent } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";

import { PERSONAS } from "../src/agents/personas.ts";
import {
  type AgentLike,
  ResidentAgents,
  delegationTools,
} from "../src/agents/residents.ts";
import { type ModelId, installGateway } from "../src/runtime/gateway.ts";

const AGENTS_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../agents",
);

const shellCalls: { role: string; purpose: string; command: string; got: string }[] = [];

/** A read-only stand-in for the index, so the smoke test needs no filesystem. */
const FAKE_INDEX: Record<string, string> = {
  "index/story/bible/characters/mira.yaml":
    "id: char-mira\neye_colour: grey\nage: 29\nlocation: the harbour\n",
  "index/story/structure/scenes/s-011.yaml":
    "id: s-011\nintent: Mira waits for the warden and he does not come.\n" +
    "present: [char-mira]\nreveal_limits: [must not reveal the warden's faction]\n",
};

/**
 * A shell that answers the way a real one would.
 *
 * The first version required the command to contain a literal full path, so
 * every `grep -rn s-011 index/` came back empty and the writer — correctly,
 * per its prompt — refused to invent the facts it could not find. That was the
 * fixture failing, not the agent, but it is worth recording: a read surface
 * that silently returns nothing is indistinguishable from a world where the
 * fact does not exist, and the agent's only honest response is to stop.
 */
function fakeShell(command: string): string {
  const paths = Object.keys(FAKE_INDEX);
  if (/^\s*(ls|find)\b/.test(command)) return paths.join("\n");

  const lower = command.toLowerCase();
  const mentioned = paths.filter((p) => {
    const stem = p.split("/").pop()!.replace(/\.[^.]+$/, "").toLowerCase();
    return lower.includes(p.toLowerCase()) || lower.includes(stem);
  });
  if (mentioned.length > 0) {
    return mentioned.map((p) => `==> ${p} <==\n${FAKE_INDEX[p]}`).join("\n");
  }

  // grep-like: search the contents for any bare word in the command.
  const words = command.match(/[A-Za-z_][A-Za-z0-9_-]{2,}/g) ?? [];
  const hits = paths.filter((p) =>
    words.some((w) => FAKE_INDEX[p]!.toLowerCase().includes(w.toLowerCase())),
  );
  return hits.length > 0
    ? hits.map((p) => `==> ${p} <==\n${FAKE_INDEX[p]}`).join("\n")
    : `no match. files in the index:\n${paths.join("\n")}`;
}

function buildTools(role: string, names: readonly string[]): unknown[] {
  const tools: unknown[] = [];

  if (names.includes("run_command")) {
    tools.push({
      label: "Run command",
      name: "run_command",
      description:
        "Read the index with a shell command (grep, ls, cat, head, wc). " +
        "State why you need it in `purpose`.",
      parameters: Type.Object({
        command: Type.String({ description: "The command to run" }),
        purpose: Type.String({
          description: "One line: what you are trying to find out",
        }),
      }),
      execute: async (_id: string, args: { command: string; purpose: string }) => {
        const output = fakeShell(args.command);
        shellCalls.push({
          role,
          purpose: args.purpose,
          command: args.command,
          got: output.slice(0, 60),
        });
        return { content: [{ type: "text", text: output }] };
      },
    });
  }

  if (names.includes("propose_state_delta")) {
    tools.push({
      label: "Propose state delta",
      name: "propose_state_delta",
      description:
        "Declare what this scene changed. One claim per fact, each quoting the " +
        "prose it comes from.",
      parameters: Type.Object({
        scene_id: Type.String(),
        claims: Type.Array(
          Type.Object({
            entity: Type.String(),
            attribute: Type.String(),
            value: Type.String(),
            quote: Type.String({ description: "Verbatim prose establishing it" }),
          }),
        ),
      }),
      execute: async (_id: string, args: { claims: unknown[] }) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify({ staged: true, claims: args.claims.length }),
          },
        ],
      }),
    });
  }

  return tools;
}

const started = Date.now();
const gateway = installGateway();

const residents = new ResidentAgents({
  agentsRoot: AGENTS_ROOT,
  personas: PERSONAS,
  factory: (persona, systemPrompt, toolNames) =>
    new (Agent as unknown as new (init: unknown) => AgentLike)({
      initialState: {
        systemPrompt,
        model: gateway.model(persona.model as ModelId),
        thinkingLevel: "off",
        tools: buildTools(persona.role, toolNames),
      },
    }),
});

const first = await residents.invoke(
  "writer",
  "Draft scene s-011 in about 120 words. Read the scene card and Mira's entry " +
    "from the index first, then call propose_state_delta with what the scene " +
    "established. Respect the reveal limits.",
  { txid: "tx-smoke", caller: "orchestrator" },
);

// Same agent, second turn: if residency works it can answer from its own
// history without reading the index again.
const second = await residents.invoke(
  "writer",
  "In one sentence: what eye colour did you give Mira, and where did you get it?",
  { txid: "tx-smoke", caller: "orchestrator" },
);

const verified = await residents.invoke(
  "verifier",
  `Here is a drafted scene. Canon says Mira's eyes are grey.\n\n${first.text}\n\n` +
    "Report any factual contradiction with canon in one or two sentences, or say it looks fine.",
  { txid: "tx-smoke", caller: "orchestrator" },
);

let depthRefused = false;
try {
  await residents.invoke("verifier", "check", { txid: "tx-smoke", caller: "writer" });
} catch (error) {
  depthRefused = /specialists never call specialists/.test(String(error));
}

const ledger = residents.ledger();
const models = new Set(ledger.map((e) => e.model));

console.log(
  JSON.stringify(
    {
      elapsed_ms: Date.now() - started,
      writer_first_words: first.text.split(/\s+/).filter(Boolean).length,
      writer_draft: first.text,
      writer_second_turn: second.text.slice(0, 220),
      verifier_verdict: verified.text.slice(0, 220),
      shell_calls: shellCalls,
      delegation_tools: delegationTools(residents).map((t) => t.name),
      depth_guard_refused_specialist_delegation: depthRefused,
      writer_session_messages: residents.agent("writer").state.messages.length,
      models_used: [...models],
      ledger: ledger.map((e) => ({
        role: e.role,
        model: e.model,
        tokens: e.usage.total,
        tool_calls: e.toolCalls,
        ms: e.durationMs,
      })),
      roll_up: residents.rollUp(),
      verdict:
        ledger.length === 3 &&
        depthRefused &&
        residents.agent("writer").state.messages.length > 2 &&
        [...models].some((m) => m.includes("gemini")) &&
        [...models].some((m) => m.includes("gpt"))
          ? "PASS: resident personas, cross-family verifier, depth guard and ledger all work"
          : "FAIL: see fields above",
    },
    null,
    2,
  ),
);
