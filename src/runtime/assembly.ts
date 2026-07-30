/**
 * Wiring: five resident agents, their tools, and the seams between them.
 *
 * This was 400 lines inside the CLI entry point, next to argument parsing and
 * summary rendering, and the mixture had a cost beyond ugliness — the question
 * "which tools does the verifier actually have" was answered by reading a
 * conditional expression in the middle of a file whose subject was command-line
 * flags. Assembly is a subject of its own, and this is it.
 *
 * The decisions worth knowing before reading the code:
 *
 * **Read reach is uniform, write authority is not.** Every role except the
 * writer gets the same `bash`, `read`, `read_index` and `read_relation_history`
 * over the same tree. What differs is what a role may change. The writer is the
 * one exception and it is an exception about attention rather than trust: it ran
 * four shell commands in a whole run against the builder's forty-eight, and a
 * writer spending its turn grepping is a writer not writing. It gets its packet,
 * `read_context` to re-read it, and `ask_context_builder` to extend it.
 *
 * **Tools are registered once, against getters.** The agents are resident, so a
 * tool that closed over scene 1's buffer would still be writing into it at scene
 * 40. Every per-scene thing therefore arrives through a bus or a stage that the
 * loop swaps: `SceneToolBus` for prose and findings, `BuilderBus` for packet
 * items, `SceneStage` for the orchestrator's delegation targets, and a mutable
 * `partitionWriter` holder for the backfill in progress.
 *
 * **Memory reaches a live agent through its system prompt, not a message.** A
 * message would sit at the top of the transcript compaction is about to fold, so
 * the one thing designed to survive compaction would be the thing compaction
 * eats.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { Agent } from "@earendil-works/pi-agent-core";

import { summaryPrompt, thresholdsFor } from "../agents/compaction.ts";
import { indexManagerTools } from "../agents/index-manager-tools.ts";
import { AgentMemory, memorySection } from "../agents/memory.ts";
import { memoryTools } from "../agents/memory-tools.ts";
import {
  PERSONAS,
  type PersonaSpec,
  allowlistMismatch,
  withBackbone,
  withVerifier,
} from "../agents/personas.ts";
import { type AgentLike, ResidentAgents } from "../agents/residents.ts";
import { skillTools } from "../agents/skill-tools.ts";
import { SkillLibrary, installStarterSkills, skillsSection } from "../agents/skills.ts";
import type { ContextPacket } from "../context/types.ts";
import { PartitionWriter } from "../index/backfill.ts";
import type { CanonicalIndex, FileWrite } from "../index/commit.ts";
import { paths } from "../index/tree.ts";
import type { AgentRole } from "../transaction/types.ts";
import { readIndexTool } from "../tools/read-index.ts";
import { nativeTools } from "../tools/pi-tools.ts";
import { relationHistoryTool } from "../tools/relation-tool.ts";
import type { SandboxBackend } from "../sandbox/types.ts";
import { type ArtifactStore, artifactPaths, renderFollowUp } from "./artifacts.ts";
import { type BudgetProfile, TokenBudget } from "./budget.ts";
import { AllocationState, type SceneAllocation } from "./allocation.ts";
import { SceneToolBus } from "./collaborators.ts";
import { type ModelId, installGateway } from "./gateway.ts";
import { SceneStage, orchestratorTools } from "./orchestration.ts";
import {
  BuilderBus,
  askBuilderTool,
  builderBrief,
  followUpBrief,
  readContextTool,
} from "./packet-builder.ts";
import { MIN_WORDS_PER_SCENE, type StoryPlan, planTool, sceneCountFor, updatePlanTool } from "./plan.ts";
import { sceneCountForRequest } from "./parts.ts";
import type { BuildResult, Draft } from "./scene-loop.ts";

/** One shell read, with who ran it and during which scene. */
export interface ReadRecord {
  readonly role: AgentRole;
  readonly scene: string;
  readonly command: string;
  readonly durationMs: number;
}

export interface AssemblyOptions {
  readonly index: CanonicalIndex;
  readonly artifacts: ArtifactStore;
  readonly projectRoot: string;
  /** Where the role prompts are read from. */
  readonly agentsRoot: string;
  readonly profile: BudgetProfile;
  readonly budget: TokenBudget;
  readonly targetWords: number;
  /**
   * How long a scene is asked to be, which is what decides how many there are.
   *
   * A knob rather than the constant it used to be, because it is the cheapest
   * available form of "write a chapter at a time": the scene already *is* the
   * unit of one packet build, one writer call, one verifier pass and one commit,
   * so tripling its size divides all four by three without a second state
   * machine to get wrong.
   *
   * It is an experiment, not a tuning parameter, and the evidence points both
   * ways. For: `lbw029` written as one scene instead of four scored 93.6 against
   * 88.0 with S_q 4.50 against 3.83, at $0.46 against $1.31 — fewer, larger
   * units were better *and* cheaper there. Against: per-scene session resets are
   * what stopped the writer's context reaching 209,891 tokens and dying at 40k,
   * and a longer scene grows it again within the unit.
   *
   * So it defaults to the measured value and is recorded per run, and the arms
   * are compared at n≥3 — two same-code samples of one task have come back 6.5
   * S-bar points apart, so nothing smaller than that is readable at n=1.
   */
  readonly wordsPerScene?: number;
  /**
   * The request itself, so the plan tool's scene-count ceiling agrees with what
   * the planner was asked for.
   *
   * Both are derived from the length alone unless the request names its own
   * structure — and when it does, the two must move together: `submit_plan` refuses
   * more scenes than the ceiling when they fall below the 500-word floor, so a
   * request for 五篇 at 2,000 words would have the planner asked for five and the
   * tool rejecting five. See `parts.ts`.
   */
  readonly request?: string;
  /**
   * The language the manuscript must be in, when the request settles it.
   *
   * Derived by the caller from the request rather than configured, because it is
   * a property of the commission. See `CHINESE_MANUSCRIPT_DIRECTIVE`: half of
   * LongBench-Write is Chinese, and it is the one axis on which this harness makes
   * its own backbone measurably worse.
   */
  readonly manuscriptLanguage?: "chinese";
  readonly backbone: ModelId | null;
  /** Override the verifier's model. Recorded in the summary; see `withVerifier`. */
  readonly verifierModel?: ModelId | null;
  /** Run-scoped by default; a shared directory accumulates craft across stories. */
  readonly memoryRoot: string;
  /** One id per run, so transcripts from separate runs never interleave. */
  readonly runId: string;
  /**
   * Where agent shell commands run, when a backend confines them. Omitted, they
   * run on the host with the refusal list as the only barrier.
   */
  readonly sandbox?: SandboxBackend;
  readonly log: (line: string) => void;
  readonly transcriptSink: (
    role: AgentRole,
    messages: readonly unknown[],
    meta: { readonly txid: string; readonly durationMs: number },
  ) => Promise<void>;
}

export interface Harness {
  readonly residents: ResidentAgents;
  readonly bus: SceneToolBus;
  readonly stage: SceneStage;
  /**
   * What the scene in progress may spend. The story loop writes it per scene;
   * the writer's `ask_context_builder` and the follow-up log read it.
   */
  readonly allocation: AllocationState;
  readonly planState: { plan?: StoryPlan; committed: Set<string> };
  /** Scene ids in the order they were opened; the summariser reads the tail. */
  readonly storyState: {
    canon: { entity: string }[];
    promises: string[];
    scenes: string[];
  };
  readonly build: (input: {
    readonly sceneId: string;
    readonly skeleton: ContextPacket;
    readonly allocation: SceneAllocation;
    readonly note?: string;
  }) => Promise<BuildResult>;
  readonly backfill: (input: {
    readonly sceneId: string;
    readonly draft: Draft;
    readonly note?: string;
  }) => Promise<readonly FileWrite[]>;
  readonly reads: readonly ReadRecord[];
  /**
   * Follow-up exchanges over the whole run, for "was the fifth round worth it".
   *
   * The tier travels with each one because that is the question the schedule
   * raises: if the endgame's extra rounds are never used, the schedule is costing
   * prompt text and buying nothing, and only a per-tier count can say so.
   */
  readonly followUps: readonly {
    readonly scene: string;
    readonly round: number;
    readonly question: string;
    readonly tier: string;
    readonly allowed: number;
  }[];
  readonly memories: ReadonlyMap<AgentRole, AgentMemory>;
  readonly skillLibraries: ReadonlyMap<AgentRole, SkillLibrary>;
}

export async function assembleHarness(options: AssemblyOptions): Promise<Harness> {
  const { index, artifacts, projectRoot, profile, budget, log: say } = options;
  const gateway = installGateway();

  const bus = new SceneToolBus();
  const builderBus = new BuilderBus();
  /**
   * A cited source has to be a file that exists.
   *
   * Checked against the project directory rather than through `index.read` so the
   * check costs no read budget and cannot itself fail on a permission boundary. A
   * source is allowed to name a path with a line range or a trailing note — what is
   * refused is a source that resolves to nothing, which is what `source:
   * "synthetic"` does. See `BuilderBus#resolves` for the measurement.
   */
  builderBus.checkSourcesWith((source) => {
    const cleaned = source.trim().split(/[\s,;]+/)[0]!.replace(/[:#].*$/, "");
    if (!cleaned || cleaned.startsWith("/") || cleaned.includes("..")) return false;
    return existsSync(path.join(projectRoot, cleaned));
  });
  const stage = new SceneStage();
  /**
   * What the scene in progress may spend, for the tools that have to ask at call
   * time. The story loop opens it per scene; nothing here decides it.
   */
  const allocation = new AllocationState();
  const base: readonly PersonaSpec[] = options.backbone
    ? withBackbone(options.backbone)
    : PERSONAS;
  // Applied after the backbone override, never by it: which model checks the prose
  // changes what a result means, so it is always an explicit choice.
  const personas: readonly PersonaSpec[] = options.verifierModel
    ? withVerifier(base, options.verifierModel)
    : base;

  // One object, two readers: the plan tool writes it, update_plan revises it,
  // and the story loop reads whatever it currently says.
  const planState: { plan?: StoryPlan; committed: Set<string> } = { committed: new Set() };

  /**
   * Canon and open promises as they stand right now, for the summariser.
   *
   * Read through a mutable holder rather than captured once, because compaction
   * happens mid-story and a digest of the canon as it was at scene 1 would tell
   * a compacted agent the wrong thing about scene 30.
   */
  const storyState: { canon: { entity: string }[]; promises: string[]; scenes: string[] } = {
    canon: [],
    promises: [],
    scenes: [],
  };

  const reads: ReadRecord[] = [];
  const followUps: {
    scene: string;
    round: number;
    question: string;
    tier: string;
    allowed: number;
  }[] = [];

  /**
   * The live backfill buffer for the scene being committed.
   *
   * Set immediately before index-manager is invoked and cleared after, for the
   * same reason the buses exist: a tool closing over scene 1's writer would
   * still be filing scene 40's characters into scene 1's transaction.
   */
  let partitionWriter: PartitionWriter | null = null;

  /**
   * Skills, installed once per role.
   *
   * An empty library is a mechanism nobody uses: the first agent to face a
   * promise audit improvises one rather than writing one down. Only descriptions
   * reach the prompt, so the starter set costs a line each.
   */
  const skillLibraries = new Map<AgentRole, SkillLibrary>(
    PERSONAS.map((p) => [p.role, new SkillLibrary({ root: options.memoryRoot, role: p.role })]),
  );
  const skillIndex = new Map<AgentRole, string>();
  for (const [role, library] of skillLibraries) {
    await installStarterSkills(options.memoryRoot, role);
    skillIndex.set(role, skillsSection(await library.all()));
  }

  const memories = new Map<AgentRole, AgentMemory>(
    PERSONAS.map((p) => [
      p.role,
      new AgentMemory({
        root: options.memoryRoot,
        role: p.role,
        // Read fresh: the entity list grows as the story is planned and written,
        // and the guard is only worth having if it knows about scene 30's cast.
        knownEntities: () => (planState.plan?.entities ?? []).map((e) => e.id),
      }),
    ]),
  );
  const memoryIndex = new Map<AgentRole, string>();
  for (const [role, memory] of memories) memoryIndex.set(role, await memory.refreshIndex());

  const residents = new ResidentAgents({
    agentsRoot: options.agentsRoot,
    ...(options.manuscriptLanguage
      ? { manuscriptLanguage: options.manuscriptLanguage }
      : {}),
    personas,
    budget,
    promptSuffix: (role) =>
      `${memorySection(memoryIndex.get(role) ?? "")}\n\n${skillIndex.get(role) ?? ""}`,
    transcriptSink: (role, messages, meta) => options.transcriptSink(role, messages, meta),
    // A run that quietly slept ninety seconds a scene waiting out a quota looks
    // exactly like a run that was slow, and the two call for different
    // responses. The 429s that made every scene unverified were invisible until
    // someone opened a transcript.
    onRetry: ({ role, attempt, waitMs, detail }) =>
      say(
        `${role} call failed (attempt ${attempt}), waiting ${Math.round(waitMs / 1000)}s: ` +
          `${detail.slice(0, 160)}`,
      ),
    compaction: {
      thresholds: thresholdsFor(profile),
      // Each agent compresses its own transcript with its own model. Routing
      // this through the orchestrator would hand it the writer's session and ask
      // it to judge writing work it did not do.
      summarise: async (role, input) => {
        // The role travels with the input, so the fold can be told what *this*
        // role cannot recover from the index. See `ROLE_RETENTION`.
        const { text } = await residents.invoke(role, summaryPrompt({ ...input, role }), {
          txid: "tx-compaction",
          caller: "orchestrator",
          selfCall: role === "orchestrator",
        });
        return text;
      },
      onCompaction: (record) =>
        say(
          `compaction ${record.level} on ${record.role} at ${record.inputTokens} context ` +
            `tokens: ${record.evicted} payload(s) evicted, ${record.summarised} message(s) folded`,
        ),
      context: () => ({
        canonDigest: `${storyState.canon.length} facts across ${
          new Set(storyState.canon.map((f) => f.entity)).size
        } entities`,
        openPromises: storyState.promises,
        recentSceneIds: storyState.scenes.slice(-3),
      }),
    },
    factory: (persona, systemPrompt) => {
      const role = persona.role as AgentRole;
      const knownEntities = () => (planState.plan?.entities ?? []).map((e) => e.id);
      const scene = () => storyState.scenes.at(-1) ?? "plan";
      const tools = [
        ...bus.toolsFor(role),
        ...(role === "orchestrator"
          ? [
              planTool(
                planState,
                sceneCountForRequest(
                  sceneCountFor(options.targetWords, options.wordsPerScene),
                  options.targetWords,
                  options.request ?? "",
                  MIN_WORDS_PER_SCENE,
                ).count,
                options.targetWords,
              ),
              updatePlanTool(planState),
              ...orchestratorTools(stage),
            ]
          : []),
        // The writer is the one role without a shell; see the header.
        ...(role === "writer"
          ? [
              readContextTool({
                path: () =>
                  builderBus.sceneId ? artifactPaths.packet(builderBus.sceneId) : null,
                read: (relPath) => artifacts.read(relPath),
              }),
              askBuilderTool({
                // Asked at call time, not captured at construction. The writer is
                // resident, so a limit read here once would police scene 40 with
                // scene 1's allowance.
                maxRounds: () => allocation.followUpRounds,
                roundsUsed: () => builderBus.contribution().followUps.length,
                ask: askContextBuilder,
              }),
            ]
          : [
              ...(() => {
                const native = nativeTools({
                projectRoot,
                ...(options.sandbox && options.sandbox.id !== "none"
                  ? { shell: options.sandbox.shell }
                  : {}),
                budgetKey: () => `${role}:${scene()}`,
                // Attributed per role. One shared counter would credit the
                // builder with the verifier's reads too, and "was the grep worth
                // it" is a question about the builder specifically.
                onRead: (entry) => {
                  reads.push({ role, scene: scene(), ...entry });
                  if (role === "context-builder") builderBus.noteRead();
                  // Per role and per scene, so the review step can ask whether the
                  // verifier consulted anything before concluding the scene is clean.
                  bus.noteRead(role);
                },
                });
                return [
                  ...native.tools,
                  readIndexTool({
                    read: (relPath) => index.read(relPath),
                    spend: native.spend,
                  }),
                ];
              })(),
            ]),
        // Novelty 2's consumption path. The relation records are being written;
        // without this the reader can only `cat` a YAML file and gets the raw
        // structure instead of the narrative view `renderHistory` produces — and
        // a data structure with no consumption path does not reach the prose we
        // are scored on.
        relationHistoryTool({ read: (relPath) => index.read(relPath), role }),
        ...(role === "index-manager" ? indexManagerTools(() => partitionWriter!) : []),
        ...(role === "context-builder" ? builderBus.tools() : []),
        ...memoryTools(memories.get(role)!, {
          source: () => storyState.scenes.at(-1) ?? "planning",
          knownEntities,
          onChange: async () => {
            memoryIndex.set(role, await memories.get(role)!.refreshIndex());
            residents.refreshSystemPrompt(role);
          },
        }),
        ...skillTools(skillLibraries.get(role)!, {
          knownEntities,
          onChange: async () => {
            skillIndex.set(role, skillsSection(await skillLibraries.get(role)!.all()));
            residents.refreshSystemPrompt(role);
          },
        }),
      ];

      // The permission model, checked against what was actually built rather
      // than asserted in a list nothing consults. The list previously named six
      // tools that did not exist while the factory ignored it; a drift this
      // check would have caught the day it happened.
      const mismatch = allowlistMismatch(
        role,
        tools.map((t) => (t as { name: string }).name),
      );
      if (mismatch) {
        throw new Error(
          `${role}'s tools disagree with its persona allowlist. ` +
            `Granted but not listed: ${mismatch.unlisted.join(", ") || "none"}. ` +
            `Listed but not granted: ${mismatch.missing.join(", ") || "none"}. ` +
            `Fix personas.ts or the factory — they are the same statement about ` +
            `who may do what.`,
        );
      }

      return new (Agent as unknown as new (init: unknown) => AgentLike)({
        initialState: {
          systemPrompt,
          model: gateway.model(persona.model as ModelId),
          thinkingLevel: persona.thinkingLevel ?? "off",
          maxTokens: profile.maxCompletionTokens,
          tools,
        },
      });
    },
  });

  /**
   * Answer one follow-up question, and put the answer where the question was
   * asked from.
   *
   * The appending is the point. An answer returned only as tool text is a reply
   * that scrolls past; appended to the packet it becomes part of the material the
   * writer is working from, which is what the brief described — *"conetxt builder
   * 就会收到工具调用，然后重新read然后往01.md里补充"*.
   */
  async function askContextBuilder(question: string): Promise<string> {
    const scene = builderBus.sceneId;
    const round = builderBus.contribution().followUps.length + 1;
    const maxRounds = allocation.followUpRounds;
    // Marks the question as outstanding, which is what makes `answer_writer`
    // legal. Without it the builder could spend the allowance on a question
    // nobody asked — see `BuilderBus#pending`.
    builderBus.expect(question);
    await residents.invoke(
      "context-builder",
      followUpBrief({ sceneId: scene, question, round, maxRounds }),
      { txid: `tx-${scene}`, caller: "orchestrator" },
    );
    const answered = builderBus.contribution().followUps;
    const answer =
      answered.at(-1)?.answer ??
      "the context-builder did not answer through answer_writer; treat the question as " +
        "unanswered rather than assuming a value";
    /**
     * A framework error is not an answer, and it used to reach the writer as one.
     *
     * `Agent is already processing a prompt` is what pi returns when a second
     * `invoke` arrives mid-turn, which happened whenever the writer batched its
     * questions. The writer has no way to recognise that string, so it read "the
     * index has nothing" and wrote the scene accordingly. Sequential execution on
     * the tool prevents the collision; this catches anything else that returns a
     * machine message where a search result belongs.
     */
    if (/already processing a prompt|steer\(\)|followUp\(\)/i.test(answer)) {
      const failed =
        `the context-builder could not be reached for this question (${answer.slice(0, 80)}). ` +
        `Treat it as unanswered: do not assume the index is silent on it, and say in your ` +
        `reply that the question went unanswered if it changes what you can write.`;
      say(`${scene} follow-up ${round}/${maxRounds} FAILED to reach the builder`);
      return failed;
    }
    followUps.push({ scene, round, question, tier: allocation.current.tier, allowed: maxRounds });
    await artifacts.append(
      artifactPaths.packet(scene),
      renderFollowUp({ round, question, answer }),
    );
    say(`${scene} follow-up ${round}/${maxRounds} answered (${allocation.current.tier})`);
    return answer;
  }

  /** Build P2–P4 for a scene by asking the resident builder to search the index. */
  async function build(input: {
    readonly sceneId: string;
    readonly skeleton: ContextPacket;
    readonly allocation: SceneAllocation;
    readonly note?: string;
  }): Promise<BuildResult> {
    builderBus.open(
      input.sceneId,
      input.skeleton.items.map((i) => i.id),
    );
    const card = planState.plan?.scenes.find((s) => s.id === input.sceneId);
    await residents.invoke(
      "context-builder",
      builderBrief({
        sceneId: input.sceneId,
        intent: card?.intent ?? "unknown",
        presentEntities: card?.presentEntities ?? [],
        skeleton: input.skeleton.rendered,
        committedScenes: [...planState.committed],
        packetPath: artifactPaths.packet(input.sceneId),
        allocation: input.allocation,
        ...(input.note ? { note: input.note } : {}),
      }),
      { txid: `tx-${input.sceneId}`, caller: "orchestrator" },
    );
    const contribution = builderBus.contribution();
    say(
      `${input.sceneId} context-builder added ${contribution.items.length} item(s) ` +
        `after ${contribution.reads} read(s), and recorded ${contribution.gaps.length} gap(s) ` +
        `[${input.allocation.tier}]`,
    );
    return { items: contribution.items, gaps: contribution.gaps };
  }

  /**
   * Fold an approved scene into the index by asking the resident index-manager.
   *
   * The prose and delta are shown to it, not derived from it: this is the step
   * the brief described as its whole job, and the parts that matter — did this
   * scene change a relationship, which promise did it pay off, where did it land
   * on the tension curve — are judgements, not transformations.
   */
  async function backfill(input: {
    readonly sceneId: string;
    readonly draft: Draft;
    readonly note?: string;
  }): Promise<readonly FileWrite[]> {
    const writer = new PartitionWriter(index, input.sceneId);
    partitionWriter = writer;
    try {
      await residents.invoke(
        "index-manager",
        [
          `Scene ${input.sceneId} has been approved. Fold it into the index.`,
          "",
          "Work through the partitions in order: identity, then state, then belief, then",
          "relations, then events, then rhythm, then promises. If you want a state attribute",
          "that is not in the vocabulary, what you have is an event.",
          "",
          // Measured: 29.8 round-trips per commit, 97% of them one tool call, each
          // re-sending an 8k transcript to write a single field. Ordering the
          // partitions does not require a separate request per partition — the
          // order is about what depends on what, and nothing here depends on the
          // *result* of a write.
          "**Order is not the same as one-at-a-time.** Read the prose and the delta, decide",
          "everything you are going to record, and then issue those calls together in one",
          "reply. Nothing you write depends on the result of another write, so a separate",
          "request per field buys nothing and costs a full round-trip: measured, you averaged",
          "29.8 round-trips per commit with 97% carrying a single call, and that is most of",
          "the time a scene takes to land.",
          "",
          "Only record what the prose supports. An index that improves on what was written",
          "will disagree with the manuscript, and nothing downstream can tell which is right.",
          "",
          input.note ? `The orchestrator adds: ${input.note}\n` : "",
          `## The prose\n\n${input.draft.prose}`,
          "",
          `## What the writer declared\n\n${JSON.stringify(input.draft.delta, null, 2)}`,
          "",
          "Finish by naming the partitions you wrote to and anything the prose implied that",
          "you deliberately did not record.",
        ]
          .filter(Boolean)
          .join("\n"),
        { txid: `tx-${input.sceneId}`, caller: "orchestrator" },
      );
      const writes = writer.writes();
      say(
        `${input.sceneId} index-manager wrote ${writes.length} partition file(s): ` +
          `${writer.touched().map((p) => p.split("/")[0]).join(", ") || "none"}`,
      );
      return writes;
    } catch (error) {
      /**
       * Keep what it managed to fold before it failed.
       *
       * Measured, not hypothetical: on the first orchestrator-driven run the
       * index-manager accepted two character profiles, five entities and three
       * state entries in 106 seconds, then a single model call returned nothing
       * for 794 seconds until the watchdog aborted the turn — and every one of
       * those nine accepted writes was discarded, because the throw reached a
       * handler that treated the whole fold as absent. The scene committed with
       * its `identity: {}` stub untouched and no `state.jsonl` at all.
       *
       * Those writes are not partial in any sense that matters. Each went
       * through its typed tool, was validated, and was accepted. Losing them
       * because a *later* call hung turns a fold that mostly worked into no
       * fold, in the one step whose entire purpose is not to lose anything.
       */
      const salvaged = writer.writes();
      const message = error instanceof Error ? error.message : String(error);
      say(
        `${input.sceneId} index-manager failed after ${salvaged.length} accepted ` +
          `write(s) — keeping them and committing anyway: ${message}`,
      );
      if (salvaged.length === 0) throw error;
      return salvaged;
    } finally {
      partitionWriter = null;
    }
  }

  return {
    residents,
    bus,
    stage,
    allocation,
    planState,
    storyState,
    build,
    backfill,
    reads,
    followUps,
    memories,
    skillLibraries,
  };
}

/** Where a role's transcript goes, relative to the project root. */
export function transcriptPath(role: AgentRole, runId: string): string {
  return paths.transcript(role, runId);
}

/** Resolve the agents directory relative to this module, so callers need not. */
export function defaultAgentsRoot(): string {
  return path.join(import.meta.dirname, "../../agents");
}
