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
import { resumeConversationIfPending } from '../conversationPending.js';
import { publishConversationEvent, buildMessageEnvelope } from '../realtime/publish.js';
import { maybeRunAiAssistantAfterVisitorMessage } from '../ai-agent/engine.js';
import { handleTelegramInboundFlow } from './telegram/runtime.js';
import { insertContactWithVisitorCode } from '../widget/visitorCode.js';
import { anonCodeFrom } from '../widget/anonymousContact.js';
import { isBotProvider } from '../../../shared/channels/botProviders.js';

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
  /** Extra provider-side identity details shown in the contact profile. */
  senderProfile?: {
    firstName?: string | null;
    lastName?: string | null;
    isPremium?: boolean;
    isBot?: boolean;
    chatType?: string | null;
  } | null;
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

  const channelMetadata = {
    source: input.provider,
    channel: input.provider,
    channel_identity: identityKey,
    channel_user_id: input.externalUserId,
    channel_chat_id: input.externalChatId,
    channel_username: input.senderUsername,
    channel_language: input.senderLanguage,
    channel_first_name: input.senderProfile?.firstName ?? null,
    channel_last_name: input.senderProfile?.lastName ?? null,
    channel_is_premium: input.senderProfile?.isPremium ?? false,
    channel_chat_type: input.senderProfile?.chatType ?? null,
  };

  const { data: existing } = await sb
    .from('contacts')
    .select('id, name, metadata')
    .eq('workspace_id', input.workspaceId)
    .contains('metadata', { channel_identity: identityKey })
    .limit(1)
    .maybeSingle();
  if (existing?.id) {
    // Keep the provider-side identity fresh (renames, new @username, locale).
    const nextName =
      input.senderName || (input.senderUsername ? `@${input.senderUsername}` : null);
    await sb
      .from('contacts')
      .update({
        ...(nextName && nextName !== (existing as any).name ? { name: nextName } : {}),
        metadata: { ...((existing as any).metadata || {}), ...channelMetadata },
      })
      .eq('id', (existing as any).id);
    return (existing as any).id as string;
  }

  const buildPayload = (visitorCode: string | null) => ({
    workspace_id: input.workspaceId,
    name: input.senderName || (input.senderUsername ? `@${input.senderUsername}` : null),
    visitor_code: visitorCode,
    metadata: {
      ...channelMetadata,
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
  extraMetadata: Record<string, unknown> = {},
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
        ...extraMetadata,
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

/**
 * Whether the AI will own this thread from its very first message. Resolved
 * BEFORE the conversation row exists so a Telegram thread is born in the
 * Automated queue instead of flashing through the human Inbox for the second
 * or two the AI needs to answer.
 */
async function resolveInboundAiOwnership(
  config: ServerConfig,
  input: NormalizedInboundMessage,
): Promise<boolean> {
  if (!isBotProvider(input.provider)) return false;
  try {
    const [{ getInstallation }, { parseTelegramSettings, resolveTelegramHandlingMode }] = await Promise.all([
      import('../plugins/state.js'),
      import('./telegram/settings.js'),
    ]);
    const installation = await getInstallation(config, input.workspaceId, input.provider);
    if (!installation) return false;
    const parsed = parseTelegramSettings(installation.settings);
    const { mode } = await resolveTelegramHandlingMode(config, input.workspaceId, parsed.handlingMode, input.provider);
    if (mode !== 'ai_first') return false;
    const { resolveEffectiveAiMode } = await import('../ai-agent/effectiveMode.js');
    const effective = await resolveEffectiveAiMode(config, input.workspaceId);
    return effective.visitorFacing === true;
  } catch (err) {
    console.warn('[channels] ai ownership pre-check failed:', err instanceof Error ? err.message : err);
    return false;
  }
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

    // Profile photo sync — best-effort, never blocks message processing.
    if (contactId && isBotProvider(input.provider)) {
      void import('./telegram/avatarSync.js')
        .then(({ syncTelegramContactAvatar }) =>
          syncTelegramContactAvatar(config, {
            workspaceId: input.workspaceId,
            integrationId: input.integrationId,
            contactId,
            telegramUserId: input.externalUserId,
            provider: input.provider,
          }),
        )
        .catch(() => undefined);
    }
    const aiOwnsThread = await resolveInboundAiOwnership(config, input);
    const conversation = await ensureChannelConversation(
      sb,
      input,
      contactId,
      aiOwnsThread ? { ai_state: 'ai_managed', managed_by_ai: true, ai_managed_by_ai: true } : {},
    );


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

    // NOTE: the "awaiting customer reply" resume does NOT happen here. It runs
    // after the message is committed AND after the provider flow has told us
    // whether this was real content or a menu tap — see below.


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

    // NOTE: the conversation `updated_at` bump happens after the provider
    // flow resolves, so pure menu navigation never re-floats the thread in
    // the operator inbox.
    await sb
      .from('conversations')
      .update({ contact_id: contactId })
      .eq('id', conversation.id);


    // Media persistence — provider-specific, best-effort, non-fatal. The
    // DOWNLOAD happens in the Channels Worker (Core performs no provider
    // network I/O); attachments show as `pending` until it reports back.
    if (isBotProvider(input.provider) && input.attachments?.length) {
      try {
        const { requestTelegramMediaFetch } = await import('./telegram/mediaIngest.js');
        const { outcomes } = await requestTelegramMediaFetch(config, {
          provider: input.provider,
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
        console.warn('[channels] telegram media fetch enqueue error:', mediaErr?.message || mediaErr);
      }
    }


    // Telegram-specific: slash commands (/start /help /human /new) get an
    // inline reply and never reach the AI; the handling-mode gate (human_only
    // vs entitlement-gated ai_first) is resolved here too.
    let aiAllowed = true;
    let telegramCommandHandled = false;
    let replyLocale: string | null = input.senderLanguage;
    let menuCommand: string | null = null;
    let aiPromptOverride: string | null = null;
    if (isBotProvider(input.provider)) {
      const flow = await handleTelegramInboundFlow(config, input, conversation.id);
      aiAllowed = flow.aiAllowed;
      telegramCommandHandled = flow.handled;
      replyLocale = flow.locale;
      menuCommand = flow.command ?? null;
      aiPromptOverride = flow.aiPrompt ?? null;
      console.log('[channels] telegram ai gate', {
        workspaceId: input.workspaceId,
        aiAllowed,
        commandHandled: telegramCommandHandled,
        locale: replyLocale,
      });
    }

    // Menu/command taps are navigation, not conversation content. They are
    // flagged (and pre-marked as seen) so they never raise an unread badge,
    // never re-float the thread, and never notify the operator — the Inbox
    // only renders them as a compact activity strip once the thread is open.
    if (menuCommand) {
      const nextMeta = {
        ...(((insertedMsg as any).metadata as Record<string, unknown>) || {}),
        channel_menu_command: menuCommand,
        channel_menu_event: 'true',
      };
      const seenAt = new Date().toISOString();
      (insertedMsg as any).metadata = nextMeta;
      (insertedMsg as any).seen_at = seenAt;
      await sb
        .from('conversation_messages')
        .update({ metadata: nextMeta, seen_at: seenAt })
        .eq('id', (insertedMsg as any).id);
    } else {
      await sb
        .from('conversations')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', conversation.id);
    }

    // Customer replied on a channel thread parked as "awaiting reply" — put it
    // back in the active queue. Runs AFTER the message is committed and AFTER
    // the menu router verdict, so a `/start` or menu-keyboard tap (navigation,
    // not content) can never un-park a thread. Provider status/echo events
    // never reach this far: they are dropped by the normalizers.
    await resumeConversationIfPending(config, {
      workspaceId: input.workspaceId,
      conversationId: conversation.id,
      source: input.provider,
      messageId: (insertedMsg as any).id,
      message: {
        senderType: (insertedMsg as any).sender_type,
        direction: 'inbound',
        text: input.text,
        attachmentCount: input.attachments?.length ?? 0,
        isMenuEvent: Boolean(menuCommand),
      },
    });


    // Inbox realtime — identical envelope to widget traffic. Menu taps stay
    // silent: no realtime ping, no operator notification.
    if (!menuCommand) {
      publishConversationEvent(
        config,
        input.workspaceId,
        conversation.id,
        buildMessageEnvelope(insertedMsg as any),
      ).catch(() => {});
    }



    // AI Agent runs through the SAME entry point as the widget, so mode,
    // human-takeover blocking and safety gates behave identically. Telegram
    // additionally requires ai_first (entitlement-gated) mode and skips this
    // for recognized slash commands, which are already answered above.
    if (aiAllowed && !telegramCommandHandled && (aiPromptOverride || input.text.trim())) {
      void maybeRunAiAssistantAfterVisitorMessage(config, {
        workspaceId: input.workspaceId,
        conversationId: conversation.id,
        visitorMessageId: (insertedMsg as any).id,
        question: aiPromptOverride || input.text,
        locale: replyLocale || undefined,
      })
        .then((r: any) => {
          if (isBotProvider(input.provider)) console.log(`[channels] ${input.provider} ai result`, r);
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
