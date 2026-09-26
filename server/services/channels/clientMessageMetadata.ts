/**
 * Client-supplied `conversation_messages.metadata` sanitation.
 *
 * Some metadata keys are SERVER-OWNED control fields that downstream
 * machinery acts on without further checks:
 *   - `attachments` — the channel outbound DB trigger
 *     (`channel_enqueue_outbound_message`, migrations 049/150) copies it
 *     verbatim into a `<provider>_outbound_media` job, and the Channels
 *     Worker downloads every URL in it and uploads the bytes to the chat.
 *     Client-controlled, that is a server-side request forgery primitive with
 *     a readable response.
 *   - `attachment_id` / `client_message_id` — set by the route itself from
 *     validated request fields.
 *   - `channel_*` — inbound / delivery-skip / menu markers that change how the
 *     message is routed and delivered.
 *
 * Legitimate operator attachments never travel through metadata: the
 * composer uploads the file, sends `attachment_id`, and Core mints the signed
 * URL and enqueues the media job itself (services/channels/mediaOutbound.ts).
 */

const RESERVED_KEYS = new Set(['attachments', 'attachment_id', 'client_message_id']);
const RESERVED_PREFIXES = ['channel_'];

export function isReservedMessageMetadataKey(key: string): boolean {
  const k = key.toLowerCase();
  return RESERVED_KEYS.has(k) || RESERVED_PREFIXES.some((p) => k.startsWith(p));
}

/** Returns a copy of client metadata without any server-owned key. */
export function sanitizeClientMessageMetadata(
  metadata: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return out;
  for (const [key, value] of Object.entries(metadata)) {
    if (isReservedMessageMetadataKey(key)) continue;
    out[key] = value;
  }
  return out;
}
