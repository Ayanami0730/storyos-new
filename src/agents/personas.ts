/**
 * The five personas: prompt, model, and tool allowlist per role.
 *
 * Three properties are enforced here rather than trusted to a prompt, because
 * each of them is a guarantee the paper claims.
 *
 * **Delegation depth is exactly one.** Only the orchestrator gets `call_*`
 * tools. A specialist that can spawn specialists turns a bounded call graph
 * into an unbounded one, and the budget stops meaning anything.
 *
 * **Read reach is uniform.** Every persona's allowlist contains every read
 * tool. What differs is write authority — that asymmetry is the design, and a
 * persona quietly given a narrower view breaks the claim that no agent is a
 * second-class citizen.
 *
 * **The verifier is cross-family by default.** It is checking prose produced by
 * the writer's model; drawn from the same family it inherits the same blind
 * spots, and the deterministic layer only covers what needs no judgement.
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import type { AgentRole } from "../transaction/types.ts";
import type { ModelId } from "../runtime/gateway.ts";

export interface PersonaSpec {
  readonly role: AgentRole;
  readonly model: ModelId;
  /** Tools this role may call, beyond the universal read set. */
  readonly writeTools: readonly string[];
  /** True only for the orchestrator. */
  readonly mayDelegate: boolean;
}

/**
 * Available to every role. Uniform read reach is a design guarantee.
 *
 * `read_relation_history` is here rather than only on the writer because a
 * relation's narrative view — what two people were to each other at each stage
 * and what changed it — is as much use to the verifier checking whether a scene
 * contradicts their history as to the writer creating it. Reading a YAML gives
 * you the structure instead.
 */
export const READ_TOOLS: readonly string[] = ["read_relation_history"];

/**
 * The shell and the path-addressed read, for every role but the writer.
 *
 * The writer's exception is about attention, not trust. Measured over a whole
 * run it issued four shell commands to the context-builder's forty-eight and
 * asked the builder nothing at all — a research tool it barely used alongside a
 * question it never asked produced neither. Its input surface is its packet,
 * `read_context` to re-read it, and `ask_context_builder` to extend it.
 */
export const SEARCH_TOOLS: readonly string[] = ["bash", "read", "read_index"];

/**
 * Also available to every role.
 *
 * `remember` writes a file, but not a canonical one, so it does not breach the
 * rule that only index-manager changes canonical state — and the boundary is
 * enforced rather than trusted: a memory mentioning a story entity is rejected.
 * Every role gets it for the same reason every role gets the read tools. The
 * lesson a verifier learns about its own false positives is worth exactly as
 * much as the one a writer learns about voice.
 */
export const MEMORY_TOOLS: readonly string[] = [
  "remember",
  "read_memory",
  "read_skill",
  "write_skill",
];

export const PERSONAS: readonly PersonaSpec[] = [
  {
    role: "orchestrator",
    model: "gpt-5-mini",
    writeTools: ["submit_plan", "update_plan", "abandon_scene"],
    mayDelegate: true,
  },
  {
    role: "context-builder",
    model: "gpt-5-mini",
    writeTools: ["add_context_item", "note_gap", "answer_writer"],
    mayDelegate: false,
  },
  {
    role: "writer",
    model: "gpt-5-mini",
    writeTools: [
      "write_staged_scene",
      "propose_state_delta",
      "read_context",
      "ask_context_builder",
    ],
    mayDelegate: false,
  },
  {
    role: "verifier",
    // Cross-family on purpose; see the header.
    model: "gemini-3.1-pro-preview",
    writeTools: ["write_findings"],
    mayDelegate: false,
  },
  {
    role: "index-manager",
    model: "gpt-5-mini",
    writeTools: [
      "upsert_character",
      "upsert_entity",
      "append_state",
      "append_beliefs",
      "record_relation_phase",
      "append_event",
      "record_rhythm",
      "register_promise",
      "pay_off_promise",
      "record_retcon",
    ],
    mayDelegate: false,
  },
];

/**
 * The orchestrator's delegation tools.
 *
 * Each is a call to a resident specialist *and* a step of the scene
 * transaction, which is not a coincidence: the transaction's actors are the
 * specialists. `call_index_manager` is the commit, because index-manager is the
 * only actor that may produce COMMITTED — so there is no separate commit tool
 * for a different role to reach.
 */
export const DELEGATION_TOOLS: readonly string[] = [
  "call_context_builder",
  "call_writer",
  "call_verifier",
  "call_index_manager",
];

export function personaFor(role: AgentRole): PersonaSpec {
  const persona = PERSONAS.find((p) => p.role === role);
  if (!persona) throw new Error(`no persona defined for ${role}`);
  return persona;
}

/** The full tool allowlist for a role, read tools included. */
export function toolNamesFor(role: AgentRole): readonly string[] {
  const persona = personaFor(role);
  return [
    ...READ_TOOLS,
    ...(role === "writer" ? [] : SEARCH_TOOLS),
    ...MEMORY_TOOLS,
    ...persona.writeTools,
    ...(persona.mayDelegate ? DELEGATION_TOOLS : []),
  ];
}

/**
 * Check what was actually built against what the role is allowed.
 *
 * This list used to name six tools that did not exist — `open_transaction`,
 * `build_context_packet`, `apply_state_delta` and others — while the factory
 * ignored it entirely and assembled tools from a conditional expression
 * somewhere else. A permission model nothing consults is a comment, and this
 * one was a comment that had drifted into being wrong. Comparing both ways
 * matters: a tool granted but not listed is an unreviewed capability, and a
 * tool listed but not granted is a role that cannot do its job and will not say
 * so until it tries.
 */
export function allowlistMismatch(
  role: AgentRole,
  built: readonly string[],
): { readonly unlisted: readonly string[]; readonly missing: readonly string[] } | null {
  const allowed = new Set(toolNamesFor(role));
  const actual = new Set(built);
  const unlisted = [...actual].filter((t) => !allowed.has(t)).sort();
  const missing = [...allowed].filter((t) => !actual.has(t)).sort();
  return unlisted.length === 0 && missing.length === 0 ? null : { unlisted, missing };
}

/**
 * The system prompt: the shared contract, then the role's own file.
 *
 * Composed at load rather than duplicated into five files, because the shared
 * half is the part most likely to drift out of agreement with itself if copied.
 */
export function systemPromptFor(role: AgentRole, agentsRoot: string): string {
  const shared = readFileSync(path.join(agentsRoot, "SHARED.md"), "utf8");
  const own = readFileSync(path.join(agentsRoot, role, "AGENT.md"), "utf8");
  return `${shared.trim()}\n\n---\n\n${own.trim()}`;
}

/**
 * Backbone override for the second experimental arm.
 *
 * The verifier is deliberately excluded: swapping the writer's backbone is the
 * experiment, and swapping the verifier along with it would reintroduce the
 * same-family blind spot the split exists to avoid, silently, in exactly the
 * run meant to measure something else.
 */
export function withBackbone(backbone: ModelId): readonly PersonaSpec[] {
  return PERSONAS.map((p) =>
    p.role === "verifier" ? p : { ...p, model: backbone },
  );
}

/**
 * Point the verifier at a different model, deliberately and on the record.
 *
 * This is the one knob that changes what a result *means*, so it is separate from
 * `withBackbone` and never implied by it. Two reasons it has to exist:
 *
 * The cross-family verifier is a real confound in every comparison published so
 * far. Our rows run `gpt-5-mini` everywhere except the verifier, while the
 * baselines run `gpt-5-mini` throughout — so "we beat them by 11.8" mixes an
 * architectural effect with a stronger model in one role, and the only way to
 * separate the two is to run the same harness with a same-family verifier.
 *
 * And it is the practical escape when the cross-family channel is unusable. The
 * `gemini-3.1-pro-preview` plan quota ran out mid-validation and every verifier
 * call failed, which does not merely slow a run down — it commits scenes
 * unverified and makes the run useless for measuring the verifier at all.
 *
 * Whatever it is set to is recorded in the summary, because a cost or quality row
 * from a same-family verifier is not comparable with one from a cross-family
 * verifier.
 */
export function withVerifier(
  personas: readonly PersonaSpec[],
  model: ModelId,
): readonly PersonaSpec[] {
  return personas.map((p) => (p.role === "verifier" ? { ...p, model } : p));
}
