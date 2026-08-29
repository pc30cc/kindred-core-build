/**
 * Instagram Messaging webhook payload → Bot-API-shaped update.
 *
 * Same ingest strategy as WhatsApp: the Messenger Platform envelope
 * (`entry[].messaging[]`) is translated ONCE, here, into the shared Telegram
 * Bot API update, so every downstream feature (menus, departments, offline
 * lock, AI ownership, contact enrichment) stays provider-neutral.
 */

type BotUpdate = Record<string, any>;

/** Stable numeric-ish message id for an opaque Instagram message id. */
function shortMessageId(mid: string): number {
  let hash = 0;
  for (let i = 0; i < mid.length; i++) hash = (hash * 31 + mid.charCodeAt(i)) % 2_147_483_647;
  return hash || 1;
}

const ATTACHMENT_KINDS: Record<string, string> = {
  image: 'photo',
  video: 'video',
  audio: 'audio',
  file: 'document',
  // Stories/reels shares carry a CDN url too; treat them as photos so the
  // media pipeline can archive them.
  story_mention: 'photo',
  share: 'photo',
  ig_reel: 'video',
};

/**
 * Expands one Meta webhook body into zero or more Bot-API updates.
 *
 * Echoes (messages the business itself sent), reads, deliveries and
 * reactions carry no inbound conversational content and are dropped.
 */
export function instagramToBotUpdates(payload: Record<string, any>): BotUpdate[] {
  const updates: BotUpdate[] = [];
  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const events: any[] = Array.isArray(entry?.messaging)
      ? entry.messaging
      : Array.isArray(entry?.standby)
        ? entry.standby
        : [];

    for (const event of events) {
      const senderId = String(event?.sender?.id ?? '');
      if (!senderId) continue;
      if (event?.message?.is_echo || event?.read || event?.delivery || event?.reaction) continue;

      const mid = String(event?.message?.mid ?? event?.postback?.mid ?? '');
      const messageId = mid ? shortMessageId(mid) : Math.floor(Date.now() / 1000);
      const date = event?.timestamp ? Math.floor(Number(event.timestamp) / 1000) : Math.floor(Date.now() / 1000);

      const from = {
        id: senderId,
        is_bot: false,
        first_name: senderId,
        last_name: undefined,
        username: undefined,
        language_code: undefined,
      };
      const chat = { id: senderId, type: 'private' };

      // ── Quick reply taps and postbacks are MENU actions, so they map to
      // Telegram callback queries and reach the existing menu router.
      const payloadData =
        event?.message?.quick_reply?.payload ?? event?.postback?.payload ?? null;
      if (payloadData) {
        updates.push({
          update_id: `${mid || messageId}`,
          callback_query: {
            id: mid || String(messageId),
            from,
            data: String(payloadData),
            message: { message_id: messageId, chat, date },
          },
        });
        continue;
      }

      const attachments: Record<string, any> = {};
      const list: any[] = Array.isArray(event?.message?.attachments) ? event.message.attachments : [];
      for (const attachment of list) {
        const target = ATTACHMENT_KINDS[String(attachment?.type ?? '').toLowerCase()];
        const url = attachment?.payload?.url ? String(attachment.payload.url) : null;
        if (!target || !url) continue;
        // Instagram media arrives as an absolute CDN url; the url itself is
        // the file reference (see `channels/providers/instagram/client.ts`).
        if (target === 'photo') {
          attachments.photo = [{ file_id: url, file_size: null }];
        } else {
          attachments[target] = { file_id: url, mime_type: null, file_name: null, file_size: null };
        }
      }

      const text = event?.message?.text ? String(event.message.text) : null;
      if (!text && Object.keys(attachments).length === 0) continue;

      updates.push({
        update_id: `${mid || messageId}`,
        message: {
          message_id: messageId,
          from,
          chat,
          date,
          ...(text ? { text } : {}),
          ...attachments,
        },
      });
    }
  }

  return updates;
}
