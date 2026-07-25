/**
 * The partitioned index tree, created at initialisation.
 *
 * The original brief asked for this and the first implementation did not build
 * it: nineteen scenes of output produced exactly two kinds of file, flat
 * `manuscript/s-001.md` and `continuity/deltas/s-001.json`. Everything else —
 * characters, relations, events, the outline, the rhythm — lived in a process
 * array and evaporated. The consequences were not cosmetic:
 *
 *   - The context packet cited `index/story/bible/char-araine.yaml` as
 *     provenance for facts. **That file did not exist.** Provenance that cannot
 *     be opened is decoration.
 *   - `context-builder` had nothing to grep, so it was never invoked, so the
 *     claim that agents collaborate over a shared index was not being tested by
 *     any run.
 *   - `relations/<pair-id>.yaml` — the concrete form of novelty 2 — had never
 *     been produced by a single run, while the paper argued for it.
 *
 * So the tree is created up front, empty but complete, and every partition is a
 * real directory an agent can list. An empty `relations/` that an agent can see
 * is a prompt to fill it; a `relations/` that does not exist is a feature that
 * does not happen.
 *
 * ## The partitions, and why each is separate
 *
 * `novel/` is the artefact: outline, chapters, style. `characters/`,
 * `locations/`, `objects/`, `factions/` are the entities. `relations/` is
 * per-*pair* rather than per-entity because a relation belongs to neither
 * participant. `events/` is chronology, which is not state — "she went to the
 * warden's office" is a fact about a moment, not about her. `continuity/` is the
 * verifiable layer: canon facts, promises, open loops, retcons, findings.
 * `world/` is what is true regardless of who knows it.
 *
 * ## Why an entity is a directory, not a file
 *
 * `characters/<id>/` splits into `profile.yaml`, `state.jsonl` and
 * `beliefs.jsonl`, and that split is the fix for the defect that cost 80% of the
 * failed scenes in the first long run. A flat key-value entity file makes every
 * attribute equally permanent, so `location` set in scene 1 needs a formal
 * retcon to change in scene 2 — and the writer, told that changing a fact
 * requires declaring a deliberate supersede, learned instead to never touch
 * `location` again and to invent a new attribute name per scene. Canon became an
 * append-only diary of 72 entries with one permanently stale location that kept
 * firing contradictions.
 *
 * State that varies by nature belongs in a timeline where the current value is
 * simply the last entry. Identity belongs in a profile where a change really is
 * a retcon. The distinction is in the tree, so it cannot be argued with.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRole } from "../transaction/types.ts";

/** Roles that get their own dot-directory. */
export const AGENT_ROLES: readonly AgentRole[] = [
  "orchestrator",
  "index-manager",
  "context-builder",
  "writer",
  "verifier",
];

/**
 * Every directory created at init.
 *
 * Listed explicitly rather than derived from first use, because a partition that
 * appears only once something has been written to it is invisible exactly when
 * an agent is deciding whether to write there.
 */
export const PARTITIONS: readonly string[] = [
  "config",
  "novel/outline",
  "novel/outline/synopsis",
  "novel/chapters",
  "novel/style",
  "novel/style/exemplars",
  "characters",
  "relations",
  "locations",
  "objects",
  "factions",
  "events",
  "world",
  "continuity",
  "_schemas",
  "staging",
  "runtime",
  "runtime/transcripts",
  "runtime/artifacts",
];

/** Append-only logs, created empty so a reader never has to handle "absent". */
export const LEDGER_FILES: readonly string[] = [
  "events/timeline.jsonl",
  "continuity/canon-facts.jsonl",
  "continuity/plot-contracts.jsonl",
  "continuity/retcons.jsonl",
  "continuity/findings.jsonl",
  "runtime/events.jsonl",
];

export const paths = {
  harness: () => "HARNESS.md",
  head: () => "HEAD",
  agentDir: (role: AgentRole) => `.${role}`,
  agentPrompt: (role: AgentRole) => `.${role}/AGENT.md`,
  agentTools: (role: AgentRole) => `.${role}/tools.json`,
  memoryIndex: (role: AgentRole) => `.${role}/memory/MEMORY.md`,
  memoryTopic: (role: AgentRole, topic: string) => `.${role}/memory/${topic}.md`,
  skill: (role: AgentRole, skill: string) => `.${role}/skills/${skill}/SKILL.md`,

  premise: () => "novel/outline/premise.md",
  logline: () => "novel/outline/logline.md",
  beats: () => "novel/outline/beats.yaml",
  arcs: () => "novel/outline/arcs.yaml",
  /** Tension target vs actual per scene — the story rhythm, as a checkable file. */
  rhythm: () => "novel/outline/rhythm.csv",
  chapterDir: (chapter: string) => `novel/chapters/${chapter}`,
  chapterCard: (chapter: string) => `novel/chapters/${chapter}/chapter.yaml`,
  scene: (chapter: string, scene: string) => `novel/chapters/${chapter}/scenes/${scene}.md`,
  voice: () => "novel/style/voice.md",

  characterDir: (id: string) => `characters/${id}`,
  profile: (id: string) => `characters/${id}/profile.yaml`,
  /** Append-only state timeline. Current value of an attribute is its last entry. */
  state: (id: string) => `characters/${id}/state.jsonl`,
  beliefs: (id: string) => `characters/${id}/beliefs.jsonl`,
  relation: (pair: string) => `relations/${pair}.yaml`,
  location: (id: string) => `locations/${id}.yaml`,
  object: (id: string) => `objects/${id}.yaml`,
  faction: (id: string) => `factions/${id}.yaml`,

  worldRules: () => "world/rules.yaml",
  terminology: () => "world/terminology.yaml",

  timeline: () => "events/timeline.jsonl",
  canonFacts: () => "continuity/canon-facts.jsonl",
  plotContracts: () => "continuity/plot-contracts.jsonl",
  openLoops: () => "continuity/open-loops.yaml",
  retcons: () => "continuity/retcons.jsonl",
  findings: () => "continuity/findings.jsonl",

  sceneDelta: (scene: string) => `continuity/deltas/${scene}.json`,
  transcript: (role: AgentRole, runId: string) => `runtime/transcripts/${role}/${runId}.jsonl`,
  schema: (name: string) => `_schemas/${name}.schema.json`,
} as const;

/** Chapter id for a scene number, at `scenesPerChapter` scenes per chapter. */
export function chapterFor(sceneIndex: number, scenesPerChapter = 4): string {
  return `ch-${String(Math.floor((sceneIndex - 1) / scenesPerChapter) + 1).padStart(2, "0")}`;
}

/** Scene number from `s-013`, for chapter assignment and ordering. */
export function sceneIndexOf(sceneId: string): number {
  const n = Number.parseInt(sceneId.replace(/^s-/, ""), 10);
  if (!Number.isFinite(n)) throw new Error(`not a scene id: ${sceneId}`);
  return n;
}

/**
 * Schemas written to `_schemas/`.
 *
 * On disk for two readers: a human auditing the tree, and an agent that wants to
 * know the shape of a partition without being told. Enforcement lives in the
 * typed tools — a schema file an agent can edit is not a constraint — but the
 * two must agree, so the interesting fields are documented here with the reason
 * they exist rather than just their type.
 */
export const SCHEMAS: Readonly<Record<string, unknown>> = {
  "character-profile": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Character profile — identity only",
    description:
      "Attributes that do not vary with the story. Changing one is a retcon and " +
      "must be declared. Anything that changes as the plot moves (location, mood, " +
      "what they carry, what they know) belongs in state.jsonl or beliefs.jsonl.",
    type: "object",
    required: ["id", "name", "sketch"],
    properties: {
      id: { type: "string", pattern: "^char-[a-z0-9-]+$" },
      name: { type: "string" },
      sketch: { type: "string" },
      identity: {
        type: "object",
        description: "Stable traits: appearance, origin, profession, speech habits.",
        additionalProperties: { type: "string" },
      },
      provenance: {
        type: "object",
        description: "Scene that established each identity attribute.",
        additionalProperties: { type: "string" },
      },
    },
  },
  "state-entry": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "One state observation in a character's timeline",
    description:
      "Append-only. The current value of an attribute is the last entry for it, " +
      "so ordinary change needs no retcon — which is the whole point: a character " +
      "walking to another room is not a continuity error.",
    type: "object",
    required: ["scene", "attribute", "value", "quote"],
    properties: {
      scene: { type: "string", pattern: "^s-\\d{3,}$" },
      attribute: {
        type: "string",
        description:
          "From the controlled vocabulary (location, holds, mood, condition, " +
          "companions, goal). Free-form names produce one attribute per event and " +
          "a canon that never supersedes anything.",
      },
      value: { type: "string" },
      quote: { type: "string", description: "Verbatim prose that establishes it" },
    },
  },
  "belief-entry": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "What a character knows, and from when",
    description:
      "Most knowledge contradictions in generated fiction come from a character " +
      "using information the reader has but the character does not. Belief is " +
      "therefore tracked separately from truth: world/rules.yaml says what is so, " +
      "this says who has found out.",
    type: "object",
    required: ["scene", "proposition", "stance", "quote"],
    properties: {
      scene: { type: "string", pattern: "^s-\\d{3,}$" },
      proposition: { type: "string" },
      stance: { enum: ["knows", "suspects", "wrong-about", "ignorant-of"] },
      quote: { type: "string" },
    },
  },
  "relation-record": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Relation record — novelty 2",
    description:
      "An ordered sequence of possibly overlapping phases for one pair. Each phase " +
      "carries how it began (transition), an optional asymmetry because A's view of " +
      "B need not equal B's view of A, scene-level provenance with a line span, and " +
      "an optional supersedes that revises in place while leaving the superseded " +
      "phase readable.",
    type: "object",
    required: ["pairId", "participants", "phases"],
    properties: {
      pairId: { type: "string" },
      participants: { type: "array", items: { type: "string" }, minItems: 2, maxItems: 2 },
      phases: {
        type: "array",
        items: {
          type: "object",
          required: ["index", "relation", "fromScene", "transition", "source"],
          properties: {
            index: { type: "integer", minimum: 1 },
            relation: { type: "string" },
            fromScene: { type: "string" },
            toScene: { type: ["string", "null"] },
            transition: { type: "string" },
            asymmetry: { type: "string" },
            supersedes: { type: "integer" },
            source: {
              type: "object",
              required: ["scene", "span"],
              properties: { scene: { type: "string" }, span: { type: "string" } },
            },
          },
        },
      },
      openQuestions: { type: "array", items: { type: "string" } },
    },
  },
  "plot-contract": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "A promise the story has made to the reader",
    description:
      "Registered when made, never reconstructed at the end — an abandoned thread " +
      "is invisible in the finished text precisely because nothing refers to it.",
    type: "object",
    required: ["id", "promise", "scene", "quote"],
    properties: {
      id: { type: "string" },
      promise: { type: "string" },
      scene: { type: "string" },
      quote: { type: "string" },
      dueByScene: { type: ["string", "null"] },
      paidOffBy: { type: ["string", "null"] },
    },
  },
  "timeline-event": {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    title: "Something that happened, in story time",
    description:
      "Separate from character state on purpose. 'She crossed the quay' is a fact " +
      "about a moment; recording it as a property of her makes the next scene in " +
      "which she moves look like a contradiction.",
    type: "object",
    required: ["scene", "summary", "participants"],
    properties: {
      scene: { type: "string" },
      when: { type: "string", description: "Story time if stated, else null" },
      summary: { type: "string" },
      participants: { type: "array", items: { type: "string" } },
      location: { type: ["string", "null"] },
    },
  },
};

const HARNESS = `# Harness contract

This project directory **is** the state of the novel. Nothing that matters lives
only in a conversation: a session can be summarised away at any time, and
anything not written here is lost when that happens.

## Partitions

| Path | Holds | Who writes |
|---|---|---|
| \`novel/outline/\` | premise, logline, beats, arcs, rhythm | index-manager |
| \`novel/chapters/<ch>/scenes/<s>.md\` | the prose | index-manager, on commit |
| \`characters/<id>/profile.yaml\` | identity — changing it is a retcon | index-manager |
| \`characters/<id>/state.jsonl\` | state timeline — current value is the last entry | index-manager |
| \`characters/<id>/beliefs.jsonl\` | what they know, and from when | index-manager |
| \`relations/<pair>.yaml\` | one pair's ordered relation phases | index-manager |
| \`events/timeline.jsonl\` | chronology | index-manager |
| \`locations/\` \`objects/\` \`factions/\` | other entities | index-manager |
| \`world/rules.yaml\` | what is true regardless of who knows it | index-manager |
| \`continuity/\` | canon facts, promises, open loops, retcons, findings | index-manager |
| \`.<role>/memory/\` | how that role works better here | that role |
| \`.<role>/skills/\` | reusable procedure | that role |
| \`staging/<txid>/\` | work in progress | anyone |
| \`runtime/\` | ledger, transcripts, evicted tool payloads | the engine |

## Two rules that are enforced, not requested

**Only index-manager writes outside \`staging/\` and its own dot-directory.**
Every other write is refused with the actor named.

**State and identity are different things.** A character's location, mood, what
they carry and where they are going change as the story moves: they are appended
to \`state.jsonl\` and the newest entry wins. Their name, eye colour and origin do
not: those live in \`profile.yaml\` and changing one requires declaring a retcon.
Confusing the two is how a story where someone walks across a room becomes a
continuity failure.

## Reading

Read with the shell — \`grep\`, \`ls\`, \`sed\` — and read as much as you need. The
index is the cheap thing; guessing is the expensive thing. Facts you assert must
name the file they came from.
`;

export interface InitOptions {
  readonly premise: string;
  readonly title?: string;
  readonly targetWords: number;
  /** Where the role prompts are read from, to be copied into the project. */
  readonly agentsRoot?: string;
  readonly roles?: readonly AgentRole[];
}

/**
 * Create the tree.
 *
 * Idempotent: re-initialising an existing project adds what is missing and
 * overwrites nothing that an agent may have written. Resuming a run must not
 * silently reset the story.
 */
export async function initialiseProject(
  root: string,
  options: InitOptions,
): Promise<{ readonly created: readonly string[] }> {
  const created: string[] = [];
  const roles = options.roles ?? AGENT_ROLES;

  const ensureDir = async (rel: string) => {
    await mkdir(path.join(root, rel), { recursive: true });
    created.push(`${rel}/`);
  };
  const ensureFile = async (rel: string, content: string) => {
    const full = path.join(root, rel);
    await mkdir(path.dirname(full), { recursive: true });
    try {
      await readFile(full, "utf8");
      return; // already there; leave whatever is in it alone
    } catch {
      await writeFile(full, content, "utf8");
      created.push(rel);
    }
  };

  for (const partition of PARTITIONS) await ensureDir(partition);

  for (const role of roles) {
    await ensureDir(`${paths.agentDir(role)}/memory`);
    await ensureDir(`${paths.agentDir(role)}/skills`);
    await ensureDir(`runtime/transcripts/${role}`);
    await ensureFile(paths.memoryIndex(role), "# Memory index\n\n(empty)\n");
    if (options.agentsRoot) {
      // Copied rather than referenced: the project should stay readable and
      // replayable after the repo moves on, and a run whose prompts changed
      // underneath it cannot be explained afterwards.
      try {
        const own = await readFile(path.join(options.agentsRoot, role, "AGENT.md"), "utf8");
        const shared = await readFile(path.join(options.agentsRoot, "SHARED.md"), "utf8");
        await ensureFile(paths.agentPrompt(role), `${shared.trim()}\n\n---\n\n${own.trim()}\n`);
      } catch {
        // A missing prompt is the caller's problem to notice, not ours to invent.
      }
    }
  }

  await ensureFile(paths.harness(), HARNESS);
  await ensureFile(paths.premise(), `${options.premise.trim()}\n`);
  await ensureFile(
    "config/project.yaml",
    `title: ${options.title ?? "untitled"}\ntarget_words: ${options.targetWords}\n` +
      `created_at: ${new Date().toISOString()}\n`,
  );
  await ensureFile(
    paths.rhythm(),
    // Rhythm as a file rather than a vibe: the brief asked for "反复的起承转合",
    // and the only version of that a machine can check is a target curve and an
    // observed one side by side.
    "scene,chapter,beat,tension_target,tension_actual,note\n",
  );
  await ensureFile(paths.openLoops(), "loops: []\n");
  await ensureFile(paths.terminology(), "terms: {}\n");
  await ensureFile(
    paths.voice(),
    "# Voice\n\n(Established by the first committed scenes; the writer may propose changes.)\n",
  );

  for (const rel of LEDGER_FILES) await ensureFile(rel, "");
  for (const [name, schema] of Object.entries(SCHEMAS)) {
    await ensureFile(paths.schema(name), `${JSON.stringify(schema, null, 2)}\n`);
  }

  return { created };
}

/** Every partition directory that exists, for an audit of what a run produced. */
export async function partitionReport(
  root: string,
): Promise<Readonly<Record<string, number>>> {
  const out: Record<string, number> = {};
  for (const partition of PARTITIONS) {
    try {
      const entries = await readdir(path.join(root, partition), { withFileTypes: true });
      out[partition] = entries.filter((e) => e.isFile() || e.isDirectory()).length;
    } catch {
      out[partition] = -1; // absent, which is a defect worth seeing rather than a zero
    }
  }
  return out;
}
