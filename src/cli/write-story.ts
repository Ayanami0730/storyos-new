/**
 * Write one story, end to end.
 *
 *   export PATH="$HOME/bin/node22/bin:$PATH"
 *   YS_KEY="$(cat ~/.config/ys/key)" node --experimental-strip-types \
 *     src/cli/write-story.ts --premise-file p.txt --target 4000 --out runs/demo
 *
 * A run is not complete unless its trace, cost and timing ledger is on disk —
 * including a run that failed. An aborted run with a ledger teaches us
 * something; one without teaches us nothing. So everything is written out even
 * on the unhappy path.
 */

import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Agent } from "@earendil-works/pi-agent-core";

import { summaryPrompt, thresholdsFor } from "../agents/compaction.ts";
import { indexManagerTools } from "../agents/index-manager-tools.ts";
import { AgentMemory, memorySection } from "../agents/memory.ts";
import { memoryTools } from "../agents/memory-tools.ts";
import { PERSONAS, withBackbone } from "../agents/personas.ts";
import { type AgentLike, ResidentAgents } from "../agents/residents.ts";
import { skillTools } from "../agents/skill-tools.ts";
import { SkillLibrary, installStarterSkills, skillsSection } from "../agents/skills.ts";
import { PartitionWriter } from "../index/backfill.ts";
import { CanonicalIndex } from "../index/commit.ts";
import {
  chapterFor,
  committedScenes,
  initialiseProject,
  partitionReport,
  paths,
  sceneIndexOf,
} from "../index/tree.ts";
import { TokenBudget, profileById, taskBudgetFor } from "../runtime/budget.ts";
import type { AgentRole } from "../transaction/types.ts";
import { SceneToolBus } from "../runtime/collaborators.ts";
import { type ModelId, installGateway } from "../runtime/gateway.ts";
import {
  BuilderBus,
  askBuilderTool,
  builderBrief,
  followUpBrief,
} from "../runtime/packet-builder.ts";
import {
  type StoryPlan,
  planTool,
  sceneCountFor,
  updatePlanTool,
  writeStory,
} from "../runtime/story.ts";
import { nativeTools } from "../tools/pi-tools.ts";
import { relationHistoryTool } from "../tools/relation-tool.ts";
import { checkReferences, renderReferenceReport } from "../verification/references.ts";

interface Args {
  premise: string;
  target: number;
  out: string;
  backbone: ModelId | null;
  maxRepairs: number;
  /** `parity` to sit in a table with the baselines, `generous` to find out if it works. */
  profile: string;
  /**
   * Where agent memory lives. Run-scoped by default, so a run is reproducible
   * from its premise alone. Point several runs at one directory and they
   * accumulate craft across stories — useful for iteration, and disqualifying
   * for a measured run, which is why it has to be asked for and is recorded.
   */
  memoryDir: string | null;
}

async function parseArgs(argv: readonly string[]): Promise<Args> {
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const premiseFile = get("--premise-file");
  const premise = premiseFile
    ? await readFile(premiseFile, "utf8")
    : (get("--premise") ?? "");
  if (!premise.trim()) {
    throw new Error("--premise or --premise-file is required");
  }
  return {
    premise: premise.trim(),
    target: Number(get("--target") ?? 4000),
    out: get("--out") ?? `runs/story-${Date.now()}`,
    backbone: (get("--backbone") as ModelId | undefined) ?? null,
    maxRepairs: Number(get("--max-repairs") ?? 2),
    profile: get("--profile") ?? "parity",
    memoryDir: get("--memory-dir") ?? null,
  };
}

const args = await parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out);
await mkdir(outDir, { recursive: true });

/** Progress on stderr, so a run that prints nothing for an hour is distinguishable from a hung one. */
const say = (line: string) =>
  console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`);

const gateway = installGateway();
const projectRoot = path.join(outDir, "project");
const index = new CanonicalIndex(projectRoot);
await index.init("genesis");

/**
 * The partitioned tree, before anything runs.
 *
 * Created empty but complete, because a partition an agent cannot list is a
 * partition it will not fill: `relations/` did not exist in the first
 * implementation until something wrote a relation, and nothing ever did.
 */
const { created } = await initialiseProject(projectRoot, {
  premise: args.premise,
  targetWords: args.target,
  agentsRoot: path.join(import.meta.dirname, "../../agents"),
});
say(`project initialised: ${created.length} paths under ${projectRoot}`);

const bus = new SceneToolBus();
const builderBus = new BuilderBus();
// One object, two readers: the plan tool writes it, update_plan revises it, and
// the story loop reads whatever it currently says.
const planState: { plan?: StoryPlan; committed: Set<string> } = { committed: new Set() };
const personas = args.backbone ? withBackbone(args.backbone) : PERSONAS;

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

const profile = profileById(args.profile);
const taskBudget = taskBudgetFor(profile, args.target);
const budget = new TokenBudget(taskBudget);

/** One id per run, so transcripts from separate runs never interleave. */
const runId = `run-${new Date().toISOString().replace(/[:.]/g, "-")}`;

/**
 * Follow-up rounds the writer may spend on the builder.
 *
 * The brief said "比如最多三轮". Three is the starting point rather than the
 * answer: every round is recorded with the findings that followed it, so whether
 * a third is worth its cost becomes a number instead of an argument.
 */
const FOLLOW_UP_ROUNDS = 3;

/**
 * The live backfill buffer for the scene being committed.
 *
 * Set immediately before index-manager is invoked and cleared after, because its
 * tools are registered once against a getter — the same reason the scene tool bus
 * exists. A tool closing over scene 1's writer would still be filing scene 40's
 * characters into scene 1's transaction.
 */
let partitionWriter: PartitionWriter | null = null;

/**
 * Every shell read, with who ran it and why.
 *
 * The point of giving agents a shell is that they can find material a template
 * would not have included. Whether they actually do is measurable, and this is
 * the measurement: reads per scene per role, and what each was for.
 */
const reads: Record<string, unknown>[] = [];

/**
 * Memory lives under the run's project directory unless told otherwise, so two
 * runs of the same premise start from the same blank slate. Sharing it across
 * runs is a real capability — an agent that has written ten stories should be
 * better at the eleventh — but it makes a result depend on history that is not
 * in the inputs, so it is opt-in and it goes in the summary.
 */
const memoryRoot = args.memoryDir ? path.resolve(args.memoryDir) : projectRoot;

/**
 * Skills, installed once per role.
 *
 * An empty library is a mechanism nobody uses: the first agent to face a promise
 * audit improvises one rather than writing one down. Only descriptions reach the
 * prompt, so the starter set costs a line each.
 */
const skillLibraries = new Map<AgentRole, SkillLibrary>(
  PERSONAS.map((p) => [p.role, new SkillLibrary({ root: memoryRoot, role: p.role })]),
);
const skillIndex = new Map<AgentRole, string>();
for (const [role, library] of skillLibraries) {
  await installStarterSkills(memoryRoot, role);
  skillIndex.set(role, skillsSection(await library.all()));
}

const memories = new Map<AgentRole, AgentMemory>(
  PERSONAS.map((p) => [
    p.role,
    new AgentMemory({
      root: memoryRoot,
      role: p.role,
      // Read fresh: the entity list grows as the story is planned and written,
      // and the guard is only worth having if it knows about scene 30's cast.
      knownEntities: () => (planState.plan?.entities ?? []).map((e) => e.id),
    }),
  ]),
);
/** Rendered indexes, refreshed on write; read synchronously when composing prompts. */
const memoryIndex = new Map<AgentRole, string>();
for (const [role, memory] of memories) memoryIndex.set(role, await memory.refreshIndex());

const residents = new ResidentAgents({
  agentsRoot: path.join(import.meta.dirname, "../../agents"),
  personas,
  budget,
  promptSuffix: (role) =>
    `${memorySection(memoryIndex.get(role) ?? "")}\n\n${skillIndex.get(role) ?? ""}`,
  transcriptSink: async (role, messages, meta) => {
    // The brief asked for raw conversation on disk, and its absence has already
    // cost real time: reconstructing what an agent was told in a finished run
    // required replaying the packet, which says nothing about what it replied.
    const rel = paths.transcript(role, runId);
    const full = path.join(projectRoot, rel);
    await mkdir(path.dirname(full), { recursive: true });
    const lines = messages.map((m) =>
      JSON.stringify({ at: new Date().toISOString(), txid: meta.txid, ...m }),
    );
    await appendFile(full, `${lines.join("\n")}\n`, "utf8");
  },
  compaction: {
    thresholds: thresholdsFor(profile),
    // Each agent compresses its own transcript with its own model. Routing this
    // through the orchestrator would hand it the writer's session and ask it to
    // judge writing work it did not do.
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
  factory: (persona, systemPrompt, toolNames) => {
    const role = persona.role as AgentRole;
    const knownEntities = () => (planState.plan?.entities ?? []).map((e) => e.id);
    const tools = [
      ...bus.toolsFor(role),
      ...(role === "orchestrator"
        ? [planTool(planState, sceneCountFor(args.target)), updatePlanTool(planState)]
        : []),
      // Uniform read reach, at last actually uniform: every role gets the same
      // shell over the same tree, and the difference between roles is only what
      // they may write.
      // pi's own bash and read, with our refusal policy in bash's prepare hook.
      //
      // Not for the writer. Its job is the prose, and the measured behaviour
      // says the shell does not help it: across a whole run the writer ran four
      // commands to the context-builder's forty-eight, and asked the builder
      // nothing at all. Giving one agent both a research tool it barely uses and
      // a question it never asks produces neither. The packet plus
      // `ask_context_builder` is its whole input surface now.
      ...(role === "writer"
        ? []
        : nativeTools({
            projectRoot,
            budgetKey: () => `${role}:${storyState.scenes.at(-1) ?? "plan"}`,
            // Attributed per role. One shared counter would credit the builder
            // with the verifier's reads too, and "was the grep worth it" is a
            // question about the builder specifically.
            onRead: (entry) => {
              reads.push({ role, scene: storyState.scenes.at(-1) ?? "plan", ...entry });
              if (role === "context-builder") builderBus.noteRead();
            },
          })),
      // Novelty 2's consumption path. The relation records are finally being
      // written; without this the writer can only `cat` a YAML file and gets the
      // raw structure instead of the narrative view `renderHistory` produces —
      // and a data structure with no consumption path does not reach the prose
      // we are scored on.
      relationHistoryTool({
        read: (relPath) => index.read(relPath),
        role,
      }),
      ...(role === "index-manager" ? indexManagerTools(() => partitionWriter!) : []),
      ...(role === "context-builder" ? builderBus.tools() : []),
      ...(role === "writer"
        ? [
            askBuilderTool({
              maxRounds: FOLLOW_UP_ROUNDS,
              roundsUsed: () => builderBus.contribution().followUps.length,
              ask: askContextBuilder,
            }),
          ]
        : []),
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
      readIndexTool(index),
    ].filter(Boolean);
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
 * Ask the resident context-builder to answer the writer's question.
 *
 * Declared here rather than inline because the writer's tool closes over it and
 * the writer is constructed before the first scene opens.
 */
async function askContextBuilder(question: string): Promise<string> {
  const scene = builderBus.sceneId;
  const before = builderBus.contribution().followUps.length;
  await residents.invoke(
    "context-builder",
    followUpBrief({
      sceneId: scene,
      question,
      round: before + 1,
      maxRounds: FOLLOW_UP_ROUNDS,
    }),
    { txid: `tx-${scene}`, caller: "orchestrator" },
  );
  const answered = builderBus.contribution().followUps;
  return (
    answered.at(-1)?.answer ??
    "the context-builder did not answer through answer_writer; treat the question as " +
      "unanswered rather than assuming a value"
  );
}

/** Build P2–P4 for a scene by asking the resident builder to search the index. */
async function buildContext(input: {
  readonly sceneId: string;
  readonly skeleton: { readonly rendered: string; readonly items: readonly { id: string }[] };
}) {
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
 * The prose and delta are shown to it, not derived from it: this is the step the
 * brief described as its whole job, and the parts that matter — did this scene
 * change a relationship, which promise did it pay off, where did it land on the
 * tension curve — are judgements, not transformations.
 */
async function backfillScene(input: {
  readonly sceneId: string;
  readonly draft: { readonly prose: string; readonly delta: unknown };
}) {
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
        `## The prose\n\n${input.draft.prose}`,
        "",
        `## What the writer declared\n\n${JSON.stringify(input.draft.delta, null, 2)}`,
      ].join("\n"),
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

/**
 * A path-addressed read, kept alongside the shell.
 *
 * Redundant with `run_command` for a capable agent, and worth keeping anyway: it
 * answers "read exactly this" without spending a shell budget slot, and its
 * not-found message is written to be useful rather than to be a shell error.
 */
function readIndexTool(idx: CanonicalIndex) {
  return {
    label: "Read index",
    name: "read_index",
    description:
      "Read a committed file from the index by path, e.g. manuscript/s-003.md. " +
      "Say why in `purpose`.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        purpose: { type: "string" },
      },
      required: ["path", "purpose"],
    },
    execute: async (_id: string, a: { path: string }) => {
      try {
        const text = await idx.read(a.path);
        return { content: [{ type: "text", text: text.slice(0, 20_000) }] };
      } catch {
        return {
          content: [
            {
              type: "text",
              text:
                `no such committed file: ${a.path}. It may not have been written yet — ` +
                `that is a real answer, not a reason to invent its contents.`,
            },
          ],
        };
      }
    },
  };
}

const started = Date.now();
let result: Awaited<ReturnType<typeof writeStory>> | null = null;
let fatal: string | null = null;

try {
  result = await writeStory({
    residents,
    index,
    premise: args.premise,
    targetWords: args.target,
    maxRepairs: args.maxRepairs,
    log: say,
    build: buildContext,
    backfill: backfillScene,
    prosePathFor: (sceneId) => paths.scene(chapterFor(sceneIndexOf(sceneId)), sceneId),
    planSink: planState,
    bus,
    onScene: (sceneId) => {
      planState.committed.add(sceneId);
      storyState.scenes.push(sceneId);
    },
  });
} catch (error) {
  fatal = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

const elapsedMs = Date.now() - started;
const ledger = residents.ledger();

/**
 * What actually landed, read off the index rather than off the in-memory
 * result. If planning threw, `result` is null while committed scenes may still
 * be on disk — and a run that reports zero scenes while its manuscript
 * directory is full is worse than one that reports nothing.
 */
async function committedOnDisk(): Promise<{ scenes: string[]; words: number }> {
  const scenes = await committedScenes(projectRoot);
  let words = 0;
  for (const scene of scenes) {
    try {
      words += (await readFile(path.join(projectRoot, scene.relPath), "utf8"))
        .split(/\s+/)
        .filter(Boolean).length;
    } catch {
      // A scene listed but unreadable is worth zero words and worth not crashing.
    }
  }
  return { scenes: scenes.map((s) => s.sceneId), words };
}

const onDisk = await committedOnDisk();

/**
 * Cross-partition links, checked at the end and reported either way.
 *
 * Zero tokens, and it sees the class of defect nothing else can: every file is
 * individually well-formed, so the damage only exists between them.
 */
const referenceReport = await checkReferences(projectRoot, {
  knownScenes: new Set(onDisk.scenes),
});
say(renderReferenceReport(referenceReport));

await writeFile(
  path.join(outDir, "ledger.jsonl"),
  ledger.map((e) => JSON.stringify(e)).join("\n") + "\n",
  "utf8",
);

const summary = {
  premise_words: args.premise.split(/\s+/).filter(Boolean).length,
  target_words: args.target,
  backbone: args.backbone ?? "default (gpt-5-mini, verifier cross-family)",
  max_repairs: args.maxRepairs,
  elapsed_ms: elapsedMs,
  fatal,
  words: result?.words ?? onDisk.words,
  attainment: Number(((result?.words ?? onDisk.words) / args.target).toFixed(3)),
  scenes_planned: result?.plan.scenes.length ?? 0,
  scenes_committed:
    result?.scenes.filter((s) => s.outcome.status === "COMMITTED").length ??
    onDisk.scenes.length,
  failures: result?.failures ?? [],
  // Kept in the summary because a rejected scene's findings are the case study
  // that tells us what to fix next; losing them means repeating the run to see.
  rejected_findings:
    result?.scenes
      .filter((s) => s.outcome.status !== "COMMITTED")
      .map((s) => ({
        scene: s.card.id,
        status: s.outcome.status,
        findings: s.outcome.findings.map((f) => ({
          subtype: f.subtype,
          severity: f.severity,
          validator: f.validator,
          reasoning: f.reasoning,
          quote: f.evidence.quote.slice(0, 160),
          contradicts: f.contradicts?.quote.slice(0, 160),
        })),
      })) ?? [],
  repair_rounds: result?.scenes.reduce((n, s) => n + (s.outcome.attempts - 1), 0) ?? 0,
  findings_total: result?.scenes.reduce((n, s) => n + s.outcome.findings.length, 0) ?? 0,
  canon_facts: result?.canon.length ?? 0,
  promises_declared: result
    ? result.revision.coverage.contractsChecked
    : 0,
  promises_unpaid: result ? result.revision.coverage.contractsOpen : 0,
  revision_tasks: result?.revision.tasks.length ?? 0,
  tokens: ledger.reduce((n, e) => n + e.usage.total, 0),
  calls: ledger.length,
  roll_up: residents.rollUp(),
  /**
   * The whole budget configuration, in the artefact rather than in a lab book.
   * A `generous` row must never appear in a table beside a baseline row, and
   * the only way to guarantee that months later is for the file itself to say
   * so in words that survive being copied into a spreadsheet.
   */
  budget: {
    profile: profile.id,
    comparable_with_baselines: profile.comparableWithBaselines,
    note: profile.comparableWithBaselines
      ? "baseline-equivalent budget; this row may be compared with baseline rows"
      : "NOT comparable with baseline rows — this run had a larger budget than the " +
        "baselines were given. Use it to judge the architecture, never to claim a win.",
    rationale: profile.rationale,
    max_completion_tokens: profile.maxCompletionTokens,
    input_ceiling: profile.inputCeiling,
    task_token_budget: taskBudget,
    spent: budget.spent,
    utilisation: Number((budget.spent / taskBudget).toFixed(3)),
    tokens_per_output_word: Number((budget.spent / Math.max(1, onDisk.words)).toFixed(1)),
  },
  context: {
    thresholds: thresholdsFor(profile),
    // The measured ceiling actually reached, so we can tell a run that needed
    // the larger window from one that merely had it.
    peak_context_tokens: ledger.reduce((n, e) => Math.max(n, e.contextTokens), 0),
    peak_output_tokens: ledger.reduce((n, e) => Math.max(n, e.usage.output), 0),
    compactions: residents.compactions(),
  },
  /**
   * What the index actually gained, which is the question the first long run
   * could not answer: it reported nine committed scenes while producing no
   * character files, no relations and no timeline at all.
   */
  index: {
    reads: reads.length,
    reads_by_role: reads.reduce<Record<string, number>>((acc, r) => {
      const role = String(r.role);
      acc[role] = (acc[role] ?? 0) + 1;
      return acc;
    }, {}),
    partitions: await partitionReport(projectRoot),
    references: referenceReport.counts,
    dangling: referenceReport.dangling,
    scenes_committed_on_disk: onDisk.scenes,
  },
  memory: {
    root: memoryRoot,
    shared_across_runs: args.memoryDir !== null,
    skills: Object.fromEntries(
      await Promise.all(
        [...skillLibraries].map(
          async ([role, library]) => [role, (await library.all()).map((s) => s.slug)] as const,
        ),
      ),
    ),
    topics: Object.fromEntries(
      await Promise.all(
        [...memories].map(
          async ([role, memory]) =>
            [role, (await memory.live()).map((m) => m.topic)] as const,
        ),
      ),
    ),
  },
};

await writeFile(
  path.join(outDir, "summary.json"),
  JSON.stringify(summary, null, 2) + "\n",
  "utf8",
);

if (result) {
  await writeFile(path.join(outDir, "story.md"), result.manuscript + "\n", "utf8");
  await writeFile(
    path.join(outDir, "plan.json"),
    JSON.stringify(result.plan, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(outDir, "canon.json"),
    JSON.stringify(result.canon, null, 2) + "\n",
    "utf8",
  );
  await writeFile(
    path.join(outDir, "revision.json"),
    JSON.stringify(result.revision, null, 2) + "\n",
    "utf8",
  );
}

console.log(JSON.stringify(summary, null, 2));
if (fatal) process.exitCode = 1;
