/**
 * Talking to the YuanShi gateway from pi.
 *
 * Two things here are not obvious and cost hours the first time
 * (`FOUNDATION.md` gotchas 1 and 2), so they are encoded once rather than
 * rediscovered per entry point.
 *
 * The gateway has **no Responses API** — `POST /v1/responses` is 404 for every
 * model — while pi's built-in `openaiProvider()` hardcodes
 * `api: "openai-responses"`. Swapping `baseUrl` alone therefore cannot work; the
 * provider has to be registered from scratch pinned to `openai-completions`.
 *
 * And `Agent` needs its stream function routed at the `Models` collection or
 * construction throws `No default stream function configured`.
 */

import { setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import { createModels, createProvider, envApiKeyAuth } from "@earendil-works/pi-ai";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";

export const GATEWAY_BASE_URL = "https://ai-prod-sg.wenxiaobai.com/v1";
export const PROVIDER_ID = "yuanshi-sg";

/**
 * Where the models are actually bought, when the default supply will not sell.
 *
 * The YuanShi gateway is the reference route and stays the default: every
 * baseline in both tables was generated through it, so changing it silently
 * would make our rows incomparable with theirs on an axis nobody declared.
 *
 * It is also, on measurement, not always available. In one morning it produced a
 * forty-minute `401 Invalid token` window that truncated three runs to
 * attainment 0.05–0.06, and then sustained `429 … swedencentral has exceeded
 * rate limit` that killed four more during planning — at concurrency **2**. The
 * quota is not ours alone; another lane on the same machine draws on the same
 * `gpt-5-mini` group, so the ceiling is whatever is left over rather than a
 * number we can plan against.
 *
 * The alternate route is the same model over an OpenAI-compatible endpoint.
 * Probed at rising concurrency it took 1, 2, 4 and 8 parallel requests with
 * **zero failures** and flat latency (p50 3.5–5.0s, which is the primary
 * gateway's own p50); at 12 and 16 the median doubled to ~7.5s while throughput
 * stopped rising, so eight is the knee and the reason the launcher caps there.
 *
 * Selected by environment rather than by a flag, because it has to reach the
 * provider registration that happens before any argument is parsed. Which route
 * a run used is recorded in its summary — an undeclared supply change is exactly
 * the kind of thing that makes two numbers look comparable when they are not.
 */
export interface Supply {
  readonly id: string;
  readonly name: string;
  readonly baseUrl: string;
  readonly keyEnv: readonly string[];
  /**
   * What this route calls a model, when that differs from what we call it.
   *
   * The `openai/…` route is a different upstream group behind the same host, and
   * the name is how you reach it: with the key unchanged, `openai/gpt-5-mini`
   * answers 200 while plain `gpt-5-mini` answers
   * `当前分组上游负载已饱和` on both the public and the internal address.
   * Kept as a mapping rather than a rename so `summary.json`, the tables and the
   * personas all keep saying `gpt-5-mini`, which is the model that actually ran.
   */
  readonly modelNames?: Readonly<Record<string, string>>;
}

export const SUPPLIES: Readonly<Record<string, Supply>> = {
  yuanshi: {
    id: PROVIDER_ID,
    name: "YuanShi Singapore gateway",
    baseUrl: GATEWAY_BASE_URL,
    keyEnv: ["YS_KEY"],
  },
  zzz: {
    id: "zhizengzeng",
    name: "zhizengzeng (OpenAI-compatible)",
    baseUrl: "https://api.zhizengzeng.com/v1",
    keyEnv: ["ZZZ_KEY"],
  },
  /**
   * The second zhizengzeng key. The first is out of credit
   * (`quota_not_enough`, "亲，余额不足哦~") and answers nothing.
   *
   * Slower than either YuanShi route and with a nearer knee: zero failures at 4, 8
   * and 16 parallel requests, but p50 4.6–5.9s against ys2's 3.0s and throughput
   * peaking at 8 (1.13 req/s) before p90 goes to 20s at 16. So it is the third
   * lane, sized at 8, not a substitute for the first two.
   */
  zzz2: {
    id: "zhizengzeng-2",
    name: "zhizengzeng (second key)",
    baseUrl: "https://api.zhizengzeng.com/v1",
    keyEnv: ["ZZZ_KEY2"],
  },
  /**
   * The same gateway and the same key, on an upstream group that is not full.
   *
   * Probed with 4, 8, 16, 24 and 32 parallel requests: **zero failures at every
   * level and a flat p50 of 3.0–3.7s**. 429s begin at 48 (1 of 48), reach 16 of
   * 64 and 36 of 96, while throughput plateaus around 3.8 req/s throughout — so
   * past 32 the extra workers buy errors rather than work, and 32 is the number
   * to plan against. That is four times what the old group tolerated on the day
   * it was measured, when concurrency 2 was killing runs outright.
   */
  ys2: {
    id: "yuanshi-sg-openai",
    name: "YuanShi SG gateway (openai/ group, internal)",
    baseUrl: "https://ai-prod-sg-internal.wenxiaobai.com/v1",
    keyEnv: ["YS_KEY"],
    modelNames: { "gpt-5-mini": "openai/gpt-5-mini" },
  },
  /**
   * The same `openai/` group on the public address, for splitting a fleet.
   *
   * Added when two benchmarks needed to run at once and `zzz` had gone to
   * `quota_not_enough`. Probed while ~60 of our own runs were already drawing on
   * `ys2`: 8/8 and 16/16 with zero failures and p50 2.8–2.9s, which is `ys2`'s own
   * p50 — so it is at least not the same queue at the same depth. The plain
   * `gpt-5-mini` group on this address is a different matter and stays unused: it
   * returned 429 on 1 of 4 parallel requests and 5 of 8.
   */
  ys3: {
    id: "yuanshi-sg-openai-public",
    name: "YuanShi SG gateway (openai/ group, public)",
    baseUrl: GATEWAY_BASE_URL,
    keyEnv: ["YS_KEY"],
    modelNames: { "gpt-5-mini": "openai/gpt-5-mini" },
  },
};

/** The route this process will use. `STORYOS_SUPPLY=zzz` to switch. */
export function selectedSupply(env: NodeJS.ProcessEnv = process.env): Supply {
  const wanted = env.STORYOS_SUPPLY?.trim() || "yuanshi";
  const supply = SUPPLIES[wanted];
  if (!supply) {
    throw new Error(
      `STORYOS_SUPPLY=${JSON.stringify(wanted)} is not a known route; ` +
        `expected one of ${Object.keys(SUPPLIES).join(", ")}`,
    );
  }
  return supply;
}

/**
 * Per HTTP request. Well above the slowest legitimate single call we have
 * measured and well below the twenty-plus minutes a stalled socket will happily
 * wait, which is the failure this exists for.
 */
export const REQUEST_TIMEOUT_MS = 300_000;

/**
 * Attempts for a single HTTP request, and the waits between them.
 *
 * Deliberately quicker and more numerous than the turn-level schedule. A turn
 * retry rewinds and re-runs everything, so it can afford to wait a minute; a
 * request retry is resuming one call inside a tool loop that may have thirty of
 * them, so what it needs is to get through soon. Six attempts over ~30s covers
 * the bursty contention we measured — probing a rate-limited channel directly
 * returned `200, 429, 429`, roughly one request in three — while staying well
 * inside the per-turn watchdog.
 */
export const REQUEST_ATTEMPTS = 6;
export const REQUEST_BACKOFF_MS: readonly number[] = [500, 1_500, 3_000, 6_000, 12_000];

/**
 * Worth asking again, or not.
 *
 * Kept separate from the turn-level classifier because the strings differ: this
 * one sees transport and provider errors as thrown by the stream, where the
 * other reads what pi wrote into a failed assistant message. Both lists come
 * from real failure text rather than from imagining what a failure might say —
 * the first version of the other one matched `timeout` and missed
 * `Request timed out.`
 */
export function isRetryableRequestError(message: string): boolean {
  return /\b(408|429|5\d\d)\b|rate.?limit|rate_limit|too_many_requests|resource exhausted|负载已饱和|overloaded|time(?:d)?[\s_-]*out|terminated|ECONNRESET|ETIMEDOUT|EAI_AGAIN|socket hang up|fetch failed/i.test(
    message,
  );
}

/**
 * Models verified against the gateway on 2026-07-25 by direct probe, not from
 * documentation. `gpt-5.5-mini` and every `-high` / `-medium` suffixed name
 * return 503 `model_not_found`, and `o4-mini` returns 404 — do not add them
 * back without re-probing.
 */
export const MODELS = {
  /** Main-table backbone. Every published number of ours so far used this. */
  "gpt-5-mini": { contextWindow: 400_000, maxTokens: 128_000 },
  /** The second backbone arm, for the "newer model, more agentic" comparison. */
  "gpt-5.6-terra": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.6-sol": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.6-luna": { contextWindow: 400_000, maxTokens: 128_000 },
  "gpt-5.5": { contextWindow: 400_000, maxTokens: 128_000 },
  /**
   * Cross-family, and that is the point: a verifier drawn from the same family
   * as the writer shares its blind spots, and a judge from the same family as
   * the backbone is grading itself.
   */
  "gemini-3.1-pro-preview": { contextWindow: 1_000_000, maxTokens: 65_536 },
} as const;

export type ModelId = keyof typeof MODELS;

export interface GatewayHandle {
  readonly models: ReturnType<typeof createModels>;
  model(id: ModelId): unknown;
}

let installed: GatewayHandle | null = null;

/**
 * Install the provider once per process.
 *
 * Idempotent because every agent construction path wants a model and none of
 * them should care whether it is first.
 */
export function installGateway(): GatewayHandle {
  if (installed) return installed;

  const supply = selectedSupply();
  // Register under the name the route answers to; `model()` below translates on
  // the way in, so nothing outside this file has to know the difference.
  const wireName = (id: string) => supply.modelNames?.[id] ?? id;
  const modelDefs = Object.entries(MODELS).map(([id, limits]) => ({
    id: wireName(id),
    name: `${id} (${supply.name})`,
    api: "openai-completions" as const,
    provider: supply.id,
    baseUrl: supply.baseUrl,
    reasoning: true,
    input: ["text"] as const,
    // The gateway publishes no verified per-model rates, so cost stays zero by
    // design rather than being guessed. Token counts are the real ledger.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...limits,
  }));

  const provider = createProvider({
    id: supply.id,
    name: supply.name,
    baseUrl: supply.baseUrl,
    auth: { apiKey: envApiKeyAuth(`${supply.name} key`, supply.keyEnv as string[]) },
    models: modelDefs as never,
    api: openAICompletionsApi(),
  });

  const models = createModels();
  models.setProvider(provider as never);
  setDefaultStreamFn(async (m, context, options) => {
    /**
     * Retry the request itself, underneath the turn-level retry.
     *
     * Two layers, because they catch different things. The turn-level retry in
     * `ResidentAgents` sees a *finished* turn that pi recorded as failed, and its
     * cure is to rewind the transcript and ask again — correct, and expensive,
     * since it discards a whole turn's work. This one sees a single request fail
     * and simply asks again, which is what a 429 on the fourth of thirty tool
     * calls actually needs.
     *
     * Without it, one rate-limited call in the middle of a long tool loop threw
     * the whole turn away. That was most of what went wrong on the run where the
     * gateway was degraded: scenes aborted after ten minutes of successful work
     * because a single request in the middle of them came back 429.
     */
    let lastError: unknown;
    for (let attempt = 1; attempt <= REQUEST_ATTEMPTS; attempt += 1) {
      try {
        return await (models as never as { stream: Function }).stream(m, context, {
          // pi documents `timeoutMs` as honoured only by providers that support
          // it, and whether this gateway's completions path does is unverified —
          // so this is the cheap fast path, not the guarantee. The guarantee is
          // the watchdog in `ResidentAgents`.
          timeoutMs: REQUEST_TIMEOUT_MS,
          ...(options as object),
        });
      } catch (error) {
        lastError = error;
        const message = error instanceof Error ? error.message : String(error);
        if (attempt >= REQUEST_ATTEMPTS || !isRetryableRequestError(message)) throw error;
        const wait = REQUEST_BACKOFF_MS[attempt - 1] ?? 8_000;
        // Jittered, so several agents that hit the same quota window do not wake
        // together and collide again on every attempt.
        await new Promise((r) => setTimeout(r, Math.round(wait * (0.75 + Math.random() * 0.5))));
      }
    }
    throw lastError;
  });

  installed = {
    models,
    // Look the model up under the provider that was actually registered, not
    // under the default one. Registering as `zhizengzeng` and then fetching
    // `yuanshi-sg` is how every run on the alternate route died at its first
    // turn with `Unknown provider: unknown`.
    model: (id: ModelId) =>
      (models as never as { getModel: Function }).getModel(supply.id, wireName(id)),
  };
  return installed;
}

/** For tests that need a clean process-level state. */
export function resetGatewayForTesting(): void {
  installed = null;
}
