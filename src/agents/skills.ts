/**
 * Skills: procedure a role can look up, as distinct from memory it has learnt.
 *
 * The brief put both under each worker's dot-directory and drew the line between
 * them clearly: *"以及如果有有用的可以写到skills/下面"*, alongside "写入memory.md".
 * They are not the same thing and collapsing them loses something in each
 * direction:
 *
 * - **Memory** is what this agent found out on this project — a false positive it
 *   was talked out of, a phrasing its reviewer kept rejecting. Small, indexed,
 *   expiring, always in view.
 * - **A skill** is a procedure that is correct independently of what happened
 *   here — how to audit a promise, how to extract canon from a scene, how to run
 *   a copyedit pass. Larger, stable, and *not* always in view: only its name and
 *   description are loaded, and the body arrives when it is invoked.
 *
 * That loading discipline is the whole design. Twelve procedures fully expanded
 * is tens of thousands of tokens in every single turn, most of them irrelevant to
 * the scene at hand. A one-line description costs about twenty tokens and lets
 * the agent decide. It is the same trade as `MEMORY.md` being an index rather than
 * the memories, and the same trade Claude Code makes for the same reason.
 *
 * **A skill never escalates permissions.** It may say "read the plot contracts";
 * it may not grant the ability to write them. Procedure and authority are
 * separate, and a system where writing a file can widen your own access has no
 * meaningful access control at all.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRole } from "../transaction/types.ts";

export interface SkillFrontmatter {
  readonly name: string;
  readonly description: string;
  /** Optional list of tool names the procedure uses, for documentation only. */
  readonly uses?: readonly string[];
}

export interface Skill extends SkillFrontmatter {
  /** Directory name, which is how it is invoked. */
  readonly slug: string;
  readonly body: string;
}

export class SkillError extends Error {}

const NAME_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;

/** Parse `SKILL.md`: frontmatter, then the procedure. */
export function parseSkill(slug: string, text: string): Skill {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) {
    throw new SkillError(
      `${slug}/SKILL.md has no frontmatter. It needs at least name and description — ` +
        `the description is all that is loaded until the skill is invoked, so a skill ` +
        `without one can never be found.`,
    );
  }
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const name = fields.get("name") ?? slug;
  const description = fields.get("description") ?? "";
  if (!description) throw new SkillError(`${slug}/SKILL.md needs a description`);
  const uses = fields.get("uses");
  return {
    slug,
    name,
    description,
    ...(uses ? { uses: uses.split(",").map((u) => u.trim()).filter(Boolean) } : {}),
    body: text.slice(match[0].length),
  };
}

export function serialiseSkill(skill: Omit<Skill, "slug">): string {
  return [
    "---",
    `name: ${skill.name}`,
    `description: ${skill.description}`,
    ...(skill.uses?.length ? [`uses: ${skill.uses.join(", ")}`] : []),
    "---",
    "",
    skill.body.trim(),
    "",
  ].join("\n");
}

/**
 * One role's skill library.
 *
 * Rooted under the role's dot-directory, so a skill the writer wrote is the
 * writer's — a shared library would let one role's procedure quietly change how
 * another behaves, and nothing in a run would show it.
 */
export class SkillLibrary {
  readonly #dir: string;

  constructor(options: { readonly root: string; readonly role: AgentRole }) {
    this.#dir = path.join(options.root, `.${options.role}`, "skills");
  }

  get dir(): string {
    return this.#dir;
  }

  /** Every skill, with bodies. Used for the index and by `read_skill`. */
  async all(): Promise<readonly Skill[]> {
    let entries: string[];
    try {
      entries = (await readdir(this.#dir, { withFileTypes: true }))
        .filter((e) => e.isDirectory())
        .map((e) => e.name);
    } catch {
      return [];
    }
    const skills: Skill[] = [];
    for (const slug of entries.sort()) {
      try {
        skills.push(parseSkill(slug, await readFile(path.join(this.#dir, slug, "SKILL.md"), "utf8")));
      } catch {
        // A malformed skill is skipped rather than fatal: one bad file must not
        // stop a run, and the agent will notice it is not in the index.
      }
    }
    return skills;
  }

  async read(slug: string): Promise<Skill | null> {
    if (!NAME_PATTERN.test(slug)) return null;
    try {
      return parseSkill(slug, await readFile(path.join(this.#dir, slug, "SKILL.md"), "utf8"));
    } catch {
      return null;
    }
  }

  async write(input: {
    readonly slug: string;
    readonly name: string;
    readonly description: string;
    readonly body: string;
    readonly uses?: readonly string[];
  }): Promise<void> {
    if (!NAME_PATTERN.test(input.slug)) {
      throw new SkillError(`slug must be a lowercase slug like promise-payoff-audit`);
    }
    if (!input.description.trim()) throw new SkillError("description is required");
    if (!input.body.trim()) throw new SkillError("body is required");
    const dir = path.join(this.#dir, input.slug);
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      serialiseSkill({
        name: input.name || input.slug,
        description: input.description,
        body: input.body,
        ...(input.uses ? { uses: input.uses } : {}),
      }),
      "utf8",
    );
  }
}

/**
 * The skills section of a system prompt: names and descriptions only.
 *
 * The token cost of this section is what makes the whole mechanism worth having,
 * so it is bounded by construction — one line each — rather than by hoping the
 * bodies stay short.
 */
export function skillsSection(skills: readonly Skill[]): string {
  if (skills.length === 0) {
    return [
      "## Your skills",
      "",
      "You have none recorded yet. When you work out a procedure that will be right again",
      "next time — how to audit something, what order to check things in — write it with",
      "`write_skill`. Skills are procedure; `remember` is for what you learnt about this",
      "particular project.",
    ].join("\n");
  }
  return [
    "## Your skills",
    "",
    "Names and one-line descriptions only. Open one with `read_skill` when it applies —",
    "the body is not in this prompt because most of them are irrelevant to any given scene.",
    "",
    ...skills.map((s) => `- \`${s.slug}\` — ${s.description}`),
  ].join("\n");
}

/**
 * Starter skills, written into the project at initialisation.
 *
 * These exist because an empty library is a mechanism nobody uses: the first
 * agent to face a promise audit will improvise one rather than write one down.
 * Each is a procedure, contains no story state, and grants no authority — the
 * `uses` line documents which tools the procedure calls, it does not confer them.
 */
export const STARTER_SKILLS: Readonly<Record<AgentRole, readonly Omit<Skill, "slug">[]>> = {
  writer: [
    {
      name: "scene-drafting",
      description: "How to turn a context packet into a scene without inventing constraints",
      uses: ["run_command", "write_staged_scene", "propose_state_delta"],
      body: `1. Read the P0 block first and list the constraints you must not break.
2. Check the belief section for every character present: what they know bounds what
   they may say. Most knowledge contradictions come from a character using
   something the reader knows and they do not.
3. If a hard constraint is missing or contradictory, say so instead of inferring it.
4. Write the scene. Aim for the target length; overshooting is not free, because
   every word is also a word the verifier reads.
5. Stage the prose, then declare state. State is what is now *true*, not what
   happened — the prose already narrates what happened.`,
    },
    {
      name: "repair-response",
      description: "How to answer findings without rewriting a scene that was mostly right",
      uses: ["run_command", "write_staged_scene"],
      body: `1. Read each finding's editLocus before changing anything. \`canon\` means the
   index is stale and the draft may be right; \`draft\` means the prose is wrong;
   \`unresolved\` means someone has to decide.
2. Fix the quoted span. Do not rewrite the scene: a wholesale rewrite trades a
   known defect for an unknown one, and the evidence is that it does not converge.
3. If you disagree with a finding, say why in your reply rather than complying
   silently. A verifier that is wrong and unchallenged will be wrong again.
4. If the same finding comes back unchanged, stop and escalate. Another attempt
   buys the same draft.`,
    },
  ],
  verifier: [
    {
      name: "continuity-audit",
      description: "Order to check a draft in, cheapest and most certain first",
      uses: ["run_command"],
      body: `1. Names and references: does every entity named exist in the index?
2. Explicit pairs: does the draft assert something the index already contradicts?
   Quote both sides or you have a suspicion, not a finding.
3. Belief boundaries: does anyone use knowledge their beliefs file does not give
   them yet?
4. Space and time: can the movements in this scene actually be performed in the
   stated order and place?
5. Only then judgement: motivation, causality, pacing.

Literary technique is not a defect. Metaphor, irony, unreliable narration and
deliberate ambiguity all read as contradictions to a literal check. When a
passage admits both readings, take the literary one — a false positive costs a
repair round and a worse scene, a false negative costs one flaw in a novel.`,
    },
    {
      name: "promise-payoff-audit",
      description: "How to judge whether an open promise is abandoned or merely open",
      uses: ["run_command"],
      body: `Read \`continuity/plot-contracts.jsonl\`. For each unpaid promise ask:

1. Is its due-by scene already written? Then it is late, not open.
2. Has anything referred to it since it was made? A thread nobody has touched for
   many scenes is drifting even if it is not yet due.
3. At scene level an unpaid promise is never an error — it is an open loop, and
   the story is not finished. Report it as a warning or not at all.`,
    },
  ],
  "index-manager": [
    {
      name: "canon-extraction",
      description: "How to fold a committed scene into every partition it touched",
      uses: ["append_state", "append_beliefs", "record_relation_phase", "append_event"],
      body: `Work through the partitions in this order, because each answers a different
question and it is easy to conflate them:

1. **Identity** — did we learn something that does not change? Only then upsert_character.
2. **State** — where is everyone now, what do they hold, what do they intend?
3. **Belief** — who found something out, and what are they still wrong about?
4. **Relations** — did this scene change what two people are to each other? If so
   the transition text must say *how it began*, not just the new label.
5. **Events** — what happened, in story time.
6. **Rhythm** — where did this scene sit on the tension curve, against the plan?
7. **Promises** — anything newly promised, anything paid off.

If you find yourself wanting a state attribute that is not in the vocabulary, what
you have is an event. File it in step 5.`,
    },
  ],
  "context-builder": [
    {
      name: "packet-assembly",
      description: "What to search for when building a scene's context, and in what order",
      uses: ["run_command", "read_relation_history"],
      body: `Priority order, not similarity order. Nothing in P0 or P1 may be displaced by
something that merely looks relevant.

1. P0 — the scene card, the world rules, the reveal limits, the base revision.
2. P1 — for every present entity: identity, current state, beliefs as of this scene.
   Use \`read_relation_history\` for pairs who are both present; the phase
   transitions are what a label cannot carry.
3. P2 — the previous scene verbatim, plus any promise due here.
4. P3 — remote recall: grep for the entity ids in earlier scenes.
5. P4 — background, if there is room.

If a hard-required id does not resolve, fail the build and say which. Letting the
writer infer a constraint is how a scene gets rejected three attempts later.`,
    },
  ],
  orchestrator: [
    {
      name: "story-architecture",
      description: "How to turn a premise into scene cards that a single call can write",
      uses: ["submit_plan", "update_plan"],
      body: `1. Derive scene count from the target length, not from the shape of the plot: a
   scene is what one call writes well, around a thousand words.
2. Give every character, location and significant object a stable id now. Later
   scenes can only refer to entities that exist.
3. State world rules as truths, and remember they are not knowledge — if the story
   is about someone discovering one, the plan must not let scene 1 hand it to them.
4. Plan the tension curve, not just the events. A story is repeated rise and
   release; write the intended beat into each scene card.
5. Revise the plan when the prose teaches you something, and only ahead of the
   write head. Committed scenes are on the page and later ones were built on them.`,
    },
  ],
};

/** Write the starter library for a role, skipping any that already exist. */
export async function installStarterSkills(
  root: string,
  role: AgentRole,
): Promise<readonly string[]> {
  const library = new SkillLibrary({ root, role });
  const installed: string[] = [];
  for (const skill of STARTER_SKILLS[role] ?? []) {
    const slug = skill.name;
    if (await library.read(slug)) continue;
    await library.write({ ...skill, slug });
    installed.push(slug);
  }
  return installed;
}
