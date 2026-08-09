/**
 * AI Agent engine — standalone orchestration helpers.
 *
 * Mechanically extracted from server/services/ai-agent/engine.ts (Phase 5
 * engine extraction, Commit A). Every function here is self-contained --
 * none of them close over runInternal()'s mutable local state, they only
 * take parameters -- so this move carries no behavior risk. No behavior
 * change; text unchanged apart from import path depth (moved one
 * directory deeper).
 */
import type { ServerConfig } from '../../../config.js';
import { getServiceClient } from '../../../supabase.js';
import { pickHandoffOfflineMessage, hasOfflineContactCapability } from '../runtime/templates.js';
import { evaluateMessageTriggers } from '../runtime/triggerRuntime.js';
import { evaluateWorkflows, buildWorkflowMetadata } from '../runtime/workflowRuntime.js';
import { evaluateInternalTools } from '../runtime/toolRuntime.js';
import { executeRuntimeActions } from '../runtime/actionExecutor.js';
import { executeMatchedWorkflows, buildExecutedWorkflowMetadata } from '../runtime/workflowExecutor.js';

/**
 * AI-online / human-offline is a valid, common state (the AI keeps
 * answering around the clock even when the team is asleep) — but the
 * moment the AI itself needs to hand off, a visitor must never be told
 * "connecting you to an agent" when nobody is actually online. This picks
 * the right acknowledgement and never promises a callback the workspace
 * has no way to make (see pickHandoffOfflineMessage).
 */
export async function resolveHandoffAckMessage(
  config: ServerConfig,
  workspaceId: string,
  locale: string,
  isTeamOffline: boolean,
  onlineMessage: string,
): Promise<string> {
  if (!isTeamOffline) return onlineMessage;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from('widget_prechat_settings')
      .select('ask_email, ask_phone')
      .eq('workspace_id', workspaceId)
      .maybeSingle();
    return pickHandoffOfflineMessage(locale, hasOfflineContactCapability(data as any));
  } catch {
    return pickHandoffOfflineMessage(locale, true);
  }
}

export function pickHandoffAck(locale: string | undefined, agentName: string): string {
  const l = (locale || 'en').toLowerCase();
  if (l.startsWith('fa')) return `باشه — همین الان شما را به یک کارشناس انسانی وصل می‌کنم.`;
  if (l.startsWith('tr')) return `Tamam — sizi bir temsilciye bağlıyorum.`;
  return `Sure — I'll connect you with a human agent.`;
}

export function pickGreeting(locale: string | undefined, _agentName: string): string {
  const l = (locale || 'en').toLowerCase();
  if (l.startsWith('fa')) return 'سلام! چطور می‌توانم کمکتان کنم؟';
  if (l.startsWith('tr')) return 'Merhaba! Size nasıl yardımcı olabilirim?';
  if (l.startsWith('ar')) return 'مرحباً! كيف يمكنني مساعدتك؟';
  return 'Hi! How can I help?';
}

export function pickPageNotIndexed(locale: string | undefined): string {
  const l = (locale || 'en').toLowerCase();
  if (l.startsWith('fa')) return 'این صفحه هنوز در منابع آموزشی AI ایندکس نشده است. از بخش AI Agent → Train → Web Pages این صفحه را sync کنید.';
  if (l.startsWith('tr')) return 'Bu sayfa henüz AI eğitim kaynaklarına eklenmemiş. AI Agent → Train → Web Pages üzerinden bu sayfayı senkronize edin.';
  return 'This page has not been indexed in the AI training sources yet. Sync it from AI Agent → Train → Web Pages.';
}
export function pickPageNoUrl(locale: string | undefined): string {
  const l = (locale || 'en').toLowerCase();
  if (l.startsWith('fa')) return 'من به آدرس صفحه فعلی دسترسی ندارم. لطفاً لینک صفحه را بفرستید یا ویجت را روی همان صفحه باز کنید.';
  if (l.startsWith('tr')) return 'Mevcut sayfanın adresine erişimim yok. Lütfen sayfanın bağlantısını gönderin veya widget\u2019ı o sayfada açın.';
  return 'I do not have the URL of the page you are on. Please share the page link or open the widget on that page.';
}

/** E2C — detect "what is this page" / "what page am I on" style intents. */
const PAGE_INTENT_PATTERNS: RegExp[] = [
  // Persian
  /این\s*صفحه/i,
  /صفحه[ای|‌ای]?\s*که\s*(الان|اکنون)?\s*(داخل(ش)?|توی|تو)\s*(هستم|هستیم)/i,
  /الان\s*(داخل|توی)\s*چه\s*صفحه/i,
  /محتوای\s*این\s*صفحه/i,
  /درباره\s*این\s*صفحه/i,
  // Turkish
  /bu\s*sayfa/i,
  /(şu\s*an|şuan)\s*hangi\s*sayfada/i,
  // English
  /\b(this|current)\s+page\b/i,
  /\bwhat\s+page\s+am\s+i\s+on\b/i,
  /\bexplain\s+this\s+page\b/i,
];
export function detectPageIntent(text: string): boolean {
  const t = (text || '').trim();
  if (!t || t.length > 300) return false;
  for (const p of PAGE_INTENT_PATTERNS) if (p.test(t)) return true;
  return false;
}

/**
 * C2A — execute the safe non-handoff routing side-effects in-place.
 * Currently only `mark_priority` is supported (existing column).
 * Other actions are planned-only and already logged.
 */
export async function applySafeRoutingSideEffects(
  config: ServerConfig,
  workspaceId: string,
  conversationId: string,
  result: { actions: Array<{ type: string; executed: boolean; payload?: any; sourceId?: string | null }> } | null,
): Promise<void> {
  if (!result || !conversationId) return;
  const sb = getServiceClient(config);
  for (const a of result.actions) {
    if (!a.executed) continue;
    if (a.type === 'mark_priority') {
      const desired = (a.payload?.priority || a.payload?.level || 'high') as string;
      try {
        await sb
          .from('conversations')
          .update({ priority: desired })
          .eq('id', conversationId)
          .eq('workspace_id', workspaceId);
        console.log('[ai-agent.runtime.routing] executed mark_priority', { conversationId, priority: desired });
      } catch (err: any) {
        console.warn('[ai-agent.runtime.routing] mark_priority failed:', err?.message || err);
      }
    }
  }
}

/**
 * C2B — evaluate ai_no_answer triggers / workflows and (optionally) the
 * internal handoff_to_operator tool. Mutates the provided meta refs.
 */
export async function evaluateNoAnswerHooks(args: {
  config: ServerConfig;
  workspaceId: string;
  conversationId: string;
  locale: string;
  settings: any;
  buildEvalCtx: (extra?: { answerStrategy?: any }) => any;
  runtimeCfg: any;
  decisionTimeline: string[];
  strategyMeta: { action: string; confidence: number | null; reason: string | null };
  triggerMetaRef: { get: () => any; set: (v: any) => void };
  workflowMetaRef: { get: () => any; set: (v: any) => void };
  toolMetaRef: { get: () => any; set: (v: any) => void };
}): Promise<{ handoffExecuted: boolean; lastMessageId: string | null }> {
  const summary = { handoffExecuted: false, lastMessageId: null as string | null };
  if (!args.runtimeCfg) return summary;
  try {
    const ctx = args.buildEvalCtx({ answerStrategy: args.strategyMeta });
    const trig = evaluateMessageTriggers(ctx, 'ai_no_answer');
    if (trig.matchedTriggerIds.length) {
      args.decisionTimeline.push('ai_no_answer_trigger_evaluated');
      // Execute safe trigger actions for ai_no_answer (handoff/send_message).
      const exec = await executeRuntimeActions({
        config: args.config, workspaceId: args.workspaceId, conversationId: args.conversationId,
        responseLanguage: args.locale, settings: args.settings, runId: null,
      }, trig.executed);
      if (exec.handoffExecuted) summary.handoffExecuted = true;
      if (exec.insertedMessageIds.length) summary.lastMessageId = exec.insertedMessageIds[exec.insertedMessageIds.length - 1];
      const cur = args.triggerMetaRef.get();
      args.triggerMetaRef.set({
        matched: [...cur.matched, ...trig.matchedTriggerIds.map((id, i) => ({ id, name: trig.matchedTriggerNames[i] || id }))],
        executed: [...cur.executed, ...trig.executed.map((a, i) => ({
          id: a.sourceId, name: a.sourceName,
          action_type: a.type === 'reply_template' ? 'send_message' : a.type,
          messageId: exec.insertedMessageIds[i] || null,
        }))],
        planned: [...cur.planned, ...trig.planned.map((a) => ({ id: a.sourceId, name: a.sourceName, action_type: a.type, reason: a.skippedReason || a.reason || null }))],
        skipped: [...cur.skipped, ...trig.skipped.map((a) => ({ id: a.sourceId, name: a.sourceName, reason: a.skippedReason || a.reason || null }))],
      });
    }
    const wf = evaluateWorkflows(ctx, 'ai_no_answer');
    if (wf.matchedWorkflowIds.length) {
      args.decisionTimeline.push('workflow_matched');
      // Pass D — execute safe workflow steps for ai_no_answer.
      const exec = await executeMatchedWorkflows(
        {
          config: args.config, workspaceId: args.workspaceId, conversationId: args.conversationId,
          responseLanguage: args.locale, settings: args.settings, runId: null,
        },
        wf,
        ctx,
      );
      const execMeta = buildExecutedWorkflowMetadata(exec);
      const planMeta = buildWorkflowMetadata(wf);
      const cur = args.workflowMetaRef.get();
      args.workflowMetaRef.set({
        matchedWorkflowIds: [...cur.matchedWorkflowIds, ...planMeta.matchedWorkflowIds],
        matchedWorkflowNames: [...cur.matchedWorkflowNames, ...planMeta.matchedWorkflowNames],
        executedActions: [...(cur.executedActions || []), ...execMeta.executedActions],
        blockedActions: [...(cur.blockedActions || []), ...execMeta.blockedActions],
        plannedActions: [...cur.plannedActions, ...execMeta.plannedActions],
        skippedActions: [...cur.skippedActions, ...execMeta.skippedActions, ...planMeta.skippedActions],
        runtimeExecutionEnabled: true,
        safeExecutionOnly: true,
      });
      if (execMeta.executedActions.length) args.decisionTimeline.push('workflow_step_executed');
      if (execMeta.blockedActions.length) args.decisionTimeline.push('workflow_step_blocked');
      if (exec.handoffExecuted) {
        args.decisionTimeline.push('workflow_handoff_executed');
        summary.handoffExecuted = true;
        if (exec.insertedMessageIds.length) summary.lastMessageId = exec.insertedMessageIds[exec.insertedMessageIds.length - 1];
      }
      if (exec.stopAi) args.decisionTimeline.push('workflow_stopped_ai');
    }
    // Internal tool: if handoff_to_operator is enabled, evaluate it for
    // no-answer/handoff strategies. This is a no-op when no internal tools
    // are configured.
    const enabledNames = new Set((args.runtimeCfg?.internalTools || []).map((t: any) => t.name));
    if (enabledNames.has('handoff_to_operator')) {
      const tool = evaluateInternalTools(ctx, [{ name: 'handoff_to_operator', source: 'runtime_policy' }]);
      if (tool.usedTools.length || tool.plannedTools.length || tool.skippedTools.length) {
        args.decisionTimeline.push('tools_evaluated');
      }
      if (tool.usedTools.includes('handoff_to_operator')) {
        // Executed by central executor. (Engine no_answer path also calls
        // its own markNeedsHuman; safe due to dedup flags.)
        const exec = await executeRuntimeActions({
          config: args.config, workspaceId: args.workspaceId, conversationId: args.conversationId,
          responseLanguage: args.locale, settings: args.settings, runId: null,
        }, tool.actions.filter((a) => a.executed));
        if (exec.handoffExecuted) args.decisionTimeline.push('tool_handoff_executed');
        if (exec.handoffExecuted) summary.handoffExecuted = true;
        if (exec.insertedMessageIds.length) summary.lastMessageId = exec.insertedMessageIds[exec.insertedMessageIds.length - 1];
      }
      const cur = args.toolMetaRef.get();
      args.toolMetaRef.set({
        allowedTools: tool.allowedTools,
        usedTools: Array.from(new Set([...cur.usedTools, ...tool.usedTools])),
        plannedTools: Array.from(new Set([...cur.plannedTools, ...tool.plannedTools])),
        skippedTools: Array.from(new Set([...cur.skippedTools, ...tool.skippedTools])),
      });
    }
  } catch (err: any) {
    console.warn('[ai-agent.runtime.no_answer_hooks] failed:', err?.message || err);
  }
  return summary;
}
