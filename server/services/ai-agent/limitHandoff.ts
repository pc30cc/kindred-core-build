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
import { commitNeedsHuman, routeAfterHandoff, type HandoffReason } from './handoffState.js';

export type LimitReason =
  | 'max_replies_reached'
  | 'rate_limited'
  | 'no_credits'
  | 'plan_limit_reached'
  // P0-AI — the provider vanished (deleted/disabled) between the widget
  // config snapshot and this turn. The AI definitively cannot answer, so
  // the conversation must leave AI ownership through the same durable
  // machinery instead of sitting silently in ai_state=ai_managed.
  | 'no_ai_provider';

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

/** Atomic shallow metadata patch (migration 057) — no lost updates. */
async function patchMeta(
  config: ServerConfig,
  conversationId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const sb = getServiceClient(config);
  const { error } = await sb.rpc('patch_conversation_metadata', {
    p_conversation_id: conversationId,
    p_workspace_id: null,
    p_patch: patch,
  });
  if (!error) return;
  const current = await readMeta(config, conversationId);
  await sb
    .from('conversations')
    .update({ metadata: { ...current, ...patch }, updated_at: new Date().toISOString() })
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
  /** True only when needs_human was durably persisted (or already was). */
  committed: boolean;
  sentMessage: boolean;
  duplicate: boolean;
  runId: string | null;
  messageId: string | null;
}

/**
 * Execute the limit-handoff flow. Idempotent per (conversation, reason):
 * subsequent visitor messages will not re-send the template.
 *
 * COMMIT-FIRST contract: no dedupe marker, no visitor acknowledgement and no
 * routing may happen until `commitNeedsHuman()` durably persisted the
 * needs_human transition. A failed commit logs a `failed` run and returns
 * `committed:false`, so the next visitor message retries the whole flow.
 */
export async function runLimitHandoff(
  config: ServerConfig,
  input: RunLimitHandoffInput,
): Promise<RunLimitHandoffResult> {
  const fallbackBehavior = (input.settings as any).fallback_behavior || 'handoff';
  const suppressMessage = fallbackBehavior === 'silent' || input.suppressVisitorMessage === true;
  const meta = await readMeta(config, input.conversationId);

  const reasonMatches = meta.ai_limit_handoff_reason === input.reason;
  // Post-commit marker — written ONLY after a durable commit succeeded.
  const committedMarker = reasonMatches && meta.ai_limit_handoff_committed === true;
  // Legacy marker (pre commit-first implementations): ambiguous, it may have
  // been written before a commit that never landed. Verify durable state.
  const legacyMarker = reasonMatches && meta.ai_limit_handoff_sent === true && !committedMarker;
  const durableNeedsHuman = meta.ai_state === 'needs_human';
  const messageAlreadySent =
    reasonMatches &&
    (meta.ai_limit_handoff_message_sent === true || meta.ai_limit_handoff_sent === true);

  const logHandoffRun = (opts: {
    status: 'handoff' | 'failed';
    duplicate: boolean;
    extra?: Record<string, unknown>;
    skipReason?: string;
  }) =>
    logRun(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      visitorMessageId: input.visitorMessageId,
      runType: 'handoff',
      mode: input.settings.mode,
      status: opts.status,
      inputText: input.question,
      skipReason: opts.skipReason || input.reason,
      creditsUsed: 0,
      metadata: {
        ...(input.extraMetadata || {}),
        limit_handoff: true,
        limit_reason: input.reason,
        duplicate: opts.duplicate,
        fallback_behavior: fallbackBehavior,
        ...(opts.extra || {}),
      },
    });

  // ── Duplicate paths ────────────────────────────────────────────────────
  if (committedMarker || (legacyMarker && durableNeedsHuman)) {
    const runId = await logHandoffRun({ status: 'handoff', duplicate: true });
    return { committed: true, sentMessage: false, duplicate: true, runId, messageId: null };
  }

  if (legacyMarker) {
    // Ambiguous historical marker with no durable state — re-run the
    // idempotent commit instead of trusting it.
    const recommit = await commitNeedsHuman(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      reason: input.reason as HandoffReason,
    }).catch(() => ({ ok: false, routingDeferred: false }));
    if (!recommit.ok) {
      const runId = await logHandoffRun({
        status: 'failed',
        duplicate: false,
        skipReason: 'commit_failed',
        extra: { commit_failed: true, legacy_marker: true },
      });
      return { committed: false, sentMessage: false, duplicate: false, runId, messageId: null };
    }
    await patchMeta(config, input.conversationId, {
      ai_limit_handoff_committed: true,
      ai_limit_handoff_reason: input.reason,
      ai_limit_handoff_at: new Date().toISOString(),
    });
    const runId = await logHandoffRun({
      status: 'handoff',
      duplicate: true,
      extra: { legacy_marker_recommitted: true },
    });
    await routeAfterHandoff(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      commit: recommit,
    });
    return {
      committed: true,
      sentMessage: false,
      duplicate: messageAlreadySent,
      runId,
      messageId: null,
    };
  }

  // ── Commit FIRST ───────────────────────────────────────────────────────
  const commit = await commitNeedsHuman(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    reason: input.reason as HandoffReason,
  }).catch(() => ({ ok: false, routingDeferred: false }));

  if (!commit.ok) {
    // Nothing persisted: no dedupe marker, no acknowledgement, no routing.
    const runId = await logHandoffRun({
      status: 'failed',
      duplicate: false,
      skipReason: 'commit_failed',
      extra: { commit_failed: true },
    });
    return { committed: false, sentMessage: false, duplicate: false, runId, messageId: null };
  }

  const nowIso = new Date().toISOString();
  await patchMeta(config, input.conversationId, {
    ai_limit_handoff_committed: true,
    ai_limit_handoff_reason: input.reason,
    ai_limit_handoff_at: nowIso,
  });

  const runId = await logHandoffRun({ status: 'handoff', duplicate: false });

  // Suppress visitor-facing message when fallback_behavior='silent' or
  // mode=suggest_only — committed:true / sentMessage:false is valid.
  if (suppressMessage) {
    await routeAfterHandoff(config, {
      workspaceId: input.workspaceId,
      conversationId: input.conversationId,
      commit,
    });
    return { committed: true, sentMessage: false, duplicate: false, runId, messageId: null };
  }

  // The ack is inserted AFTER the commit but BEFORE routing, so the routing
  // outcome ("X joined" / "no one's available") can never render ahead of
  // the AI's own message.
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
  await patchMeta(config, input.conversationId, {
    ai_limit_handoff_message_sent: true,
    // Legacy key kept for backward compatibility with older readers.
    ai_limit_handoff_sent: true,
  });
  await routeAfterHandoff(config, {
    workspaceId: input.workspaceId,
    conversationId: input.conversationId,
    commit,
  });


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

  return { committed: true, sentMessage: true, duplicate: false, runId, messageId: inserted.id };
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