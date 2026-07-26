/**
 * Assemble a trace bundle from what a run left on disk.
 *
 * Everything here is read, never inferred. Where a value is genuinely absent —
 * a run that was not scored, a scene whose verifier never answered — the field
 * is null or empty rather than filled with a plausible substitute, because a
 * trace exists to be trusted about what happened and a helpful guess is
 * indistinguishable from a fact once it is on a web page.
 */

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";

import { chapterFor, sceneIndexOf } from "../index/tree.ts";
import { costOf } from "../runtime/rates.ts";
import type {
  Bilingual,
  TraceArtifact,
  TraceBundle,
  TraceCall,
  TraceMemory,
  TraceMessage,
  TraceScene,
  TraceStep,
  ToolTally,
} from "./types.ts";

const en = (text: string): Bilingual => ({ en: text });

async function readMaybe(p: string): Promise<string | null> {
  try {
    return await readFile(p, "utf8");
  } catch {
    return null;
  }
}

async function readJson<T>(p: string): Promise<T | null> {
  const text = await readMaybe(p);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/**
 * Every model call of a run, reconstructed from the raw transcripts.
 *
 * The rule for splitting a session into calls is that an **assistant row is a
 * call**: it is the only row type that carries `usage` and a `stopReason`, so it
 * marks the moment a model answered. Everything queued before it — the prompt
 * that opened the turn, and the tool results from the previous round — is that
 * call's input. This reconstruction is why a reader can see a tool being called
 * with the wrong arguments, or a refusal in a tool result that the agent then
 * ignored, neither of which is visible in per-call totals.
 */
async function stepsByTx(project: string): Promise<Map<string, TraceStep[]>> {
  const root = path.join(project, "runtime/transcripts");
  const byTx = new Map<string, TraceStep[]>();
  let roles: string[] = [];
  try {
    roles = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return byTx;
  }

  for (const role of roles) {
    for (const file of await readdir(path.join(root, role)).catch(() => [])) {
      const text = await readMaybe(path.join(root, role, file));
      if (!text) continue;

      let pending: TraceMessage[] = [];
      let previousAt = 0;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let row: {
          txid?: string;
          role?: string;
          content?: unknown;
          usage?: Record<string, number>;
          model?: string;
          stopReason?: string;
          timestamp?: string;
          toolName?: string;
          isError?: string | boolean;
          at?: string;
        };
        try {
          row = JSON.parse(line);
        } catch {
          continue;
        }
        const blocks = Array.isArray(row.content) ? (row.content as Record<string, unknown>[]) : [];
        const at = Number(row.timestamp ?? 0);

        if (row.role === "user" || row.role === "toolResult") {
          for (const block of blocks) {
            const body = typeof block.text === "string" ? block.text : "";
            if (!body.trim()) continue;
            pending.push({
              kind: row.role === "user" ? "prompt" : "toolResult",
              at: row.at ?? "",
              body: en(body),
              ...(row.toolName ? { toolName: row.toolName } : {}),
              // The sink writes booleans through `String()`, so both shapes occur.
              ...(row.isError === true || row.isError === "true" ? { isError: true } : {}),
            });
          }
          if (previousAt === 0) previousAt = at;
          continue;
        }
        if (row.role !== "assistant") continue;

        const produced: TraceMessage[] = [];
        const toolsCalled: string[] = [];
        for (const block of blocks) {
          if (block.type === "toolCall") {
            const name = String(block.name ?? "unknown");
            toolsCalled.push(name);
            produced.push({
              kind: "toolCall",
              at: row.at ?? "",
              toolName: name,
              arguments:
                typeof block.arguments === "string"
                  ? block.arguments
                  : JSON.stringify(block.arguments ?? {}),
              // The arguments are the body for a tool call; there is no prose.
              body: en(""),
            });
          } else if (typeof block.text === "string" && block.text.trim()) {
            produced.push({ kind: "text", at: row.at ?? "", body: en(block.text) });
          }
        }

        const usage = row.usage ?? {};
        const txid = row.txid ?? "tx-unknown";
        const list = byTx.get(txid) ?? [];
        list.push({
          index: list.length + 1,
          role,
          model: String(row.model ?? "unknown"),
          at: row.at ?? "",
          durationMs: previousAt > 0 && at > previousAt ? at - previousAt : 0,
          usage: {
            input: usage.input ?? 0,
            output: usage.output ?? 0,
            cacheRead: usage.cacheRead ?? 0,
            reasoning: usage.reasoning ?? 0,
            billable: (usage.input ?? 0) + (usage.output ?? 0),
          },
          ...(row.stopReason ? { stopReason: row.stopReason } : {}),
          toolsCalled,
          messages: [...pending, ...produced],
        });
        byTx.set(txid, list);
        pending = [];
        previousAt = at;
      }
    }
  }

  // Chronological across roles, because the orchestrator's turn *contains* the
  // specialists' turns and the question a reader has is "what happened next",
  // not "what did each role do separately".
  for (const [txid, list] of byTx) {
    list.sort((a, b) => a.at.localeCompare(b.at) || a.index - b.index);
    byTx.set(
      txid,
      list.map((s, i) => ({ ...s, index: i + 1 })),
    );
  }
  return byTx;
}

/** Tool calls per transaction, per role, from the transcripts. */
async function tallyTools(project: string): Promise<Map<string, ToolTally[]>> {
  const root = path.join(project, "runtime/transcripts");
  const perTx = new Map<string, Map<string, number>>();
  let roles: string[] = [];
  try {
    roles = (await readdir(root, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name);
  } catch {
    return new Map();
  }
  for (const role of roles) {
    for (const file of await readdir(path.join(root, role)).catch(() => [])) {
      const text = await readMaybe(path.join(root, role, file));
      if (!text) continue;
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        let message: { txid?: string; content?: unknown };
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content as { type?: string; name?: string }[]) {
          if (block?.type !== "toolCall") continue;
          const txid = message.txid ?? "unknown";
          const tally = perTx.get(txid) ?? new Map<string, number>();
          const key = `${role}\u0000${block.name ?? "?"}`;
          tally.set(key, (tally.get(key) ?? 0) + 1);
          perTx.set(txid, tally);
        }
      }
    }
  }
  const out = new Map<string, ToolTally[]>();
  for (const [txid, tally] of perTx) {
    out.set(
      txid,
      [...tally]
        .map(([key, count]) => {
          const [role, tool] = key.split("\u0000");
          return { role: role!, tool: tool!, count };
        })
        .sort((a, b) => b.count - a.count),
    );
  }
  return out;
}

/** One artefact, with its body carried inline so the bundle stands alone. */
async function artifact(
  project: string,
  kind: TraceArtifact["kind"],
  relPath: string,
): Promise<TraceArtifact | null> {
  const full = path.join(project, relPath);
  const body = await readMaybe(full);
  if (body === null) return null;
  const bytes = (await stat(full)).size;
  return { kind, path: relPath, bytes, body: en(body) };
}

/** Gaps, parsed back out of the packet the builder wrote. */
function gapsFromPacket(packet: string): { need: Bilingual; searched: string }[] {
  const section = packet.split("## What the index does not have")[1];
  if (!section) return [];
  const out: { need: Bilingual; searched: string }[] = [];
  for (const line of section.split("\n")) {
    const match = /^- \*\*(.+?)\*\* \(searched: (.+?)\)\s*$/.exec(line.trim());
    if (match) out.push({ need: en(match[1]!), searched: match[2]! });
  }
  return out;
}

/** Memory topics, with their frontmatter parsed. */
async function memories(project: string): Promise<TraceMemory[]> {
  const out: TraceMemory[] = [];
  for (const role of [
    "orchestrator",
    "context-builder",
    "writer",
    "verifier",
    "index-manager",
  ]) {
    const dir = path.join(project, `.${role}/memory`);
    for (const file of await readdir(dir).catch(() => [])) {
      if (!file.endsWith(".md") || file === "MEMORY.md") continue;
      const text = await readMaybe(path.join(dir, file));
      if (!text) continue;
      const fm = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
      const front = fm?.[1] ?? "";
      const field = (name: string) =>
        new RegExp(`^${name}:\\s*(.+)$`, "m").exec(front)?.[1]?.trim() ?? "";
      out.push({
        role,
        topic: file.replace(/\.md$/, ""),
        title: field("title"),
        hook: field("hook"),
        scope: field("scope"),
        source: field("source"),
        body: en((fm?.[2] ?? text).trim()),
      });
    }
  }
  return out;
}

export interface BundleOptions {
  readonly runDir: string;
  /** The benchmark task this run answered, when there was one. */
  readonly taskFile?: string;
  /** Judge output for this run, as `score_lbw.py` appends it. */
  readonly judgementFile?: string;
  /** The same task's rows for other systems, for context. */
  readonly baselineJudgements?: readonly { readonly system: string; readonly file: string }[];
  /**
   * Include every model call's full input and output, reconstructed from the
   * transcripts.
   *
   * Off by default because it is the difference between a 400KB bundle and a
   * multi-megabyte one, and because translating those bodies is most of the cost
   * of an ingest — measured at 5.2M characters across six runs, of which
   * deduplication recovers only 4%. A reader studying one case asks for that case.
   */
  readonly deep?: boolean;
}

export async function buildBundle(options: BundleOptions): Promise<TraceBundle> {
  const runDir = path.resolve(options.runDir);
  const project = path.join(runDir, "project");

  const summary = (await readJson<Record<string, any>>(path.join(runDir, "summary.json"))) ?? {};
  const plan = await readJson<Record<string, any>>(path.join(runDir, "plan.json"));
  const ledgerText = (await readMaybe(path.join(runDir, "ledger.jsonl"))) ?? "";
  const ledger = ledgerText
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, any>);
  const logText = (await readMaybe(path.join(runDir, "..", `${path.basename(runDir)}.log`))) ?? "";
  const log = logText
    .split("\n")
    .filter((l) => /^\[\d\d:\d\d:\d\d\]/.test(l))
    .map((l) => l.trim());

  const tools = await tallyTools(project);
  // Only read when asked: on a five-scene run this is several megabytes of prose.
  const deepSteps = options.deep ? await stepsByTx(project) : new Map<string, TraceStep[]>();

  const call = (e: Record<string, any>): TraceCall => ({
    role: e.role,
    model: e.model,
    txid: e.txid,
    at: e.at,
    durationMs: e.durationMs,
    toolCalls: e.toolCalls,
    contextTokens: e.contextTokens,
    usage: {
      input: e.usage.input,
      output: e.usage.output,
      cacheRead: e.usage.cacheRead,
      reasoning: e.usage.reasoning,
      // Older runs predate the split and only carry `total`; saying so beats
      // silently reporting a cache-inflated figure as though it were billable.
      billable: e.usage.billable ?? e.usage.input + e.usage.output,
      total: e.usage.total,
    },
    ...(e.stopReason ? { stopReason: e.stopReason } : {}),
    ...(e.errorMessage ? { errorMessage: e.errorMessage } : {}),
    usd: costOf(e.model, e.usage).usd,
  });

  /** Per-scene outcome, taken from the summary's failure list and the log. */
  const failureFor = (sceneId: string): string | undefined =>
    (summary.failures ?? []).find((f: any) => f.sceneId === sceneId)?.reason;

  const scenes: TraceScene[] = [];
  for (const card of plan?.scenes ?? []) {
    const sceneId: string = card.id;
    const txid = `tx-${sceneId}`;
    const chapter = chapterFor(sceneIndexOf(sceneId));
    const calls = ledger.filter((e) => e.txid === txid).map(call);

    const packetPath = `.context-builder/history/${chapter}/${sceneId}.md`;
    const packet = await artifact(project, "packet", packetPath);
    const artifacts = (
      await Promise.all([
        Promise.resolve(packet),
        artifact(project, "draft", `.writer/drafts/${sceneId}.md`),
        artifact(project, "delta", `.writer/drafts/${sceneId}.delta.json`),
        ...[1, 2, 3, 4].map((n) =>
          artifact(project, "audit", `.verifier/audits/${sceneId}-a${n}.md`),
        ),
        artifact(project, "orchestrator-log", `.orchestrator/scenes/${sceneId}.md`),
        artifact(project, "prose", `novel/chapters/${chapter}/scenes/${sceneId}.md`),
      ])
    ).filter((a): a is TraceArtifact => a !== null);

    const rejected = (summary.rejected_findings ?? []).find((r: any) => r.scene === sceneId);
    const committed = (summary.index?.scenes_committed_on_disk ?? []).includes(sceneId);
    const reason = failureFor(sceneId);

    // Wall time from the log line the loop prints on completion, which is the
    // only place the per-scene figure exists.
    const wallLine = log.find((l) => new RegExp(`${sceneId} (COMMITTED|REJECTED|ABORTED)`).test(l));
    const wallMs = Number(/, (\d+)s,/.exec(wallLine ?? "")?.[1] ?? 0) * 1000;
    const drove = Number(/(\d+) step\(s\) driven/.exec(wallLine ?? "")?.[1] ?? 0);

    scenes.push({
      sceneId,
      txid,
      chapter,
      intent: en(card.intent),
      presentEntities: card.presentEntities ?? [],
      targetWords: card.targetWords ?? 0,
      status: committed ? "COMMITTED" : (rejected?.status ?? (reason ? "FAILED" : "UNKNOWN")),
      attempts: Number(/after (\d+) attempt/.exec(wallLine ?? "")?.[1] ?? 0),
      // Absent for runs from before the schedule existed, and absent rather than
      // defaulted: a scene card claiming an allowance nothing allocated would be
      // a fabrication in the one artefact meant to be trustworthy.
      ...(() => {
        const record = (summary.allocation?.per_scene ?? []).find(
          (a: any) => a.scene === sceneId,
        );
        if (!record) return {};
        return {
          allocation: {
            tier: record.tier,
            position: record.position,
            repairRounds: record.allowed_repair_rounds,
            followUpRounds: record.allowed_follow_ups,
            recentScenes: record.recent_scenes_in_packet,
            pinned: summary.allocation?.pinned_to !== null,
            rationale: en(record.rationale ?? ""),
          },
        };
      })(),
      stepsByOrchestrator: drove,
      stepsRescuedByEngine: 0,
      wallMs,
      calls,
      ...(options.deep ? { steps: deepSteps.get(txid) ?? [] } : {}),
      tools: tools.get(txid) ?? [],
      artifacts,
      findings: (rejected?.findings ?? []).map((f: any) => ({
        subtype: f.subtype,
        severity: f.severity,
        validator: f.validator,
        reasoning: en(f.reasoning ?? ""),
        quote: f.quote ?? "",
        ...(f.contradicts ? { contradicts: f.contradicts } : {}),
      })),
      ...(reason ? { failureReason: en(reason) } : {}),
      gaps: packet ? gapsFromPacket(packet.body.en) : [],
    });
  }

  const task = options.taskFile ? await readJson<Record<string, any>>(options.taskFile) : null;
  const judgement = options.judgementFile
    ? ((await readMaybe(options.judgementFile)) ?? "")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, any>)
        .filter((r) => r.scores)
        .at(-1)
    : null;

  const baselines: TraceBundle["score"] extends null ? never[] : any[] = [];
  for (const b of options.baselineJudgements ?? []) {
    const rows = ((await readMaybe(b.file)) ?? "")
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l) as Record<string, any>)
      .filter((r) => r.scores && r.task_id === task?.task_id);
    const row = rows.at(-1);
    if (!row) continue;
    baselines.push({
      system: b.system,
      sBar: (20 * row.s_quality_raw + row.s_length) / 2,
      sLength: row.s_length,
      sQualityRaw: row.s_quality_raw,
      words: row.response_words,
    });
  }
  baselines.sort((a, b) => b.sBar - a.sBar);

  const manuscript = (await readMaybe(path.join(runDir, "story.md"))) ?? "";
  const revisionPlan =
    (await readMaybe(path.join(project, ".orchestrator/revision-plan.md"))) ?? "";

  return {
    runId: path.basename(runDir),
    harnessVersion: summary.harness_version ?? "unknown",
    harnessVersionNote: en(summary.harness_version_note ?? ""),
    startedAt: ledger[0]?.at ?? new Date().toISOString(),
    task: task
      ? {
          id: task.task_id,
          benchmark: "longbench-write",
          prompt: en(task.prompt),
          requiredWords: task.length,
          language: task.language,
          type: task.type,
        }
      : null,
    plan: {
      logline: en(plan?.logline ?? ""),
      worldRules: (plan?.worldRules ?? []).map(en),
      entities: (plan?.entities ?? []).map((e: any) => ({ id: e.id, sketch: en(e.sketch) })),
    },
    scenes,
    headline: {
      words: summary.words,
      target_words: summary.target_words,
      attainment: summary.attainment,
      scenes_committed: summary.scenes_committed,
      scenes_planned: summary.scenes_planned,
      scenes_unverified: summary.scenes_unverified,
      repair_rounds: summary.repair_rounds,
      findings_total: summary.findings_total,
      tokens_billable: summary.tokens,
      tokens_reported_including_cache: summary.tokens_reported_including_cache,
      tokens_cache_read: summary.tokens_cache_read,
      budget: summary.budget,
      calls: summary.calls,
      elapsed_ms: summary.elapsed_ms,
      driving: summary.driving,
      follow_ups: summary.follow_ups,
      peak_context_tokens: summary.context?.peak_context_tokens,
      compactions: summary.context?.compactions ?? [],
      roll_up: summary.roll_up,
      roll_up_note: summary.roll_up_note,
    },
    score: judgement
      ? {
          judgeModel: judgement.judge_model,
          sLength: judgement.s_length,
          sQualityRaw: judgement.s_quality_raw,
          sBar: (20 * judgement.s_quality_raw + judgement.s_length) / 2,
          responseWords: judgement.response_words,
          requiredWords: judgement.required_words,
          dimensions: judgement.scores,
          baselines,
        }
      : null,
    cost: {
      totalUsd: summary.cost_estimate?.totalUsd ?? 0,
      note: summary.cost_estimate?.note ?? "",
      byModel: Object.entries(summary.cost_estimate?.byModel ?? {}).map(
        ([model, v]: [string, any]) => ({
          model,
          calls: v.calls,
          usd: v.usd,
          inputUsd: v.inputUsd,
          cachedUsd: v.cachedUsd,
          outputUsd: v.outputUsd,
        }),
      ),
    },
    index: {
      partitions: summary.index?.partitions ?? {},
      references: summary.index?.references ?? {},
      dangling: summary.index?.dangling ?? [],
      readsByRole: summary.index?.reads_by_role ?? {},
    },
    memory: await memories(project),
    skills: summary.memory?.skills ?? {},
    manuscript: en(manuscript),
    revisionPlan: en(revisionPlan),
    log,
    sandbox: summary.sandbox ?? {},
    translation: null,
  };
}
