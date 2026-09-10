/**
 * X (Twitter) DM events → Bot-API-shaped update.
 *
 * Same translation strategy as Instagram/WhatsApp: the provider's native
 * shape is converted ONCE, here, into the shared Telegram Bot API update, so
 * every downstream feature (contact enrichment, AI ownership, the outbound
 * trigger) stays provider-neutral.
 *
 * Unlike the webhook-pushed providers, this runs in the Channels Worker
 * itself (see `worker/channels/index.ts`, job type `x_poll_dm_events`)
 * against events already fetched and expansion-resolved by the Worker's
 * `channels/providers/x/client.ts` (`pollDmEvents`), not against a raw
 * webhook body — X has no broadly-available real-time DM webhook. This file
 * only imports the event's SHAPE from `shared/channels/xDmEvent.ts`, never
 * the provider client itself — Core must never import anything under
 * `channels/providers/**`, per the provider-isolation guard
 * (`src/test/channels/providerIsolationGuard.test.ts`).
 */

import type { XDmEvent } from '../../../../shared/channels/xDmEvent.js';

type BotUpdate = Record<string, any>;

/** Stable numeric-ish message id for an opaque X DM event id (a snowflake string). */
function shortMessageId(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) hash = (hash * 31 + id.charCodeAt(i)) % 2_147_483_647;
  return hash || 1;
}

/**
 * Translates polled DM events into Bot-API updates, dropping the connected
 * account's own messages (`selfUserId`) so its replies never loop back in as
 * inbound content.
 */
export function xDmEventsToBotUpdates(events: XDmEvent[], selfUserId: string): BotUpdate[] {
  const updates: BotUpdate[] = [];

  for (const event of events) {
    if (!event.dmConversationId || !event.senderId) continue;
    if (selfUserId && event.senderId === selfUserId) continue;

    const attachments: Record<string, any> = {};
    for (const media of event.mediaUrls) {
      if (media.kind === 'photo') {
        attachments.photo = [{ file_id: media.url, file_size: null }];
      } else {
        attachments[media.kind] = { file_id: media.url, mime_type: null, file_name: null, file_size: null };
      }
    }

    if (!event.text && Object.keys(attachments).length === 0) continue;

    const messageId = shortMessageId(event.id);
    const date = event.createdAt ? Math.floor(new Date(event.createdAt).getTime() / 1000) : Math.floor(Date.now() / 1000);
    const from = {
      id: event.senderId,
      is_bot: false,
      first_name: event.senderUsername ? `@${event.senderUsername}` : event.senderId,
      last_name: undefined,
      username: event.senderUsername ?? undefined,
      language_code: undefined,
    };
    // A reply must address the CONVERSATION, not the sender — X's send
    // endpoint takes a `dm_conversation_id`, so that (not the user id)
    // becomes the Bot-API chat id every downstream feature stores and reuses.
    const chat = { id: event.dmConversationId, type: 'private' };

    updates.push({
      update_id: event.id,
      message: {
        message_id: messageId,
        from,
        chat,
        date,
        ...(event.text ? { text: event.text } : {}),
        ...attachments,
      },
    });
  }

  return updates;
}
