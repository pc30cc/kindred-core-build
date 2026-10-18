/**
 * THE TRANSCRIPT BY EMAIL (issue #340 g1; migration 276).
 *
 * A visitor asks, from the rating card or the chat header's menu, for their
 * conversation to be mailed to them. Rules (owner, 2026-10-17):
 *
 *   - Only to the email already on the conversation's contact (the pre-chat
 *     form, the email card, the away form, a signed identify). The request
 *     never names an address, and the address is shown back masked
 *     (a•••@example.com).
 *   - Only once a human operator answered in the conversation. Visitor
 *     addresses are claims, not verified: without this an AI-only thread
 *     would mail anybody's address whatever text it was fed.
 *   - Only while the workspace's effective template offers it and its
 *     `transcriptEmail` option is on, and the platform has an email provider.
 *   - At most 3 sent per conversation, one per 10 minutes, and 100 attempts
 *     per workspace per 24 hours, counted in the ledger
 *     `conversation_transcript_emails` (sent and failed; a failed send does
 *     not use up the conversation's 3), plus the widget's per-visitor burst
 *     limit (security.ts, category `transcript`).
 *   - Every plan; the platform's default provider (platform mail on the
 *     visitor's request, like the offline-message notice).
 *
 * The mail is the running edition's Super Admin template
 * `visitor_conversation_transcript` in the visitor's language
 * (resolveEmailScope clamps it: Iran, Persian only), filled with HTML-escaped
 * values. Visitor and operator text is never put through placeholder
 * expansion: email/index.ts interpolates in one pass and never looks at an
 * inserted value again, and the transcript keys come last.
 *
 * Lives here, not in server/services/widget or server/routes: the widget's
 * code never names an email template (src/test/widget/noTemplateSystem.test.ts).
 */

import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient, type ServiceClient } from '../supabase.js';
import { isEmailProviderConfigured, resolveEmailScope, sendEmail, type SendResult } from './email/index.js';
import { recordConversationEvent } from './conversationEvents.js';
import { humanOperatorAnswered } from './conversationRatings.js';
import { isRelationMissing } from './billing/entitlementParse.js';
import { getWorkspaceWidgetSnapshot, workspaceChatTemplate } from './widget/configSnapshot.js';
import { enrichMessagesWithSender } from './widget/senderIdentity.js';
import { enrichMessagesWithAttachments, isVisitorVisibleMessageMeta } from '../routes/widgetAttachments.js';
import { chatTemplateOptionKeys } from '../../shared/chatTemplateCatalog.js';
import type { Edition } from '../../shared/edition.js';

export const TRANSCRIPT_TEMPLATE_SLUG = 'visitor_conversation_transcript';
/** Sent transcripts per conversation, ever. */
export const TRANSCRIPTS_PER_CONVERSATION = 3;
/** The pause between two sent transcripts of one conversation. */
export const TRANSCRIPT_COOLDOWN_MS = 10 * 60 * 1000;
/** Attempts (sent or failed) per workspace in 24 hours. */
export const TRANSCRIPTS_PER_WORKSPACE_DAY = 100;
/** The newest messages a transcript holds. */
const MAX_MESSAGES = 200;
/** Characters of one message's text. */
const MAX_MESSAGE_CHARS = 4000;
/**
 * The HTML transcript's size in UTF-8 bytes (what the mail carries: Persian
 * letters are two each); the oldest rows go first.
 */
export const MAX_TRANSCRIPT_BYTES = 200 * 1024;

const LEDGER = 'conversation_transcript_emails';
const emailSchema = z.string().trim().email().max(254);

/** 'ali.r@example.com' → 'a•••@example.com' (the domain stays readable). */
export function maskEmail(email: string): string {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '•••';
  return `${[...email.slice(0, at)][0]}•••${email.slice(at)}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

type TranscriptLocale = 'fa' | 'en' | 'tr';

/** The transcript's own words: the visitor's name for themselves, and the fallback mail. */
const COPY: Record<TranscriptLocale, { you: string; subject: (ws: string) => string; intro: (ws: string, date: string) => string }> = {
  fa: {
    you: 'شما',
    subject: (ws) => `متن گفتگوی شما با ${ws}`,
    intro: (ws, date) => `این متن گفتگوی شما با ${ws} است (${date})، همان‌طور که از پنجره‌ی گفتگو خواستید.`,
  },
  en: {
    you: 'You',
    subject: (ws) => `Your conversation with ${ws}`,
    intro: (ws, date) => `Here is your conversation with ${ws} (${date}), as you asked from the chat window.`,
  },
  tr: {
    you: 'Siz',
    subject: (ws) => `${ws} ile sohbetiniz`,
    intro: (ws, date) => `Sohbet penceresinden istediğiniz üzere ${ws} ile sohbetiniz (${date}):`,
  },
};

function transcriptLocale(locale: string | undefined): TranscriptLocale {
  const base = String(locale || '').toLowerCase().split('-')[0];
  return base === 'fa' || base === 'tr' ? base : 'en';
}

/**
 * The zone the times are written in: the visitor's (as the widget reports
 * it) when it is a real one, else the edition's (Tehran for Iran, UTC
 * otherwise).
 */
export function transcriptTimeZone(tz: unknown, edition: Edition | null): string {
  if (typeof tz === 'string' && tz.length > 0 && tz.length <= 64) {
    try {
      new Intl.DateTimeFormat('en-US', { timeZone: tz });
      return tz;
    } catch { /* not a zone */ }
  }
  return (edition ?? 'iran') === 'iran' ? 'Asia/Tehran' : 'UTC';
}

/** Persian in the Iranian edition is Jalali; elsewhere Persian is Gregorian with Persian digits. */
function intlLocale(locale: TranscriptLocale, edition: Edition | null): string {
  if (locale === 'fa') return (edition ?? 'iran') === 'iran' ? 'fa-IR-u-ca-persian' : 'fa-IR-u-ca-gregory';
  return locale === 'tr' ? 'tr-TR' : 'en-US';
}

export interface TranscriptAvailability {
  available: boolean;
  /** The masked address, when available. */
  to: string | null;
  reason?: 'disabled' | 'no_provider' | 'no_email' | 'no_human_reply' | 'limit_reached' | 'unavailable';
}

interface OwnedConversation {
  id: string;
  contact_id?: string | null;
}

/** The contact's email, when it is one. */
async function contactEmail(sb: ServiceClient, workspaceId: string, contactId: string | null | undefined): Promise<string | null> {
  if (!contactId) return null;
  const { data, error } = await sb
    .from('contacts')
    .select('email')
    .eq('workspace_id', workspaceId)
    .eq('id', contactId)
    .maybeSingle();
  if (error) throw error;
  const parsed = emailSchema.safeParse((data as { email?: unknown } | null)?.email);
  return parsed.success ? parsed.data : null;
}

/** Whether the workspace's effective template offers the transcript and has it on. */
async function transcriptOptionOn(config: ServerConfig, workspaceId: string): Promise<boolean> {
  const template = await workspaceChatTemplate(config, workspaceId);
  return chatTemplateOptionKeys(template.id).includes('transcriptEmail') && template.options.transcriptEmail !== false;
}

interface LedgerState {
  /** Sent transcripts of the conversation (up to the limit). */
  sent: number;
  /** When the newest one was sent (ms), or 0. */
  lastSentAt: number;
}

/** The conversation's sent transcripts; null before migration 276. */
async function conversationLedger(sb: ServiceClient, conversationId: string): Promise<LedgerState | null> {
  const { data, error } = await sb
    .from(LEDGER)
    .select('created_at')
    .eq('conversation_id', conversationId)
    .eq('status', 'sent')
    .order('created_at', { ascending: false })
    .limit(TRANSCRIPTS_PER_CONVERSATION);
  if (error) {
    if (isRelationMissing(error, LEDGER)) return null;
    throw error;
  }
  const rows = (data || []) as Array<{ created_at: string }>;
  return { sent: rows.length, lastSentAt: rows.length ? Date.parse(rows[0].created_at) || 0 : 0 };
}

/**
 * Whether the visitor may ask for the transcript now, and where it would go
 * (masked). For GET …/csat (the card's link and the menu item are drawn only
 * when available). `humanAnswered` may be passed when the caller already
 * counted it.
 */
export async function transcriptAvailability(
  config: ServerConfig,
  input: { workspaceId: string; conversation: OwnedConversation; humanAnswered?: boolean },
): Promise<TranscriptAvailability> {
  const off = (reason: TranscriptAvailability['reason']): TranscriptAvailability => ({ available: false, to: null, reason });
  if (!(await transcriptOptionOn(config, input.workspaceId))) return off('disabled');
  if (!(await isEmailProviderConfigured(config))) return off('no_provider');
  const sb = getServiceClient(config);
  const email = await contactEmail(sb, input.workspaceId, input.conversation.contact_id);
  if (!email) return off('no_email');
  if (!(input.humanAnswered ?? await humanOperatorAnswered(sb, input.conversation.id))) return off('no_human_reply');
  const ledger = await conversationLedger(sb, input.conversation.id);
  if (!ledger) return off('unavailable');
  if (ledger.sent >= TRANSCRIPTS_PER_CONVERSATION) return off('limit_reached');
  return { available: true, to: maskEmail(email) };
}

interface TranscriptMessage {
  sender_type: string;
  text: string;
  time: string;
  sender_name?: string | null;
  attachment?: { file_name?: string } | null;
}

/**
 * The conversation as the visitor saw it, newest MAX_MESSAGES: the HTML rows
 * the template's {transcript} table takes, the plain text for
 * {transcript_text}, and the date it started. Inbox-only and system rows
 * are left out; an attachment shows its file name, never a link.
 */
export async function buildVisitorTranscript(
  config: ServerConfig,
  input: {
    workspaceId: string;
    conversationId: string;
    workspaceName: string;
    locale: TranscriptLocale;
    timeZone: string;
    edition: Edition | null;
  },
): Promise<{ html: string; text: string; date: string; count: number }> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('conversation_messages')
    .select('id, body, sender_type, sender_id, created_at, metadata')
    .eq('conversation_id', input.conversationId)
    .order('created_at', { ascending: false })
    .limit(MAX_MESSAGES);
  if (error) throw error;
  const base = ((data || []) as Array<Record<string, unknown>>)
    .slice()
    .reverse()
    .filter((m) => m.sender_type !== 'system' && isVisitorVisibleMessageMeta(m.metadata))
    .map((m) => ({
      id: m.id as string,
      role: m.sender_type === 'contact' ? 'visitor' : 'agent',
      sender_type: String(m.sender_type || ''),
      _sender_id: (m.sender_id as string | null) || null,
      text: String(m.body ?? ''),
      time: String(m.created_at),
      metadata: m.metadata,
    }));
  const withFiles = await enrichMessagesWithAttachments(config, input.workspaceId, base);
  const messages = (await enrichMessagesWithSender(config, sb, withFiles, input.workspaceId)) as TranscriptMessage[];

  const fmt = intlLocale(input.locale, input.edition);
  const dayOf = new Intl.DateTimeFormat('en-CA', { timeZone: input.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const days = new Set(messages.map((m) => dayOf.format(new Date(m.time))));
  // Times only for a conversation of one day; with the date when it spans more.
  const stamp = new Intl.DateTimeFormat(fmt, days.size > 1
    ? { dateStyle: 'short', timeStyle: 'short', timeZone: input.timeZone }
    : { timeStyle: 'short', timeZone: input.timeZone });
  const longDate = new Intl.DateTimeFormat(fmt, { dateStyle: 'long', timeZone: input.timeZone });
  const you = COPY[input.locale].you;

  const rows: string[] = [];
  const texts: string[] = [];
  for (const m of messages) {
    const who = m.sender_type === 'contact' ? you : (m.sender_name || input.workspaceName);
    const time = stamp.format(new Date(m.time));
    const body = [...m.text.trim()].slice(0, MAX_MESSAGE_CHARS).join('');
    const file = m.attachment?.file_name ? `📎 ${m.attachment.file_name}` : '';
    if (!body && !file) continue;
    const lines = [body, file].filter(Boolean);
    rows.push(
      '<tr><td style="padding:10px 0;border-top:1px solid #e2e8f0">'
      + `<div style="font-size:12px;color:#64748b">${escapeHtml(who)} · ${escapeHtml(time)}</div>`
      + '<div dir="auto" style="font-size:15px;line-height:24px;color:#1e293b;white-space:pre-wrap">'
      + lines.map(escapeHtml).join('\n')
      + '</div></td></tr>',
    );
    texts.push(`${who} · ${time}\n${lines.join('\n')}`);
  }
  // Within the size cap, the newest rows are kept.
  let size = rows.reduce((n, r) => n + Buffer.byteLength(r, 'utf8'), 0);
  while (rows.length > 1 && size > MAX_TRANSCRIPT_BYTES) {
    size -= Buffer.byteLength(rows.shift() as string, 'utf8');
    texts.shift();
  }
  const first = messages.find((m) => m.text.trim() || m.attachment?.file_name);
  return {
    html: rows.join(''),
    text: texts.join('\n\n'),
    date: longDate.format(first ? new Date(first.time) : new Date()),
    count: rows.length,
  };
}

export type TranscriptSendResult =
  | { ok: true; to: string }
  | {
    ok: false;
    status: number;
    error: 'transcript_disabled' | 'no_email' | 'nothing_to_send' | 'limit_reached' | 'workspace_limit'
      | 'rate_limited' | 'send_failed' | 'email_unavailable';
    retryAfter?: number;
  };

/** Conversations with a transcript being built or sent in this process (a double click). */
const inFlight = new Set<string>();

/**
 * POST …/transcript: checks every rule above, builds the transcript and mails
 * it to the contact's address. The caller has verified the visitor owns the
 * conversation.
 */
export async function emailVisitorTranscript(
  config: ServerConfig,
  input: {
    workspaceId: string;
    conversation: OwnedConversation;
    locale?: string;
    tz?: string;
  },
  now: number = Date.now(),
): Promise<TranscriptSendResult> {
  const conversationId = input.conversation.id;
  if (!(await transcriptOptionOn(config, input.workspaceId))) {
    return { ok: false, status: 403, error: 'transcript_disabled' };
  }
  if (!(await isEmailProviderConfigured(config))) return { ok: false, status: 503, error: 'email_unavailable' };
  const sb = getServiceClient(config);
  const to = await contactEmail(sb, input.workspaceId, input.conversation.contact_id);
  if (!to) return { ok: false, status: 409, error: 'no_email' };
  if (!(await humanOperatorAnswered(sb, conversationId))) return { ok: false, status: 409, error: 'nothing_to_send' };

  if (inFlight.has(conversationId)) return { ok: false, status: 429, error: 'rate_limited', retryAfter: 10 };
  inFlight.add(conversationId);
  try {
    const ledger = await conversationLedger(sb, conversationId);
    if (!ledger) return { ok: false, status: 503, error: 'email_unavailable' };
    if (ledger.sent >= TRANSCRIPTS_PER_CONVERSATION) return { ok: false, status: 429, error: 'limit_reached' };
    const wait = ledger.lastSentAt + TRANSCRIPT_COOLDOWN_MS - now;
    if (wait > 0) return { ok: false, status: 429, error: 'rate_limited', retryAfter: Math.ceil(wait / 1000) };
    const { count: today, error: dayErr } = await sb
      .from(LEDGER)
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', input.workspaceId)
      .gte('created_at', new Date(now - 24 * 60 * 60 * 1000).toISOString());
    if (dayErr) {
      if (isRelationMissing(dayErr, LEDGER)) return { ok: false, status: 503, error: 'email_unavailable' };
      throw dayErr;
    }
    if ((today ?? 0) >= TRANSCRIPTS_PER_WORKSPACE_DAY) return { ok: false, status: 429, error: 'workspace_limit' };

    const scope = await resolveEmailScope(config, input.locale);
    if (!scope) return { ok: false, status: 503, error: 'email_unavailable' };
    const locale = transcriptLocale(scope.locales[0]);
    const snap = await getWorkspaceWidgetSnapshot(config, input.workspaceId);
    const brandName = typeof snap.settings?.brand_name === 'string' ? snap.settings.brand_name.trim() : '';
    const workspaceName = brandName || snap.workspace?.name || '';
    const transcript = await buildVisitorTranscript(config, {
      workspaceId: input.workspaceId,
      conversationId,
      workspaceName,
      locale,
      timeZone: transcriptTimeZone(input.tz, scope.edition),
      edition: scope.edition,
    });
    if (!transcript.count) return { ok: false, status: 409, error: 'nothing_to_send' };

    const copy = COPY[locale];
    // A provider that throws (a network error) has failed like one that
    // says so: a 502, a 'failed' row the workspace's daily cap counts.
    const result = await sendEmail(config, {
      workspaceId: input.workspaceId,
      to,
      templateSlug: TRANSCRIPT_TEMPLATE_SLUG,
      locale,
      // Sent as it is only when the template is missing.
      subject: copy.subject(workspaceName),
      html: `<p>${escapeHtml(copy.intro(workspaceName, transcript.date))}</p><table role="presentation" width="100%" cellpadding="0" cellspacing="0">${transcript.html}</table>`,
      text: `${copy.intro(workspaceName, transcript.date)}\n\n${transcript.text}`,
      // The transcript last: nothing is filled in after visitor text.
      templateData: {
        workspace: escapeHtml(workspaceName),
        workspace_name: workspaceName,
        date: escapeHtml(transcript.date),
        transcript: transcript.html,
        transcript_text: transcript.text,
      },
    }).catch((err: unknown): SendResult => ({
      success: false,
      provider: 'unknown',
      error: (err as { message?: string } | null)?.message || String(err),
    }));

    const status = result.success ? 'sent' : 'failed';
    const { error: ledgerErr } = await sb.from(LEDGER).insert({
      workspace_id: input.workspaceId,
      conversation_id: conversationId,
      status,
    });
    if (ledgerErr) console.warn('[visitorTranscript] ledger insert failed:', ledgerErr.message);
    void recordConversationEvent(config, {
      workspaceId: input.workspaceId,
      conversationId,
      eventType: 'transcript_emailed',
      actorType: 'visitor',
      actorId: null,
      payload: { status, to: maskEmail(to), messages: transcript.count, source: 'widget' },
    });
    if (!result.success) {
      console.warn('[visitorTranscript] send failed:', result.provider, result.error);
      return { ok: false, status: 502, error: 'send_failed' };
    }
    return { ok: true, to: maskEmail(to) };
  } finally {
    inFlight.delete(conversationId);
  }
}
