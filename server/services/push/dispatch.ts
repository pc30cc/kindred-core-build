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
import {
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
      .select('id, workspace_id, assigned_to, status')
      .eq('id', input.conversationId)
      .maybeSingle();
    const conv = conversationRow as ConversationRow | null;
    if (!conv || String(conv.workspace_id) !== input.workspaceId) return;

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
      const { title, body } = renderContent(input, eventType, recipient.preview, policy, recipient.locale);
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
    const rendered = renderTemplate(policy, eventType, locale, preview, {
      sender: name,
      preview: truncate(text || fallback),
      count: String(input.attachmentCount ?? 0),
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
  const category = (policy.categories ?? []).find((c) => c.eventTypes?.includes(eventType));
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
