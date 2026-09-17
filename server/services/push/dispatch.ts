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
import { listActiveDevices, disableToken } from './devices.js';
import { resolveRecipients, unreadBadgeCount, type PushEventType } from './recipients.js';
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

const PRIVACY_TITLE = 'Webyar';
const PRIVACY_BODY = 'پیام جدید در Webyar';

export async function notifyInboundMessage(
  config: ServerConfig,
  input: InboundPushInput,
): Promise<void> {
  try {
    if (!isPushConfigured()) return;
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

    for (const recipient of recipients) {
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

      const devices = await listActiveDevices(config, [recipient.userId]);
      if (!devices.length) {
        await finish(config, input, recipient.userId, dedupeKey, 0, 0, 0, 'no_devices');
        continue;
      }

      const badge = policy.badge_enabled
        ? await unreadBadgeCount(config, recipient.userId, input.workspaceId)
        : undefined;
      const { title, body } = renderContent(input, eventType, recipient.preview, policy, recipient.locale);
      const apns = apnsDeliveryFor(policy, eventType, input);

      let accepted = 0;
      let failed = 0;
      for (const device of devices) {
        const outcome = await sendFcmMessage({
          token: device.push_token,
          title,
          body,
          data,
          badge,
          sound: recipient.sound,
          collapseKey: policy.collapse_enabled ? `conv-${input.conversationId}` : undefined,
          androidChannelId: policy.android_channel_id,
          apns,
        });
        if (outcome.ok) {
          accepted += 1;
        } else {
          failed += 1;
          if (outcome.unregistered) {
            await disableToken(config, device.push_token);
            console.warn('[push] token unregistered, device disabled', {
              userId: recipient.userId,
              platform: device.platform,
            });
          } else {
            console.warn('[push] send failed', {
              userId: recipient.userId,
              platform: device.platform,
              status: outcome.status,
            });
          }
        }
      }

      await finish(
        config,
        input,
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

async function finish(
  config: ServerConfig,
  input: InboundPushInput,
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
    .eq('workspace_id', input.workspaceId)
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
  const name = (input.senderName || '').trim() || 'Customer';
  const text = (input.text || '').trim();
  const fallback = input.attachmentCount ? '📎 Attachment' : 'New message';

  if (policy) {
    const rendered = renderTemplate(policy, eventType, locale, preview, {
      sender: name,
      preview: truncate(text || fallback),
      count: String(input.attachmentCount ?? 0),
    });
    // A template edited down to nothing must not produce a blank banner.
    if (rendered.title.trim() && rendered.body.trim()) return rendered;
  }

  if (!preview) return { title: PRIVACY_TITLE, body: PRIVACY_BODY };
  if (eventType === 'internal_note') {
    return { title: `${name} · internal note`, body: truncate(text || fallback) };
  }
  if (eventType === 'mention') {
    return { title: `${name} mentioned you`, body: truncate(text || fallback) };
  }
  return { title: name, body: truncate(text || fallback) };
}

/**
 * The APNs half of a send, derived from platform policy. The category id is
 * the one registered for this event type, which is what gives the banner its
 * action buttons ("Reply", "Mark as read") on the device.
 */
function apnsDeliveryFor(
  policy: PushPlatformSettings,
  eventType: PushEventType,
  input: InboundPushInput,
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
