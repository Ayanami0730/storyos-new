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
} from "../agents/personas.ts";
import { type AgentLike, ResidentAgents } from "../agents/residents.ts";
import { skillTools } from "../agents/skill-tools.ts";
import { SkillLibrary, installStarterSkills, skillsSection } from "../agents/skills.ts";
import type { ContextItem, ContextPacket } from "../context/types.ts";
import { PartitionWriter } from "../index/backfill.ts";
import type { CanonicalIndex, FileWrite } from "../index/commit.ts";
import { paths } from "../index/tree.ts";
import type { AgentRole } from "../transaction/types.ts";
import { readIndexTool } from "../tools/read-index.ts";
import { nativeTools } from "../tools/pi-tools.ts";
import { relationHistoryTool } from "../tools/relation-tool.ts";
import { type ArtifactStore, artifactPaths, renderFollowUp } from "./artifacts.ts";
import { type BudgetProfile, TokenBudget } from "./budget.ts";
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
import { type StoryPlan, planTool, sceneCountFor, updatePlanTool } from "./plan.ts";
import type { Draft } from "./scene-loop.ts";

/**
 * Follow-up rounds the writer may spend on the builder.
 *
 * The brief said *"比如最多三轮"*. Three is the starting point rather than the
 * answer: every round is recorded with the findings that followed it, so whether
 * a third is worth its cost becomes a number instead of an argument.
 */
export const FOLLOW_UP_ROUNDS = 3;

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
  readonly backbone: ModelId | null;
  /** Run-scoped by default; a shared directory accumulates craft across stories. */
  readonly memoryRoot: string;
  /** One id per run, so transcripts from separate runs never interleave. */
  readonly runId: string;
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
    readonly note?: string;
  }) => Promise<readonly ContextItem[]>;
  readonly backfill: (input: {
    readonly sceneId: string;
    readonly draft: Draft;
    readonly note?: string;
  }) => Promise<readonly FileWrite[]>;
  readonly reads: readonly ReadRecord[];
  /** Follow-up exchanges over the whole run, for "was the third round worth it". */
  readonly followUps: readonly {
    readonly scene: string;
    readonly round: number;
    readonly question: string;
  }[];
  readonly memories: ReadonlyMap<AgentRole, AgentMemory>;
  readonly skillLibraries: ReadonlyMap<AgentRole, SkillLibrary>;
}

export async function assembleHarness(options: AssemblyOptions): Promise<Harness> {
  const { index, artifacts, projectRoot, profile, budget, log: say } = options;
  const gateway = installGateway();

  const bus = new SceneToolBus();
  const builderBus = new BuilderBus();
  const stage = new SceneStage();
  const personas: readonly PersonaSpec[] = options.backbone
    ? withBackbone(options.backbone)
    : PERSONAS;

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
  const followUps: { scene: string; round: number; question: string }[] = [];

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
    personas,
    budget,
    promptSuffix: (role) =>
      `${memorySection(memoryIndex.get(role) ?? "")}\n\n${skillIndex.get(role) ?? ""}`,
    transcriptSink: (role, messages, meta) => options.transcriptSink(role, messages, meta),
    compaction: {
      thresholds: thresholdsFor(profile),
      // Each agent compresses its own transcript with its own model. Routing
      // this through the orchestrator would hand it the writer's session and ask
      // it to judge writing work it did not do.
      summarise: async (role, input) => {
        const { text } = await residents.invoke(role, summaryPrompt(input), {
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
              planTool(planState, sceneCountFor(options.targetWords)),
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
                maxRounds: FOLLOW_UP_ROUNDS,
                roundsUsed: () => builderBus.contribution().followUps.length,
                ask: askContextBuilder,
              }),
            ]
          : [
              ...nativeTools({
                projectRoot,
                budgetKey: () => `${role}:${scene()}`,
                // Attributed per role. One shared counter would credit the
                // builder with the verifier's reads too, and "was the grep worth
                // it" is a question about the builder specifically.
                onRead: (entry) => {
                  reads.push({ role, scene: scene(), ...entry });
                  if (role === "context-builder") builderBus.noteRead();
                },
              }),
              readIndexTool({ read: (relPath) => index.read(relPath) }),
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
          thinkingLevel: "off",
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
    await residents.invoke(
      "context-builder",
      followUpBrief({ sceneId: scene, question, round, maxRounds: FOLLOW_UP_ROUNDS }),
      { txid: `tx-${scene}`, caller: "orchestrator" },
    );
    const answered = builderBus.contribution().followUps;
    const answer =
      answered.at(-1)?.answer ??
      "the context-builder did not answer through answer_writer; treat the question as " +
        "unanswered rather than assuming a value";
    followUps.push({ scene, round, question });
    await artifacts.append(
      artifactPaths.packet(scene),
      renderFollowUp({ round, question, answer }),
    );
    say(`${scene} follow-up ${round}/${FOLLOW_UP_ROUNDS} answered`);
    return answer;
  }

  /** Build P2–P4 for a scene by asking the resident builder to search the index. */
  async function build(input: {
    readonly sceneId: string;
    readonly skeleton: ContextPacket;
    readonly note?: string;
  }): Promise<readonly ContextItem[]> {
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
        ...(input.note ? { note: input.note } : {}),
      }),
      { txid: `tx-${input.sceneId}`, caller: "orchestrator" },
    );
    const contribution = builderBus.contribution();
    say(
      `${input.sceneId} context-builder added ${contribution.items.length} item(s) ` +
        `after ${contribution.reads} read(s)`,
    );
    return contribution.items;
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
    partitionWriter = new PartitionWriter(index, input.sceneId);
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
      const writes = partitionWriter.writes();
      say(
        `${input.sceneId} index-manager wrote ${writes.length} partition file(s): ` +
          `${partitionWriter.touched().map((p) => p.split("/")[0]).join(", ") || "none"}`,
      );
      return writes;
    } finally {
      partitionWriter = null;
    }
  }

  return {
    residents,
    bus,
    stage,
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
