/**
 * Reference integrity across partitions — the check that costs nothing.
 *
 * The brief asked for an index whose partitions are "多层嵌套互相索引". Cross-links
 * are what make that useful and also what rots first: a state entry says
 * `location: loc-catacombs` and `locations/loc-catacombs.yaml` was never created;
 * a relation names a character who has no profile; a promise is due by a scene the
 * plan no longer contains. None of this is visible in the prose, none of it will
 * be caught by a model reading one scene, and each one silently degrades every
 * later packet built from it.
 *
 * Per-file schema validation cannot see any of it, because every file is
 * individually well-formed. So this runs over the whole tree, spends no tokens,
 * and reports dangling links with the file that points at nothing.
 *
 * Severity is deliberately not uniform. A missing location file is a gap to fill;
 * a relation phase naming an entity that does not exist is a broken record. The
 * distinction matters because the first should never block a commit and the second
 * should be fixed before anything is built on it.
 */

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { parse as fromYaml } from "yaml";

import type { PlotContract, TimelineEvent } from "../index/backfill.ts";
import { type BeliefEntry, type StateEntry, parseJsonl } from "../index/entities.ts";
import type { RelationRecord } from "../index/relations.ts";
import { paths } from "../index/tree.ts";

export interface DanglingReference {
  /** File that points at something absent. */
  readonly from: string;
  /** What it points at. */
  readonly target: string;
  readonly kind:
    | "missing-character"
    | "missing-location"
    | "missing-object"
    | "missing-scene"
    | "missing-promise";
  readonly detail: string;
  /**
   * `broken` means a record is internally invalid and should be repaired before
   * anything reads it. `gap` means a partition has not been filled in yet, which
   * is normal mid-story and must not block a commit.
   */
  readonly severity: "broken" | "gap";
}

export interface ReferenceReport {
  readonly dangling: readonly DanglingReference[];
  readonly counts: Readonly<Record<string, number>>;
}

async function listIds(root: string, dir: string, strip = ".yaml"): Promise<Set<string>> {
  try {
    const entries = await readdir(path.join(root, dir), { withFileTypes: true });
    return new Set(
      entries.map((e) => (e.isDirectory() ? e.name : e.name.replace(strip, ""))),
    );
  } catch {
    return new Set();
  }
}

async function readText(root: string, rel: string): Promise<string> {
  try {
    return await readFile(path.join(root, rel), "utf8");
  } catch {
    return "";
  }
}

/**
 * Walk the tree and report every link that points at nothing.
 *
 * Reads files rather than taking an in-memory model, on purpose: the point is to
 * check what a *later agent will actually find on disk*, which is not necessarily
 * what the process that wrote it believed.
 */
export async function checkReferences(
  root: string,
  options: { readonly knownScenes?: ReadonlySet<string> } = {},
): Promise<ReferenceReport> {
  const dangling: DanglingReference[] = [];
  const characters = await listIds(root, "characters", "");
  const locations = await listIds(root, "locations");
  const objects = await listIds(root, "objects");
  const counts: Record<string, number> = {
    characters: characters.size,
    locations: locations.size,
    objects: objects.size,
    relations: 0,
    events: 0,
    promises: 0,
    state_entries: 0,
    belief_entries: 0,
  };

  const scenes = options.knownScenes;
  const noteScene = (from: string, scene: string, detail: string) => {
    if (!scenes || scenes.has(scene)) return;
    dangling.push({ from, target: scene, kind: "missing-scene", detail, severity: "broken" });
  };

  // Character state and beliefs.
  for (const id of characters) {
    const state = parseJsonl<StateEntry>(await readText(root, paths.state(id)));
    counts.state_entries! += state.length;
    for (const entry of state) {
      noteScene(paths.state(id), entry.scene, `state entry for ${entry.attribute}`);
      if (entry.attribute !== "location") continue;
      // A location value is only a reference if it looks like one: writers also
      // write "somewhere on the quay", and demanding a file for that would push
      // them back towards prose-shaped values, which is worse.
      if (/^loc-[a-z0-9-]+$/.test(entry.value) && !locations.has(entry.value)) {
        dangling.push({
          from: paths.state(id),
          target: entry.value,
          kind: "missing-location",
          detail: `${id} is at ${entry.value} as of ${entry.scene}, but that location has no file`,
          severity: "gap",
        });
      }
    }
    const beliefs = parseJsonl<BeliefEntry>(await readText(root, paths.beliefs(id)));
    counts.belief_entries! += beliefs.length;
    for (const belief of beliefs) noteScene(paths.beliefs(id), belief.scene, "belief entry");
  }

  // Relations: both participants must exist, and a superseding phase must point
  // at a phase that is really there.
  for (const file of await listIds(root, "relations")) {
    const record = fromYaml(await readText(root, paths.relation(file))) as RelationRecord | null;
    if (!record) continue;
    counts.relations! += 1;
    for (const participant of record.participants ?? []) {
      if (participant.startsWith("char-") && !characters.has(participant)) {
        dangling.push({
          from: paths.relation(file),
          target: participant,
          kind: "missing-character",
          detail: `relation ${file} names ${participant}, who has no profile`,
          severity: "broken",
        });
      }
    }
    const indices = new Set((record.phases ?? []).map((p) => p.index));
    for (const phase of record.phases ?? []) {
      noteScene(paths.relation(file), phase.fromScene, `phase ${phase.index}`);
      if (phase.supersedes !== undefined && !indices.has(phase.supersedes)) {
        dangling.push({
          from: paths.relation(file),
          target: `phase ${phase.supersedes}`,
          kind: "missing-promise",
          detail: `phase ${phase.index} supersedes a phase that is not in the record`,
          severity: "broken",
        });
      }
    }
  }

  // Timeline participants and locations.
  const events = parseJsonl<TimelineEvent>(await readText(root, paths.timeline()));
  counts.events = events.length;
  for (const event of events) {
    noteScene(paths.timeline(), event.scene, "timeline event");
    for (const participant of event.participants ?? []) {
      const missing =
        (participant.startsWith("char-") && !characters.has(participant)) ||
        (participant.startsWith("obj-") && !objects.has(participant));
      if (missing) {
        dangling.push({
          from: paths.timeline(),
          target: participant,
          kind: participant.startsWith("char-") ? "missing-character" : "missing-object",
          detail: `event in ${event.scene} involves ${participant}, which has no file`,
          severity: "gap",
        });
      }
    }
  }

  // Promises: due-by and paid-off must name real scenes.
  const contracts = parseJsonl<PlotContract>(await readText(root, paths.plotContracts()));
  counts.promises = contracts.length;
  for (const contract of contracts) {
    noteScene(paths.plotContracts(), contract.scene, `promise ${contract.id}`);
    if (contract.paidOffBy) {
      noteScene(paths.plotContracts(), contract.paidOffBy, `payoff of ${contract.id}`);
    }
  }

  return { dangling, counts };
}

/** One line per problem, for a run report or a repair brief. */
export function renderReferenceReport(report: ReferenceReport): string {
  if (report.dangling.length === 0) {
    return `reference integrity: clean (${report.counts.characters} character(s), ${report.counts.relations} relation(s), ${report.counts.events} event(s))`;
  }
  const broken = report.dangling.filter((d) => d.severity === "broken");
  const gaps = report.dangling.filter((d) => d.severity === "gap");
  return [
    `reference integrity: ${broken.length} broken, ${gaps.length} gap(s)`,
    ...broken.map((d) => `  BROKEN ${d.from} -> ${d.target}: ${d.detail}`),
    ...gaps.map((d) => `  gap    ${d.from} -> ${d.target}: ${d.detail}`),
  ].join("\n");
}
