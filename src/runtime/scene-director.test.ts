/**
 * What the director must guarantee, now that a model can call its steps.
 *
 * The deterministic driver could not call a step out of order, so nothing had
 * to stop it. `orchestratorTools` exposes the same steps to a model that can
 * call anything at any time, and every guarantee the design rests on — prose
 * and delta land together, only index-manager commits, the repair budget is
 * bounded — now depends on a refusal rather than on control flow. These are
 * those refusals.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import type { ContextItem } from "../context/types.ts";
import { CanonicalIndex } from "../index/commit.ts";
import type { CanonFact } from "../verification/deterministic.ts";
import { makeFinding } from "../verification/finding.ts";
import { allocate } from "./allocation.ts";
import { ArtifactStore, artifactPaths } from "./artifacts.ts";
import type { ContextGap } from "./packet-builder.ts";
import { SceneStage, driveScene, orchestratorTools } from "./orchestration.ts";
import { SceneDirector } from "./scene-director.ts";
import { runScene } from "./scene-loop.ts";
import {
  type Draft,
  type SceneCollaborators,
  type SceneRequest,
  VerificationUnavailable,
} from "./scene-loop.ts";

const roots: string[] = [];
after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

async function freshIndex() {
  const root = await mkdtemp(path.join(tmpdir(), "storyos-director-"));
  roots.push(root);
  const index = new CanonicalIndex(root);
  await index.init("commit-0");
  return { root, index, artifacts: new ArtifactStore(root) };
}

const AVAILABLE: readonly ContextItem[] = [
  {
    id: "scene-card",
    priority: "P0",
    source: "novel/chapters/ch-01/chapter.yaml",
    content: "Mira waits for the warden and he does not come.",
  },
];

const CANON: readonly CanonFact[] = [
  { id: "fact-eyes", entity: "char-mira", attribute: "eye_colour", value: "grey", source: "s-003" },
];

function request(overrides: Partial<SceneRequest> = {}): SceneRequest {
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
    knownEntities: new Set(["char-mira"]),
    allocation: allocate({ sceneIndex: 1, total: 1, pinnedRepairs: 2 }),
    prosePath: "novel/chapters/ch-01/scenes/s-011.md",
    ...overrides,
  };
}

function goodDraft(prose = "She waited on the quay."): Draft {
  return {
    prose,
    delta: {
      sceneId: "s-011",
      presentEntities: ["char-mira"],
      claims: [
        { entity: "char-mira", attribute: "mood", value: "impatient", quote: prose },
      ],
    },
  };
}

function collaborators(options: {
  drafts?: Draft[];
  reviews?: (readonly import("../transaction/types.ts").Finding[])[];
  build?: readonly ContextItem[];
  gaps?: readonly ContextGap[];
} = {}): SceneCollaborators & {
  notes: (string | undefined)[];
  gapsSeen: (readonly ContextGap[] | undefined)[];
} {
  const notes: (string | undefined)[] = [];
  const gapsSeen: (readonly ContextGap[] | undefined)[] = [];
  let draftIndex = 0;
  let reviewIndex = 0;
  return {
    notes,
    gapsSeen,
    async build({ note }) {
      notes.push(note);
      return { items: options.build ?? [], gaps: options.gaps ?? [] };
    },
    async draft({ note, gaps }) {
      notes.push(note);
      gapsSeen.push(gaps);
      const drafts = options.drafts ?? [goodDraft()];
      return drafts[Math.min(draftIndex++, drafts.length - 1)]!;
    },
    async review({ note }) {
      notes.push(note);
      return options.reviews?.[reviewIndex++] ?? [];
    },
  };
}

const blockingFinding = () =>
  makeFinding({
    subtype: "appearance_mismatches",
    validator: "llm",
    severity: "error",
    reasoning: "her eyes were grey in s-003",
    evidence: { quote: "her green eyes", source: "s-011" },
    contradicts: { quote: "eye_colour: grey", source: "s-003" },
    editLocus: { kind: "draft", quote: "her green eyes" },
  });

describe("steps refuse to run out of order", () => {
  it("will not draft before context is built, and names the legal call", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });

    const drafted = await director.draft();
    assert.equal(drafted.ok, false);
    assert.match(drafted.text, /no packet yet/);
    // Naming the legal call is the load-bearing half. An agent told only "no"
    // retries the same call, and each retry is a whole turn.
    assert.match(drafted.text, /call_context_builder/);
    assert.equal(director.state, "OPEN");
  });

  it("will not verify a scene with no fresh draft", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });
    await director.buildContext();

    const verified = await director.verify();
    assert.equal(verified.ok, false);
    assert.match(verified.text, /call_writer/);
    assert.equal(director.state, "CONTEXT_BUILT");
  });

  it("will not commit a scene the verifier has not approved", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });
    await director.buildContext();
    await director.draft();

    const committed = await director.commit();
    assert.equal(committed.ok, false);
    assert.match(committed.text, /only an approved scene/);
    // Nothing landed. This is the guarantee that used to be held by the shape
    // of a for-loop and is now held by a refusal.
    await assert.rejects(index.read("novel/chapters/ch-01/scenes/s-011.md"));
  });

  it("will not rebuild context for a scene that already has it", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });
    await director.buildContext();
    const again = await director.buildContext();
    assert.equal(again.ok, false);
    assert.match(again.text, /already been built/);
  });
});

describe("steps report what they produced", () => {
  it("writes the packet to disk and returns the path that resolves", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });

    const built = await director.buildContext();
    assert.equal(built.ok, true);
    assert.deepEqual(built.paths, [artifactPaths.packet("s-011")]);
    assert.equal(director.packetPath, artifactPaths.packet("s-011"));
    // The path in a report has to be a path that resolves, or the next caller
    // is being handed a citation to nothing — the defect that had the verifier
    // grepping for `index/story/bible/` files that never existed.
    const onDisk = await artifacts.read(built.paths[0]!);
    assert.match(onDisk!, /Mira waits for the warden/);
  });

  it("stages the draft without committing it, and says so", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });
    await director.buildContext();
    const drafted = await director.draft();

    assert.equal(drafted.ok, true);
    assert.match(drafted.text, /Nothing is committed yet/);
    assert.equal(await artifacts.read(artifactPaths.draft("s-011")), "She waited on the quay.");
    await assert.rejects(index.read("novel/chapters/ch-01/scenes/s-011.md"));
  });

  it("writes an audit per attempt and points the repair at it", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators({
        drafts: [goodDraft("her green eyes"), goodDraft("her grey eyes")],
        reviews: [[blockingFinding()], []],
      }),
    });
    await director.buildContext();
    await director.draft();
    const first = await director.verify();

    assert.equal(director.state, "REPAIR_REQUIRED");
    assert.deepEqual(first.paths, [artifactPaths.audit("s-011", 1)]);
    const audit = await artifacts.read(artifactPaths.audit("s-011", 1));
    assert.match(audit!, /Blocking: 1/);

    await director.draft();
    await director.verify();
    // A second attempt gets its own audit rather than overwriting the first.
    assert.notEqual(await artifacts.read(artifactPaths.audit("s-011", 2)), null);
    assert.equal(director.state, "APPROVED");
  });

  it("passes the orchestrator's brief to the specialist it is meant for", async () => {
    const { index, artifacts } = await freshIndex();
    const collabs = collaborators();
    const director = new SceneDirector(request(), { index, artifacts, collaborators: collabs });

    await director.buildContext("keep the fog out of it");
    await director.draft("short sentences");

    assert.deepEqual(collabs.notes, ["keep the fog out of it", "short sentences"]);
  });
});

describe("gaps the index could not fill", () => {
  const gaps: readonly ContextGap[] = [
    { need: "what the warden tower looks like inside", searched: "locations/, novel/chapters/" },
    { need: "whether Senna and Jun have met before", searched: "relations/, events/timeline.jsonl" },
  ];

  it("carries them from the build to the writer", async () => {
    const { index, artifacts } = await freshIndex();
    const collabs = collaborators({ gaps });
    const director = new SceneDirector(request(), { index, artifacts, collaborators: collabs });

    await director.buildContext();
    await director.draft();

    // The failure this fixes: three runs, zero follow-up questions, with the
    // tool registered and the prompt describing it at length. A packet presents
    // itself as complete, so there was nothing to ask about — the gaps only
    // became visible at the moment the writer filled one in.
    assert.deepEqual(collabs.gapsSeen[0], gaps);
  });

  it("puts them in the packet file, so a re-read still shows them", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators({ gaps }),
    });
    await director.buildContext();

    const packet = (await artifacts.read(artifactPaths.packet("s-011")))!;
    assert.match(packet, /What the index does not have/);
    assert.match(packet, /whether Senna and Jun have met before/);
    // Where the builder looked, so the writer does not send it back over the
    // same ground.
    assert.match(packet, /events\/timeline\.jsonl/);
  });

  it("tells the orchestrator how many went unfilled", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators({ gaps }),
    });
    const built = await director.buildContext();
    assert.match(built.text, /2 gap\(s\)/);
  });

  it("says nothing when the index had everything", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });
    await director.buildContext();
    // A gap section with no gaps in it is noise in the one place attention is
    // most expensive.
    const packet = (await artifacts.read(artifactPaths.packet("s-011")))!;
    assert.doesNotMatch(packet, /What the index does not have/);
  });
});

describe("a verifier that produced nothing", () => {
  /** Collaborators whose review reports that the layer could not be run. */
  function unavailable(): SceneCollaborators {
    return {
      async draft() {
        return goodDraft();
      },
      async review(): Promise<readonly import("../transaction/types.ts").Finding[]> {
        throw new VerificationUnavailable("zero output tokens, twice");
      },
    };
  }

  it("commits the scene rather than losing sound prose to a provider failure", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: unavailable(),
    });
    await director.buildContext();
    await director.draft();
    await director.verify();
    await director.commit();

    // The deterministic layer did run. Throwing away a clean draft because the
    // model verifier's socket died is the worse trade.
    assert.equal(director.state, "COMMITTED");
  });

  it("records that the scene was never checked, instead of reporting it clean", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: unavailable(),
    });
    await director.buildContext();
    await director.draft();
    const verified = await director.verify();
    await director.commit();

    const outcome = director.outcome() as {
      status: string;
      unverified: boolean;
      warnings: readonly string[];
    };
    // This is the failure that fails *open*: no findings means no blockers
    // means approved, so an absent verifier produces a flawless-looking scene.
    // "0 findings" must never be the only thing the run remembers about it.
    assert.equal(outcome.unverified, true);
    assert.match(outcome.warnings.join(" "), /never reached the model verifier/);
    assert.match(verified.text, /unchecked rather than clean/);
  });

  it("marks a normally verified scene as verified", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });
    await director.buildContext();
    await director.draft();
    await director.verify();
    await director.commit();
    assert.equal((director.outcome() as { unverified: boolean }).unverified, false);
  });
});

describe("the orchestrator's tools", () => {
  function toolMap(stage: SceneStage) {
    const tools = orchestratorTools(stage) as {
      name: string;
      description: string;
      execute: (id: string, args: Record<string, string>) => Promise<{
        content: { text: string }[];
      }>;
    }[];
    return new Map(tools.map((t) => [t.name, t]));
  }

  const textOf = (result: { content: { text: string }[] }) => result.content[0]!.text;

  it("exposes one call per specialist, and the commit is index-manager's", () => {
    const tools = toolMap(new SceneStage());
    assert.deepEqual(
      [...tools.keys()].sort(),
      [
        "abandon_scene",
        "call_context_builder",
        "call_index_manager",
        "call_verifier",
        "call_writer",
      ],
    );
    // There is no separate commit tool, because there is no separate commit:
    // index-manager is the only actor that may produce COMMITTED, so the
    // delegation and the transition are the same call.
    assert.match(tools.get("call_index_manager")!.description, /commit/i);
  });

  it("runs sequentially, because each call is a transition on one transaction", () => {
    // pi's default is parallel. An orchestrator emitting `call_writer` and
    // `call_verifier` in one message would have the verifier reading a draft
    // while the writer is still producing it, through a buffer they share — and
    // the state checks cannot catch it, because two calls that begin together
    // both see the state before either.
    for (const tool of orchestratorTools(new SceneStage()) as {
      name: string;
      executionMode?: string;
    }[]) {
      assert.equal(tool.executionMode, "sequential", `${tool.name} may not run in parallel`);
    }
  });

  it("refuses every call when no scene is open", async () => {
    const tools = toolMap(new SceneStage());
    for (const name of ["call_writer", "call_verifier", "abandon_scene"]) {
      const out = await tools.get(name)!.execute("id", { brief: "x", reason: "x" });
      assert.match(textOf(out), /no scene is open/);
    }
  });

  it("routes a call to the open scene and reports the state back", async () => {
    const { index, artifacts } = await freshIndex();
    const stage = new SceneStage();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });
    stage.open(director);

    const out = await toolMap(stage)
      .get("call_context_builder")!
      .execute("id", { brief: "first scene of the book" });

    assert.match(textOf(out), /context built for s-011/);
    // Every reply ends with where the scene stands and what is legal next, so
    // the model never has to remember the state machine.
    assert.match(textOf(out), /Scene state: CONTEXT_BUILT/);
    assert.match(textOf(out), /Next: call_writer/);
    assert.deepEqual(stage.steps(), [{ scene: "s-011", step: "context-builder", ok: true }]);
  });

  it("refuses to abandon a scene without a reason", async () => {
    const { index, artifacts } = await freshIndex();
    const stage = new SceneStage();
    stage.open(
      new SceneDirector(request(), { index, artifacts, collaborators: collaborators() }),
    );
    const out = await toolMap(stage).get("abandon_scene")!.execute("id", { reason: "  " });
    // An abandoned scene with no reason is a hole in the manuscript that
    // nothing can explain later.
    assert.match(textOf(out), /reason is required/);
  });
});

describe("the engine finishes what the orchestrator leaves", () => {
  /** A stand-in orchestrator that runs a scripted number of steps and stops. */
  function residentsThatDrive(steps: number, stage: SceneStage) {
    return {
      invoke: async () => {
        const order = ["buildContext", "draft", "verify", "commit"] as const;
        for (let i = 0; i < steps; i += 1) {
          const director = stage.director!;
          await director[order[i]!]();
          stage.note(director.sceneId, order[i]!, true);
        }
        return { text: "did what I could", ledger: {} };
      },
    } as unknown as import("../agents/residents.ts").ResidentAgents;
  }

  it("commits a scene the orchestrator drove all the way, rescuing nothing", async () => {
    const { index, artifacts } = await freshIndex();
    const stage = new SceneStage();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });

    const run = await driveScene({
      residents: residentsThatDrive(4, stage),
      stage,
      director,
      brief: "run it",
      txid: "tx-1",
      maxNudges: 0,
    });

    assert.equal(run.outcome.status, "COMMITTED");
    assert.equal(run.orchestratorSteps, 4);
    assert.equal(run.rescuedSteps, 0);
  });

  it("finishes an approved scene the orchestrator never committed", async () => {
    const { index, artifacts } = await freshIndex();
    const stage = new SceneStage();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });

    // Three steps: built, drafted, verified — approved and then abandoned mid-air.
    const run = await driveScene({
      residents: residentsThatDrive(3, stage),
      stage,
      director,
      brief: "run it",
      txid: "tx-1",
      maxNudges: 0,
    });

    // Losing an approved scene because nobody called the commit would corrupt
    // the only number that matters with a failure that has nothing to do with
    // writing.
    assert.equal(run.outcome.status, "COMMITTED");
    assert.equal(run.orchestratorSteps, 3);
    assert.equal(run.rescuedSteps, 1);
    assert.match(await index.read("novel/chapters/ch-01/scenes/s-011.md"), /waited on the quay/);
  });

  it("writes the whole scene when the orchestrator does nothing at all", async () => {
    const { index, artifacts } = await freshIndex();
    const stage = new SceneStage();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });

    const run = await driveScene({
      residents: residentsThatDrive(0, stage),
      stage,
      director,
      brief: "run it",
      txid: "tx-1",
      maxNudges: 0,
    });

    assert.equal(run.outcome.status, "COMMITTED");
    assert.equal(run.orchestratorSteps, 0);
    // Four rescued steps is the old engine-driven behaviour exactly, which is
    // the point: agent-driven orchestration can fail without the novel failing.
    assert.equal(run.rescuedSteps, 4);
  });

  it("still finishes the scene when the orchestrator's own turn throws", async () => {
    const { index, artifacts } = await freshIndex();
    const stage = new SceneStage();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });
    const exploding = {
      invoke: async () => {
        throw new Error("gateway said no");
      },
    } as unknown as import("../agents/residents.ts").ResidentAgents;

    const run = await driveScene({
      residents: exploding,
      stage,
      director,
      brief: "run it",
      txid: "tx-1",
      maxNudges: 0,
    });

    assert.equal(run.outcome.status, "COMMITTED");
    assert.match(run.account, /gateway said no/);
  });

  it("does not resurrect a scene the orchestrator deliberately abandoned", async () => {
    const { index, artifacts } = await freshIndex();
    const stage = new SceneStage();
    const director = new SceneDirector(request(), {
      index,
      artifacts,
      collaborators: collaborators(),
    });
    const abandoning = {
      invoke: async () => {
        stage.director!.abandon("the premise does not support this scene");
        return { text: "gave up", ledger: {} };
      },
    } as unknown as import("../agents/residents.ts").ResidentAgents;

    const run = await driveScene({
      residents: abandoning,
      stage,
      director,
      brief: "run it",
      txid: "tx-1",
      maxNudges: 0,
    });

    // The rescue exists for a model that lost the thread, not for one that made
    // a decision. Overriding a deliberate abandonment would make the tool a lie.
    assert.equal(run.outcome.status, "ABORTED");
    assert.equal(run.rescuedSteps, 0);
    assert.match(
      (run.outcome as { reason: string }).reason,
      /premise does not support this scene/,
    );
  });
});

/**
 * A writer turn that produced nothing at all, as opposed to one that produced
 * something defective.
 *
 * Measured on `lbw103`: the writer's opening call hit a provider content filter,
 * the director aborted the transaction on that first failure, and when the
 * orchestrator sensibly called `call_writer` again it was refused because the
 * transaction it was retrying into no longer existed. A quarter of that
 * manuscript was lost to one refused turn with the scene's whole repair
 * allowance unspent.
 */
describe("a failed writer turn costs an attempt, not the scene", () => {
  function flaky(failures: number): SceneCollaborators {
    let calls = 0;
    return {
      async draft() {
        calls += 1;
        if (calls <= failures) {
          throw new Error("400 content_filter: the request was refused by the provider");
        }
        return goodDraft();
      },
      async review() {
        return [];
      },
    };
  }

  it("leaves the scene draftable and says how many attempts are left", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(
      request({ allocation: allocate({ sceneIndex: 1, total: 1, pinnedRepairs: 2 }) }),
      { index, artifacts, collaborators: flaky(1) },
    );
    await director.buildContext();

    const failed = await director.draft();
    assert.equal(failed.ok, false);
    assert.equal(director.isTerminal(), false, "the scene must survive a refused turn");
    // The state has to still admit the retry, or "call_writer is legal again" is
    // a claim the next call disproves.
    assert.equal(director.state, "CONTEXT_BUILT");
    assert.equal(director.nextStep(), "call_writer");
    assert.match(failed.text, /NOT lost/);
    assert.match(failed.text, /attempt 1 of 3/);
    // And the advice is specific to the failure class, because retrying a content
    // filter with the same request fails the same way.
    assert.match(failed.text, /content filter|change what you ask/i);

    const second = await director.draft();
    assert.equal(second.ok, true, "the retry goes through");
    assert.equal(director.state, "STATE_DELTA_PROPOSED");
  });

  it("aborts once the failures have used the scene's whole allowance", async () => {
    const { index, artifacts } = await freshIndex();
    const director = new SceneDirector(
      // One repair round means two writer attempts in total, so the third failure
      // is the one that ends it. A writer that produces nothing gets exactly as
      // many chances as a writer that produces something defective.
      request({ allocation: allocate({ sceneIndex: 1, total: 1, pinnedRepairs: 1 }) }),
      { index, artifacts, collaborators: flaky(99) },
    );
    await director.buildContext();

    assert.equal((await director.draft()).ok, false);
    assert.equal(director.isTerminal(), false);
    const last = await director.draft();
    assert.equal(last.ok, false);
    assert.equal(director.isTerminal(), true);
    assert.match((director.outcome() as { reason: string }).reason, /whole allowance/);
  });

  it("the deterministic driver retries too, rather than giving up on a live scene", async () => {
    const { index, artifacts } = await freshIndex();
    // The engine fallback must not be strictly worse than the orchestrator at
    // this: a rescue that abandons a retryable failure would turn a transient
    // provider refusal into a lost scene whenever the orchestrator stopped early.
    const outcome = await runScene(
      request({ allocation: allocate({ sceneIndex: 1, total: 1, pinnedRepairs: 2 }) }),
      { index, artifacts, collaborators: flaky(2) },
    );
    assert.equal(outcome.status, "COMMITTED");
  });
});
