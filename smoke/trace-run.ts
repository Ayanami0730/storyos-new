/**
 * Reconstruct one run, end to end, from what it left on disk.
 *
 * A run's own log says what happened in order; the summary says what it cost.
 * Neither answers the question that actually comes up when reading a finished
 * story: *for this scene, what did each agent see, do, and hand on?* Answering
 * that used to mean opening five transcripts and a summary side by side and
 * keeping the scene id in your head.
 *
 * Everything here is read from the run directory. Nothing is inferred, and
 * where a number is unavailable it says so rather than estimating.
 *
 *   node --experimental-strip-types smoke/trace-run.ts runs/lbw081/run
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

const runDir = path.resolve(process.argv[2] ?? "runs/lbw081/run");
const project = path.join(runDir, "project");

interface Ledger {
  role: string;
  txid: string;
  model: string;
  durationMs: number;
  toolCalls: number;
  contextTokens: number;
  stopReason?: string;
  errorMessage?: string;
  usage: { input: number; output: number; cacheRead: number; reasoning: number; total: number };
}

const readJson = async <T>(p: string): Promise<T | null> => {
  try {
    return JSON.parse(await readFile(p, "utf8")) as T;
  } catch {
    return null;
  }
};

const summary = (await readJson<Record<string, any>>(path.join(runDir, "summary.json"))) ?? {};
const plan = await readJson<Record<string, any>>(path.join(runDir, "plan.json"));
const ledger: Ledger[] = (await readFile(path.join(runDir, "ledger.jsonl"), "utf8"))
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l) as Ledger);

/** Tool calls per role per transaction, read from the transcripts. */
async function toolCalls(): Promise<Map<string, Map<string, number>>> {
  const out = new Map<string, Map<string, number>>();
  const root = path.join(project, "runtime/transcripts");
  let roles: string[] = [];
  try {
    roles = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return out;
  }
  for (const role of roles) {
    for (const file of await readdir(path.join(root, role))) {
      for (const line of (await readFile(path.join(root, role, file), "utf8")).split("\n")) {
        if (!line.trim()) continue;
        let m: any;
        try {
          m = JSON.parse(line);
        } catch {
          continue;
        }
        const txid = String(m.txid ?? "?");
        if (!Array.isArray(m.content)) continue;
        for (const block of m.content) {
          if (block?.type !== "toolCall") continue;
          const perTx = out.get(txid) ?? new Map<string, number>();
          const key = `${role}:${block.name}`;
          perTx.set(key, (perTx.get(key) ?? 0) + 1);
          out.set(txid, perTx);
        }
      }
    }
  }
  return out;
}

const calls = await toolCalls();
const fmt = (n: number) => n.toLocaleString("en-US");

console.log(`# Trajectory — ${path.basename(runDir)}\n`);

console.log("## What was asked\n");
const premise = await readFile(path.join(project, "novel/outline/premise.md"), "utf8").catch(
  () => "(no premise on disk)",
);
console.log(premise.trim(), "\n");

console.log("## Headline\n");
for (const [k, v] of [
  ["words", `${summary.words} (target ${summary.target_words}, attainment ${summary.attainment})`],
  ["scenes", `${summary.scenes_committed}/${summary.scenes_planned} committed`],
  ["unverified", String(summary.scenes_unverified ?? "n/a")],
  ["repair rounds", String(summary.repair_rounds)],
  ["findings", String(summary.findings_total)],
  ["tokens", `${fmt(summary.tokens ?? 0)} (budget ${fmt(summary.budget?.task_token_budget ?? 0)}, utilisation ${summary.budget?.utilisation})`],
  ["tokens/word", String(summary.budget?.tokens_per_output_word)],
  ["wall clock", `${Math.round((summary.elapsed_ms ?? 0) / 1000)}s`],
  ["model calls", String(summary.calls)],
  ["orchestrator drove", `${summary.driving?.stepsByOrchestrator} steps, engine rescued ${summary.driving?.stepsRescuedByEngine}`],
  ["follow-ups", String(summary.follow_ups?.total)],
  ["write gate", `${summary.sandbox?.id} (${summary.sandbox?.enforcement}), verified=${summary.sandbox?.gate_verified}`],
  ["compactions", String((summary.context?.compactions ?? []).length)],
  ["peak context", fmt(summary.context?.peak_context_tokens ?? 0)],
]) {
  console.log(`- **${k}**: ${v}`);
}

console.log("\n## The plan\n");
if (plan) {
  console.log(`Logline: ${plan.logline}\n`);
  console.log(`${plan.entities.length} entities, ${plan.worldRules.length} world rules.\n`);
  for (const s of plan.scenes) {
    console.log(`- \`${s.id}\` (${s.targetWords}w) — ${s.intent}`);
    console.log(`  present: ${s.presentEntities.join(", ") || "none"}`);
  }
}

console.log("\n## Per scene\n");
const byTx = new Map<string, Ledger[]>();
for (const e of ledger) {
  byTx.set(e.txid, [...(byTx.get(e.txid) ?? []), e]);
}
for (const [txid, entries] of byTx) {
  const tokens = entries.reduce((n, e) => n + e.usage.total, 0);
  const ms = entries.reduce((n, e) => n + e.durationMs, 0);
  console.log(`### ${txid} — ${entries.length} model call(s), ${fmt(tokens)} tokens, ${Math.round(ms / 1000)}s\n`);
  console.log("| role | model | tools | context | in | cacheRead | out | total | s | stop |");
  console.log("|---|---|---:|---:|---:|---:|---:|---:|---:|---|");
  for (const e of entries) {
    console.log(
      `| ${e.role} | ${e.model} | ${e.toolCalls} | ${fmt(e.contextTokens)} | ${fmt(e.usage.input)} | ` +
        `${fmt(e.usage.cacheRead)} | ${fmt(e.usage.output)} | ${fmt(e.usage.total)} | ` +
        `${Math.round(e.durationMs / 1000)} | ${e.stopReason ?? ""} |`,
    );
  }
  const perTx = calls.get(txid);
  if (perTx) {
    console.log(
      `\ntools: ${[...perTx].sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k}×${v}`).join(", ")}`,
    );
  }
  console.log();
}

console.log("## What the index gained\n");
console.log("| partition | files |");
console.log("|---|---:|");
for (const [k, v] of Object.entries(summary.index?.partitions ?? {})) {
  if ((v as number) > 0) console.log(`| \`${k}\` | ${v} |`);
}
console.log(`\nreferences: ${JSON.stringify(summary.index?.references)}`);
console.log(`dangling: ${(summary.index?.dangling ?? []).length}`);
console.log(`reads by role: ${JSON.stringify(summary.index?.reads_by_role)}`);

console.log("\n## Artefacts on disk\n");
for (const dir of [".context-builder/history", ".writer/drafts", ".verifier/audits", ".orchestrator"]) {
  const full = path.join(project, dir);
  const walk = async (p: string): Promise<string[]> => {
    const entries = await readdir(p, { withFileTypes: true }).catch(() => []);
    const out: string[] = [];
    for (const e of entries) {
      const child = path.join(p, e.name);
      if (e.isDirectory()) out.push(...(await walk(child)));
      else {
        const size = (await stat(child)).size;
        out.push(`${path.relative(project, child)} (${size}B)`);
      }
    }
    return out;
  };
  for (const f of await walk(full)) console.log(`- ${f}`);
}

console.log("\n## Memory and skills written\n");
console.log(JSON.stringify(summary.memory, null, 2));
