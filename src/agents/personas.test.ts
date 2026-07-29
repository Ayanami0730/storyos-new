import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";

import type { AgentRole } from "../transaction/types.ts";
import { indexManagerTools } from "./index-manager-tools.ts";
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
  withVerifier,
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

  /**
   * The verifier runs the writer's backbone, and this test used to assert the
   * opposite.
   *
   * Cross-family was the default until 0.6.1 on a sound argument — a verifier from
   * the writer's own family inherits its blind spots. It lost to two things the
   * argument cannot answer. It breaks the comparison: main's experiment settings
   * hold the generation backbone constant across systems and every baseline runs
   * `gpt-5-mini` throughout, so a stronger model in one role makes our measured
   * margin unattributable. And the gateway returns zero cache reads for that model,
   * so a resident verifier re-sent its whole history every call — 81% of a run's
   * cost on 11% of its round-trips, then the channel's quota ran out and scenes
   * committed unverified.
   */
  it("runs the verifier on the same backbone as every other role and every baseline", () => {
    assert.equal(personaFor("verifier").model, personaFor("writer").model);
    for (const role of ["orchestrator", "context-builder", "index-manager"] as const) {
      assert.equal(personaFor(role).model, personaFor("verifier").model);
    }
  });

  it("still allows a cross-family verifier, which is now the ablation", () => {
    // The blind-spot question is real and worth measuring; it is a variable now
    // rather than a confound baked into the main table.
    const swapped = withVerifier(PERSONAS, "gemini-3.1-pro-preview");
    const verifier = swapped.find((p) => p.role === "verifier")!;
    assert.equal(verifier.model, "gemini-3.1-pro-preview");
    // And nothing else moves.
    for (const p of swapped) {
      if (p.role !== "verifier") assert.equal(p.model, "gpt-5-mini");
    }
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

  /**
   * The three tests above compare the list against `toolNamesFor`, which is the
   * list. They cannot fail on the drift the check exists to catch, and that is
   * not hypothetical — it is how 0.9.1 shipped.
   *
   * `fold_scene` was added to the factory and not to the persona, so
   * `allowlistMismatch` refused the index-manager at construction on every scene
   * of every run for four versions. The scene loop treats a failed backfill as a
   * warning and commits anyway, which is right for a transient failure and made
   * a total one invisible: 26 runs delivered manuscripts with **zero state
   * entries, zero beliefs, zero relations and zero events**, against 11–101
   * state entries in every run from 0.7.1 to 0.8.2. Nothing failed, so nothing
   * was looked at.
   *
   * Comparing against what the factory actually builds is the assertion that was
   * missing. It is the same argument the runtime check makes, moved to where it
   * costs a test run instead of a batch.
   */
  it("agrees with the tools the index-manager factory actually builds", () => {
    const built = (
      indexManagerTools(() => {
        throw new Error("a live writer is not needed to enumerate tool names");
      }) as { readonly name: string }[]
    ).map((t) => t.name);
    const mismatch = allowlistMismatch("index-manager", [
      ...built,
      // The rest of the role's surface comes from shared factories, which this
      // test is not about; only the write tools are role-specific.
      ...toolNamesFor("index-manager").filter(
        (t) => !personaFor("index-manager").writeTools.includes(t),
      ),
    ]);
    assert.equal(
      mismatch,
      null,
      `personas.ts and index-manager-tools.ts disagree: ` +
        `granted but not listed ${mismatch?.unlisted.join(", ") || "none"}, ` +
        `listed but not granted ${mismatch?.missing.join(", ") || "none"}`,
    );
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

/**
 * The Chinese directive, and the reason it exists rather than a translation.
 *
 * Half of LongBench-Write is Chinese and it is the one axis on which this harness
 * makes its own backbone worse: raw gpt-5-mini scores 4.26 on the Chinese tasks
 * and 3.87 on the English ones, while through the harness the same backbone scores
 * 3.24 and 3.55. Every other system in the table scores the same or better in
 * Chinese; only ours scores worse.
 */
describe("the manuscript language directive", () => {
  it("puts the Chinese instruction before the English contract", () => {
    const root = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../agents",
    );
    const plain = systemPromptFor("writer", root);
    const chinese = systemPromptFor("writer", root, { manuscriptLanguage: "chinese" });
    assert.ok(!plain.includes("本书的语言"), "an English task must not carry it");
    assert.ok(chinese.startsWith("# 本书的语言：中文"), "it has to come first to set register");
    // The contract itself is untouched: the directive is additive, and a
    // mistranslated tool rule would break the gate rather than the prose, which
    // is exactly why the role files are not translated.
    assert.ok(chinese.endsWith(plain), "the English contract must survive verbatim");
  });

  it("keeps harness identifiers out of the translation", () => {
    const root = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../agents",
    );
    const chinese = systemPromptFor("orchestrator", root, { manuscriptLanguage: "chinese" });
    // Entity ids are filing keys; a directive that told the model to translate
    // them would break reference integrity on every scene.
    assert.match(chinese, /char-、loc-、obj-/);
  });
});
