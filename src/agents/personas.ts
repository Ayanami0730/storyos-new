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

/** Available to every role. Uniform read reach is a design guarantee. */
export const READ_TOOLS: readonly string[] = ["run_command", "read_relation_history"];

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
export const MEMORY_TOOLS: readonly string[] = ["remember", "read_memory"];

export const PERSONAS: readonly PersonaSpec[] = [
  {
    role: "orchestrator",
    model: "gpt-5-mini",
    writeTools: ["open_transaction", "abort_transaction", "request_commit"],
    mayDelegate: true,
  },
  {
    role: "context-builder",
    model: "gpt-5-mini",
    writeTools: ["build_context_packet"],
    mayDelegate: false,
  },
  {
    role: "writer",
    model: "gpt-5-mini",
    writeTools: ["write_staged_scene", "propose_state_delta"],
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
    writeTools: ["apply_state_delta", "commit_transaction"],
    mayDelegate: false,
  },
];

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
    ...MEMORY_TOOLS,
    ...persona.writeTools,
    ...(persona.mayDelegate ? DELEGATION_TOOLS : []),
  ];
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
