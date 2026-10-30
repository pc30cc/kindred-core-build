// ============================================
// THE OWNERS' MAIL WHEN A VISITOR LEAVES A MESSAGE WHILE THE TEAM IS AWAY
// ============================================
//
// POST /api/widget/offline-messages needs no account: anybody with the
// widget's public token can leave a message, and every message used to mail
// every owner and admin at once, one mail each, with the visitor's name in
// the Subject. A contact-form bot turned that into platform-signed spam, from
// our own domains and our own relay, as fast as the widget's limits let it.
// So, for every provider alike:
//
//   - Nobody is mailed while the team is online (the capture is then routed
//     to an operator who is there, like any message), nor a member who is
//     suspended, whose seat the plan has paused or whose account is disabled.
//   - A workspace's first capture opens a window (15 minutes): it is mailed
//     at once. Every later capture in the window is merged into one summary
//     mail, sent when the window ends; the summary says how many and links
//     the inbox, with nothing a visitor typed. A workspace opens at most
//     OFFLINE_NOTICE_WINDOWS_PER_DAY windows a day; past that, the inbox and
//     the phones still have every message, the mail does not.
//   - Each mail goes through the outbox (enqueueEmail: retries, never twice
//     for one message and one recipient), not from the visitor's request.
//   - Each owner and admin may turn it off, like the other operator
//     notification emails (Settings → Notifications, or the mail's one-click
//     unsubscribe link; services/notificationEmail/unsubscribe.ts): every
//     mail to a member carries List-Unsubscribe and the line under its text.
//     It has no platform switch: it is the workspace's own operational mail.
//   - The window's summary is ranked by its count in the outbox
//     (supersedeRank): of the summaries a burst queues, the one with the
//     highest count is the one sent, whichever reached the queue last.
//   - What a visitor typed never reaches a Subject: the notice's subject and
//     text part get nothing of it; its HTML part gets it escaped (htmlData),
//     and the platform's own template makes its text part from that HTML
//     (migration 289d).

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendEmail, type EmailRequest, type SendResult } from '../email/index.js';
import { enqueueEmail, type EmailOutboxOptions } from '../email/outbox.js';
import { peekEmailQuota, takeEmailQuota } from '../email/sendQuota.js';
import { resolveWorkspaceAppUrl } from '../auth-email.js';
import { operatorFallbackLocale, operatorLocales } from '../operatorLocale.js';
import { resolveLockState } from '../billing/locks/state.js';
import { isMemberLocked } from '../billing/locks/predicates.js';
import { resolveAvailability } from './availability.js';
import { parseEmailAddress } from '../../../shared/emailProviders.js';
import { operatorsDeclining } from '../notificationEmail/queue.js';
import { OFFLINE_MESSAGES_EMAIL, OFFLINE_NOTICE_ROLES } from '../notificationEmail/types.js';
import { notificationFooter, unsubscribeBaseUrl, unsubscribeUrl } from '../notificationEmail/unsubscribe.js';
import type { OperatorLocale } from '../operatorLocale.js';

/** A workspace's notice window: its first capture is mailed at once, the rest at its end, merged. */
export const OFFLINE_NOTICE_WINDOW_SECONDS = 15 * 60;
/** Windows a workspace may open in a day: each is one notice, and at most one summary. */
export const OFFLINE_NOTICE_WINDOWS_PER_DAY = 20;

const DAY_SECONDS = 24 * 60 * 60;

export interface OfflineCapture {
  conversationId: string;
  /** The visitor's message row: with the recipient, what makes a mail one mail. */
  messageId?: string | null;
  message: string;
  email: string | null;
  name: string | null;
  phone?: string | null;
}

export type OfflineNoticeOutcome = 'team_online' | 'no_recipient' | 'immediate' | 'summary' | 'capped';

/** Visitor text for an HTML mail body: `&`, `<`, `>` and `"` as entities. */
export function escapeMailText(value: string): string {
  return String(value).replace(/[&<>"]/g, (c) => (c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : '&quot;'));
}

// ─── Who hears of it ──────────────────────────────────────────────────────

interface NoticeRecipient {
  /** The member's user id, or 'reply_to' for the workspace's own address. */
  key: string;
  to: string;
  locale: OperatorLocale;
  /** A member, who may turn this mail off: its unsubscribe link and line go with it. */
  member: boolean;
}

/**
 * The workspace's owners and admins who may read visitors' messages, each in
 * their own language (operatorLocale.ts), never the visitor's. A suspended
 * member, one whose seat the plan has paused and one whose account is
 * disabled hear nothing, nor one who turned this mail off. With nobody left
 * who has an address, the workspace's reply-to address (Settings → Email)
 * stands in, unless it is the address of one of those excluded; members who
 * turned it off do not hand it to that address.
 */
async function noticeRecipients(config: ServerConfig, workspaceId: string): Promise<NoticeRecipient[]> {
  const sb = getServiceClient(config);
  const { data: members, error } = await sb
    .from('workspace_members')
    .select('user_id, role, suspended_at')
    .eq('workspace_id', workspaceId)
    .in('role', [...OFFLINE_NOTICE_ROLES]);
  if (error) {
    console.warn('[offline-notice] owners not readable; nobody mailed:', error.message);
    return [];
  }
  const rows = ((members ?? []) as Array<{ user_id: string | null; suspended_at?: string | null }>)
    .filter((m) => typeof m.user_id === 'string' && m.user_id);
  const locks = await resolveLockState(config, workspaceId, ['member']);
  const eligible = new Set(
    rows.filter((m) => !m.suspended_at && !isMemberLocked(locks, m.user_id)).map((m) => String(m.user_id)),
  );
  const ids = rows.map((m) => String(m.user_id));

  let profiles: Array<{ id: string; email: string | null }> = [];
  if (ids.length) {
    const [{ data: profileRows }, { data: credentials }] = await Promise.all([
      sb.from('profiles').select('id, email').in('id', ids),
      sb.from('user_credentials').select('user_id, status').in('user_id', ids),
    ]);
    for (const c of (credentials ?? []) as Array<{ user_id: string; status: string | null }>) {
      if (c.status === 'disabled') eligible.delete(String(c.user_id));
    }
    profiles = (profileRows ?? []) as Array<{ id: string; email: string | null }>;
  }

  const excludedAddresses = new Set(
    profiles.filter((p) => !eligible.has(String(p.id))).map((p) => String(p.email || '').trim().toLowerCase()),
  );
  const reachable = profiles
    .filter((p) => eligible.has(String(p.id)))
    .map((p) => ({ id: String(p.id), to: parseEmailAddress(p.email) }))
    .filter((p): p is { id: string; to: string } => Boolean(p.to));

  if (reachable.length) {
    // Each one's own switch; a lookup that fails mails nobody, since not
    // knowing is not consent (notificationEmail/queue.ts).
    const declined = await operatorsDeclining(config, reachable.map((p) => p.id), OFFLINE_MESSAGES_EMAIL);
    const wanted = declined ? reachable.filter((p) => !declined.has(p.id)) : [];
    if (!wanted.length) return [];
    const locales = await operatorLocales(config, wanted.map((p) => p.id));
    return wanted.map((p) => ({ key: p.id, to: p.to, locale: locales.get(p.id) || 'en', member: true }));
  }

  const { data: settings } = await sb
    .from('email_settings')
    .select('reply_to_email')
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  const replyTo = parseEmailAddress((settings as { reply_to_email?: string | null } | null)?.reply_to_email);
  if (!replyTo || excludedAddresses.has(replyTo.toLowerCase())) return [];
  return [{ key: 'reply_to', to: replyTo, locale: await operatorFallbackLocale(config), member: false }];
}

// ─── At once, merged, or not at all ───────────────────────────────────────

type NoticeVerdict =
  | { kind: 'immediate' }
  | { kind: 'summary'; count: number; windowStartedAt: Date; windowEndsAt: Date }
  | { kind: 'capped' };

async function noticeVerdict(config: ServerConfig, workspaceId: string): Promise<NoticeVerdict> {
  const day = { scope: 'offline_notice_day', key: workspaceId, windowSeconds: DAY_SECONDS, max: OFFLINE_NOTICE_WINDOWS_PER_DAY };
  const window = await takeEmailQuota(config, {
    scope: 'offline_notice_window', key: workspaceId, windowSeconds: OFFLINE_NOTICE_WINDOW_SECONDS, max: 1,
  });
  if (window.allowed) {
    return (await takeEmailQuota(config, day)).allowed ? { kind: 'immediate' } : { kind: 'capped' };
  }
  // A window opened over the day's cap mails nothing, its summary included.
  if ((await peekEmailQuota(config, day)).used > OFFLINE_NOTICE_WINDOWS_PER_DAY) return { kind: 'capped' };
  return {
    kind: 'summary',
    count: Math.max(1, window.used - 1),
    windowStartedAt: window.windowStartedAt,
    windowEndsAt: window.windowEndsAt,
  };
}

// ─── The mails ────────────────────────────────────────────────────────────

async function appLink(config: ServerConfig, workspaceId: string, path: string): Promise<string> {
  try {
    return await resolveWorkspaceAppUrl(config, workspaceId, path);
  } catch {
    return '';
  }
}

/**
 * The way out, for a member: the one-click List-Unsubscribe and the line
 * under the mail's text, in their language, as every operator notification
 * email carries them; the line points at the settings page when there is no
 * https link to give. The workspace's reply-to address gets neither: it is
 * the workspace's own setting (Settings → Email), not a person's
 * subscription.
 */
async function optOut(
  config: ServerConfig,
  workspaceId: string,
  recipient: NoticeRecipient,
  linkBase: string | null,
): Promise<Pick<EmailRequest, 'listUnsubscribe' | 'footer'>> {
  if (!recipient.member) return {};
  const unsubscribe = unsubscribeUrl(linkBase, recipient.key, OFFLINE_MESSAGES_EMAIL);
  const settings = unsubscribe ? null : (await appLink(config, workspaceId, '/settings/notifications')) || null;
  return {
    ...(unsubscribe ? { listUnsubscribe: { url: unsubscribe } } : {}),
    footer: notificationFooter(recipient.locale, OFFLINE_MESSAGES_EMAIL, { unsubscribe, settings }),
  };
}

/**
 * The notice for one capture. The template's subject and text part get no
 * visitor text (its keys are there, empty, so a placeholder never shows as
 * written); the HTML part gets the escaped copies. The built-in text below
 * is sent only when the template is missing: a fixed subject, the visitor's
 * words escaped in the HTML and as typed in the text part.
 */
function noticeRequest(
  workspaceId: string,
  capture: OfflineCapture,
  inboxUrl: string,
  to: string,
  locale: string,
): EmailRequest {
  const name = capture.name || '';
  const email = capture.email || '';
  const phone = capture.phone || '';
  const html = `
    <p>A visitor left a message while your workspace was offline.</p>
    <p><strong>From:</strong> ${escapeMailText(name || 'Anonymous')} ${email ? `&lt;${escapeMailText(email)}&gt;` : ''}</p>
    ${phone ? `<p><strong>Phone:</strong> <span dir="ltr">${escapeMailText(phone)}</span></p>` : ''}
    <p><strong>Message:</strong></p>
    <blockquote style="border-left:3px solid #ccc;padding-left:12px;">${escapeMailText(capture.message)}</blockquote>
    <p>${inboxUrl ? `<a href="${escapeMailText(inboxUrl)}">Open this conversation in the inbox to reply.</a>` : 'Open this conversation in the inbox to reply.'}</p>
  `;
  const text = `New offline message\nFrom: ${name || 'Anonymous'} ${email}${phone ? `\nPhone: ${phone}` : ''}\n\n${capture.message}${inboxUrl ? `\n\n${inboxUrl}` : ''}`;
  return {
    workspaceId,
    to,
    subject: 'New offline message',
    html,
    text,
    templateSlug: 'offline_message_received',
    templateData: {
      conversation_id: capture.conversationId,
      action_url: inboxUrl,
      contact_name: '',
      contact_email: '',
      contact_phone: '',
      message_body: '',
    },
    htmlData: {
      contact_name: escapeMailText(name),
      contact_email: escapeMailText(email),
      contact_phone: escapeMailText(phone),
      message_body: escapeMailText(capture.message),
      action_url: escapeMailText(inboxUrl),
    },
    locale,
    category: 'notification',
  };
}

/** A number in the recipient's digits (Persian ones for fa). */
function localNumber(value: number, locale: string): string {
  const tag = locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US';
  try {
    return new Intl.NumberFormat(tag).format(value);
  } catch {
    return String(value);
  }
}

/** The summary's built-in text, for when its template (289d) is missing. */
const SUMMARY_FALLBACK: Record<string, { subject: string; line: string; open: string }> = {
  en: {
    subject: 'More offline messages: {count}',
    line: 'After the message we told you about, {count} more arrived in the next {minutes} minutes.',
    open: 'Open the inbox',
  },
  fa: {
    subject: 'پیام‌های آفلاین بیشتر: {count}',
    line: 'بعد از پیامی که خبرش را برایتان فرستادیم، در {minutes} دقیقه‌ی بعد {count} پیام دیگر هم رسید.',
    open: 'باز کردن صندوق ورودی',
  },
  tr: {
    subject: 'Daha fazla çevrimdışı mesaj: {count}',
    line: 'Size bildirdiğimiz mesajdan sonraki {minutes} dakika içinde {count} mesaj daha geldi.',
    open: 'Gelen kutusunu aç',
  },
};

/** The window's summary: how many more, and the inbox. Nothing a visitor typed. */
function summaryRequest(workspaceId: string, count: number, inboxUrl: string, to: string, locale: string): EmailRequest {
  const lang = locale.slice(0, 2);
  const words = SUMMARY_FALLBACK[lang] ?? SUMMARY_FALLBACK.en;
  const values = { count: localNumber(count, lang), minutes: localNumber(OFFLINE_NOTICE_WINDOW_SECONDS / 60, lang) };
  const fill = (s: string) => s.replace('{count}', values.count).replace('{minutes}', values.minutes);
  const dir = lang === 'fa' ? 'rtl' : 'ltr';
  return {
    workspaceId,
    to,
    subject: fill(words.subject),
    html: `<div dir="${dir}"><p>${fill(words.line)}</p>${inboxUrl ? `<p><a href="${escapeMailText(inboxUrl)}">${words.open}</a></p>` : ''}</div>`,
    text: `${fill(words.line)}${inboxUrl ? `\n\n${inboxUrl}` : ''}`,
    templateSlug: 'offline_messages_summary',
    templateData: { ...values, action_url: inboxUrl },
    htmlData: { action_url: escapeMailText(inboxUrl) },
    locale,
    category: 'notification',
  };
}

/**
 * Queues one mail. Without the outbox (migration 289b not applied), the
 * notice is sent here, once, as it used to be; a summary, which must wait
 * for the end of its window, is then not sent at all.
 */
async function queue(
  config: ServerConfig,
  request: EmailRequest,
  options: EmailOutboxOptions,
  sendInlineWithoutOutbox: boolean,
): Promise<void> {
  const queued = await enqueueEmail(config, request, options);
  if (queued.queued) return;
  if (queued.error === 'outbox_unavailable' && sendInlineWithoutOutbox) {
    const result = await sendEmail(config, request);
    if (!result.success) console.warn('[offline-notice] notice not sent:', result.error);
    return;
  }
  console.warn('[offline-notice] mail not queued:', queued.error);
}

/**
 * Tells the workspace's owners and admins about one captured message, when
 * the team is away: at once for the window's first capture, in the window's
 * summary for the ones after it, not at all past the day's cap. `teamOnline`
 * is the availability the caller already resolved (POST /offline-messages);
 * without it, it is resolved here. Never throws for a mail that cannot go.
 */
export async function notifyOfflineCapture(
  config: ServerConfig,
  workspaceId: string,
  capture: OfflineCapture,
  opts: { teamOnline?: boolean } = {},
): Promise<OfflineNoticeOutcome> {
  const teamOnline = opts.teamOnline ?? (await resolveAvailability(config, { workspaceId })).state === 'online';
  if (teamOnline) return 'team_online';

  const recipients = await noticeRecipients(config, workspaceId);
  if (!recipients.length) return 'no_recipient';

  const verdict = await noticeVerdict(config, workspaceId);
  if (verdict.kind === 'capped') {
    console.info('[offline-notice] the workspace\'s notices for today are used up; the inbox has the message', { workspaceId });
    return 'capped';
  }

  const item = capture.messageId || capture.conversationId;
  const linkBase = await unsubscribeBaseUrl(config);
  if (verdict.kind === 'immediate') {
    const inboxUrl = await appLink(config, workspaceId, `/inbox?c=${encodeURIComponent(capture.conversationId)}`);
    for (const r of recipients) {
      const request = { ...noticeRequest(workspaceId, capture, inboxUrl, r.to, r.locale), ...(await optOut(config, workspaceId, r, linkBase)) };
      await queue(config, request, { dedupeKey: `offline_message:${item}:${r.key}` }, true);
    }
    return 'immediate';
  }

  // Each later capture queues the summary anew with the new count, for the
  // window's end, ranked by that count: of the summaries under one
  // supersedeKey the outbox sends the highest, so two captures of a burst
  // that reach the queue out of order still end in the larger count.
  const inboxUrl = await appLink(config, workspaceId, '/inbox');
  for (const r of recipients) {
    const request = { ...summaryRequest(workspaceId, verdict.count, inboxUrl, r.to, r.locale), ...(await optOut(config, workspaceId, r, linkBase)) };
    await queue(config, request, {
      dedupeKey: `offline_summary:${item}:${r.key}`,
      supersedeKey: `offline_summary:${workspaceId}:${verdict.windowStartedAt.getTime()}:${r.key}`,
      supersedeRank: verdict.count,
      notBefore: verdict.windowEndsAt,
    }, false);
  }
  return 'summary';
}

/**
 * The panel's test of this mail: the same notice, with sample details, sent
 * now (not queued) so the answer is the provider's real one.
 */
export async function sendOfflineNoticeTest(
  config: ServerConfig,
  input: { workspaceId: string; to: string; locale: string },
): Promise<SendResult> {
  const inboxUrl = await appLink(config, input.workspaceId, '/inbox');
  return sendEmail(config, noticeRequest(input.workspaceId, {
    conversationId: 'test-conversation-id',
    message: 'Hello — this is a test message confirming your offline notification pipeline works.',
    name: 'Test Visitor',
    email: 'visitor@example.com',
    phone: '+989121234567',
  }, inboxUrl, input.to, input.locale));
}
