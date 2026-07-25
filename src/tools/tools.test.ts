import assert from "node:assert/strict";
import { describe, it } from "node:test";

import type { RelationRecord } from "../index/relations.ts";
import { proposeStateDeltaTool, relationHistoryTool } from "./index-tools.ts";
import { ALL_ROLES, ToolRegistry } from "./registry.ts";
import { GuardedShell } from "./shell.ts";

const record: RelationRecord = {
  pairId: "char-mira--char-warden",
  participants: ["char-mira", "char-warden"],
  phases: [
    {
      index: 1,
      relation: "strangers",
      fromScene: "s-001",
      toScene: "s-004",
      transition: "they pass each other on the quay without speaking",
      source: { scene: "s-001", span: "L12-L18" },
    },
    {
      index: 2,
      relation: "mentor_student",
      fromScene: "s-005",
      toScene: null,
      transition: "he corrects her chart and she lets him",
      asymmetry: "he is recruiting her; she thinks she is being taught",
      source: { scene: "s-005", span: "L44-L60" },
    },
  ],
  openQuestions: ["does mira learn his faction?"],
};

const ctx = { role: "writer", txid: "tx-1" } as const;

function registryWith(load = async () => record as RelationRecord | null) {
  return new ToolRegistry().register(relationHistoryTool(load));
}

describe("registry authority", () => {
  it("lets every role read, because read reach is not what differs", () => {
    const registry = registryWith();
    for (const role of ALL_ROLES) {
      assert.ok(registry.namesFor(role).includes("read_relation_history"));
    }
  });

  it("refuses to register a read tool that only some roles may call", () => {
    assert.throws(
      () =>
        new ToolRegistry().register({
          ...relationHistoryTool(async () => record),
          allowedRoles: ["writer"],
        }),
      /every role must be allowed/,
    );
  });

  it("refuses a mutating call from the wrong role and names who may", async () => {
    const registry = new ToolRegistry().register(proposeStateDeltaTool(() => "staged"));
    const result = await registry.call("propose_state_delta", {}, {
      role: "verifier",
      txid: "tx-1",
    });
    assert.equal(result.ok, false);
    assert.equal(result.ok === false && result.code, "FORBIDDEN");
    assert.match(result.ok === false ? result.message : "", /restricted to writer/);
  });

  it("refuses a tool that nobody could call", () => {
    assert.throws(
      () =>
        new ToolRegistry().register({
          ...proposeStateDeltaTool(() => "staged"),
          allowedRoles: [],
        }),
      /callable by nobody/,
    );
  });
});

describe("read_relation_history", () => {
  it("gives the writer the cause of each change, not just the labels", async () => {
    const result = await registryWith().call<string>(
      "read_relation_history",
      { pairId: "char-mira--char-warden" },
      ctx,
    );
    assert.equal(result.ok, true);
    const text = result.ok ? result.value : "";
    assert.match(text, /how: he corrects her chart and she lets him/);
    assert.match(text, /asymmetry: he is recruiting her/);
    assert.match(text, /source: s-005 L44-L60/);
  });

  it("restricts to what is in force at a scene when asked", async () => {
    const result = await registryWith().call<string>(
      "read_relation_history",
      { pairId: "char-mira--char-warden", atScene: "s-002" },
      ctx,
    );
    const text = result.ok ? result.value : "";
    assert.match(text, /strangers/);
    assert.doesNotMatch(text, /mentor_student/);
  });

  it("keeps an open-ended phase in force however far ahead the scene is", async () => {
    const result = await registryWith().call<string>(
      "read_relation_history",
      { pairId: "char-mira--char-warden", atScene: "s-999" },
      ctx,
    );
    const text = result.ok ? result.value : "";
    assert.match(text, /mentor_student/);
    assert.doesNotMatch(text, /strangers/);
  });

  it("says plainly when no phase covers the scene, instead of returning nothing", async () => {
    const result = await registryWith().call<string>(
      "read_relation_history",
      { pairId: "char-mira--char-warden", atScene: "s-000" },
      ctx,
    );
    const text = result.ok ? result.value : "";
    assert.match(text, /no phase is in force at s-000/);
  });

  it("names the field when the pair id is malformed", async () => {
    const result = await registryWith().call("read_relation_history", { pairId: "mira" }, ctx);
    assert.equal(result.ok === false && result.code, "INVALID_ARGUMENTS");
    assert.deepEqual(result.ok === false && result.errors.map((e) => e.path), ["pairId"]);
  });

  it("treats a missing record as worth reporting, not worth working around", async () => {
    const result = await registryWith(async () => null).call(
      "read_relation_history",
      { pairId: "char-a--char-b" },
      ctx,
    );
    assert.equal(result.ok === false && result.code, "REFUSED");
    assert.match(result.ok === false ? result.message : "", /defect worth reporting/);
  });
});

describe("propose_state_delta validates in the same turn", () => {
  const registry = new ToolRegistry().register(
    proposeStateDeltaTool(() => "staging/tx-1/proposed-state-delta.json"),
  );

  const good = {
    sceneId: "s-011",
    presentEntities: ["char-mira"],
    claims: [
      {
        entity: "char-mira",
        attribute: "location",
        value: "the harbour",
        quote: "she waited where the water met the stone",
      },
    ],
  };

  it("accepts a well-formed delta", async () => {
    const result = await registry.call("propose_state_delta", good, ctx);
    assert.equal(result.ok, true);
  });

  it("reports every field problem at once, not the first one", async () => {
    const result = await registry.call(
      "propose_state_delta",
      {
        sceneId: "scene-11",
        presentEntities: ["char-mira"],
        claims: [{ entity: "", attribute: "", value: "", quote: "" }],
      },
      ctx,
    );
    assert.equal(result.ok === false && result.code, "INVALID_ARGUMENTS");
    const paths = result.ok === false ? result.errors.map((e) => e.path) : [];
    assert.deepEqual(paths, [
      "sceneId",
      "claims[0].entity",
      "claims[0].attribute",
      "claims[0].value",
      "claims[0].quote",
    ]);
  });

  it("requires the verbatim quote, because a claim without one cannot be audited", async () => {
    const result = await registry.call(
      "propose_state_delta",
      { ...good, claims: [{ ...good.claims[0]!, quote: "  " }] },
      ctx,
    );
    assert.match(
      result.ok === false ? result.errors[0]!.problem : "",
      /verbatim prose/,
    );
  });

  it("requires a reason for a deliberate overwrite", async () => {
    const result = await registry.call(
      "propose_state_delta",
      {
        ...good,
        claims: [
          { ...good.claims[0]!, supersedes: { factId: "fact-1", reason: "" } },
        ],
      },
      ctx,
    );
    assert.match(
      result.ok === false ? result.errors[0]!.problem : "",
      /cannot tell it from a mistake/,
    );
  });

  it("catches a scene that proposes two values for the same property", async () => {
    const result = await registry.call(
      "propose_state_delta",
      {
        ...good,
        claims: [
          good.claims[0]!,
          { ...good.claims[0]!, value: "the tower" },
        ],
      },
      ctx,
    );
    assert.match(result.ok === false ? result.errors[0]!.problem : "", /duplicates claims\[0\]/);
  });
});

describe("run_command guardrails", () => {
  function shell(stdout: string, limits = {}) {
    const spilled: string[] = [];
    const guarded = new GuardedShell({
      execute: async () => ({ exitCode: 0, stdout, stderr: "" }),
      spill: (payload) => {
        spilled.push(payload);
        return "runtime/artifacts/a-1.txt";
      },
      limits,
      now: () => 0,
    });
    return { guarded, spilled };
  }

  it("passes a normal read through untouched", async () => {
    const { guarded } = shell("three lines\nof output\nhere");
    const outcome = await guarded.run(
      { command: "grep -n harbour index/story/bible/locations/harbour.yaml", purpose: "check the harbour's stated depth" },
      "writer:tx-1",
    );
    assert.equal(outcome.truncated, false);
    assert.equal(outcome.stdout, "three lines\nof output\nhere");
  });

  it("spills an oversized payload and says so, rather than cutting it silently", async () => {
    const { guarded, spilled } = shell("x".repeat(20_000), { maxInlineChars: 100 });
    const outcome = await guarded.run(
      { command: "cat manuscript/parts/1/chapters/1/scenes/s-001.md", purpose: "read the previous scene" },
      "writer:tx-1",
    );
    assert.equal(outcome.truncated, true);
    assert.equal(outcome.artifactPath, "runtime/artifacts/a-1.txt");
    assert.equal(spilled.length, 1);
    // The head alone reads as a complete answer; the notice is what stops an
    // agent drawing conclusions from a fragment.
    assert.match(outcome.stdout, /truncated: 20000 chars total/);
    assert.match(outcome.stdout, /Narrow the command/);
  });

  for (const [command, expected] of [
    ["rm -rf index/story", /never through the shell/],
    ["echo hi > index/HEAD", /shell redirection writes files/],
    ["sed -i s/a/b/ index/story/premise.md", /escapes every check/],
    ["curl https://example.com", /no network from the read path/],
    ["git commit -am wip", /engine owning every commit/],
  ] as const) {
    it(`refuses \`${command}\` with a reason`, async () => {
      const { guarded } = shell("");
      await assert.rejects(
        guarded.run({ command, purpose: "tidy up" }, "writer:tx-1"),
        expected,
      );
    });
  }

  it("requires a purpose, because the ledger cannot ask afterwards", async () => {
    const { guarded } = shell("");
    await assert.rejects(
      guarded.run({ command: "ls index/", purpose: "" }, "writer:tx-1"),
      /purpose is required/,
    );
  });

  it("stops an agent that turns the shell into its whole strategy", async () => {
    const { guarded } = shell("ok", { maxCallsPerTransaction: 2 });
    const req = { command: "ls index/", purpose: "orient" };
    await guarded.run(req, "writer:tx-1");
    await guarded.run(req, "writer:tx-1");
    await assert.rejects(guarded.run(req, "writer:tx-1"), /shell budget exhausted/);
    // Budgets are per transaction and per agent, so another scene is unaffected.
    assert.equal(guarded.callsUsed("writer:tx-2"), 0);
  });
});
