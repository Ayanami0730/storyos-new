/**
 * Reconstruct the context packet a scene was actually written against.
 *
 * Packet assembly is deterministic given the plan and the canon in force, and
 * both are on disk after a run — so a finished run can be replayed exactly
 * rather than described from the design doc. Transcripts are not yet persisted
 * (`docs/02` §8 wants `runtime/transcripts/`), and until they are this is the
 * only faithful way to see what the writer was told.
 *
 *   node --experimental-strip-types smoke/replay-packet.ts runs/v4-24k s-004
 */

import { readFile } from "node:fs/promises";
import path from "node:path";

import { buildContextPacket } from "../src/context/packet.ts";
import type { CanonFact, SceneDelta } from "../src/verification/deterministic.ts";
import { type StoryPlan, absorb, contextFor } from "../src/runtime/story.ts";

const [runDir, sceneId] = process.argv.slice(2);
if (!runDir || !sceneId) throw new Error("usage: replay-packet.ts <runDir> <sceneId>");

const plan = JSON.parse(await readFile(path.join(runDir, "plan.json"), "utf8")) as StoryPlan;
const target = plan.scenes.find((s) => s.id === sceneId);
if (!target) throw new Error(`${sceneId} is not in the plan`);

// Replay canon forward through the scenes that actually committed before this
// one. Uncommitted scenes contributed nothing, which is the point of the
// transaction: a rejected scene leaves canon exactly as it was.
let canon: readonly CanonFact[] = [];
const earlierIntents: string[] = [];
let previousProse: string | null = null;

for (const card of plan.scenes) {
  if (card.id === sceneId) break;
  const deltaPath = path.join(runDir, "project/index/story/continuity/deltas", `${card.id}.json`);
  try {
    const delta = JSON.parse(await readFile(deltaPath, "utf8")) as SceneDelta;
    canon = absorb(canon, card.id, delta);
    previousProse = await readFile(path.join(runDir, "project/manuscript", `${card.id}.md`), "utf8");
    earlierIntents.push(card.intent);
  } catch {
    earlierIntents.push(`${card.intent} [scene not completed]`);
  }
}

const packet = buildContextPacket(
  {
    sceneId,
    baseCommitId: (await readFile(path.join(runDir, "project/HEAD"), "utf8")).trim(),
    hardRequiredIds: ["scene-card", "logline"],
    budgetWords: 60_000,
  },
  contextFor({ card: target, plan, canon, previousProse, earlierIntents }),
);

console.log(packet.rendered);
const words = Object.values(packet.coverage.byPriority).reduce((n, p) => n + p.words, 0);
console.error(
  `\n--- coverage: ${packet.items.length} item(s), ${words} words, ` +
    `complete=${packet.coverage.complete}, canon facts in force=${canon.length}`,
);
