/**
 * AI Agent — pre-chat intro service.
 *
 * The AI's greeting when the visitor opens the chat (or completes pre-chat)
 * and the agent is in an auto-reply mode. Templated by default — costs zero
 * AI credits.
 *
 * Since 2026-10-24 (one current conversation per visitor) opening the chat
 * writes nothing: the widget asks for a preview (POST /ai-agent/intro
 * `preview: true`), draws it, and the request that creates the conversation
 * — the visitor's first POST /message, `ai_intro` — stores the server's own
 * copy just before their message (storeIntroBeforeFirstMessage). A chat
 * opened and left creates no conversation, and none is counted.
 *
 * Widgets loaded before that release still ask without `preview`, and get
 * the greeting written as before (the legacy branch of maybeSendIntro), but
 * never a second conversation beside a live one. Time-boxed: remove it, with
 * the Inbox's intro-only filter (routes/conversations.ts), about two weeks
 * after the release.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { getOrCreateSettings, type AgentSettings } from './settings.js';
import { insertAiMessage, deriveAgentDisplay } from './responder.js';
import { logRun } from './logs.js';
import { isAutoAnswerAllowedForWorkspace } from './platformGuards.js';
import { ensureVisitorContact } from '../widget/anonymousContact.js';
import { isDefaultAiAgentName } from '../../../shared/systemMessages.js';
import {
  LIVE_CONVERSATION_STATUSES,
  findLiveVisitorConversation,
  resolveVisitorConversationScope,
} from '../widget/visitorConversations.js';
import {
  clampLocaleToPlatformRegion,
  getPlatformAllowedLocales,
  textMatchesLocale,
} from '../platformRegion.js';

export interface IntroInput {
  workspaceId: string;
  /** A conversation the route verified is this visitor's own and live. */
  conversationId?: string | null;
  visitorSessionId?: string | null;
  /** The signed visitor id (cookie or credential header). */
  visitorId?: string | null;
  locale?: string;
  /**
   * P0-F — the visitor asked for a new thread (an older widget's "+ New
   * conversation"). Ignored while they have a live conversation (one current
   * conversation per visitor, 2026-10-24): the greeting goes into that one,
   * never into a second.
   */
  forceNewConversation?: boolean;
  /**
   * Draw it, write nothing: no conversation, no message, no log, no run (the
   * widget's chat open since 2026-10-24). Without it, an older widget's
   * call: the greeting is written at once (the legacy branch).
   */
  preview?: boolean;
}


export interface IntroResult {
  sent: boolean;
  /** The greeting to draw; nothing was written (IntroInput.preview). */
  preview?: boolean;
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

/**
 * The intro of an agent the owner gave no name of its own (none, or the
 * English default): an unnamed assistant in a sentence of its own, not the
 * named one above with a stand-in name ("I'm AI Assistant, an AI assistant").
 */
const UNNAMED_INTRO: Record<'en' | 'fa' | 'tr', string> = {
  en: "Hi! I'm an AI assistant. I can answer questions from our help center. If I'm not sure about something, I'll connect you with a human agent.",
  fa: 'سلام! من یک دستیار هوش مصنوعی هستم. می‌توانم به سوالات شما با کمک پایگاه دانش پاسخ بدهم. اگر مطمئن نباشم، شما را به یک کارشناس انسانی وصل می‌کنم.',
  tr: 'Merhaba! Ben bir yapay zekâ asistanıyım. Yardım merkezimizden sorularınızı yanıtlayabilirim. Emin olmadığım konularda sizi bir temsilciye bağlarım.',
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
    // Never another language's text (the owner's English for a Turkish
    // visitor): the built-in intro below is in the visitor's language.
  }
  // Legacy single-string fields carry no locale — accept them only when the
  // script matches the active language.
  const legacy = [settings.intro_message, settings.welcome_message]
    .map((v) => (v || '').trim())
    .filter(Boolean);
  for (const text of legacy) {
    if (textMatchesLocale(text, loc)) return text;
  }
  const own = (settings.agent_name || '').trim();
  return own && !isDefaultAiAgentName(own) ? FALLBACK_INTRO[loc](own) : UNNAMED_INTRO[loc];
}

/**
 * Returns true when an intro should NOT be re-sent (already logged or a
 * matching AI intro message already exists in the conversation).
 */
async function alreadyIntroduced(
  sb: ReturnType<typeof getServiceClient>,
  workspaceId: string,
  conversationId: string,
): Promise<boolean> {
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
  const rows = (msg || []) as Array<{ metadata?: { source?: string } | null }>;
  return rows.some((m) => (m.metadata?.source || '').startsWith('ai_agent_intro'));
}

/** The greeting the AI may give this workspace's visitor now, or why not. */
export type IntroGreeting =
  | { ok: true; body: string; settings: AgentSettings; agentName: string; agentLogoUrl: string | null }
  | { ok: false; reason: string };

/**
 * Every gate the greeting passes, and its text in the visitor's language:
 * the ONE decision behind the preview, the legacy write and the copy stored
 * before a first message, so the visitor and the Inbox read the same words.
 * Reads only.
 */
export async function resolveIntroGreeting(
  config: ServerConfig,
  workspaceId: string,
  locale?: string | null,
): Promise<IntroGreeting> {
  // E12 — Platform kill switch must short-circuit the visitor-facing
  // intro before any settings load, conversation creation, or AI
  // message insert. When disabled the widget gets a graceful no-op so
  // it falls back to the normal generic greeting / live-chat flow and
  // no AI side effects (rows, runs, LLM calls) happen.
  const platformGate = await isAutoAnswerAllowedForWorkspace(config, workspaceId);
  if (platformGate.allowed !== true) {
    return { ok: false, reason: (platformGate as { allowed: false; reason: string }).reason };
  }
  const settings = await getOrCreateSettings(config, workspaceId);
  if (!settings.enabled || settings.mode === 'off') {
    return { ok: false, reason: 'disabled_or_off' };
  }
  if (settings.ai_intro_enabled === false) {
    return { ok: false, reason: 'intro_disabled' };
  }
  // Only auto-reply modes get a visitor-facing intro. suggest_only stays silent.
  if (settings.mode === 'suggest_only') {
    return { ok: false, reason: 'suggest_only_no_intro' };
  }
  // "Auto-reply when operators are offline": while the team is online the
  // AI does not answer (runtimePolicy.ts, only suggestions), so it does not
  // greet either. Its greeting marks the thread the AI's (`ai_managed`),
  // which parked a daytime chat in the AI's queue — out of the Inbox, with
  // no notification — while nobody answered it (R-02). The visitor gets the
  // widget's ordinary live-chat greeting instead.
  if (settings.mode === 'auto_reply_when_offline') {
    const { getOperatorAvailability } = await import('./availability.js');
    if ((await getOperatorAvailability(config, workspaceId)).state !== 'offline') {
      return { ok: false, reason: 'operators_online' };
    }
  }

  // P0-AI (BLOCKER) — the client guard is not enough: a direct POST to
  // /api/widget/ai-agent/intro must not be able to create an AI-managed
  // conversation the AI cannot actually service. The intro text promises
  // "I can answer your questions", so it requires a REAL provider, not
  // just the gates. Fail closed BEFORE conversation creation,
  // ai_state=ai_managed, the intro message insert and the intro log.
  // Coarse reason only — never provider/model/key details.
  const { resolveVisitorAiSnapshot } = await import('./visitorAiSnapshot.js');
  const aiSnapshot = await resolveVisitorAiSnapshot(config, workspaceId, settings);
  if (aiSnapshot.visitorFacing !== true || aiSnapshot.providerReady !== true) {
    return { ok: false, reason: 'ai_not_visitor_facing' };
  }

  // A visitor's browser can still negotiate a language the platform
  // doesn't actually offer (e.g. a Persian-only deployment reached by a
  // Turkish browser) — clamp to what the platform's region lock allows
  // so the admin's edited text (set for the platform's one language)
  // always wins over a stale per-locale fallback.
  const clampedLocale = await clampLocaleToPlatformRegion(config, locale || undefined);
  const allowedLocales = await getPlatformAllowedLocales(config);
  const display = deriveAgentDisplay(settings);
  return {
    ok: true,
    body: buildIntroBody(settings, clampedLocale, allowedLocales),
    settings,
    agentName: display.agentName,
    agentLogoUrl: display.agentLogoUrl,
  };
}

/**
 * The greeting the visitor saw before writing (the preview), stored by the
 * request that created their conversation, just before their first message:
 * the server's own text, never the browser's, in the same row today's intro
 * writes (sender 'ai', metadata.source 'ai_agent_intro'), with its intro log
 * and run. Never throws; null when it could not be written (the message
 * goes on without it).
 */
export async function storeIntroBeforeFirstMessage(
  config: ServerConfig,
  input: {
    workspaceId: string;
    conversationId: string;
    greeting: Extract<IntroGreeting, { ok: true }>;
    visitorSessionId?: string | null;
    visitorId?: string | null;
    locale?: string | null;
  },
): Promise<{ row: Record<string, unknown>; senderAvatar: string | null } | null> {
  try {
    const { greeting } = input;
    const inserted = await insertAiMessage(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      body: greeting.body,
      source: 'ai_agent_intro',
      mode: greeting.settings.mode,
      agentName: greeting.agentName,
      agentLogoUrl: greeting.agentLogoUrl,
    });
    if (!inserted.id || !inserted.row) return null;
    const sb = getServiceClient(config);
    await sb.from('ai_agent_intro_log').insert({
      workspace_id: input.workspaceId,
      conversation_id: input.conversationId,
      visitor_session_id: input.visitorSessionId || null,
      visitor_id: input.visitorId || null,
      message_id: inserted.id,
    });
    await logRun(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      runType: 'auto_reply',
      mode: greeting.settings.mode,
      status: 'replied',
      inputText: null,
      outputText: greeting.body,
      metadata: { intro: true, before_first_message: true, locale: input.locale || null },
    });
    return { row: inserted.row, senderAvatar: inserted.senderAvatar ?? null };
  } catch (e) {
    console.warn('[ai-agent] intro before first message failed:', (e as Error)?.message || e);
    return null;
  }
}

export async function maybeSendIntro(
  config: ServerConfig,
  input: IntroInput,
): Promise<IntroResult> {
  try {
    const greeting = await resolveIntroGreeting(config, input.workspaceId, input.locale);
    if (greeting.ok !== true) return { sent: false, reason: greeting.reason };
    const { settings, body } = greeting;
    const display = { agentName: greeting.agentName, agentLogoUrl: greeting.agentLogoUrl };

    const sb = getServiceClient(config);
    // The visitor's sessions and contact, read only when a lookup needs them.
    const scope = () => (input.visitorId
      ? resolveVisitorConversationScope(sb, input.workspaceId, input.visitorId)
      : Promise.resolve(null));

    // ─── Preview: the widget draws it, nothing is written ───
    // The visitor's live conversation (another tab, another device, an
    // operator's outreach) is theirs to go on in: the widget opens it
    // instead of greeting a new thread beside it. At a full quota nothing is
    // drawn either: the first message could not create the conversation.
    if (input.preview === true) {
      const live = await findLiveVisitorConversation(sb, input.workspaceId, await scope());
      if (live) return { sent: false, reason: 'conversation_live', conversationId: live.id };
      const { checkMaxConversationsAllowance } = await import('../billing/conversationLimit.js');
      const allowance = await checkMaxConversationsAllowance(config, input.workspaceId);
      if (!allowance.allowed) return { sent: false, reason: `conversation_limit_${allowance.reason}` };
      return {
        sent: true,
        preview: true,
        conversationId: null,
        messageId: null,
        body,
        agentName: display.agentName,
        agentLogoUrl: display.agentLogoUrl,
      };
    }

    // ─── Legacy (widgets before 2026-10-24): resolve or create, then write ───
    // The intro must live in a real conversation_messages row so it appears
    // in history on reload and is visible in the operator inbox. The named
    // conversation (the route verified it is this visitor's and live), else
    // the visitor's live one, a greeting-only one included, so this branch
    // never mints a second conversation beside a live one, force-new or not
    // (P0-F's "+ New conversation" is ignored while one is live). Only with
    // none is one created.
    let conversationId = input.conversationId || null;

    // The id comes from the visitor's browser and the greeting is written
    // into it (and a channel conversation would deliver it): only this
    // workspace's, and only a live one, never a closed one, which is never
    // revived. Anything else is ignored, and the visitor's own conversation
    // is found or created below. (The route also checks it is this
    // visitor's.)
    if (conversationId) {
      const { data: named } = await sb
        .from('conversations')
        .select('id')
        .eq('id', conversationId)
        .eq('workspace_id', input.workspaceId)
        .in('status', [...LIVE_CONVERSATION_STATUSES])
        .maybeSingle();
      if (!named?.id) conversationId = null;
    }

    if (!conversationId) {
      const live = await findLiveVisitorConversation(sb, input.workspaceId, await scope(), { includeUnansweredGreeting: true });
      if (live) {
        conversationId = live.id;
        console.debug('[ai-agent] intro resolve conversation', conversationId);
      }
    }

    if (!conversationId) {
      // P0-BILLING — creating a thread here is a real conversation creation
      // and must respect `max_conversations` exactly like the widget and
      // operator HTTP surfaces do. This is a non-HTTP caller, so it uses the
      // shared transport-free checker rather than the Express middleware —
      // same entitlement RPC, same usage counter, no second limit system.
      const { checkMaxConversationsAllowance } = await import('../billing/conversationLimit.js');
      const allowance = await checkMaxConversationsAllowance(config, input.workspaceId);
      if (!allowance.allowed) {
        console.warn('[ai-agent] intro suppressed by conversation limit', {
          workspaceId: input.workspaceId,
          reason: allowance.reason,
        });
        return { sent: false, reason: `conversation_limit_${allowance.reason}` };
      }

      // Every conversation gets a contact — even AI-only threads started
      // before the visitor has identified themselves. The placeholder is
      // upgraded in place once the pre-chat / identity form is submitted.
      const contactId: string | null = await ensureVisitorContact(sb, {
        workspaceId: input.workspaceId,
        visitorId: input.visitorId || null,
        sessionId: input.visitorSessionId || null,
      });


      const { data: created, error: createErr } = await sb
        .from('conversations')
        .insert({
          workspace_id: input.workspaceId,
          status: 'open',
          priority: 'normal',
          subject: 'New conversation',
          contact_id: contactId,
          visitor_session_id: input.visitorSessionId || null,
          metadata: {
            ai_state: 'ai_managed',
            source: 'ai_agent_intro',
            // Ownership anchor — without a session id or contact this is the
            // only way /message can prove the visitor owns this conversation.
            visitor_id: input.visitorId || null,
          },
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

    if (!conversationId) return { sent: false, reason: 'conversation_create_failed' };

    if (await alreadyIntroduced(sb, input.workspaceId, conversationId)) {
      console.debug('[ai-agent] intro already sent', conversationId);
      return { sent: false, reason: 'already_sent', conversationId };
    }

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
  } catch (e) {
    console.warn('[ai-agent] intro failed:', e?.message || e);
    return { sent: false, reason: 'intro_failed' };
  }
}
