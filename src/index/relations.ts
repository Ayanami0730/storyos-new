/**
 * The relation record — where novelty 2 becomes a data structure.
 *
 * A typed graph edge can already carry an ordered sequence of intervals: NWM's
 * `Relationship state` has `character pair, relation type, polarity/status,
 * validity`, superseded edges stay as closed intervals, and history is kept. So
 * "strangers -> mentor -> lovers -> enemies -> lovers again" is *not* what a
 * graph fails at, and we must not claim it is (docs/01-novelty.md).
 *
 * What a typed label per interval cannot hold is the texture of the change:
 * that the discipleship began by bowing to the wrong master, that affection
 * went tentative -> dependent -> love. NWM records an `evidence span`, but a
 * span is a *pointer back into prose*, and re-reading prose is exactly what a
 * memory system exists to avoid. Its records are also chapter-scoped, so
 * within-chapter progression is flattened — and relationship change is usually
 * where sub-chapter ordering matters most.
 *
 * Hence every phase here carries:
 *   - `transition`: free text for *how and why* this phase began,
 *   - `asymmetry`: A's view of B need not equal B's view of A,
 *   - scene-level provenance with a line span, not a chapter number,
 *   - `supersedes`: in-place revision that keeps the superseded phase readable.
 */

export interface Provenance {
  readonly scene: string;
  /** Line span within that scene, e.g. "L44-L60". */
  readonly span: string;
}

export interface RelationPhase {
  /** 1-based, unique and contiguous within a record. */
  readonly index: number;
  readonly relation: string;
  readonly fromScene: string;
  /** null means the phase is still open. */
  readonly toScene: string | null;
  /**
   * How and why this phase began. The field a typed edge does not have; the
   * reason it exists is that continuing a story needs the cause, not the label.
   */
  readonly transition: string;
  /** Free text when the two participants do not see the relation the same way. */
  readonly asymmetry?: string;
  readonly source: Provenance;
  /** Index of a phase this one revises in place. */
  readonly supersedes?: number;
}

export interface RelationRecord {
  readonly pairId: string;
  readonly participants: readonly [string, string];
  readonly phases: readonly RelationPhase[];
  readonly openQuestions: readonly string[];
}

export class RelationRecordError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(`invalid relation record:\n  - ${problems.join("\n  - ")}`);
    this.name = "RelationRecordError";
    this.problems = problems;
  }
}

/** Deterministic pair id so the same two entities always map to one file. */
export function pairId(a: string, b: string): string {
  return [a, b].sort().join("--");
}

const SCENE_PATTERN = /^s-\d{3,}$/;

function sceneOrder(sceneId: string): number {
  return Number.parseInt(sceneId.slice(2), 10);
}

/**
 * Validate a record. Overlapping phases are *allowed* — two people can be
 * colleagues and rivals at once — but the record must stay coherent: indices
 * unique and contiguous, intervals well-formed, provenance present, and a
 * superseding phase must point at a real earlier phase.
 */
export function validateRelationRecord(record: RelationRecord): void {
  const problems: string[] = [];
  const { pairId: id, participants, phases } = record;

  if (participants[0] === participants[1]) {
    problems.push("participants must be two distinct entities");
  }
  if (id !== pairId(participants[0], participants[1])) {
    problems.push(
      `pairId ${id} does not match participants (${pairId(participants[0], participants[1])})`,
    );
  }
  if (phases.length === 0) {
    problems.push("a relation record needs at least one phase");
  }

  const seen = new Set<number>();
  for (const phase of phases) {
    const at = `phase ${phase.index}`;
    if (seen.has(phase.index)) problems.push(`${at}: duplicate index`);
    seen.add(phase.index);

    if (!phase.relation.trim()) problems.push(`${at}: relation must not be empty`);
    // The whole point of the record: a phase without its cause is a typed edge.
    if (!phase.transition.trim()) {
      problems.push(`${at}: transition must describe how and why the phase began`);
    }
    if (!SCENE_PATTERN.test(phase.fromScene)) {
      problems.push(`${at}: fromScene "${phase.fromScene}" is not a scene id`);
    }
    if (phase.toScene !== null && !SCENE_PATTERN.test(phase.toScene)) {
      problems.push(`${at}: toScene "${phase.toScene}" is not a scene id`);
    }
    if (
      phase.toScene !== null &&
      SCENE_PATTERN.test(phase.fromScene) &&
      SCENE_PATTERN.test(phase.toScene) &&
      sceneOrder(phase.toScene) < sceneOrder(phase.fromScene)
    ) {
      problems.push(`${at}: toScene precedes fromScene`);
    }
    if (!SCENE_PATTERN.test(phase.source.scene)) {
      problems.push(`${at}: provenance scene "${phase.source.scene}" is not a scene id`);
    }
    if (!/^L\d+(-L\d+)?$/.test(phase.source.span)) {
      problems.push(`${at}: provenance span "${phase.source.span}" must look like L44-L60`);
    }
    if (phase.supersedes !== undefined) {
      if (phase.supersedes >= phase.index) {
        problems.push(`${at}: may only supersede an earlier phase`);
      } else if (!phases.some((p) => p.index === phase.supersedes)) {
        problems.push(`${at}: supersedes ${phase.supersedes}, which does not exist`);
      }
    }
  }

  const indices = [...seen].sort((a, b) => a - b);
  const contiguous = indices.every((n, i) => n === i + 1);
  if (indices.length > 0 && !contiguous) {
    problems.push(`phase indices must be 1..n, got ${indices.join(",")}`);
  }

  if (problems.length > 0) throw new RelationRecordError(problems);
}

/** Phases in force at a scene, excluding any that were superseded. */
export function phasesAt(record: RelationRecord, sceneId: string): readonly RelationPhase[] {
  const at = sceneOrder(sceneId);
  const superseded = new Set(
    record.phases.flatMap((p) => (p.supersedes === undefined ? [] : [p.supersedes])),
  );
  return record.phases.filter(
    (p) =>
      !superseded.has(p.index) &&
      sceneOrder(p.fromScene) <= at &&
      (p.toScene === null || sceneOrder(p.toScene) >= at),
  );
}

/**
 * The narrative a writer actually needs: every phase in order with the cause of
 * each change. This is the query a typed edge cannot answer without re-reading
 * the prose it points at.
 */
export function renderHistory(record: RelationRecord): string {
  const superseded = new Set(
    record.phases.flatMap((p) => (p.supersedes === undefined ? [] : [p.supersedes])),
  );
  const lines: string[] = [`${record.participants[0]} & ${record.participants[1]}`];
  for (const p of [...record.phases].sort((a, b) => a.index - b.index)) {
    const span = p.toScene === null ? `${p.fromScene}-` : `${p.fromScene}..${p.toScene}`;
    const mark = superseded.has(p.index) ? " [superseded]" : "";
    lines.push(`  ${span}  ${p.relation}${mark}`);
    lines.push(`    how: ${p.transition}`);
    if (p.asymmetry) lines.push(`    asymmetry: ${p.asymmetry}`);
    lines.push(`    source: ${p.source.scene} ${p.source.span}`);
  }
  if (record.openQuestions.length > 0) {
    lines.push("  open questions:");
    for (const q of record.openQuestions) lines.push(`    - ${q}`);
  }
  return lines.join("\n");
}
