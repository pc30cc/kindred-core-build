/**
 * CENTRAL PUSH DISPATCH.
 *
 * The single point where a Webyar event becomes a native notification. No
 * provider handler (Telegram / WhatsApp / Instagram / Bale / widget) ever
 * calls FCM directly: they all reach this module through
 * `notifyInboundMessage`, which is channel-agnostic. A colleague's message in
 * team chat, which is about no conversation, comes in through
 * `notifyTeamMessage` and leaves by the same road.
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
import { resolveRecipients, unreadBadgeCount, type PushEventType, type Recipient } from './recipients.js';
import { contactDisplayName, type NamedContact } from './contactName.js';
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
  contact_id: string | null;
  is_spam?: boolean | null;
  ai_state?: string | null;
}

export interface InboundPushInput {
  workspaceId: string;
  conversationId: string;
  messageId: string;
  /** Raw message text; only used when the recipient allows previews. */
  text?: string | null;
  /** Display name of the customer / note author. */
  senderName?: string | null;
  channel?: string | null;
  eventType?: PushEventType;
  actorId?: string | null;
  mentionedUserIds?: string[];
  attachmentCount?: number;
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
    colleague: 'Colleague',
    teamPrivacyBody: 'New message from a colleague',
    teamMessage: (name: string) => `${name} · colleague`,
    support: 'Support',
    supportPrivacyBody: 'New reply from support',
    supportReply: (name: string) => `${name} · Support`,
    assignedTitle: 'Conversation assigned to you',
    assignedPrivacyBody: 'A conversation was assigned to you',
    assignedBy: (name: string) => `Assigned by ${name}`,
    handoffTitle: 'Needs a person',
    handoffBody: 'The AI handed this conversation to your team',
    handoffPrivacyBody: 'A conversation needs a person',
    emailTitle: 'New email',
    emailPrivacyBody: 'New email in Webyar',
    callbackTitle: 'Callback request',
    callbackBody: 'A visitor asked to be called back',
    visitor: 'Website visitor',
  },
  fa: {
    privacyTitle: 'Webyar',
    privacyBody: 'پیام جدید در وب‌یار',
    customer: 'مشتری',
    attachment: '📎 پیوست',
    newMessage: 'پیام جدید',
    internalNote: (name: string) => `${name} · یادداشت داخلی`,
    mentioned: (name: string) => `${name} شما را نام برد`,
    colleague: 'همکار',
    teamPrivacyBody: 'پیام جدید از همکار',
    teamMessage: (name: string) => `${name} · همکار`,
    support: 'پشتیبانی',
    supportPrivacyBody: 'پاسخ جدید از پشتیبانی',
    supportReply: (name: string) => `${name} · پشتیبانی`,
    assignedTitle: 'گفتگو به شما سپرده شد',
    assignedPrivacyBody: 'گفتگویی به شما سپرده شد',
    assignedBy: (name: string) => `سپرده‌شده توسط ${name}`,
    handoffTitle: 'نیاز به اپراتور',
    handoffBody: 'هوش مصنوعی این گفتگو را به تیم شما سپرد',
    handoffPrivacyBody: 'گفتگویی به اپراتور نیاز دارد',
    emailTitle: 'ایمیل تازه',
    emailPrivacyBody: 'ایمیل تازه در وب‌یار',
    callbackTitle: 'درخواست تماس',
    callbackBody: 'بازدیدکننده‌ای درخواست تماس داده است',
    visitor: 'بازدیدکننده وب‌سایت',
  },
  tr: {
    privacyTitle: 'Webyar',
    privacyBody: "Webyar'da yeni mesaj",
    customer: 'Müşteri',
    attachment: '📎 Ek',
    newMessage: 'Yeni mesaj',
    internalNote: (name: string) => `${name} · dahili not`,
    mentioned: (name: string) => `${name} sizden bahsetti`,
    colleague: 'İş arkadaşı',
    teamPrivacyBody: 'Bir iş arkadaşından yeni mesaj',
    teamMessage: (name: string) => `${name} · iş arkadaşı`,
    support: 'Destek',
    supportPrivacyBody: 'Destekten yeni yanıt',
    supportReply: (name: string) => `${name} · Destek`,
    assignedTitle: 'Görüşme size atandı',
    assignedPrivacyBody: 'Size bir görüşme atandı',
    assignedBy: (name: string) => `${name} tarafından atandı`,
    handoffTitle: 'Bir temsilci gerekiyor',
    handoffBody: 'Yapay zekâ bu görüşmeyi ekibinize devretti',
    handoffPrivacyBody: 'Bir görüşme bir temsilci bekliyor',
    emailTitle: 'Yeni e-posta',
    emailPrivacyBody: 'Webyar\'da yeni e-posta',
    callbackTitle: 'Geri arama isteği',
    callbackBody: 'Bir ziyaretçi geri aranmak istedi',
    visitor: 'Web sitesi ziyaretçisi',
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

export async function notifyInboundMessage(
  config: ServerConfig,
  input: InboundPushInput,
): Promise<void> {
  try {
    // Either transport being available is enough. A deployment with an APNs
    // key and no Firebase service account reaches every native operator app,
    // and returning early here because Google is absent would have silently
    // turned all of them off.
    if (!isPushConfigured() && !isApnsConfigured()) return;
    // Platform policy (Super Admin → Notifications). The master switch is
    // honoured before any work is done, so turning push off is immediate and
    // does not depend on removing credentials.
    const policy = await loadPushPlatformSettings(config);
    if (!policy.push_enabled) return;
    const eventType: PushEventType = input.eventType ?? 'new_message';
    const sb = getServiceClient(config);

    // Conversation state is read server-side; the caller's IDs are never
    // treated as authority for who may be notified.
    const { data: conversationRow } = await sb
      .from('conversations')
      .select('id, workspace_id, assigned_to, status, contact_id, is_spam, ai_state')
      .eq('id', input.conversationId)
      .maybeSingle();
    const conv = conversationRow as ConversationRow | null;
    if (!conv || String(conv.workspace_id) !== input.workspaceId) return;
    // Spam is hidden from every inbox; it does not get to buzz a phone.
    if (conv.is_spam) return;
    // The AI is answering this one and nobody holds it: the inbox keeps it
    // in the AI's own queue, out of the operators' way, and so does the
    // phone. When the AI hands it over, that is its own notification.
    if (eventType === 'new_message' && conv.ai_state === 'ai_managed' && !conv.assigned_to) return;

    // A customer's message is signed with what the operator's app calls
    // them in its list, read from the conversation's contact now — not the
    // name the sender happened to pass, which an anonymous visitor never
    // has. A note is signed by its author, who is passed in.
    const contact = eventType === 'new_message' ? await loadContact(config, conv.contact_id) : null;
    const senderFor = (locale: string): string | null | undefined =>
      eventType !== 'new_message'
        ? input.senderName
        : contact || !input.senderName
          ? contactDisplayName(contact, locale)
          : input.senderName;

    const recipients = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      assignedTo: conv.assigned_to ?? null,
      eventType,
      actorId: input.actorId ?? null,
      mentionedUserIds: input.mentionedUserIds,
      policy,
    });
    if (!recipients.length) return;

    const dedupeKey = `${eventType}:${input.messageId}`;
    const data: Record<string, string> = {
      type: eventType,
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      messageId: input.messageId,
    };
    // Read only when a template asks for it: most never do.
    const content: InboundPushInput = usesPlaceholder(policy, 'workspace')
      ? { ...input, workspaceName: await workspaceName(config, input.workspaceId) }
      : input;
    if (input.channel) data.channel = String(input.channel).slice(0, 32);

    // One device lookup for every recipient, up front. A recipient with no
    // active device has nothing to deliver to, so they get no claim row and
    // no status update: those were two writes per member per message (for a
    // team where only a few people install the app, most of this table),
    // recording only "no_devices", plus a device query each. Every recipient
    // WITH a device is claimed, sent and logged exactly as before.
    const devicesByUser = new Map<string, PushDeviceRow[]>();
    for (const device of await listActiveDevices(config, recipients.map((r) => r.userId))) {
      const list = devicesByUser.get(device.user_id);
      if (list) list.push(device);
      else devicesByUser.set(device.user_id, [device]);
    }

    for (const recipient of recipients) {
      const devices = devicesByUser.get(recipient.userId) ?? [];
      if (!devices.length) continue;

      // Idempotency gate: the UNIQUE index rejects the second attempt for the
      // same (workspace, user, message) — that rejection IS the suppression.
      const { error: claimError } = await sb.from('push_dispatch_log').insert({
        workspace_id: input.workspaceId,
        user_id: recipient.userId,
        conversation_id: input.conversationId,
        message_id: input.messageId,
        notification_type: eventType,
        dedupe_key: dedupeKey,
        status: 'attempted',
      });
      if (claimError) continue; // duplicate (or logging outage) → stay silent

      const badge = policy.badge_enabled
        ? await unreadBadgeCount(config, recipient.userId, input.workspaceId)
        : undefined;
      const { title, body } = renderContent(
        { ...content, senderName: senderFor(recipient.locale) },
        eventType,
        recipient.preview,
        policy,
        recipient.locale,
      );
      const apns = apnsDeliveryFor(policy, eventType, input);

      const collapseId = policy.collapse_enabled ? `conv-${input.conversationId}` : undefined;

      const { accepted, failed } = await deliver(config, recipient, devices, {
        title,
        body,
        data,
        badge,
        collapseId,
        apns,
        androidChannelId: policy.android_channel_id,
      });

      await finish(
        config,
        input.workspaceId,
        recipient.userId,
        dedupeKey,
        devices.length,
        accepted,
        failed,
        accepted > 0 ? 'sent' : 'failed',
      );
    }
  } catch (err) {
    // Absolutely terminal: push must never surface into the ingestion path.
    console.error('[push] dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

export interface TeamPushInput {
  workspaceId: string;
  /** The colleague who wrote it; never notified. */
  senderId: string;
  /** The one operator it is addressed to. */
  recipientId: string;
  /** The `team_messages` row, committed before this is called. */
  messageId: string;
  /** Only shown when the recipient allows previews. */
  text?: string | null;
  hasAttachment?: boolean;
}

/**
 * A colleague's direct message in team chat, as a notification on the phone
 * of the operator it was sent to.
 *
 * Team chat only ever told the recipient over realtime, which reaches an app
 * that is open and nothing else: a message from a colleague to a phone in a
 * pocket arrived in silence. The same properties as `notifyInboundMessage`
 * — best effort and fire-and-forget after the row is committed, one claim
 * per (workspace, user, message), every device independently — and the same
 * preferences: "disable all", scope 'none', presence, quiet hours (which a
 * direct message breaks exactly where a mention would) and previews.
 *
 * `data` names the colleague (`peerId`), not a conversation: that is the
 * thread a tap opens.
 */
export async function notifyTeamMessage(config: ServerConfig, input: TeamPushInput): Promise<void> {
  try {
    if (!isPushConfigured() && !isApnsConfigured()) return;
    if (input.recipientId === input.senderId) return;
    const policy = await loadPushPlatformSettings(config);
    if (!policy.push_enabled) return;
    const eventType: PushEventType = 'team_message';

    // Membership, suspension and preferences are read here, as for any
    // other event; the route's own check is not taken as authority.
    const [recipient] = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      assignedTo: null,
      eventType,
      actorId: input.senderId,
      mentionedUserIds: [input.recipientId],
      userIds: [input.recipientId],
      policy,
    });
    if (!recipient) return;
    const devices = await listActiveDevices(config, [recipient.userId]);
    if (!devices.length) return;

    const sb = getServiceClient(config);
    const dedupeKey = `${eventType}:${input.messageId}`;
    const { error: claimError } = await sb.from('push_dispatch_log').insert({
      workspace_id: input.workspaceId,
      user_id: recipient.userId,
      conversation_id: null,
      message_id: input.messageId,
      notification_type: eventType,
      dedupe_key: dedupeKey,
      status: 'attempted',
    });
    if (claimError) return; // duplicate (or logging outage) → stay silent

    const { data: sender } = await sb
      .from('profiles')
      .select('full_name')
      .eq('id', input.senderId)
      .maybeSingle();
    const { title, body } = renderTeamContent(
      {
        senderName: (sender as { full_name: string | null } | null)?.full_name ?? null,
        text: input.text,
        hasAttachment: input.hasAttachment,
      },
      recipient.preview,
      recipient.locale,
    );
    const badge = policy.badge_enabled
      ? await unreadBadgeCount(config, recipient.userId, input.workspaceId)
      : undefined;
    // One thread per colleague, as the app shows them.
    const thread = `team-${input.senderId}`;
    const { accepted, failed } = await deliver(config, recipient, devices, {
      title,
      body,
      data: {
        type: eventType,
        workspaceId: input.workspaceId,
        peerId: input.senderId,
        messageId: input.messageId,
      },
      badge,
      collapseId: policy.collapse_enabled ? thread : undefined,
      apns: apnsDeliveryFor(policy, eventType, { workspaceId: input.workspaceId, conversationId: thread }),
      androidChannelId: policy.android_channel_id,
    });

    await finish(
      config,
      input.workspaceId,
      recipient.userId,
      dedupeKey,
      devices.length,
      accepted,
      failed,
      accepted > 0 ? 'sent' : 'failed',
    );
  } catch (err) {
    // A team message is already saved and on its way over realtime.
    console.error('[push] team dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

/**
 * A team message's copy, in the recipient's language: the colleague's name
 * marked as a colleague's — so it is never read as a customer's — and what
 * they wrote. With previews off, neither the text nor the name leaves the
 * server.
 *
 * Not from Super Admin's templates: those are written for customers'
 * messages ("{{sender}}" is a customer there), and a team message worded as
 * one would say the wrong thing.
 */
export function renderTeamContent(
  input: { senderName?: string | null; text?: string | null; hasAttachment?: boolean },
  preview: boolean,
  locale = 'en',
): { title: string; body: string } {
  const lang = copyLocale(locale);
  const copy = COPY[lang];
  const mark = (result: { title: string; body: string }) => ({
    title: directed(lang, result.title),
    body: directed(lang, result.body),
  });
  if (!preview) return mark({ title: copy.privacyTitle, body: copy.teamPrivacyBody });
  const name = (input.senderName || '').trim();
  const text = (input.text || '').trim();
  const fallback = input.hasAttachment ? copy.attachment : copy.newMessage;
  return mark({ title: name ? copy.teamMessage(name) : copy.colleague, body: truncate(text || fallback) });
}

export interface SupportReplyPushInput {
  /** The operator who opened the support thread. */
  userId: string;
  /**
   * A workspace that operator belongs to: the one the thread was opened
   * from while they still belong to it. The app files the notification under
   * it, and ignores one for a workspace it does not know.
   */
  workspaceId: string;
  /** The support thread (its conversation id), which a tap opens. */
  threadId: string;
  messageId: string;
  /** The support agent's name, when they have one. */
  senderName?: string | null;
  /** Only shown when the operator allows previews. */
  text?: string | null;
}

/**
 * The platform's support team answered an operator's support thread.
 *
 * Addressed to that one operator, so it goes where a colleague's message
 * goes: past their scope, through quiet hours as a direct message does, and
 * only with a preview they allow. `data` names the thread, not a
 * conversation of theirs — the conversation lives in the support team's
 * workspace, which the operator cannot open.
 */
export async function notifySupportReply(config: ServerConfig, input: SupportReplyPushInput): Promise<void> {
  try {
    if (!isPushConfigured() && !isApnsConfigured()) return;
    const policy = await loadPushPlatformSettings(config);
    if (!policy.push_enabled) return;
    const eventType: PushEventType = 'support_reply';

    const [recipient] = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      assignedTo: null,
      eventType,
      actorId: null,
      mentionedUserIds: [input.userId],
      userIds: [input.userId],
      policy,
    });
    if (!recipient) return;
    const devices = await listActiveDevices(config, [recipient.userId]);
    if (!devices.length) return;

    const sb = getServiceClient(config);
    const dedupeKey = `${eventType}:${input.messageId}`;
    const { error: claimError } = await sb.from('push_dispatch_log').insert({
      workspace_id: input.workspaceId,
      user_id: recipient.userId,
      conversation_id: null,
      message_id: input.messageId,
      notification_type: eventType,
      dedupe_key: dedupeKey,
      status: 'attempted',
    });
    if (claimError) return; // duplicate (or logging outage) → stay silent

    const { title, body } = renderSupportContent(
      { senderName: input.senderName, text: input.text },
      recipient.preview,
      recipient.locale,
    );
    const thread = `support-${input.threadId}`;
    const { accepted, failed } = await deliver(config, recipient, devices, {
      title,
      body,
      data: {
        type: eventType,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        messageId: input.messageId,
      },
      collapseId: policy.collapse_enabled ? thread : undefined,
      apns: apnsDeliveryFor(policy, eventType, { workspaceId: input.workspaceId, conversationId: thread }),
      androidChannelId: policy.android_channel_id,
    });

    await finish(
      config,
      input.workspaceId,
      recipient.userId,
      dedupeKey,
      devices.length,
      accepted,
      failed,
      accepted > 0 ? 'sent' : 'failed',
    );
  } catch (err) {
    // The reply is already saved and on its way over realtime.
    console.error('[push] support dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

/** A support reply's copy, in the operator's language; nothing leaves with previews off. */
export function renderSupportContent(
  input: { senderName?: string | null; text?: string | null },
  preview: boolean,
  locale = 'en',
): { title: string; body: string } {
  const lang = copyLocale(locale);
  const copy = COPY[lang];
  const mark = (result: { title: string; body: string }) => ({
    title: directed(lang, result.title),
    body: directed(lang, result.body),
  });
  if (!preview) return mark({ title: copy.support, body: copy.supportPrivacyBody });
  const name = (input.senderName || '').trim();
  const text = (input.text || '').trim();
  return mark({ title: name ? copy.supportReply(name) : copy.support, body: truncate(text || copy.newMessage) });
}

/**
 * The shared tail of every event that is not a customer's message: for each
 * recipient with a device, claim the (workspace, user, dedupe key) row —
 * the second claim is the suppression — render in their language, send to
 * each device, and record the outcome. Never throws.
 */
async function pushToRecipients(
  config: ServerConfig,
  input: {
    workspaceId: string;
    eventType: PushEventType;
    recipients: Recipient[];
    dedupeKey: string;
    conversationId?: string | null;
    /** A uuid, when the event has one; the dispatch log's column is typed. */
    messageId?: string | null;
    data: Record<string, string>;
    render: (recipient: Recipient) => { title: string; body: string };
    /** One notification per this, replacing the last. */
    thread: string;
    policy: PushPlatformSettings;
  },
): Promise<void> {
  const { policy } = input;
  if (!input.recipients.length) return;
  const sb = getServiceClient(config);
  const devicesByUser = new Map<string, PushDeviceRow[]>();
  for (const device of await listActiveDevices(config, input.recipients.map((r) => r.userId))) {
    const list = devicesByUser.get(device.user_id);
    if (list) list.push(device);
    else devicesByUser.set(device.user_id, [device]);
  }
  for (const recipient of input.recipients) {
    const devices = devicesByUser.get(recipient.userId) ?? [];
    if (!devices.length) continue;
    const { error: claimError } = await sb.from('push_dispatch_log').insert({
      workspace_id: input.workspaceId,
      user_id: recipient.userId,
      conversation_id: input.conversationId ?? null,
      message_id: input.messageId ?? null,
      notification_type: input.eventType,
      dedupe_key: input.dedupeKey,
      status: 'attempted',
    });
    if (claimError) continue;

    const badge = policy.badge_enabled
      ? await unreadBadgeCount(config, recipient.userId, input.workspaceId)
      : undefined;
    const { title, body } = input.render(recipient);
    const { accepted, failed } = await deliver(config, recipient, devices, {
      title,
      body,
      data: input.data,
      badge,
      collapseId: policy.collapse_enabled ? input.thread : undefined,
      apns: apnsDeliveryFor(policy, input.eventType, { workspaceId: input.workspaceId, conversationId: input.thread }),
      androidChannelId: policy.android_channel_id,
    });
    await finish(config, input.workspaceId, recipient.userId, input.dedupeKey, devices.length, accepted, failed, accepted > 0 ? 'sent' : 'failed');
  }
}

/** Push is on at all: a transport, and the platform master switch. */
async function pushPolicy(config: ServerConfig): Promise<PushPlatformSettings | null> {
  if (!isPushConfigured() && !isApnsConfigured()) return null;
  const policy = await loadPushPlatformSettings(config);
  return policy.push_enabled ? policy : null;
}

/** A conversation's contact, as much of it as naming them needs. */
async function loadContact(config: ServerConfig, contactId: string | null | undefined): Promise<NamedContact | null> {
  if (!contactId) return null;
  const { data } = await getServiceClient(config)
    .from('contacts')
    .select('name, email, visitor_code')
    .eq('id', contactId)
    .maybeSingle();
  return (data as NamedContact | null) ?? null;
}

async function displayName(config: ServerConfig, userId: string | null | undefined): Promise<string | null> {
  if (!userId) return null;
  const { data } = await getServiceClient(config)
    .from('profiles')
    .select('full_name')
    .eq('id', userId)
    .maybeSingle();
  const name = (data as { full_name: string | null } | null)?.full_name?.trim();
  return name || null;
}

export interface AssignmentPushInput {
  workspaceId: string;
  conversationId: string;
  /** The operator it now belongs to. */
  assigneeId: string;
  /** Who handed it over; null when routing did. Never notified. */
  actorId: string | null;
  /** Distinguishes this handover from the next one of the same conversation. */
  stamp: string;
}

/**
 * A conversation handed to one operator — by a colleague, or by routing after
 * the AI stepped aside — on that operator's phone.
 *
 * The customer message that led here was pushed before anyone was assigned,
 * so without this the new owner heard nothing until the customer wrote
 * again. Only to the assignee, under their own settings; a handover they
 * made to themselves is not news to them.
 */
export async function notifyAssignment(config: ServerConfig, input: AssignmentPushInput): Promise<void> {
  try {
    if (input.actorId && input.actorId === input.assigneeId) return;
    const policy = await pushPolicy(config);
    if (!policy) return;
    const eventType: PushEventType = 'assignment';
    const sb = getServiceClient(config);
    const { data: conversation } = await sb
      .from('conversations')
      .select('id, workspace_id, assigned_to, contact_id')
      .eq('id', input.conversationId)
      .maybeSingle();
    const conv = conversation as { workspace_id: string; assigned_to: string | null; contact_id: string | null } | null;
    // Read back rather than trusted: a handover already undone is not sent.
    if (!conv || String(conv.workspace_id) !== input.workspaceId || conv.assigned_to !== input.assigneeId) return;

    const recipients = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      assignedTo: input.assigneeId,
      eventType,
      actorId: input.actorId,
      userIds: [input.assigneeId],
      policy,
    });
    if (!recipients.length) return;

    const contact = await loadContact(config, conv.contact_id);
    const actorName = await displayName(config, input.actorId);

    await pushToRecipients(config, {
      workspaceId: input.workspaceId,
      eventType,
      recipients,
      dedupeKey: `${eventType}:${input.conversationId}:${input.stamp}`.slice(0, 200),
      conversationId: input.conversationId,
      data: { type: eventType, workspaceId: input.workspaceId, conversationId: input.conversationId },
      render: (recipient) => renderAssignmentContent(
        { customer: contactDisplayName(contact, recipient.locale), actorName },
        recipient.preview,
        recipient.locale,
      ),
      thread: `conv-${input.conversationId}`,
      policy,
    });
  } catch (err) {
    console.error('[push] assignment dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

export function renderAssignmentContent(
  input: { customer: string | null; actorName: string | null },
  preview: boolean,
  locale = 'en',
): { title: string; body: string } {
  const lang = copyLocale(locale);
  const copy = COPY[lang];
  const mark = (result: { title: string; body: string }) => ({
    title: directed(lang, result.title),
    body: directed(lang, result.body),
  });
  if (!preview) return mark({ title: copy.privacyTitle, body: copy.assignedPrivacyBody });
  const who = input.customer?.trim() || copy.customer;
  const by = input.actorName?.trim();
  return mark({ title: copy.assignedTitle, body: by ? `${who} · ${copy.assignedBy(by)}` : who });
}

export interface HandoffPushInput {
  workspaceId: string;
  conversationId: string;
  /** When the AI let go of it: one notification per handoff, however often routing runs. */
  handoffAt: string;
}

/**
 * The AI stopped and handed a conversation to people, and routing did not
 * give it to anyone new: it is still the AI queue's last owner's, or it is
 * waiting in the queue. The customer's messages up to here were the AI's and
 * reached no phone, so without this nobody would hear of it until the
 * customer wrote again. A handoff routing DID assign is `notifyAssignment`.
 */
export async function notifyHandoff(config: ServerConfig, input: HandoffPushInput): Promise<void> {
  try {
    const policy = await pushPolicy(config);
    if (!policy) return;
    const eventType: PushEventType = 'handoff';
    const sb = getServiceClient(config);
    const { data: conversation } = await sb
      .from('conversations')
      .select('id, workspace_id, assigned_to, is_spam, contact_id')
      .eq('id', input.conversationId)
      .maybeSingle();
    const conv = conversation as {
      workspace_id: string;
      assigned_to: string | null;
      is_spam: boolean | null;
      contact_id: string | null;
    } | null;
    if (!conv || String(conv.workspace_id) !== input.workspaceId || conv.is_spam) return;

    const recipients = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      assignedTo: conv.assigned_to ?? null,
      eventType,
      userIds: conv.assigned_to ? [conv.assigned_to] : undefined,
      policy,
    });
    if (!recipients.length) return;

    const contact = await loadContact(config, conv.contact_id);
    await pushToRecipients(config, {
      workspaceId: input.workspaceId,
      eventType,
      recipients,
      dedupeKey: `${eventType}:${input.conversationId}:${input.handoffAt}`.slice(0, 200),
      conversationId: input.conversationId,
      data: { type: eventType, workspaceId: input.workspaceId, conversationId: input.conversationId },
      render: (recipient) => renderHandoffContent(
        { customer: contactDisplayName(contact, recipient.locale) },
        recipient.preview,
        recipient.locale,
      ),
      thread: `conv-${input.conversationId}`,
      policy,
    });
  } catch (err) {
    console.error('[push] handoff dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

export function renderHandoffContent(
  input: { customer: string | null },
  preview: boolean,
  locale = 'en',
): { title: string; body: string } {
  const lang = copyLocale(locale);
  const copy = COPY[lang];
  const mark = (result: { title: string; body: string }) => ({
    title: directed(lang, result.title),
    body: directed(lang, result.body),
  });
  if (!preview) return mark({ title: copy.privacyTitle, body: copy.handoffPrivacyBody });
  const who = input.customer?.trim() || copy.customer;
  return mark({ title: copy.handoffTitle, body: `${who} · ${copy.handoffBody}` });
}

/** Whether any of the platform's templates uses `{{name}}`. */
function usesPlaceholder(policy: PushPlatformSettings, name: string): boolean {
  return JSON.stringify(policy.templates ?? {}).includes(`{{${name}}}`);
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

export interface EmailPushInput {
  workspaceId: string;
  /** The thread the app opens; a live (Gmail) inbox names Gmail's thread id. */
  threadId: string;
  /** The stored `email_messages` row (a uuid), when there is one. */
  messageId?: string | null;
  /** Unique per notification; defaults to messageId. A live inbox has no row to name. */
  dedupeId?: string;
  /** The mailbox the thread is in (`data.provider`), for apps that show more than one. */
  provider?: 'gmail' | 'yahoo';
  from?: string | null;
  subject?: string | null;
  snippet?: string | null;
}

/**
 * A new email in the workspace's email inbox.
 *
 * Email is not a conversation — it has its own threads and no assignee — so
 * it reaches everyone who follows all of the workspace's traffic, as an
 * unassigned customer message does. `data` names the thread the app opens.
 */
export async function notifyEmailMessage(config: ServerConfig, input: EmailPushInput): Promise<void> {
  try {
    const policy = await pushPolicy(config);
    if (!policy) return;
    const eventType: PushEventType = 'email_message';
    const recipients = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      assignedTo: null,
      eventType,
      policy,
    });
    await pushToRecipients(config, {
      workspaceId: input.workspaceId,
      eventType,
      recipients,
      dedupeKey: `${eventType}:${input.dedupeId ?? input.messageId}`,
      messageId: input.messageId ?? null,
      data: {
        type: eventType,
        workspaceId: input.workspaceId,
        threadId: input.threadId,
        ...(input.messageId ? { messageId: input.messageId } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
      },
      render: (recipient) => renderEmailContent(input, recipient.preview, recipient.locale),
      thread: `email-${input.threadId}`,
      policy,
    });
  } catch (err) {
    console.error('[push] email dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

export function renderEmailContent(
  input: { from?: string | null; subject?: string | null; snippet?: string | null },
  preview: boolean,
  locale = 'en',
): { title: string; body: string } {
  const lang = copyLocale(locale);
  const copy = COPY[lang];
  const mark = (result: { title: string; body: string }) => ({
    title: directed(lang, result.title),
    body: directed(lang, result.body),
  });
  if (!preview) return mark({ title: copy.privacyTitle, body: copy.emailPrivacyBody });
  const from = input.from?.trim() || copy.emailTitle;
  const subject = input.subject?.trim();
  const snippet = input.snippet?.replace(/\s+/g, ' ').trim();
  const body = [subject, snippet].filter(Boolean).join(' — ') || copy.emailTitle;
  return mark({ title: from, body: truncate(body) });
}

export interface CallbackPushInput {
  workspaceId: string;
  /** The callback request row. */
  callbackId: string;
  visitorName?: string | null;
}

/**
 * A visitor asked to be called back. Nobody is on the line, so it is a
 * notification rather than a ring; it reaches everyone who follows all of
 * the workspace's traffic.
 */
export async function notifyCallbackRequest(config: ServerConfig, input: CallbackPushInput): Promise<void> {
  try {
    const policy = await pushPolicy(config);
    if (!policy) return;
    const eventType: PushEventType = 'callback_request';
    const recipients = await resolveRecipients(config, {
      workspaceId: input.workspaceId,
      assignedTo: null,
      eventType,
      policy,
    });
    await pushToRecipients(config, {
      workspaceId: input.workspaceId,
      eventType,
      recipients,
      dedupeKey: `${eventType}:${input.callbackId}`,
      messageId: /^[0-9a-f-]{36}$/i.test(input.callbackId) ? input.callbackId : null,
      data: { type: eventType, workspaceId: input.workspaceId, callbackId: input.callbackId },
      render: (recipient) => {
        const lang = copyLocale(recipient.locale);
        const copy = COPY[lang];
        const name = input.visitorName?.trim();
        return {
          title: directed(lang, copy.callbackTitle),
          body: directed(lang, recipient.preview && name ? `${name} · ${copy.callbackBody}` : copy.callbackBody),
        };
      },
      thread: `callback-${input.callbackId}`,
      policy,
    });
  } catch (err) {
    console.error('[push] callback dispatch error', { message: String((err as Error)?.message ?? err) });
  }
}

/** One notification, as every device of one recipient is sent it. */
interface Outgoing {
  title: string;
  body: string;
  data: Record<string, string>;
  badge?: number;
  collapseId?: string;
  apns: ApnsDelivery;
  androidChannelId?: string;
}

/**
 * Sends [message] to each of [recipient]'s devices, independently: a dead
 * token on one phone is disabled and never blocks the others.
 */
async function deliver(
  config: ServerConfig,
  recipient: Recipient,
  devices: PushDeviceRow[],
  message: Outgoing,
): Promise<{ accepted: number; failed: number }> {
  let accepted = 0;
  let failed = 0;
  for (const device of devices) {
    // The row says which door. Both transports answer with the same three
    // things that matter here — did it go, is the address dead, what did
    // the service say — so only the call itself differs.
    const outcome = device.transport === 'apns'
      ? await sendApnsAlert({
          token: device.push_token,
          title: message.title,
          body: message.body,
          data: message.data,
          badge: message.badge,
          sound: recipient.sound,
          collapseId: message.collapseId,
          apns: message.apns,
          topic: nativeBundleId(),
        })
      : await sendFcmMessage({
          token: device.push_token,
          title: message.title,
          body: message.body,
          data: message.data,
          badge: message.badge,
          sound: recipient.sound,
          collapseKey: message.collapseId,
          androidChannelId: message.androidChannelId,
          apns: message.apns,
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
  return { accepted, failed };
}

async function finish(
  config: ServerConfig,
  workspaceId: string,
  userId: string,
  dedupeKey: string,
  deviceCount: number,
  accepted: number,
  failed: number,
  status: string,
): Promise<void> {
  const sb = getServiceClient(config);
  await sb
    .from('push_dispatch_log')
    .update({
      device_count: deviceCount,
      accepted_count: accepted,
      failed_count: failed,
      status,
    })
    .eq('workspace_id', workspaceId)
    .eq('user_id', userId)
    .eq('dedupe_key', dedupeKey);
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

  const name = (input.senderName || '').trim() || copy.customer;
  const text = (input.text || '').trim();
  const fallback = input.attachmentCount ? copy.attachment : copy.newMessage;

  if (policy) {
    // Templates are keyed by bare language ("fa") and profiles store full
    // tags ("fa-IR"): rendering with the raw tag gave every Persian operator
    // the English template.
    const rendered = renderTemplate(policy, eventType, lang, preview, {
      sender: name,
      preview: truncate(text || fallback),
      count: String(input.attachmentCount ?? 0),
      workspace: (input.workspaceName || '').trim() || 'Webyar',
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
  return mark({ title: name, body: truncate(text || fallback) });
}

/**
 * The APNs half of a send, derived from platform policy. The category id is
 * the one registered for this event type, which is what gives the banner its
 * action buttons ("Reply", "Mark as read") on the device.
 */
function apnsDeliveryFor(
  policy: PushPlatformSettings,
  eventType: PushEventType,
  input: Pick<InboundPushInput, 'workspaceId' | 'conversationId'>,
): ApnsDelivery {
  // A category list saved before an event type existed does not name it; the
  // shipped categories answer for it, so its banner still has its buttons.
  const category =
    (policy.categories ?? []).find((c) => c.eventTypes?.includes(eventType)) ??
    DEFAULT_CATEGORIES.find((c) => c.eventTypes.includes(eventType));
  const threadId =
    policy.thread_id_strategy === 'conversation'
      ? input.conversationId
      : policy.thread_id_strategy === 'workspace'
        ? input.workspaceId
        : undefined;
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
