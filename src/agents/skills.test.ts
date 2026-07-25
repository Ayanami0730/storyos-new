import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";

import { skillTools } from "./skill-tools.ts";
import {
  STARTER_SKILLS,
  SkillLibrary,
  installStarterSkills,
  parseSkill,
  skillsSection,
} from "./skills.ts";

async function library(role: "writer" | "verifier" = "writer") {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-skills-"));
  return { root, library: new SkillLibrary({ root, role }) };
}

interface Tool {
  name: string;
  execute: (id: string, args: Record<string, unknown>) => Promise<{ content: { text: string }[] }>;
}
const text = (r: { content: { text: string }[] }) => r.content[0]!.text;

describe("the skill file format", () => {
  it("requires a description, because that is all that is ever loaded", () => {
    assert.throws(() => parseSkill("x", "---\nname: x\n---\nbody"), /needs a description/);
    assert.throws(() => parseSkill("x", "no frontmatter here"), /no frontmatter/);
  });

  it("keeps the body out of the frontmatter", () => {
    const skill = parseSkill(
      "promise-payoff-audit",
      "---\nname: Promise audit\ndescription: how to judge an open promise\nuses: run_command\n---\n1. Read the contracts.\n",
    );
    assert.equal(skill.description, "how to judge an open promise");
    assert.deepEqual(skill.uses, ["run_command"]);
    assert.match(skill.body, /Read the contracts/);
  });
});

describe("the prompt section", () => {
  it("is one line per skill, which is what makes the mechanism affordable", async () => {
    const { root } = await library();
    await installStarterSkills(root, "writer");
    const skills = await new SkillLibrary({ root, role: "writer" }).all();
    const section = skillsSection(skills);
    const bullets = section.split("\n").filter((l) => l.startsWith("- `"));
    assert.equal(bullets.length, skills.length);
    // The body must not leak into the prompt; twelve expanded procedures would be
    // tens of thousands of tokens in every turn, most of them irrelevant.
    assert.doesNotMatch(section, /1\. Read the P0 block/);
    assert.match(section, /read_skill/);
  });

  it("tells an agent with no skills how to make one", () => {
    assert.match(skillsSection([]), /write_skill/);
  });
});

describe("the starter library", () => {
  it("gives every role at least one procedure", () => {
    for (const [role, skills] of Object.entries(STARTER_SKILLS)) {
      assert.ok(skills.length > 0, role);
      for (const skill of skills) assert.ok(skill.description.trim(), `${role}/${skill.name}`);
    }
  });

  it("installs without overwriting a skill the agent has edited", async () => {
    const { root } = await library();
    await installStarterSkills(root, "writer");
    const dir = path.join(root, ".writer", "skills", "scene-drafting");
    await mkdir(dir, { recursive: true });
    await writeFile(
      path.join(dir, "SKILL.md"),
      "---\nname: scene-drafting\ndescription: my own version\n---\nmine\n",
      "utf8",
    );
    const installed = await installStarterSkills(root, "writer");
    assert.ok(!installed.includes("scene-drafting"));
    const skill = await new SkillLibrary({ root, role: "writer" }).read("scene-drafting");
    assert.equal(skill!.description, "my own version");
  });

  it("contains no story state, so it holds in a different story", () => {
    // A skill that names this story's characters is a fact with no provenance
    // and no verifier reading it.
    const all = Object.values(STARTER_SKILLS).flat();
    for (const skill of all) {
      assert.doesNotMatch(`${skill.name} ${skill.body}`, /\bchar-[a-z]/, skill.name);
    }
  });

  it("documents which tools a procedure calls without granting them", () => {
    const drafting = STARTER_SKILLS.writer.find((s) => s.name === "scene-drafting")!;
    assert.ok(drafting.uses!.includes("write_staged_scene"));
  });
});

describe("the skill tools", () => {
  function tools(lib: SkillLibrary, entities: readonly string[] = []) {
    let changes = 0;
    const list = skillTools(lib, {
      knownEntities: () => entities,
      onChange: () => {
        changes += 1;
      },
    }) as Tool[];
    return {
      read: list.find((t) => t.name === "read_skill")!,
      write: list.find((t) => t.name === "write_skill")!,
      changes: () => changes,
    };
  }

  it("returns the full procedure on read", async () => {
    const { root, library: lib } = await library();
    await installStarterSkills(root, "writer");
    const { read } = tools(lib);
    assert.match(text(await read.execute("t", { slug: "scene-drafting" })), /Read the P0 block/);
  });

  it("lists what exists when the slug is wrong", async () => {
    const { root, library: lib } = await library();
    await installStarterSkills(root, "writer");
    const { read } = tools(lib);
    assert.match(text(await read.execute("t", { slug: "nope" })), /scene-drafting/);
  });

  it("refuses a skill that is really a fact about this story", async () => {
    const { library: lib } = await library();
    const { write, changes } = tools(lib, ["char-araine"]);
    const result = await write.execute("t", {
      slug: "araine-notes",
      name: "Araine notes",
      description: "what she knows",
      body: "char-araine is at the docks and does not know the city moves.",
    });
    assert.match(text(result), /^rejected/);
    assert.match(text(result), /char-araine/);
    assert.equal(changes(), 0);
  });

  it("writes a procedure and refreshes the prompt", async () => {
    const { library: lib } = await library();
    const { write, changes } = tools(lib, ["char-araine"]);
    await write.execute("t", {
      slug: "belief-boundary-audit",
      name: "Belief boundary audit",
      description: "check nobody uses knowledge they do not have",
      body: "1. List present characters. 2. Read their beliefs as of this scene.",
      uses: ["run_command"],
    });
    assert.equal(changes(), 1);
    const stored = await lib.read("belief-boundary-audit");
    assert.deepEqual(stored!.uses, ["run_command"]);
  });

  it("hands validation problems back as feedback", async () => {
    const { library: lib } = await library();
    const { write } = tools(lib);
    assert.match(
      text(await write.execute("t", { slug: "Not A Slug", name: "n", description: "d", body: "b" })),
      /rejected: slug must be/,
    );
  });
});
