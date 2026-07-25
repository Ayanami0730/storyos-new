import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { AgentRole } from "../transaction/types.ts";
import {
  DELEGATION_TOOLS,
  PERSONAS,
  READ_TOOLS,
  personaFor,
  systemPromptFor,
  toolNamesFor,
  withBackbone,
} from "./personas.ts";

const AGENTS_ROOT = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../agents",
);

const ROLES: readonly AgentRole[] = [
  "orchestrator",
  "index-manager",
  "context-builder",
  "writer",
  "verifier",
];

describe("personas", () => {
  it("defines exactly the five roles", () => {
    assert.deepEqual([...PERSONAS.map((p) => p.role)].sort(), [...ROLES].sort());
  });

  it("gives every role the same read reach", () => {
    for (const role of ROLES) {
      for (const tool of READ_TOOLS) {
        assert.ok(
          toolNamesFor(role).includes(tool),
          `${role} is missing the universal read tool ${tool}`,
        );
      }
    }
  });

  it("keeps delegation depth at one: only the orchestrator may call an agent", () => {
    for (const role of ROLES) {
      const canDelegate = DELEGATION_TOOLS.some((t) => toolNamesFor(role).includes(t));
      assert.equal(
        canDelegate,
        role === "orchestrator",
        `${role} delegation authority is wrong`,
      );
    }
  });

  it("gives commit authority to index-manager alone", () => {
    for (const role of ROLES) {
      assert.equal(
        toolNamesFor(role).includes("commit_transaction"),
        role === "index-manager",
      );
    }
  });

  it("never lets the verifier write prose or state", () => {
    const tools = toolNamesFor("verifier");
    for (const forbidden of [
      "write_staged_scene",
      "propose_state_delta",
      "apply_state_delta",
      "commit_transaction",
    ]) {
      assert.ok(!tools.includes(forbidden), `verifier must not have ${forbidden}`);
    }
    assert.ok(tools.includes("write_findings"));
  });

  it("draws the verifier from a different family than the writer", () => {
    const family = (id: string) => id.split(/[-.]/)[0];
    assert.notEqual(
      family(personaFor("verifier").model),
      family(personaFor("writer").model),
    );
  });

  it("refuses to describe a role it does not have", () => {
    assert.throws(() => personaFor("librarian" as AgentRole), /no persona/);
  });
});

describe("backbone override", () => {
  it("moves every role onto the new backbone", () => {
    const swapped = withBackbone("gpt-5.6-terra");
    for (const p of swapped) {
      if (p.role !== "verifier") assert.equal(p.model, "gpt-5.6-terra");
    }
  });

  it("leaves the verifier alone, so the arm does not silently lose cross-family checking", () => {
    const swapped = withBackbone("gpt-5.6-terra");
    const verifier = swapped.find((p) => p.role === "verifier");
    assert.equal(verifier!.model, personaFor("verifier").model);
  });
});

describe("system prompts", () => {
  for (const role of ROLES) {
    it(`composes ${role}'s prompt from the shared contract plus its own file`, () => {
      const prompt = systemPromptFor(role, AGENTS_ROOT);
      assert.ok(prompt.includes("# Shared contract"), "shared half missing");
      assert.ok(prompt.length > 2000, `${role} prompt is suspiciously short`);
    });
  }

  it("tells every role that the index is the truth, not their memory", () => {
    for (const role of ROLES) {
      assert.match(systemPromptFor(role, AGENTS_ROOT), /Never rely on your own memory/);
    }
  });
});
