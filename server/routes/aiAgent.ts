/**
 * AI Agent — Phase 1 routes.
 *
 * Self-host. All work runs in this Express server. NO edge functions.
 * Phase 1 wires Settings, Knowledge status, Playground, Diagnostics,
 * Analytics, Q&A CRUD. Real auto-reply integration is Phase 2.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';
import { checkModuleAccess } from '../middleware/featureGating.js';
import {
  getOrCreateSettings,
  updateSettings,
  type AgentSettings,
} from '../services/ai-agent/settings.js';
import { getKnowledgeStatus } from '../services/ai-agent/retrieval.js';
import { runPlayground } from '../services/ai-agent/playground.js';
import { listRuns, summarize } from '../services/ai-agent/logs.js';
import { resolveAIConfig } from '../services/ai/index.js';
import { getOperatorAvailability } from '../services/ai-agent/availability.js';

export const aiAgentRouter: Router = express.Router();

// ─── Phase 1 in-memory rate limit for playground tests ───
// 30 tests / 5 min per (workspace,user). Documented as temporary safeguard
// until usage-metering for playground is wired up in Phase 2.
const playgroundCounters = new Map<string, { count: number; windowStart: number }>();
const PLAYGROUND_LIMIT = 30;
const PLAYGROUND_WINDOW = 5 * 60_000;
function checkPlaygroundRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`;
  const now = Date.now();
  const c = playgroundCounters.get(key);
  if (!c || now - c.windowStart > PLAYGROUND_WINDOW) {
    playgroundCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  c.count += 1;
  return c.count <= PLAYGROUND_LIMIT;
}

// ─── Auth: workspace member (or global admin) ───
async function authorizeMember(
  req: Request,
  res: Response,
  config: ServerConfig,
  workspaceId: string,
): Promise<{ userId: string; isAdmin: boolean; role: string | null } | null> {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing authorization' });
    return null;
  }
  const token = authHeader.replace('Bearer ', '');
  const sb = getServiceClient(config);
  const { data: { user }, error } = await sb.auth.getUser(token);
  if (error || !user) {
    res.status(401).json({ error: 'Invalid token' });
    return null;
  }
  const isAdmin = await isGlobalAdmin(config, user.id);
  let role: string | null = null;
  if (!isAdmin) {
    const { data: isMember } = await sb.rpc('is_workspace_member', {
      _workspace_id: workspaceId,
      _user_id: user.id,
    });
    if (!isMember) {
      res.status(403).json({ error: 'Not a workspace member' });
      return null;
    }
    const { data: member } = await sb
      .from('workspace_members')
      .select('role')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle();
    role = (member?.role as string) || null;
  }
  return { userId: user.id, isAdmin, role };
}

function isOwnerOrAdmin(role: string | null, isGlobalAdmin: boolean): boolean {
  if (isGlobalAdmin) return true;
  return role === 'owner' || role === 'admin';
}

function requireWorkspace(req: Request): string | null {
  return String(
    req.query.workspaceId || req.query.workspace_id || (req.body && req.body.workspaceId) || '',
  ) || null;
}

// ─── GET /settings ───
aiAgentRouter.get('/settings', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const settings = await getOrCreateSettings(config, workspaceId);
  return res.json({ settings });
});

// ─── PUT /settings ───
const updateSchema = z.object({
  workspaceId: z.string().uuid(),
  enabled: z.boolean().optional(),
  agent_name: z.string().min(1).max(120).optional(),
  agent_logo_url: z.string().url().nullable().optional(),
  business_description: z.string().max(2000).nullable().optional(),
  answer_guidance: z.enum(['conservative','balanced','creative']).optional(),
  mode: z.enum(['off','suggest_only','auto_reply_when_offline','auto_reply_until_human_joins','auto_reply_always']).optional(),
  answer_only_from_kb: z.boolean().optional(),
  welcome_message: z.string().max(500).nullable().optional(),
  fallback_message: z.string().max(500).optional(),
  handoff_keywords: z.array(z.string().max(100)).max(50).optional(),
  max_replies_per_conversation: z.number().int().min(0).max(100).optional(),
  max_replies_per_hour: z.number().int().min(0).max(1000).optional(),
  allowed_locales: z.array(z.string().max(10)).max(20).optional(),
  show_sources_to_operator: z.boolean().optional(),
  show_sources_to_visitor: z.boolean().optional(),
  handoff_on_low_confidence: z.boolean().optional(),
  handoff_on_human_request: z.boolean().optional(),
  handoff_when_no_kb_match: z.boolean().optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  instructions: z.object({
    tone: z.string().max(200).optional(),
    custom_instructions: z.string().max(2000).optional(),
    forbidden_topics: z.array(z.string().max(120)).max(40).optional(),
    escalation_instructions: z.string().max(1000).optional(),
    max_answer_length: z.enum(['short','medium','long']).optional(),
  }).optional(),
  ai_intro_enabled: z.boolean().optional(),
  intro_message: z.string().max(1000).nullable().optional(),
  fallback_behavior: z.enum(['handoff','silent']).optional(),
  stop_on_handoff: z.boolean().optional(),
});

aiAgentRouter.put('/settings', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, ...patch } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }

  // Activation gate: enabling requires AI provider + (if KB-only) at least 1 article.
  if (patch.enabled === true) {
    // Module gate: ai_assistant must be on the workspace plan
    // (or the operator must be a global admin — bypass mirrors existing pattern).
    if (!auth.isAdmin) {
      const mod = await checkModuleAccess(
        config.supabaseUrl,
        config.supabaseServiceRoleKey,
        workspaceId,
        'ai_assistant',
      );
      if (!mod.allowed) {
        return res.status(409).json({
          error: 'module_ai_assistant_not_enabled',
          plan: mod.plan,
          upgrade_required: true,
        });
      }
    }
    const ai = await resolveAIConfig(config, workspaceId);
    if (!ai) {
      return res.status(409).json({ error: 'ai_provider_not_configured' });
    }
    const settings = await getOrCreateSettings(config, workspaceId);
    const enforceKb = patch.answer_only_from_kb ?? settings.answer_only_from_kb;
    if (enforceKb) {
      const ks = await getKnowledgeStatus(config, workspaceId);
      if (!ks.has_any) {
        return res.status(409).json({ error: 'no_published_knowledge' });
      }
    }
  }

  try {
    const updated = await updateSettings(config, workspaceId, patch as Partial<AgentSettings>);
    return res.json({ settings: updated });
  } catch (err: any) {
    return res.status(500).json({ error: 'update_failed', details: err?.message });
  }
});

// ─── GET /knowledge-status ───
aiAgentRouter.get('/knowledge-status', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const status = await getKnowledgeStatus(config, workspaceId);
  return res.json(status);
});

// ─── GET /diagnostics ───
aiAgentRouter.get('/diagnostics', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  const [settings, ai, ks, mod] = await Promise.all([
    getOrCreateSettings(config, workspaceId),
    resolveAIConfig(config, workspaceId),
    getKnowledgeStatus(config, workspaceId),
    checkModuleAccess(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'ai_assistant'),
  ]);

  const checks = {
    ai_provider_configured: !!ai,
    has_knowledge: ks.has_any,
    module_enabled: mod.allowed || auth.isAdmin,
    settings_enabled: settings.enabled,
    mode: settings.mode,
  };
  const ready = checks.ai_provider_configured && checks.has_knowledge && checks.module_enabled;
  const recentRuns = await listRuns(config, workspaceId, { limit: 5 }).catch(() => []);
  const availability = await getOperatorAvailability(config, workspaceId, 'en').catch(() => null);
  return res.json({
    ready,
    checks,
    provider: ai ? { name: ai.provider, model: ai.model } : null,
    knowledge: ks,
    is_global_admin: auth.isAdmin,
    role: auth.role,
    auto_modes_supported: true,
    intro_enabled: (settings as any).ai_intro_enabled !== false,
    operator_availability: availability,
    reply_limits: {
      per_conversation: settings.max_replies_per_conversation,
      per_hour: settings.max_replies_per_hour,
      fallback_behavior: (settings as any).fallback_behavior || 'handoff',
      stop_on_handoff: (settings as any).stop_on_handoff !== false,
    },
    recent_runs: recentRuns,
  });
});

// ─── POST /playground/test ───
const playgroundSchema = z.object({
  workspaceId: z.string().uuid(),
  question: z.string().min(1).max(2000),
  locale: z.string().max(10).optional(),
  guidanceOverride: z.enum(['conservative','balanced','creative']).optional(),
  modelOverride: z.string().max(100).optional(),
});

aiAgentRouter.post('/playground/test', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = playgroundSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, question, locale, guidanceOverride, modelOverride } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;

  if (!checkPlaygroundRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({
      error: 'playground_rate_limited',
      message: `Limit ${PLAYGROUND_LIMIT} tests per 5 minutes per user.`,
    });
  }

  try {
    const result = await runPlayground(config, {
      workspaceId,
      question,
      locale: locale || 'en',
      guidanceOverride,
      modelOverride,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'playground_failed', details: err?.message });
  }
});

// ─── GET /runs ───
aiAgentRouter.get('/runs', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const limit = parseInt(String(req.query.limit || '50'), 10);
  const runs = await listRuns(config, workspaceId, { limit });
  return res.json({ runs });
});

// ─── GET /analytics ───
aiAgentRouter.get('/analytics', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const summary = await summarize(config, workspaceId);
  return res.json(summary);
});

// ─── Q&A CRUD ───
aiAgentRouter.get('/qna', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_qna')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

const qnaSchema = z.object({
  workspaceId: z.string().uuid(),
  question: z.string().min(1).max(500),
  answer: z.string().min(1).max(4000),
  locale: z.string().max(10).default('en'),
  enabled: z.boolean().default(true),
});

aiAgentRouter.post('/qna', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = qnaSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, ...row } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_qna')
    .insert({ workspace_id: workspaceId, ...row })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

aiAgentRouter.patch('/qna/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_qna').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  const allowed = ['question','answer','locale','enabled'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = (req.body as any)[k];
  const { data, error } = await sb.from('ai_agent_qna').update(patch).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

aiAgentRouter.delete('/qna/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_qna').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  const { error } = await sb.from('ai_agent_qna').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ─── POST /generate-business-description ───
const genDescSchema = z.object({ workspaceId: z.string().uuid() });

aiAgentRouter.post('/generate-business-description', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = genDescSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }

  const sb = getServiceClient(config);
  const [{ data: domainRow }, { data: ws }, ks, { data: articles }] = await Promise.all([
    sb.from('workspace_domains').select('domain').eq('workspace_id', workspaceId).order('is_primary', { ascending: false }).limit(1).maybeSingle(),
    sb.from('workspaces').select('name').eq('id', workspaceId).maybeSingle(),
    getKnowledgeStatus(config, workspaceId),
    sb.from('knowledge_base_articles').select('title,excerpt').eq('workspace_id', workspaceId).eq('status','published').limit(8),
  ]);

  const domain = (domainRow?.domain as string) || '';
  const wsName = (ws?.name as string) || 'Our company';

  const ai = await resolveAIConfig(config, workspaceId);
  if (!ai) {
    // Fallback: deterministic stub, no AI required.
    const stub = `${wsName}${domain ? ` (${domain})` : ''} provides customer support for our products and services. Our knowledge base has ${ks.published} published articles. We help visitors with common questions and connect them with a human agent when needed.`;
    return res.json({ description: stub, source: 'stub' });
  }

  const { executeAICompletion } = await import('../services/ai/index.js');
  const sys = 'You write a single short business description (2–4 sentences, plain text, no markdown). Describe what the company does and how it helps its customers. Stay grounded in the provided context. Never invent pricing, legal, financial, or medical claims.';
  const ctx = [
    `Company: ${wsName}`,
    domain ? `Domain: ${domain}` : '',
    articles?.length ? `Sample knowledge titles:\n${(articles || []).map((a) => `- ${a.title}${a.excerpt ? ` — ${a.excerpt}` : ''}`).join('\n')}` : '',
  ].filter(Boolean).join('\n');
  try {
    const r = await executeAICompletion(config, {
      workspaceId,
      systemPrompt: sys,
      prompt: `Context:\n${ctx}\n\nWrite the description now.`,
      maxTokens: 220,
      temperature: 0.4,
    });
    return res.json({ description: (r.text || '').trim(), source: 'ai', provider: r.provider, model: r.model });
  } catch (err: any) {
    return res.status(500).json({ error: 'generation_failed', details: err?.message });
  }
});

// ─── GET /sources — registry placeholder ───
aiAgentRouter.get('/sources', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_sources')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('source_type');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ sources: data || [] });
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

aiAgentRouter.get('/conversations/:conversationId/suggestions', async (req: Request, res: Response) => {
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

aiAgentRouter.post('/suggestions/:id/use', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ctx = await authorizeSuggestion(req, res, config, req.params.id);
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
    const { publishOperatorEvent } = await import('../services/realtime/publish.js');
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

aiAgentRouter.post('/suggestions/:id/dismiss', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const ctx = await authorizeSuggestion(req, res, config, req.params.id);
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
    const { publishOperatorEvent } = await import('../services/realtime/publish.js');
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