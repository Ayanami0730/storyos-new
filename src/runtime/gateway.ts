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
  setDefaultStreamFn((m, context, options) =>
    (models as never as { stream: Function }).stream(m, context, {
      // Belt and braces with the turn watchdog in `ResidentAgents`. pi documents
      // `timeoutMs` as honoured only by providers that support it, and whether
      // this gateway's completions path does is unverified — so this is the
      // cheap fast path, not the guarantee. The guarantee is the watchdog.
      timeoutMs: REQUEST_TIMEOUT_MS,
      ...(options as object),
    }),
  );

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
