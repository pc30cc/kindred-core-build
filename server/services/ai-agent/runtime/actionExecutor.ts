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
import { markNeedsHuman } from '../handoffState.js';
import { markHandoffRequested } from '../conversationState.js';
import { updateRuntimeFlags } from './conversationState.js';
import { pickTemplate } from './templates.js';
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
        await markHandoffRequested(ctx.config, ctx.conversationId).catch(() => {});
        await markNeedsHuman(ctx.config, {
          workspaceId: ctx.workspaceId,
          conversationId: ctx.conversationId,
          reason: 'human_request',
        });
        const display = deriveAgentDisplay(ctx.settings);
        const ack = pickTemplate('handoff', ctx.responseLanguage);
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
      const desired = ((a.payload as any)?.priority || (a.payload as any)?.level || 'high') as string;
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