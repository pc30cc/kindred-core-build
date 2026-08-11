/**
 * AI Agent router — activity domain.
 *
 * Mechanically extracted from the original server/routes/aiAgent.ts (Phase 3
 * router split). Route paths, middleware order, auth, validation, rate
 * limits and response shapes are unchanged from the original file.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { routeParam } from '../../lib/routeParams.js';
import { listRuns, listRunsPaged, summarize } from '../../services/ai-agent/logs.js';
import { markHumanTakeover } from '../../services/ai-agent/handoffState.js';
import { authorizeMember, isOwnerOrAdmin, requireWorkspace, redactDeep } from './shared.js';

export const activityRouter: Router = express.Router();


// ─── GET /runs ───
activityRouter.get('/runs', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const limit = parseInt(String(req.query.limit || '50'), 10);
  const hasPaging = req.query.page !== undefined || req.query.pageSize !== undefined
    || req.query.search !== undefined || req.query.filter !== undefined;
  if (hasPaging) {
    const result = await listRunsPaged(config, workspaceId, {
      page: parseInt(String(req.query.page || '1'), 10) || 1,
      pageSize: parseInt(String(req.query.pageSize || '20'), 10) || 20,
      search: req.query.search ? String(req.query.search) : undefined,
      filter: req.query.filter ? String(req.query.filter) : undefined,
    });
    return res.json(result);
  }
  const runs = await listRuns(config, workspaceId, { limit });
  return res.json({ runs });
});

// ─── E5 — Answer Inspector ───
// GET /runs/:id/inspect — returns redacted, observable run details.
// Strips storage paths, signed URLs, credentials, tokens. File source URLs are null.
// redactDeep is shared with the internal-qa domain's /debug/retrieval route
// (see shared.ts); truncate is only used here.
function truncate(s: any, n: number): any {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

activityRouter.get('/runs/:id/inspect', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: run, error } = await sb.from('ai_agent_runs').select('*').eq('id', req.params.id).maybeSingle();
  if (error || !run) return res.status(404).json({ error: 'run_not_found' });
  const auth = await authorizeMember(req, res, config, run.workspace_id);
  if (!auth) return;

  const meta: any = run.metadata || {};
  const retrieval = meta.retrieval || {};
  const retrievalDebug = retrieval.retrieval_debug || null;
  const answerStrategy = meta.answer_strategy || null;
  const pageContext = meta.page_context || retrieval.page_context || null;

  // Conversation + visitor/AI message context (best-effort).
  let conversation: any = null;
  let visitorMessage: any = null;
  let aiMessage: any = null;
  if (run.conversation_id) {
    const { data: c } = await sb.from('conversations').select('id, status, channel, locale, created_at').eq('id', run.conversation_id).maybeSingle();
    conversation = c || null;
    if (run.visitor_message_id) {
      const { data: vm } = await sb.from('conversation_messages').select('id, body, created_at, sender_type').eq('id', run.visitor_message_id).maybeSingle();
      visitorMessage = vm ? { id: vm.id, body: truncate(vm.body, 4000), sender_type: (vm as any).sender_type, created_at: vm.created_at } : null;
    }
    const { data: am } = await sb.from('conversation_messages')
      .select('id, body, created_at, sender_type, metadata')
      .eq('conversation_id', run.conversation_id)
      .gte('created_at', run.created_at)
      .order('created_at', { ascending: true })
      .limit(5);
    const found = (am || []).find((m: any) => m?.metadata?.run_id === run.id || m?.metadata?.runId === run.id);
    if (found) aiMessage = { id: found.id, body: truncate(found.body, 4000), sender_type: (found as any).sender_type, created_at: found.created_at };
  }

  const promptPreview = meta.prompt_preview
    ? { system: truncate(meta.prompt_preview.system, 2000), user: truncate(meta.prompt_preview.user, 4000) }
    : null;

  const safetyNotes: string[] = [];
  const exc = retrieval.excluded_sources_summary || retrievalDebug?.excluded_sources_summary;
  if (exc) {
    if (exc.disabled_qna_excluded) safetyNotes.push(`disabled_qna_excluded=${exc.disabled_qna_excluded}`);
    if (exc.draft_kb_excluded) safetyNotes.push(`draft_kb_excluded=${exc.draft_kb_excluded}`);
    if (exc.inactive_file_excluded) safetyNotes.push(`inactive_file_excluded=${exc.inactive_file_excluded}`);
    if (exc.inactive_web_page_excluded) safetyNotes.push(`inactive_web_page_excluded=${exc.inactive_web_page_excluded}`);
    if (exc.unapproved_learned_qna_excluded) safetyNotes.push(`unapproved_learned_qna_excluded=${exc.unapproved_learned_qna_excluded}`);
  }

  // Best-effort observability event.
  try {
    await sb.from('ai_agent_debug_events').insert({
      workspace_id: run.workspace_id,
      run_id: run.id,
      event_type: 'answer_inspected',
      actor_user_id: auth.userId,
      metadata: { },
    });
  } catch { /* noop */ }

  return res.json(redactDeep({
    run: {
      id: run.id,
      workspace_id: run.workspace_id,
      conversation_id: run.conversation_id,
      run_type: run.run_type,
      mode: run.mode,
      status: run.status,
      input_text: truncate(run.input_text, 4000),
      output_text: truncate(run.output_text, 4000),
      confidence: run.confidence,
      provider: run.provider,
      model: run.model,
      created_at: run.created_at,
    },
    conversation,
    visitor_message: visitorMessage,
    ai_message: aiMessage,
    retrieval_debug: retrievalDebug,
    answer_strategy: answerStrategy,
    page_context: pageContext,
    selected_sources: retrievalDebug?.selected_sources || retrieval.selected_sources || [],
    prompt_preview: promptPreview,
    decision_timeline: meta.decision_timeline || [],
    safety_notes: safetyNotes,
  }));
});

// ─── GET /analytics ───
activityRouter.get('/analytics', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const summary = await summarize(config, workspaceId);
  return res.json(summary);
});

// ─────────────────────────────────────────────────────────────────────
// Phase 2 — Operator-facing suggestion endpoints
//
// GET    /api/ai-agent/conversations/:conversationId/suggestions
// POST   /api/ai-agent/suggestions/:id/use
// POST   /api/ai-agent/suggestions/:id/dismiss
//
// Authorization: caller must be a workspace member (or global admin) of
// the conversation's workspace. RLS already restricts SELECT for clients,
// but mutations go through the service role + this middleware.
// ─────────────────────────────────────────────────────────────────────

async function authorizeSuggestion(
  req: Request,
  res: Response,
  config: ServerConfig,
  suggestionId: string,
): Promise<{ workspaceId: string; userId: string; isAdmin: boolean; row: any } | null> {
  const sb = getServiceClient(config);
  const { data: row, error } = await sb
    .from('ai_agent_suggestions')
    .select('id, workspace_id, conversation_id, status, suggested_reply, source_article_ids, confidence, visitor_message_id, created_at')
    .eq('id', suggestionId)
    .maybeSingle();
  if (error || !row) {
    res.status(404).json({ error: 'suggestion_not_found' });
    return null;
  }
  const auth = await authorizeMember(req, res, config, row.workspace_id);
  if (!auth) return null;
  return { workspaceId: row.workspace_id, userId: auth.userId, isAdmin: auth.isAdmin, row };
}

activityRouter.get('/conversations/:conversationId/suggestions', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const conversationId = req.params.conversationId;
  const sb = getServiceClient(config);
  const { data: conv } = await sb
    .from('conversations')
    .select('workspace_id')
    .eq('id', conversationId)
    .maybeSingle();
  if (!conv) return res.status(404).json({ error: 'conversation_not_found' });
  const auth = await authorizeMember(req, res, config, conv.workspace_id);
  if (!auth) return;

  const status = String(req.query.status || 'pending');
  let q = sb
    .from('ai_agent_suggestions')
    .select('id, conversation_id, visitor_message_id, suggested_reply, source_article_ids, confidence, status, created_at, updated_at')
    .eq('workspace_id', conv.workspace_id)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: false })
    .limit(20);
  if (status !== 'all') q = q.eq('status', status);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });

  // Resolve source article titles/slugs (best-effort). Skip if none.
  const articleIds = Array.from(
    new Set((data || []).flatMap((r) => (r.source_article_ids as string[] | null) || [])),
  );
  let articleMap: Record<string, { id: string; title: string; slug: string | null; locale: string | null }> = {};
  if (articleIds.length > 0) {
    const { data: arts } = await sb
      .from('knowledge_base_articles')
      .select('id, title, slug, locale')
      .in('id', articleIds);
    for (const a of arts || []) {
      articleMap[a.id as string] = {
        id: a.id as string,
        title: (a.title as string) || '',
        slug: (a.slug as string) || null,
        locale: (a.locale as string) || null,
      };
    }
  }

  const items = (data || []).map((r) => ({
    ...r,
    sources: ((r.source_article_ids as string[] | null) || [])
      .map((id) => articleMap[id])
      .filter(Boolean),
  }));
  return res.json({ items });
});

activityRouter.post('/suggestions/:id/use', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const suggestionId = routeParam(req.params.id);
  if (!suggestionId) return res.status(400).json({ error: 'invalid_params' });
  const ctx = await authorizeSuggestion(req, res, config, suggestionId);
  if (!ctx) return;
  if (ctx.row.status !== 'pending') {
    return res.status(409).json({ error: 'suggestion_not_pending', status: ctx.row.status });
  }
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_suggestions')
    .update({ status: 'used' })
    .eq('id', req.params.id)
    .eq('status', 'pending') // race-safe
    .select('id, status, conversation_id, workspace_id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(409).json({ error: 'suggestion_not_pending' });

  // Realtime echo so other open operator sessions remove the card.
  try {
    const { publishOperatorEvent } = await import('../../services/realtime/publish.js');
    await publishOperatorEvent(config, {
      kind: 'ai_suggestion_updated' as any,
      conversation_id: data.conversation_id as string,
      workspace_id: data.workspace_id as string,
      actor_id: ctx.userId,
      suggestion_id: data.id as string,
      status: 'used',
    }, { skipInboxChannel: true });
  } catch { /* best-effort */ }

  return res.json({ ok: true, suggestion: data });
});

activityRouter.post('/suggestions/:id/dismiss', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const suggestionId = routeParam(req.params.id);
  if (!suggestionId) return res.status(400).json({ error: 'invalid_params' });
  const ctx = await authorizeSuggestion(req, res, config, suggestionId);
  if (!ctx) return;
  if (ctx.row.status !== 'pending') {
    return res.status(409).json({ error: 'suggestion_not_pending', status: ctx.row.status });
  }
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_suggestions')
    .update({ status: 'dismissed' })
    .eq('id', req.params.id)
    .eq('status', 'pending')
    .select('id, status, conversation_id, workspace_id')
    .maybeSingle();
  if (error) return res.status(500).json({ error: error.message });
  if (!data) return res.status(409).json({ error: 'suggestion_not_pending' });

  try {
    const { publishOperatorEvent } = await import('../../services/realtime/publish.js');
    await publishOperatorEvent(config, {
      kind: 'ai_suggestion_updated' as any,
      conversation_id: data.conversation_id as string,
      workspace_id: data.workspace_id as string,
      actor_id: ctx.userId,
      suggestion_id: data.id as string,
      status: 'dismissed',
    }, { skipInboxChannel: true });
  } catch { /* best-effort */ }

  return res.json({ ok: true, suggestion: data });
});

// ─── POST /api/ai-agent/conversations/:conversationId/take-over ─────
// Manual operator takeover. Removes the conversation from the Automated
// inbox, marks `ai_state='human_active'`, optionally assigns to caller,
// and stops further AI auto-replies.
const takeOverSchema = z.object({
  workspaceId: z.string().uuid(),
  assign_to_me: z.boolean().optional().default(true),
});
activityRouter.post(
  '/conversations/:conversationId/take-over',
  async (req: Request, res: Response) => {
    const config = (req as any).serverConfig as ServerConfig;
    const conversationId = routeParam(req.params.conversationId);
    if (!conversationId) return res.status(400).json({ error: 'invalid_params' });
    const parsed = takeOverSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
    const { workspaceId, assign_to_me } = parsed.data;

    const sb = getServiceClient(config);
    const { data: conv } = await sb
      .from('conversations')
      .select('id, workspace_id, assigned_to')
      .eq('id', conversationId)
      .maybeSingle();
    if (!conv || conv.workspace_id !== workspaceId) {
      return res.status(404).json({ error: 'conversation_not_found' });
    }
    const auth = await authorizeMember(req, res, config, workspaceId);
    if (!auth) return;

    if (assign_to_me && !conv.assigned_to) {
      await sb
        .from('conversations')
        .update({ assigned_to: auth.userId })
        .eq('id', conversationId);
    }
    await markHumanTakeover(config, {
      workspaceId,
      conversationId,
      operatorId: auth.userId,
      reason: 'manual_takeover',
    });
    return res.json({ ok: true });
  },
);
