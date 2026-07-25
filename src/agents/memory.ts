/**
 * Agent memory: what a role learns about doing its job, kept across compaction.
 *
 * Residency and compaction pull against each other. Residency is the point —
 * the verifier should remember that it already argued about this character's
 * eye colour, the writer should keep the voice it established. Compaction is
 * what makes residency affordable, and it works by throwing that transcript
 * away. Without somewhere durable to put the lessons, a longer context budget
 * only postpones the loss: at scene 30 the agent is fluent, at scene 31 it has
 * been summarised back into a stranger.
 *
 * Memory is that durable place, and the boundary around it is the whole design:
 *
 * **Only "how this role works better" goes here.** A verifier calibration
 * against a known false positive, a writer style note the verifier already
 * approved, a convention about how this project names things. Never a story
 * fact. Story state lives in the index, where it is schema-checked, has
 * provenance, and can be contradicted by a verifier that reads it. A fact that
 * lives in memory instead is a second source of truth that nothing audits — and
 * it will be wrong eventually, silently, in a run nobody re-reads.
 *
 * That rule is enforced in code rather than asked for in a prompt: a write
 * mentioning a known entity id is rejected with the id named. It costs the
 * agent one turn and it costs us nothing.
 *
 * **`MEMORY.md` is an index, not the memories.** One pointer per line, capped,
 * loaded into the system prompt so an agent always knows what it knows. The
 * bodies are separate files read on demand, so knowing that a lesson exists
 * costs a line and reading it costs a tool call.
 *
 * **Lessons expire.** Each topic carries when it was last verified and may
 * carry an expiry. A calibration note from a prompt version that no longer
 * exists is worse than no note, because it reads exactly as authoritative.
 */

import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRole } from "../transaction/types.ts";

/**
 * What kind of lesson this is. Both are about work, never about the story —
 * the enum exists so that "there is no scope for story facts" is visible at
 * the call site rather than only in a comment.
 */
export type MemoryScope = "role-craft" | "project-convention";

export const MEMORY_SCOPES: readonly MemoryScope[] = ["role-craft", "project-convention"];

/** `MEMORY.md` limits, from the architecture: an index has to stay skimmable. */
export const INDEX_MAX_LINES = 200;
export const INDEX_MAX_BYTES = 25_000;
/** A memory longer than this is a document; it belongs in the index or a skill. */
export const BODY_MAX_CHARS = 6_000;

export interface MemoryWrite {
  /** File stem, so it is greppable and stable across rewrites of the same lesson. */
  readonly topic: string;
  readonly title: string;
  /** The one line that appears in the index. It is what makes an agent open the file. */
  readonly hook: string;
  readonly body: string;
  readonly scope: MemoryScope;
  /** Where the lesson came from — a scene, a finding, a rejected draft. */
  readonly source: string;
  /** Omit for a lesson with no natural shelf life. */
  readonly expiresInDays?: number;
}

export interface StoredMemory extends Omit<MemoryWrite, "expiresInDays"> {
  readonly lastVerifiedAt: string;
  readonly expiresAt: string | null;
  readonly file: string;
}

export interface MemoryProblem {
  readonly path: string;
  readonly problem: string;
}

const TOPIC_PATTERN = /^[a-z0-9][a-z0-9-]{1,48}$/;

/**
 * Validate a proposed memory, returning every problem at once.
 *
 * All of them, not the first: a tool that reports one field per round trip
 * turns a three-field mistake into three turns, and the agent has no way to
 * know the second problem exists until it has fixed the first.
 */
export function memoryProblems(
  input: Partial<MemoryWrite>,
  knownEntityIds: readonly string[] = [],
): readonly MemoryProblem[] {
  const problems: MemoryProblem[] = [];

  if (!input.topic || !TOPIC_PATTERN.test(input.topic)) {
    problems.push({
      path: "topic",
      problem:
        "must be a lowercase slug like `false-positive-metaphor`, 2–49 characters. " +
        "It is the filename, and reusing an existing topic updates that lesson in place.",
    });
  }
  if (!input.title?.trim()) {
    problems.push({ path: "title", problem: "required" });
  } else if (input.title.length > 80 || input.title.includes("\n")) {
    problems.push({
      path: "title",
      problem: "must be a single line of at most 80 characters; it is an index entry",
    });
  }
  if (!input.hook?.trim()) {
    problems.push({
      path: "hook",
      problem:
        "required: the index shows only this line, so it has to be enough to decide " +
        "whether to open the file",
    });
  } else if (input.hook.length > 140 || input.hook.includes("\n")) {
    problems.push({ path: "hook", problem: "must be a single line of at most 140 characters" });
  }
  if (!input.body?.trim()) {
    problems.push({ path: "body", problem: "required" });
  } else if (input.body.length > BODY_MAX_CHARS) {
    problems.push({
      path: "body",
      problem: `at most ${BODY_MAX_CHARS} characters; anything longer is a document, not a lesson`,
    });
  }
  if (!input.scope || !MEMORY_SCOPES.includes(input.scope)) {
    problems.push({
      path: "scope",
      problem: `must be one of: ${MEMORY_SCOPES.join(", ")}`,
    });
  }
  if (!input.source?.trim()) {
    problems.push({
      path: "source",
      problem: "required: a lesson whose origin is unknown cannot be re-checked when it goes stale",
    });
  }
  if (input.expiresInDays !== undefined && !(input.expiresInDays > 0)) {
    problems.push({ path: "expires_in_days", problem: "must be a positive number of days" });
  }

  const mentioned = storyStateMentions(input, knownEntityIds);
  if (mentioned.length > 0) {
    problems.push({
      path: "body",
      problem:
        `mentions story entities (${mentioned.join(", ")}). Memory is for how you work, not ` +
        `for what is true in the story — facts belong in the index, where they are ` +
        `schema-checked, carry provenance, and can be contradicted by a verifier that reads ` +
        `them. Rewrite the lesson so it holds for any scene, or record it as a state delta ` +
        `instead.`,
    });
  }

  return problems;
}

/** Entity and scene ids appearing anywhere in a proposed memory. */
function storyStateMentions(
  input: Partial<MemoryWrite>,
  knownEntityIds: readonly string[],
): readonly string[] {
  const haystack = `${input.title ?? ""}\n${input.hook ?? ""}\n${input.body ?? ""}`.toLowerCase();
  const hits = new Set<string>();
  for (const id of knownEntityIds) {
    const needle = id.toLowerCase();
    if (needle.length >= 3 && haystack.includes(needle)) hits.add(id);
  }
  for (const scene of haystack.match(/\bs-\d{3}\b/g) ?? []) hits.add(scene);
  return [...hits];
}

function frontmatter(memory: StoredMemory): string {
  return [
    "---",
    `title: ${memory.title}`,
    `hook: ${memory.hook}`,
    `scope: ${memory.scope}`,
    `source: ${memory.source}`,
    `last_verified_at: ${memory.lastVerifiedAt}`,
    ...(memory.expiresAt ? [`expires_at: ${memory.expiresAt}`] : []),
    "---",
    "",
  ].join("\n");
}

function parse(file: string, text: string): StoredMemory | null {
  const match = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (!match) return null;
  const fields = new Map<string, string>();
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(":");
    if (at > 0) fields.set(line.slice(0, at).trim(), line.slice(at + 1).trim());
  }
  const scope = fields.get("scope") as MemoryScope | undefined;
  return {
    topic: file.replace(/\.md$/, ""),
    file,
    title: fields.get("title") ?? file,
    hook: fields.get("hook") ?? "",
    scope: scope && MEMORY_SCOPES.includes(scope) ? scope : "role-craft",
    source: fields.get("source") ?? "unknown",
    lastVerifiedAt: fields.get("last_verified_at") ?? "",
    expiresAt: fields.get("expires_at") ?? null,
    body: text.slice(match[0].length),
  };
}

export class MemoryError extends Error {}

/**
 * One role's memory directory.
 *
 * `MEMORY.md` is regenerated from the topic files on every write rather than
 * appended to. An index that is edited independently of what it indexes drifts,
 * and a drifted index is worse than none: it tells an agent a lesson exists
 * that it cannot open, or hides one it needs.
 */
export class AgentMemory {
  readonly #dir: string;
  readonly #now: () => number;
  readonly #knownEntities: () => readonly string[];

  constructor(options: {
    /** Usually `<project>/agents`; each role gets a subdirectory under it. */
    readonly root: string;
    readonly role: AgentRole;
    readonly now?: () => number;
    /** Read fresh each time: the entity list grows while the story is written. */
    readonly knownEntities?: () => readonly string[];
  }) {
    this.#dir = path.join(options.root, options.role, "memory");
    this.#now = options.now ?? (() => Date.now());
    this.#knownEntities = options.knownEntities ?? (() => []);
  }

  get dir(): string {
    return this.#dir;
  }

  async write(input: MemoryWrite): Promise<StoredMemory> {
    const problems = memoryProblems(input, this.#knownEntities());
    if (problems.length > 0) {
      throw new MemoryError(problems.map((p) => `${p.path}: ${p.problem}`).join("\n"));
    }
    const now = new Date(this.#now());
    const stored: StoredMemory = {
      topic: input.topic,
      file: `${input.topic}.md`,
      title: input.title.trim(),
      hook: input.hook.trim(),
      body: input.body.trim(),
      scope: input.scope,
      source: input.source.trim(),
      lastVerifiedAt: now.toISOString(),
      expiresAt: input.expiresInDays
        ? new Date(now.getTime() + input.expiresInDays * 86_400_000).toISOString()
        : null,
    };
    await mkdir(this.#dir, { recursive: true });
    await writeFile(
      path.join(this.#dir, stored.file),
      `${frontmatter(stored)}${stored.body}\n`,
      "utf8",
    );
    await this.refreshIndex();
    return stored;
  }

  /** One topic in full, or null. Null is a real answer, not a reason to guess. */
  async read(topic: string): Promise<StoredMemory | null> {
    if (!TOPIC_PATTERN.test(topic)) return null;
    try {
      const text = await readFile(path.join(this.#dir, `${topic}.md`), "utf8");
      return parse(`${topic}.md`, text);
    } catch {
      return null;
    }
  }

  /** Everything on disk, newest verification first, expired entries flagged. */
  async all(): Promise<readonly StoredMemory[]> {
    let files: string[];
    try {
      files = (await readdir(this.#dir)).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
    } catch {
      return [];
    }
    const out: StoredMemory[] = [];
    for (const file of files.sort()) {
      const parsed = parse(file, await readFile(path.join(this.#dir, file), "utf8"));
      if (parsed) out.push(parsed);
    }
    return out.sort((a, b) => b.lastVerifiedAt.localeCompare(a.lastVerifiedAt));
  }

  #expired(memory: StoredMemory): boolean {
    return memory.expiresAt !== null && Date.parse(memory.expiresAt) <= this.#now();
  }

  /** Memories still in force, most recently verified first. */
  async live(): Promise<readonly StoredMemory[]> {
    return (await this.all()).filter((m) => !this.#expired(m));
  }

  /**
   * The index as it goes into the system prompt.
   *
   * Expired topics are dropped rather than shown struck through: a stale
   * calibration reads exactly as authoritative as a current one, and an agent
   * that can see it will use it. The file stays on disk for the audit trail.
   */
  async renderIndex(): Promise<string> {
    const live = await this.live();
    if (live.length === 0) return "";

    const lines: string[] = [];
    let bytes = 0;
    let dropped = 0;
    for (const memory of live) {
      const line = `- [${memory.title}](${memory.file}) — ${memory.hook}`;
      // Bytes, not characters: the cap is a size on disk and in the prompt, and
      // titles are prose, so a character count is an undercount by a third.
      const size = Buffer.byteLength(line) + 1;
      if (lines.length >= INDEX_MAX_LINES || bytes + size > INDEX_MAX_BYTES) {
        dropped += 1;
        continue;
      }
      lines.push(line);
      bytes += size;
    }
    if (dropped > 0) {
      lines.push(
        `- (${dropped} older topic(s) not indexed — grep ${this.#dir} if you need them)`,
      );
    }
    return lines.join("\n");
  }

  /** Rewrite `MEMORY.md` from the topic files. Called after every write. */
  async refreshIndex(): Promise<string> {
    const index = await this.renderIndex();
    await mkdir(this.#dir, { recursive: true });
    await writeFile(
      path.join(this.#dir, "MEMORY.md"),
      index ? `# Memory index\n\n${index}\n` : "# Memory index\n\n(empty)\n",
      "utf8",
    );
    return index;
  }
}

/**
 * The memory section appended to a role's system prompt.
 *
 * Written as instructions plus the current index, because an index with no
 * instruction produces two failure modes at once: agents that never write, and
 * agents that write the plot into it.
 */
export function memorySection(index: string): string {
  return [
    "## Your memory",
    "",
    "You keep notes across this whole story about **how to do your job better here** —",
    "a false positive you were talked out of, a convention this project follows, a",
    "phrasing your reviewer kept rejecting. Write one with `remember`; open one with",
    "`read_memory`. Reusing a topic name updates that lesson in place.",
    "",
    "Story facts never go here. They go in the index, where they are checked and have",
    "provenance; a fact in memory is a second source of truth that nobody audits.",
    "Writes that mention story entities are rejected.",
    "",
    "Your conversation will be summarised when it grows too long. Anything you want to",
    "keep past that point has to be in memory or in the index before then.",
    "",
    index ? `### What you have learnt so far\n\n${index}` : "### What you have learnt so far\n\n(nothing yet)",
  ].join("\n");
}
