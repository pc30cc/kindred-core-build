/**
 * OpenAI-compatible embedding provider — Core side.
 *
 * PROVIDER NETWORK ISOLATION: Core does not call the embeddings endpoint.
 * It batches the texts and forwards them to the AI Runtime, which owns the
 * provider socket (runtime/ai/providers/embeddings.ts).
 *
 * Uses the same workspace AI provider config (OpenAI / Azure OpenAI / Ollama
 * / OpenRouter / etc) so admins don't have to configure embeddings separately.
 * If the configured provider isn't OpenAI-compatible, callers fall back to noop.
 */
import type { ServerConfig } from '../../../config.js';
import type { EmbeddingProvider, EmbedOptions } from './provider.js';
import { EMBED_BATCH_SIZE, clipForEmbedding } from './provider.js';
import { runtimeEmbed } from '../../ai/runtimeClient.js';
import { recordStepUsage } from '../../ai-billing/runContext.js';
import { normalizeUsage } from '../../ai-billing/normalize.js';

/**
 * Providers speaking the OpenAI embeddings wire format. Kept as plain names —
 * no endpoint hostnames live in Core; the runtime owns the endpoint catalog.
 */
const OPENAI_COMPATIBLE = new Set([
  'openai',
  'azure_openai',
  'groq',
  'together',
  'mistral',
  'deepseek',
  'openrouter',
  'ollama',
]);

export interface OpenAIEmbeddingResolved {
  provider: string;
  apiKey: string;
  /** Optional operator-configured endpoint; the runtime applies defaults. */
  baseUrl?: string;
  model: string;
  orgId?: string;
  /** Who supplied baseUrl (see AIConfig.endpointScope); drives runtime SSRF policy. */
  endpointScope?: 'workspace' | 'platform';
  dimensions: number;
}

export function isOpenAICompatible(providerName: string): boolean {
  return OPENAI_COMPATIBLE.has(providerName);
}

export function buildOpenAIEmbeddingProvider(
  serverConfig: ServerConfig,
  cfg: OpenAIEmbeddingResolved,
): EmbeddingProvider {
  return {
    name: cfg.provider,
    model: cfg.model,
    dimensions: cfg.dimensions,
    async embedTexts(texts: string[], opts?: EmbedOptions): Promise<number[][]> {
      if (!texts.length) return [];
      const out: number[][] = [];
      const cleaned = texts.map((t) => clipForEmbedding(t, opts?.truncateChars));
      let attemptNo = 0;
      for (let i = 0; i < cleaned.length; i += EMBED_BATCH_SIZE) {
        const batch = cleaned.slice(i, i + EMBED_BATCH_SIZE);
        attemptNo += 1;
        const vectors = await runtimeEmbed(
          serverConfig,
          {
            provider: cfg.provider,
            apiKey: cfg.apiKey,
            model: cfg.model,
            baseUrl: cfg.baseUrl,
            orgId: cfg.orgId,
            endpointScope: cfg.endpointScope,
          },
          batch,
        );
        out.push(...vectors);

        // AI billing — embeddings are billable provider work. The runtime
        // embed endpoint returns no usage block, so the token count is
        // estimated (~4 chars/token) and the event is flagged ESTIMATED.
        if (opts?.runCtx) {
          const chars = batch.reduce((n, t) => n + t.length, 0);
          const usage = normalizeUsage({
            provider: cfg.provider,
            requestedModel: cfg.model,
            actualModel: cfg.model,
            promptTokens: Math.max(1, Math.ceil(chars / 4)),
            kind: 'embedding',
            estimatedUsage: true,
            raw: { batchSize: batch.length, chars },
          });
          try {
            await recordStepUsage(serverConfig, opts.runCtx, {
              stepKind: 'EMBEDDING',
              attemptNo,
              usage,
            });
          } catch (err) {
            // METER_ONLY: usage is best-effort observability, never block on
            // it. ENFORCED: a Run only reaches here after reserveForRun()
            // already confirmed a rate card and a funded wallet, so a
            // failure here is a real anomaly (e.g. the card was unpublished
            // mid-run) — swallowing it would grant this embedding for free
            // with no audit trail, so it must propagate and fail the caller.
            if (opts.runCtx.mode === 'ENFORCED') throw err;
            console.warn('[ai-billing] embedding usage not recorded:', (err as any)?.message);
          }
        }
      }
      return out;
    },
  };
}
