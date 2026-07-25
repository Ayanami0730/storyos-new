/**
 * Entity state: what varies, what does not, and why they cannot share a file.
 *
 * This module exists because of one measured failure. In the first long run
 * (`runs/v4-24k`, nineteen scenes) **four of the five blocking findings were the
 * same defect**, verbatim in shape:
 *
 *     char-araine's location was established as "loc-docks" and this scene
 *     asserts "loc-charthouse" without declaring the change deliberate
 *
 * `location` was set in scene 1 and every later scene that moved her was
 * reported as a contradiction, because the model of canon was a flat map from
 * `(entity, attribute)` to one value, and changing a value required a formal
 * `supersedes`. That mechanism is right for "she dyed her hair" and absurd for
 * "she walked to the next room".
 *
 * The writer's response is the part worth remembering. Told that touching
 * `location` cost a repair round, it stopped touching `location` and began
 * inventing a fresh attribute per scene — `left_market_and_crossed_to_docks`,
 * `visited_warden_office_then_entered_catacombs` — because a name that has never
 * been used cannot collide. Canon became a 72-entry diary of events, no value was
 * ever superseded, and the packet went on presenting `location: loc-docks (from
 * s-001)` as current state at scene 13. It even wrote itself a memory about it,
 * and got the lesson wrong: *"state the movement explicitly in the prose"*, which
 * fixes nothing.
 *
 * So there are three kinds of thing, and the type system knows which is which:
 *
 * - **Identity** (`profile.yaml`): name, appearance, origin, profession. Does not
 *   vary with the plot. Changing one *is* a retcon and must say so.
 * - **State** (`state.jsonl`): location, what they hold, mood, condition, goal.
 *   Varies by nature. Append-only; the current value is the newest entry. No
 *   declaration needed, because ordinary change is not an error.
 * - **Belief** (`beliefs.jsonl`): what they know and from when. Tracked apart
 *   from truth because most knowledge contradictions in generated fiction are a
 *   character using something the reader knows and they do not.
 *
 * The controlled vocabulary is the other half of the fix. Free-form attribute
 * names are what let the writer route around the check; a closed set means the
 * same concept lands in the same slot every time, so it can actually be
 * superseded.
 */

import type { CanonFact } from "../verification/deterministic.ts";

/**
 * State attributes a character may have. Closed on purpose.
 *
 * Chosen to cover what a scene actually changes about a person. `goal` is here
 * because intent drives the next scene and a stale intent reads as a character
 * forgetting what they wanted — one of the negative-inference subtypes.
 */
export const STATE_ATTRIBUTES = [
  "location",
  "holds",
  "mood",
  "condition",
  "companions",
  "goal",
] as const;

export type StateAttribute = (typeof STATE_ATTRIBUTES)[number];

export function isStateAttribute(name: string): name is StateAttribute {
  return (STATE_ATTRIBUTES as readonly string[]).includes(normaliseAttribute(name));
}

/**
 * Identity attributes. Also closed, and deliberately short.
 *
 * If something is not in either list it is almost certainly an event, and events
 * belong in `events/timeline.jsonl` where nothing will later read them as a
 * property that changed.
 */
export const IDENTITY_ATTRIBUTES = [
  "name",
  "appearance",
  "age",
  "origin",
  "profession",
  "speech",
  "身份",
] as const;

export type IdentityAttribute = (typeof IDENTITY_ATTRIBUTES)[number];

export function isIdentityAttribute(name: string): name is IdentityAttribute {
  return (IDENTITY_ATTRIBUTES as readonly string[]).includes(normaliseAttribute(name));
}

export function normaliseAttribute(name: string): string {
  return name.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

export type AttributeKind = "state" | "identity" | "unknown";

export function attributeKind(name: string): AttributeKind {
  if (isStateAttribute(name)) return "state";
  if (isIdentityAttribute(name)) return "identity";
  return "unknown";
}

/**
 * The guidance an agent gets when it uses an attribute name we do not accept.
 *
 * Written as a redirect rather than a refusal, because the underlying urge is
 * usually right — the scene did change something — and the useful answer is
 * where that something goes.
 */
export function attributeAdvice(name: string): string {
  return (
    `"${name}" is not a tracked attribute. State attributes (they change as the story ` +
    `moves, newest entry wins, no retcon needed): ${STATE_ATTRIBUTES.join(", ")}. ` +
    `Identity attributes (changing one is a retcon and must be declared): ` +
    `${IDENTITY_ATTRIBUTES.filter((a) => /^[a-z]/.test(a)).join(", ")}. ` +
    `If what you want to record is something that *happened* rather than something ` +
    `that is now *true of* this entity, it is a timeline event — the prose already ` +
    `narrates it, and filing it as a property makes the next scene in which they do ` +
    `anything else look like a contradiction.`
  );
}

export interface StateEntry {
  readonly scene: string;
  readonly attribute: StateAttribute;
  readonly value: string;
  readonly quote: string;
}

export type BeliefStance = "knows" | "suspects" | "wrong-about" | "ignorant-of";

export interface BeliefEntry {
  readonly scene: string;
  readonly proposition: string;
  readonly stance: BeliefStance;
  readonly quote: string;
}

export interface CharacterProfile {
  readonly id: string;
  readonly name: string;
  readonly sketch: string;
  readonly identity: Readonly<Record<string, string>>;
  /** Scene that established each identity attribute. */
  readonly provenance: Readonly<Record<string, string>>;
}

/** One line per entry, so appending is a concatenation and never a rewrite. */
export function serialiseJsonl(entries: readonly unknown[]): string {
  return entries.length === 0 ? "" : `${entries.map((e) => JSON.stringify(e)).join("\n")}\n`;
}

export function parseJsonl<T>(text: string): readonly T[] {
  return text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => JSON.parse(l) as T);
}

/**
 * Current state from a timeline: the newest entry per attribute.
 *
 * This one function is the whole difference. Under the old model the answer to
 * "where is she" was "whatever scene 1 said, until somebody performs a retcon";
 * here it is "whatever the most recent scene said", which is what everyone
 * assumed all along.
 */
export function currentState(
  entries: readonly StateEntry[],
): Readonly<Record<string, { value: string; scene: string; quote: string }>> {
  const out: Record<string, { value: string; scene: string; quote: string }> = {};
  for (const entry of entries) {
    const existing = out[entry.attribute];
    // Compare scene order rather than trusting file order: a re-read or a
    // partially replayed timeline must give the same answer.
    if (!existing || sceneOrder(entry.scene) >= sceneOrder(existing.scene)) {
      out[entry.attribute] = { value: entry.value, scene: entry.scene, quote: entry.quote };
    }
  }
  return out;
}

/**
 * State entries up to and including a scene.
 *
 * A packet for scene 3 must not contain scene 10's state. That sounds obvious and
 * is easy to get wrong, because the timeline for a *finished* story contains
 * everything and reading "current state" off it is right in every context except
 * the one that matters — building context for a scene being rewritten.
 */
export function stateAsOf(
  entries: readonly StateEntry[],
  scene: string,
): readonly StateEntry[] {
  const cutoff = sceneOrder(scene);
  return entries.filter((e) => sceneOrder(e.scene) <= cutoff);
}

/** What a character believed as of a scene, so a packet can be built for it. */
export function beliefsAsOf(
  entries: readonly BeliefEntry[],
  scene: string,
): readonly BeliefEntry[] {
  const cutoff = sceneOrder(scene);
  const latest = new Map<string, BeliefEntry>();
  for (const entry of entries) {
    if (sceneOrder(entry.scene) > cutoff) continue;
    const seen = latest.get(entry.proposition);
    if (!seen || sceneOrder(entry.scene) >= sceneOrder(seen.scene)) {
      latest.set(entry.proposition, entry);
    }
  }
  return [...latest.values()];
}

function sceneOrder(sceneId: string): number {
  const n = Number.parseInt(String(sceneId).replace(/^s-/, ""), 10);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Identity facts as the deterministic layer sees them.
 *
 * Only identity: state is excluded because the contradiction check asks "did a
 * value change without a declaration", which is a defect for identity and the
 * normal course of events for state.
 */
export function identityFacts(profiles: readonly CharacterProfile[]): readonly CanonFact[] {
  return profiles.flatMap((p) =>
    Object.entries(p.identity).map(([attribute, value]) => ({
      id: `fact-${p.id}-${attribute}`,
      entity: p.id,
      attribute,
      value,
      source: p.provenance[attribute] ?? "unknown",
    })),
  );
}

/** How a character reads in a context packet: identity, then state, then belief. */
export function renderCharacter(input: {
  readonly profile: CharacterProfile;
  readonly state: readonly StateEntry[];
  readonly beliefs: readonly BeliefEntry[];
  readonly asOfScene: string;
}): string {
  const { profile, asOfScene } = input;
  const now = currentState(stateAsOf(input.state, asOfScene));
  const beliefs = beliefsAsOf(input.beliefs, asOfScene);

  const lines = [`${profile.id} — ${profile.name}`, `  ${profile.sketch}`];

  const identity = Object.entries(profile.identity);
  if (identity.length > 0) {
    lines.push("  identity (changing any of these is a retcon):");
    for (const [k, v] of identity) {
      lines.push(`    ${k}: ${v}  (${profile.provenance[k] ?? "unknown"})`);
    }
  }

  lines.push("  state now:");
  if (Object.keys(now).length === 0) {
    lines.push("    nothing recorded yet");
  } else {
    for (const [k, v] of Object.entries(now)) lines.push(`    ${k}: ${v.value}  (${v.scene})`);
  }

  if (beliefs.length > 0) {
    // Grouped by stance because the useful question at drafting time is not
    // "what do they believe" but "what must they not use yet".
    lines.push("  knows / does not know:");
    for (const stance of ["knows", "suspects", "wrong-about", "ignorant-of"] as const) {
      const of = beliefs.filter((b) => b.stance === stance);
      if (of.length === 0) continue;
      lines.push(`    ${stance}: ${of.map((b) => `${b.proposition} (${b.scene})`).join("; ")}`);
    }
  }

  return lines.join("\n");
}
