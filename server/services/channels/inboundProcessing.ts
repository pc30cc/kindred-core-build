/**
 * CANONICAL inbound processing for every channel plugin.
 *
 * This is the ONLY place a channel message becomes business data. The Gateway
 * never writes canonical rows and the Worker never writes them directly — the
 * worker calls Core, and Core runs this. That keeps Inbox, contacts, AI Agent
 * and analytics identical for widget and channel traffic.
 *
 * Idempotency: keyed on (integration_id, provider_event_id) via
 * `channel_inbound_events`. A replayed provider delivery is a no-op.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { recordConversationEvent } from '../conversationEvents.js';
import { publishConversationEvent, buildMessageEnvelope } from '../realtime/publish.js';
import { maybeRunAiAssistantAfterVisitorMessage } from '../ai-agent/engine.js';
import { handleTelegramInboundFlow } from './telegram/runtime.js';
import { insertContactWithVisitorCode } from '../widget/visitorCode.js';
import { anonCodeFrom } from '../widget/anonymousContact.js';

export type NormalizedInboundMessage = {
  provider: string;
  workspaceId: string;
  integrationId: string;
  /** Stable per-provider event id used for deduplication. */
  providerEventId: string;
  /** Provider-side conversation/chat id. */
  externalChatId: string;
  externalUserId: string | null;
  senderName: string | null;
  senderUsername: string | null;
  senderLanguage: string | null;
  text: string;
  attachments?: Array<{ fileId: string; kind: string; fileName?: string | null; mimeType?: string | null; size?: number | null }>;
  sentAt: string | null;
};

export type InboundResult = {
  status: 'processed' | 'duplicate' | 'ignored';
  conversationId?: string;
  messageId?: string;
  contactId?: string;
};

/** Contact resolution is keyed on the provider identity, not on the text. */
async function ensureChannelContact(
  sb: any,
  input: NormalizedInboundMessage,
): Promise<string | null> {
  const identityKey = `${input.provider}:${input.externalUserId ?? input.externalChatId}`;

  const { data: existing } = await sb
    .from('contacts')
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .contains('metadata', { channel_identity: identityKey })
    .limit(1)
    .maybeSingle();
  if (existing?.id) return existing.id as string;

  const buildPayload = (visitorCode: string | null) => ({
    workspace_id: input.workspaceId,
    name: input.senderName || (input.senderUsername ? `@${input.senderUsername}` : null),
    visitor_code: visitorCode,
    metadata: {
      source: input.provider,
      channel: input.provider,
      channel_identity: identityKey,
      channel_user_id: input.externalUserId,
      channel_username: input.senderUsername,
      channel_language: input.senderLanguage,
      anonymous: !input.senderName,
      anon_code: anonCodeFrom(identityKey),
    },
  });

  const { data: created, error } = await insertContactWithVisitorCode(sb, buildPayload, 'id');
  if (error) {
    console.error('[channels] contact creation failed:', error.message);
    return null;
  }
  return (created as any)?.id ?? null;
}

async function ensureChannelConversation(
  sb: any,
  input: NormalizedInboundMessage,
  contactId: string | null,
): Promise<{ id: string; created: boolean }> {
  const threadKey = `${input.provider}:${input.integrationId}:${input.externalChatId}`;

  const { data: open } = await sb
    .from('conversations')
    .select('id')
    .eq('workspace_id', input.workspaceId)
    .contains('metadata', { channel_thread_key: threadKey })
    .in('status', ['open', 'pending'])
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (open?.id) return { id: open.id as string, created: false };

  const { data: conv, error } = await sb
    .from('conversations')
    .insert({
      workspace_id: input.workspaceId,
      contact_id: contactId,
      status: 'open',
      subject: null,
      metadata: {
        channel: input.provider,
        channel_thread_key: threadKey,
        channel_integration_id: input.integrationId,
        channel_chat_id: input.externalChatId,
      },
      updated_at: new Date().toISOString(),
    })
    .select('id')
    .single();
  if (error) {
    console.error('[channels] conversation creation failed:', error.message);
    throw new Error(`conversation creation failed: ${error.message}`);
  }
  return { id: (conv as any).id as string, created: true };
}

export async function processInboundMessage(
  config: ServerConfig,
  input: NormalizedInboundMessage,
): Promise<InboundResult> {
  const sb = getServiceClient(config);

  // 1. Idempotency gate — insert first, process only if we won the race.
  //    Column names below MUST match public.channel_inbound_events exactly.
  const { error: dedupeError } = await sb.from('channel_inbound_events').insert({
    integration_id: input.integrationId,
    workspace_id: input.workspaceId,
    provider: input.provider,
    external_event_id: input.providerEventId,
    payload: {},
    status: 'processing',
  });
  if (dedupeError) {
    // A processed event is a true duplicate. A previously failed event must
    // be reclaimable after its underlying defect is repaired; otherwise the
    // queue retry would be acknowledged while the message remains lost.
    if ((dedupeError as any).code === '23505') {
      const { data: existing, error: existingError } = await sb
        .from('channel_inbound_events')
        .select('status')
        .eq('integration_id', input.integrationId)
        .eq('external_event_id', input.providerEventId)
        .maybeSingle();
      if (existingError) throw new Error(`inbound dedupe lookup failed: ${existingError.message}`);
      if ((existing as any)?.status !== 'failed') return { status: 'duplicate' };

      const { error: reclaimError } = await sb
        .from('channel_inbound_events')
        .update({ status: 'processing', last_error: null, processed_at: null })
        .eq('integration_id', input.integrationId)
        .eq('external_event_id', input.providerEventId)
        .eq('status', 'failed');
      if (reclaimError) throw new Error(`inbound retry claim failed: ${reclaimError.message}`);
    } else {
      throw new Error(`inbound dedupe failed: ${dedupeError.message}`);
    }
  }

  const finish = async (status: string, detail: Record<string, unknown> = {}) => {
    await sb
      .from('channel_inbound_events')
      .update({ status, processed_at: new Date().toISOString(), ...detail })
      .eq('integration_id', input.integrationId)
      .eq('external_event_id', input.providerEventId);
  };

  try {
    const contactId = await ensureChannelContact(sb, input);
    const conversation = await ensureChannelConversation(sb, input, contactId);

    if (conversation.created) {
      void recordConversationEvent(config, {
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        eventType: 'created',
        actorType: 'visitor',
        actorId: null,
        payload: { source: input.provider },
      });
    }

    const { data: insertedMsg, error: msgError } = await sb
      .from('conversation_messages')
      .insert({
        conversation_id: conversation.id,
        body: input.text,
        sender_type: 'contact',
        metadata: {
          source: input.provider,
          channel: input.provider,
          channel_chat_id: input.externalChatId,
          channel_user_id: input.externalUserId,
          channel_message_id: input.providerEventId,
          // Guard for the outbound outbox trigger: never echo inbound back.
          channel_inbound: 'true',
          attachments: input.attachments?.length ? input.attachments : undefined,
        },
      })
      .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
      .single();
    if (msgError) throw new Error(`message insert failed: ${msgError.message}`);

    await sb
      .from('conversations')
      .update({ updated_at: new Date().toISOString(), contact_id: contactId })
      .eq('id', conversation.id);

    // Media persistence — provider-specific, best-effort, non-fatal. A
    // failure here must never lose the already-inserted text message.
    if (input.provider === 'telegram' && input.attachments?.length) {
      try {
        const { ingestTelegramMedia } = await import('./telegram/mediaIngest.js');
        const outcomes = await ingestTelegramMedia(config, {
          workspaceId: input.workspaceId,
          integrationId: input.integrationId,
          conversationId: conversation.id,
          messageId: (insertedMsg as any).id,
          attachments: input.attachments,
        });
        await sb
          .from('conversation_messages')
          .update({
            metadata: {
              ...(insertedMsg as any).metadata,
              attachments: outcomes,
            },
          })
          .eq('id', (insertedMsg as any).id);
      } catch (mediaErr: any) {
        console.warn('[channels] telegram media ingest error:', mediaErr?.message || mediaErr);
      }
    }

    // Inbox realtime — identical envelope to widget traffic.
    publishConversationEvent(
      config,
      input.workspaceId,
      conversation.id,
      buildMessageEnvelope(insertedMsg as any),
    ).catch(() => {});

    // Telegram-specific: slash commands (/start /help /human /new) get an
    // inline reply and never reach the AI; the handling-mode gate (human_only
    // vs entitlement-gated ai_first) is resolved here too.
    let aiAllowed = true;
    let telegramCommandHandled = false;
    let replyLocale: string | null = input.senderLanguage;
    if (input.provider === 'telegram') {
      const flow = await handleTelegramInboundFlow(config, input, conversation.id);
      aiAllowed = flow.aiAllowed;
      telegramCommandHandled = flow.handled;
      replyLocale = flow.locale;
      console.log('[channels] telegram ai gate', {
        workspaceId: input.workspaceId,
        aiAllowed,
        commandHandled: telegramCommandHandled,
        locale: replyLocale,
      });
    }

    // AI Agent runs through the SAME entry point as the widget, so mode,
    // human-takeover blocking and safety gates behave identically. Telegram
    // additionally requires ai_first (entitlement-gated) mode and skips this
    // for recognized slash commands, which are already answered above.
    if (aiAllowed && !telegramCommandHandled && input.text.trim()) {
      void maybeRunAiAssistantAfterVisitorMessage(config, {
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        visitorMessageId: (insertedMsg as any).id,
        question: input.text,
        locale: replyLocale || undefined,
      })
        .then((r: any) => {
          if (input.provider === 'telegram') console.log('[channels] telegram ai result', r);
        })
        .catch((e: any) => console.warn('[channels] AI engine error:', e?.message || e));
    }


    await finish('processed', {
      conversation_id: conversation.id,
      contact_id: contactId,
      message_id: (insertedMsg as any).id,
    });

    return {
      status: 'processed',
      conversationId: conversation.id,
      messageId: (insertedMsg as any).id,
      contactId: contactId ?? undefined,
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await finish('failed', { last_error: message.slice(0, 500) });
    throw err;
  }
}
