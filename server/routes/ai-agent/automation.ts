/**
 * AI Agent router — automation domain.
 *
 * Mechanically extracted from the original server/routes/aiAgent.ts (Phase 3
 * router split). Route paths, middleware order, auth, validation, rate
 * limits and response shapes are unchanged from the original file.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { detectTopics } from '../../services/ai-agent/topics/detector.js';
import { DEFAULT_TOPICS } from '../../services/ai-agent/topics/defaults.js';
import {
  validateWorkflow, previewWorkflow,
  ALLOWED_TRIGGERS, ALLOWED_CONDITION_TYPES, ALLOWED_ACTION_TYPES,
} from '../../services/ai-agent/workflows/validate.js';
import { DEFAULT_INTERNAL_TOOLS } from '../../services/ai-agent/overview.js';
import { authorizeMember, isOwnerOrAdmin, requireWorkspace } from './shared.js';

export const automationRouter: Router = express.Router();


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

automationRouter.get('/guidance', async (req: Request, res: Response) => {
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

automationRouter.post('/guidance', async (req: Request, res: Response) => {
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

automationRouter.patch('/guidance/:id', async (req: Request, res: Response) => {
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

automationRouter.delete('/guidance/:id', async (req: Request, res: Response) => {
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

automationRouter.get('/routing', async (req: Request, res: Response) => {
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

automationRouter.post('/routing', async (req: Request, res: Response) => {
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

automationRouter.patch('/routing/:id', async (req: Request, res: Response) => {
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

automationRouter.delete('/routing/:id', async (req: Request, res: Response) => {
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

// ============================================================
// Pass B1 — Automate: Topics, Workflows, Message Triggers
// ============================================================

// ─── Topics: list ───
automationRouter.get('/topics', async (req: Request, res: Response) => {
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

automationRouter.post('/topics', async (req: Request, res: Response) => {
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
automationRouter.patch('/topics/:id', async (req: Request, res: Response) => {
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

automationRouter.delete('/topics/:id', async (req: Request, res: Response) => {
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

automationRouter.post('/topics/seed-defaults', async (req: Request, res: Response) => {
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
automationRouter.post('/topics/test', async (req: Request, res: Response) => {
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
automationRouter.get('/workflows', async (req: Request, res: Response) => {
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

automationRouter.post('/workflows', async (req: Request, res: Response) => {
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
automationRouter.patch('/workflows/:id', async (req: Request, res: Response) => {
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

automationRouter.delete('/workflows/:id', async (req: Request, res: Response) => {
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

automationRouter.post('/workflows/:id/duplicate', async (req: Request, res: Response) => {
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

automationRouter.post('/workflows/:id/validate', async (req: Request, res: Response) => {
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
automationRouter.post('/workflows/preview', async (req: Request, res: Response) => {
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

automationRouter.get('/workflows/_meta', async (_req: Request, res: Response) => {
  return res.json({
    triggers: ALLOWED_TRIGGERS,
    conditions: ALLOWED_CONDITION_TYPES,
    actions: ALLOWED_ACTION_TYPES,
  });
});

// ─── Message triggers ───
// Follow-up 9G.1 — narrow capability classification for truthful dry-run
// reporting only. This does NOT change runtime behavior: it mirrors (does
// not import, to avoid coupling a route file to the runtime evaluator's
// internals) the actual event/action sets currently wired into the live
// engine — see server/services/ai-agent/engine/automationStage.ts (PRE
// events) and server/services/ai-agent/engine/helpers.ts (ai_no_answer) for
// the authoritative call sites this list is kept in sync with.
const LIVE_MESSAGE_TRIGGER_EVENTS = new Set([
  'visitor_first_message', 'topic_detected', 'human_requested', 'ai_no_answer',
]);
const LIVE_MESSAGE_TRIGGER_ACTIONS = new Set(['send_message', 'handoff']);

/**
 * Pure classification — no DB I/O, no side effects. Exported so tests can
 * pin the exact capability booleans and note text for every event/action
 * combination without needing to exercise the HTTP route (Follow-up 9G.1).
 */
export function classifyMessageTriggerRuntimeCapability(
  eventType: string,
  actionType: string,
): {
  eventRuntimeEnabled: boolean;
  actionRuntimeEnabled: boolean;
  runtimeExecutionEnabled: boolean;
  note: string;
} {
  const eventRuntimeEnabled = LIVE_MESSAGE_TRIGGER_EVENTS.has(eventType);
  const actionRuntimeEnabled = LIVE_MESSAGE_TRIGGER_ACTIONS.has(actionType);
  const runtimeExecutionEnabled = eventRuntimeEnabled && actionRuntimeEnabled;

  let note: string;
  if (runtimeExecutionEnabled) {
    note = 'Dry run evaluated this trigger. Its event and action are live in runtime. This test does not execute side effects.';
  } else if (!eventRuntimeEnabled && !actionRuntimeEnabled) {
    note = `This rule can be evaluated as configuration, but the "${eventType}" event is not currently emitted by the runtime and the "${actionType}" action is not currently executed by the runtime.`;
  } else if (!eventRuntimeEnabled) {
    note = `This rule can be evaluated as configuration, but the "${eventType}" event is not currently emitted by the runtime.`;
  } else {
    note = `This event may be live, but the "${actionType}" action is not currently executed by the runtime.`;
  }

  return { eventRuntimeEnabled, actionRuntimeEnabled, runtimeExecutionEnabled, note };
}

automationRouter.get('/message-triggers', async (req: Request, res: Response) => {
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

automationRouter.post('/message-triggers', async (req: Request, res: Response) => {
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
automationRouter.patch('/message-triggers/:id', async (req: Request, res: Response) => {
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

automationRouter.delete('/message-triggers/:id', async (req: Request, res: Response) => {
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

// Test (dry-run) — reports what the runtime would actually do for this
// trigger's persisted event/action, without executing anything (no
// insertAiMessage, no handoff, no Workflow evaluation — pure read + report).
// Follow-up 9G.1 — the response now reflects real capability instead of the
// previous hard-coded runtimeExecutionEnabled:false / "next pass" claim,
// which was false for any live event+action combination.
automationRouter.post('/message-triggers/:id/test', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: trig } = await sb.from('ai_agent_message_triggers').select('*').eq('id', req.params.id).maybeSingle();
  if (!trig) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, trig.workspace_id);
  if (!auth) return;

  const { eventRuntimeEnabled, actionRuntimeEnabled, runtimeExecutionEnabled, note } =
    classifyMessageTriggerRuntimeCapability(trig.event_type, trig.action_type);

  return res.json({
    ok: true,
    dryRun: true,
    runtimeExecutionEnabled,
    eventRuntimeEnabled,
    actionRuntimeEnabled,
    planned: {
      event_type: trig.event_type,
      action_type: trig.action_type,
      action_json: trig.action_json,
      delay_seconds: trig.delay_seconds,
    },
    note,
  });
});

// ── Tools catalog (CRUD) ──
automationRouter.get('/tools', async (req: Request, res: Response) => {
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
automationRouter.post('/tools', async (req: Request, res: Response) => {
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

automationRouter.patch('/tools/:id', async (req: Request, res: Response) => {
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

automationRouter.delete('/tools/:id', async (req: Request, res: Response) => {
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

automationRouter.get('/tool-servers', async (req: Request, res: Response) => {
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
automationRouter.post('/tool-servers', async (req: Request, res: Response) => {
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

automationRouter.patch('/tool-servers/:id', async (req: Request, res: Response) => {
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

automationRouter.delete('/tool-servers/:id', async (req: Request, res: Response) => {
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
automationRouter.post('/tool-servers/:id/test', async (req: Request, res: Response) => {
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
