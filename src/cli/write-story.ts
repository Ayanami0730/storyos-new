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

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { Agent } from "@earendil-works/pi-agent-core";

import { summaryPrompt, thresholdsFor } from "../agents/compaction.ts";
import { AgentMemory, memorySection } from "../agents/memory.ts";
import { memoryTools } from "../agents/memory-tools.ts";
import { PERSONAS, withBackbone } from "../agents/personas.ts";
import { type AgentLike, ResidentAgents } from "../agents/residents.ts";
import { CanonicalIndex } from "../index/commit.ts";
import { TokenBudget, profileById, taskBudgetFor } from "../runtime/budget.ts";
import type { AgentRole } from "../transaction/types.ts";
import { SceneToolBus } from "../runtime/collaborators.ts";
import { type ModelId, installGateway } from "../runtime/gateway.ts";
import {
  type StoryPlan,
  planTool,
  sceneCountFor,
  updatePlanTool,
  writeStory,
} from "../runtime/story.ts";

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
const index = new CanonicalIndex(path.join(outDir, "project"));
await index.init("genesis");

const bus = new SceneToolBus();
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

/**
 * Memory lives under the run's project directory unless told otherwise, so two
 * runs of the same premise start from the same blank slate. Sharing it across
 * runs is a real capability — an agent that has written ten stories should be
 * better at the eleventh — but it makes a result depend on history that is not
 * in the inputs, so it is opt-in and it goes in the summary.
 */
const memoryRoot = args.memoryDir
  ? path.resolve(args.memoryDir)
  : path.join(outDir, "project", "agents");

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
  promptSuffix: (role) => memorySection(memoryIndex.get(role) ?? ""),
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
    const tools = [
      ...bus.toolsFor(role),
      ...(role === "orchestrator"
        ? [planTool(planState, sceneCountFor(args.target)), updatePlanTool(planState)]
        : []),
      ...memoryTools(memories.get(role)!, {
        source: () => storyState.scenes.at(-1) ?? "planning",
        knownEntities: () => (planState.plan?.entities ?? []).map((e) => e.id),
        onChange: async () => {
          memoryIndex.set(role, await memories.get(role)!.refreshIndex());
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
 * The read surface. Deliberately not a general shell in this entry point: the
 * committed index is small and structured, and a real shell here would mean
 * standing up a sandbox before we have a single measured story. The guarded
 * shell is the production path; this is the one that gets us a number.
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
  try {
    const { readdir } = await import("node:fs/promises");
    const dir = path.join(outDir, "project", "manuscript");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".md")).sort();
    let words = 0;
    for (const f of files) {
      words += (await readFile(path.join(dir, f), "utf8")).split(/\s+/).filter(Boolean).length;
    }
    return { scenes: files.map((f) => f.replace(/\.md$/, "")), words };
  } catch {
    return { scenes: [], words: 0 };
  }
}

const onDisk = await committedOnDisk();

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
  memory: {
    root: memoryRoot,
    shared_across_runs: args.memoryDir !== null,
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
