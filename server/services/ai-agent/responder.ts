/**
 * AI Agent — visitor-facing responder.
 *
 * Persists an `ai` sender_type message into conversation_messages and fans
 * it out via the standard realtime envelope. Used by both auto-reply and
 * handoff paths so the wire format stays identical to operator messages.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import {
  publishConversationEvent,
  buildMessageEnvelope,
} from '../realtime/publish.js';
import { ensureOutboundIntent } from '../channels/outbound.js';
import { maybeQueueTelegramOfflineScreen } from '../channels/telegram/offlineDelivery.js';
import type { AgentSettings } from './settings.js';

export interface InsertAiMessageInput {
  workspaceId: string;
  conversationId: string;
  body: string;
  source: 'ai_agent' | 'ai_agent_intro' | 'ai_agent_handoff' | 'ai_agent_fallback';
  runId?: string | null;
  mode?: string | null;
  kbArticleIds?: string[];
  qnaIds?: string[];
  confidence?: number | null;
  provider?: string | null;
  model?: string | null;
  handoff?: boolean;
  agentName?: string | null;
  agentLogoUrl?: string | null;
  /** Answer-strategy decision type — read back by the retrieval query builder. */
  decisionType?: string | null;
}

export async function insertAiMessage(
  config: ServerConfig,
  input: InsertAiMessageInput,
): Promise<{ id: string | null; error?: string }> {
  const sb = getServiceClient(config);
  const offlineScreenQueued = input.handoff === true
    ? await maybeQueueTelegramOfflineScreen(config, {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        locale: 'en',
      }).catch(() => false)
    : false;
  const metadata: Record<string, unknown> = {
    source: input.source,
    run_id: input.runId ?? null,
    mode: input.mode ?? null,
    kb_article_ids: input.kbArticleIds ?? [],
    qna_ids: input.qnaIds ?? [],
    confidence: input.confidence ?? null,
    provider: input.provider ?? null,
    model: input.model ?? null,
    handoff: !!input.handoff,
    agent_name: input.agentName ?? null,
    agent_logo_url: input.agentLogoUrl ?? null,
    decision_type: input.decisionType ?? null,
    answer_strategy: { decision_type: input.decisionType ?? null },
    ...(offlineScreenQueued ? { channel_delivery_skip: 'true', telegram_offline_screen: true } : {}),
  };

  const { data: row, error } = await sb
    .from('conversation_messages')
    .insert({
      conversation_id: input.conversationId,
      body: input.body,
      sender_type: 'ai',
      metadata,
    })
    .select('id, conversation_id, sender_type, body, created_at, metadata, seen_at')
    .single();

  if (error) {
    console.warn('[ai-agent] insertAiMessage failed:', error.message);
    return { id: null, error: error.message };
  }

  // Bump conversation updated_at so inbox ordering reflects the AI reply.
  await sb
    .from('conversations')
    .update({ updated_at: new Date().toISOString() })
    .eq('id', input.conversationId);

  // The DB trigger is the crash-safe primary path. Reconcile here as a
  // compatibility backstop for deployments whose channel trigger has not yet
  // been migrated to accept sender_type='ai'. The message-id unique index
  // keeps this idempotent when the trigger already created the job.
  if (!offlineScreenQueued) {
    try {
      await ensureOutboundIntent(config, {
        workspaceId: input.workspaceId,
        conversationId: input.conversationId,
        messageId: row.id,
        body: input.body,
      });
    } catch (e: any) {
      console.warn('[ai-agent] outbound reconciliation failed:', e?.message || e);
    }
  }

  // Realtime fan-out: same envelope as operator messages.
  try {
    await publishConversationEvent(
      config,
      input.workspaceId,
      input.conversationId,
      buildMessageEnvelope(row as any),
    );
  } catch (e: any) {
    console.warn('[ai-agent] publish AI message failed:', e?.message || e);
  }

  return { id: row?.id || null };
}

export function deriveAgentDisplay(settings: AgentSettings): {
  agentName: string;
  agentLogoUrl: string | null;
} {
  return {
    agentName: settings.agent_name || 'AI Assistant',
    agentLogoUrl: settings.agent_logo_url || null,
  };
}
