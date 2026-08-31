/**
 * Operator → channel media delivery.
 *
 * The DB trigger only enqueues an outbound job when the message carries text
 * (or a pre-built `metadata.attachments` array). An operator reply that is
 * ONLY a file/image/voice note therefore never reached Telegram / Bale /
 * WhatsApp / Instagram.
 *
 * This module closes that gap on the request path:
 *   1. resolve the channel routing metadata of the conversation,
 *   2. mint a short-lived, signed, PUBLIC download URL for the attachment
 *      (providers fetch media by URL — they cannot present our session
 *      cookie), and
 *   3. enqueue the durable `<provider>_outbound_media` job the Channels
 *      Worker already knows how to execute.
 *
 * The signed URL is scoped to a single attachment id and expires quickly.
 */

import crypto from 'node:crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { botJobType, enqueueChannelJob } from './jobs.js';
import { isBotProvider } from '../../../shared/channels/botProviders.js';
import { resolveApiBaseUrl } from '../calls/rtcResolver.js';

const URL_TTL_SECONDS = 60 * 60 * 6; // 6h — plenty for retries, short enough to be safe.

function secret(): Buffer {
  const base = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.WIDGET_SIGNING_SECRET || '';
  return crypto.createHash('sha256').update('attachment-public:' + base).digest();
}

export function signAttachmentAccess(attachmentId: string, expiresAt: number): string {
  return crypto
    .createHmac('sha256', secret())
    .update(`${attachmentId}.${expiresAt}`)
    .digest('base64url');
}

export function verifyAttachmentAccess(
  attachmentId: string,
  expiresAt: number,
  signature: string,
): boolean {
  if (!Number.isFinite(expiresAt) || expiresAt * 1000 < Date.now()) return false;
  const expected = signAttachmentAccess(attachmentId, expiresAt);
  const a = Buffer.from(signature || '');
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function attachmentKindFromMime(mime: string): 'image' | 'audio' | 'video' | 'document' {
  const m = String(mime || '').toLowerCase();
  if (m.startsWith('image/')) return 'image';
  if (m.startsWith('audio/')) return 'audio';
  if (m.startsWith('video/')) return 'video';
  return 'document';
}

export type MediaIntentResult =
  | 'not_a_channel_conversation'
  | 'attachment_unavailable'
  | 'base_url_unresolved'
  | 'already_enqueued'
  | 'enqueued';

export async function enqueueOutboundMediaIfChannelConversation(
  config: ServerConfig,
  input: {
    workspaceId: string;
    conversationId: string;
    messageId: string;
    attachmentId: string;
    caption?: string;
    req?: { headers?: Record<string, unknown>; protocol?: string };
  },
): Promise<MediaIntentResult> {
  const sb = getServiceClient(config);

  const { data: conversation } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', input.conversationId)
    .maybeSingle();

  const metadata = ((conversation as any)?.metadata ?? {}) as Record<string, unknown>;
  const provider = String(metadata.channel ?? '');
  if (!isBotProvider(provider)) return 'not_a_channel_conversation';

  const integrationId = metadata.channel_integration_id as string | undefined;
  const chatId = metadata.channel_chat_id as string | undefined;
  if (!integrationId || !chatId) return 'not_a_channel_conversation';

  const { data: att } = await sb
    .from('conversation_attachments')
    .select('id, workspace_id, mime_type, file_name, status')
    .eq('id', input.attachmentId)
    .maybeSingle();
  if (!att || att.workspace_id !== input.workspaceId) return 'attachment_unavailable';
  if (att.status !== 'uploaded' && att.status !== 'attached') return 'attachment_unavailable';

  const apiBase = await resolveApiBaseUrl(config, input.req);
  if (!apiBase || !/^https:\/\//i.test(apiBase)) return 'base_url_unresolved';

  const exp = Math.floor(Date.now() / 1000) + URL_TTL_SECONDS;
  const sig = signAttachmentAccess(att.id as string, exp);
  const url = `${apiBase.replace(/\/+$/, '')}/api/conversation-attachments/${att.id}/public?exp=${exp}&sig=${sig}`;

  const { data: existing } = await sb
    .from('channel_jobs')
    .select('id')
    .in('job_type', [botJobType(provider, 'outbound_message'), botJobType(provider, 'outbound_media')])
    .filter('payload->>message_id', 'eq', input.messageId)
    .limit(1)
    .maybeSingle();
  if (existing) return 'already_enqueued';

  try {
    await enqueueChannelJob(sb, {
      provider,
      jobType: botJobType(provider, 'outbound_media'),
      workspaceId: input.workspaceId,
      integrationId,
      payload: {
        chat_id: chatId,
        text: input.caption ?? '',
        message_id: input.messageId,
        conversation_id: input.conversationId,
        attachments: [
          {
            url,
            kind: attachmentKindFromMime(att.mime_type as string),
            file_name: att.file_name ?? null,
            mime_type: att.mime_type ?? null,
          },
        ],
      },
    });
    return 'enqueued';
  } catch (err) {
    if ((err as any)?.message?.includes('duplicate key')) return 'already_enqueued';
    throw err;
  }
}
