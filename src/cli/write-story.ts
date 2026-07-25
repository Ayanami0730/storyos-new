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

import { DEFAULT_THRESHOLDS, summaryPrompt } from "../agents/compaction.ts";
import { PERSONAS, withBackbone } from "../agents/personas.ts";
import { type AgentLike, ResidentAgents } from "../agents/residents.ts";
import { CanonicalIndex } from "../index/commit.ts";
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
  };
}

const args = await parseArgs(process.argv.slice(2));
const outDir = path.resolve(args.out);
await mkdir(outDir, { recursive: true });

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

const residents = new ResidentAgents({
  agentsRoot: path.join(import.meta.dirname, "../../agents"),
  personas,
  compaction: {
    thresholds: DEFAULT_THRESHOLDS,
    // The summariser runs on the cheap backbone: it is writing navigation, not
    // prose, and paying the flagship rate to compress a transcript is the kind
    // of cost that only shows up at scene forty.
    summarise: async (input) => {
      const { text } = await residents.invoke("orchestrator", summaryPrompt(input), {
        txid: "tx-compaction",
        caller: "orchestrator",
        selfCall: true,
      });
      return text;
    },
    context: () => ({
      canonDigest: `${storyState.canon.length} facts across ${
        new Set(storyState.canon.map((f) => f.entity)).size
      } entities`,
      openPromises: storyState.promises,
      recentSceneIds: storyState.scenes.slice(-3),
    }),
  },
  factory: (persona, systemPrompt, toolNames) => {
    const tools = [
      ...bus.toolsFor(persona.role as AgentRole),
      ...(persona.role === "orchestrator"
        ? [planTool(planState, sceneCountFor(args.target)), updatePlanTool(planState)]
        : []),
      readIndexTool(index),
    ].filter(Boolean);
    return new (Agent as unknown as new (init: unknown) => AgentLike)({
      initialState: {
        systemPrompt,
        model: gateway.model(persona.model as ModelId),
        thinkingLevel: "off",
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
    log: (line) => console.error(`[${new Date().toISOString().slice(11, 19)}] ${line}`),
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
  compactions: residents.compactions(),
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
