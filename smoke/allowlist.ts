/**
 * Build all five agents for real and check their tools against the personas.
 *
 * The check lives in the factory, which only runs when an agent is first
 * invoked — so a mismatch on the index-manager would surface partway through
 * the first scene of a live run, after the planning call has already been
 * spent. Constructing all five up front costs no tokens and moves that failure
 * to the second before a run starts.
 *
 *   YS_KEY=... node --experimental-strip-types smoke/allowlist.ts
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { toolNamesFor } from "../src/agents/personas.ts";
import { CanonicalIndex } from "../src/index/commit.ts";
import { AGENT_ROLES, initialiseProject } from "../src/index/tree.ts";
import { ArtifactStore } from "../src/runtime/artifacts.ts";
import { assembleHarness, defaultAgentsRoot } from "../src/runtime/assembly.ts";
import { TokenBudget, profileById, taskBudgetFor } from "../src/runtime/budget.ts";

const root = await mkdtemp(path.join(tmpdir(), "storyos-allowlist-"));
try {
  const projectRoot = path.join(root, "project");
  const index = new CanonicalIndex(projectRoot);
  await index.init("genesis");
  await initialiseProject(projectRoot, {
    premise: "a smoke test",
    targetWords: 1000,
    agentsRoot: defaultAgentsRoot(),
  });

  const profile = profileById("parity");
  const harness = await assembleHarness({
    index,
    artifacts: new ArtifactStore(projectRoot),
    projectRoot,
    agentsRoot: defaultAgentsRoot(),
    profile,
    budget: new TokenBudget(taskBudgetFor(profile, 1000)),
    targetWords: 1000,
    backbone: null,
    memoryRoot: projectRoot,
    runId: "smoke",
    log: () => {},
    transcriptSink: async () => {},
  });

  for (const role of AGENT_ROLES) {
    // Construction is where the allowlist is enforced; it throws on a mismatch.
    harness.residents.agent(role);
    console.log(`${role}: ${toolNamesFor(role).length} tools, allowlist agrees`);
  }
  console.log("PASS: every role's tools match its persona");
} finally {
  await rm(root, { recursive: true, force: true });
}
