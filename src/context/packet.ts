/**
 * Priority-ordered context packet assembly with a coverage report.
 *
 * The builder fails loudly in two cases, both deliberate:
 *   1. A hard-required id does not resolve — the writer must never be asked to
 *      infer state that should have been supplied.
 *   2. The mandatory tiers (P0/P1) do not fit the budget — silently dropping a
 *      world rule to make room is worse than refusing to build.
 */

import {
  type ContextItem,
  type ContextPacket,
  type CoverageReport,
  type PacketRequest,
  type Priority,
  MANDATORY_PRIORITIES,
  PRIORITIES,
  PacketBuildError,
} from "./types.ts";

/**
 * Word count, as the benchmarks count words. See `runtime/words.ts`.
 *
 * Re-exported here rather than left as its own whitespace split, because the
 * packet budget is a proxy for how much text an agent has to read and a Chinese
 * packet was being measured at a fiftieth of its real size — the same defect that
 * made a finished 1,850-character manuscript report `20 words`.
 */
import { countWords } from "../runtime/words.ts";

export { countWords };

function emptyByPriority(): Record<Priority, { included: number; excluded: number; words: number }> {
  return Object.fromEntries(
    PRIORITIES.map((p) => [p, { included: 0, excluded: 0, words: 0 }]),
  ) as Record<Priority, { included: number; excluded: number; words: number }>;
}

export function buildContextPacket(
  request: PacketRequest,
  available: readonly ContextItem[],
): ContextPacket {
  if (!Number.isInteger(request.budgetWords) || request.budgetWords <= 0) {
    throw new PacketBuildError("budgetWords must be a positive integer");
  }

  const byId = new Map<string, ContextItem>();
  for (const item of available) {
    if (byId.has(item.id)) {
      throw new PacketBuildError(`duplicate context item id: ${item.id}`);
    }
    byId.set(item.id, item);
  }

  // Invariant 1: every hard-required id must resolve, before anything else.
  const missingIds = request.hardRequiredIds.filter((id) => !byId.has(id));
  if (missingIds.length > 0) {
    throw new PacketBuildError(
      `context packet for ${request.sceneId} is missing hard-required ids: ${missingIds.join(", ")}`,
      { missingIds },
    );
  }

  // Stable ordering: tier first, then the order the caller supplied. No
  // similarity ranking — that is what lets P2 material outrank a world rule.
  const ordered = PRIORITIES.flatMap((p) =>
    available.filter((item) => item.priority === p),
  );

  const mandatory = ordered.filter((i) => MANDATORY_PRIORITIES.includes(i.priority));
  const mandatoryWords = mandatory.reduce((n, i) => n + countWords(i.content), 0);
  if (mandatoryWords > request.budgetWords) {
    // Invariant 2: refuse rather than silently drop a hard constraint.
    const overflowPriorities = [...new Set(mandatory.map((i) => i.priority))];
    throw new PacketBuildError(
      `mandatory tiers need ${mandatoryWords} words but the budget is ${request.budgetWords}`,
      { overflowPriorities },
    );
  }

  const included: ContextItem[] = [];
  const excluded: { id: string; priority: Priority }[] = [];
  const byPriority = emptyByPriority();
  let usedWords = 0;

  for (const item of ordered) {
    const words = countWords(item.content);
    const isMandatory = MANDATORY_PRIORITIES.includes(item.priority);
    const isHardRequired = request.hardRequiredIds.includes(item.id);

    // Items are never split; an item either fits whole or is dropped whole.
    if (isMandatory || isHardRequired || usedWords + words <= request.budgetWords) {
      included.push(item);
      usedWords += words;
      const tier = byPriority[item.priority];
      tier.included += 1;
      tier.words += words;
    } else {
      excluded.push({ id: item.id, priority: item.priority });
      byPriority[item.priority].excluded += 1;
    }
  }

  const coverage: CoverageReport = {
    sceneId: request.sceneId,
    baseCommitId: request.baseCommitId,
    budgetWords: request.budgetWords,
    usedWords,
    includedIds: included.map((i) => i.id),
    excluded,
    byPriority,
    complete: excluded.length === 0,
  };

  return { request, items: included, coverage, rendered: render(request, included) };
}

function render(request: PacketRequest, items: readonly ContextItem[]): string {
  const lines: string[] = [
    `# Context packet — scene ${request.sceneId}`,
    `base_commit: ${request.baseCommitId}`,
    "",
  ];
  for (const priority of PRIORITIES) {
    const tier = items.filter((i) => i.priority === priority);
    if (tier.length === 0) continue;
    lines.push(`## ${priority}`, "");
    for (const item of tier) {
      // Provenance travels with every item so a claim can be traced back.
      lines.push(`### ${item.id}  <${item.source}>`, "", item.content, "");
    }
  }
  return lines.join("\n");
}
