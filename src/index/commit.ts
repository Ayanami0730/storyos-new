/**
 * Atomic commit into the canonical filesystem index.
 *
 * Canonical state is the filesystem (docs/02-architecture.md §3). Prose and the
 * state delta must land together or not at all, which on a filesystem means:
 * write everything into a staging directory, fsync it, then rename each file
 * into place, then fsync the parent directories. A crash before the first
 * rename leaves the index untouched; a crash during renames leaves a partial
 * index, so the commit records an intent file first and recovery replays it.
 *
 * Only this module writes to the canonical tree, and only `index-manager` may
 * call it — the caller is asserted rather than trusted, because v2 spread the
 * write path across modules and lost track of who could mutate state.
 */

import { createHash } from "node:crypto";
import { closeSync, openSync, fsyncSync } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { AgentRole } from "../transaction/types.ts";

export interface FileWrite {
  /** Path relative to the index root. */
  readonly relPath: string;
  readonly content: string;
}

export interface CommitRequest {
  readonly txid: string;
  readonly sceneId: string;
  /** The commit this change was computed against. */
  readonly baseCommitId: string;
  readonly prose: FileWrite;
  readonly stateDelta: readonly FileWrite[];
  readonly actor: AgentRole;
}

export interface CommitResult {
  readonly commitId: string;
  readonly baseCommitId: string;
  readonly writtenPaths: readonly string[];
  readonly at: string;
}

export class CommitRefused extends Error {
  readonly code: "WRONG_ACTOR" | "STALE_BASE" | "EMPTY_DELTA" | "PATH_ESCAPE";
  constructor(code: CommitRefused["code"], message: string) {
    super(message);
    this.name = "CommitRefused";
    this.code = code;
  }
}

const HEAD = "HEAD";
const INTENT = "commit-intent.json";

function digest(parts: readonly string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\0");
  return h.digest("hex").slice(0, 16);
}

/** fsync a directory so a rename is durable, not just visible. */
function fsyncDir(dir: string): void {
  const fd = openSync(dir, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function assertInsideRoot(root: string, relPath: string): string {
  const resolved = path.resolve(root, relPath);
  const rel = path.relative(root, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new CommitRefused(
      "PATH_ESCAPE",
      `refusing to write outside the index root: ${relPath}`,
    );
  }
  return resolved;
}

export class CanonicalIndex {
  readonly #root: string;
  readonly #now: () => Date;

  constructor(root: string, options: { readonly now?: () => Date } = {}) {
    this.#root = path.resolve(root);
    this.#now = options.now ?? (() => new Date());
  }

  get root(): string {
    return this.#root;
  }

  async init(genesisCommitId = "genesis"): Promise<void> {
    await mkdir(this.#root, { recursive: true });
    await writeFile(path.join(this.#root, HEAD), genesisCommitId, "utf8");
  }

  async head(): Promise<string> {
    return (await readFile(path.join(this.#root, HEAD), "utf8")).trim();
  }

  async read(relPath: string): Promise<string> {
    return readFile(assertInsideRoot(this.#root, relPath), "utf8");
  }

  /**
   * Commit prose and state delta as one unit.
   *
   * Refuses when: the caller is not index-manager; the base commit no longer
   * matches HEAD (the packet is stale, so the delta was computed against a world
   * that moved); or the delta is empty (prose with no state change is almost
   * always a bug, and silently allowing it hides extraction failures).
   */
  async commit(request: CommitRequest): Promise<CommitResult> {
    if (request.actor !== "index-manager") {
      throw new CommitRefused(
        "WRONG_ACTOR",
        `${request.actor} may not write canonical state; only index-manager may`,
      );
    }
    if (request.stateDelta.length === 0) {
      throw new CommitRefused(
        "EMPTY_DELTA",
        "refusing to commit prose with no state delta",
      );
    }

    const currentHead = await this.head();
    if (currentHead !== request.baseCommitId) {
      throw new CommitRefused(
        "STALE_BASE",
        `base ${request.baseCommitId} is behind HEAD ${currentHead}`,
      );
    }

    const files = [request.prose, ...request.stateDelta];
    for (const f of files) assertInsideRoot(this.#root, f.relPath);

    const at = this.#now().toISOString();
    const commitId = digest([
      request.baseCommitId,
      request.sceneId,
      at,
      ...files.flatMap((f) => [f.relPath, f.content]),
    ]);

    const staging = path.join(this.#root, ".staging", request.txid);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });

    // 1. Everything into staging, each file fsynced before it can be renamed.
    const staged: { from: string; to: string }[] = [];
    for (const f of files) {
      const from = path.join(staging, f.relPath);
      await mkdir(path.dirname(from), { recursive: true });
      await writeFile(from, f.content, "utf8");
      const fd = openSync(from, "r");
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      staged.push({ from, to: path.resolve(this.#root, f.relPath) });
    }

    // 2. Record intent, so a crash mid-rename is replayable rather than a
    //    half-written index of unknown shape.
    const intent = {
      commitId,
      baseCommitId: request.baseCommitId,
      txid: request.txid,
      sceneId: request.sceneId,
      at,
      files: staged.map((s) => path.relative(this.#root, s.to)),
    };
    const intentPath = path.join(staging, INTENT);
    await writeFile(intentPath, JSON.stringify(intent, null, 2), "utf8");
    fsyncDir(staging);

    // 3. Rename into place, fsyncing each destination directory.
    const touchedDirs = new Set<string>();
    for (const { from, to } of staged) {
      await mkdir(path.dirname(to), { recursive: true });
      await rename(from, to);
      touchedDirs.add(path.dirname(to));
    }
    for (const dir of touchedDirs) fsyncDir(dir);

    // 4. HEAD moves last. Until this line the commit has not happened.
    const headTmp = path.join(staging, "HEAD.next");
    await writeFile(headTmp, commitId, "utf8");
    await rename(headTmp, path.join(this.#root, HEAD));
    fsyncDir(this.#root);

    await rm(staging, { recursive: true, force: true });

    return {
      commitId,
      baseCommitId: request.baseCommitId,
      writtenPaths: files.map((f) => f.relPath),
      at,
    };
  }

  /**
   * Staging directories left behind by a crash. Their intent files say what was
   * meant to happen; a caller can replay or discard them.
   */
  async pendingIntents(): Promise<readonly string[]> {
    const dir = path.join(this.#root, ".staging");
    try {
      return await readdir(dir);
    } catch {
      return [];
    }
  }
}
