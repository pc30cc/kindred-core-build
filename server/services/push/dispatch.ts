/**
 * CENTRAL PUSH DISPATCH.
 *
 * The single point where a Webyar event becomes a native notification. No
 * provider handler (Telegram / WhatsApp / Instagram / Bale / widget) ever
 * calls FCM directly: they all reach this module through
 * `notifyInboundMessage`, which is channel-agnostic.
 *
 * Load-bearing properties:
 *  • Best effort, never transactional. `notifyInboundMessage` never throws and
 *    is always invoked fire-and-forget AFTER the message row is committed, so
 *    a Google outage can never fail a customer's message.
 *  • Idempotent. One row in `push_dispatch_log` per (workspace, user,
 *    dedupe_key = `${type}:${messageId}`) with a UNIQUE index: a provider
 *    re-delivery or an internal retry produces zero extra visible
 *    notifications.
 *  • Multi-device fanout with independent failures: a dead token on one phone
 *    is disabled and never blocks the others.
 *  • Payloads carry identifiers only — routing hints, never authorization.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { sendFcmMessage, isPushConfigured, type ApnsDelivery } from './fcm.js';
import { sendApnsAlert, isApnsConfigured, nativeBundleId } from './apns.js';
import { listActiveDevices, disableToken, type PushDeviceRow } from './devices.js';
import {
  resolveRecipients,
  unreadBadgeCount,
  type PushEventType,
  type Recipient,
} from './recipients.js';
import {
  DEFAULT_CATEGORIES,
  loadPushPlatformSettings,
  renderTemplate,
  type PushPlatformSettings,
} from './platformSettings.js';

/** The conversation columns this module reads. */
interface ConversationRow {
  id: string;
  workspace_id: string;
  assigned_to: string | null;
  status: string;
  is_spam?: boolean | null;
  ai_state?: string | null;
  contacts?: { name: string | null } | { name: string | null }[] | null;
}

export interface InboundPushInput {
  workspaceId: string;
  conversationId: string;
  /**
   * The message this is about — or, for an event that is not a message (an
   * assignment, a handoff), any id unique to the event: it is only the
   * dedupe key then.
   */
  messageId: string;
  /** Raw message text; only used when the recipient allows previews. */
  text?: string | null;
  /** Display name of the customer / note author / colleague / email sender. */
  senderName?: string | null;
  /** Who did it, by name — the teammate who assigned a conversation. */
  actorName?: string | null;
  channel?: string | null;
  eventType?: PushEventType;
  actorId?: string | null;
  mentionedUserIds?: string[];
  attachmentCount?: number;
  /** The one operator an event is for — the assignee of an assignment. */
  targetUserId?: string | null;
  /** The workspace's name, for templates that use `{{workspace}}`. */
  workspaceName?: string | null;
}

/**
 * The copy a notification falls back to when no operator-written template
 * covers it, in the RECIPIENT's language.
 *
 * All of this used to be hardcoded, and in two languages at once: the privacy
 * body was Persian and everything else was English, so an English operator
 * who turned previews off got "پیام جدید در Webyar" on their lock screen and
 * a Turkish one got a sentence in neither of their languages. The recipient's
 * locale was already being resolved and passed in here — `recipients.ts`
 * reads `profiles.preferred_locale` precisely so a Turkish operator does not
 * get a Persian push because the customer wrote in Persian — and then only
 * the template path used it.
 *
 * The brand is not translated: `Str.brandWordmark` in the app makes the same
 * call for the same reason.
 */
const COPY = {
  en: {
    privacyTitle: 'Webyar',
    privacyBody: 'New message in Webyar',
    customer: 'Customer',
    attachment: '📎 Attachment',
    newMessage: 'New message',
    internalNote: (name: string) => `${name} · internal note`,
    mentioned: (name: string) => `${name} mentioned you`,
    assigned: (actor: string) => `Assigned to you · ${actor}`,
    autoRouting: 'automatic routing',
    handoff: 'The AI handed this conversation to your team',
    colleague: 'Colleague',
    emailSender: 'Email',
  },
  fa: {
    privacyTitle: 'Webyar',
    privacyBody: 'پیام جدید در وب‌یار',
    customer: 'مشتری',
    attachment: '📎 پیوست',
    newMessage: 'پیام جدید',
    internalNote: (name: string) => `${name} · یادداشت داخلی`,
    mentioned: (name: string) => `${name} شما را نام برد`,
    assigned: (actor: string) => `به شما سپرده شد · ${actor}`,
    autoRouting: 'تخصیص خودکار',
    handoff: 'هوش مصنوعی این گفتگو را به تیم شما سپرد',
    colleague: 'همکار',
    emailSender: 'ایمیل',
  },
  tr: {
    privacyTitle: 'Webyar',
    privacyBody: "Webyar'da yeni mesaj",
    customer: 'Müşteri',
    attachment: '📎 Ek',
    newMessage: 'Yeni mesaj',
    internalNote: (name: string) => `${name} · dahili not`,
    mentioned: (name: string) => `${name} sizden bahsetti`,
    assigned: (actor: string) => `Size atandı · ${actor}`,
    autoRouting: 'otomatik yönlendirme',
    handoff: 'Yapay zekâ bu konuşmayı ekibinize devretti',
    colleague: 'Ekip arkadaşı',
    emailSender: 'E-posta',
  },
} as const;

type CopyLocale = keyof typeof COPY;

/** `fa-IR`, `FA`, `fa_IR` and nonsense all land somewhere sensible. */
function copyLocale(locale: string | null | undefined): CopyLocale {
  const base = String(locale ?? '').trim().toLowerCase().split(/[-_]/)[0];
  return base === 'fa' || base === 'tr' ? base : 'en';
}

/**
 * U+200F RIGHT-TO-LEFT MARK, where it is actually needed.
 *
 * A notification banner has no direction of its own: iOS lays the text out by
 * the FIRST STRONG character it finds. Persian copy that starts with a
 * Persian letter comes out right-aligned on its own and needs nothing. The
 * case that breaks is Persian copy that starts with the CUSTOMER'S NAME,
 * which is as often "Ali" or "Sarah" as it is Persian — one Latin first
 * letter and the whole line flips to left-aligned, with the punctuation
 * stranded on the wrong end.
 *
 * So the mark goes on exactly that: a line with Persian in it whose first
 * strong character is Latin. Putting it on everything would also right-align
 * "Webyar" on its own, which is a Latin word with no reason to move.
 */
const RLM = '\u200F';

/** Hebrew, Arabic, Persian and the Arabic presentation forms. */
const RTL_LETTER = /[\u0590-\u08FF\uFB1D-\uFDFF\uFE70-\uFEFF]/;
/** Latin, including the accented ranges Turkish needs. */
const LTR_LETTER = /[A-Za-z\u00C0-\u024F]/;

/** Which way iOS will read this line, or null when nothing in it is strong. */
function firstStrongDirection(value: string): 'ltr' | 'rtl' | null {
  for (const character of value) {
    if (RTL_LETTER.test(character)) return 'rtl';
    if (LTR_LETTER.test(character)) return 'ltr';
  }
  return null;
}

function directed(locale: CopyLocale, value: string): string {
  if (locale !== 'fa' || !value) return value;
  if (!RTL_LETTER.test(value)) return value;
  return firstStrongDirection(value) === 'ltr' ? `${RLM}${value}` : value;
}

/**
 * A customer message arrived — the original entry point, kept for its two
 * callers (the widget and the channel ingestion path).
 */
export async function notifyInboundMessage(
  config: ServerConfig,
  input: InboundPushInput,
): Promise<void> {
  return notifyConversationEvent(config, input);
}

/**
 * Anything about one customer conversation: a new message, a note, a
 * mention, an assignment, a handoff from the AI.
 *
 * Never throws, and is always invoked fire-and-forget AFTER the change it
 * reports is committed.
 */
export async function notifyConversationEvent(
  config: ServerConfig,
  input: InboundPushInput,
): Promise<void> {
  try {
    const policy = await livePolicy(config);
    if (!policy) return;
    const eventType: PushEventType = input.eventType ?? 'new_message';
    const sb = getServiceClient(config);

    // Conversation state is read server-side; the caller's IDs are never
    // treated as authority for who may be notified.
    const { data: conversationRow } = await sb
      .from('conversations')
      .select('id, workspace_id, assigned_to, status, is_spam, ai_state, contacts(name)')
      .eq('id', input.conversationId)
      .maybeSingle();
    const conv = conversationRow as ConversationRow | null;
    if (!conv || String(conv.workspace_id) !== input.workspaceId) return;

    // Spam is hidden from every inbox; it does not get to buzz a phone.
    if (conv.is_spam) return;
    // The AI is answering this one and nobody holds it: the operator would
    // be woken for a conversation their inbox deliberately keeps out of the
    // way. The handoff, when it comes, is its own event.
    if (eventType === 'new_message' && conv.ai_state === 'ai_managed' && !conv.assigned_to) return;
    // An assignment is only news while it still stands.
    if (eventType === 'assigned') {
      if (!input.targetUserId || conv.assigned_to !== input.targetUserId) return;
    }

    const recipients = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      assignedTo: conv.assigned_to ?? null,
      eventType,
      targetUserIds: eventType === 'assigned' && input.targetUserId ? [input.targetUserId] : undefined,
      actorId: input.actorId ?? null,
      mentionedUserIds: input.mentionedUserIds,
      policy,
    });
    if (!recipients.length) return;

    const contact = Array.isArray(conv.contacts) ? conv.contacts[0] : conv.contacts;
    const content: InboundPushInput = {
      ...input,
      senderName: input.senderName ?? contact?.name ?? null,
    };

    const data: Record<string, string> = {
      type: eventType,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
    };
    if (eventType === 'new_message') data.messageId = input.messageId;
    if (input.channel) data.channel = String(input.channel).slice(0, 32);

    const workspace = await workspaceName(config, input.workspaceId);
    await deliver(config, {
      workspaceId: input.workspaceId,
      eventType,
      recipients,
      data,
      dedupeKey: `${eventType}:${input.messageId}`,
      conversationId: input.conversationId,
      messageId: eventType === 'new_message' ? input.messageId : null,
      collapseId: policy.collapse_enabled ? `conv-${input.conversationId}` : undefined,
      threadId: threadIdFor(policy, input.workspaceId, input.conversationId),
      policy,
      content: (recipient) =>
        renderContent({ ...content, workspaceName: workspace }, eventType, recipient.preview, policy, recipient.locale),
    });
  } catch (err) {
    // Absolutely terminal: push must never surface into the ingestion path.
    console.error('[push] dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

export interface TeamMessagePushInput {
  workspaceId: string;
  senderId: string;
  recipientId: string;
  messageId: string;
  text?: string | null;
  hasAttachment?: boolean;
}

/**
 * A colleague wrote to the operator in team chat. Only the recipient is ever
 * considered — a direct message is nobody else's business.
 */
export async function notifyTeamMessage(
  config: ServerConfig,
  input: TeamMessagePushInput,
): Promise<void> {
  try {
    if (input.senderId === input.recipientId) return;
    const policy = await livePolicy(config);
    if (!policy) return;

    const recipients = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      conversationId: null,
      assignedTo: null,
      eventType: 'team_message',
      targetUserIds: [input.recipientId],
      actorId: input.senderId,
      policy,
    });
    if (!recipients.length) return;

    const senderName = await personName(config, input.senderId);
    const workspace = await workspaceName(config, input.workspaceId);
    const thread = `team-${input.senderId}`;
    await deliver(config, {
      workspaceId: input.workspaceId,
      eventType: 'team_message',
      recipients,
      data: {
        type: 'team_message',
        workspaceId: input.workspaceId,
        // The thread is the colleague: the app opens the conversation with
        // whoever wrote.
        teamPeerId: input.senderId,
        messageId: input.messageId,
      },
      dedupeKey: `team_message:${input.messageId}`,
      collapseId: policy.collapse_enabled ? thread : undefined,
      threadId: threadIdFor(policy, input.workspaceId, thread),
      policy,
      content: (recipient) =>
        renderContent(
          {
            workspaceId: input.workspaceId,
            conversationId: '',
            messageId: input.messageId,
            senderName,
            text: input.text ?? null,
            attachmentCount: input.hasAttachment ? 1 : 0,
            workspaceName: workspace,
          },
          'team_message',
          recipient.preview,
          policy,
          recipient.locale,
        ),
    });
  } catch (err) {
    console.error('[push] team dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

export interface EmailPushInput {
  workspaceId: string;
  threadId: string;
  messageId: string;
  /** The raw From: — `Name <address>` or a bare address. */
  from: string;
  subject?: string | null;
  snippet?: string | null;
  /** When the email was sent, as the provider reports it. */
  sentAt?: string | null;
}

/**
 * How old an email may be and still be news. A mailbox's first sync, or a
 * resync after the provider's history window lapsed, imports the latest
 * messages in one go — days-old mail that must not arrive on a phone as
 * twenty-five banners.
 */
const EMAIL_FRESH_MS = 15 * 60_000;

export function isFreshEmail(sentAt: string | null | undefined, now = Date.now()): boolean {
  if (!sentAt) return true;
  const at = Date.parse(sentAt);
  if (!Number.isFinite(at)) return true;
  return now - at <= EMAIL_FRESH_MS;
}

/**
 * A new email arrived in the workspace's shared inbox. The inbox is an
 * owner/admin surface, so only they are told about it.
 */
export async function notifyInboundEmail(
  config: ServerConfig,
  input: EmailPushInput,
): Promise<void> {
  try {
    if (!isFreshEmail(input.sentAt)) return;
    const policy = await livePolicy(config);
    if (!policy) return;

    const recipients = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      conversationId: null,
      assignedTo: null,
      eventType: 'email',
      roles: ['owner', 'admin'],
      policy,
    });
    if (!recipients.length) return;

    const workspace = await workspaceName(config, input.workspaceId);
    const thread = `email-${input.threadId}`;
    const subject = (input.subject || '').trim();
    const snippet = (input.snippet || '').trim();
    await deliver(config, {
      workspaceId: input.workspaceId,
      eventType: 'email',
      recipients,
      data: {
        type: 'email',
        workspaceId: input.workspaceId,
        emailThreadId: input.threadId,
        messageId: input.messageId,
      },
      dedupeKey: `email:${input.messageId}`,
      collapseId: policy.collapse_enabled ? thread : undefined,
      threadId: threadIdFor(policy, input.workspaceId, thread),
      policy,
      content: (recipient) =>
        renderContent(
          {
            workspaceId: input.workspaceId,
            conversationId: '',
            messageId: input.messageId,
            senderName: emailSenderName(input.from),
            // The subject says what an email is about; the snippet is what a
            // subject-less one has instead.
            text: subject && snippet ? `${subject} — ${snippet}` : subject || snippet,
            workspaceName: workspace,
          },
          'email',
          recipient.preview,
          policy,
          recipient.locale,
        ),
    });
  } catch (err) {
    console.error('[push] email dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

/** `"Sara Karimi" <sara@example.com>` → Sara Karimi; a bare address stays. */
export function emailSenderName(from: string): string {
  const raw = String(from || '').trim();
  const named = /^\s*"?([^"<]+?)"?\s*<[^>]+>\s*$/.exec(raw);
  if (named && named[1].trim()) return named[1].trim();
  const bracketed = /<([^>]+)>/.exec(raw);
  return (bracketed ? bracketed[1] : raw).trim();
}

/**
 * The platform policy, or null when nothing may be sent at all: no transport
 * configured, or Super Admin's master switch off. Either transport being
 * available is enough — a deployment with an APNs key and no Firebase
 * service account reaches every native operator app.
 */
async function livePolicy(config: ServerConfig): Promise<PushPlatformSettings | null> {
  if (!isPushConfigured() && !isApnsConfigured()) return null;
  const policy = await loadPushPlatformSettings(config);
  return policy.push_enabled ? policy : null;
}

interface Delivery {
  workspaceId: string;
  eventType: PushEventType;
  recipients: Recipient[];
  data: Record<string, string>;
  /** Unique per event; one log row per (workspace, user, key). */
  dedupeKey: string;
  conversationId?: string | null;
  /** A customer message's id, or null for an event that is not one. */
  messageId?: string | null;
  collapseId?: string;
  threadId?: string;
  policy: PushPlatformSettings;
  content: (recipient: Recipient) => { title: string; body: string };
}

/**
 * Claim, render, send and log, for every recipient with a device. Shared by
 * every kind of event so each one gets the same idempotency, the same
 * dead-token handling and the same log.
 */
async function deliver(config: ServerConfig, d: Delivery): Promise<void> {
  const sb = getServiceClient(config);

  // One device lookup for every recipient, up front. A recipient with no
  // active device has nothing to deliver to, so they get no claim row and
  // no status update.
  const devicesByUser = new Map<string, PushDeviceRow[]>();
  for (const device of await listActiveDevices(config, d.recipients.map((r) => r.userId))) {
    const list = devicesByUser.get(device.user_id);
    if (list) list.push(device);
    else devicesByUser.set(device.user_id, [device]);
  }

  for (const recipient of d.recipients) {
    const devices = devicesByUser.get(recipient.userId) ?? [];
    if (!devices.length) continue;

    // Idempotency gate: the UNIQUE index rejects the second attempt for the
    // same (workspace, user, event) — that rejection IS the suppression.
    const { error: claimError } = await sb.from('push_dispatch_log').insert({
      workspace_id: d.workspaceId,
      user_id: recipient.userId,
      conversation_id: d.conversationId ?? null,
      message_id: d.messageId ?? null,
      notification_type: d.eventType,
      dedupe_key: d.dedupeKey,
      status: 'attempted',
    });
    if (claimError) continue; // duplicate (or logging outage) → stay silent

    const badge = d.policy.badge_enabled
      ? await unreadBadgeCount(config, recipient.userId, d.workspaceId)
      : undefined;
    const { title, body } = d.content(recipient);
    const apns = apnsDeliveryFor(d.policy, d.eventType, d.threadId);

    let accepted = 0;
    let failed = 0;
    for (const device of devices) {
      // The row says which door. Both transports answer with the same three
      // things that matter here — did it go, is the address dead, what did
      // the service say — so only the call itself differs.
      const outcome = device.transport === 'apns'
        ? await sendApnsAlert({
            token: device.push_token,
            title,
            body,
            data: d.data,
            badge,
            sound: recipient.sound,
            collapseId: d.collapseId,
            apns,
            topic: nativeBundleId(),
          })
        : await sendFcmMessage({
            token: device.push_token,
            title,
            body,
            data: d.data,
            badge,
            sound: recipient.sound,
            collapseKey: d.collapseId,
            androidChannelId: d.policy.android_channel_id,
            apns,
          });
      if (outcome.ok) {
        accepted += 1;
      } else {
        failed += 1;
        if (outcome.unregistered) {
          await disableToken(
            config,
            device.push_token,
            device.transport === 'apns' ? 'apns_unregistered' : 'fcm_unregistered',
          );
          console.warn('[push] token unregistered, device disabled', {
            userId: recipient.userId,
            platform: device.platform,
            transport: device.transport,
          });
        } else {
          console.warn('[push] send failed', {
            userId: recipient.userId,
            platform: device.platform,
            transport: device.transport,
            status: outcome.status,
          });
        }
      }
    }

    await sb
      .from('push_dispatch_log')
      .update({
        device_count: devices.length,
        accepted_count: accepted,
        failed_count: failed,
        status: accepted > 0 ? 'sent' : 'failed',
      })
      .eq('workspace_id', d.workspaceId)
      .eq('user_id', recipient.userId)
      .eq('dedupe_key', d.dedupeKey);
  }
}

/** The workspace's display name, for the `{{workspace}}` placeholder. */
async function workspaceName(config: ServerConfig, workspaceId: string): Promise<string | null> {
  try {
    const { data } = await getServiceClient(config)
      .from('workspaces')
      .select('name')
      .eq('id', workspaceId)
      .maybeSingle();
    const name = (data as { name?: string | null } | null)?.name;
    return name ? String(name) : null;
  } catch {
    return null;
  }
}

/** An operator's name as their colleagues see it. */
async function personName(config: ServerConfig, userId: string): Promise<string | null> {
  try {
    const { data } = await getServiceClient(config)
      .from('profiles')
      .select('full_name, email')
      .eq('id', userId)
      .maybeSingle();
    const row = data as { full_name?: string | null; email?: string | null } | null;
    return (row?.full_name || '').trim() || (row?.email || '').trim() || null;
  } catch {
    return null;
  }
}

/**
 * Notification copy. Privacy mode is a per-user server-side preference, so the
 * text never reaches the device at all when previews are off — hiding it in
 * the app would be theatre, since the payload is visible on a locked phone.
 *
 * With a policy present the operator-editable templates decide the wording,
 * rendered in the RECIPIENT's language. Without one (tests, or a deployment
 * that has not applied migration 195) the original hardcoded copy is used, so
 * behaviour is identical to before the templates existed.
 */
export function renderContent(
  input: InboundPushInput,
  eventType: PushEventType,
  preview: boolean,
  policy?: PushPlatformSettings | null,
  locale = 'en',
): { title: string; body: string } {
  const lang = copyLocale(locale);
  const copy = COPY[lang];
  const mark = (result: { title: string; body: string }) => ({
    title: directed(lang, result.title),
    body: directed(lang, result.body),
  });

  const whoDefault =
    eventType === 'team_message' ? copy.colleague : eventType === 'email' ? copy.emailSender : copy.customer;
  const name = (input.senderName || '').trim() || whoDefault;
  const text = (input.text || '').trim();
  const fallback = input.attachmentCount ? copy.attachment : copy.newMessage;
  // Nobody assigned it by hand: the routing rules did.
  const actor = (input.actorName || '').trim() || copy.autoRouting;

  if (policy) {
    // Templates are keyed by bare language ("fa"), and profiles store full
    // tags ("fa-IR") — rendering with the raw tag fell through to the
    // English default for every Persian operator.
    const rendered = renderTemplate(policy, eventType, lang, preview, {
      sender: name,
      preview: truncate(text || fallback),
      count: String(input.attachmentCount ?? 0),
      workspace: (input.workspaceName || '').trim() || 'Webyar',
      actor,
    });
    // A template edited down to nothing must not produce a blank banner.
    if (rendered.title.trim() && rendered.body.trim()) return mark(rendered);
  }

  if (!preview) return mark({ title: copy.privacyTitle, body: copy.privacyBody });
  if (eventType === 'internal_note') {
    return mark({ title: copy.internalNote(name), body: truncate(text || fallback) });
  }
  if (eventType === 'mention') {
    return mark({ title: copy.mentioned(name), body: truncate(text || fallback) });
  }
  if (eventType === 'assigned') return mark({ title: name, body: copy.assigned(actor) });
  if (eventType === 'handoff') return mark({ title: name, body: copy.handoff });
  return mark({ title: name, body: truncate(text || fallback) });
}

/**
 * The APNs thread a notification groups under, by platform policy: one per
 * conversation (or colleague, or email thread), one per workspace, or none.
 */
function threadIdFor(
  policy: PushPlatformSettings,
  workspaceId: string,
  key: string,
): string | undefined {
  if (policy.thread_id_strategy === 'conversation') return key;
  if (policy.thread_id_strategy === 'workspace') return workspaceId;
  return undefined;
}

/**
 * The APNs half of a send, derived from platform policy. The category id is
 * the one registered for this event type, which is what gives the banner its
 * action buttons ("Reply", "Mark as read") on the device.
 *
 * A category list saved before an event type existed does not name it, so
 * the shipped categories answer for it: a team message saved into an old
 * policy still gets the team-chat Reply rather than no buttons at all.
 */
function apnsDeliveryFor(
  policy: PushPlatformSettings,
  eventType: PushEventType,
  threadId?: string,
): ApnsDelivery {
  const category =
    (policy.categories ?? []).find((c) => c.eventTypes?.includes(eventType)) ??
    DEFAULT_CATEGORIES.find((c) => c.eventTypes.includes(eventType));
  return {
    priority: policy.apns_priority,
    ttlSeconds: policy.apns_ttl_seconds,
    interruptionLevel: policy.interruption_level,
    relevanceScore: policy.relevance_score,
    threadId,
    categoryId: category?.id,
    soundName: policy.sound_name,
    mutableContent: policy.mutable_content,
    critical: policy.critical_alerts_enabled,
    criticalVolume: policy.critical_alert_volume,
  };
}

function truncate(value: string, max = 180): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
