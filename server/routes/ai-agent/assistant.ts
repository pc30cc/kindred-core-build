/**
 * AI Agent router — assistant domain.
 *
 * Mechanically extracted from the original server/routes/aiAgent.ts (Phase 3
 * router split). Route paths, middleware order, auth, validation, rate
 * limits and response shapes are unchanged from the original file.
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { checkModuleAccess, requireModule } from '../../middleware/featureGating.js';
import {
  getOrCreateSettings,
  updateSettings,
  type AgentSettings,
} from '../../services/ai-agent/settings.js';
import { getKnowledgeStatus } from '../../services/ai-agent/retrieval.js';
import { listRuns } from '../../services/ai-agent/logs.js';
import { resolveAIConfig } from '../../services/ai/index.js';
import { getOperatorAvailability } from '../../services/ai-agent/availability.js';
import { buildOverview } from '../../services/ai-agent/overview.js';
import { randomUUID } from 'crypto';
import { uploadFile, deleteFile } from '../../services/storage/index.js';
import {
  toCustomerSafeAiAgentSettings,
  validateAvatarBytes,
} from '../../services/ai-agent/customerSafe.js';
import { getWorkspaceAiAgentCapabilities } from '../../services/ai-agent/platformSettings.js';
import { resolveCurrentUserId, authorizeMember, isOwnerOrAdmin, requireWorkspace } from './shared.js';

export const assistantRouter: Router = express.Router();

// ─── GET /settings ───
assistantRouter.get('/settings', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const settings = await getOrCreateSettings(config, workspaceId);
  return res.json({ settings: toCustomerSafeAiAgentSettings(settings) });
});

// ─── E12 GET /capabilities ───
// Redacted capability snapshot for workspace UI. Reachable even when the
// platform kill switch is on (so the UI can render the disabled state).
// Requires the caller to be a workspace member of the requested workspace.
assistantRouter.get('/capabilities', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const { userId } = await resolveCurrentUserId(req, config);
  try {
    const capabilities = await getWorkspaceAiAgentCapabilities(
      config,
      workspaceId,
      userId || null,
    );
    return res.json({ capabilities });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'capabilities_read_failed' });
  }
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
  intro_message_localized: z.record(z.string().max(1000)).optional(),
  handoff_message_localized: z.record(z.string().max(1000)).optional(),
  handoff_prechat_message_localized: z.record(z.string().max(1000)).optional(),
  fallback_behavior: z.enum(['handoff','silent']).optional(),
  stop_on_handoff: z.boolean().optional(),
  pause_auto_reply_after_human_reply: z.boolean().optional(),
  allow_suggestions_after_takeover: z.boolean().optional(),
  keep_in_automated_until_handoff: z.boolean().optional(),
});

assistantRouter.put('/settings', async (req: Request, res: Response) => {
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
    return res.json({ settings: toCustomerSafeAiAgentSettings(updated) });
  } catch (err: any) {
    return res.status(500).json({ error: 'update_failed', details: err?.message });
  }
});

// ─── POST /settings/avatar — upload AI agent avatar via active storage provider ───
const AVATAR_MAX_BYTES = 5 * 1024 * 1024; // 5 MB
// Reject base64 payloads that decode larger than the limit. base64 expands
// bytes by ~4/3, so cap the encoded string roughly here as a fast pre-check.
const AVATAR_MAX_BASE64_LEN = Math.ceil((AVATAR_MAX_BYTES * 4) / 3) + 32;

const avatarUploadSchema = z.object({
  workspaceId: z.string().uuid(),
  filename: z.string().min(1).max(200),
  mimeType: z.string().max(100).optional(),
  dataBase64: z.string().min(1),
});

function safeAvatarFilename(name: string): string {
  // strip path, keep ascii alnum + . _ -
  const base = String(name).split(/[\\/]/).pop() || 'avatar';
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80);
  return cleaned || 'avatar';
}

assistantRouter.post('/settings/avatar', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = avatarUploadSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, filename, mimeType, dataBase64 } = parsed.data;

  if (dataBase64.length > AVATAR_MAX_BASE64_LEN) {
    return res.status(413).json({ error: 'file_too_large', maxBytes: AVATAR_MAX_BYTES });
  }

  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }

  let buf: Buffer;
  try {
    buf = Buffer.from(dataBase64, 'base64');
  } catch {
    return res.status(400).json({ error: 'invalid_base64' });
  }
  const v = validateAvatarBytes({
    filename,
    declaredMime: mimeType,
    buf,
    maxBytes: AVATAR_MAX_BYTES,
  });
  if (!v.ok) {
    const code = v.error === 'file_too_large' ? 413 : 400;
    return res.status(code).json({ error: v.error || 'invalid_image' });
  }
  const ext = v.ext!;
  const finalMime = v.mime!;

  const safeName = safeAvatarFilename(filename);
  // workspace-scoped path. NEVER returned to the client.
  const fileKey = `workspace/${workspaceId}/ai-agent/avatar/${randomUUID()}-${safeName}${safeName.endsWith('.' + ext) ? '' : '.' + ext}`;

  // Best-effort cleanup of previous avatar (if it was stored via our provider).
  let oldKey: string | null = null;
  try {
    const prev = await getOrCreateSettings(config, workspaceId);
    const meta = (prev.metadata || {}) as Record<string, unknown>;
    const prevKey = typeof meta.ai_avatar_storage_key === 'string' ? meta.ai_avatar_storage_key : null;
    if (prevKey) oldKey = prevKey;
  } catch { /* ignore */ }

  const uploaded = await uploadFile(config, {
    workspaceId,
    fileKey,
    data: buf,
    contentType: finalMime,
  });
  if (!uploaded.success || !uploaded.url) {
    return res.status(502).json({ error: 'upload_failed', details: uploaded.error });
  }

  // Persist public URL on the existing settings.agent_logo_url column.
  // Track internal storage key in metadata so we can clean up on replace.
  try {
    const current = await getOrCreateSettings(config, workspaceId);
    const newMeta = {
      ...((current.metadata || {}) as Record<string, unknown>),
      ai_avatar_storage_key: fileKey,
    };
    await updateSettings(config, workspaceId, {
      agent_logo_url: uploaded.url,
      metadata: newMeta,
    } as Partial<AgentSettings>);
  } catch (err: any) {
    return res.status(500).json({ error: 'persist_failed', details: err?.message });
  }

  if (oldKey && oldKey !== fileKey) {
    // Best effort. Never fail the request if cleanup fails.
    deleteFile(config, workspaceId, oldKey).catch(() => undefined);
  }

  // Only safe display URL is returned. Storage key stays server-side.
  return res.json({ avatar_url: uploaded.url });
});

assistantRouter.delete('/settings/avatar', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }

  let oldKey: string | null = null;
  try {
    const current = await getOrCreateSettings(config, workspaceId);
    const meta = (current.metadata || {}) as Record<string, unknown>;
    if (typeof meta.ai_avatar_storage_key === 'string') oldKey = meta.ai_avatar_storage_key;
    const newMeta = { ...meta };
    delete (newMeta as any).ai_avatar_storage_key;
    await updateSettings(config, workspaceId, {
      agent_logo_url: null,
      metadata: newMeta,
    } as Partial<AgentSettings>);
  } catch (err: any) {
    return res.status(500).json({ error: 'persist_failed', details: err?.message });
  }

  if (oldKey) {
    deleteFile(config, workspaceId, oldKey).catch(() => undefined);
  }
  return res.json({ ok: true });
});

// ─── GET /knowledge-status ───
assistantRouter.get('/knowledge-status', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const status = await getKnowledgeStatus(config, workspaceId);
  return res.json(status);
});

// ─── GET /diagnostics ───
assistantRouter.get('/diagnostics', async (req: Request, res: Response) => {
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

// ─── POST /generate-business-description ───
const genDescSchema = z.object({ workspaceId: z.string().uuid() });

// Phase: AI Agent route audit + selective gating.
// This is a brand-new optional generate action that calls a real AI completion.
// It does not operate on any existing in-progress run/job. Owner/admin auth
// remains enforced in-handler. Adding `requireModule('ai_assistant')` makes
// plan/override changes take effect uniformly without stranding any in-flight
// work.
assistantRouter.post('/generate-business-description', requireModule('ai_assistant'), async (req: Request, res: Response) => {
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

  const { executeAICompletion } = await import('../../services/ai/index.js');
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
      billing: { entryPoint: 'assistant_describe_business' },
    });
    return res.json({ description: (r.text || '').trim(), source: 'ai', provider: r.provider, model: r.model });
  } catch (err: any) {
    return res.status(500).json({ error: 'generation_failed', details: err?.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Pass B2 — Integrations & MCP, Overview, Test-run
// ─────────────────────────────────────────────────────────────────────────────

// ── GET /overview ──
assistantRouter.get('/overview', async (req: Request, res: Response) => {
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
