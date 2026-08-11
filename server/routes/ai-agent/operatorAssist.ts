/**
 * AI Agent router — operatorAssist domain.
 *
 * Mechanically extracted from the original server/routes/aiAgent.ts (Phase 3
 * router split). Route paths, middleware order, auth, validation, rate
 * limits and response shapes are unchanged from the original file.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { redactSecrets } from '../../lib/redactSecrets.js';
import { getOrCreateSettings } from '../../services/ai-agent/settings.js';
import { retrieveHybridSources } from '../../services/ai-agent/retrievalHybrid.js';
import {
  redactDeep as e7_redactDeep,
  redactString as e7_redactString,
} from '../../services/ai-agent/testHarness.js';
import { decideStrategy as e7_decideStrategy } from '../../services/ai-agent/answerStrategy.js';
import { buildSystemPrompt as e7_buildSystemPrompt, buildUserPrompt as e7_buildUserPrompt } from '../../services/ai-agent/prompt.js';
import { resolveAIConfig as e7_resolveAIConfig, executeAICompletion as e7_executeAICompletion } from '../../services/ai/index.js';
import { checkEntitlementFromDB } from '../../middleware/featureGating.js';
import { authorizeMember, isOwnerOrAdmin, requireWorkspace } from './shared.js';

export const operatorAssistRouter: Router = express.Router();


// ─────────────────────────────────────────────────────────────────────
// Pass E7 — Operator AI Suggest-Reply (read-only, no side effects).
//
// POST /api/ai-agent/operator/suggest-reply
//   - workspace member required
//   - feature gate: 'ai_operator_assist' (fail-closed if entitlement denied)
//   - never inserts conversation_messages
//   - never triggers workflows / handoffs / learning candidates / tools
//   - never auto-sends; operator decides via inbox UI
//   - file source_url always null; sensitive metadata redacted
// ─────────────────────────────────────────────────────────────────────

const e7AssistCounters = new Map<string, { count: number; windowStart: number }>();
const E7_ASSIST_LIMIT = 30;
const E7_ASSIST_WINDOW = 5 * 60_000;
function checkE7AssistRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`;
  const now = Date.now();
  const c = e7AssistCounters.get(key);
  if (!c || now - c.windowStart > E7_ASSIST_WINDOW) {
    e7AssistCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  c.count += 1;
  return c.count <= E7_ASSIST_LIMIT;
}

const suggestReplySchema = z.object({
  workspaceId: z.string().uuid(),
  conversationId: z.string().uuid(),
  locale: z.string().max(10).optional(),
  tone: z.enum(['friendly', 'professional', 'short', 'detailed']).optional(),
  instruction: z.string().max(1000).optional(),
  callLLM: z.boolean().optional(),
});

const TONE_HINTS: Record<string, string> = {
  friendly: 'Use a warm, friendly tone. Address the visitor casually but respectfully.',
  professional: 'Use a professional, courteous tone. No slang.',
  short: 'Keep the reply to 1–2 short sentences. No filler.',
  detailed: 'Provide a thorough reply that covers the question completely while staying grounded in the sources.',
};

/** Operator inbox permission: owner / admin / agent (or global admin). */
function e7_isOperator(role: string | null, isGlobalAdmin: boolean): boolean {
  if (isGlobalAdmin) return true;
  return role === 'owner' || role === 'admin' || role === 'agent';
}

/** Schema-aware visitor message detection. Conversation messages use
 *  `sender_type` in this app; visitor messages are stored as 'contact'
 *  (see widgetIdentity / conversations routes). 'visitor'/'customer'/'user'
 *  are accepted as forward-compat fallbacks but never as a guess. */
function e7_isVisitorMessage(m: { sender_type?: string | null } | null | undefined): boolean {
  if (!m) return false;
  const t = (m.sender_type || '').toLowerCase();
  return t === 'contact' || t === 'visitor' || t === 'customer';
}

async function e7PersistAssistRun(
  config: ServerConfig,
  payload: {
    workspaceId: string;
    conversationId: string;
    requestedBy: string | null;
    status: 'suggested' | 'failed' | 'skipped';
    inputMessage: string | null;
    instruction: string | null;
    tone: string | null;
    suggestion: string | null;
    confidence: number | null;
    selectedSources: any[];
    retrievalDebug: any;
    answerStrategy: any;
    safetyNotes: string[];
    provider: string | null;
    model: string | null;
    error: string | null;
  },
): Promise<string | null> {
  try {
    const sb = getServiceClient(config);
    const { data, error } = await sb.from('ai_operator_assist_runs').insert({
      workspace_id: payload.workspaceId,
      conversation_id: payload.conversationId,
      requested_by: payload.requestedBy,
      status: payload.status,
      input_message: payload.inputMessage,
      instruction: payload.instruction,
      tone: payload.tone,
      suggestion: payload.suggestion,
      confidence: payload.confidence,
      selected_sources: e7_redactDeep(payload.selectedSources) || [],
      retrieval_debug: e7_redactDeep(payload.retrievalDebug) || {},
      answer_strategy: e7_redactDeep(payload.answerStrategy) || {},
      safety_notes: e7_redactDeep(payload.safetyNotes) || [],
      provider: payload.provider,
      model: payload.model,
      // Provider/network failures can embed credentials — redact before persisting.
      error: redactSecrets(payload.error),
    }).select('id').maybeSingle();
    if (error) {
      console.error('[ai-agent.e7] persist assist run error:', error.message);
      return null;
    }
    return (data?.id as string) || null;
  } catch (err: any) {
    console.error('[ai-agent.e7] persist assist run failed:', err?.message);
    return null;
  }
}

operatorAssistRouter.post('/operator/suggest-reply', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = suggestReplySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId, conversationId, locale, tone, instruction } = parsed.data;
  const callLLM = parsed.data.callLLM !== false;

  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  // E7-Hardening: only inbox operators (owner/admin/agent or global admin).
  if (!e7_isOperator(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'operator_permission_required' });
  }

  if (!checkE7AssistRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'rate_limited' });
  }

  // Conversation must belong to workspace.
  const sb = getServiceClient(config);
  const { data: conv } = await sb
    .from('conversations')
    .select('id, workspace_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv || conv.workspace_id !== workspaceId) {
    return res.status(404).json({ error: 'conversation_not_found' });
  }

  // Feature gate: fail-closed in production. Only allow in non-production
  // when AI_OPERATOR_ASSIST_ALLOW_WITHOUT_PLAN=true is explicitly set.
  const ent = await checkEntitlementFromDB(
    config.supabaseUrl,
    config.supabaseServiceRoleKey,
    workspaceId,
    'ai_operator_assist',
  );
  if (!ent.allowed) {
    const allowDevBypass =
      process.env.NODE_ENV !== 'production' &&
      process.env.AI_OPERATOR_ASSIST_ALLOW_WITHOUT_PLAN === 'true';
    if (!allowDevBypass) {
      return res.status(403).json({
        error: 'feature_not_available',
        feature: 'ai_operator_assist',
        plan: ent.plan,
        reason: ent.reason || 'entitlement_denied',
        upgrade_required: true,
      });
    }
  }

  // Load recent messages — last 20 / 12k chars cap.
  const { data: msgs } = await sb
    .from('conversation_messages')
    .select('id, sender_type, body, created_at')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(20);
  const ordered = (msgs || []).slice().reverse();
  let totalChars = 0;
  const trimmed: typeof ordered = [];
  for (const m of ordered) {
    const len = (m.body || '').length;
    if (totalChars + len > 12_000) break;
    trimmed.push(m);
    totalChars += len;
  }
  const latestVisitor = [...trimmed].reverse().find((m) => e7_isVisitorMessage(m));
  const inputMessage = latestVisitor?.body || '';

  if (!inputMessage.trim()) {
    return res.status(400).json({ error: 'no_visitor_message' });
  }

  // Build retrieval query: latest visitor message + tail context.
  const tailContext = trimmed.slice(-4)
    .map((m) => `${e7_isVisitorMessage(m) ? 'Visitor' : 'Agent'}: ${(m.body || '').slice(0, 400)}`)
    .join('\n');

  const settings = await getOrCreateSettings(config, workspaceId);
  const responseLocale = locale || settings.allowed_locales?.[0] || 'en';

  const safetyNotes: string[] = [];
  let hybrid: any;
  try {
    hybrid = await retrieveHybridSources(config, {
      workspaceId,
      originalMessage: inputMessage,
      retrievalQuery: inputMessage,
      expandedQuery: inputMessage,
      responseLanguage: responseLocale,
      inputLanguage: responseLocale,
      limit: 8,
    });
  } catch (err: any) {
    await e7PersistAssistRun(config, {
      workspaceId, conversationId, requestedBy: auth.userId,
      status: 'failed', inputMessage, instruction: instruction ?? null, tone: tone ?? null,
      suggestion: null, confidence: null, selectedSources: [], retrievalDebug: null,
      answerStrategy: {}, safetyNotes: [`retrieval_error:${err?.message || 'unknown'}`],
      provider: null, model: null, error: err?.message || 'retrieval_failed',
    });
    return res.status(500).json({ error: 'retrieval_failed', details: err?.message });
  }

  const sources = hybrid.sources || [];
  const selectedSources = sources.map((s: any) => ({
    id: s.source_id,
    source_id: s.source_id,
    source_type: s.source_type,
    kind: s.kind,
    title: s.title,
    source_url: s.source_type === 'file' ? null : (s.source_url ?? null),
    locale: s.locale ?? null,
    final_score: s.final_score,
  }));
  if (sources.length === 0) safetyNotes.push('no_eligible_knowledge_sources');

  // Excluded summary for the UI debug modal (counts of sources filtered out).
  const excludedSummary: Record<string, number> = (hybrid.retrievalDebug?.excluded_summary)
    || (hybrid.retrievalDebug?.excluded as any)
    || {};

  const enginePromptSources = sources.map((s: any) => ({
    kind: s.kind === 'qna' ? 'qna' : 'kb_article',
    id: s.source_id,
    title: s.title,
    excerpt: s.excerpt ?? null,
    content: s.content ?? null,
    slug: s.slug ?? null,
    locale: s.locale ?? null,
    score: s.final_score,
    source_type: s.source_type,
    source_url: s.source_type === 'file' ? null : (s.source_url ?? null),
    url_boost: s.url_boost,
  } as any));

  const strategy = e7_decideStrategy({
    settings,
    question: inputMessage,
    sources: enginePromptSources,
    clarificationAttemptCount: 0,
    hybridUsed: hybrid.hybridUsed,
  });

  let confidence = strategy.confidence ?? 0;
  if (sources.length === 0) confidence = Math.min(confidence, 0.25);

  const answerStrategy = {
    action: strategy.decisionType === 'handoff' ? 'handoff'
      : strategy.decisionType === 'ask_clarifying_question' ? 'clarification'
      : strategy.decisionType === 'no_answer_silent' ? 'no_answer'
      : 'answer',
    decision_type: strategy.decisionType,
    reason: strategy.reason,
    retrieval_strength: strategy.retrievalStrength,
    top_score: strategy.topScore,
    handoff_required: strategy.handoffRequired,
    source_types_used: strategy.sourceTypesUsed,
  };

  // Build prompts. Append operator assist framing + recent conversation.
  const baseSystem = e7_buildSystemPrompt(settings, responseLocale, {
    responseLanguage: responseLocale,
    inputLanguage: responseLocale,
  });
  const operatorFraming = [
    '',
    'OPERATOR-ASSIST MODE:',
    '- You are drafting a reply that a HUMAN support operator will review before sending.',
    '- Write the reply text directly, in the response language. No preamble like "Here is a draft".',
    '- Never expose internal storage paths, signed URLs, tokens, or credentials. Cite sources only by title if needed.',
    '- If the sources do not support a fact, do not invent it; suggest collecting more info instead.',
    tone ? `- Operator-selected tone: ${tone}. ${TONE_HINTS[tone] || ''}` : '',
    instruction ? `- Operator instruction: ${instruction}` : '',
    sources.length === 0
      ? '- No eligible knowledge source was found. Draft only from the conversation context. Do not state product, pricing, policy, technical, or legal facts unless they are explicitly present in the conversation.'
      : '',
  ].filter(Boolean).join('\n');
  const systemPrompt = `${baseSystem}\n${operatorFraming}`;

  const baseUser = e7_buildUserPrompt(inputMessage, enginePromptSources, {
    decisionType: strategy.decisionType,
    clarificationHint: strategy.clarificationHint,
    safeGuidanceTopic: strategy.safeGuidanceTopic,
  });
  const userPrompt = `${baseUser}\n\nRecent conversation (for context, do not quote verbatim):\n${tailContext}`;

  const promptPreview = (auth.isAdmin || auth.role === 'owner' || auth.role === 'admin')
    ? {
        system: e7_redactString(systemPrompt) || '',
        user: e7_redactString(userPrompt) || '',
      }
    : undefined;

  const baseResponse = {
    ok: true,
    assist_run_id: null as string | null,
    suggestion: null as string | null,
    confidence,
    tone: tone ?? null,
    provider: null as string | null,
    model: null as string | null,
    selected_sources: e7_redactDeep(selectedSources),
    retrieval_debug: e7_redactDeep(hybrid.retrievalDebug),
    answer_strategy: e7_redactDeep(answerStrategy),
    safety_notes: safetyNotes,
    excluded_summary: excludedSummary,
    prompt_preview: promptPreview,
  };

  if (!callLLM) {
    baseResponse.safety_notes = ['llm_call_skipped', ...safetyNotes];
    const runId = await e7PersistAssistRun(config, {
      workspaceId, conversationId, requestedBy: auth.userId,
      status: 'skipped', inputMessage, instruction: instruction ?? null, tone: tone ?? null,
      suggestion: null, confidence, selectedSources, retrievalDebug: hybrid.retrievalDebug,
      answerStrategy, safetyNotes: baseResponse.safety_notes,
      provider: null, model: null, error: null,
    });
    baseResponse.assist_run_id = runId;
    return res.json(baseResponse);
  }

  const aiCfg = await e7_resolveAIConfig(config, workspaceId);
  if (!aiCfg) {
    const notes = ['ai_provider_not_configured', ...safetyNotes];
    const runId = await e7PersistAssistRun(config, {
      workspaceId, conversationId, requestedBy: auth.userId,
      status: 'failed', inputMessage, instruction: instruction ?? null, tone: tone ?? null,
      suggestion: null, confidence, selectedSources, retrievalDebug: hybrid.retrievalDebug,
      answerStrategy, safetyNotes: notes,
      provider: null, model: null, error: 'ai_provider_not_configured',
    });
    return res.status(400).json({ error: 'ai_provider_not_configured', assist_run_id: runId });
  }

  try {
    const result = await e7_executeAICompletion(config, {
      workspaceId,
      prompt: userPrompt,
      systemPrompt,
      maxTokens: tone === 'detailed' ? 800 : tone === 'short' ? 250 : 500,
      temperature: settings.answer_guidance === 'creative' ? 0.6
        : settings.answer_guidance === 'balanced' ? 0.4 : 0.25,
    });
    const suggestion = (result.text || '').trim() || null;
    // Increment usage only after a non-empty successful suggestion.
    if (suggestion) {
      try {
        const { error: usageErr } = await sb.rpc('increment_usage_counter', {
          _workspace_id: workspaceId,
          _counter_name: 'ai_operator_suggestions',
          _amount: 1,
        });
        if (usageErr) {
          console.error('[ai-agent.e7] usage increment failed:', usageErr.message);
          safetyNotes.push('usage_increment_failed');
        }
      } catch (uerr: any) {
        console.error('[ai-agent.e7] usage increment exception:', uerr?.message);
        safetyNotes.push('usage_increment_failed');
      }
    }

    const out = {
      ...baseResponse,
      suggestion,
      safety_notes: safetyNotes,
      provider: result.provider,
      model: result.model,
    };
    const runId = await e7PersistAssistRun(config, {
      workspaceId, conversationId, requestedBy: auth.userId,
      status: suggestion ? 'suggested' : 'failed', inputMessage,
      instruction: instruction ?? null, tone: tone ?? null,
      suggestion, confidence, selectedSources, retrievalDebug: hybrid.retrievalDebug,
      answerStrategy, safetyNotes,
      provider: result.provider, model: result.model,
      error: suggestion ? null : 'empty_completion',
    });
    out.assist_run_id = runId;
    return res.json(out);
  } catch (err: any) {
    const notes = [`llm_error:${err?.message || 'unknown'}`, ...safetyNotes];
    await e7PersistAssistRun(config, {
      workspaceId, conversationId, requestedBy: auth.userId,
      status: 'failed', inputMessage, instruction: instruction ?? null, tone: tone ?? null,
      suggestion: null, confidence, selectedSources, retrievalDebug: hybrid.retrievalDebug,
      answerStrategy, safetyNotes: notes,
      provider: aiCfg.provider, model: aiCfg.model,
      error: err?.message || 'llm_failed',
    });
    return res.status(502).json({ error: 'llm_failed', details: err?.message });
  }
});

// ─────────────────────────────────────────────────────────────────────
// Pass E8 — Operator AI Assist feedback + analytics
//   - feedback: persisted to ai_operator_assist_feedback
//   - never auto-sends, never writes conversation_messages, no workflows
//   - analytics is workspace-scoped and redacts source URLs
// ─────────────────────────────────────────────────────────────────────

const E8_FEEDBACK_REASONS = [
  'helpful','wrong_answer','missing_context','bad_tone',
  'too_long','too_short','unsafe','not_grounded','other',
] as const;
const E8_FEEDBACK_ACTIONS = [
  'inserted','replaced','appended','copied','dismissed','regenerated','sent_after_edit','sent_as_is',
] as const;

const e8FeedbackSchema = z.object({
  rating: z.enum(['positive','negative','neutral']),
  reason: z.enum(E8_FEEDBACK_REASONS).optional().nullable(),
  comment: z.string().max(2000).optional().nullable(),
  operatorAction: z.enum(E8_FEEDBACK_ACTIONS).optional().nullable(),
  finalComposerText: z.string().max(8000).optional().nullable(),
  metadata: z.record(z.any()).optional(),
});

operatorAssistRouter.post('/operator-assist/:runId/feedback', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const runId = String(req.params.runId || '');
  if (!/^[0-9a-f-]{36}$/i.test(runId)) {
    return res.status(400).json({ error: 'invalid_run_id' });
  }
  const parsed = e8FeedbackSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { rating, reason, comment, operatorAction, finalComposerText, metadata } = parsed.data;

  const sb = getServiceClient(config);
  const { data: run, error: runErr } = await sb
    .from('ai_operator_assist_runs')
    .select('id, workspace_id, conversation_id')
    .eq('id', runId)
    .maybeSingle();
  if (runErr || !run) return res.status(404).json({ error: 'assist_run_not_found' });

  const auth = await authorizeMember(req, res, config, run.workspace_id);
  if (!auth) return;
  if (!e7_isOperator(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'operator_permission_required' });
  }

  // Dedupe identical operator action within 3s from same user.
  if (operatorAction) {
    const cutoff = new Date(Date.now() - 3_000).toISOString();
    const { data: dup } = await sb
      .from('ai_operator_assist_feedback')
      .select('id')
      .eq('assist_run_id', runId)
      .eq('submitted_by', auth.userId)
      .eq('operator_action', operatorAction)
      .gte('created_at', cutoff)
      .limit(1);
    if (dup && dup.length > 0) {
      return res.json({ ok: true, feedback: { id: dup[0].id, deduped: true } });
    }
  }

  const safeComment = (comment || '').slice(0, 2000) || null;
  const safeFinal = finalComposerText
    ? (e7_redactString(finalComposerText.slice(0, 8000)) || null)
    : null;
  const safeMeta = e7_redactDeep(metadata || {}) || {};

  const { data: inserted, error: insErr } = await sb
    .from('ai_operator_assist_feedback')
    .insert({
      workspace_id: run.workspace_id,
      assist_run_id: run.id,
      conversation_id: run.conversation_id,
      submitted_by: auth.userId,
      rating,
      reason: reason || null,
      comment: safeComment,
      operator_action: operatorAction || null,
      final_composer_text: safeFinal,
      metadata: safeMeta,
    })
    .select('*')
    .maybeSingle();
  if (insErr) {
    console.error('[ai-agent.e8] feedback insert failed:', insErr.message);
    return res.status(500).json({ error: 'feedback_insert_failed', details: insErr.message });
  }
  return res.json({ ok: true, feedback: inserted });
});

function e8RangeToDays(range: string | undefined): number {
  if (range === '90d') return 90;
  if (range === '30d') return 30;
  return 7;
}

operatorAssistRouter.get('/operator-assist/analytics', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = String(req.query.workspaceId || '');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) {
    return res.status(400).json({ error: 'invalid_workspace' });
  }
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!e7_isOperator(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'operator_permission_required' });
  }

  const days = e8RangeToDays(String(req.query.range || '7d'));
  const since = new Date(Date.now() - days * 86_400_000).toISOString();
  const sb = getServiceClient(config);

  const [runsRes, fbRes] = await Promise.all([
    sb.from('ai_operator_assist_runs')
      .select('id, created_at, status, confidence, suggestion, selected_sources, safety_notes')
      .eq('workspace_id', workspaceId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(2000),
    sb.from('ai_operator_assist_feedback')
      .select('id, assist_run_id, rating, reason, operator_action, created_at')
      .eq('workspace_id', workspaceId)
      .gte('created_at', since)
      .order('created_at', { ascending: false })
      .limit(5000),
  ]);
  if (runsRes.error) return res.status(500).json({ error: 'analytics_runs_failed', details: runsRes.error.message });
  if (fbRes.error) return res.status(500).json({ error: 'analytics_feedback_failed', details: fbRes.error.message });

  const runs = runsRes.data || [];
  const feedback = fbRes.data || [];

  const total_suggestions = runs.length;
  let positive = 0, negative = 0, neutral = 0;
  const by_reason_map: Record<string, number> = {};
  const by_action_map: Record<string, number> = {};
  const ACCEPT_ACTIONS = new Set(['inserted','replaced','appended','copied','sent_after_edit','sent_as_is']);
  let acceptedRuns = new Set<string>();
  for (const f of feedback) {
    if (f.rating === 'positive') positive++;
    else if (f.rating === 'negative') negative++;
    else if (f.rating === 'neutral') neutral++;
    if (f.reason) by_reason_map[f.reason] = (by_reason_map[f.reason] || 0) + 1;
    if (f.operator_action) {
      by_action_map[f.operator_action] = (by_action_map[f.operator_action] || 0) + 1;
      if (ACCEPT_ACTIONS.has(f.operator_action)) acceptedRuns.add(f.assist_run_id);
    }
  }
  const total_feedback = feedback.length;

  let confSum = 0, confN = 0;
  let no_source_count = 0;
  let usage_increment_failed_count = 0;
  const sourceTypeAgg: Record<string, { runs: number }> = {};
  for (const r of runs) {
    if (typeof r.confidence === 'number') { confSum += r.confidence; confN++; }
    const notes: string[] = Array.isArray(r.safety_notes) ? r.safety_notes : [];
    if (notes.includes('no_eligible_knowledge_sources')) {
      no_source_count++;
      sourceTypeAgg['no_source'] = { runs: (sourceTypeAgg['no_source']?.runs || 0) + 1 };
    }
    if (notes.includes('usage_increment_failed')) usage_increment_failed_count++;
    const sources: any[] = Array.isArray(r.selected_sources) ? r.selected_sources : [];
    const seen = new Set<string>();
    for (const s of sources) {
      const t = String(s?.source_type || 'unknown');
      if (seen.has(t)) continue;
      seen.add(t);
      sourceTypeAgg[t] = { runs: (sourceTypeAgg[t]?.runs || 0) + 1 };
    }
  }

  const avg_confidence = confN > 0 ? confSum / confN : 0;
  const acceptance_rate = total_suggestions > 0 ? acceptedRuns.size / total_suggestions : 0;
  const negative_rate = total_feedback > 0 ? negative / total_feedback : 0;

  // by_day buckets (UTC date).
  const dayMap: Record<string, { suggestions: number; positive: number; negative: number; neutral: number }> = {};
  for (const r of runs) {
    const d = String(r.created_at).slice(0, 10);
    dayMap[d] = dayMap[d] || { suggestions: 0, positive: 0, negative: 0, neutral: 0 };
    dayMap[d].suggestions++;
  }
  for (const f of feedback) {
    const d = String(f.created_at).slice(0, 10);
    dayMap[d] = dayMap[d] || { suggestions: 0, positive: 0, negative: 0, neutral: 0 };
    if (f.rating === 'positive') dayMap[d].positive++;
    else if (f.rating === 'negative') dayMap[d].negative++;
    else if (f.rating === 'neutral') dayMap[d].neutral++;
  }
  const by_day = Object.entries(dayMap)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([day, v]) => ({ day, ...v }));

  // Worst runs: latest negative-rated runs (or low confidence + negative action), redacted.
  // E9: include latest negative `feedback_id` per run so the UI can hand it to
  // POST /suggested-test-cases/from-feedback/:feedbackId.
  const negFeedbackByRun = new Map<string, { reason: string | null; comment_present: boolean; feedback_id: string }>();
  for (const f of feedback) {
    if (f.rating === 'negative' && !negFeedbackByRun.has(f.assist_run_id)) {
      negFeedbackByRun.set(f.assist_run_id, { reason: f.reason || null, comment_present: false, feedback_id: f.id });
    }
  }
  const worst_runs = runs
    .filter((r) => negFeedbackByRun.has(r.id))
    .slice(0, 25)
    .map((r) => {
      const notes: string[] = Array.isArray(r.safety_notes) ? r.safety_notes : [];
      const sources: any[] = Array.isArray(r.selected_sources) ? r.selected_sources : [];
      const fb = negFeedbackByRun.get(r.id);
      return {
        run_id: r.id,
        feedback_id: fb?.feedback_id || null,
        created_at: r.created_at,
        confidence: r.confidence,
        rating: 'negative' as const,
        reason: fb?.reason || null,
        source_types: Array.from(new Set(sources.map((s) => s?.source_type).filter(Boolean))),
        safety_notes: notes,
        suggestion_preview: e7_redactString((r.suggestion || '').slice(0, 240)) || null,
      };
    });

  return res.json({
    range: `${days}d`,
    summary: {
      total_suggestions,
      total_feedback,
      positive,
      negative,
      neutral,
      acceptance_rate,
      negative_rate,
      avg_confidence,
      no_source_count,
      usage_increment_failed_count,
    },
    by_reason: Object.entries(by_reason_map).map(([reason, count]) => ({ reason, count })),
    by_action: Object.entries(by_action_map).map(([action, count]) => ({ action, count })),
    by_source_type: Object.entries(sourceTypeAgg).map(([source_type, v]) => ({ source_type, runs: v.runs })),
    by_day,
    worst_runs,
  });
});
