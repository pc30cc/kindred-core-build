/**
 * Shared pieces of the «Personality & behavior» page tests
 * (src/pages/app/ai-agent/BehaviorPage.tsx). Each test file declares its own
 * vi.mock calls and reaches this module from inside them, so the page reads
 * this one store:
 *
 *   - `store.data` is what useAiAgentSettings returns, and a save replaces it
 *     with the server's copy, as useUpdateAiAgentSettings' setQueryData does;
 *   - the server's merge is the real one's (server settings.ts): top-level
 *     fields replaced, `instructions` merged key by key, the custom system
 *     instruction never returned (only has_custom_system_instruction);
 *   - `store.fail` makes the next save fail, `store.hold` keeps it pending
 *     until `release()`.
 *
 * Texts resolve against the real English catalogue, so the queries read what
 * an owner reads, and a key missing from en.ts fails them.
 */
import en from '@/i18n/locales/en';

type Settings = Record<string, unknown> & { instructions?: Record<string, unknown> };
export type Patch = Record<string, unknown> & { instructions?: Record<string, unknown> };

export function enText(key: string, params?: Record<string, string | number>): string {
  const raw = key.split('.').reduce<unknown>(
    (acc, part) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined),
    en,
  );
  let value = typeof raw === 'string' ? raw : key;
  if (params) {
    for (const [k, v] of Object.entries(params)) value = value.split(`{{${k}}}`).join(String(v));
  }
  return value;
}

/** What GET /api/ai-agent/settings sends for a configured workspace (customerSafe.ts). */
export function baseSettings(overrides: Record<string, unknown> = {}): Settings {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    enabled: true,
    mode: 'auto_reply_always',
    agent_name: 'Sara',
    agent_logo_url: null,
    business_description: 'We sell widgets.',
    answer_guidance: 'balanced',
    answer_only_from_kb: true,
    strict_topic_scope: false,
    welcome_message: 'legacy welcome text',
    fallback_message: 'Not sure, let me get a human.',
    handoff_keywords: ['human', 'operator'],
    max_replies_per_conversation: 3,
    max_replies_per_hour: 20,
    allowed_locales: [],
    show_sources_to_operator: true,
    show_sources_to_visitor: false,
    handoff_on_low_confidence: false,
    handoff_on_human_request: true,
    handoff_when_no_kb_match: false,
    handoff_policy: null,
    max_assist_attempts: 1,
    confidence_threshold: 0.55,
    has_custom_system_instruction: false,
    instructions: { tone: 'friendly', max_answer_length: 'medium', reply_language: 'visitor' },
    ai_intro_enabled: true,
    intro_message: null,
    intro_message_localized: { en: 'Hello from Sara', fa: 'سلام از سارا' },
    handoff_message_localized: { en: 'Connecting you now', fa: 'الان وصل می‌کنم' },
    handoff_prechat_message_localized: {},
    fallback_behavior: 'handoff',
    stop_on_handoff: true,
    pause_auto_reply_after_human_reply: true,
    allow_suggestions_after_takeover: true,
    keep_in_automated_until_handoff: true,
    escalation_style: 'balanced',
    allow_clarifying_questions: true,
    max_clarification_attempts: 1,
    allow_answer_with_caveat: true,
    learning_enabled: true,
    auto_create_learning_candidates: true,
    ...overrides,
  };
}

/** GET /api/ai-agent/diagnostics for a workspace that can be turned on. */
export function baseDiagnostics(overrides: Record<string, unknown> = {}) {
  return {
    ready: true,
    checks: {
      ai_provider_configured: true,
      has_knowledge: true,
      module_enabled: true,
      settings_enabled: true,
      mode: 'auto_reply_always',
    },
    provider: { name: 'openai', model: 'gpt' },
    knowledge: { published: 4, drafts: 0, by_locale: {}, qna_count: 2, has_any: true },
    is_global_admin: false,
    role: 'owner',
    operator_availability: { state: 'online', online_count: 2, total_count: 3 },
    ...overrides,
  };
}

/** The server's write (settings.ts updateSettings + customerSafe.ts), on the copy the page holds. */
export function serverApply(current: Settings, patch: Patch): Settings {
  const next: Settings = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (key !== 'instructions') next[key] = value;
  }
  if (patch.instructions) {
    const merged: Record<string, unknown> = { ...(current.instructions || {}) };
    for (const [key, value] of Object.entries(patch.instructions)) {
      if (value !== undefined) merged[key] = value;
    }
    const custom = merged.custom_system_instruction;
    delete merged.custom_system_instruction;
    next.instructions = merged;
    if (typeof custom === 'string') next.has_custom_system_instruction = custom.trim().length > 0;
  }
  const policy = patch.handoff_policy;
  if ((policy === 'immediate' || policy === 'assist_first' || policy === 'adaptive') && !('handoff_on_human_request' in patch)) {
    next.handoff_on_human_request = true;
  }
  return next;
}

export const store = {
  data: { settings: null as Settings | null },
  diag: baseDiagnostics() as ReturnType<typeof baseDiagnostics> | undefined,
  locales: ['en', 'fa'] as string[],
  workspace: { id: 'ws-1', slug: 'acme', default_locale: 'en' } as { id: string; slug: string; default_locale: string },
  listeners: new Set<() => void>(),
  /** Every PATCH the page sent, in order. */
  patches: [] as Patch[],
  /** The next save fails with this. */
  fail: null as unknown,
  /** Saves wait for release(). */
  hold: false,
  waiting: [] as Array<() => void>,
};

export function resetStore(settings: Settings = baseSettings()) {
  store.data = { settings };
  store.diag = baseDiagnostics();
  store.locales = ['en', 'fa'];
  store.workspace = { id: 'ws-1', slug: 'acme', default_locale: 'en' };
  store.patches = [];
  store.fail = null;
  store.hold = false;
  store.waiting = [];
}

export function subscribe(listener: () => void) {
  store.listeners.add(listener);
  return () => { store.listeners.delete(listener); };
}

/** A server copy arriving (a refetch, another tab's save): the page reads it next. */
export function serverCopy(settings: Settings) {
  store.data = { settings };
  store.listeners.forEach((l) => l());
}

/** useUpdateAiAgentSettings().mutateAsync, against the store. */
export async function mutate(patch: Patch) {
  store.patches.push(patch);
  if (store.hold) await new Promise<void>((resolve) => store.waiting.push(resolve));
  if (store.fail) {
    const error = store.fail;
    store.fail = null;
    throw error;
  }
  serverCopy(serverApply(store.data.settings as Settings, patch));
  return store.data;
}

/** Let the held saves through. */
export function release() {
  const waiting = store.waiting;
  store.waiting = [];
  store.hold = false;
  waiting.forEach((resolve) => resolve());
}

/** The API client's error for a refused write (lib/ai-agent/client.ts AiAgentApiError). */
export function apiError(code: string, status = 409) {
  return Object.assign(new Error(code), { code, status });
}

/** Guidance → "Add default rules", in English, byte for byte what it always saved. */
export const ENGLISH_DEFAULT_RULES = [
  { workspaceId: 'ws-1', title: 'Never claim to be human', description: 'Honesty rule', rule_type: 'answer_policy',
    instruction: 'If a visitor asks whether you are a human, clearly say you are an AI assistant.' },
  { workspaceId: 'ws-1', title: 'Do not invent exact prices', description: 'Pricing safety', rule_type: 'pricing_guidance',
    instruction: 'Never quote exact prices unless the knowledge base contains them. Offer to connect the visitor with sales instead.' },
  { workspaceId: 'ws-1', title: 'Offer human help on request', description: 'Escalation rule', rule_type: 'escalation_policy',
    instruction: 'If the visitor asks for a human, immediately offer to hand off and stop attempting to answer.' },
  { workspaceId: 'ws-1', title: 'Ask one clarification before handoff', description: 'Vague questions', rule_type: 'fallback_behavior',
    instruction: 'If a question is too vague to answer, ask exactly one short clarifying question before handing off.' },
  { workspaceId: 'ws-1', title: 'Friendly and concise tone', description: 'Voice rule', rule_type: 'tone',
    instruction: 'Use a friendly, concise tone. Avoid long paragraphs. Prefer short, helpful answers.' },
];
