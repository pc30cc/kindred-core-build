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
import { markHumanTakeover } from '../services/ai-agent/handoffState.js';
import { syncKnowledgeSource, rebuildWorkspaceIndex, getKnowledgeIndexStatus } from '../services/ai-agent/knowledgeIndex/sync.js';
import { buildTrainOverview, listChunks, rebuildSingleSource } from '../services/ai-agent/train.js';
import { detectTopics } from '../services/ai-agent/topics/detector.js';
import { DEFAULT_TOPICS } from '../services/ai-agent/topics/defaults.js';
import {
  validateWorkflow, previewWorkflow,
  ALLOWED_TRIGGERS, ALLOWED_CONDITION_TYPES, ALLOWED_ACTION_TYPES,
} from '../services/ai-agent/workflows/validate.js';
import { buildOverview, runDryRun, DEFAULT_INTERNAL_TOOLS } from '../services/ai-agent/overview.js';
import { resolveAiAgentDataLimits, countSourceJobsThisMonth } from '../services/ai-agent/limits.js';
import { enqueueSourceSyncJob, cancelSourceSyncJob } from '../services/ai-agent/sourceJobs.js';
import { processOne as processOneSourceJob, getWorkerInfo } from '../services/ai-agent/sourceWorker.js';
import { generatePendingCandidates } from '../services/ai-agent/learning/generator.js';
import { normalizeQuestion } from '../services/ai-agent/learning/normalize.js';

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
    // Pass A — extended workspace-level instruction fields
    brand_voice: z.string().max(500).optional(),
    business_description: z.string().max(2000).optional(),
    do_list: z.array(z.string().max(300)).max(40).optional(),
    dont_list: z.array(z.string().max(300)).max(40).optional(),
    handoff_instructions: z.string().max(1000).optional(),
    pricing_instructions: z.string().max(1000).optional(),
    support_instructions: z.string().max(1000).optional(),
    custom_system_instruction: z.string().max(4000).optional(),
  }).optional(),
  ai_intro_enabled: z.boolean().optional(),
  intro_message: z.string().max(1000).nullable().optional(),
  fallback_behavior: z.enum(['handoff','silent']).optional(),
  stop_on_handoff: z.boolean().optional(),
  pause_auto_reply_after_human_reply: z.boolean().optional(),
  allow_suggestions_after_takeover: z.boolean().optional(),
  keep_in_automated_until_handoff: z.boolean().optional(),
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

  // Phase 3.1 — automated inbox counts (best-effort).
  const sb = getServiceClient(config);
  let automatedCounts = {
    ai_managed: 0,
    needs_human: 0,
    human_active: 0,
    last_handoff_reason: null as string | null,
    last_human_takeover_at: null as string | null,
  };
  try {
    const states = ['ai_managed', 'needs_human', 'human_active'] as const;
    for (const s of states) {
      const { count } = await sb
        .from('conversations')
        .select('id', { count: 'exact', head: true })
        .eq('workspace_id', workspaceId)
        .eq('ai_state', s);
      (automatedCounts as any)[s] = count ?? 0;
    }
    const { data: lastHandoff } = await sb
      .from('conversations')
      .select('metadata, updated_at')
      .eq('workspace_id', workspaceId)
      .eq('ai_state', 'needs_human')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastHandoff?.metadata) {
      automatedCounts.last_handoff_reason = ((lastHandoff.metadata as any).ai_handoff_reason as string) || null;
    }
    const { data: lastTakeover } = await sb
      .from('conversations')
      .select('metadata')
      .eq('workspace_id', workspaceId)
      .eq('ai_state', 'human_active')
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (lastTakeover?.metadata) {
      automatedCounts.last_human_takeover_at = ((lastTakeover.metadata as any).human_takeover_at as string) || null;
    }
  } catch { /* best-effort */ }

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
    automated_inbox: automatedCounts,
    safety_settings: {
      pause_auto_reply_after_human_reply:
        (settings as any).pause_auto_reply_after_human_reply !== false,
      allow_suggestions_after_takeover:
        (settings as any).allow_suggestions_after_takeover !== false,
      keep_in_automated_until_handoff:
        (settings as any).keep_in_automated_until_handoff !== false,
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
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  // Trim & normalize before validation/insertion (parity with /qna/bulk).
  const trimmedQuestion = (row.question || '').trim();
  const trimmedAnswer = (row.answer || '').trim();
  const trimmedLocale = ((row.locale || 'en') + '').trim().toLowerCase().slice(0, 10) || 'en';
  if (!trimmedQuestion) return res.status(400).json({ error: 'question_required' });
  if (!trimmedAnswer) return res.status(400).json({ error: 'answer_required' });
  const sb = getServiceClient(config);
  // Dedupe by workspace + locale + normalized question.
  const normalized = normalizeQuestion(trimmedQuestion);
  if (!normalized) return res.status(400).json({ error: 'question_required' });
  const { data: existingRows } = await sb
    .from('ai_agent_qna')
    .select('id, question, locale')
    .eq('workspace_id', workspaceId)
    .eq('locale', trimmedLocale)
    .limit(2000);
  const dup = (existingRows || []).find((r: any) => normalizeQuestion(r.question || '') === normalized);
  if (dup) {
    return res.status(409).json({ error: 'duplicate_qna', existing_id: dup.id });
  }
  const { data, error } = await sb
    .from('ai_agent_qna')
    .insert({
      workspace_id: workspaceId,
      question: trimmedQuestion,
      answer: trimmedAnswer,
      locale: trimmedLocale,
      enabled: row.enabled,
    })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // Best-effort knowledge index sync.
  syncKnowledgeSource(config, { workspaceId, sourceType: 'qna', sourceId: data.id }).catch(() => {});
  return res.status(201).json({ item: data });
});

aiAgentRouter.patch('/qna/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb
    .from('ai_agent_qna')
    .select('workspace_id, enabled, question, locale')
    .eq('id', req.params.id)
    .maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const allowed = ['question','answer','locale','enabled'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = (req.body as any)[k];
  if ('answer' in patch && (!patch.answer || !String(patch.answer).trim())) {
    return res.status(400).json({ error: 'answer_required' });
  }
  if ('question' in patch && (!patch.question || !String(patch.question).trim())) {
    return res.status(400).json({ error: 'question_required' });
  }
  // Duplicate-protection: if question or locale is changing, dedupe against
  // sibling rows in same (workspace_id, locale) using normalized form.
  if ('question' in patch || 'locale' in patch) {
    const finalQuestion = ('question' in patch ? String(patch.question) : (existing as any).question) || '';
    const finalLocale = ('locale' in patch ? String(patch.locale) : ((existing as any).locale || 'en')) || 'en';
    const normalized = normalizeQuestion(finalQuestion);
    if (!normalized) return res.status(400).json({ error: 'question_required' });
    const { data: siblings } = await sb
      .from('ai_agent_qna')
      .select('id, question, locale')
      .eq('workspace_id', existing.workspace_id)
      .eq('locale', finalLocale)
      .neq('id', req.params.id)
      .limit(2000);
    const dup = (siblings || []).find((r: any) => normalizeQuestion(r.question || '') === normalized);
    if (dup) return res.status(409).json({ error: 'duplicate_qna', existing_id: dup.id });
  }
  const { data, error } = await sb.from('ai_agent_qna').update(patch).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  // syncKnowledgeSource already deactivates chunks when enabled=false (passes
  // empty chunks → indexer marks all as deleted) and re-indexes on enabled=true.
  syncKnowledgeSource(config, { workspaceId: existing.workspace_id, sourceType: 'qna', sourceId: req.params.id }).catch(() => {});
  return res.json({ item: data });
});

aiAgentRouter.delete('/qna/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_qna').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  // Deactivate runtime chunks BEFORE the row vanishes so retrieval can never
  // surface a Q&A whose source row is gone.
  await sb.from('ai_knowledge_chunks')
    .update({ status: 'deleted' })
    .eq('workspace_id', existing.workspace_id)
    .eq('source_type', 'qna')
    .eq('source_id', req.params.id);
  const { error } = await sb.from('ai_agent_qna').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ─── Q&A bulk import (owner/admin) ───
const qnaBulkSchema = z.object({
  workspaceId: z.string().uuid(),
  items: z.array(z.object({
    question: z.string().min(1).max(500),
    answer: z.string().min(1).max(4000),
    locale: z.string().max(10).optional(),
    enabled: z.boolean().optional(),
  })).min(1).max(200),
});
aiAgentRouter.post('/qna/bulk', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = qnaBulkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, items } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  // Pull existing normalized questions per locale to dedupe in-memory.
  const { data: existingRows } = await sb
    .from('ai_agent_qna')
    .select('question, locale')
    .eq('workspace_id', workspaceId)
    .limit(5000);
  const existingKeys = new Set(
    (existingRows || []).map((r: any) => `${(r.locale || 'en')}::${normalizeQuestion(r.question || '')}`)
  );
  const created: string[] = [];
  const skipped: { question: string; reason: string }[] = [];
  const errors: { question: string; error: string }[] = [];
  for (const it of items) {
    const rawQ = typeof it.question === 'string' ? it.question.trim() : '';
    const rawA = typeof it.answer === 'string' ? it.answer.trim() : '';
    const rawLocale = (typeof it.locale === 'string' ? it.locale.trim().toLowerCase() : '') || 'en';
    if (rawLocale.length > 10) { skipped.push({ question: it.question, reason: 'invalid_locale' }); continue; }
    if (!rawQ) { skipped.push({ question: it.question, reason: 'empty_question' }); continue; }
    if (!rawA) { skipped.push({ question: it.question, reason: 'empty_answer' }); continue; }
    const normalized = normalizeQuestion(rawQ);
    if (!normalized) { skipped.push({ question: it.question, reason: 'empty_question' }); continue; }
    const key = `${rawLocale}::${normalized}`;
    if (existingKeys.has(key)) { skipped.push({ question: it.question, reason: 'duplicate' }); continue; }
    existingKeys.add(key);
    const { data, error } = await sb
      .from('ai_agent_qna')
      .insert({ workspace_id: workspaceId, question: rawQ, answer: rawA, locale: rawLocale, enabled: it.enabled ?? true })
      .select('id').single();
    if (error) { skipped.push({ question: it.question, reason: 'insert_failed' }); errors.push({ question: it.question, error: error.message }); continue; }
    created.push(data.id);
    syncKnowledgeSource(config, { workspaceId, sourceType: 'qna', sourceId: data.id }).catch(() => {});
  }
  return res.json({ created: created.length, skipped: skipped.length, errors: errors.length, details: { skipped, errors } });
});

// ─── Q&A reindex single (owner/admin) ───
aiAgentRouter.post('/qna/:id/reindex', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_qna').select('workspace_id, enabled').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  await syncKnowledgeSource(config, { workspaceId: existing.workspace_id, sourceType: 'qna', sourceId: req.params.id });
  return res.json({ ok: true, indexed: existing.enabled !== false, skipped_disabled: existing.enabled === false });
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

// ─── POST /api/ai-agent/conversations/:conversationId/take-over ─────
// Manual operator takeover. Removes the conversation from the Automated
// inbox, marks `ai_state='human_active'`, optionally assigns to caller,
// and stops further AI auto-replies.
const takeOverSchema = z.object({
  workspaceId: z.string().uuid(),
  assign_to_me: z.boolean().optional().default(true),
});
aiAgentRouter.post(
  '/conversations/:conversationId/take-over',
  async (req: Request, res: Response) => {
    const config = (req as any).serverConfig as ServerConfig;
    const conversationId = req.params.conversationId;
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

// ─────────────────────────────────────────────────────────────────────
// Pass 2 — Knowledge index endpoints
// ─────────────────────────────────────────────────────────────────────

const rebuildSchema = z.object({ workspaceId: z.string().uuid() });
aiAgentRouter.post('/knowledge-index/rebuild', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = rebuildSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  try {
    const summary = await rebuildWorkspaceIndex(config, workspaceId);
    return res.json(summary);
  } catch (err: any) {
    return res.status(500).json({ error: 'rebuild_failed', details: err?.message });
  }
});

aiAgentRouter.get('/knowledge-index/status', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const status = await getKnowledgeIndexStatus(config, workspaceId);
  return res.json(status);
});

// Per-source sync: called by clients after they save a KB article so the
// index stays fresh without forcing a full rebuild. Backend re-reads the
// source from the DB; client is not trusted to send content.
const syncSourceSchema = z.object({
  workspaceId: z.string().uuid(),
  sourceType: z.enum(['kb_article', 'qna', 'business_profile']),
  sourceId: z.string().min(1).max(200),
});
aiAgentRouter.post('/knowledge-index/sync-source', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = syncSourceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId, sourceType, sourceId } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  // Best-effort; never throws.
  await syncKnowledgeSource(config, { workspaceId, sourceType, sourceId });
  return res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────
// Pass E1 — Train / Data Hub overview + index diagnostics
// ─────────────────────────────────────────────────────────────────────

aiAgentRouter.get('/train/overview', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  try {
    const overview = await buildTrainOverview(config, workspaceId);
    return res.json(overview);
  } catch (err: any) {
    return res.status(500).json({ error: 'train_overview_failed', details: err?.message });
  }
});

aiAgentRouter.get('/knowledge-index/chunks', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sourceType = req.query.sourceType ? String(req.query.sourceType) : null;
  const status = req.query.status ? String(req.query.status) : null;
  const query = req.query.query ? String(req.query.query).slice(0, 200) : null;
  const limit = req.query.limit ? Math.min(parseInt(String(req.query.limit), 10) || 50, 200) : 50;
  try {
    const r = await listChunks(config, workspaceId, { sourceType, status, query, limit });
    return res.json(r);
  } catch (err: any) {
    return res.status(500).json({ error: 'list_chunks_failed', details: err?.message });
  }
});

const rebuildSourceSchema = z.object({
  workspaceId: z.string().uuid(),
  sourceType: z.enum(['kb_article', 'qna', 'business_profile', 'website', 'web_page']),
  sourceId: z.string().min(1).max(200),
});
aiAgentRouter.post('/knowledge-index/rebuild-source', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = rebuildSourceSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId, sourceType, sourceId } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  if (sourceType === 'website' || sourceType === 'web_page') {
    // Resolve website source (web_page rebuild is parent-source rebuild).
    const sb = getServiceClient(config);
    const websiteId = sourceType === 'website' ? sourceId : sourceId.split(':')[0];
    const { data: src } = await sb.from('ai_data_sources')
      .select('id, workspace_id, status').eq('id', websiteId).maybeSingle();
    if (!src || src.workspace_id !== workspaceId) {
      return res.status(404).json({ error: 'source_not_found' });
    }
    if (src.status === 'deleted') return res.status(400).json({ error: 'source_deleted' });
    const job = await enqueueSourceSyncJob(config, {
      workspaceId, sourceId: src.id, jobType: 'website_rebuild', createdBy: auth.userId,
    });
    if (process.env.AI_KB_WORKER_INPROC === '1') {
      setImmediate(() => { processOneSourceJob(config).catch(() => {}); });
    }
    return res.json({ ok: true, jobId: job.id, status: 'queued' });
  }
  const r = await rebuildSingleSource(config, workspaceId, sourceType, sourceId);
  return res.json(r);
});

// ─────────────────────────────────────────────────────────────────────
// Pass 3 — Learning candidates
// ─────────────────────────────────────────────────────────────────────

aiAgentRouter.get('/learning-candidates', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const status = String(req.query.status || 'pending');
  const sb = getServiceClient(config);
  let q = sb
    .from('ai_agent_learning_candidates')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(Math.min(Number(req.query.limit) || 200, 500));
  if (status !== 'all') q = q.eq('status', status);
  const reason = String(req.query.reason || '').trim();
  if (reason) {
    // Filter strictly by the dedicated `reason` column (backfilled by migration).
    q = q.eq('reason', reason);
  }
  const locale = String(req.query.locale || '').trim();
  if (locale) q = q.eq('locale', locale);
  const search = String(req.query.q || '').trim();
  if (search) q = q.ilike('question_text', `%${search}%`);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

// ─── POST /learning-candidates/generate ───
const generateSchema = z.object({
  workspaceId: z.string().uuid(),
  sinceIso: z.string().datetime().optional(),
  limit: z.number().int().min(1).max(500).optional(),
});
aiAgentRouter.post('/learning-candidates/generate', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const auth = await authorizeMember(req, res, config, parsed.data.workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const result = await generatePendingCandidates(config, parsed.data);
  return res.json(result);
});

// ─── PATCH /learning-candidates/:id ───
const candidatePatchSchema = z.object({
  question_text: z.string().min(1).max(500).optional(),
  suggested_answer: z.string().min(1).max(4000).optional(),
  locale: z.string().max(10).optional(),
  suggested_title: z.string().max(200).optional(),
});
aiAgentRouter.patch('/learning-candidates/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = candidatePatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const cand = await loadCandidate(config, req.params.id);
  if (!cand) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, cand.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  // Trim + validate fields. Empty-after-trim is rejected.
  const patch: Record<string, unknown> = {};
  if (parsed.data.question_text !== undefined) {
    const q = parsed.data.question_text.trim();
    if (!q) return res.status(400).json({ error: 'question_required' });
    patch.question_text = q;
    patch.normalized_question = normalizeQuestion(q);
  }
  if (parsed.data.suggested_answer !== undefined) {
    const a = parsed.data.suggested_answer.trim();
    if (!a) return res.status(400).json({ error: 'answer_required' });
    patch.suggested_answer = a;
  }
  if (parsed.data.locale !== undefined) {
    const loc = (parsed.data.locale || '').trim().toLowerCase() || 'en';
    if (loc.length > 10) return res.status(400).json({ error: 'invalid_locale' });
    patch.locale = loc;
  }
  if (parsed.data.suggested_title !== undefined) patch.suggested_title = parsed.data.suggested_title;
  const reindexFields = ['question_text','suggested_answer','locale'] as const;
  const willReindex = cand.status === 'approved' && reindexFields.some((k) => k in patch);
  if (willReindex) {
    const finalAnswer = (patch.suggested_answer as string | undefined) ?? cand.suggested_answer ?? cand.answer_text;
    if (!finalAnswer || !String(finalAnswer).trim()) {
      return res.status(400).json({ error: 'answer_required' });
    }
  }
  const { data, error } = await sb.from('ai_agent_learning_candidates').update(patch).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  if (willReindex) {
    const finalQuestion = (patch.question_text as string | undefined) ?? cand.question_text;
    const finalAnswer = (patch.suggested_answer as string | undefined) ?? cand.suggested_answer ?? cand.answer_text;
    const finalLocale = (patch.locale as string | undefined) ?? cand.locale ?? 'en';
    try {
      await reindexLearnedCandidate(config, {
        workspaceId: cand.workspace_id,
        candidateId: cand.id,
        question: finalQuestion,
        answer: finalAnswer,
        locale: finalLocale,
        actorId: auth.userId,
        markReindexed: true,
      });
    } catch (err: any) {
      console.warn('[learning-candidates.patch] reindex failed:', err?.message);
    }
  }
  return res.json({ item: data });
});

// ─── POST /learning-candidates/:id/approve  (creates a learned_qna chunk, no Q&A row) ───
const approveLearnedSchema = z.object({
  final_answer: z.string().min(1).max(4000),
  question: z.string().min(1).max(500).optional(),
  locale: z.string().max(10).optional(),
});
aiAgentRouter.post('/learning-candidates/:id/approve', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = approveLearnedSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'answer_required', details: parsed.error.flatten().fieldErrors });
  if (!parsed.data.final_answer || !parsed.data.final_answer.trim()) {
    return res.status(400).json({ error: 'answer_required' });
  }
  const cand = await loadCandidate(config, req.params.id);
  if (!cand) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, cand.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  // Idempotent re-approve: if already approved, replace its single learned_qna
  // chunk with the new answer text. Reject hard-conflicts with terminal states.
  if (!['pending','approved'].includes(cand.status)) {
    return res.status(409).json({ error: 'not_pending', status: cand.status });
  }
  const answer = (parsed.data.final_answer || '').trim();
  if (!answer) return res.status(400).json({ error: 'answer_required' });
  const question = (parsed.data.question ?? cand.question_text ?? '').trim();
  if (!question) return res.status(400).json({ error: 'question_required' });
  const normalized = normalizeQuestion(question);
  if (!normalized) return res.status(400).json({ error: 'question_required' });
  const locale = ((parsed.data.locale ?? cand.locale ?? 'en') + '').trim().toLowerCase().slice(0, 10) || 'en';
  const nowIso = new Date().toISOString();
  const sb = getServiceClient(config);
  // Persist final_answer + status.
  await sb.from('ai_agent_learning_candidates').update({
    status: 'approved',
    question_text: question,
    normalized_question: normalized,
    suggested_answer: answer,
    answer_text: answer,
    locale,
    reviewed_by: auth.userId,
    reviewed_at: nowIso,
    metadata: { ...(cand.metadata || {}), approved_by: auth.userId, approved_at: nowIso },
  }).eq('id', cand.id);
  try {
    await reindexLearnedCandidate(config, {
      workspaceId: cand.workspace_id,
      candidateId: cand.id,
      question,
      answer,
      locale,
      actorId: auth.userId,
      markReindexed: false,
    });
  } catch (err: any) {
    console.warn('[learning-candidates.approve] reindex failed:', err?.message);
  }
  return res.json({ ok: true, candidate_id: cand.id });
});

// ─── POST /learning-candidates/:id/convert-to-qna  (creates ai_agent_qna row + indexes) ───
const convertQnaSchema = z.object({
  question: z.string().min(1).max(500).optional(),
  answer: z.string().min(1).max(4000).optional(),
  locale: z.string().max(10).optional(),
});
aiAgentRouter.post('/learning-candidates/:id/convert-to-qna', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = convertQnaSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const cand = await loadCandidate(config, req.params.id);
  if (!cand) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, cand.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const result = await convertCandidateToQna(config, cand.id, parsed.data, { userId: auth.userId });
  return res.status(result.status).json(result.payload);
});

// ─── POST /learning-candidates/:id/convert-to-kb  (replaces /convert-kb; supports publish flag) ───
const convertKbSchema = z.object({
  title: z.string().max(200).optional(),
  answer: z.string().min(1).max(20000).optional(),
  locale: z.string().max(10).optional(),
  publish: z.boolean().optional(),
});
aiAgentRouter.post('/learning-candidates/:id/convert-to-kb', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = convertKbSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const cand = await loadCandidate(config, req.params.id);
  if (!cand) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, cand.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const result = await convertCandidateToKb(config, cand.id, parsed.data, { userId: auth.userId });
  return res.status(result.status).json(result.payload);
});

const candidateActionSchema = z.object({
  question: z.string().min(1).max(500).optional(),
  answer: z.string().min(1).max(4000).optional(),
  locale: z.string().max(10).optional(),
  title: z.string().max(200).optional(),
});

async function loadCandidate(config: ServerConfig, id: string) {
  const sb = getServiceClient(config);
  const { data } = await sb.from('ai_agent_learning_candidates').select('*').eq('id', id).maybeSingle();
  return data as any | null;
}

// Shared helper: (re)index a learned_qna chunk for an approved candidate.
// Always wipes prior learned_qna chunks for this candidate first so retrieval
// never returns stale duplicates.
async function reindexLearnedCandidate(
  config: ServerConfig,
  args: {
    workspaceId: string;
    candidateId: string;
    question: string;
    answer: string;
    locale: string;
    actorId: string | null;
    markReindexed?: boolean;
  },
): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('ai_knowledge_chunks').delete()
    .eq('workspace_id', args.workspaceId)
    .eq('source_type', 'learned_qna')
    .eq('source_id', args.candidateId);
  const { indexSource, getEmbedderForWorkspace } = await import('../services/ai-agent/knowledgeIndex/indexer.js');
  const { chunkQna } = await import('../services/ai-agent/knowledgeIndex/chunker.js');
  const embedder = await getEmbedderForWorkspace(config, args.workspaceId);
  await indexSource(config, {
    workspaceId: args.workspaceId,
    sourceType: 'learned_qna',
    sourceId: args.candidateId,
    title: (args.question || '').slice(0, 300),
    locale: args.locale,
    chunks: chunkQna(args.question, args.answer),
    metadata: {
      candidate_id: args.candidateId,
      approved_by: args.actorId,
      reindexed_at: args.markReindexed ? new Date().toISOString() : undefined,
    },
  }, embedder);
}

// Shared convert helpers — used by both new and legacy routes. Caller must
// have already authorized owner/admin. These return a result tuple instead
// of writing to res so the calling route owns the response shape.
async function convertCandidateToQna(
  config: ServerConfig,
  candidateId: string,
  body: { question?: string; answer?: string; locale?: string },
  auth: { userId: string | null },
): Promise<{ status: number; payload: any }> {
  const cand = await loadCandidate(config, candidateId);
  if (!cand) return { status: 404, payload: { error: 'not_found' } };
  if (cand.status !== 'pending' && cand.status !== 'approved') {
    return { status: 409, payload: { error: 'not_pending', status: cand.status } };
  }
  const sb = getServiceClient(config);
  const question = (body.question ?? cand.question_text ?? '').toString().trim();
  const answer = (body.answer ?? cand.suggested_answer ?? cand.answer_text ?? '').toString().trim();
  if (!answer) return { status: 400, payload: { error: 'answer_required' } };
  if (!question) return { status: 400, payload: { error: 'question_required' } };
  const locale = ((body.locale ?? cand.locale ?? 'en') as string).trim().toLowerCase() || 'en';
  const normalized = normalizeQuestion(question);
  let qnaId: string | null = null;
  let duplicate = false;
  if (normalized) {
    const { data: existingRows } = await sb
      .from('ai_agent_qna')
      .select('id, question, locale')
      .eq('workspace_id', cand.workspace_id)
      .eq('locale', locale)
      .limit(2000);
    const hit = (existingRows || []).find((r: any) => normalizeQuestion(r.question || '') === normalized);
    if (hit) { qnaId = hit.id; duplicate = true; }
  }
  if (!qnaId) {
    const { data: qna, error: qErr } = await sb
      .from('ai_agent_qna')
      .insert({ workspace_id: cand.workspace_id, question, answer, locale, enabled: true })
      .select('id').single();
    if (qErr) return { status: 500, payload: { error: qErr.message } };
    qnaId = qna.id;
  }
  await sb.from('ai_agent_learning_candidates').update({
    status: 'converted_to_qna',
    reviewed_by: auth.userId,
    reviewed_at: new Date().toISOString(),
    metadata: { ...(cand.metadata || {}), converted_qna_id: qnaId, deduped_to_existing: duplicate },
  }).eq('id', cand.id);
  const { count: removedStale } = await sb.from('ai_knowledge_chunks').delete({ count: 'exact' })
    .eq('workspace_id', cand.workspace_id).eq('source_type', 'learned_qna').eq('source_id', cand.id);
  syncKnowledgeSource(config, { workspaceId: cand.workspace_id, sourceType: 'qna', sourceId: qnaId }).catch(() => {});
  return { status: 200, payload: { ok: true, qna_id: qnaId, deduped: duplicate, removed_stale_chunks: removedStale ?? 0 } };
}

async function convertCandidateToKb(
  config: ServerConfig,
  candidateId: string,
  body: { title?: string; answer?: string; locale?: string; publish?: boolean },
  auth: { userId: string | null },
): Promise<{ status: number; payload: any }> {
  const cand = await loadCandidate(config, candidateId);
  if (!cand) return { status: 404, payload: { error: 'not_found' } };
  if (cand.status !== 'pending' && cand.status !== 'approved') {
    return { status: 409, payload: { error: 'not_pending', status: cand.status } };
  }
  const sb = getServiceClient(config);
  const title = (body.title ?? cand.suggested_title ?? (cand.question_text || '').slice(0, 120)).toString().trim();
  const content = (body.answer ?? cand.suggested_answer ?? cand.answer_text ?? '').toString().trim();
  if (!content) return { status: 400, payload: { error: 'answer_required' } };
  const locale = ((body.locale ?? cand.locale ?? 'en') as string).trim().toLowerCase() || 'en';
  const publish = !!body.publish;
  const slug = await generateUniqueKbSlug(config, cand.workspace_id, locale, title);
  const { data: art, error: aErr } = await sb
    .from('knowledge_base_articles')
    .insert({ workspace_id: cand.workspace_id, title, content, locale, slug, status: publish ? 'published' : 'draft' })
    .select('id').single();
  if (aErr) return { status: 500, payload: { error: aErr.message } };
  await sb.from('ai_agent_learning_candidates').update({
    status: 'converted_to_kb',
    reviewed_by: auth.userId,
    reviewed_at: new Date().toISOString(),
    metadata: { ...(cand.metadata || {}), converted_kb_id: art.id, kb_published: publish },
  }).eq('id', cand.id);
  const { count: removedStale } = await sb.from('ai_knowledge_chunks').delete({ count: 'exact' })
    .eq('workspace_id', cand.workspace_id).eq('source_type', 'learned_qna').eq('source_id', cand.id);
  if (publish) {
    syncKnowledgeSource(config, { workspaceId: cand.workspace_id, sourceType: 'kb_article', sourceId: art.id }).catch(() => {});
  }
  return { status: 200, payload: { ok: true, article_id: art.id, published: publish, removed_stale_chunks: removedStale ?? 0 } };
}

// Legacy aliases — call shared helpers directly. No req.url mutation.
aiAgentRouter.post('/learning-candidates/:id/approve-qna', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = convertQnaSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const cand = await loadCandidate(config, req.params.id);
  if (!cand) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, cand.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const result = await convertCandidateToQna(config, cand.id, parsed.data, { userId: auth.userId });
  return res.status(result.status).json(result.payload);
});
aiAgentRouter.post('/learning-candidates/:id/convert-kb', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = convertKbSchema.safeParse({ ...(req.body || {}), publish: false });
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const cand = await loadCandidate(config, req.params.id);
  if (!cand) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, cand.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const result = await convertCandidateToKb(config, cand.id, { ...parsed.data, publish: false }, { userId: auth.userId });
  return res.status(result.status).json(result.payload);
});

aiAgentRouter.post('/learning-candidates/:id/reject', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const cand = await loadCandidate(config, req.params.id);
  if (!cand) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, cand.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  if (cand.status === 'converted_to_qna' || cand.status === 'converted_to_kb') {
    return res.status(409).json({ error: 'already_converted', status: cand.status });
  }
  if (cand.status === 'rejected') {
    return res.json({ ok: true, already_rejected: true });
  }
  if (cand.status !== 'pending' && cand.status !== 'approved') {
    return res.status(409).json({ error: 'invalid_status', status: cand.status });
  }
  const sb = getServiceClient(config);
  const reason = typeof req.body?.reason === 'string' ? String(req.body.reason).slice(0, 500) : null;
  await sb
    .from('ai_agent_learning_candidates')
    .update({
      status: 'rejected',
      reviewed_by: auth.userId,
      reviewed_at: new Date().toISOString(),
      metadata: { ...(cand.metadata || {}), rejection_reason: reason },
    })
    .eq('id', cand.id);
  // Defense-in-depth: any prior learned_qna chunk for this candidate is hard-deleted.
  const { count: removedStale } = await sb.from('ai_knowledge_chunks').update({ status: 'deleted' }, { count: 'exact' })
    .eq('workspace_id', cand.workspace_id).eq('source_type', 'learned_qna').eq('source_id', cand.id);
  return res.json({ ok: true, removed_stale_chunks: removedStale ?? 0 });
});

// Slug helper for KB conversion. Lowercase, ascii-fold-best-effort, dedupe per workspace+locale.
async function generateUniqueKbSlug(
  config: ServerConfig,
  workspaceId: string,
  locale: string,
  title: string,
): Promise<string> {
  const sb = getServiceClient(config);
  const base = (title || 'article')
    .toString()
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\u00C0-\u024F\u0370-\u1FFF\u3040-\u30FF\u4E00-\u9FFF\u0600-\u06FF\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'article';
  let candidate = base;
  for (let i = 0; i < 20; i += 1) {
    const { data } = await sb
      .from('knowledge_base_articles')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('locale', locale)
      .eq('slug', candidate)
      .maybeSingle();
    if (!data) return candidate;
    candidate = `${base}-${Math.random().toString(36).slice(2, 7)}`;
  }
  return `${base}-${Date.now()}`;
}

aiAgentRouter.get('/learning-candidates/stats', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const stats: Record<string, number> = { pending: 0, approved: 0, converted_to_qna: 0, converted_to_kb: 0, rejected: 0 };
  for (const s of Object.keys(stats)) {
    const { count } = await sb
      .from('ai_agent_learning_candidates')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId)
      .eq('status', s);
    stats[s] = count ?? 0;
  }
  return res.json(stats);
});

// ─────────────────────────────────────────────────────────────────────
// Pass A — Guidance / Routing / Data Sources CRUD
//   These power the AI Agent admin console. No runtime behaviour change
//   in this pass; rules are stored and surfaced for review/editing only.
//   Real engine integration happens in a later pass.
// ─────────────────────────────────────────────────────────────────────

const GUIDANCE_TYPES = [
  'tone','answer_policy','escalation_policy','restricted_topic',
  'fallback_behavior','sales_guidance','support_guidance','pricing_guidance',
] as const;

const guidanceCreateSchema = z.object({
  workspaceId: z.string().uuid(),
  title: z.string().min(1).max(160),
  description: z.string().max(1000).optional().nullable(),
  rule_type: z.enum(GUIDANCE_TYPES),
  condition_json: z.record(z.any()).optional(),
  instruction: z.string().max(2000).default(''),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
});
const guidancePatchSchema = guidanceCreateSchema.partial().omit({ workspaceId: true });

aiAgentRouter.get('/guidance', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_guidance_rules')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

aiAgentRouter.post('/guidance', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = guidanceCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, ...row } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_guidance_rules')
    .insert({ workspace_id: workspaceId, ...row })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

aiAgentRouter.patch('/guidance/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_guidance_rules').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const parsed = guidancePatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { data, error } = await sb
    .from('ai_agent_guidance_rules')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

aiAgentRouter.delete('/guidance/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_guidance_rules').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { error } = await sb.from('ai_agent_guidance_rules').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ─── Routing rules CRUD ───
const ROUTING_TRIGGERS = [
  'human_request','no_answer','low_confidence','topic_detected',
  'business_hours','language','vip_customer','plan_limit',
] as const;
const ROUTING_ACTIONS = [
  'handoff','assign_team','assign_operator','keep_ai','create_ticket','mark_priority',
] as const;

const routingCreateSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).optional().nullable(),
  trigger_type: z.enum(ROUTING_TRIGGERS),
  conditions_json: z.record(z.any()).optional(),
  action_type: z.enum(ROUTING_ACTIONS),
  action_json: z.record(z.any()).optional(),
  priority: z.number().int().min(0).max(10000).default(100),
  enabled: z.boolean().default(true),
});
const routingPatchSchema = routingCreateSchema.partial().omit({ workspaceId: true });

aiAgentRouter.get('/routing', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_routing_rules')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('priority', { ascending: true })
    .order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

aiAgentRouter.post('/routing', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = routingCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, ...row } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_routing_rules')
    .insert({ workspace_id: workspaceId, ...row })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

aiAgentRouter.patch('/routing/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_routing_rules').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const parsed = routingPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { data, error } = await sb
    .from('ai_agent_routing_rules')
    .update(parsed.data)
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

aiAgentRouter.delete('/routing/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_routing_rules').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { error } = await sb.from('ai_agent_routing_rules').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ─── Data sources (web pages, files) ───
aiAgentRouter.get('/data-sources', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sourceType = req.query.sourceType ? String(req.query.sourceType) : null;
  const sb = getServiceClient(config);
  let q = sb.from('ai_data_sources').select('*').eq('workspace_id', workspaceId).neq('status', 'deleted').order('created_at', { ascending: false });
  if (sourceType) q = q.eq('source_type', sourceType);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

const websiteCreateSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(160).optional(),
  base_url: z.string().url().optional(),
  include_rules: z.array(z.string().max(500)).max(50).optional(),
  exclude_rules: z.array(z.string().max(500)).max(50).optional(),
  crawl_depth: z.number().int().min(1).max(5).default(2),
  max_pages: z.number().int().min(1).max(5000).default(50),
  refresh_interval: z.enum(['manual','daily','weekly','monthly']).default('manual'),
});

aiAgentRouter.post('/data-sources/website', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = websiteCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, base_url, name, include_rules, exclude_rules, crawl_depth, max_pages, refresh_interval } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });

  const sb = getServiceClient(config);
  // Resolve workspace registered domain — we do not allow arbitrary cross-domain crawl in v1.
  const { data: domainRow } = await sb
    .from('workspace_domains')
    .select('domain')
    .eq('workspace_id', workspaceId)
    .order('is_primary', { ascending: false })
    .limit(1)
    .maybeSingle();
  const registeredDomain = (domainRow?.domain as string | undefined)?.toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (!registeredDomain) {
    return res.status(400).json({ error: 'no_workspace_domain' });
  }

  let url: URL;
  try {
    url = new URL(base_url || (registeredDomain ? `https://${registeredDomain}` : ''));
  } catch {
    return res.status(400).json({ error: 'invalid_base_url' });
  }
  const proto = url.protocol.toLowerCase();
  if (proto !== 'http:' && proto !== 'https:') {
    return res.status(400).json({ error: 'unsupported_protocol' });
  }
  const hostBare = url.hostname.toLowerCase().replace(/^www\./, '');
  const rootBare = registeredDomain.replace(/^www\./, '');
  if (hostBare !== rootBare) {
    return res.status(400).json({ error: 'domain_not_allowed', registeredDomain });
  }

  // Cap user input by plan limits at create time.
  const { limits } = await resolveAiAgentDataLimits(config, workspaceId);
  const cappedMaxPages = Math.min(max_pages, limits.ai_kb_max_pages);
  const cappedDepth = Math.min(crawl_depth, limits.ai_kb_max_depth);

  const { data, error } = await sb
    .from('ai_data_sources')
    .insert({
      workspace_id: workspaceId,
      source_type: 'website',
      name: name || url.hostname,
      base_url: url.toString(),
      status: 'active',
      include_rules: include_rules || [],
      exclude_rules: exclude_rules || [],
      crawl_depth: cappedDepth,
      max_pages: cappedMaxPages,
      refresh_interval,
    })
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data, registeredDomain });
});

const dataSourcePatchSchema = z.object({
  name: z.string().min(1).max(160).optional(),
  status: z.enum(['active','paused','syncing','failed','deleted']).optional(),
  include_rules: z.array(z.string().max(500)).max(50).optional(),
  exclude_rules: z.array(z.string().max(500)).max(50).optional(),
  crawl_depth: z.number().int().min(1).max(5).optional(),
  max_pages: z.number().int().min(1).max(5000).optional(),
  refresh_interval: z.enum(['manual','daily','weekly','monthly']).optional(),
});

aiAgentRouter.patch('/data-sources/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_data_sources').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const parsed = dataSourcePatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  // Cap by plan limits when caller is editing crawl_depth/max_pages.
  const patch: Record<string, unknown> = { ...parsed.data };
  if (patch.crawl_depth !== undefined || patch.max_pages !== undefined) {
    const { limits } = await resolveAiAgentDataLimits(config, existing.workspace_id);
    if (patch.crawl_depth !== undefined) patch.crawl_depth = Math.min(Number(patch.crawl_depth), limits.ai_kb_max_depth);
    if (patch.max_pages !== undefined) patch.max_pages = Math.min(Number(patch.max_pages), limits.ai_kb_max_pages);
  }
  const { data, error } = await sb
    .from('ai_data_sources')
    .update(patch)
    .eq('id', req.params.id)
    .select('*')
    .single();
  if (error) return res.status(500).json({ error: error.message });
  // If transitioned to paused → deactivate active chunks (fail-closed retrieval).
  if (parsed.data.status === 'paused') {
    await sb.from('ai_knowledge_chunks').update({ status: 'inactive' })
      .eq('workspace_id', existing.workspace_id)
      .eq('source_type', 'web_page')
      .like('source_id', `${req.params.id}:%`)
      .eq('status', 'active');
  } else if (parsed.data.status === 'active') {
    await sb.from('ai_knowledge_chunks').update({ status: 'active' })
      .eq('workspace_id', existing.workspace_id)
      .eq('source_type', 'web_page')
      .like('source_id', `${req.params.id}:%`)
      .eq('status', 'inactive');
  }
  return res.json({ item: data });
});

aiAgentRouter.delete('/data-sources/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_data_sources').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  // Soft-delete + cancel queued jobs + deactivate chunks (fail-closed retrieval).
  const { error } = await sb.from('ai_data_sources').update({ status: 'deleted' }).eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  await sb.from('ai_knowledge_chunks')
    .update({ status: 'deleted' })
    .eq('workspace_id', existing.workspace_id)
    .eq('source_type', 'web_page')
    .like('source_id', `${req.params.id}:%`)
    .neq('status', 'deleted');
  await sb.from('ai_source_sync_jobs')
    .update({ status: 'cancelled', finished_at: new Date().toISOString() })
    .eq('source_id', req.params.id)
    .in('status', ['queued', 'running']);
  return res.json({ ok: true });
});

// Manual sync trigger — enqueues a DB-backed sync job (ai_source_sync_jobs).
// If AI_KB_WORKER_INPROC=1 the local server will pick it up immediately;
// otherwise a standalone worker can claim it.
aiAgentRouter.post('/data-sources/:id/sync', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_data_sources').select('id, workspace_id, source_type, status').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  if (existing.status === 'deleted') return res.status(400).json({ error: 'source_deleted' });
  // Plan: monthly job ceiling. Platform admins bypass for operational use.
  if (!auth.isAdmin) {
    const { limits } = await resolveAiAgentDataLimits(config, existing.workspace_id);
    const monthly = await countSourceJobsThisMonth(config, existing.workspace_id);
    if (monthly >= limits.ai_kb_jobs_per_month) {
      return res.status(403).json({ error: 'plan_limit_reached', detail: 'ai_kb_jobs_per_month', limit: limits.ai_kb_jobs_per_month, used: monthly });
    }
  }
  // Block if a queued/running job already exists. Otherwise (including when
  // the latest job is failed/max-attempts), enqueue a fresh queued job —
  // failed jobs are never auto-claimed; this is the explicit retry path.
  const { data: active } = await sb
    .from('ai_source_sync_jobs')
    .select('id, status')
    .eq('source_id', existing.id)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  let job: { id: string; status: string };
  if (active) {
    job = active as any;
  } else {
    const created = await enqueueSourceSyncJob(config, {
      workspaceId: existing.workspace_id,
      sourceId: existing.id,
      jobType: 'website_sync',
      createdBy: auth.userId || null,
      metadata: auth.isAdmin ? { admin_override: true } : {},
    });
    job = created;
  }
  await sb.from('ai_source_sync_logs').insert({
    workspace_id: existing.workspace_id,
    source_id: existing.id,
    status: 'queued',
    message: auth.isAdmin ? 'Sync job queued (admin bypass)' : 'Sync job queued',
    metadata: { job_id: job.id },
  });
  // In-process opportunistic kick.
  if (process.env.AI_KB_WORKER_INPROC === '1') {
    setImmediate(() => { processOneSourceJob(config).catch(() => {}); });
  }
  return res.json({ ok: true, jobId: job.id, status: job.status, bypass: auth.isAdmin || undefined, worker: getWorkerInfo() });
});

// Explicit retry of the latest job for a source. Creates a fresh queued job
// (preferred for clean audit history) when no queued/running job already
// exists. Failed jobs are NEVER auto-claimed by the worker.
aiAgentRouter.post('/data-sources/:id/retry-failed-job', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_data_sources').select('id, workspace_id, status').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  if (existing.status === 'deleted') return res.status(400).json({ error: 'source_deleted' });
  const { data: active } = await sb
    .from('ai_source_sync_jobs')
    .select('id, status')
    .eq('source_id', existing.id)
    .in('status', ['queued', 'running'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (active) {
    return res.json({ ok: true, jobId: (active as any).id, status: (active as any).status, reused: true, worker: getWorkerInfo() });
  }
  const created = await enqueueSourceSyncJob(config, {
    workspaceId: existing.workspace_id,
    sourceId: existing.id,
    jobType: 'website_sync',
    createdBy: auth.userId || null,
    metadata: { retry: true, ...(auth.isAdmin ? { admin_override: true } : {}) },
  });
  await sb.from('ai_source_sync_logs').insert({
    workspace_id: existing.workspace_id,
    source_id: existing.id,
    status: 'queued',
    message: auth.isAdmin ? 'Retry sync job queued (admin bypass)' : 'Retry sync job queued',
    metadata: { job_id: created.id, retry: true },
  });
  if (process.env.AI_KB_WORKER_INPROC === '1') {
    setImmediate(() => { processOneSourceJob(config).catch(() => {}); });
  }
  return res.json({ ok: true, jobId: created.id, status: created.status, retried: true, bypass: auth.isAdmin || undefined, worker: getWorkerInfo() });
});

aiAgentRouter.get('/data-sources/:id/logs', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_data_sources').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  const { data, error } = await sb
    .from('ai_source_sync_logs')
    .select('*')
    .eq('source_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(50);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

// ─── Discovered pages (E2) ───
aiAgentRouter.get('/data-sources/:id/pages', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_data_sources').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  const { data, error } = await sb
    .from('ai_source_pages')
    .select('id, url, status, http_status, title, locale, text_length, content_hash, chunks_created, embedding_status, warning, last_seen_at')
    .eq('source_id', req.params.id)
    .order('last_seen_at', { ascending: false })
    .limit(500);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

// ─── Sync jobs (latest per source) ───
aiAgentRouter.get('/data-sources/:id/jobs', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_data_sources').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  const { data, error } = await sb
    .from('ai_source_sync_jobs')
    .select('id, status, attempts, locked_by, started_at, finished_at, last_error, metadata, created_at')
    .eq('source_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(20);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [], worker: getWorkerInfo() });
});

aiAgentRouter.post('/data-sources/jobs/:jobId/cancel', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: job } = await sb.from('ai_source_sync_jobs').select('workspace_id').eq('id', req.params.jobId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, job.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  await cancelSourceSyncJob(config, { jobId: req.params.jobId });
  return res.json({ ok: true });
});

// ─── Plan limits view (read-only, used by Web Pages UI) ───
aiAgentRouter.get('/data-sources/limits', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const resolved = await resolveAiAgentDataLimits(config, workspaceId);
  const used = await countSourceJobsThisMonth(config, workspaceId);
  return res.json({
    ...resolved,
    jobs_used_this_month: used,
    bypass: auth.isAdmin || false,
    bypassReason: auth.isAdmin ? 'platform_admin' : null,
    worker: getWorkerInfo(),
  });
});

// ─── Workspace registered domain helper (read-only) ───
aiAgentRouter.get('/workspace-domain', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data } = await sb
    .from('workspace_domains')
    .select('domain, is_primary, verified')
    .eq('workspace_id', workspaceId)
    .order('is_primary', { ascending: false });
  return res.json({ domains: data || [] });
});
// ============================================================
// Pass B1 — Automate: Topics, Workflows, Message Triggers
// ============================================================

// ─── Topics: list ───
aiAgentRouter.get('/topics', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_topics')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

const topicCreateSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(1000).nullable().optional(),
  slug: z.string().min(1).max(120).optional(),
  keywords: z.array(z.string().max(120)).max(200).optional(),
  examples: z.array(z.string().max(500)).max(100).optional(),
  language: z.string().max(8).nullable().optional(),
  confidence_threshold: z.number().min(0).max(1).optional(),
  action: z.enum(['label_only','route','trigger_workflow','suggest_reply']).optional(),
  action_json: z.record(z.any()).optional(),
  enabled: z.boolean().optional(),
});

function slugify(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 120) || 'topic';
}

aiAgentRouter.post('/topics', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = topicCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const auth = await authorizeMember(req, res, config, parsed.data.workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  const slug = parsed.data.slug || slugify(parsed.data.name);
  const { workspaceId, ...rest } = parsed.data;
  const { data, error } = await sb
    .from('ai_agent_topics')
    .insert({ workspace_id: workspaceId, ...rest, slug })
    .select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

const topicPatchSchema = topicCreateSchema.partial().omit({ workspaceId: true });
aiAgentRouter.patch('/topics/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_topics').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const parsed = topicPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { data, error } = await sb.from('ai_agent_topics').update(parsed.data).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

aiAgentRouter.delete('/topics/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_topics').select('workspace_id, system').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { error } = await sb.from('ai_agent_topics').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

aiAgentRouter.post('/topics/seed-defaults', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_topics').select('slug').eq('workspace_id', workspaceId);
  const have = new Set((existing || []).map((r: any) => r.slug));
  const toInsert = DEFAULT_TOPICS.filter((t) => !have.has(t.slug)).map((t) => ({
    workspace_id: workspaceId,
    name: t.name,
    description: t.description,
    slug: t.slug,
    keywords: t.keywords,
    examples: t.examples,
    action: t.action,
    confidence_threshold: t.confidence_threshold ?? 0.65,
    enabled: true,
    system: true,
  }));
  if (toInsert.length === 0) return res.json({ ok: true, created: 0 });
  const { data, error } = await sb.from('ai_agent_topics').insert(toInsert).select('*');
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true, created: data?.length ?? 0 });
});

const topicTestSchema = z.object({
  workspaceId: z.string().uuid(),
  text: z.string().min(1).max(4000),
  language: z.string().max(8).optional(),
});
aiAgentRouter.post('/topics/test', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = topicTestSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const auth = await authorizeMember(req, res, config, parsed.data.workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data: topics } = await sb
    .from('ai_agent_topics')
    .select('*')
    .eq('workspace_id', parsed.data.workspaceId)
    .eq('enabled', true);
  const result = detectTopics(parsed.data.text, (topics || []) as any);
  if (parsed.data.language) result.language = parsed.data.language;
  return res.json(result);
});

// ─── Workflows ───
aiAgentRouter.get('/workflows', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_workflows')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

const workflowCreateSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(160),
  description: z.string().max(2000).nullable().optional(),
  trigger_json: z.record(z.any()).optional(),
  steps_json: z.array(z.record(z.any())).optional(),
  enabled: z.boolean().optional(),
  status: z.enum(['draft','active','paused','archived']).optional(),
});

aiAgentRouter.post('/workflows', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = workflowCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const auth = await authorizeMember(req, res, config, parsed.data.workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  const { workspaceId, ...rest } = parsed.data;
  const { data, error } = await sb.from('ai_agent_workflows').insert({
    workspace_id: workspaceId,
    status: 'draft',
    enabled: false,
    ...rest,
  }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

const workflowPatchSchema = workflowCreateSchema.partial().omit({ workspaceId: true });
aiAgentRouter.patch('/workflows/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_workflows').select('*').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const parsed = workflowPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });

  // Refuse to enable an invalid workflow.
  const wantsEnable = parsed.data.enabled === true || parsed.data.status === 'active';
  if (wantsEnable) {
    const merged = {
      name: parsed.data.name ?? existing.name,
      trigger_json: parsed.data.trigger_json ?? existing.trigger_json,
      steps_json: parsed.data.steps_json ?? existing.steps_json,
    };
    const v = validateWorkflow(merged as any);
    if (!v.valid) return res.status(400).json({ error: 'workflow_invalid', errors: v.errors });
  }

  const { data, error } = await sb.from('ai_agent_workflows').update(parsed.data).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

aiAgentRouter.delete('/workflows/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_workflows').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { error } = await sb.from('ai_agent_workflows').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

aiAgentRouter.post('/workflows/:id/duplicate', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: src } = await sb.from('ai_agent_workflows').select('*').eq('id', req.params.id).maybeSingle();
  if (!src) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, src.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { data, error } = await sb.from('ai_agent_workflows').insert({
    workspace_id: src.workspace_id,
    name: `${src.name} (copy)`,
    description: src.description,
    trigger_json: src.trigger_json,
    steps_json: src.steps_json,
    status: 'draft',
    enabled: false,
    version: 1,
  }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

aiAgentRouter.post('/workflows/:id/validate', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: wf } = await sb.from('ai_agent_workflows').select('*').eq('id', req.params.id).maybeSingle();
  if (!wf) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, wf.workspace_id);
  if (!auth) return;
  return res.json(validateWorkflow(wf as any));
});

const workflowPreviewSchema = z.object({
  workspaceId: z.string().uuid(),
  workflowDraft: z.record(z.any()),
  sampleMessage: z.string().max(4000).optional(),
  sampleContext: z.record(z.any()).optional(),
});
aiAgentRouter.post('/workflows/preview', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = workflowPreviewSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const auth = await authorizeMember(req, res, config, parsed.data.workspaceId);
  if (!auth) return;
  const result = previewWorkflow({
    workflowDraft: parsed.data.workflowDraft as any,
    sampleMessage: parsed.data.sampleMessage,
    sampleContext: parsed.data.sampleContext as any,
  });
  return res.json(result);
});

aiAgentRouter.get('/workflows/_meta', async (_req: Request, res: Response) => {
  return res.json({
    triggers: ALLOWED_TRIGGERS,
    conditions: ALLOWED_CONDITION_TYPES,
    actions: ALLOWED_ACTION_TYPES,
  });
});

// ─── Message triggers ───
aiAgentRouter.get('/message-triggers', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_message_triggers')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('updated_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ items: data || [] });
});

const messageTriggerCreateSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(160),
  description: z.string().max(1000).nullable().optional(),
  event_type: z.enum([
    'visitor_first_message','conversation_started','after_prechat',
    'no_operator_online','ai_no_answer','topic_detected',
    'human_requested','business_hours_closed',
  ]),
  conditions_json: z.record(z.any()).optional(),
  action_type: z.enum(['send_message','start_workflow','handoff','assign','tag','internal_note']),
  action_json: z.record(z.any()).optional(),
  delay_seconds: z.number().int().min(0).max(86400).optional(),
  enabled: z.boolean().optional(),
});

aiAgentRouter.post('/message-triggers', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = messageTriggerCreateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const auth = await authorizeMember(req, res, config, parsed.data.workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  const { workspaceId, ...rest } = parsed.data;
  const { data, error } = await sb.from('ai_agent_message_triggers').insert({
    workspace_id: workspaceId, enabled: false, ...rest,
  }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

const messageTriggerPatchSchema = messageTriggerCreateSchema.partial().omit({ workspaceId: true });
aiAgentRouter.patch('/message-triggers/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_message_triggers').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const parsed = messageTriggerPatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { data, error } = await sb.from('ai_agent_message_triggers').update(parsed.data).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

aiAgentRouter.delete('/message-triggers/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_message_triggers').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { error } = await sb.from('ai_agent_message_triggers').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// Test (dry-run) — returns the planned action without executing anything.
aiAgentRouter.post('/message-triggers/:id/test', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: trig } = await sb.from('ai_agent_message_triggers').select('*').eq('id', req.params.id).maybeSingle();
  if (!trig) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, trig.workspace_id);
  if (!auth) return;
  return res.json({
    ok: true,
    dryRun: true,
    runtimeExecutionEnabled: false,
    planned: {
      event_type: trig.event_type,
      action_type: trig.action_type,
      action_json: trig.action_json,
      delay_seconds: trig.delay_seconds,
    },
    note: 'Saved. Runtime execution will be enabled in the next automation runtime pass.',
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass B2 — Integrations & MCP, Overview, Test-run
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /overview ──
aiAgentRouter.get('/overview', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace_id' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  try {
    const overview = await buildOverview(config, workspaceId);
    return res.json(overview);
  } catch (err: any) {
    return res.status(500).json({ error: 'overview_failed', details: err?.message });
  }
});

// ── POST /test-run ──
const testRunSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  pageUrl: z.string().max(2000).optional(),
  visitorLocale: z.string().max(10).optional(),
  dryRun: z.boolean().optional().default(true),
});
aiAgentRouter.post('/test-run', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = testRunSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, message, pageUrl, visitorLocale } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!checkPlaygroundRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'playground_rate_limited' });
  }
  try {
    const result = await runDryRun(config, { workspaceId, message, pageUrl, visitorLocale });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'test_run_failed', details: err?.message });
  }
});

// ── Tools catalog (CRUD) ──
aiAgentRouter.get('/tools', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace_id' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('ai_agent_tools').select('*')
    .eq('workspace_id', workspaceId)
    .order('tool_type', { ascending: true })
    .order('name', { ascending: true });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({
    items: data || [],
    defaultInternalTools: DEFAULT_INTERNAL_TOOLS,
    runtimeExecutionEnabled: false,
  });
});

const toolSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional().nullable(),
  tool_type: z.enum(['internal', 'mcp', 'webhook', 'crm', 'ticket']),
  provider: z.string().max(120).optional().nullable(),
  server_id: z.string().uuid().optional().nullable(),
  config_json: z.record(z.any()).optional().default({}),
  enabled: z.boolean().optional().default(false),
  permissions_json: z.record(z.any()).optional().default({}),
  risk_level: z.enum(['low', 'medium', 'high']).optional().default('low'),
});
aiAgentRouter.post('/tools', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = toolSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, ...row } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  // High-risk tools cannot be enabled at creation time
  const safeRow = { ...row, enabled: row.risk_level === 'high' ? false : !!row.enabled };
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('ai_agent_tools').insert({ workspace_id: workspaceId, ...safeRow }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: data });
});

aiAgentRouter.patch('/tools/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_tools').select('workspace_id,risk_level').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const allowed = ['name','description','tool_type','provider','server_id','config_json','enabled','permissions_json','risk_level'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = (req.body as any)[k];
  // Explicit confirmation required to enable a high-risk tool
  const finalRisk = (patch.risk_level as string | undefined) ?? existing.risk_level;
  if (patch.enabled === true && finalRisk === 'high' && req.body?.confirm_high_risk !== true) {
    return res.status(400).json({ error: 'high_risk_confirmation_required' });
  }
  const { data, error } = await sb.from('ai_agent_tools').update(patch).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: data });
});

aiAgentRouter.delete('/tools/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_tools').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { error } = await sb.from('ai_agent_tools').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// ── Tool servers (CRUD + safe test) ──
function sanitizeServer(row: any) {
  if (!row) return row;
  const { encrypted_config, ...rest } = row;
  return { ...rest, hasConfig: !!encrypted_config };
}

aiAgentRouter.get('/tool-servers', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'missing_workspace_id' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('ai_agent_tool_servers').select('*')
    .eq('workspace_id', workspaceId).order('created_at', { ascending: false });
  if (error) return res.status(500).json({ error: error.message });
  return res.json({
    items: (data || []).map(sanitizeServer),
    runtimeExecutionEnabled: process.env.AI_AGENT_MCP_TEST_ENABLED === '1',
  });
});

const serverSchema = z.object({
  workspaceId: z.string().uuid(),
  name: z.string().min(1).max(120),
  server_type: z.enum(['mcp', 'internal', 'webhook']).default('mcp'),
  endpoint_url: z.string().max(2000).optional().nullable(),
  status: z.enum(['disabled', 'enabled', 'error']).optional().default('disabled'),
  auth_type: z.enum(['none', 'bearer', 'basic', 'api_key', 'oauth']).optional().default('none'),
  encrypted_config: z.record(z.any()).optional().nullable(),
  allowed_tools: z.array(z.string()).optional().default([]),
  permissions_json: z.record(z.any()).optional().default({}),
});
aiAgentRouter.post('/tool-servers', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = serverSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, ...row } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  // Enforce: status cannot be 'enabled' until platform admin enables MCP runtime
  const safeRow = { ...row, status: row.status === 'enabled' && process.env.AI_AGENT_MCP_TEST_ENABLED !== '1' ? 'disabled' : row.status };
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('ai_agent_tool_servers').insert({ workspace_id: workspaceId, ...safeRow }).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.status(201).json({ item: sanitizeServer(data) });
});

aiAgentRouter.patch('/tool-servers/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_tool_servers').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const allowed = ['name','server_type','endpoint_url','status','auth_type','encrypted_config','allowed_tools','permissions_json'];
  const patch: Record<string, unknown> = {};
  for (const k of allowed) if (k in req.body) patch[k] = (req.body as any)[k];
  if (patch.status === 'enabled' && process.env.AI_AGENT_MCP_TEST_ENABLED !== '1') {
    patch.status = 'disabled';
  }
  const { data, error } = await sb.from('ai_agent_tool_servers').update(patch).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ item: sanitizeServer(data) });
});

aiAgentRouter.delete('/tool-servers/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_tool_servers').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { error } = await sb.from('ai_agent_tool_servers').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: error.message });
  return res.json({ ok: true });
});

// Safe test: validate URL/config shape only; never execute external tools
// unless AI_AGENT_MCP_TEST_ENABLED=1.
aiAgentRouter.post('/tool-servers/:id/test', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: srv } = await sb.from('ai_agent_tool_servers').select('*').eq('id', req.params.id).maybeSingle();
  if (!srv) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, srv.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });

  const validations: Array<{ key: string; ok: boolean; message?: string }> = [];
  validations.push({ key: 'name', ok: !!srv.name });
  if (srv.server_type !== 'internal') {
    let urlOk = false;
    try { if (srv.endpoint_url) { new URL(srv.endpoint_url); urlOk = true; } } catch { /* */ }
    validations.push({ key: 'endpoint_url', ok: urlOk, message: urlOk ? undefined : 'A valid endpoint URL is required.' });
  }
  if (srv.auth_type && srv.auth_type !== 'none') {
    validations.push({ key: 'auth_config', ok: !!srv.encrypted_config, message: srv.encrypted_config ? undefined : 'Auth config is required for the selected auth type.' });
  }
  const allValid = validations.every((v) => v.ok);

  await sb.from('ai_agent_tool_servers').update({ last_checked_at: new Date().toISOString(), last_error: allValid ? null : 'validation_failed' }).eq('id', srv.id);

  return res.json({
    ok: allValid,
    runtimeExecutionEnabled: false,
    validations,
    message: 'MCP execution is disabled until platform admin enables it.',
  });
});
