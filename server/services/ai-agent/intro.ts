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

export function buildIntroBody(settings: AgentSettings, locale?: string): string {
  if (settings.intro_message && settings.intro_message.trim()) {
    return settings.intro_message.trim();
  }
  if (settings.welcome_message && settings.welcome_message.trim()) {
    return settings.welcome_message.trim();
  }
  const name = settings.agent_name || 'AI Assistant';
  return FALLBACK_INTRO[pickLocale(locale)](name);
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
    if (await alreadyIntroduced(sb, input.workspaceId, input.conversationId, input.visitorSessionId)) {
      return { sent: false, reason: 'already_sent' };
    }

    const body = buildIntroBody(settings, input.locale);
    const display = deriveAgentDisplay(settings);

    let messageId: string | null = null;
    if (input.conversationId) {
      // Persist as a real conversation message — history-consistent.
      const inserted = await insertAiMessage(config, {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        body,
        source: 'ai_agent_intro',
        mode: settings.mode,
        agentName: display.agentName,
        agentLogoUrl: display.agentLogoUrl,
      });
      messageId = inserted.id;
    }

    // Always record the intro log so subsequent intro attempts dedupe.
    await sb.from('ai_agent_intro_log').insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId || null,
      visitor_session_id: input.visitorSessionId || null,
      visitor_id: input.visitorId || null,
      message_id: messageId,
    });

    await logRun(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId || null,
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
      body,
      agentName: display.agentName,
      agentLogoUrl: display.agentLogoUrl,
    };
  } catch (e: any) {
    console.warn('[ai-agent] intro failed:', e?.message || e);
    return { sent: false, reason: 'intro_failed' };
  }
}
