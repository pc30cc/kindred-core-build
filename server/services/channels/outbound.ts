/**
 * Outbound bridge: an operator or AI reply in a channel-backed conversation
 * must reach the visitor on the ORIGINAL provider, not only in the Inbox.
 *
 * Core does not call the provider itself — it enqueues a durable job so
 * delivery survives a restart and retries with backoff in the Channels
 * Worker. The payload carries routing data only; never a credential.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { enqueueChannelJob, type ChannelJobType } from './jobs.js';

const OUTBOUND_JOB_BY_PROVIDER: Record<string, ChannelJobType> = {
  telegram: 'telegram_outbound_message',
};

/**
 * No-op for widget conversations. Safe to call after every agent/AI message.
 * Never throws into the caller's request path.
 */
export async function dispatchOutboundIfChannelConversation(
  config: ServerConfig,
  input: { workspaceId: string; conversationId: string; messageId: string; body: string },
): Promise<void> {
  if (!input.body?.trim()) return;

  try {
    const sb = getServiceClient(config);
    const { data: conversation } = await sb
      .from('conversations')
      .select('metadata, channel')
      .eq('id', input.conversationId)
      .maybeSingle();

    const metadata = ((conversation as any)?.metadata ?? {}) as Record<string, unknown>;
    const provider = String((conversation as any)?.channel ?? metadata.channel ?? '');
    const jobType = OUTBOUND_JOB_BY_PROVIDER[provider];
    if (!jobType) return;

    const integrationId = metadata.channel_integration_id as string | undefined;
    const chatId = metadata.channel_chat_id as string | undefined;
    if (!integrationId || !chatId) return;

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
  } catch (err) {
    // Delivery problems must never fail the operator's send request; the
    // message is already persisted and visible in the Inbox.
    console.warn('[channels] outbound dispatch failed:', (err as Error).message);
  }
}
