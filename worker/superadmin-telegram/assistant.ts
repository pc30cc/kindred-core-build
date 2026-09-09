import type { ServerConfig } from '../../server/config.js';
import { getServiceClient } from '../../server/supabase.js';
import { runtimeComplete, AiRuntimeError } from '../../server/services/ai/runtimeClient.js';
import type { AIConfig } from '../../shared/ai/types.js';
import type { OpsSnapshot } from './opsSnapshot.js';

const OPS_WORKSPACE_ID = '00000000-0000-4000-8000-000000000001';
const CONFIG_CACHE_MS = 5 * 60_000;

let cachedAi: { value: AIConfig | null; at: number } | null = null;

function envAiConfig(): AIConfig | null {
  const apiKey = process.env.SUPERADMIN_TELEGRAM_AI_API_KEY?.trim();
  if (!apiKey) return null;
  return {
    provider: process.env.SUPERADMIN_TELEGRAM_AI_PROVIDER?.trim() || 'openai',
    apiKey,
    model: process.env.SUPERADMIN_TELEGRAM_AI_MODEL?.trim() || 'gpt-4o-mini',
    maxTokens: Number(process.env.SUPERADMIN_TELEGRAM_AI_MAX_TOKENS || 1200) || 1200,
    temperature: Number(process.env.SUPERADMIN_TELEGRAM_AI_TEMPERATURE || 0.2),
    baseUrl: process.env.SUPERADMIN_TELEGRAM_AI_BASE_URL?.trim() || undefined,
    orgId: process.env.SUPERADMIN_TELEGRAM_AI_ORG_ID?.trim() || undefined,
  };
}

function parseGlobalDefault(raw: any): AIConfig | null {
  if (!raw || typeof raw !== 'object') return null;
  const provider = raw.provider || raw.provider_name || 'openai';
  const c = raw.config && typeof raw.config === 'object' ? raw.config : raw;
  if (!c.api_key) return null;
  return {
    provider,
    apiKey: c.api_key,
    model: c.model || 'gpt-4o-mini',
    maxTokens: c.max_tokens ? Number(c.max_tokens) : 1200,
    temperature: c.temperature != null ? Number(c.temperature) : 0.2,
    baseUrl: c.base_url || c.endpoint || undefined,
    orgId: c.org_id || undefined,
  };
}

async function resolveOpsAiConfig(config: ServerConfig): Promise<AIConfig | null> {
  const explicit = envAiConfig();
  if (explicit) return explicit;
  const now = Date.now();
  if (cachedAi && now - cachedAi.at < CONFIG_CACHE_MS) return cachedAi.value;
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('app_runtime_config')
      .select('value')
      .eq('key', 'default_ai_provider')
      .maybeSingle();
    const value = error ? null : parseGlobalDefault(data?.value);
    cachedAi = { value, at: now };
    return value;
  } catch {
    cachedAi = { value: null, at: now };
    return null;
  }
}

const SYSTEM_PROMPT = `You are the private technical operations assistant for the platform super-admin.
Answer in Persian unless the user explicitly asks for another language.
You are READ-ONLY. Never claim to have changed configuration, restarted a service, drained a node, executed SQL, or performed any write.
Use the live snapshot as observed evidence. Clearly distinguish observed facts from recommendations and estimates.
Never reveal, reconstruct, or ask for secrets, tokens, API keys, Redis passwords, service-role keys, or internal auth headers.
Do not invent benchmark capacity. If asked whether 100k/250k/500k/1M concurrent users fit, reason from the observed metrics and architecture, but say a production load test is required before asserting capacity.
Known architecture:
- PostgreSQL/Supabase stores durable/business state.
- Centrifugo is live realtime/presence truth when healthy.
- Redis/Valkey is ephemeral distributed coordination for multi-node realtime and the visitor candidate index.
- single_memory = one Centrifugo memory-engine node, no Redis required.
- app_routed_redis = browser gets a selected Centrifugo node; all nodes share Redis.
- load_balanced_redis = browser connects through one LB endpoint; nodes share Redis.
- Visitor presence uses per-session vp:v2 channels and batched presence_stats.
- Healthy realtime has zero periodic PostgreSQL liveness/candidacy writes.
- This Telegram bot persists no chat history, no app audit row, and no AI usage row. Telegram itself remains the transport and may retain chat messages according to Telegram's own behavior.
Be concise but technically specific. If evidence is insufficient, say exactly what measurement is missing.`;

export async function answerOpsQuestion(
  config: ServerConfig,
  question: string,
  snapshot: OpsSnapshot,
): Promise<string> {
  const ai = await resolveOpsAiConfig(config);
  if (!ai) {
    return 'AI برای این ربات تنظیم نشده است. SUPERADMIN_TELEGRAM_AI_API_KEY را در worker تنظیم کن، یا default_ai_provider را در تنظیمات سراسری AI داشته باش.';
  }
  try {
    const response = await runtimeComplete(config, ai, {
      workspaceId: OPS_WORKSPACE_ID,
      prompt: `Live snapshot:\n${JSON.stringify(snapshot)}\n\nQuestion:\n${question}`,
      systemPrompt: SYSTEM_PROMPT,
      model: ai.model,
      maxTokens: ai.maxTokens ?? 1200,
      temperature: ai.temperature ?? 0.2,
    });
    return response.text?.trim() || 'پاسخی از AI Runtime دریافت نشد.';
  } catch (err) {
    if (err instanceof AiRuntimeError) {
      return `AI Runtime در دسترس نیست یا درخواست را نپذیرفت. code=${err.code}`;
    }
    return 'در پاسخ فنی خطای موقت رخ داد.';
  }
}
