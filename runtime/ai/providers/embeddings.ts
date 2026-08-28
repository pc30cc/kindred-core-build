/**
 * Embedding generation against OpenAI-compatible providers.
 *
 * Runs ONLY inside the AI Runtime deployable — Core sends texts + a resolved
 * provider config and receives vectors back; it never contacts the provider.
 */
import { redactSecrets } from '../../../server/lib/redactSecrets.js';
import { PROVIDER_BASE_URLS, isOpenAICompatible } from './catalog.js';
import { requestJsonWithRetry } from './executor.js';
import { readProviderErrorMessage } from '../../../shared/ai/parse.js';
import type { HttpFetch } from '../../../shared/ai/types.js';

export interface EmbedProviderConfig {
  provider: string;
  apiKey: string;
  model: string;
  baseUrl?: string;
  orgId?: string;
}

/** Batches are already sized by the caller; this keeps one request per call. */
export async function embedTexts(
  cfg: EmbedProviderConfig,
  texts: string[],
  fetchImpl?: HttpFetch,
): Promise<number[][]> {
  if (!texts.length) return [];
  if (!isOpenAICompatible(cfg.provider)) {
    throw new Error(`embedding_provider_unsupported: ${cfg.provider}`);
  }
  const baseUrl = cfg.baseUrl || PROVIDER_BASE_URLS[cfg.provider] || PROVIDER_BASE_URLS.openai;

  const res = await requestJsonWithRetry(
    `${baseUrl}/embeddings`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.apiKey}`,
        'Content-Type': 'application/json',
        ...(cfg.orgId ? { 'OpenAI-Organization': cfg.orgId } : {}),
      },
      body: JSON.stringify({ model: cfg.model, input: texts }),
    },
    2,
    undefined,
    fetchImpl,
  );

  if (!res.ok) {
    throw new Error(
      `embedding_provider_error: ${redactSecrets(readProviderErrorMessage(res.data) || res.statusText)}`,
    );
  }

  const rows = ((res.data as any)?.data as any[]) || [];
  return rows.map((row) => (row?.embedding as number[]) || []);
}
