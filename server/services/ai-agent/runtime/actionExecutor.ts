/**
 * AI Agent — C2B central runtime action executor.
 *
 * Single source of truth for safe side-effects:
 *   - reply_template (insert AI message via insertAiMessage)
 *   - handoff (markNeedsHuman + handoff template + flags)
 *   - mark_priority (conversation.priority update)
 *   - tool_executed for handoff_to_operator / mark_priority
 *
 * Anything else is left untouched (planned). Engine still owns the high-level
 * decision flow (LLM, retrieval, etc.); this module just executes leaves.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import type { RuntimeAction } from './types.js';
import { insertAiMessage, deriveAgentDisplay } from '../responder.js';
import { markNeedsHuman, readAiConversationMeta } from '../handoffState.js';
import { markHandoffRequested } from '../conversationState.js';
import { updateRuntimeFlags } from './conversationState.js';
import { pickHandoffAckMessage } from './templates.js';
import type { AgentSettings } from '../settings.js';

export interface ExecutorContext {
  config: ServerConfig;
  workspaceId: string;
  conversationId: string;
  responseLanguage: string;
  settings: AgentSettings;
  runId?: string | null;
}

export interface ExecutionResult {
  insertedMessageIds: string[];
  triggerExecutedIds: string[];
  handoffExecuted: boolean;
  priorityUpdated: boolean;
  toolUsedNames: string[];
}

export async function executeRuntimeActions(
  ctx: ExecutorContext,
  actions: RuntimeAction[],
): Promise<ExecutionResult> {
  const result: ExecutionResult = {
    insertedMessageIds: [], triggerExecutedIds: [],
    handoffExecuted: false, priorityUpdated: false, toolUsedNames: [],
  };
  if (!actions || !actions.length) return result;

  for (const a of actions) {
    if (!a.executed) continue;

    if (a.type === 'reply_template') {
      const body = (a.payload as any)?.body as string | undefined;
      if (!body) continue;
      const display = deriveAgentDisplay(ctx.settings);
      try {
        const ins = await insertAiMessage(ctx.config, {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          body,
          source: 'ai_agent' as const,
          runId: ctx.runId ?? null,
          mode: ctx.settings.mode,
          handoff: false,
          agentName: display.agentName,
          agentLogoUrl: display.agentLogoUrl,
        });
        if (ins.id) {
          result.insertedMessageIds.push(ins.id);
          (a.payload as any).messageId = ins.id;
        }
        if (a.source === 'message_trigger' && a.sourceId) {
          await updateRuntimeFlags(ctx.config, ctx.conversationId, {
            appendTriggerId: a.sourceId,
          }).catch(() => {});
          result.triggerExecutedIds.push(a.sourceId);
        }
      } catch (err: any) {
        console.warn('[ai-agent.runtime.executor] reply_template failed:', err?.message || err);
      }
      continue;
    }

    if (a.type === 'handoff' || (a.type === 'tool_executed' && a.sourceName === 'handoff_to_operator')) {
      try {
        // Idempotency: if a handoff/takeover is already recorded, do not insert
        // another handoff message. We still mark dedup flag so downstream sees it.
        const current = await readAiConversationMeta(ctx.config, ctx.conversationId).catch(() => null);
        const alreadyHandoff =
          !!current && (
            current.state === 'needs_human' ||
            current.state === 'human_active' ||
            current.handoff_requested === true ||
            !!current.human_takeover_at ||
            (current.metadata as any)?.ai_handoff_sent === true
          );
        if (alreadyHandoff) {
          await updateRuntimeFlags(ctx.config, ctx.conversationId, { handoffSent: true }).catch(() => {});
          if (a.source === 'message_trigger' && a.sourceId) {
            await updateRuntimeFlags(ctx.config, ctx.conversationId, {
              appendTriggerId: a.sourceId,
            }).catch(() => {});
            result.triggerExecutedIds.push(a.sourceId);
          }
          if (a.type === 'tool_executed') result.toolUsedNames.push('handoff_to_operator');
          result.handoffExecuted = true;
          console.log('[ai-agent.runtime.executor] handoff skipped — already in handoff/takeover state', { conversationId: ctx.conversationId });
          continue;
        }
        await markHandoffRequested(ctx.config, ctx.conversationId).catch(() => {});
        // The AI's own "connecting you now" ack must land in the thread
        // BEFORE any routing-outcome message ("X joined" / "no one's
        // available") — markNeedsHuman() below synchronously runs routing
        // (chatRouting.ts) and inserts that outcome message itself, so the
        // ack has to be inserted first or it renders out of order (visitor
        // sees "operator joined" before the AI ever says it's connecting).
        const display = deriveAgentDisplay(ctx.settings);
        const ack = pickHandoffAckMessage(ctx.settings, ctx.responseLanguage);
        const ins = await insertAiMessage(ctx.config, {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          body: ack,
          source: 'ai_agent_handoff',
          runId: ctx.runId ?? null,
          mode: ctx.settings.mode,
          handoff: true,
          agentName: display.agentName,
          agentLogoUrl: display.agentLogoUrl,
        });
        if (ins.id) result.insertedMessageIds.push(ins.id);
        await markNeedsHuman(ctx.config, {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          reason: 'human_request',
        });
        await updateRuntimeFlags(ctx.config, ctx.conversationId, { handoffSent: true }).catch(() => {});
        if (a.source === 'message_trigger' && a.sourceId) {
          await updateRuntimeFlags(ctx.config, ctx.conversationId, {
            appendTriggerId: a.sourceId,
          }).catch(() => {});
          result.triggerExecutedIds.push(a.sourceId);
        }
        if (a.type === 'tool_executed') result.toolUsedNames.push('handoff_to_operator');
        result.handoffExecuted = true;
      } catch (err: any) {
        console.warn('[ai-agent.runtime.executor] handoff failed:', err?.message || err);
      }
      continue;
    }

    if (a.type === 'mark_priority' || (a.type === 'tool_executed' && a.sourceName === 'mark_priority')) {
      const raw = String((a.payload as any)?.priority || (a.payload as any)?.level || 'high').toLowerCase();
      // conversation_priority enum: low | normal | high | urgent
      const ALLOWED = new Set(['low', 'normal', 'high', 'urgent']);
      const desired = ALLOWED.has(raw) ? raw : 'high';
      try {
        const sb = getServiceClient(ctx.config);
        await sb.from('conversations').update({ priority: desired })
          .eq('id', ctx.conversationId)
          .eq('workspace_id', ctx.workspaceId);
        result.priorityUpdated = true;
        if (a.type === 'tool_executed') result.toolUsedNames.push('mark_priority');
        console.log('[ai-agent.runtime.executor] mark_priority', { conversationId: ctx.conversationId, priority: desired });
      } catch (err: any) {
        console.warn('[ai-agent.runtime.executor] mark_priority failed:', err?.message || err);
      }
      continue;
    }

    if (a.type === 'tool_executed' && a.sourceName === 'search_kb') {
      // Marker only — retrieval already happens upstream.
      result.toolUsedNames.push('search_kb');
      continue;
    }
  }

  return result;
}

export function planOnly(action: RuntimeAction, reason: string): RuntimeAction {
  return { ...action, executed: false, skippedReason: action.skippedReason || reason };
}