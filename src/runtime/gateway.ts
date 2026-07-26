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

  const modelDefs = Object.entries(MODELS).map(([id, limits]) => ({
    id,
    name: `${id} (yuanshi SG gateway)`,
    api: "openai-completions" as const,
    provider: PROVIDER_ID,
    baseUrl: GATEWAY_BASE_URL,
    reasoning: true,
    input: ["text"] as const,
    // The gateway publishes no verified per-model rates, so cost stays zero by
    // design rather than being guessed. Token counts are the real ledger.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    ...limits,
  }));

  const provider = createProvider({
    id: PROVIDER_ID,
    name: "YuanShi Singapore gateway",
    baseUrl: GATEWAY_BASE_URL,
    auth: { apiKey: envApiKeyAuth("YuanShi gateway key", ["YS_KEY"]) },
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
    model: (id: ModelId) =>
      (models as never as { getModel: Function }).getModel(PROVIDER_ID, id),
  };
  return installed;
}

/** For tests that need a clean process-level state. */
export function resetGatewayForTesting(): void {
  installed = null;
}
