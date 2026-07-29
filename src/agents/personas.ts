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
 * **Every role runs the same generation backbone**, the verifier included.
 *
 * It was cross-family until 0.6.1, on the argument that a verifier drawn from the
 * writer's own family inherits its blind spots. The argument is sound and it lost
 * to two things it cannot answer.
 *
 * It breaks the comparison. `docs/13-experiment-settings.md` puts the generation
 * backbone in the column that must be held constant across systems, and every
 * baseline runs `gpt-5-mini` throughout. A verifier on `gemini-3.1-pro-preview`
 * gives our system a stronger model in one role than any comparator gets, so the
 * measured margin — +11.8 over the same backbone on the LongBench-Write story
 * slice — mixes an architectural effect with a model advantage and cannot be
 * attributed.
 *
 * And it was unaffordable in a way that was specifically ours. The gateway returns
 * **zero** cache reads for that model, so a resident verifier re-sent its whole
 * growing history on every request: first-call input climbed 10,142 → 25,473 →
 * 41,241 → 61,934 tokens across four scenes, at eight times the input rate, and
 * the verifier became 81% of a run's cost on 11% of its round-trips. It then
 * exhausted the channel's plan quota mid-validation and every call failed, which
 * commits scenes unverified — the gate cannot be both the strongest model and the
 * one that stops answering.
 *
 * Cross-family remains available and worth measuring: `--verifier-model
 * gemini-3.1-pro-preview` restores it, and `withVerifier` records the choice in the
 * summary. The blind-spot question is a real one; it is now an ablation instead of
 * a confound in the main table.
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
    // Same backbone as every other role, and as every baseline; see the header for
    // why the cross-family default was withdrawn. `--verifier-model` restores it as
    // an ablation.
    model: "gpt-5-mini",
    /**
     * Two report channels, not one.
     *
     * `write_findings` is ConStory's nineteen consistency subtypes and feeds EID,
     * the metric of record for the results table's consistency column.
     * `write_craft_finding` is the axis the graders' quality rubrics penalise and
     * that taxonomy cannot express — a scene that repeats an earlier one, a story
     * that stops instead of ending. They are separate tools rather than one tool
     * with a flag because their findings are counted into different columns, and a
     * craft judgement filed as a consistency subtype would inflate an error density
     * with something that is not an error in it.
     */
    writeTools: ["write_findings", "write_craft_finding"],
    mayDelegate: false,
  },
  {
    role: "index-manager",
    model: "gpt-5-mini",
    /**
     * `fold_scene` first, because leaving it out of this list is what made 0.9.1
     * through 0.9.4 build an index of identities only.
     *
     * The factory granted it and this list did not name it, so
     * `allowlistMismatch` refused the whole invocation — correctly, by its own
     * argument — and the index-manager failed on *every scene of every run*.
     * The per-partition tools below are still granted, but the role never got as
     * far as calling one: the refusal happens at construction. Measured across
     * 26 runs on 0.9.1–0.9.4: **zero state entries, zero beliefs, zero
     * relations, zero events, in all of them**, against 11–101 state entries in
     * all 15 runs from 0.7.1 to 0.8.2.
     */
    writeTools: [
      "fold_scene",
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
export function systemPromptFor(
  role: AgentRole,
  agentsRoot: string,
  options: { readonly manuscriptLanguage?: "chinese" } = {},
): string {
  const shared = readFileSync(path.join(agentsRoot, "SHARED.md"), "utf8");
  const own = readFileSync(path.join(agentsRoot, role, "AGENT.md"), "utf8");
  const base = `${shared.trim()}\n\n---\n\n${own.trim()}`;
  return options.manuscriptLanguage === "chinese"
    ? `${CHINESE_MANUSCRIPT_DIRECTIVE}\n\n---\n\n${base}`
    : base;
}

/**
 * What a Chinese task needs said, in Chinese, before twenty-five thousand
 * characters of English instructions.
 *
 * Measured, and it is the largest single finding about our quality on
 * LongBench-Write. Half the benchmark is Chinese (58 of 120 tasks; 11 of the 21
 * we run), and on those tasks:
 *
 *     raw gpt-5-mini   zh 4.26   en 3.87   +0.39
 *     agentwrite       zh 4.02   en 4.03   -0.02
 *     bare-long-ctx    zh 3.94   en 3.72   +0.22
 *     ours             zh 3.24   en 3.55   -0.31
 *
 * **Every other system does as well or better in Chinese; only ours does worse.**
 * Against our own backbone with no scaffold at all, the harness costs 1.02 on
 * Chinese tasks and 0.32 on English ones — so roughly two thirds of our quality
 * deficit is Chinese-specific, and it appears when the scaffold is added. Two of
 * twenty-one manuscripts answered a Chinese prompt entirely in English, which
 * none of the eight baselines did.
 *
 * Prepended rather than translated. A faithful translation of five role files is
 * a day's careful work and a rushed one would be worse than none: the prompts
 * carry the tool contract, and a mistranslated refusal rule breaks the gate rather
 * than the prose. What the evidence actually implicates is register — the model is
 * being asked, at length and in English, to produce Chinese literary prose — so
 * the directive is short, in Chinese, and first.
 */
const CHINESE_MANUSCRIPT_DIRECTIVE = [
  "# 本书的语言：中文",
  "",
  "这部作品的委托是用中文写的，因此**正文必须全部是中文**——叙述、对白、内心独白，",
  "无一例外。下面那份英文说明只规定工作流程与工具契约，不规定作品的语言；把它读成",
  "「用英文写」是本项目实测过的、最常见也最昂贵的误解：二十一篇稿子里有两篇整本用",
  "英文回答了中文命题，另有五篇中途换了语言。",
  "",
  "语言不只是转写。中文文学散文有它自己的节奏、意象习惯与标点（「」《》，、。），",
  "请按中文的写法写，而不是把英文句式译成中文。专有名词、术语、引用的外文原名可以",
  "保留原文，那是自然的；成段的英文不是。",
  "",
  "工具名、参数名、实体 id（char-、loc-、obj-）以及一切写给 harness 的字段仍用英文，",
  "它们是文件系统的键，不是作品的一部分。",
].join("\n");

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
