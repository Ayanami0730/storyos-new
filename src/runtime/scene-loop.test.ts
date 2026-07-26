import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { ContextItem } from "../context/types.ts";
import { CanonicalIndex } from "../index/commit.ts";
import type { Finding } from "../transaction/types.ts";
import type { CanonFact } from "../verification/deterministic.ts";
import { makeFinding } from "../verification/finding.ts";
import { allocate } from "./allocation.ts";
import { type Draft, type SceneCollaborators, runScene } from "./scene-loop.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshIndex() {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-loop-"));
  roots.push(root);
  const index = new CanonicalIndex(root);
  await index.init("commit-0");
  return { root, index };
}

const AVAILABLE: readonly ContextItem[] = [
  {
    id: "scene-card",
    priority: "P0",
    source: "index/story/structure/scenes/s-011.yaml",
    content: "Mira waits for the warden and he does not come.",
  },
  {
    id: "char-mira",
    priority: "P1",
    source: "index/story/bible/characters/mira.yaml",
    content: "grey eyes, 29, at the harbour",
  },
];

const CANON: readonly CanonFact[] = [
  {
    id: "fact-eyes",
    entity: "char-mira",
    attribute: "eye_colour",
    value: "grey",
    source: "s-003",
  },
];

const KNOWN = new Set(["char-mira"]);

function request(overrides: Partial<Parameters<typeof runScene>[0]> = {}) {
  return {
    txid: "tx-1",
    sceneId: "s-011",
    packet: {
      sceneId: "s-011",
      baseCommitId: "commit-0",
      hardRequiredIds: ["scene-card"],
      budgetWords: 500,
    },
    available: AVAILABLE,
    canon: CANON,
    knownEntities: KNOWN,
    allocation: allocate({ sceneIndex: 1, total: 1, pinnedRepairs: 2 }),
    prosePath: "manuscript/s-011.md",
    ...overrides,
  } as Parameters<typeof runScene>[0];
}

function goodDraft(prose = "She waited on the quay."): Draft {
  return {
    prose,
    delta: {
      sceneId: "s-011",
      presentEntities: ["char-mira"],
      claims: [
        {
          entity: "char-mira",
          attribute: "mood",
          value: "impatient",
          quote: "She waited on the quay.",
        },
      ],
    },
  };
}

/** A collaborator whose drafts and reviews are scripted per attempt. */
function scripted(options: {
  drafts: Draft[];
  reviews?: (readonly Finding[])[];
}): SceneCollaborators & { briefs: string[]; attempts: number[] } {
  const briefs: string[] = [];
  const attempts: number[] = [];
  let draftIndex = 0;
  let reviewIndex = 0;
  return {
    briefs,
    attempts,
    async draft({ attempt, repairBrief }) {
      briefs.push(repairBrief);
      attempts.push(attempt);
      return options.drafts[Math.min(draftIndex++, options.drafts.length - 1)]!;
    },
    async review() {
      return options.reviews?.[reviewIndex++] ?? [];
    },
  };
}

describe("a clean scene", () => {
  it("commits prose and delta together and reports the path it took", async () => {
    const { index, root } = await freshIndex();
    const outcome = await runScene(request(), {
      index,
      collaborators: scripted({ drafts: [goodDraft()] }),
    });

    assert.equal(outcome.status, "COMMITTED");
    assert.equal(outcome.attempts, 1);
    assert.deepEqual(outcome.history, [
      "CONTEXT_BUILT",
      "DRAFTED",
      "STATE_DELTA_PROPOSED",
      "VALIDATING",
      "APPROVED",
      "COMMITTING",
      "COMMITTED",
    ]);
    assert.equal(
      await readFile(path.join(root, "manuscript/s-011.md"), "utf8"),
      "She waited on the quay.",
    );
    // Both artefacts, or neither: the delta must be on disk too.
    const delta = JSON.parse(
      await readFile(
        path.join(root, "continuity/deltas/s-011.json"),
        "utf8",
      ),
    );
    assert.equal(delta.claims.length, 1);
    assert.equal(await index.head(), (outcome as { commit: { commitId: string } }).commit.commitId);
  });

  it("does not send the writer a repair brief on the first attempt", async () => {
    const { index } = await freshIndex();
    const collaborators = scripted({ drafts: [goodDraft()] });
    await runScene(request(), { index, collaborators });
    assert.deepEqual(collaborators.briefs, [""]);
  });
});

describe("repair rounds", () => {
  const contradicting: Draft = {
    prose: "Her green eyes narrowed.",
    delta: {
      sceneId: "s-011",
      presentEntities: ["char-mira"],
      claims: [
        {
          entity: "char-mira",
          attribute: "eye_colour",
          value: "green",
          quote: "Her green eyes narrowed.",
        },
      ],
    },
  };

  it("routes a contradiction back to the writer with both sides quoted", async () => {
    const { index } = await freshIndex();
    const collaborators = scripted({ drafts: [contradicting, goodDraft()] });
    const outcome = await runScene(request(), { index, collaborators });

    assert.equal(outcome.status, "COMMITTED");
    assert.equal(outcome.attempts, 2);
    assert.equal(collaborators.attempts[1], 1);
    const brief = collaborators.briefs[1]!;
    assert.match(brief, /appearance_mismatches/);
    assert.match(brief, /Her green eyes narrowed/);
    assert.match(brief, /contradicts: "grey"/);
  });

  it("stops early when a finding survives a rewrite, and commits rather than deleting the scene", async () => {
    const { index } = await freshIndex();
    // The writer changes the prose but not the offending claim.
    const outcome = await runScene(request({ allocation: allocate({ sceneIndex: 1, total: 1, pinnedRepairs: 5 }) }), {
      index,
      collaborators: scripted({ drafts: [contradicting, contradicting] }),
    });

    // Stopping early is still right: a finding that survived a rewrite will
    // survive the next one, and three more rounds buy the same draft again.
    assert.equal(outcome.attempts, 2, "should not have spent the whole budget");
    // But the scene lands. Deleting it was measured and it was the worse trade:
    // one dropped scene cost fifteen points of length score and left the
    // manuscript opening mid-investigation, which is a larger defect than the one
    // the gate objected to and one that nothing records.
    assert.equal(outcome.status, "COMMITTED");
    const committed = outcome as {
      unresolvedFindings: readonly unknown[];
      warnings: readonly string[];
    };
    assert.equal(committed.unresolvedFindings.length, 1, "the defect is carried, not forgotten");
    assert.match(committed.warnings.join(" "), /survived a rewrite unchanged/);
    // And it is auditable on disk, or "the gate still has teeth" has no artefact.
    assert.match(await index.read("continuity/unresolved/s-011.json"), /eye_colour|green/);
  });

  it("commits with the defect recorded once the budget runs out on new findings each round", async () => {
    const { index } = await freshIndex();
    // Each attempt contradicts canon at a different quote, so nothing persists.
    const drafts = ["green", "blue", "amber"].map((colour) => ({
      prose: `Her ${colour} eyes narrowed.`,
      delta: {
        sceneId: "s-011",
        presentEntities: ["char-mira"],
        claims: [
          {
            entity: "char-mira",
            attribute: "eye_colour",
            value: colour,
            quote: `Her ${colour} eyes narrowed.`,
          },
        ],
      },
    }));
    const outcome = await runScene(request({ allocation: allocate({ sceneIndex: 1, total: 1, pinnedRepairs: 2 }) }), {
      index,
      collaborators: scripted({ drafts }),
    });

    assert.equal(outcome.status, "COMMITTED");
    const committed = outcome as {
      unresolvedFindings: readonly unknown[];
      warnings: readonly string[];
    };
    assert.equal(committed.unresolvedFindings.length, 1);
    assert.match(committed.warnings.join(" "), /repair budget of 2 round\(s\) ran out/);
  });

  it("does not call the model verifier while a deterministic contradiction stands", async () => {
    const { index } = await freshIndex();
    let reviews = 0;
    const outcome = await runScene(request(), {
      index,
      collaborators: {
        async draft() {
          return goodDraft();
        },
        async review() {
          reviews += 1;
          return [];
        },
      },
    });
    assert.equal(outcome.status, "COMMITTED");
    assert.equal(reviews, 1);

    const { index: index2 } = await freshIndex();
    let reviews2 = 0;
    await runScene(request(), {
      index: index2,
      collaborators: {
        async draft() {
          return contradicting;
        },
        async review() {
          reviews2 += 1;
          return [];
        },
      },
    });
    // Three attempts, zero model calls: the free layer settled it every time.
    assert.equal(reviews2, 0);
  });
});

describe("the model verifier's findings", () => {
  it("blocks a commit when the LLM track finds an evidenced contradiction", async () => {
    const { index } = await freshIndex();
    const llmFinding = makeFinding({
      subtype: "geographical_contradictions",
      validator: "llm",
      severity: "error",
      reasoning: "the quay is inland in this scene",
      evidence: { quote: "the quay above the treeline", source: "s-011" },
      contradicts: { quote: "the harbour is at sea level", source: "s-002" },
      editLocus: { kind: "draft", quote: "the quay above the treeline" },
    });
    let round = 0;
    const outcome = await runScene(request(), {
      index,
      collaborators: {
        async draft() {
          return goodDraft(round === 0 ? "the quay above the treeline" : "the quay");
        },
        async review() {
          return round++ === 0 ? [llmFinding] : [];
        },
      },
    });
    assert.equal(outcome.status, "COMMITTED");
    assert.equal(outcome.attempts, 2);
  });

  it("lets a warning through without spending a repair round", async () => {
    const { index } = await freshIndex();
    const warning = makeFinding({
      subtype: "style_shifts",
      validator: "llm",
      severity: "warning",
      reasoning: "the register turns clinical",
      evidence: { quote: "She waited on the quay.", source: "s-011" },
      editLocus: { kind: "draft", quote: "She waited on the quay." },
    });
    const outcome = await runScene(request(), {
      index,
      collaborators: scripted({ drafts: [goodDraft()], reviews: [[warning]] }),
    });
    assert.equal(outcome.status, "COMMITTED");
    assert.equal(outcome.attempts, 1);
    assert.equal(outcome.findings.length, 1);
  });
});

describe("failures that are not the writer's fault", () => {
  it("aborts on a missing hard-required id and says not to let the writer infer it", async () => {
    const { index } = await freshIndex();
    const outcome = await runScene(
      request({
        packet: {
          sceneId: "s-011",
          baseCommitId: "commit-0",
          hardRequiredIds: ["scene-card", "world-rule-tides"],
          budgetWords: 500,
        },
      }),
      { index, collaborators: scripted({ drafts: [goodDraft()] }) },
    );
    assert.equal(outcome.status, "ABORTED");
    assert.match((outcome as { reason: string }).reason, /world-rule-tides/);
    assert.match((outcome as { reason: string }).reason, /do not let the writer infer them/);
  });

  it("aborts when the mandatory tiers cannot fit, rather than dropping a constraint", async () => {
    const { index } = await freshIndex();
    const outcome = await runScene(request({ packet: { ...request().packet, budgetWords: 3 } }), {
      index,
      collaborators: scripted({ drafts: [goodDraft()] }),
    });
    assert.equal(outcome.status, "ABORTED");
    assert.match((outcome as { reason: string }).reason, /mandatory tiers/);
  });

  it("rebuilds context on a stale base and refuses to retry the commit", async () => {
    const { index } = await freshIndex();
    // Someone else commits first, moving HEAD out from under us.
    await index.commit({
      txid: "tx-other",
      sceneId: "s-010",
      baseCommitId: "commit-0",
      actor: "index-manager",
      prose: { relPath: "manuscript/s-010.md", content: "elsewhere" },
      stateDelta: [{ relPath: "continuity/deltas/s-010.json", content: "{}" }],
    });

    const outcome = await runScene(request(), {
      index,
      collaborators: scripted({ drafts: [goodDraft()] }),
    });

    assert.equal(outcome.status, "STALE_BASE");
    assert.equal(
      (outcome as { newBaseCommitId: string }).newBaseCommitId,
      await index.head(),
    );
    assert.match((outcome as { reason: string }).reason, /do not retry the commit/);
    // Nothing of ours landed.
    await assert.rejects(readFile(path.join(index.root, "manuscript/s-011.md"), "utf8"));
  });

  it("always commits prose and delta as one unit, even when the scene changed nothing", async () => {
    const { index } = await freshIndex();
    const outcome = await runScene(request(), {
      index,
      collaborators: scripted({
        drafts: [
          { prose: "She waited.", delta: { sceneId: "s-011", claims: [], presentEntities: [] } },
        ],
      }),
    });

    assert.equal(outcome.status, "COMMITTED");
    // The index refuses a commit with no state delta at all. A scene that
    // established nothing still writes its (empty) delta, so the refusal is
    // reserved for the real bug it is meant to catch — a caller committing
    // prose without any delta — rather than firing on an inert scene.
    assert.deepEqual((outcome as { commit: { writtenPaths: readonly string[] } }).commit.writtenPaths, [
      "manuscript/s-011.md",
      "continuity/deltas/s-011.json",
    ]);
  });
});
