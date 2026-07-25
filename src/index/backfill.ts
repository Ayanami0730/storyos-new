/**
 * Folding a finished scene back into the index.
 *
 * The brief was specific about this role: *"index manager，他专注于文件系统（就是
 * 这个统一index）的读和写，每次整套系统有新的进展、产出，都应该唤起他来对对应
 * index做修改、添加…新情节、新人物、人物之间关系的变化、新事件、当前的故事韵律
 * …伏笔的回收"*. The first implementation replaced all of that with ten lines
 * (`absorb()`) that merged claims into an in-memory map, and never invoked the
 * agent at all — nineteen scenes of output, zero index-manager calls.
 *
 * What that lost is not tidiness. It lost every partition that the *next* scene
 * needs to read: no character files, so no state and no beliefs; no relations, so
 * the paper's second novelty had no artefact; no timeline, so no chronology; no
 * rhythm, so no way to see a sagging middle.
 *
 * ## Why this is agent work and not a transform
 *
 * Applying declared state is mechanical, and this module does it. The rest is
 * judgement: whether a scene *begins a new relation phase* or merely continues
 * one, which promise a payoff answers, what the scene did to the tension curve.
 * Those cannot be pattern-matched off a delta, and the brief put them here on
 * purpose. So index-manager gets typed tools, and this class is what they write
 * through — accumulating pending writes so that prose, delta and every derived
 * partition land in **one** commit or none.
 *
 * ## The one thing it must never do
 *
 * Invent. Every mutation carries the scene it came from and, where the shape
 * allows, verbatim prose. A backfill that quietly improves on what the writer
 * wrote produces an index that disagrees with the manuscript, and nothing
 * downstream can tell which is right.
 */

import { stringify as toYaml, parse as fromYaml } from "yaml";

import type { CanonicalIndex, FileWrite } from "./commit.ts";
import {
  type BeliefEntry,
  type CharacterProfile,
  type StateAttribute,
  type StateEntry,
  attributeAdvice,
  isStateAttribute,
  normaliseAttribute,
  parseJsonl,
  serialiseJsonl,
} from "./entities.ts";
import {
  type RelationPhase,
  type RelationRecord,
  pairId,
  validateRelationRecord,
} from "./relations.ts";
import { chapterFor, paths, sceneIndexOf } from "./tree.ts";

export interface TimelineEvent {
  readonly scene: string;
  readonly when: string | null;
  readonly summary: string;
  readonly participants: readonly string[];
  readonly location: string | null;
}

export interface PlotContract {
  readonly id: string;
  readonly promise: string;
  readonly scene: string;
  readonly quote: string;
  readonly dueByScene: string | null;
  readonly paidOffBy: string | null;
  readonly paidOffQuote?: string;
}

export interface RhythmRow {
  readonly scene: string;
  readonly chapter: string;
  /** Which beat of 起承转合 this scene serves. */
  readonly beat: string;
  readonly tensionTarget: number;
  readonly tensionActual: number;
  readonly note: string;
}

export class BackfillError extends Error {
  readonly problems: readonly string[];
  constructor(problems: readonly string[]) {
    super(problems.join("; "));
    this.name = "BackfillError";
    this.problems = problems;
  }
}

/**
 * Pending partition writes for one scene.
 *
 * Reads the current index lazily and caches, so a tool can be called several
 * times for the same file and see its own earlier writes — an index-manager that
 * appends two state entries in two calls must not lose the first.
 */
export class PartitionWriter {
  readonly #index: CanonicalIndex;
  readonly #sceneId: string;
  readonly #pending = new Map<string, string>();
  readonly #touched: string[] = [];

  constructor(index: CanonicalIndex, sceneId: string) {
    this.#index = index;
    this.#sceneId = sceneId;
  }

  get sceneId(): string {
    return this.#sceneId;
  }

  /** Files this backfill will write, for the commit and for the audit. */
  writes(): readonly FileWrite[] {
    return [...this.#pending].map(([relPath, content]) => ({ relPath, content }));
  }

  /** Partitions touched, in call order, so a run can show what a scene changed. */
  touched(): readonly string[] {
    return [...this.#touched];
  }

  async #read(relPath: string): Promise<string> {
    const pending = this.#pending.get(relPath);
    if (pending !== undefined) return pending;
    try {
      return await this.#index.read(relPath);
    } catch {
      return "";
    }
  }

  #write(relPath: string, content: string): void {
    this.#pending.set(relPath, content);
    if (!this.#touched.includes(relPath)) this.#touched.push(relPath);
  }

  // ---- characters -------------------------------------------------------

  /**
   * Create or extend a character profile.
   *
   * Identity attributes only, and an existing one is never silently replaced: a
   * changed identity attribute is a retcon and has to be recorded as one, which
   * is what `retcon` below is for. Silent replacement is how a story ends up with
   * two eye colours and no record of which came first.
   */
  async upsertCharacter(input: {
    readonly id: string;
    readonly name: string;
    readonly sketch: string;
    readonly identity: Readonly<Record<string, string>>;
  }): Promise<{ readonly conflicts: readonly string[] }> {
    const relPath = paths.profile(input.id);
    const existing = await this.#read(relPath);
    const current: CharacterProfile = existing
      ? (fromYaml(existing) as CharacterProfile)
      : {
          id: input.id,
          name: input.name,
          sketch: input.sketch,
          identity: {},
          provenance: {},
        };

    const identity: Record<string, string> = { ...current.identity };
    const provenance: Record<string, string> = { ...current.provenance };
    const conflicts: string[] = [];

    for (const [rawKey, value] of Object.entries(input.identity)) {
      const key = normaliseAttribute(rawKey);
      if (isStateAttribute(key)) {
        conflicts.push(
          `${key} is state, not identity — append it to ${paths.state(input.id)} instead, ` +
            `where the newest entry wins and no retcon is needed`,
        );
        continue;
      }
      const held = identity[key];
      if (held !== undefined && held !== value) {
        conflicts.push(
          `${key} is already "${held}" (from ${provenance[key] ?? "unknown"}); changing it ` +
            `to "${value}" is a retcon — record it with record_retcon so the change is ` +
            `readable, or leave it alone`,
        );
        continue;
      }
      identity[key] = value;
      provenance[key] ??= this.#sceneId;
    }

    this.#write(
      relPath,
      toYaml({
        ...current,
        name: current.name || input.name,
        sketch: current.sketch || input.sketch,
        identity,
        provenance,
      }),
    );
    return { conflicts };
  }

  /** Append state observations. The newest entry per attribute is the truth. */
  async appendState(
    characterId: string,
    entries: readonly { attribute: string; value: string; quote: string }[],
  ): Promise<void> {
    const problems: string[] = [];
    const normalised: StateEntry[] = [];
    entries.forEach((e, i) => {
      const attribute = normaliseAttribute(e.attribute);
      if (!isStateAttribute(attribute)) {
        problems.push(`entries[${i}]: ${attributeAdvice(e.attribute)}`);
        return;
      }
      if (!e.quote?.trim()) {
        problems.push(
          `entries[${i}].quote is required: a state change with no prose behind it cannot ` +
            `be audited, and is usually one the scene did not actually make`,
        );
        return;
      }
      normalised.push({
        scene: this.#sceneId,
        attribute: attribute as StateAttribute,
        value: e.value,
        quote: e.quote,
      });
    });
    if (problems.length > 0) throw new BackfillError(problems);

    const relPath = paths.state(characterId);
    const existing = parseJsonl<StateEntry>(await this.#read(relPath));
    this.#write(relPath, serialiseJsonl([...existing, ...normalised]));
  }

  /**
   * Append belief changes.
   *
   * Kept apart from state because "she knows the city moves" is not a property of
   * the city and not a place she is standing; it is the boundary that decides
   * whether her next line is a revelation or a continuity error.
   */
  async appendBeliefs(
    characterId: string,
    entries: readonly { proposition: string; stance: string; quote: string }[],
  ): Promise<void> {
    const allowed = new Set(["knows", "suspects", "wrong-about", "ignorant-of"]);
    const problems: string[] = [];
    const normalised: BeliefEntry[] = [];
    entries.forEach((e, i) => {
      if (!allowed.has(e.stance)) {
        problems.push(`entries[${i}].stance must be one of ${[...allowed].join(", ")}`);
        return;
      }
      if (!e.proposition?.trim()) problems.push(`entries[${i}].proposition is required`);
      else {
        normalised.push({
          scene: this.#sceneId,
          proposition: e.proposition,
          stance: e.stance as BeliefEntry["stance"],
          quote: e.quote ?? "",
        });
      }
    });
    if (problems.length > 0) throw new BackfillError(problems);

    const relPath = paths.beliefs(characterId);
    const existing = parseJsonl<BeliefEntry>(await this.#read(relPath));
    this.#write(relPath, serialiseJsonl([...existing, ...normalised]));
  }

  // ---- relations (novelty 2) -------------------------------------------

  /**
   * Open, close or revise a phase in one pair's relation record.
   *
   * The phase — not the edge — is the unit, and `transition` is the field the
   * whole novelty rests on: a typed graph can hold "mentor from scene 4 to scene
   * 9", but not *that the discipleship began by bowing to the wrong master*. That
   * sentence is what the next scene needs and what a label cannot carry.
   */
  async recordRelationPhase(input: {
    readonly participants: readonly [string, string];
    readonly relation: string;
    readonly transition: string;
    readonly span: string;
    readonly asymmetry?: string;
    /** Phase index this revises in place; the superseded phase stays readable. */
    readonly supersedes?: number;
    /** Close the previous open phase of the same pair at this scene. */
    readonly closesPrevious?: boolean;
  }): Promise<{ readonly pairId: string; readonly phaseIndex: number }> {
    const id = pairId(input.participants[0], input.participants[1]);
    const relPath = paths.relation(id);
    const existing = await this.#read(relPath);
    const record: RelationRecord = existing
      ? (fromYaml(existing) as RelationRecord)
      : {
          pairId: id,
          participants: [...input.participants].sort() as unknown as readonly [string, string],
          phases: [],
          openQuestions: [],
        };

    let phases: RelationPhase[] = record.phases.map((p) => ({ ...p }));
    if (input.closesPrevious) {
      // Close the latest still-open phase rather than all of them: overlapping
      // phases are legal — two people can be colleagues and rivals at once — so
      // closing everything would erase a distinction the schema exists to keep.
      for (let i = phases.length - 1; i >= 0; i -= 1) {
        if (phases[i]!.toScene === null) {
          phases[i] = { ...phases[i]!, toScene: this.#sceneId };
          break;
        }
      }
    }

    const phase: RelationPhase = {
      index: phases.length + 1,
      relation: input.relation,
      fromScene: this.#sceneId,
      toScene: null,
      transition: input.transition,
      ...(input.asymmetry ? { asymmetry: input.asymmetry } : {}),
      source: { scene: this.#sceneId, span: input.span },
      ...(input.supersedes ? { supersedes: input.supersedes } : {}),
    };
    phases = [...phases, phase];

    const next: RelationRecord = { ...record, phases };
    validateRelationRecord(next); // throws RelationRecordError with every problem
    this.#write(relPath, toYaml(next));
    return { pairId: id, phaseIndex: phase.index };
  }

  // ---- chronology, rhythm, promises ------------------------------------

  async appendEvent(input: {
    readonly summary: string;
    readonly participants: readonly string[];
    readonly location?: string | null;
    readonly when?: string | null;
  }): Promise<void> {
    if (!input.summary?.trim()) throw new BackfillError(["summary is required"]);
    const relPath = paths.timeline();
    const existing = parseJsonl<TimelineEvent>(await this.#read(relPath));
    const event: TimelineEvent = {
      scene: this.#sceneId,
      when: input.when ?? null,
      summary: input.summary,
      participants: input.participants ?? [],
      location: input.location ?? null,
    };
    this.#write(relPath, serialiseJsonl([...existing, event]));
  }

  /**
   * One row of the tension curve.
   *
   * The brief asked for "当前的故事韵律（比如小说应该是反复的起承转合的结合）".
   * A curve with a target and an observation is the only form of that a machine
   * can act on: the closing pass can see a sagging middle, and no amount of
   * prose-level checking ever would.
   */
  async recordRhythm(input: {
    readonly beat: string;
    readonly tensionTarget: number;
    readonly tensionActual: number;
    readonly note: string;
  }): Promise<void> {
    const relPath = paths.rhythm();
    const existing = await this.#read(relPath);
    const header = "scene,chapter,beat,tension_target,tension_actual,note";
    const rows = existing
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && l !== header)
      .filter((l) => !l.startsWith(`${this.#sceneId},`)); // rewriting a scene replaces its row
    const csv = (s: string) => `"${String(s).replace(/"/g, '""')}"`;
    rows.push(
      [
        this.#sceneId,
        chapterFor(sceneIndexOf(this.#sceneId)),
        csv(input.beat),
        input.tensionTarget,
        input.tensionActual,
        csv(input.note),
      ].join(","),
    );
    rows.sort((a, b) => sceneIndexOf(a.split(",")[0]!) - sceneIndexOf(b.split(",")[0]!));
    this.#write(relPath, `${header}\n${rows.join("\n")}\n`);
  }

  async registerPromise(input: {
    readonly id: string;
    readonly promise: string;
    readonly quote: string;
    readonly dueByScene?: string | null;
  }): Promise<void> {
    const relPath = paths.plotContracts();
    const existing = parseJsonl<PlotContract>(await this.#read(relPath));
    if (existing.some((c) => c.id === input.id)) return; // idempotent; a repeat is not a new promise
    const contract: PlotContract = {
      id: input.id,
      promise: input.promise,
      scene: this.#sceneId,
      quote: input.quote,
      dueByScene: input.dueByScene ?? null,
      paidOffBy: null,
    };
    this.#write(relPath, serialiseJsonl([...existing, contract]));
  }

  /**
   * Mark a promise paid, which is the half the first implementation never did:
   * nine declared, nine unpaid, nine revision tasks and no mechanism to close one.
   */
  async payOffPromise(contractId: string, quote: string): Promise<void> {
    const relPath = paths.plotContracts();
    const existing = parseJsonl<PlotContract>(await this.#read(relPath));
    const at = existing.findIndex((c) => c.id === contractId);
    if (at < 0) {
      throw new BackfillError([
        `no promise ${contractId} was ever registered. Open promises are in ` +
          `${paths.plotContracts()}; paying off something that was never promised is either ` +
          `a wrong id or a promise nobody recorded when it was made`,
      ]);
    }
    const updated = [...existing];
    updated[at] = { ...existing[at]!, paidOffBy: this.#sceneId, paidOffQuote: quote };
    this.#write(relPath, serialiseJsonl(updated));
  }

  /** A deliberate change to something already established, kept readable. */
  async recordRetcon(input: {
    readonly entity: string;
    readonly attribute: string;
    readonly from: string;
    readonly to: string;
    readonly reason: string;
  }): Promise<void> {
    const relPath = paths.retcons();
    const existing = parseJsonl<Record<string, unknown>>(await this.#read(relPath));
    this.#write(
      relPath,
      serialiseJsonl([...existing, { scene: this.#sceneId, ...input }]),
    );
    // The profile follows the retcon, not the other way round: the record of the
    // change is what makes the new value legible, so it is written first.
    const profilePath = paths.profile(input.entity);
    const profileText = await this.#read(profilePath);
    if (profileText) {
      const profile = fromYaml(profileText) as CharacterProfile;
      const key = normaliseAttribute(input.attribute);
      this.#write(
        profilePath,
        toYaml({
          ...profile,
          identity: { ...profile.identity, [key]: input.to },
          provenance: { ...profile.provenance, [key]: this.#sceneId },
        }),
      );
    }
  }

  /** Locations, objects, factions — flat records, same provenance discipline. */
  async upsertEntity(
    kind: "location" | "object" | "faction",
    input: { readonly id: string; readonly sketch: string; readonly notes?: string },
  ): Promise<void> {
    const relPath =
      kind === "location"
        ? paths.location(input.id)
        : kind === "object"
          ? paths.object(input.id)
          : paths.faction(input.id);
    const existing = await this.#read(relPath);
    const current = existing ? (fromYaml(existing) as Record<string, unknown>) : {};
    this.#write(
      relPath,
      toYaml({
        id: input.id,
        sketch: current.sketch ?? input.sketch,
        ...(input.notes ? { notes: [...((current.notes as string[]) ?? []), input.notes] } : {}),
        first_seen: current.first_seen ?? this.#sceneId,
      }),
    );
  }
}
