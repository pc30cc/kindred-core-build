/**
 * AI Agent router — knowledge domain.
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
import { requireModule } from '../../middleware/featureGating.js';
import { getSourceHealth, type HealthSourceType } from '../../services/ai-agent/sourceHealth.js';
import { syncKnowledgeSource, rebuildWorkspaceIndex, getKnowledgeIndexStatus } from '../../services/ai-agent/knowledgeIndex/sync.js';
import { buildTrainOverview, listChunks, rebuildSingleSource } from '../../services/ai-agent/train.js';
import { resolveAiAgentDataLimits, countSourceJobsThisMonth } from '../../services/ai-agent/limits.js';
import { enqueueSourceSyncJob, cancelSourceSyncJob } from '../../services/ai-agent/sourceJobs.js';
import { processOne as processOneSourceJob, getWorkerInfo } from '../../services/ai-agent/sourceWorker.js';
import { generatePendingCandidates } from '../../services/ai-agent/learning/generator.js';
import { normalizeQuestion } from '../../services/ai-agent/learning/normalize.js';
import {
  deleteAiFile,
  pauseAiFile, resumeAiFile, resolveFileLimits,
  queueAiFileIngest, queueReindexAiFile,
  IngestError,
} from '../../services/ai-agent/files/fileIngestion.js';
import { SUPPORTED_MIMES, isSupportedMime } from '../../services/ai-agent/files/parsers.js';
import { authorizeMember, isOwnerOrAdmin, requireWorkspace } from './shared.js';

export const knowledgeRouter: Router = express.Router();


// ─── Q&A CRUD ───
knowledgeRouter.get('/qna', async (req: Request, res: Response) => {
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

knowledgeRouter.post('/qna', async (req: Request, res: Response) => {
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

knowledgeRouter.patch('/qna/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const qnaId = routeParam(req.params.id);
  if (!qnaId) return res.status(400).json({ error: 'invalid_params' });
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
  syncKnowledgeSource(config, { workspaceId: existing.workspace_id, sourceType: 'qna', sourceId: qnaId }).catch(() => {});
  return res.json({ item: data });
});

knowledgeRouter.delete('/qna/:id', async (req: Request, res: Response) => {
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
knowledgeRouter.post('/qna/bulk', async (req: Request, res: Response) => {
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
knowledgeRouter.post('/qna/:id/reindex', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const qnaId = routeParam(req.params.id);
  if (!qnaId) return res.status(400).json({ error: 'invalid_params' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_qna').select('workspace_id, enabled').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  await syncKnowledgeSource(config, { workspaceId: existing.workspace_id, sourceType: 'qna', sourceId: qnaId });
  return res.json({ ok: true, indexed: existing.enabled !== false, skipped_disabled: existing.enabled === false });
});

// ─── GET /sources — registry placeholder ───
knowledgeRouter.get('/sources', async (req: Request, res: Response) => {
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
// Pass 2 — Knowledge index endpoints
// ─────────────────────────────────────────────────────────────────────

const rebuildSchema = z.object({ workspaceId: z.string().uuid() });
knowledgeRouter.post('/knowledge-index/rebuild', async (req: Request, res: Response) => {
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

knowledgeRouter.get('/knowledge-index/status', async (req: Request, res: Response) => {
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
knowledgeRouter.post('/knowledge-index/sync-source', async (req: Request, res: Response) => {
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

knowledgeRouter.get('/train/overview', async (req: Request, res: Response) => {
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

knowledgeRouter.get('/knowledge-index/chunks', async (req: Request, res: Response) => {
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
knowledgeRouter.post('/knowledge-index/rebuild-source', async (req: Request, res: Response) => {
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

knowledgeRouter.get('/learning-candidates', async (req: Request, res: Response) => {
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
// Phase: AI Agent route audit + selective gating.
// `/learning-candidates/generate` is a discrete new generation action that
// drafts brand-new pending candidates. It does not modify or finalize any
// existing candidate row, so denial only blocks NEW work — review/approve/
// reject/convert routes remain ungated. Owner/admin auth still enforced.
knowledgeRouter.post('/learning-candidates/generate', requireModule('ai_assistant'), async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = generateSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const auth = await authorizeMember(req, res, config, parsed.data.workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  // zod's inferred output marks all properties optional under
  // `strictNullChecks: false`; workspaceId is required by the schema.
  const result = await generatePendingCandidates(config, {
    workspaceId: parsed.data.workspaceId,
    sinceIso: parsed.data.sinceIso,
    limit: parsed.data.limit,
  });
  return res.json(result);
});

// ─── PATCH /learning-candidates/:id ───
const candidatePatchSchema = z.object({
  question_text: z.string().min(1).max(500).optional(),
  suggested_answer: z.string().min(1).max(4000).optional(),
  locale: z.string().max(10).optional(),
  suggested_title: z.string().max(200).optional(),
});
knowledgeRouter.patch('/learning-candidates/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const candidateId = routeParam(req.params.id);
  if (!candidateId) return res.status(400).json({ error: 'invalid_params' });
  const parsed = candidatePatchSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const cand = await loadCandidate(config, candidateId);
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
    if (cand.status === 'approved') {
      patch.answer_text = a;
    }
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
knowledgeRouter.post('/learning-candidates/:id/approve', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const candidateId = routeParam(req.params.id);
  if (!candidateId) return res.status(400).json({ error: 'invalid_params' });
  const parsed = approveLearnedSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'answer_required', details: parsed.error.flatten().fieldErrors });
  if (!parsed.data.final_answer || !parsed.data.final_answer.trim()) {
    return res.status(400).json({ error: 'answer_required' });
  }
  const cand = await loadCandidate(config, candidateId);
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
knowledgeRouter.post('/learning-candidates/:id/convert-to-qna', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const candidateId = routeParam(req.params.id);
  if (!candidateId) return res.status(400).json({ error: 'invalid_params' });
  const parsed = convertQnaSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const cand = await loadCandidate(config, candidateId);
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
knowledgeRouter.post('/learning-candidates/:id/convert-to-kb', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const candidateId = routeParam(req.params.id);
  if (!candidateId) return res.status(400).json({ error: 'invalid_params' });
  const parsed = convertKbSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const cand = await loadCandidate(config, candidateId);
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
  const { indexSource, getEmbedderForWorkspace } = await import('../../services/ai-agent/knowledgeIndex/indexer.js');
  const { chunkQna } = await import('../../services/ai-agent/knowledgeIndex/chunker.js');
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
knowledgeRouter.post('/learning-candidates/:id/approve-qna', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const candidateId = routeParam(req.params.id);
  if (!candidateId) return res.status(400).json({ error: 'invalid_params' });
  const parsed = convertQnaSchema.safeParse(req.body || {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const cand = await loadCandidate(config, candidateId);
  if (!cand) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, cand.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const result = await convertCandidateToQna(config, cand.id, parsed.data, { userId: auth.userId });
  return res.status(result.status).json(result.payload);
});
knowledgeRouter.post('/learning-candidates/:id/convert-kb', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const candidateId = routeParam(req.params.id);
  if (!candidateId) return res.status(400).json({ error: 'invalid_params' });
  const parsed = convertKbSchema.safeParse({ ...(req.body || {}), publish: false });
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const cand = await loadCandidate(config, candidateId);
  if (!cand) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, cand.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const result = await convertCandidateToKb(config, cand.id, { ...parsed.data, publish: false }, { userId: auth.userId });
  return res.status(result.status).json(result.payload);
});

knowledgeRouter.post('/learning-candidates/:id/reject', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const candidateId = routeParam(req.params.id);
  if (!candidateId) return res.status(400).json({ error: 'invalid_params' });
  const cand = await loadCandidate(config, candidateId);
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

knowledgeRouter.get('/learning-candidates/stats', async (req: Request, res: Response) => {
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

// ─── Data sources (web pages, files) ───
knowledgeRouter.get('/data-sources', async (req: Request, res: Response) => {
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

knowledgeRouter.post('/data-sources/website', async (req: Request, res: Response) => {
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

knowledgeRouter.patch('/data-sources/:id', async (req: Request, res: Response) => {
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
    // ai_knowledge_chunks CHECK allows active|stale|deleted only.
    await sb.from('ai_knowledge_chunks').update({ status: 'stale' })
      .eq('workspace_id', existing.workspace_id)
      .eq('source_type', 'web_page')
      .like('source_id', `${req.params.id}:%`)
      .eq('status', 'active');
  } else if (parsed.data.status === 'active') {
    await sb.from('ai_knowledge_chunks').update({ status: 'active' })
      .eq('workspace_id', existing.workspace_id)
      .eq('source_type', 'web_page')
      .like('source_id', `${req.params.id}:%`)
      .eq('status', 'stale');
  }
  return res.json({ item: data });
});

knowledgeRouter.delete('/data-sources/:id', async (req: Request, res: Response) => {
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
knowledgeRouter.post('/data-sources/:id/sync', async (req: Request, res: Response) => {
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
knowledgeRouter.post('/data-sources/:id/retry-failed-job', async (req: Request, res: Response) => {
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

knowledgeRouter.get('/data-sources/:id/logs', async (req: Request, res: Response) => {
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
knowledgeRouter.get('/data-sources/:id/pages', async (req: Request, res: Response) => {
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
knowledgeRouter.get('/data-sources/:id/jobs', async (req: Request, res: Response) => {
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

knowledgeRouter.post('/data-sources/jobs/:jobId/cancel', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const jobId = routeParam(req.params.jobId);
  if (!jobId) return res.status(400).json({ error: 'invalid_params' });
  const sb = getServiceClient(config);
  const { data: job } = await sb.from('ai_source_sync_jobs').select('workspace_id').eq('id', jobId).maybeSingle();
  if (!job) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, job.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  await cancelSourceSyncJob(config, { jobId });
  return res.json({ ok: true });
});

// ─── Plan limits view (read-only, used by Web Pages UI) ───
knowledgeRouter.get('/data-sources/limits', async (req: Request, res: Response) => {
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
knowledgeRouter.get('/workspace-domain', async (req: Request, res: Response) => {
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
// Pass E4-A — AI Agent Files (TXT, MD, CSV, PDF) ingestion
// ============================================================

const fileUploadSchema = z.object({
  workspaceId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().max(120).optional().default(''),
  sizeBytes: z.number().int().positive().max(60 * 1024 * 1024),
  dataBase64: z.string().min(1),
});

function ingestErrorResponse(res: Response, e: any) {
  if (e instanceof IngestError) {
    return res.status(e.status).json({ error: e.code, details: e.details });
  }
  console.warn('[ai-agent files] error:', e?.message);
  return res.status(500).json({ error: 'internal_error', message: e?.message });
}

function validateUploadFileName(name: string): string | null {
  if (!name || name.length > 255) return 'invalid_file_name';
  if (name.includes('\u0000')) return 'invalid_file_name';
  if (name.includes('/') || name.includes('\\')) return 'invalid_file_name';
  if (name.startsWith('.')) return 'invalid_file_name';
  return null;
}

/**
 * Browsers may send empty file.type for .md/.csv. Infer from extension
 * server-side — never trust browser-provided MIME alone.
 */
function resolveMimeFromName(fileName: string, browserMime: string): string {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const byExt: Record<string, string> = {
    txt: 'text/plain',
    md: 'text/markdown',
    markdown: 'text/markdown',
    csv: 'text/csv',
    pdf: 'application/pdf',
  };
  const inferred = byExt[ext];
  const browser = (browserMime || '').toLowerCase().trim();
  if (inferred) return inferred;
  if (browser && browser !== 'application/octet-stream') return browser;
  return browser || 'application/octet-stream';
}

knowledgeRouter.post('/files/upload', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = fileUploadSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, fileName, sizeBytes, dataBase64 } = parsed.data;
  const mimeType = resolveMimeFromName(fileName, parsed.data.mimeType || '');

  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });

  const nameErr = validateUploadFileName(fileName);
  if (nameErr) return res.status(400).json({ error: nameErr });
  if (!isSupportedMime(mimeType)) return res.status(415).json({ error: 'unsupported_file_type', supported: SUPPORTED_MIMES });

  // Pre-decode size + storage gate to fail fast before base64 decode and
  // before any ai_data_sources row is inserted.
  const limits = await resolveFileLimits(config, workspaceId);
  if (!limits.storageProvider) return res.status(500).json({ error: 'storage_not_configured' });
  if (!limits.storageReady) {
    return res.status(500).json({ error: 'storage_not_ready', storageProvider: limits.storageProvider, storageError: limits.storageError });
  }
  const declaredMB = sizeBytes / (1024 * 1024);
  if (declaredMB > limits.transportMaxFileSizeMB) {
    return res.status(413).json({ error: 'file_size_limit_reached', maxMB: limits.transportMaxFileSizeMB, actualMB: Math.round(declaredMB * 100) / 100, reason: 'transport_cap' });
  }
  if (!auth.isAdmin && declaredMB > limits.effectiveMaxFileSizeMB) {
    return res.status(413).json({ error: 'file_size_limit_reached', maxMB: limits.effectiveMaxFileSizeMB, actualMB: Math.round(declaredMB * 100) / 100 });
  }

  let buffer: Buffer;
  try {
    buffer = Buffer.from(dataBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid_base64' });
  }
  if (!buffer.length) return res.status(400).json({ error: 'empty_file' });
  // sanity check: decoded size should be roughly within 1.5% of declared sizeBytes
  if (Math.abs(buffer.length - sizeBytes) > Math.max(64, sizeBytes * 0.015)) {
    return res.status(400).json({ error: 'size_mismatch', declared: sizeBytes, actual: buffer.length });
  }

  try {
    // Pass E4-C: queue background ingestion job; do NOT parse/index in request.
    const result = await queueAiFileIngest(config, {
      workspaceId, userId: auth.userId, fileName, mimeType, buffer,
    }, { bypassPlanLimits: !!auth.isAdmin });
    return res.json({
      ok: true,
      source: result.source,
      jobId: result.jobId,
      status: result.status,
    });
  } catch (e) { return ingestErrorResponse(res, e); }
});

knowledgeRouter.get('/files', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const status = req.query.status ? String(req.query.status) : null;
  const query = req.query.query ? String(req.query.query).trim().toLowerCase() : null;
  const limit = Math.min(parseInt(String(req.query.limit || '100'), 10) || 100, 500);
  const sb = getServiceClient(config);
  let q = sb.from('ai_data_sources').select('*')
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'file')
    .neq('status', 'deleted')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (status) q = q.eq('status', status);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: error.message });
  const items = query ? (data || []).filter((r: any) => (r.name || '').toLowerCase().includes(query)) : (data || []);
  return res.json({ items });
});

knowledgeRouter.get('/files/limits', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const limits = await resolveFileLimits(config, workspaceId);
  const sb = getServiceClient(config);
  const { count } = await sb.from('ai_data_sources')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId)
    .eq('source_type', 'file')
    .neq('status', 'deleted');
  return res.json({
    maxFiles: limits.maxFiles,
    maxFileSizeMB: limits.maxFileSizeMB,
    effectiveMaxFileSizeMB: limits.effectiveMaxFileSizeMB,
    storageProvider: limits.storageProvider,
    storageReady: limits.storageReady,
    storageError: limits.storageError,
    transport: limits.transport,
    transportMaxFileSizeMB: limits.transportMaxFileSizeMB,
    used: count || 0,
    bypass: !!auth.isAdmin,
    supported_mimes: SUPPORTED_MIMES,
    hard_cap_mb: 50,
  });
});

async function loadFileSource(config: ServerConfig, id: string) {
  const sb = getServiceClient(config);
  const { data } = await sb.from('ai_data_sources').select('workspace_id, source_type').eq('id', id).maybeSingle();
  return data;
}

/**
 * Hardened sanitizer for any metadata/job payload returned to the admin UI.
 * Strips storage paths, signed URLs, credentials, tokens, and secrets.
 * Case-insensitive; matches snake_case, camelCase, and substring patterns.
 */
const SECRET_KEY_SUBSTRINGS = [
  'storage_path', 'storagepath',
  'storage_url', 'storageurl',
  'signed_url', 'signedurl',
  'public_url', 'publicurl',
  'access_key', 'accesskey',
  'secret_access_key', 'secretaccesskey',
  'access_key_id', 'accesskeyid',
  'api_key', 'apikey',
  'token', 'secret', 'password', 'credential',
];
export function sanitizeAiFileMetadata(obj: any): any {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(sanitizeAiFileMetadata);
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (SECRET_KEY_SUBSTRINGS.some((s) => lk.includes(s))) continue;
    out[k] = (v && typeof v === 'object') ? sanitizeAiFileMetadata(v) : v;
  }
  return out;
}

knowledgeRouter.post('/files/:id/reindex', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const fileId = routeParam(req.params.id);
  if (!fileId) return res.status(400).json({ error: 'invalid_params' });
  const src = await loadFileSource(config, fileId);
  if (!src) return res.status(404).json({ error: 'not_found' });
  if (src.source_type !== 'file') return res.status(400).json({ error: 'not_a_file_source' });
  const auth = await authorizeMember(req, res, config, src.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  try {
    const result = await queueReindexAiFile(config, fileId, auth.userId);
    return res.json({ ok: true, source: result.source, jobId: result.jobId, status: result.status });
  } catch (e) { return ingestErrorResponse(res, e); }
});

knowledgeRouter.delete('/files/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const fileId = routeParam(req.params.id);
  if (!fileId) return res.status(400).json({ error: 'invalid_params' });
  const src = await loadFileSource(config, fileId);
  if (!src) return res.status(404).json({ error: 'not_found' });
  if (src.source_type !== 'file') return res.status(400).json({ error: 'not_a_file_source' });
  const auth = await authorizeMember(req, res, config, src.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  try {
    const r = await deleteAiFile(config, fileId);
    return res.json({ ok: true, ...r });
  } catch (e) { return ingestErrorResponse(res, e); }
});

knowledgeRouter.post('/files/:id/pause', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const fileId = routeParam(req.params.id);
  if (!fileId) return res.status(400).json({ error: 'invalid_params' });
  const src = await loadFileSource(config, fileId);
  if (!src) return res.status(404).json({ error: 'not_found' });
  if (src.source_type !== 'file') return res.status(400).json({ error: 'not_a_file_source' });
  const auth = await authorizeMember(req, res, config, src.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  try { await pauseAiFile(config, fileId); return res.json({ ok: true }); }
  catch (e) { return ingestErrorResponse(res, e); }
});

knowledgeRouter.post('/files/:id/resume', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const fileId = routeParam(req.params.id);
  if (!fileId) return res.status(400).json({ error: 'invalid_params' });
  const src = await loadFileSource(config, fileId);
  if (!src) return res.status(404).json({ error: 'not_found' });
  if (src.source_type !== 'file') return res.status(400).json({ error: 'not_a_file_source' });
  const auth = await authorizeMember(req, res, config, src.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  try {
    const result = await resumeAiFile(config, fileId, auth.userId);
    return res.json({ ok: true, source: result.source, jobId: result.jobId, status: result.status });
  } catch (e) { return ingestErrorResponse(res, e); }
});

// ─── Pass E4-C: file preview (workspace-scoped, no storage URLs) ───
knowledgeRouter.get('/files/:id/preview', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const fileId = routeParam(req.params.id);
  if (!fileId) return res.status(400).json({ error: 'invalid_params' });
  const src = await loadFileSource(config, fileId);
  if (!src) return res.status(404).json({ error: 'not_found' });
  if (src.source_type !== 'file') return res.status(400).json({ error: 'not_a_file_source' });
  const auth = await authorizeMember(req, res, config, src.workspace_id);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data: source } = await sb.from('ai_data_sources').select('*').eq('id', req.params.id).maybeSingle();
  if (!source) return res.status(404).json({ error: 'not_found' });
  const meta = (source.metadata as any) || {};
  // Prefer active chunks; fall back to stale (paused) chunks.
  const PREVIEW_CHUNK_LIMIT = 5;
  const PREVIEW_TOTAL_BYTES = 10 * 1024;
  const fetchChunks = async (status: 'active' | 'stale') => {
    const { data } = await sb.from('ai_knowledge_chunks')
      .select('chunk_index, content, status')
      .eq('workspace_id', source.workspace_id)
      .eq('source_type', 'file').eq('source_id', source.id)
      .eq('status', status)
      .order('chunk_index', { ascending: true })
      .limit(PREVIEW_CHUNK_LIMIT);
    return data || [];
  };
  let chunks = await fetchChunks('active');
  if (chunks.length === 0 && source.status === 'paused') chunks = await fetchChunks('stale');
  let used = 0;
  const chunksPreview: Array<{ index: number; content: string; status: string }> = [];
  for (const c of chunks) {
    const remaining = Math.max(0, PREVIEW_TOTAL_BYTES - used);
    if (remaining <= 0) break;
    const text = String((c as any).content || '').slice(0, remaining);
    used += text.length;
    chunksPreview.push({ index: (c as any).chunk_index, content: text, status: (c as any).status });
  }
  const text_preview = chunksPreview.map(c => c.content).join('\n\n---\n\n');
  return res.json({
    source_id: source.id,
    file_name: meta.original_file_name || source.name,
    status: source.status,
    job_status: meta.job_status || null,
    parser: meta.parser || null,
    page_count: meta.page_count ?? null,
    text_length: meta.text_length ?? null,
    text_preview,
    chunks_preview: chunksPreview,
    warnings: Array.isArray(meta.warnings) ? meta.warnings : [],
    last_error: source.last_error || null,
    last_warning: source.last_warning || null,
  });
});

// ─── Pass E4-C: file ingestion logs ───
knowledgeRouter.get('/files/:id/logs', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const fileId = routeParam(req.params.id);
  if (!fileId) return res.status(400).json({ error: 'invalid_params' });
  const src = await loadFileSource(config, fileId);
  if (!src) return res.status(404).json({ error: 'not_found' });
  if (src.source_type !== 'file') return res.status(400).json({ error: 'not_a_file_source' });
  const auth = await authorizeMember(req, res, config, src.workspace_id);
  if (!auth) return;
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('ai_source_sync_logs')
    .select('id, status, message, pages_found, chunks_created, embedded_chunks, errors, metadata, created_at')
    .eq('workspace_id', src.workspace_id)
    .eq('source_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(100);
  if (error) return res.status(500).json({ error: error.message });
  // Active jobs for this source.
  const { data: jobs } = await sb.from('ai_source_sync_jobs')
    .select('id, status, attempts, started_at, finished_at, last_error, created_at, job_type')
    .eq('source_id', req.params.id)
    .eq('job_type', 'file_ingest')
    .order('created_at', { ascending: false })
    .limit(20);
  const items = (data || []).map((r: any) => ({ ...r, metadata: sanitizeAiFileMetadata(r.metadata) }));
  const safeJobs = (jobs || []).map((j: any) => ({ ...j, last_error: typeof j.last_error === 'string' ? j.last_error : null }));
  return res.json({ items, jobs: safeJobs });
});

// ─── Customer-safe Knowledge summary ───
// Returns the same friendly per-source items KnowledgePage needs, without
// exposing any internal counts/metadata. Source-health remains advanced-only.
knowledgeRouter.get('/knowledge/customer-summary', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  try {
    const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 500);
    const result = await getSourceHealth(config, workspaceId, { limit });
    const items = (result.items || []).map((it: any) => ({
      source_id: it.source_id,
      source_type: it.source_type,
      title: it.title,
      eligible: !!it.eligible,
      reason: it.reason,
      updated_at: it.last_indexed_at || null,
    }));
    return res.json({ items });
  } catch (err: any) {
    return res.status(500).json({ error: 'knowledge_summary_failed', details: err?.message });
  }
});
