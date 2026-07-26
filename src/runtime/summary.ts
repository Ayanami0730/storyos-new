/**
 * The run summary: everything needed to judge a run without rerunning it.
 *
 * Two rules shape what goes in.
 *
 * **A run is not complete unless its trace, cost and timing ledger is on disk —
 * including a run that failed.** An aborted run with a ledger teaches us
 * something; one without teaches us nothing. So this is assembled on the
 * unhappy path too, from what is on disk rather than from an in-memory result
 * that may not exist.
 *
 * **The budget configuration travels with the numbers.** A `generous` row must
 * never appear in a table beside a baseline row, and the only thing that
 * survives being copied into a spreadsheet three months later is a field in the
 * file that says so in words.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import type { AgentMemory } from "../agents/memory.ts";
import { thresholdsFor } from "../agents/compaction.ts";
import type { SkillLibrary } from "../agents/skills.ts";
import type { LedgerEntry, ResidentAgents } from "../agents/residents.ts";
import { committedScenes, partitionReport } from "../index/tree.ts";
import type { AgentRole } from "../transaction/types.ts";
import type { ReferenceReport } from "../verification/references.ts";
import type { BudgetProfile, TokenBudget } from "./budget.ts";
import type { Harness } from "./assembly.ts";
import type { StoryResult } from "./story.ts";

/**
 * What actually landed, read off the index rather than off the in-memory result.
 *
 * If planning threw, the result is null while committed scenes may still be on
 * disk — and a run that reports zero scenes while its chapter directories are
 * full is worse than one that reports nothing.
 */
export async function committedOnDisk(
  projectRoot: string,
): Promise<{ readonly scenes: readonly string[]; readonly words: number }> {
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

export interface SummaryInput {
  readonly args: {
    readonly premise: string;
    readonly target: number;
    readonly backbone: string | null;
    readonly maxRepairs: number;
    readonly memoryDir: string | null;
  };
  readonly projectRoot: string;
  readonly profile: BudgetProfile;
  readonly taskBudget: number;
  readonly budget: TokenBudget;
  readonly residents: ResidentAgents;
  readonly harness: Harness;
  readonly result: StoryResult | null;
  readonly fatal: string | null;
  readonly elapsedMs: number;
  readonly onDisk: { readonly scenes: readonly string[]; readonly words: number };
  readonly referenceReport: ReferenceReport;
}

export async function buildSummary(input: SummaryInput): Promise<Record<string, unknown>> {
  const { args, result, harness, profile, budget, onDisk } = input;
  const ledger: readonly LedgerEntry[] = input.residents.ledger();

  return {
    premise_words: args.premise.split(/\s+/).filter(Boolean).length,
    target_words: args.target,
    backbone: args.backbone ?? "default (gpt-5-mini, verifier cross-family)",
    max_repairs: args.maxRepairs,
    elapsed_ms: input.elapsedMs,
    fatal: input.fatal,
    words: result?.words ?? onDisk.words,
    attainment: Number(((result?.words ?? onDisk.words) / args.target).toFixed(3)),
    scenes_planned: result?.plan.scenes.length ?? 0,
    scenes_committed:
      result?.scenes.filter((s) => s.outcome.status === "COMMITTED").length ??
      onDisk.scenes.length,
    failures: result?.failures ?? [],
    // Kept because a rejected scene's findings are the case study that says what
    // to fix next; losing them means repeating the run to see them again.
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
    /**
     * Scenes that committed without ever reaching the model verifier.
     *
     * Sitting next to `findings_total` on purpose, because it is the number
     * that says whether `findings_total` means anything. A verifier returning
     * zero output tokens leaves an empty findings buffer, an empty buffer has
     * no blockers, and no blockers is an approval — so the failure produces a
     * flawless-looking run. It happened on the first orchestrator-driven run,
     * on every scene.
     */
    scenes_unverified:
      result?.scenes.filter((s) => s.outcome.status === "COMMITTED" && s.outcome.unverified)
        .length ?? 0,
    canon_facts: result?.canon.length ?? 0,
    promises_declared: result ? result.revision.coverage.contractsChecked : 0,
    promises_unpaid: result ? result.revision.coverage.contractsOpen : 0,
    revision_tasks: result?.revision.tasks.length ?? 0,
    tokens: ledger.reduce((n, e) => n + e.usage.total, 0),
    calls: ledger.length,
    roll_up: input.residents.rollUp(),
    /**
     * Read alongside `roll_up`, which has one trap in it.
     *
     * Its `ms` no longer sums to wall time: an orchestrator turn contains the
     * turns it delegates, because `call_verifier` blocks for a whole verifier
     * turn. Those seconds are counted twice, once for each role. Tokens are
     * unaffected — every agent's usage comes from its own calls — so the token
     * column is additive and the time column is not.
     */
    roll_up_note:
      "roll_up.ms double-counts: the orchestrator's turns contain the turns they " +
      "delegate. Use elapsed_ms for wall time. roll_up.tokens is additive.",
    /**
     * How much of the loop the orchestrator drove itself.
     *
     * The reason this is a headline field rather than a detail: the orchestrator
     * having the tools to drive is not evidence that it drives. In the run
     * before these tools existed it sent eight messages in total and delegated
     * nothing, and the engine did everything. `steps_rescued_by_engine` is the
     * number that says whether that has changed.
     */
    driving: result?.driving ?? {
      scenesDriven: 0,
      stepsByOrchestrator: 0,
      stepsRescuedByEngine: 0,
    },
    /**
     * The follow-up mechanism, measured rather than assumed.
     *
     * The writer has been told it may ask the builder questions for three
     * rounds now and has asked zero. Three is a starting point, not an answer:
     * these records are what turn "is a third round worth it" into arithmetic.
     */
    follow_ups: {
      total: harness.followUps.length,
      by_scene: harness.followUps.reduce<Record<string, number>>((acc, f) => {
        acc[f.scene] = (acc[f.scene] ?? 0) + 1;
        return acc;
      }, {}),
      questions: harness.followUps.map((f) => f.question.slice(0, 200)),
    },
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
      task_token_budget: input.taskBudget,
      spent: budget.spent,
      utilisation: Number((budget.spent / input.taskBudget).toFixed(3)),
      tokens_per_output_word: Number((budget.spent / Math.max(1, onDisk.words)).toFixed(1)),
    },
    context: {
      thresholds: thresholdsFor(profile),
      // The ceiling actually reached, so a run that needed the larger window is
      // distinguishable from one that merely had it.
      peak_context_tokens: ledger.reduce((n, e) => Math.max(n, e.contextTokens), 0),
      peak_output_tokens: ledger.reduce((n, e) => Math.max(n, e.usage.output), 0),
      compactions: input.residents.compactions(),
    },
    /**
     * What the index actually gained — the question the first long run could not
     * answer, having reported nine committed scenes while producing no character
     * files, no relations and no timeline at all.
     */
    index: {
      reads: harness.reads.length,
      reads_by_role: harness.reads.reduce<Record<string, number>>((acc, r) => {
        acc[r.role] = (acc[r.role] ?? 0) + 1;
        return acc;
      }, {}),
      partitions: await partitionReport(input.projectRoot),
      references: input.referenceReport.counts,
      dangling: input.referenceReport.dangling,
      scenes_committed_on_disk: onDisk.scenes,
    },
    memory: {
      root: args.memoryDir ?? input.projectRoot,
      shared_across_runs: args.memoryDir !== null,
      skills: await byRole(harness.skillLibraries, async (library) =>
        (await library.all()).map((s) => s.slug),
      ),
      topics: await byRole(harness.memories, async (memory) =>
        (await memory.live()).map((m) => m.topic),
      ),
    },
  };
}

async function byRole<T>(
  source: ReadonlyMap<AgentRole, T>,
  read: (value: T) => Promise<readonly string[]>,
): Promise<Record<string, readonly string[]>> {
  return Object.fromEntries(
    await Promise.all([...source].map(async ([role, value]) => [role, await read(value)] as const)),
  );
}

export type { AgentMemory, SkillLibrary };
