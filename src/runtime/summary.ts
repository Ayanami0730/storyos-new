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
import { SCHEDULE } from "./allocation.ts";
import type { BudgetProfile, TokenBudget } from "./budget.ts";
import { priceLedger } from "./rates.ts";
import { VERSION, VERSION_NOTE } from "../version.ts";
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
    readonly pinnedRepairs: number | null;
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
  /**
   * What actually enforced the write gate, and whether it was demonstrated.
   *
   * In the summary rather than the log because it qualifies every other number
   * in the file: "only index-manager writes canonical state" is a different
   * claim when a mount enforced it than when a regular expression did.
   */
  readonly sandbox: Record<string, unknown>;
}

export async function buildSummary(input: SummaryInput): Promise<Record<string, unknown>> {
  const { args, result, harness, profile, budget, onDisk } = input;
  const ledger: readonly LedgerEntry[] = input.residents.ledger();

  return {
    /**
     * Which harness produced this. First field on purpose: a result whose
     * version is unknown cannot be compared with anything, and four of this
     * version's fixes changed measured numbers by large factors.
     */
    harness_version: VERSION,
    harness_version_note: VERSION_NOTE,
    premise_words: args.premise.split(/\s+/).filter(Boolean).length,
    target_words: args.target,
    backbone: args.backbone ?? "default (gpt-5-mini, verifier cross-family)",
    /**
     * How the per-scene allowance was decided, and what it bought.
     *
     * This block is the whole of the evidence for the schedule, so it is arranged
     * as the test rather than as a configuration dump: `by_tier` puts each tier's
     * allowance next to the findings, repair rounds and follow-ups the scenes in
     * it actually produced. The claim is that later scenes need more; if the
     * endgame's extra rounds go unused and its findings match the opening's, the
     * claim is wrong and this is where that shows.
     *
     * The inference being tested is stated in `runtime/allocation.ts`:
     * `experiments/degradation` measured errors accumulating with the length of a
     * finished text, not with position inside one run.
     */
    allocation: allocationReport(input),
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
    /**
     * Scenes that committed carrying a defect the repair loop could not fix.
     *
     * The gate objected and was overruled on purpose: deleting a scene costs
     * more than the defect does — one dropped scene took fifteen points off the
     * length score and left the manuscript opening mid-investigation. So the
     * scene lands and this number is how the run admits it. A manuscript with
     * these is not a clean one, and `findings_total` alone would not say so.
     */
    scenes_with_unresolved_findings:
      result?.scenes.filter(
        (s) => s.outcome.status === "COMMITTED" && s.outcome.unresolvedFindings.length > 0,
      ).length ?? 0,
    unresolved_findings: (result?.scenes ?? [])
      .filter((s) => s.outcome.status === "COMMITTED" && s.outcome.unresolvedFindings.length > 0)
      .flatMap((s) =>
        s.outcome.status === "COMMITTED"
          ? s.outcome.unresolvedFindings.map((f) => ({
              scene: s.card.id,
              subtype: f.subtype,
              severity: f.severity,
              reasoning: f.reasoning,
              suggestion: f.suggestion ?? null,
              quote: f.evidence.quote.slice(0, 160),
            }))
          : [],
      ),
    canon_facts: result?.canon.length ?? 0,
    promises_declared: result ? result.revision.coverage.contractsChecked : 0,
    promises_unpaid: result ? result.revision.coverage.contractsOpen : 0,
    revision_tasks: result?.revision.tasks.length ?? 0,
    /**
     * What a comparison may use: `input + output`, which is what every baseline
     * counts (`run_lbw.py`: `used_tokens += input_tokens + output_tokens`).
     */
    tokens: ledger.reduce((n, e) => n + e.usage.billable, 0),
    /**
     * What the provider reported, cache reads included — and it is mostly cache
     * reads. On a measured run 89.5% of this number was `cacheRead`. It is the
     * honest figure for what moved over the wire and the wrong figure for any
     * table that puts us beside a system counting fresh tokens only.
     */
    tokens_reported_including_cache: ledger.reduce((n, e) => n + e.usage.total, 0),
    tokens_cache_read: ledger.reduce((n, e) => n + e.usage.cacheRead, 0),
    /**
     * What this run would cost at the providers' public list prices.
     *
     * Not a bill. The company gateway publishes no rate card, so nothing here
     * knows what we were actually charged; this answers the reproducible
     * question instead — what would someone pay running the same tokens
     * against the public APIs. Cached input is priced at its own (90% cheaper)
     * rate, because it is most of our traffic and charging it at the full input
     * rate would overstate the cost of this design by roughly ten times.
     */
    cost_estimate: {
      note:
        "list-price estimate against the providers' public rates, not the gateway's " +
        "billing. Cached input priced separately. See src/runtime/rates.ts for sources.",
      ...priceLedger(ledger.map((e) => ({ model: e.model, usage: e.usage }))),
    },
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
     * How many rounds a scene gets is now a function of its position, so the
     * interesting cut is `by_tier`: an endgame allowance of five that is never
     * spent past one is a schedule buying prompt text and nothing else.
     */
    follow_ups: {
      total: harness.followUps.length,
      by_scene: harness.followUps.reduce<Record<string, number>>((acc, f) => {
        acc[f.scene] = (acc[f.scene] ?? 0) + 1;
        return acc;
      }, {}),
      by_tier: harness.followUps.reduce<Record<string, number>>((acc, f) => {
        acc[f.tier] = (acc[f.tier] ?? 0) + 1;
        return acc;
      }, {}),
      questions: harness.followUps.map((f) => `[${f.tier} ${f.round}/${f.allowed}] ${f.question.slice(0, 200)}`),
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
      /**
       * Whether the ceiling stopped the run or merely counted.
       *
       * Reported because it changes what the row means. Every LongBench-Write
       * baseline ran unstopped — its runner substitutes a meter for the budget
       * on purpose — so an enforced row is not comparable with them.
       */
      enforced: budget.enforced,
      spent: budget.spent,
      utilisation: Number((budget.spent / input.taskBudget).toFixed(3)),
      tokens_per_output_word: Number((budget.spent / Math.max(1, onDisk.words)).toFixed(1)),
    },
    sandbox: input.sandbox,
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

/**
 * Each tier's allowance beside what the scenes in it actually did.
 *
 * Deliberately not a summary of the configuration — the configuration is in
 * `SCHEDULE` and is the same every run. What varies, and what a reader needs, is
 * whether the scenes given more used more and whether they needed to.
 */
function allocationReport(input: SummaryInput): Record<string, unknown> {
  const { result, harness } = input;
  const allocations = result?.allocations ?? [];
  const outcomeOf = (sceneId: string) =>
    result?.scenes.find((s) => s.card.id === sceneId)?.outcome ?? null;

  const tiers: Record<string, unknown> = {};
  for (const tier of new Set(SCHEDULE.map((p) => p.tier))) {
    const scenes = allocations.filter((a) => a.allocation.tier === tier);
    if (scenes.length === 0) continue;
    const outcomes = scenes.map((s) => outcomeOf(s.sceneId)).filter((o) => o !== null);
    tiers[tier] = {
      scenes: scenes.map((s) => s.sceneId),
      allowed: {
        repair_rounds: scenes[0]!.allocation.repairRounds,
        follow_up_rounds: scenes[0]!.allocation.followUpRounds,
        recent_scenes_in_packet: scenes[0]!.allocation.recentScenes,
      },
      used: {
        // Attempts include the first draft, so rounds spent is attempts - 1.
        repair_rounds: outcomes.reduce((n, o) => n + Math.max(0, o!.attempts - 1), 0),
        follow_ups: harness.followUps.filter(
          (f) => scenes.some((s) => s.sceneId === f.scene),
        ).length,
      },
      /**
       * The number the schedule stands or falls on. If findings per scene do not
       * rise across these three rows, position is not predicting risk in our runs
       * and the endgame tiers are paying for nothing.
       */
      findings: outcomes.reduce((n, o) => n + o!.findings.length, 0),
      findings_per_scene: Number(
        (outcomes.reduce((n, o) => n + o!.findings.length, 0) / Math.max(1, outcomes.length))
          .toFixed(2),
      ),
      committed: outcomes.filter((o) => o!.status === "COMMITTED").length,
      unresolved_findings: outcomes.reduce(
        (n, o) => n + (o!.status === "COMMITTED" ? o!.unresolvedFindings.length : 0),
        0,
      ),
    };
  }

  return {
    mode: input.args.pinnedRepairs === null ? "by-position" : "uniform (pinned)",
    pinned_to: input.args.pinnedRepairs,
    note:
      input.args.pinnedRepairs === null
        ? "per-scene allowance from runtime/allocation.ts; rows below are the test of it"
        : "position schedule OFF — every scene pinned to the same allowance. This is the " +
          "ablation arm and is not the default configuration.",
    schedule: SCHEDULE.map((p) => ({
      tier: p.tier,
      up_to_position: p.until === Infinity ? 1 : p.until,
      repair_rounds: p.repairRounds,
      follow_up_rounds: p.followUpRounds,
      recent_scenes_in_packet: p.recentScenes,
    })),
    per_scene: allocations.map((a) => ({
      scene: a.sceneId,
      tier: a.allocation.tier,
      position: a.allocation.position,
      allowed_repair_rounds: a.allocation.repairRounds,
      allowed_follow_ups: a.allocation.followUpRounds,
      recent_scenes_in_packet: a.allocation.recentScenes,
      // The reason travels with the numbers so that neither the trace bundle nor
      // a reader six months from now has to reconstruct it from the tier name.
      rationale: a.allocation.rationale,
      attempts: outcomeOf(a.sceneId)?.attempts ?? null,
      findings: outcomeOf(a.sceneId)?.findings.length ?? null,
      status: outcomeOf(a.sceneId)?.status ?? "not attempted",
    })),
    by_tier: tiers,
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
