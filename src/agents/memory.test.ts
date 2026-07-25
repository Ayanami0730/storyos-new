import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import {
  AgentMemory,
  INDEX_MAX_BYTES,
  INDEX_MAX_LINES,
  memoryProblems,
  memorySection,
} from "./memory.ts";
import { memoryTools } from "./memory-tools.ts";

async function store(options?: {
  entities?: readonly string[];
  now?: () => number;
}): Promise<{ memory: AgentMemory; root: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-memory-"));
  return {
    root,
    memory: new AgentMemory({
      root,
      role: "writer",
      ...(options?.now ? { now: options.now } : {}),
      knownEntities: () => options?.entities ?? [],
    }),
  };
}

const lesson = {
  topic: "reveal-limits-first",
  title: "Check the reveal limit before drafting, not after",
  hook: "Two rewrites came from writing past a limit that was in the packet all along",
  body: "The packet states the reveal limit in P0. Read it before the first sentence.",
  scope: "role-craft" as const,
  source: "s-004 repair round",
};

describe("what may be remembered", () => {
  it("refuses a lesson that is really a story fact", () => {
    // The guarantee: canon has schema, provenance and a verifier that reads
    // it; memory has none of those. A fact that lives here is a second source
    // of truth that nothing audits, and it will be wrong eventually, quietly.
    const problems = memoryProblems(
      {
        ...lesson,
        topic: "mira-eyes",
        body: "char-mira has grey eyes; do not write them as green again.",
      },
      ["char-mira", "loc-harbour"],
    );
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.path, "body");
    assert.match(problems[0]!.problem, /char-mira/);
  });

  it("refuses one that pins itself to a particular scene", () => {
    const problems = memoryProblems({ ...lesson, body: "In s-012 the verifier was wrong." }, []);
    assert.match(problems[0]!.problem, /s-012/);
  });

  it("allows the same lesson stated so it holds for any scene", () => {
    assert.deepEqual(
      memoryProblems(
        {
          ...lesson,
          body: "When canon and my draft disagree about an attribute, re-read canon first.",
        },
        ["char-mira"],
      ),
      [],
    );
  });

  it("reports every problem at once rather than one per round trip", () => {
    const problems = memoryProblems({ topic: "Not A Slug", hook: "", body: "x" });
    assert.deepEqual(
      problems.map((p) => p.path).sort(),
      ["hook", "scope", "source", "title", "topic"],
    );
  });
});

describe("the memory directory", () => {
  it("writes a topic with provenance and indexes it", async () => {
    const { memory } = await store();
    const stored = await memory.write(lesson);

    const onDisk = await readFile(path.join(memory.dir, stored.file), "utf8");
    assert.match(onDisk, /^---\n/);
    assert.match(onDisk, /source: s-004 repair round/);
    assert.match(onDisk, /last_verified_at: \d{4}-/);

    assert.equal(
      await memory.renderIndex(),
      `- [${lesson.title}](reveal-limits-first.md) — ${lesson.hook}`,
    );
  });

  it("updates a lesson in place when the topic is reused", async () => {
    const { memory } = await store();
    await memory.write(lesson);
    await memory.write({ ...lesson, hook: "Sharper phrasing of the same lesson" });

    const files = (await readdir(memory.dir)).filter((f) => f !== "MEMORY.md");
    assert.deepEqual(files, ["reveal-limits-first.md"]);
    assert.match(await memory.renderIndex(), /Sharper phrasing/);
  });

  it("drops an expired lesson from the index but keeps the file", async () => {
    // A stale calibration reads exactly as authoritative as a current one, so
    // hiding it is the safe default; the file stays for the audit trail.
    let now = Date.parse("2026-07-01T00:00:00Z");
    const { memory } = await store({ now: () => now });
    await memory.write({ ...lesson, expiresInDays: 2 });
    assert.notEqual(await memory.renderIndex(), "");

    now = Date.parse("2026-07-10T00:00:00Z");
    assert.equal(await memory.renderIndex(), "");
    assert.equal((await memory.all()).length, 1);
    assert.equal((await memory.live()).length, 0);
  });

  it("caps the index and says accurately how much it is not showing", async () => {
    // Two caps, and either may bind first depending on how long the hooks are.
    // What must hold in both cases is that the index stays skimmable and the
    // count of what it is hiding is right — an index that silently drops
    // lessons is worse than a short one, because the agent cannot tell.
    const written = INDEX_MAX_LINES + 3;
    const { memory } = await store();
    for (let i = 0; i < written; i += 1) {
      await memory.write({ ...lesson, topic: `lesson-${String(i).padStart(3, "0")}` });
    }

    const index = await memory.renderIndex();
    const lines = index.split("\n");
    assert.ok(lines.length <= INDEX_MAX_LINES + 1, `${lines.length} lines`);
    assert.ok(Buffer.byteLength(index) <= INDEX_MAX_BYTES + 200);
    assert.match(lines.at(-1)!, new RegExp(`${written - (lines.length - 1)} older topic\\(s\\)`));
  });

  it("answers that a topic does not exist rather than guessing", async () => {
    const { memory } = await store();
    assert.equal(await memory.read("never-written"), null);
    // Path traversal is not a topic name either.
    assert.equal(await memory.read("../../etc/passwd"), null);
  });
});

describe("the remember tool", () => {
  function tools(memory: AgentMemory, entities: readonly string[] = []) {
    const changes: number[] = [];
    const list = memoryTools(memory, {
      source: () => "s-002",
      knownEntities: () => entities,
      onChange: () => {
        changes.push(1);
      },
    }) as {
      name: string;
      execute: (id: string, args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
    }[];
    return { changes, remember: list.find((t) => t.name === "remember")!, read: list.find((t) => t.name === "read_memory")! };
  }

  it("hands back the reason instead of failing the turn", async () => {
    const { memory } = await store();
    const { remember, changes } = tools(memory, ["char-mira"]);
    const result = await remember.execute("t1", {
      topic: "mira-eyes",
      title: "Mira's eyes",
      hook: "grey not green",
      body: "char-mira has grey eyes.",
      scope: "role-craft",
    });
    assert.match(result.content[0]!.text, /^rejected:/);
    assert.match(result.content[0]!.text, /char-mira/);
    assert.deepEqual(changes, [], "a rejected write does not refresh anything");
  });

  it("stamps the caller's scene as the source, not the model's account of it", async () => {
    const { memory } = await store();
    const { remember, changes } = tools(memory);
    await remember.execute("t1", {
      topic: "repair-locus",
      title: "Read the finding's locus before editing",
      hook: "Half my repairs edited the draft when canon was the stale side",
      body: "editLocus says where the fix belongs. Read it first.",
      scope: "role-craft",
    });
    assert.equal((await memory.read("repair-locus"))!.source, "s-002");
    assert.equal(changes.length, 1);
  });

  it("lists what does exist when asked for a topic that does not", async () => {
    const { memory } = await store();
    const { remember, read } = tools(memory);
    await remember.execute("t1", { ...lesson, expires_in_days: undefined });
    const result = await read.execute("t2", { topic: "not-a-topic" });
    assert.match(result.content[0]!.text, /reveal-limits-first/);
  });
});

describe("the memory section of a system prompt", () => {
  it("says what memory is for, and is explicit when there is nothing yet", () => {
    const section = memorySection("");
    assert.match(section, /nothing yet/);
    assert.match(section, /Story facts never go here/);
  });

  it("carries the index once there is one", () => {
    assert.match(memorySection("- [A](a.md) — hook"), /- \[A\]\(a\.md\) — hook/);
  });
});
