/**
 * WhatsApp Cloud webhook payload → Bot-API-shaped update.
 *
 * The whole channel feature set (menus, departments, offline lock, AI
 * ownership, contacts enrichment) is written against ONE inbound envelope:
 * the Telegram Bot API update. Rather than fork every one of those code
 * paths, WhatsApp's Graph payload is translated into that envelope exactly
 * once, here, at the ingest boundary.
 *
 * Everything downstream therefore stays provider-neutral, and WhatsApp gains
 * the same behaviour Telegram/Bale already have.
 */

type BotUpdate = Record<string, any>;

const MEDIA_KINDS = ['image', 'document', 'audio', 'voice', 'video', 'sticker'] as const;

/** Stable numeric-ish message id for a WhatsApp `wamid`. */
function shortMessageId(wamid: string): number {
  let hash = 0;
  for (let i = 0; i < wamid.length; i++) hash = (hash * 31 + wamid.charCodeAt(i)) % 2_147_483_647;
  return hash || 1;
}

/**
 * Expands one Meta webhook body into zero or more Bot-API updates.
 *
 * Meta batches messages, and also delivers delivery/read *statuses* on the
 * same hook — statuses carry no conversational content and are dropped.
 */
export function whatsappToBotUpdates(payload: Record<string, any>): BotUpdate[] {
  const updates: BotUpdate[] = [];
  const entries: any[] = Array.isArray(payload?.entry) ? payload.entry : [];

  for (const entry of entries) {
    const changes: any[] = Array.isArray(entry?.changes) ? entry.changes : [];
    for (const change of changes) {
      const value = change?.value ?? {};
      const contacts: any[] = Array.isArray(value?.contacts) ? value.contacts : [];
      const messages: any[] = Array.isArray(value?.messages) ? value.messages : [];

      for (const message of messages) {
        const waId = String(message?.from ?? '');
        if (!waId) continue;
        const wamid = String(message?.id ?? '');
        const profileName =
          contacts.find((c) => String(c?.wa_id ?? '') === waId)?.profile?.name ?? null;

        const from = {
          id: waId,
          is_bot: false,
          first_name: profileName || waId,
          last_name: undefined,
          username: undefined,
          language_code: undefined,
        };
        const chat = { id: waId, type: 'private' };
        const date = Number(message?.timestamp ?? 0) || Math.floor(Date.now() / 1000);
        const messageId = wamid ? shortMessageId(wamid) : Math.floor(Date.now() / 1000);

        // ── Interactive replies are MENU TAPS, not chat messages. They map to
        // Telegram callback queries so the existing menu router handles them.
        const interactive = message?.interactive;
        const buttonReplyId =
          interactive?.button_reply?.id ??
          interactive?.list_reply?.id ??
          (message?.type === 'button' ? message?.button?.payload : null);

        if (buttonReplyId) {
          updates.push({
            update_id: `${wamid || messageId}`,
            callback_query: {
              id: wamid || String(messageId),
              from,
              data: String(buttonReplyId),
              message: { message_id: messageId, chat, date },
            },
          });
          continue;
        }

        const attachments: Record<string, any> = {};
        for (const kind of MEDIA_KINDS) {
          const media = message?.[kind];
          if (!media?.id) continue;
          const target = kind === 'image' || kind === 'sticker' ? 'photo' : kind;
          if (target === 'photo') {
            // Telegram photos arrive as an ascending size array.
            attachments.photo = [{ file_id: String(media.id), file_size: null }];
          } else {
            attachments[target] = {
              file_id: String(media.id),
              mime_type: media.mime_type ?? null,
              file_name: media.filename ?? null,
              file_size: null,
            };
          }
        }

        const text =
          message?.text?.body ??
          message?.button?.text ??
          message?.image?.caption ??
          message?.document?.caption ??
          message?.video?.caption ??
          null;

        if (!text && Object.keys(attachments).length === 0) continue;

        updates.push({
          update_id: `${wamid || messageId}`,
          message: {
            message_id: messageId,
            from,
            chat,
            date,
            ...(text ? { text: String(text) } : {}),
            ...attachments,
          },
        });
      }
    }
  }

  return updates;
}
