/**
 * AI Agent — limit handoff.
 *
 * When AI cannot continue because of a quota/limit (max replies per
 * conversation, hourly rate limit, no AI credits, plan limit), we send
 * ONE localized human-friendly handoff message, route the conversation
 * to "Needs human", and stop further AI auto-replies.
 *
 * Design rules:
 *   - never call the LLM (0 credits)
 *   - de-dupe per conversation per reason via metadata flags
 *   - respect fallback_behavior='silent' (no visitor message, but still
 *     route to needs_human + log)
 *   - skip visitor-facing message in suggest_only mode
 *   - log ai_agent_runs with status='handoff', run_type='handoff',
 *     skip_reason=reason, credits_used=0, metadata.limit_handoff=true
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { AgentSettings } from './settings.js';
import { logRun } from './logs.js';
import { insertAiMessage, deriveAgentDisplay } from './responder.js';
import { markHandoffRequested } from './conversationState.js';
import { markNeedsHuman, type HandoffReason } from './handoffState.js';

export type LimitReason =
  | 'max_replies_reached'
  | 'rate_limited'
  | 'no_credits'
  | 'plan_limit_reached';

/** Localized template — independent of the LLM. */
export function pickLimitHandoffMessage(
  locale: string | undefined,
  _reason: LimitReason,
): string {
  const l = (locale || 'en').toLowerCase();
  if (l.startsWith('fa')) {
    return 'برای ادامه، شما را به اپراتور وصل می‌کنم. تیم پشتیبانی به‌زودی پاسخ می‌دهد.';
  }
  if (l.startsWith('tr')) {
    return 'Bu konuda sizi bir temsilciye aktarıyorum. Ekibimiz en kısa sürede yardımcı olacak.';
  }
  return "I'll connect you with a human agent so our team can help you further.";
}

async function readMeta(
  config: ServerConfig,
  conversationId: string,
): Promise<Record<string, any>> {
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('conversations')
    .select('metadata')
    .eq('id', conversationId)
    .maybeSingle();
  return ((data as any)?.metadata || {}) as Record<string, any>;
}

async function patchMeta(
  config: ServerConfig,
  conversationId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sb = getServiceClient(config);
  const current = await readMeta(config, conversationId);
  const merged = { ...current, ...patch };
  await sb
    .from('conversations')
    .update({ metadata: merged, updated_at: new Date().toISOString() })
    .eq('id', conversationId);
}

export interface RunLimitHandoffInput {
  workspaceId: string;
  conversationId: string;
  visitorMessageId: string;
  question: string;
  locale: string;
  reason: LimitReason;
  settings: AgentSettings;
  /** When true (suggest_only), do not insert a visitor-facing message. */
  suppressVisitorMessage?: boolean;
  /** Extra metadata to merge into the run log. */
  extraMetadata?: Record<string, unknown>;
}

export interface RunLimitHandoffResult {
  sentMessage: boolean;
  duplicate: boolean;
  runId: string | null;
  messageId: string | null;
}

/**
 * Execute the limit-handoff flow. Idempotent per (conversation, reason):
 * subsequent visitor messages will not re-send the template.
 */
export async function runLimitHandoff(
  config: ServerConfig,
  input: RunLimitHandoffInput,
): Promise<RunLimitHandoffResult> {
  const fallbackBehavior = (input.settings as any).fallback_behavior || 'handoff';
  const meta = await readMeta(config, input.conversationId);
  const alreadySent =
    meta.ai_limit_handoff_sent === true &&
    meta.ai_limit_handoff_reason === input.reason;

  // Always log the run (so analytics reflect every limit hit), but mark
  // duplicates so the engine can short-circuit.
  const runId = await logRun(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    visitorMessageId: input.visitorMessageId,
    runType: 'handoff',
    mode: input.settings.mode,
    status: 'handoff',
    inputText: input.question,
    skipReason: input.reason,
    creditsUsed: 0,
    metadata: {
      ...(input.extraMetadata || {}),
      limit_handoff: true,
      limit_reason: input.reason,
      duplicate: alreadySent,
      fallback_behavior: fallbackBehavior,
    },
  });

  if (alreadySent) {
    return { sentMessage: false, duplicate: true, runId, messageId: null };
  }

  // Always route to human queue, even when fallback_behavior='silent'.
  await markHandoffRequested(config, input.conversationId).catch(() => {});

  const nowIso = new Date().toISOString();
  await patchMeta(config, input.conversationId, {
    ai_limit_handoff_sent: true,
    ai_limit_handoff_reason: input.reason,
    ai_limit_handoff_at: nowIso,
  });

  // Suppress visitor-facing message when fallback_behavior='silent' or
  // mode=suggest_only. No ack is being sent, so there's no message-ordering
  // hazard — route to the human queue right away.
  if (fallbackBehavior === 'silent' || input.suppressVisitorMessage) {
    await markNeedsHuman(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      reason: input.reason as HandoffReason,
    }).catch(() => {});
    return { sentMessage: false, duplicate: false, runId, messageId: null };
  }

  // Insert the ack BEFORE markNeedsHuman() — markNeedsHuman synchronously
  // runs routing and inserts its own "X joined" / "no one's available"
  // system message, so the ack has to land first or the routing outcome
  // renders ahead of the AI's own message.
  const display = deriveAgentDisplay(input.settings);
  const body = pickLimitHandoffMessage(input.locale, input.reason);
  const inserted = await insertAiMessage(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    body,
    // Reuse the existing handoff source so the inbox UI styles it as a handoff.
    source: 'ai_agent_handoff',
    runId,
    mode: input.settings.mode,
    handoff: true,
    agentName: display.agentName,
    agentLogoUrl: display.agentLogoUrl,
  });
  await markNeedsHuman(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    reason: input.reason as HandoffReason,
  }).catch(() => {});

  // Tag this specific message so the timeline can render the limit badge.
  try {
    const sb = getServiceClient(config);
    if (inserted.id) {
      const { data: msgRow } = await sb
        .from('conversation_messages')
        .select('metadata')
        .eq('id', inserted.id)
        .maybeSingle();
      const m = ((msgRow as any)?.metadata || {}) as Record<string, unknown>;
      await sb
        .from('conversation_messages')
        .update({
          metadata: {
            ...m,
            source: 'ai_agent_limit_handoff',
            handoff: true,
            limit_handoff: true,
            limit_reason: input.reason,
          },
        })
        .eq('id', inserted.id);
    }
  } catch { /* best-effort */ }

  return { sentMessage: true, duplicate: false, runId, messageId: inserted.id };
}

/** Detect credit / plan limit errors coming from the AI provider layer. */
export function detectLimitErrorReason(message: string | undefined | null): LimitReason | null {
  if (!message) return null;
  const m = message.toLowerCase();
  if (m.includes('plan_limit') || m.includes('plan limit') || m.includes('upgrade required')) {
    return 'plan_limit_reached';
  }
  if (
    m.includes('no_credits') ||
    m.includes('insufficient_credits') ||
    m.includes('insufficient credit') ||
    m.includes('out of credits') ||
    m.includes('credit_limit') ||
    m.includes('quota') && m.includes('credit')
  ) {
    return 'no_credits';
  }
  return null;
}