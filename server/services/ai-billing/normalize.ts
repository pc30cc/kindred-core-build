/**
 * THE single parser of AI Runtime usage output.
 *
 * Everything downstream — the immutable `ai_usage_events` rows AND the legacy
 * `ai_usage_logs` analytics projection — is derived from the object produced
 * here. There is deliberately no second parser anywhere in the codebase.
 */

export type UsageComponentType =
  | 'INPUT_TOKENS'
  | 'CACHED_INPUT_TOKENS'
  | 'OUTPUT_TOKENS'
  | 'REASONING_TOKENS'
  | 'EMBEDDING_TOKENS'
  | 'REQUEST';

export interface NormalizedComponent {
  componentType: UsageComponentType;
  quantity: string;
  unit: 'TOKEN' | 'REQUEST';
}

export interface NormalizedUsage {
  provider: string;
  requestedModel: string | null;
  actualModel: string | null;
  components: NormalizedComponent[];
  /** Legacy projection fields (ai_usage_logs). */
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  latencyMs: number;
  /** True when the provider reported no usage at all (charge is ESTIMATED). */
  estimated: boolean;
  raw: unknown;
}

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
}

export interface NormalizeInput {
  provider: string;
  requestedModel?: string | null;
  actualModel?: string | null;
  promptTokens?: number | null;
  completionTokens?: number | null;
  totalTokens?: number | null;
  cachedInputTokens?: number | null;
  reasoningTokens?: number | null;
  latencyMs?: number | null;
  kind?: 'completion' | 'embedding';
  raw?: unknown;
}

export function normalizeUsage(input: NormalizeInput): NormalizedUsage {
  const prompt = num(input.promptTokens);
  const completion = num(input.completionTokens);
  const cached = Math.min(num(input.cachedInputTokens), prompt);
  const reasoning = num(input.reasoningTokens);
  const total = num(input.totalTokens) || prompt + completion;
  const components: NormalizedComponent[] = [];

  if (input.kind === 'embedding') {
    if (prompt || total) {
      components.push({
        componentType: 'EMBEDDING_TOKENS',
        quantity: String(prompt || total),
        unit: 'TOKEN',
      });
    }
  } else {
    const billableInput = prompt - cached;
    if (billableInput > 0) {
      components.push({ componentType: 'INPUT_TOKENS', quantity: String(billableInput), unit: 'TOKEN' });
    }
    if (cached > 0) {
      components.push({ componentType: 'CACHED_INPUT_TOKENS', quantity: String(cached), unit: 'TOKEN' });
    }
    if (completion > 0) {
      components.push({ componentType: 'OUTPUT_TOKENS', quantity: String(completion), unit: 'TOKEN' });
    }
    if (reasoning > 0) {
      components.push({ componentType: 'REASONING_TOKENS', quantity: String(reasoning), unit: 'TOKEN' });
    }
  }

  if (components.length === 0) {
    components.push({ componentType: 'REQUEST', quantity: '1', unit: 'REQUEST' });
  }

  return {
    provider: input.provider,
    requestedModel: input.requestedModel ?? null,
    actualModel: input.actualModel ?? null,
    components,
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: total,
    latencyMs: num(input.latencyMs),
    estimated: prompt === 0 && completion === 0 && total === 0,
    raw: input.raw ?? null,
  };
}
