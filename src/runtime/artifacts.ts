/**
 * Artefacts as paths, not as inlined strings.
 *
 * Every hand-off in this system used to be a string passed through a function
 * argument: the packet went into the writer's prompt, the prose went into the
 * verifier's prompt, the delta went into the index-manager's prompt. It worked,
 * and it cost two things that are only obvious once you look for them.
 *
 * **The orchestrator could not see any of it.** It planned, and then every
 * artefact of every scene existed only inside a call frame it was not part of.
 * Asking it to decide whether the outline needs revising, when the only thing
 * it has ever seen is the outline it wrote, is asking it to decide from
 * nothing. An artefact on disk is an artefact it can read.
 *
 * **A follow-up had nowhere to land.** The writer could ask the builder a
 * question and get a string back, but the answer belonged to the same packet
 * the question was about, and there was no packet — only a prompt that had
 * already been sent. With a file, the builder appends and the writer re-reads,
 * which is what the brief described.
 *
 * These live under the roles' own dot-directories rather than in a shared
 * `runtime/` bucket, because whose work an artefact is matters: the packet is
 * the builder's output and its history, the audit is the verifier's. It also
 * means the write stays inside the one directory each role is allowed to write
 * to, so nothing here weakens the rule that only index-manager touches canon.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { chapterFor, sceneIndexOf } from "../index/tree.ts";

/**
 * Where each artefact lives.
 *
 * The builder's packets are filed by chapter, as the brief asked
 * (*"history/chapter1/01.md"*), because that is the axis along which someone
 * looking for one actually searches: the packets for a chapter are the record
 * of what that chapter was written against.
 */
export const artifactPaths = {
  /** The packet the builder assembled, and appends follow-up answers to. */
  packet: (sceneId: string) =>
    `.context-builder/history/${chapterFor(sceneIndexOf(sceneId))}/${sceneId}.md`,
  /** The staged draft, before it is committed as canon. */
  draft: (sceneId: string) => `.writer/drafts/${sceneId}.md`,
  /** The declared state delta, staged alongside the draft. */
  draftDelta: (sceneId: string) => `.writer/drafts/${sceneId}.delta.json`,
  /** The verifier's audit of one attempt. */
  audit: (sceneId: string, attempt: number) =>
    `.verifier/audits/${sceneId}-a${attempt}.md`,
  /** The orchestrator's own record of how a scene went. */
  sceneLog: (sceneId: string) => `.orchestrator/scenes/${sceneId}.md`,
  /** The whole-story revision plan, so the revision phase has something to read. */
  revisionPlan: () => ".orchestrator/revision-plan.md",
} as const;

/**
 * Read and write under the project root, by relative path.
 *
 * Deliberately not `CanonicalIndex`: these are working artefacts, not canon.
 * Routing them through the commit path would mean either relaxing its
 * requirement that prose and delta land together, or committing a packet as
 * though it were part of the novel. Both are worse than a plain write to a
 * directory the harness contract already marks as that role's own.
 */
export class ArtifactStore {
  readonly #root: string;

  constructor(root: string) {
    this.#root = path.resolve(root);
  }

  #resolve(relPath: string): string {
    const full = path.resolve(this.#root, relPath);
    if (path.relative(this.#root, full).startsWith("..")) {
      throw new Error(`refusing to write outside the project root: ${relPath}`);
    }
    return full;
  }

  async write(relPath: string, content: string): Promise<string> {
    const full = this.#resolve(relPath);
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content, "utf8");
    return relPath;
  }

  /**
   * Append to an existing artefact, creating it if absent.
   *
   * This is what makes a follow-up round work: the answer joins the packet it
   * belongs to instead of arriving as a detached string, so the writer's whole
   * material is still one document it can re-read.
   */
  async append(relPath: string, content: string): Promise<string> {
    const existing = await this.read(relPath);
    return this.write(relPath, existing === null ? content : `${existing}\n${content}`);
  }

  /** The contents, or null when it has not been written. Absence is an answer. */
  async read(relPath: string): Promise<string | null> {
    try {
      return await readFile(this.#resolve(relPath), "utf8");
    } catch {
      return null;
    }
  }
}

/** A follow-up exchange, rendered for appending to the packet it belongs to. */
export function renderFollowUp(input: {
  readonly round: number;
  readonly question: string;
  readonly answer: string;
}): string {
  return [
    "",
    `## Follow-up ${input.round}`,
    "",
    `**Writer asked:** ${input.question}`,
    "",
    input.answer,
    "",
  ].join("\n");
}

/**
 * The audit, as a document the writer can be pointed at.
 *
 * Rendered rather than dumped as JSON because the reader is the writer, and the
 * repair brief has always been prose for exactly that reason. What the file
 * adds over the brief is that it survives the turn: the writer can re-read it
 * mid-repair, and the orchestrator can see what the scene was sent back for
 * without having been in the room.
 */
export function renderAudit(input: {
  readonly sceneId: string;
  readonly attempt: number;
  readonly blocking: number;
  readonly warnings: number;
  readonly brief: string;
}): string {
  return [
    `# Audit — ${input.sceneId}, attempt ${input.attempt}`,
    "",
    `Blocking: ${input.blocking}. Warnings: ${input.warnings}.`,
    "",
    input.blocking === 0 && input.warnings === 0
      ? "No defects found."
      : input.brief,
    "",
  ].join("\n");
}
