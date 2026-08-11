/**
 * AI Agent — Phase 3 action runner.
 *
 * Thin adapter over the EXISTING canonical executors. No second execution
 * framework: handoff and priority go through runtime/actionExecutor.ts,
 * tags/notes reuse the same table contracts as runtime/workflowExecutor.ts,
 * business hours reuses the widget availability resolver.
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { executeRuntimeActions, type ExecutorContext } from '../runtime/actionExecutor.js';
import { getOperatorAvailability } from '../availability.js';
import { MAX_TAGS_PER_CONVERSATION } from './catalog.js';

export interface ActionRunResult {
  ok: boolean;
  reason: string;
  data?: Record<string, unknown>;
}

export interface ActionRunner {
  run(name: string, args: Record<string, unknown>): Promise<ActionRunResult>;
}

export function createRealActionRunner(ctx: ExecutorContext & { locale?: string }): ActionRunner {
  return {
    async run(name, args): Promise<ActionRunResult> {
      try {
        if (name === 'handoff_to_operator') {
          const res = await executeRuntimeActions(ctx, [{
            type: 'handoff', source: 'internal_tool', sourceName: 'handoff_to_operator',
            reason: 'ai_planned', executed: true, payload: {},
          }]);
          return res.handoffExecuted
            ? { ok: true, reason: 'handoff_executed', data: { messageIds: res.insertedMessageIds } }
            : { ok: false, reason: 'handoff_failed' };
        }
        if (name === 'mark_priority') {
          const res = await executeRuntimeActions(ctx, [{
            type: 'mark_priority', source: 'internal_tool', sourceName: 'mark_priority',
            reason: 'ai_planned', executed: true, payload: { priority: args.priority },
          }]);
          return res.priorityUpdated
            ? { ok: true, reason: 'priority_updated', data: { priority: args.priority } }
            : { ok: false, reason: 'priority_update_failed' };
        }
        if (name === 'add_tag') {
          const sb = getServiceClient(ctx.config);
          const tag = String(args.tag);
          const { data: row } = await sb.from('conversations').select('tags')
            .eq('id', ctx.conversationId).eq('workspace_id', ctx.workspaceId).maybeSingle();
          const current: string[] = Array.isArray((row as any)?.tags) ? (row as any).tags : [];
          if (current.includes(tag)) return { ok: true, reason: 'tag_already_present' };
          if (current.length >= MAX_TAGS_PER_CONVERSATION) return { ok: false, reason: 'tag_limit_reached' };
          const { error } = await sb.from('conversations').update({ tags: [...current, tag] })
            .eq('id', ctx.conversationId).eq('workspace_id', ctx.workspaceId);
          return error ? { ok: false, reason: 'add_tag_failed' } : { ok: true, reason: 'tag_added' };
        }
        if (name === 'add_internal_note') {
          const sb = getServiceClient(ctx.config);
          const { error } = await sb.from('conversation_notes').insert({
            conversation_id: ctx.conversationId,
            workspace_id: ctx.workspaceId,
            body: String(args.body),
            author_id: null,
            author_type: 'ai_agent',
            metadata: { runtime_source: 'ai_action' },
          });
          return error ? { ok: false, reason: 'add_internal_note_failed' } : { ok: true, reason: 'note_added' };
        }
        if (name === 'get_business_hours') {
          const av = await getOperatorAvailability(ctx.config, ctx.workspaceId, ctx.locale || 'en');
          return { ok: true, reason: 'business_hours_read', data: { state: av.state, reason: av.reason } };
        }
        if (name === 'search_kb') {
          return { ok: true, reason: 'search_kb_marker' };
        }
        return { ok: false, reason: 'no_executor' };
      } catch (err: any) {
        console.warn('[ai-agent.actions] runner failed:', err?.message || err);
        return { ok: false, reason: 'execution_error' };
      }
    },
  };
}
