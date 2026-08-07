/**
 * AI Agent — pre-chat intro service.
 *
 * Inserts a single AI intro message into a conversation when the visitor
 * completes pre-chat (or first opens the widget) and the agent is in an
 * auto-reply mode. Templated by default — costs zero AI credits.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getOrCreateSettings, type AgentSettings } from './settings.js';
import { insertAiMessage, deriveAgentDisplay } from './responder.js';
import { logRun } from './logs.js';
import { isAutoAnswerAllowedForWorkspace } from './platformGuards.js';
import {
  clampLocaleToPlatformRegion,
  getPlatformAllowedLocales,
  textMatchesLocale,
} from '../platformRegion.js';

export interface IntroInput {
  workspaceId: string;
  conversationId?: string | null;
  visitorSessionId?: string | null;
  visitorId?: string | null;
  locale?: string;
}

export interface IntroResult {
  sent: boolean;
  reason?: string;
  messageId?: string | null;
  conversationId?: string | null;
  body?: string | null;
  agentName?: string | null;
  agentLogoUrl?: string | null;
}

const FALLBACK_INTRO: Record<string, (name: string) => string> = {
  en: (name) =>
    `Hi! I'm ${name}, an AI assistant. I can answer questions from our help center. If I'm not sure about something, I'll connect you with a human agent.`,
  fa: (name) =>
    `سلام! من ${name} هستم، یک دستیار هوشمند. می‌توانم به سوالات شما با کمک پایگاه دانش پاسخ بدهم. اگر مطمئن نباشم، شما را به یک کارشناس انسانی وصل می‌کنم.`,
  tr: (name) =>
    `Merhaba! Ben ${name}, bir yapay zeka asistanıyım. Yardım merkezimizden sorularınızı yanıtlayabilirim. Emin olmadığım konularda sizi bir temsilciye bağlarım.`,
};

function pickLocale(loc?: string): 'en' | 'fa' | 'tr' {
  const l = (loc || 'en').toLowerCase();
  if (l.startsWith('fa')) return 'fa';
  if (l.startsWith('tr')) return 'tr';
  return 'en';
}

export function buildIntroBody(
  settings: AgentSettings,
  locale?: string,
  allowedLocales?: string[],
): string {
  const loc = pickLocale(locale);
  const allowed = (allowedLocales && allowedLocales.length ? allowedLocales : ['en', 'fa', 'tr'])
    .map((l) => l.toLowerCase().split('-')[0]);
  const singleLanguage = allowed.length === 1;

  const localized = settings.intro_message_localized;
  if (localized && typeof localized === 'object') {
    const direct = localized[loc];
    // Locale keys are admin-managed data and can contain stale text copied
    // from a previously-active language. In a single-language deployment,
    // validate the text itself as well as its JSON key so a Turkish value
    // accidentally stored under `fa` can never leak into a new intro.
    if (
      typeof direct === 'string'
      && direct.trim()
      && (!singleLanguage || textMatchesLocale(direct, loc))
    ) return direct.trim();
    // Only fall back to another locale's text when the platform actually
    // offers that language — a single-language deployment must never emit
    // text stored for a different locale.
    if (!singleLanguage) {
      const en = localized.en;
      if (typeof en === 'string' && en.trim() && allowed.includes('en')) return en.trim();
    }
  }
  // Legacy single-string fields carry no locale — accept them only when the
  // script matches the active language.
  const legacy = [settings.intro_message, settings.welcome_message]
    .map((v) => (v || '').trim())
    .filter(Boolean);
  for (const text of legacy) {
    if (!singleLanguage || textMatchesLocale(text, loc)) return text;
  }
  const name = settings.agent_name || 'AI Assistant';
  return FALLBACK_INTRO[loc](name);
}

/**
 * Returns true when an intro should NOT be re-sent (already logged or a
 * matching AI intro message already exists in the conversation).
 */
async function alreadyIntroduced(
  sb: ReturnType<typeof getServiceClient>,
  workspaceId: string,
  conversationId: string | null | undefined,
  sessionId: string | null | undefined,
): Promise<boolean> {
  if (conversationId) {
    const { data: log } = await sb
      .from('ai_agent_intro_log')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('conversation_id', conversationId)
      .limit(1)
      .maybeSingle();
    if (log) return true;

    // Defensive: if a prior AI intro message lives in the conversation but
    // the log row is missing, still treat it as introduced.
    const { data: msg } = await sb
      .from('conversation_messages')
      .select('id,metadata')
      .eq('conversation_id', conversationId)
      .eq('sender_type', 'ai')
      .order('created_at', { ascending: true })
      .limit(20);
    if ((msg || []).some((m: any) => (m.metadata?.source || '').startsWith('ai_agent_intro'))) {
      return true;
    }
  } else if (sessionId) {
    const { data: log } = await sb
      .from('ai_agent_intro_log')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('visitor_session_id', sessionId)
      .is('conversation_id', null)
      .limit(1)
      .maybeSingle();
    if (log) return true;
  }
  return false;
}

export async function maybeSendIntro(
  config: ServerConfig,
  input: IntroInput,
): Promise<IntroResult> {
  try {
    // E12 — Platform kill switch must short-circuit the visitor-facing
    // intro before any settings load, conversation creation, or AI
    // message insert. When disabled the widget gets a graceful no-op so
    // it falls back to the normal generic greeting / live-chat flow and
    // no AI side effects (rows, runs, LLM calls) happen.
    const platformGate = await isAutoAnswerAllowedForWorkspace(config, input.workspaceId);
    if (platformGate.allowed !== true) {
      const reason = (platformGate as { allowed: false; reason: string }).reason;
      return { sent: false, reason };
    }
    const settings = await getOrCreateSettings(config, input.workspaceId);
    if (!settings.enabled || settings.mode === 'off') {
      return { sent: false, reason: 'disabled_or_off' };
    }
    if ((settings as any).ai_intro_enabled === false) {
      return { sent: false, reason: 'intro_disabled' };
    }
    // Only auto-reply modes get a visitor-facing intro. suggest_only stays silent.
    if (settings.mode === 'suggest_only') {
      return { sent: false, reason: 'suggest_only_no_intro' };
    }

    const sb = getServiceClient(config);

    // ─── Resolve or create a real conversation ───
    // The intro must live in a real conversation_messages row so it appears
    // in history on reload and is visible in the operator inbox. If the
    // widget hasn't created a conversation yet (just finished pre-chat),
    // we resolve an existing open one or create a new one here.
    let conversationId = input.conversationId || null;

    if (!conversationId && input.visitorSessionId) {
      const { data: existing } = await sb
        .from('conversations')
        .select('id')
        .eq('workspace_id', input.workspaceId)
        .eq('visitor_session_id', input.visitorSessionId)
        .neq('status', 'closed')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (existing?.id) {
        conversationId = existing.id;
        console.debug('[ai-agent] intro resolve conversation', conversationId);
      }
    }

    if (!conversationId) {
      // Try to attach a contact via the visitor_id metadata (set by pre-chat).
      let contactId: string | null = null;
      if (input.visitorId) {
        const { data: c } = await sb
          .from('contacts')
          .select('id')
          .eq('workspace_id', input.workspaceId)
          .contains('metadata', { visitor_id: input.visitorId })
          .limit(1)
          .maybeSingle();
        contactId = c?.id || null;
      }

      const { data: created, error: createErr } = await sb
        .from('conversations')
        .insert({
          workspace_id: input.workspaceId,
          status: 'open',
          priority: 'normal',
          subject: 'New conversation',
          contact_id: contactId,
          visitor_session_id: input.visitorSessionId || null,
          metadata: { ai_state: 'ai_managed', source: 'ai_agent_intro' },
          updated_at: new Date().toISOString(),
        })
        .select('id')
        .single();
      if (createErr || !created?.id) {
        console.warn('[ai-agent] intro conversation create failed:', createErr?.message);
        return { sent: false, reason: 'conversation_create_failed' };
      }
      conversationId = created.id;
      console.debug('[ai-agent] intro conversation created', conversationId);
    }

    if (await alreadyIntroduced(sb, input.workspaceId, conversationId, input.visitorSessionId)) {
      console.debug('[ai-agent] intro already sent', conversationId);
      return { sent: false, reason: 'already_sent', conversationId };
    }

    // A visitor's browser can still negotiate a language the platform
    // doesn't actually offer (e.g. a Persian-only deployment reached by a
    // Turkish browser) — clamp to what the platform's region lock allows
    // so the admin's edited text (set for the platform's one language)
    // always wins over a stale per-locale fallback.
    const clampedLocale = await clampLocaleToPlatformRegion(config, input.locale);
    const allowedLocales = await getPlatformAllowedLocales(config);
    const body = buildIntroBody(settings, clampedLocale, allowedLocales);
    const display = deriveAgentDisplay(settings);

    let messageId: string | null = null;
    if (conversationId) {
      // Persist as a real conversation message — history-consistent.
      const inserted = await insertAiMessage(config, {
        workspaceId: input.workspaceId,
        conversationId,
        body,
        source: 'ai_agent_intro',
        mode: settings.mode,
        agentName: display.agentName,
        agentLogoUrl: display.agentLogoUrl,
      });
      messageId = inserted.id;
      console.debug('[ai-agent] intro inserted', { conversationId, messageId });
    }

    // Always record the intro log so subsequent intro attempts dedupe.
    await sb.from('ai_agent_intro_log').insert({
      workspace_id: input.workspaceId,
      conversation_id: conversationId,
      visitor_session_id: input.visitorSessionId || null,
      visitor_id: input.visitorId || null,
      message_id: messageId,
    });

    await logRun(config, {
      workspaceId: input.workspaceId,
      conversationId: conversationId || null,
      runType: 'auto_reply',
      mode: settings.mode,
      status: 'replied',
      inputText: null,
      outputText: body,
      metadata: { intro: true, locale: input.locale || null },
    });

    return {
      sent: true,
      messageId,
      conversationId,
      body,
      agentName: display.agentName,
      agentLogoUrl: display.agentLogoUrl,
    };
  } catch (e: any) {
    console.warn('[ai-agent] intro failed:', e?.message || e);
    return { sent: false, reason: 'intro_failed' };
  }
}
