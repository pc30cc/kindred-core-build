/**
 * Outbound delivery intents.
 *
 * DURABILITY MODEL — read this before changing anything here:
 *
 * The delivery intent is created by the DATABASE, inside the same transaction
 * that commits the canonical message (trigger `trg_channel_enqueue_outbound`,
 * migration 049). That is the crash-safe boundary: if the canonical message
 * exists, the `channel_jobs` row exists too. Node can die at any instant
 * without losing a reply, and the operator's request never waits on Telegram.
 *
 * This module therefore performs NO enqueue on the request path. It only
 * offers a reconciliation backstop used by tests and by the Super Admin
 * "resend" action for environments where the trigger has not been applied.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { botJobType, enqueueChannelJob } from './jobs.js';
import { isBotProvider } from '../../../shared/channels/botProviders.js';

export type OutboundIntentResult = 'not_a_channel_conversation' | 'already_enqueued' | 'enqueued';

/**
 * Backstop: ensures a delivery intent exists for an already-committed
 * canonical message. Idempotent — the unique index on
 * (payload->>'message_id') makes a duplicate insert a no-op.
 */
export async function ensureOutboundIntent(
  config: ServerConfig,
  input: { workspaceId: string; conversationId: string; messageId: string; body: string },
): Promise<OutboundIntentResult> {
  const sb = getServiceClient(config);

  const { data: conversation } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', input.conversationId)
    .maybeSingle();

  const metadata = ((conversation as any)?.metadata ?? {}) as Record<string, unknown>;
  const provider = String(metadata.channel ?? '');
  if (!isBotProvider(provider)) return 'not_a_channel_conversation';
  const jobType = botJobType(provider, 'outbound_message');

  const integrationId = metadata.channel_integration_id as string | undefined;
  const chatId = metadata.channel_chat_id as string | undefined;
  if (!integrationId || !chatId) return 'not_a_channel_conversation';

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
      jobType,
      workspaceId: input.workspaceId,
      integrationId,
      payload: {
        chat_id: chatId,
        text: input.body,
        message_id: input.messageId,
        conversation_id: input.conversationId,
      },
    });
    return 'enqueued';
  } catch (err) {
    // A unique-violation means the DB trigger already created the intent.
    if ((err as any)?.message?.includes('duplicate key')) return 'already_enqueued';
    throw err;
  }
}

/**
 * @deprecated Kept as a no-throw compatibility shim for the message send
 * path. The durable intent comes from the DB trigger; this only reconciles
 * environments where migration 049 has not been applied yet.
 */
export async function dispatchOutboundIfChannelConversation(
  config: ServerConfig,
  input: { workspaceId: string; conversationId: string; messageId: string; body: string },
): Promise<void> {
  if (!input.body?.trim()) return;
  try {
    await ensureOutboundIntent(config, input);
  } catch (err) {
    console.warn('[channels] outbound reconciliation failed:', (err as Error).message);
  }
}
