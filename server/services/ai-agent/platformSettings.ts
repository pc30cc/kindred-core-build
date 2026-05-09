/**
 * E12 — Platform-wide AI Agent settings service.
 *
 * Singleton-row config that controls global kill-switch + advanced/QA tool
 * visibility + per-feature enable flags. Managed exclusively via the Super
 * Admin Control Center; workspace UI must read the redacted capability
 * snapshot via getWorkspaceAiAgentCapabilities.
 *
 * SELF-HOSTED. PROVIDER-AGNOSTIC (no provider internals leak to clients).
 * Defaults to fully-enabled when the row is missing so an empty self-host
 * deployment still works out of the box.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { isGlobalAdmin } from '../../middleware/adminBypass.js';

export interface PlatformAiAgentSettings {
  id: string;
  ai_agent_enabled: boolean;
  customer_ai_agent_visible: boolean;
  advanced_tools_enabled: boolean;
  regression_runner_enabled: boolean;
  source_health_visible_to_customers: boolean;
  test_harness_visible_to_customers: boolean;
  operator_assist_enabled: boolean;
  auto_answer_enabled: boolean;
  learning_enabled: boolean;
  files_enabled: boolean;
  websites_enabled: boolean;
  qna_enabled: boolean;
  kb_enabled: boolean;
  max_customer_visible_nav_items: number;
  disabled_message: string | null;
  metadata: Record<string, unknown>;
  created_at: string;
  updated_at: string;
}

const DEFAULTS: Omit<PlatformAiAgentSettings, 'id' | 'created_at' | 'updated_at'> = {
  ai_agent_enabled: true,
  customer_ai_agent_visible: true,
  advanced_tools_enabled: false,
  regression_runner_enabled: false,
  source_health_visible_to_customers: false,
  test_harness_visible_to_customers: false,
  operator_assist_enabled: true,
  auto_answer_enabled: true,
  learning_enabled: true,
  files_enabled: true,
  websites_enabled: true,
  qna_enabled: true,
  kb_enabled: true,
  max_customer_visible_nav_items: 6,
  disabled_message: null,
  metadata: {},
};

/** Fields permitted in PATCH bodies. Any other key is ignored. */
const PATCHABLE_KEYS = new Set<keyof PlatformAiAgentSettings>([
  'ai_agent_enabled',
  'customer_ai_agent_visible',
  'advanced_tools_enabled',
  'regression_runner_enabled',
  'source_health_visible_to_customers',
  'test_harness_visible_to_customers',
  'operator_assist_enabled',
  'auto_answer_enabled',
  'learning_enabled',
  'files_enabled',
  'websites_enabled',
  'qna_enabled',
  'kb_enabled',
  'max_customer_visible_nav_items',
  'disabled_message',
]);

const CACHE_TTL_MS = 15_000;
let cache: { value: PlatformAiAgentSettings; ts: number } | null = null;

function applyDefaults(row: Partial<PlatformAiAgentSettings>): PlatformAiAgentSettings {
  const now = new Date().toISOString();
  return {
    id: row.id || 'default',
    created_at: row.created_at || now,
    updated_at: row.updated_at || now,
    ...DEFAULTS,
    ...row,
    metadata: (row.metadata as any) || {},
  } as PlatformAiAgentSettings;
}

export async function getPlatformAiAgentSettings(
  config: ServerConfig,
): Promise<PlatformAiAgentSettings> {
  const now = Date.now();
  if (cache && now - cache.ts < CACHE_TTL_MS) return cache.value;

  let value: PlatformAiAgentSettings;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('platform_ai_agent_settings' as any)
      .select('*')
      .limit(1)
      .maybeSingle();
    value = applyDefaults((data as any) || {});
  } catch {
    value = applyDefaults({});
  }
  cache = { value, ts: now };
  return value;
}

export function __resetPlatformAiAgentSettingsCache(): void {
  cache = null;
}

export async function updatePlatformAiAgentSettings(
  config: ServerConfig,
  patch: Partial<PlatformAiAgentSettings>,
  actorUserId: string,
): Promise<PlatformAiAgentSettings> {
  const ok = await isGlobalAdmin(config, actorUserId);
  if (!ok) throw new Error('forbidden');

  const sanitized: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch || {})) {
    if (!PATCHABLE_KEYS.has(k as any)) continue;
    sanitized[k] = v;
  }
  if (Object.keys(sanitized).length === 0) {
    return getPlatformAiAgentSettings(config);
  }
  sanitized.updated_at = new Date().toISOString();

  const sb = getServiceClient(config);
  const current = await getPlatformAiAgentSettings(config);

  // Upsert by id when present, else insert a fresh singleton row.
  if (current.id && current.id !== 'default') {
    const { error } = await sb
      .from('platform_ai_agent_settings' as any)
      .update(sanitized)
      .eq('id', current.id);
    if (error) throw new Error(error.message);
  } else {
    const { error } = await sb
      .from('platform_ai_agent_settings' as any)
      .insert([{ ...DEFAULTS, ...sanitized }]);
    if (error) throw new Error(error.message);
  }

  __resetPlatformAiAgentSettingsCache();
  return getPlatformAiAgentSettings(config);
}

/** Redacted capability snapshot intended for workspace customers. */
export interface WorkspaceAiAgentCapabilities {
  ai_agent_enabled: boolean;
  customer_ai_agent_visible: boolean;
  operator_assist_enabled: boolean;
  auto_answer_enabled: boolean;
  learning_enabled: boolean;
  files_enabled: boolean;
  websites_enabled: boolean;
  qna_enabled: boolean;
  kb_enabled: boolean;
  customer_nav: {
    overview: boolean;
    knowledge: boolean;
    behavior: boolean;
    operatorAssist: boolean;
    activity: boolean;
    settings: boolean;
  };
  advanced: {
    debug_visible: boolean;
    regression_visible: boolean;
    source_health_visible: boolean;
    test_harness_visible: boolean;
  };
  disabled_message: string | null;
}

export async function getWorkspaceAiAgentCapabilities(
  config: ServerConfig,
  _workspaceId: string,
  userId: string | null,
): Promise<WorkspaceAiAgentCapabilities> {
  const s = await getPlatformAiAgentSettings(config);
  const isAdmin = userId ? await isGlobalAdmin(config, userId).catch(() => false) : false;

  // Advanced visibility: admins always see; customers see only when the
  // platform allows it.
  const advVisible = (customerFlag: boolean) =>
    isAdmin || (s.advanced_tools_enabled && customerFlag);

  return {
    ai_agent_enabled: s.ai_agent_enabled,
    customer_ai_agent_visible: s.customer_ai_agent_visible,
    operator_assist_enabled: s.operator_assist_enabled,
    auto_answer_enabled: s.auto_answer_enabled,
    learning_enabled: s.learning_enabled,
    files_enabled: s.files_enabled,
    websites_enabled: s.websites_enabled,
    qna_enabled: s.qna_enabled,
    kb_enabled: s.kb_enabled,
    customer_nav: {
      overview: true,
      knowledge: s.files_enabled || s.websites_enabled || s.qna_enabled || s.kb_enabled,
      behavior: true,
      operatorAssist: s.operator_assist_enabled,
      activity: true,
      settings: true,
    },
    advanced: {
      debug_visible: advVisible(false),
      regression_visible: isAdmin || (s.advanced_tools_enabled && s.regression_runner_enabled),
      source_health_visible:
        isAdmin || (s.advanced_tools_enabled && s.source_health_visible_to_customers),
      test_harness_visible:
        isAdmin || (s.advanced_tools_enabled && s.test_harness_visible_to_customers),
    },
    disabled_message: s.disabled_message,
  };
}