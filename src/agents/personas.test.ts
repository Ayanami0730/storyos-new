import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { AgentRole } from "../transaction/types.ts";
import {
  DELEGATION_TOOLS,
  PERSONAS,
  READ_TOOLS,
  SEARCH_TOOLS,
  allowlistMismatch,
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

  it("gives every role but the writer the same search reach", () => {
    for (const role of ROLES) {
      for (const tool of SEARCH_TOOLS) {
        assert.equal(
          toolNamesFor(role).includes(tool),
          role !== "writer",
          `${role} search reach is wrong for ${tool}`,
        );
      }
    }
    // The writer's exception is about attention, not trust: it reads its own
    // packet and asks the builder, rather than grepping.
    const writer = toolNamesFor("writer");
    assert.ok(writer.includes("read_context"));
    assert.ok(writer.includes("ask_context_builder"));
  });

  it("routes commit authority through index-manager alone", () => {
    // There is no `commit` tool. The commit is `call_index_manager`, because
    // index-manager is the only actor that may produce COMMITTED — so the only
    // role that can reach a commit at all is the one that may ask for it.
    for (const role of ROLES) {
      assert.equal(
        toolNamesFor(role).includes("call_index_manager"),
        role === "orchestrator",
      );
    }
  });

  it("names only tools that something actually builds", () => {
    // The previous version of this list named six tools that did not exist,
    // and nothing noticed because nothing compared it with reality.
    const misspelt = /^(open_transaction|request_commit|build_context_packet|apply_state_delta|commit_transaction|run_command)$/;
    for (const role of ROLES) {
      for (const tool of toolNamesFor(role)) {
        assert.ok(!misspelt.test(tool), `${role} lists ${tool}, which no factory builds`);
      }
    }
  });

  it("never lets the verifier write prose or state", () => {
    const tools = toolNamesFor("verifier");
    for (const forbidden of [
      "write_staged_scene",
      "propose_state_delta",
      "append_state",
      "call_index_manager",
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

describe("the allowlist check", () => {
  it("passes when what was built is exactly what is allowed", () => {
    assert.equal(allowlistMismatch("verifier", [...toolNamesFor("verifier")]), null);
  });

  it("reports a tool granted but never reviewed", () => {
    const mismatch = allowlistMismatch("verifier", [
      ...toolNamesFor("verifier"),
      "propose_state_delta",
    ]);
    assert.deepEqual(mismatch?.unlisted, ["propose_state_delta"]);
    assert.deepEqual(mismatch?.missing, []);
  });

  it("reports a tool a role needs and did not get", () => {
    // The direction that fails silently: a role that cannot do its job says
    // nothing until it tries, and by then it is mid-scene.
    const mismatch = allowlistMismatch(
      "writer",
      toolNamesFor("writer").filter((t) => t !== "propose_state_delta"),
    );
    assert.deepEqual(mismatch?.missing, ["propose_state_delta"]);
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
