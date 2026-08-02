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
import { routeParam } from '../lib/routeParams.js';
import { isGlobalAdmin } from '../middleware/adminBypass.js';
import { checkModuleAccess, requireModule } from '../middleware/featureGating.js';
import {
  getOrCreateSettings,
  updateSettings,
  type AgentSettings,
} from '../services/ai-agent/settings.js';
import { getKnowledgeStatus } from '../services/ai-agent/retrieval.js';
import { runPlayground } from '../services/ai-agent/playground.js';
import { listRuns, summarize } from '../services/ai-agent/logs.js';
import { retrieveHybridSources } from '../services/ai-agent/retrievalHybrid.js';
import { getSourceHealth, type HealthSourceType } from '../services/ai-agent/sourceHealth.js';
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
import {
  deleteAiFile,
  pauseAiFile, resumeAiFile, resolveFileLimits,
  queueAiFileIngest, queueReindexAiFile,
  IngestError,
} from '../services/ai-agent/files/fileIngestion.js';
import { SUPPORTED_MIMES, isSupportedMime } from '../services/ai-agent/files/parsers.js';
import {
  runDryRunTest as e6_runDryRunTest,
  evaluateExpectations as e6_evaluateExpectations,
  type DryRunResult as E6DryRunResult,
  redactDeep as e7_redactDeep,
  redactString as e7_redactString,
} from '../services/ai-agent/testHarness.js';
import { decideStrategy as e7_decideStrategy } from '../services/ai-agent/answerStrategy.js';
import { buildSystemPrompt as e7_buildSystemPrompt, buildUserPrompt as e7_buildUserPrompt } from '../services/ai-agent/prompt.js';
import { resolveAIConfig as e7_resolveAIConfig, executeAICompletion as e7_executeAICompletion } from '../services/ai/index.js';
import { checkEntitlementFromDB } from '../middleware/featureGating.js';
import {
  suggestFromAssistFeedback as e9_suggestFromAssistFeedback,
  suggestFromFailedTestRun as e9_suggestFromFailedTestRun,
  listSuggestedCases as e9_listSuggestedCases,
  acceptSuggestedCase as e9_acceptSuggestedCase,
  rejectSuggestedCase as e9_rejectSuggestedCase,
} from '../services/ai-agent/regressionSuggestions.js';
import {
  listRegressionSchedules as e10_listSchedules,
  getOrCreateDefaultRegressionSchedule as e10_getOrCreateSchedule,
  updateRegressionSchedule as e10_updateSchedule,
  enqueueRegressionBatch as e10_enqueueBatch,
  listRegressionBatches as e10_listBatches,
  getRegressionBatchDetail as e10_getBatchDetail,
  claimQueuedBatch as e10_claimBatch,
  runRegressionBatch as e10_runBatch,
  cancelRegressionBatch as e10_cancelBatch,
  retryFailedRegressionBatch as e10_retryFailed,
  getRegressionOverview as e11_getOverview,
  exportRegressionBatchCsv as e11_exportBatchCsv,
} from '../services/ai-agent/regressionRunner.js';
import { randomUUID } from 'crypto';
import { uploadFile, deleteFile } from '../services/storage/index.js';
import {
  toCustomerSafeAiAgentSettings,
  canAccessAiAgentAdvancedToolsServer,
  validateAvatarBytes,
} from '../services/ai-agent/customerSafe.js';
import {
  getPlatformAiAgentSettings,
  updatePlatformAiAgentSettings,
  getWorkspaceAiAgentCapabilities,
} from '../services/ai-agent/platformSettings.js';
import { aiAgentPlatformGuard } from '../services/ai-agent/platformGuards.js';

export const aiAgentRouter: Router = express.Router();

// ─── Shared auth resolution ───
// Resolves the current user from either the standard `Authorization: Bearer`
// header used by the SPA, or the `sb-access-token` HTTP-only cookie fallback.
// Mirrors the auth pattern used elsewhere in the AI Agent router so that
// middleware (advanced-tools guard, kill switch) and per-route handlers
// authenticate the same way.
async function resolveCurrentUserId(
  req: Request,
  config: ServerConfig,
): Promise<{ userId: string | null; reason?: 'missing' | 'invalid' }> {
  let token: string | null = null;
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    token = authHeader.replace('Bearer ', '').trim() || null;
  }
  if (!token) {
    const cookieToken =
      (req as any).cookies?.['sb-access-token'] ||
      (req as any).cookies?.['sb:token'] ||
      null;
    if (cookieToken && typeof cookieToken === 'string') token = cookieToken;
  }
  if (!token) return { userId: null, reason: 'missing' };
  try {
    const sb = getServiceClient(config);
    const { data: { user }, error } = await sb.auth.getUser(token);
    if (error || !user) return { userId: null, reason: 'invalid' };
    return { userId: user.id };
  } catch {
    return { userId: null, reason: 'invalid' };
  }
}

// ─── Backend advanced-tools guard ───
// Mirrors the frontend AdvancedAiAgentGuard. Endpoints that expose internal
// QA/debug/regression data MUST go through this guard.
// Registered IMMEDIATELY after router creation so it runs before every
// matching route handler.
const ADVANCED_PATH_PATTERNS: RegExp[] = [
  /^\/runs\/[^/]+\/inspect$/,
  /^\/debug\/retrieval$/,
  /^\/debug\/run-test$/,
  /^\/source-health$/,
  /^\/test-cases(\/|$)/,
  /^\/test-runs(\/|$)/,
  /^\/suggested-test-cases(\/|$)/,
  /^\/regression(\/|$)/,
  /^\/test-summary$/,
  /^\/platform\/settings$/,
];
aiAgentRouter.use(async (req: Request, res: Response, next) => {
  if (!ADVANCED_PATH_PATTERNS.some((rx) => rx.test(req.path))) return next();
  const config = (req as any).serverConfig as ServerConfig;
  const { userId } = await resolveCurrentUserId(req, config);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const workspaceId = String(
    req.query.workspaceId || req.query.workspace_id || (req.body && req.body.workspaceId) || '',
  );
  const ok = await canAccessAiAgentAdvancedToolsServer(config, userId, workspaceId);
  if (!ok) return res.status(403).json({ error: 'advanced_ai_tools_not_available' });
  return next();
});

// Combined platform kill-switch + per-feature platform guard. Resolves
// workspaceId from query/body OR from :id route params, then enforces:
//   - global kill switch (ai_agent_enabled / customer_ai_agent_visible)
//   - per-feature platform toggles (files/websites/qna/operator-assist/
//     learning/regression/test-harness/source-health/kb)
// Super admins bypass the advanced/regression/test/source-health gates.
aiAgentRouter.use(aiAgentPlatformGuard());

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

// ─── E6 Test-Harness in-memory rate limits (workspace:user scope) ───
const e6TestCounters = new Map<string, { count: number; windowStart: number }>();
const E6_TEST_LIMIT = 30;
const E6_TEST_WINDOW = 5 * 60_000;
const e6BulkCounters = new Map<string, { count: number; windowStart: number }>();
const E6_BULK_LIMIT = 3;
const E6_BULK_WINDOW = 10 * 60_000;
const E6_BULK_MAX_CASES = 50;
function checkE6TestRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`;
  const now = Date.now();
  const c = e6TestCounters.get(key);
  if (!c || now - c.windowStart > E6_TEST_WINDOW) {
    e6TestCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  c.count += 1;
  return c.count <= E6_TEST_LIMIT;
}
function checkE6BulkRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`;
  const now = Date.now();
  const c = e6BulkCounters.get(key);
  if (!c || now - c.windowStart > E6_BULK_WINDOW) {
    e6BulkCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  c.count += 1;
  return c.count <= E6_BULK_LIMIT;
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
  return res.json({ settings: toCustomerSafeAiAgentSettings(settings) });
});

// ─── E12 Super Admin: GET /platform/settings ───
// Guarded by ADVANCED_PATH_PATTERNS middleware (admin-only).
aiAgentRouter.get('/platform/settings', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  try {
    const settings = await getPlatformAiAgentSettings(config);
    return res.json({ settings });
  } catch (e: any) {
    return res.status(500).json({ error: e?.message || 'platform_settings_read_failed' });
  }
});

// ─── E12 Super Admin: PATCH /platform/settings ───
// Guarded by ADVANCED_PATH_PATTERNS middleware (admin-only). Sanitizes
// the patch body to a whitelist; ignores unknown keys.
aiAgentRouter.patch('/platform/settings', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const { userId } = await resolveCurrentUserId(req, config);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  try {
    // Phase 6-S5-R5 — capture the PREVIOUS state so we can detect the real
    // false → true transition instead of fanning out on every patch.
    const previous = await getPlatformAiAgentSettings(config);
    const settings = await updatePlatformAiAgentSettings(
      config,
      (req.body || {}) as Record<string, unknown>,
      userId,
    );
    // Only a genuine OFF → ON transition re-arms deferred indexing for every
    // workspace. ON → ON does nothing; ON → OFF only clears caches implicitly
    // (events stay deferred and retryable on their own backoff).
    const turnedOn =
      previous.ai_agent_enabled === false && settings.ai_agent_enabled === true;
    let fanout: { scheduled: boolean; jobId?: string | null } = { scheduled: false };
    if (turnedOn) {
      const { handlePlatformAiEnabled } = await import(
        '../services/billing/entitlementChange.js'
      );
      // Phase 6-S5-R6 — durable, restart-safe queue job; the worker walks
      // public.workspaces with a keyset cursor.
      const r = await handlePlatformAiEnabled(config, {
        previousEnabled: previous.ai_agent_enabled === true,
        nextEnabled: settings.ai_agent_enabled === true,
      });
      fanout = { scheduled: r.ok && !r.skipped, jobId: r.jobId };
    }
    return res.json({ settings, entitlement_fanout: fanout });
  } catch (e: any) {
    if (String(e?.message) === 'forbidden') {
      return res.status(403).json({ error: 'forbidden' });
    }
    return res.status(500).json({ error: e?.message || 'platform_settings_update_failed' });
  }
});

// ─── E12 GET /capabilities ───
// Redacted capability snapshot for workspace UI. Reachable even when the
// platform kill switch is on (so the UI can render the disabled state).
// Requires the caller to be a workspace member of the requested workspace.
aiAgentRouter.get('/capabilities', async (req: Request, res: Response) => {
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

aiAgentRouter.post('/settings/avatar', async (req: Request, res: Response) => {
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

aiAgentRouter.delete('/settings/avatar', async (req: Request, res: Response) => {
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

// Phase 1 entitlement enforcement: playground is by definition an
// `ai_assistant` module surface — gate it with the canonical middleware
// so plan/override changes take effect uniformly. Existing per-user
// rate limit and member auth are preserved.
aiAgentRouter.post('/playground/test', requireModule('ai_assistant'), async (req: Request, res: Response) => {
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

// ─── E5 — Answer Inspector ───
// GET /runs/:id/inspect — returns redacted, observable run details.
// Strips storage paths, signed URLs, credentials, tokens. File source URLs are null.
const SENSITIVE_KEY_PATTERNS = [
  'storage_path','storage_url','signed_url','signedurl','signature','token','secret',
  'password','credential','access_key','accesskey','api_key','apikey','authorization',
];
function redactDeep(obj: any, depth = 0): any {
  if (obj == null || depth > 6) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redactDeep(v, depth + 1));
  if (typeof obj === 'object') {
    const out: any = {};
    for (const [k, v] of Object.entries(obj)) {
      const lk = k.toLowerCase();
      if (SENSITIVE_KEY_PATTERNS.some((p) => lk.includes(p))) continue;
      out[k] = redactDeep(v, depth + 1);
    }
    return out;
  }
  return obj;
}
function truncate(s: any, n: number): any {
  if (typeof s !== 'string') return s;
  return s.length > n ? s.slice(0, n) + '…' : s;
}

aiAgentRouter.get('/runs/:id/inspect', async (req: Request, res: Response) => {
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

// ─── E5 — Retrieval Debugger ───
// POST /debug/retrieval — runs retrieval ONLY. No message insert, no workflows,
// no MCP/tools, no learning, no handoff, no LLM call, no visitor side-effects.
const debugRetrievalSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  locale: z.string().max(10).optional(),
  pageContext: z.object({
    currentPageUrl: z.string().max(2000).nullable().optional(),
    currentPageOrigin: z.string().max(500).nullable().optional(),
    currentPagePath: z.string().max(1000).nullable().optional(),
    currentPageTitle: z.string().max(500).nullable().optional(),
  }).nullish(),
});
const debugCounters = new Map<string, { count: number; windowStart: number }>();
const DEBUG_LIMIT = 30;
const DEBUG_WINDOW = 5 * 60_000;
function checkDebugRateLimit(workspaceId: string, userId: string): boolean {
  const key = `${workspaceId}:${userId}`;
  const now = Date.now();
  const c = debugCounters.get(key);
  if (!c || now - c.windowStart > DEBUG_WINDOW) {
    debugCounters.set(key, { count: 1, windowStart: now });
    return true;
  }
  c.count += 1;
  return c.count <= DEBUG_LIMIT;
}

aiAgentRouter.post('/debug/retrieval', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = debugRetrievalSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, message, locale, pageContext } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!checkDebugRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'debug_rate_limited', message: `Limit ${DEBUG_LIMIT} runs per 5 minutes per user.` });
  }

  try {
    const hybrid = await retrieveHybridSources(config, {
      workspaceId,
      originalMessage: message,
      retrievalQuery: message,
      expandedQuery: message,
      responseLanguage: locale || 'en',
      inputLanguage: locale || 'en',
      limit: 8,
      pageContext: pageContext ? {
        currentPageUrl: pageContext.currentPageUrl ?? null,
        currentPageOrigin: pageContext.currentPageOrigin ?? null,
        currentPagePath: pageContext.currentPagePath ?? null,
        currentPageTitle: pageContext.currentPageTitle ?? null,
      } : null,
    });

    const top = hybrid.sources[0];
    let recommendation: 'answer_possible' | 'needs_clarification' | 'handoff_likely' | 'no_answer_likely';
    if (!top) recommendation = 'no_answer_likely';
    else if (top.final_score >= 0.55) recommendation = 'answer_possible';
    else if (top.final_score >= 0.3) recommendation = 'needs_clarification';
    else recommendation = 'handoff_likely';

    // Best-effort observability event (no visitor side-effect).
    const sb = getServiceClient(config);
    try {
      await sb.from('ai_agent_debug_events').insert({
        workspace_id: workspaceId,
        run_id: null,
        event_type: 'retrieval_debug_run',
        actor_user_id: auth.userId,
        metadata: { top_score: top?.final_score ?? 0, count: hybrid.sources.length },
      });
    } catch { /* noop */ }

    return res.json(redactDeep({
      retrieval_debug: hybrid.retrievalDebug,
      excluded_summary: hybrid.excludedSummary,
      page_context_debug: hybrid.pageContextDebug,
      recommendation,
      // Sources without raw content (preview already capped in retrieval_debug.selected_sources).
      sources: hybrid.sources.map((s) => ({
        id: s.source_id,
        source_type: s.source_type,
        title: s.title,
        source_url: s.source_type === 'file' ? null : (s.source_url || null),
        locale: s.locale,
        final_score: s.final_score,
        keyword_score: s.keyword_score,
        vector_score: s.vector_score,
        topic_boost: s.topic_boost,
        url_boost: s.url_boost,
        locale_bonus: s.locale_bonus,
        source_priority: s.source_priority,
        content_preview: ((s.content || s.excerpt || '') as string).slice(0, 300),
      })),
    }));
  } catch (err: any) {
    return res.status(500).json({ error: 'retrieval_debug_failed', details: err?.message });
  }
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

// ─── E5-Final — Source Health ───
// GET /api/ai-agent/source-health?workspaceId=...&sourceType=...&eligible=true|false&query=...&limit=...
// Read-only. Workspace-member auth. Never exposes storage paths/URLs/credentials.
aiAgentRouter.get('/source-health', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sourceType = (req.query.sourceType as string | undefined) as HealthSourceType | undefined;
  const allowed: HealthSourceType[] = ['qna', 'learned_qna', 'kb_article', 'file', 'website', 'web_page'];
  if (sourceType && !allowed.includes(sourceType)) {
    return res.status(400).json({ error: 'invalid_source_type' });
  }
  const eligibleRaw = req.query.eligible as string | undefined;
  const eligible = eligibleRaw === 'true' ? true : eligibleRaw === 'false' ? false : undefined;
  const limit = Math.min(parseInt(String(req.query.limit || '200'), 10) || 200, 500);
  const query = (req.query.query as string | undefined) || undefined;
  try {
    const result = await getSourceHealth(config, workspaceId, { sourceType, eligible, query, limit });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'source_health_failed', details: err?.message });
  }
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

// ─── POST /generate-business-description ───
const genDescSchema = z.object({ workspaceId: z.string().uuid() });

// Phase: AI Agent route audit + selective gating.
// This is a brand-new optional generate action that calls a real AI completion.
// It does not operate on any existing in-progress run/job. Owner/admin auth
// remains enforced in-handler. Adding `requireModule('ai_assistant')` makes
// plan/override changes take effect uniformly without stranding any in-flight
// work.
aiAgentRouter.post('/generate-business-description', requireModule('ai_assistant'), async (req: Request, res: Response) => {
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
      error: payload.error,
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

aiAgentRouter.post('/operator/suggest-reply', async (req: Request, res: Response) => {
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

aiAgentRouter.post('/operator-assist/:runId/feedback', async (req: Request, res: Response) => {
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

aiAgentRouter.get('/operator-assist/analytics', async (req: Request, res: Response) => {
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
// Phase: AI Agent route audit + selective gating.
// `/learning-candidates/generate` is a discrete new generation action that
// drafts brand-new pending candidates. It does not modify or finalize any
// existing candidate row, so denial only blocks NEW work — review/approve/
// reject/convert routes remain ungated. Owner/admin auth still enforced.
aiAgentRouter.post('/learning-candidates/generate', requireModule('ai_assistant'), async (req: Request, res: Response) => {
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
aiAgentRouter.patch('/learning-candidates/:id', async (req: Request, res: Response) => {
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
aiAgentRouter.post('/learning-candidates/:id/approve', async (req: Request, res: Response) => {
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
aiAgentRouter.post('/learning-candidates/:id/convert-to-qna', async (req: Request, res: Response) => {
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
aiAgentRouter.post('/learning-candidates/:id/convert-to-kb', async (req: Request, res: Response) => {
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
aiAgentRouter.post('/learning-candidates/:id/convert-kb', async (req: Request, res: Response) => {
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

aiAgentRouter.post('/learning-candidates/:id/reject', async (req: Request, res: Response) => {
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

aiAgentRouter.post('/files/upload', async (req: Request, res: Response) => {
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

aiAgentRouter.get('/files', async (req: Request, res: Response) => {
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

aiAgentRouter.get('/files/limits', async (req: Request, res: Response) => {
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

aiAgentRouter.post('/files/:id/reindex', async (req: Request, res: Response) => {
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

aiAgentRouter.delete('/files/:id', async (req: Request, res: Response) => {
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

aiAgentRouter.post('/files/:id/pause', async (req: Request, res: Response) => {
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

aiAgentRouter.post('/files/:id/resume', async (req: Request, res: Response) => {
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
aiAgentRouter.get('/files/:id/preview', async (req: Request, res: Response) => {
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
aiAgentRouter.get('/files/:id/logs', async (req: Request, res: Response) => {
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

// ═══════════════════════════════════════════════════════════════════════
// E6 — Test Harness: dry-run runtime + test cases CRUD + bulk runs.
// Self-host. No conversation side effects, no workflows, no MCP, no handoff,
// no learning candidates. Workspace-scoped, status='active' chunks only.
// ═══════════════════════════════════════════════════════════════════════

const e6PageContextSchema = z.object({
  currentPageUrl: z.string().max(2000).nullable().optional(),
  currentPageOrigin: z.string().max(500).nullable().optional(),
  currentPagePath: z.string().max(1000).nullable().optional(),
  currentPageTitle: z.string().max(500).nullable().optional(),
}).nullish();

const e6DebugRunSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  locale: z.string().max(10).optional(),
  pageContext: e6PageContextSchema,
  testCaseId: z.string().uuid().optional(),
  callLLM: z.boolean().optional(),
});

aiAgentRouter.post('/debug/run-test', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = e6DebugRunSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, message, locale, pageContext, callLLM } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!checkE6TestRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'test_rate_limited', limit: E6_TEST_LIMIT, window_ms: E6_TEST_WINDOW });
  }
  try {
    const result = await e6_runDryRunTest(config, {
      workspaceId, message, locale: locale || undefined,
      pageContext: pageContext || null,
      callLLM: callLLM !== false,
    });
    return res.json(result);
  } catch (err: any) {
    return res.status(500).json({ error: 'dry_run_failed', details: err?.message });
  }
});

const e6TestCaseFields = {
  name: z.string().min(1).max(200),
  input_message: z.string().min(1).max(2000),
  locale: z.string().max(10).nullable().optional(),
  page_context: z.record(z.any()).nullable().optional(),
  expected_behavior: z.enum(['answer','no_answer','handoff','clarification']),
  expected_source_type: z.enum(['qna','learned_qna','kb_article','web_page','file','business_profile']).nullable().optional(),
  expected_source_url: z.string().max(2000).nullable().optional(),
  expected_source_id: z.string().max(200).nullable().optional(),
  expected_contains: z.array(z.string().max(500)).max(20).optional(),
  expected_not_contains: z.array(z.string().max(500)).max(20).optional(),
  min_confidence: z.number().min(0).max(1).nullable().optional(),
  enabled: z.boolean().optional(),
  metadata: z.record(z.any()).optional(),
};

const e6CreateCaseSchema = z.object({ workspaceId: z.string().uuid(), ...e6TestCaseFields });
const e6PatchCaseSchema = z.object(Object.fromEntries(
  Object.entries(e6TestCaseFields).map(([k, v]: any) => [k, v.optional()]),
) as any);

// LIST
aiAgentRouter.get('/test-cases', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  let q = sb.from('ai_agent_test_cases').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false });
  if (req.query.enabled === 'true') q = q.eq('enabled', true);
  if (req.query.enabled === 'false') q = q.eq('enabled', false);
  if (req.query.expected_behavior) q = q.eq('expected_behavior', String(req.query.expected_behavior));
  if (req.query.expected_source_type) q = q.eq('expected_source_type', String(req.query.expected_source_type));
  if (req.query.query) q = q.ilike('name', `%${String(req.query.query)}%`);
  const { data, error } = await q.limit(500);
  if (error) return res.status(500).json({ error: 'list_failed', details: error.message });
  return res.json({ items: data || [] });
});

// CREATE
aiAgentRouter.post('/test-cases', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = e6CreateCaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { workspaceId, ...fields } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('ai_agent_test_cases').insert({
    workspace_id: workspaceId,
    created_by: auth.userId,
    expected_contains: fields.expected_contains || [],
    expected_not_contains: fields.expected_not_contains || [],
    metadata: fields.metadata || {},
    enabled: fields.enabled ?? true,
    ...fields,
  }).select('*').single();
  if (error) return res.status(500).json({ error: 'create_failed', details: error.message });
  return res.json({ item: data });
});

// PATCH
aiAgentRouter.patch('/test-cases/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_test_cases').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const parsed = e6PatchCaseSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  const { data, error } = await sb.from('ai_agent_test_cases').update(parsed.data).eq('id', req.params.id).select('*').single();
  if (error) return res.status(500).json({ error: 'update_failed', details: error.message });
  return res.json({ item: data });
});

// DELETE
aiAgentRouter.delete('/test-cases/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_test_cases').select('workspace_id').eq('id', req.params.id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const { error } = await sb.from('ai_agent_test_cases').delete().eq('id', req.params.id);
  if (error) return res.status(500).json({ error: 'delete_failed', details: error.message });
  return res.json({ ok: true });
});

async function e6PersistTestRun(
  sb: any, workspaceId: string, testCaseId: string | null, userId: string | null,
  result: E6DryRunResult, evalResult: { passed: boolean; failure_reasons: string[] },
  inputMessage: string,
): Promise<any> {
  const status = result.status === 'failed' && result.error
    ? 'errored'
    : (evalResult.passed ? 'passed' : 'failed');
  const failureReasons = status === 'errored'
    ? [result.error || 'errored', ...evalResult.failure_reasons]
    : evalResult.failure_reasons;
  const { data } = await sb.from('ai_agent_test_runs').insert({
    workspace_id: workspaceId,
    test_case_id: testCaseId,
    status,
    input_message: inputMessage,
    actual_output: result.output_text,
    actual_status: result.status,
    confidence: result.confidence,
    selected_sources: result.selected_sources,
    retrieval_debug: result.retrieval_debug,
    answer_strategy: result.answer_strategy,
    failure_reasons: failureReasons,
    metadata: {
      provider: result.provider,
      model: result.model,
      safety_notes: result.safety_notes,
      runtime: result.runtime,
      runtime_parity: result.runtime_parity,
      page_context: result.page_context,
      excluded_summary: result.excluded_summary,
    },
    created_by: userId,
  }).select('*').single();
  return data;
}

// RUN single test case
aiAgentRouter.post('/test-cases/:id/run', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: tc } = await sb.from('ai_agent_test_cases').select('*').eq('id', req.params.id).maybeSingle();
  if (!tc) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, tc.workspace_id);
  if (!auth) return;
  if (!checkE6TestRateLimit(tc.workspace_id, auth.userId)) {
    return res.status(429).json({ error: 'test_rate_limited', limit: E6_TEST_LIMIT, window_ms: E6_TEST_WINDOW });
  }
  try {
    const pc = tc.page_context || null;
    const result = await e6_runDryRunTest(config, {
      workspaceId: tc.workspace_id,
      message: tc.input_message,
      locale: tc.locale || undefined,
      pageContext: pc,
    });
    const evalResult = e6_evaluateExpectations(result, {
      workspaceId: tc.workspace_id,
      expected_behavior: tc.expected_behavior,
      expected_source_type: tc.expected_source_type,
      expected_source_url: tc.expected_source_url,
      expected_source_id: tc.expected_source_id,
      expected_contains: tc.expected_contains,
      expected_not_contains: tc.expected_not_contains,
      min_confidence: tc.min_confidence,
    });
    const run = await e6PersistTestRun(sb, tc.workspace_id, tc.id, auth.userId, result, evalResult, tc.input_message);
    return res.json({ run, result, evaluation: evalResult });
  } catch (err: any) {
    return res.status(500).json({ error: 'run_failed', details: err?.message });
  }
});

// BULK run
aiAgentRouter.post('/test-cases/run-bulk', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const schema = z.object({
    workspaceId: z.string().uuid(),
    ids: z.array(z.string().uuid()).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId, ids } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (ids && ids.length > E6_BULK_MAX_CASES) {
    return res.status(400).json({ error: 'bulk_too_many_cases', max: E6_BULK_MAX_CASES });
  }
  if (!checkE6BulkRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'bulk_test_rate_limited', limit: E6_BULK_LIMIT, window_ms: E6_BULK_WINDOW });
  }
  const sb = getServiceClient(config);
  let totalEnabled: number | null = null;
  let capped = false;
  let q = sb.from('ai_agent_test_cases').select('*').eq('workspace_id', workspaceId);
  if (ids && ids.length) {
    q = q.in('id', ids);
  } else {
    q = q.eq('enabled', true);
    const { count } = await sb.from('ai_agent_test_cases')
      .select('id', { count: 'exact', head: true })
      .eq('workspace_id', workspaceId).eq('enabled', true);
    totalEnabled = count ?? 0;
    if (totalEnabled > E6_BULK_MAX_CASES) capped = true;
  }
  const { data: cases, error } = await q.limit(E6_BULK_MAX_CASES);
  if (error) return res.status(500).json({ error: 'list_failed', details: error.message });
  const summary = {
    total: 0, passed: 0, failed: 0, errored: 0,
    capped, max: E6_BULK_MAX_CASES, total_enabled: totalEnabled,
    runs: [] as any[],
  };
  for (const tc of cases || []) {
    summary.total += 1;
    try {
      const result = await e6_runDryRunTest(config, {
        workspaceId, message: tc.input_message,
        locale: tc.locale || undefined, pageContext: tc.page_context || null,
      });
      const evalResult = e6_evaluateExpectations(result, {
        workspaceId,
        expected_behavior: tc.expected_behavior,
        expected_source_type: tc.expected_source_type,
        expected_source_url: tc.expected_source_url,
        expected_source_id: tc.expected_source_id,
        expected_contains: tc.expected_contains,
        expected_not_contains: tc.expected_not_contains,
        min_confidence: tc.min_confidence,
      });
      const run = await e6PersistTestRun(sb, workspaceId, tc.id, auth.userId, result, evalResult, tc.input_message);
      if (run?.status === 'passed') summary.passed += 1;
      else if (run?.status === 'errored') summary.errored += 1;
      else summary.failed += 1;
      summary.runs.push({ test_case_id: tc.id, name: tc.name, status: run?.status, failure_reasons: run?.failure_reasons });
    } catch (err: any) {
      summary.errored += 1;
      summary.runs.push({ test_case_id: tc.id, name: tc.name, status: 'errored', failure_reasons: [err?.message || 'errored'] });
    }
  }
  return res.json(summary);
});

// LIST runs
aiAgentRouter.get('/test-runs', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  let q = sb.from('ai_agent_test_runs').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false });
  if (req.query.testCaseId) q = q.eq('test_case_id', String(req.query.testCaseId));
  if (req.query.status) q = q.eq('status', String(req.query.status));
  const limit = Math.min(Number(req.query.limit) || 100, 500);
  const { data, error } = await q.limit(limit);
  if (error) return res.status(500).json({ error: 'list_failed', details: error.message });
  return res.json({ items: data || [] });
});

// GET single run (with linked test case for context)
aiAgentRouter.get('/test-runs/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const sb = getServiceClient(config);
  const { data: run } = await sb.from('ai_agent_test_runs').select('*').eq('id', req.params.id).maybeSingle();
  if (!run) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, run.workspace_id);
  if (!auth) return;
  let testCase: any = null;
  if (run.test_case_id) {
    const { data: tc } = await sb.from('ai_agent_test_cases').select('*').eq('id', run.test_case_id).maybeSingle();
    testCase = tc || null;
  }
  return res.json({ item: run, test_case: testCase });
});

// SEED recommended cases (idempotent on input_message + expected_behavior).
aiAgentRouter.post('/test-cases/seed-recommended', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const schema = z.object({ workspaceId: z.string().uuid() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) return res.status(403).json({ error: 'owner_or_admin_required' });
  const sb = getServiceClient(config);

  // Build a set of (source_type → set of source_ids) that have at least one
  // active+embedded chunk in this workspace. Reuses runtime eligibility rules.
  const { data: chunks } = await sb
    .from('ai_knowledge_chunks')
    .select('source_type, source_id, metadata')
    .eq('workspace_id', workspaceId)
    .eq('status', 'active')
    .not('embedding', 'is', null)
    .limit(2000);
  const activeBy: Record<string, Set<string>> = { qna: new Set(), learned_qna: new Set(), kb_article: new Set(), file: new Set(), web_page: new Set() };
  const webPageParents = new Map<string, { source_id: string; url: string | null; title: string | null }>();
  for (const c of (chunks || []) as any[]) {
    if (!activeBy[c.source_type]) continue;
    activeBy[c.source_type].add(String(c.source_id));
    if (c.source_type === 'web_page') {
      const m = c.metadata || {};
      const parent = String(m.parent_source_id || m.source_id || String(c.source_id).split(':')[0] || c.source_id);
      if (!webPageParents.has(String(c.source_id))) {
        webPageParents.set(String(c.source_id), {
          source_id: parent,
          url: (m.page_url || m.url || null) as string | null,
          title: (m.page_title || m.title || null) as string | null,
        });
      }
    }
  }

  const created: Array<{ name: string; expected_source_type: string | null; expected_source_id: string | null }> = [];
  const skippedReasons: string[] = [];

  // Existing dedup key: normalized message + behavior + source_type + source_id
  const { data: existing } = await sb.from('ai_agent_test_cases')
    .select('input_message,expected_behavior,expected_source_type,expected_source_id')
    .eq('workspace_id', workspaceId);
  const dedupKey = (m: string, b: string, st: string | null, sid: string | null) =>
    `${m.toLowerCase().trim()}|${b}|${st || ''}|${sid || ''}`;
  const existingKeys = new Set((existing || []).map((r: any) => dedupKey(r.input_message, r.expected_behavior, r.expected_source_type, r.expected_source_id)));

  const toInsert: any[] = [];
  function addCase(c: { name: string; input_message: string; expected_behavior: string; expected_source_type: string | null; expected_source_id: string | null; expected_source_url?: string | null; page_context?: any }) {
    const k = dedupKey(c.input_message, c.expected_behavior, c.expected_source_type, c.expected_source_id);
    if (existingKeys.has(k)) { skippedReasons.push(`duplicate:${c.name}`); return; }
    existingKeys.add(k);
    toInsert.push({
      workspace_id: workspaceId,
      created_by: auth.userId,
      enabled: true,
      name: c.name,
      input_message: c.input_message,
      expected_behavior: c.expected_behavior,
      expected_source_type: c.expected_source_type,
      expected_source_id: c.expected_source_id,
      expected_source_url: c.expected_source_url || null,
      page_context: c.page_context || null,
      expected_contains: [], expected_not_contains: [],
      metadata: { seeded: true, seed_version: 'e6h' },
    });
    created.push({ name: c.name, expected_source_type: c.expected_source_type, expected_source_id: c.expected_source_id });
  }

  // Q&A
  if (activeBy.qna.size) {
    const ids = Array.from(activeBy.qna).slice(0, 50);
    const { data: qna } = await sb.from('ai_agent_qna')
      .select('id, question').eq('workspace_id', workspaceId).neq('enabled', false).in('id', ids).limit(1);
    const row = (qna || [])[0];
    if (row) addCase({ name: `Q&A coverage: ${String(row.question).slice(0, 60)}`, input_message: row.question, expected_behavior: 'answer', expected_source_type: 'qna', expected_source_id: row.id });
    else skippedReasons.push('qna:no_eligible_row');
  } else { skippedReasons.push('qna:no_active_chunks'); }

  // Learned Q&A
  if (activeBy.learned_qna.size) {
    const ids = Array.from(activeBy.learned_qna).slice(0, 50);
    const { data: lq } = await sb.from('ai_agent_learning_candidates')
      .select('id, question_text, suggested_title').eq('workspace_id', workspaceId).eq('status', 'approved').in('id', ids).limit(1);
    const row = (lq || [])[0];
    if (row) {
      const msg = row.question_text || row.suggested_title || '';
      if (msg) addCase({ name: `Learned answer: ${String(row.suggested_title || msg).slice(0, 60)}`, input_message: msg, expected_behavior: 'answer', expected_source_type: 'learned_qna', expected_source_id: row.id });
      else skippedReasons.push('learned_qna:no_question_text');
    } else { skippedReasons.push('learned_qna:no_approved_row'); }
  } else { skippedReasons.push('learned_qna:no_active_chunks'); }

  // KB Article
  if (activeBy.kb_article.size) {
    const ids = Array.from(activeBy.kb_article).slice(0, 50);
    const { data: kb } = await sb.from('knowledge_base_articles')
      .select('id, title').eq('workspace_id', workspaceId).eq('status', 'published').in('id', ids).limit(1);
    const row = (kb || [])[0];
    if (row && row.title) addCase({ name: `KB article: ${String(row.title).slice(0, 60)}`, input_message: `Tell me about ${row.title}`, expected_behavior: 'answer', expected_source_type: 'kb_article', expected_source_id: row.id });
    else skippedReasons.push('kb_article:no_published_row');
  } else { skippedReasons.push('kb_article:no_active_chunks'); }

  // File
  if (activeBy.file.size) {
    const ids = Array.from(activeBy.file).slice(0, 50);
    const { data: files } = await sb.from('ai_data_sources')
      .select('id, name, metadata').eq('workspace_id', workspaceId).eq('source_type', 'file').eq('status', 'active').in('id', ids).limit(1);
    const row = (files || [])[0];
    if (row) {
      const meta = row.metadata || {};
      const title = row.name || meta.original_file_name || 'uploaded document';
      addCase({ name: `File coverage: ${String(title).slice(0, 60)}`, input_message: `What does the document "${title}" say?`, expected_behavior: 'answer', expected_source_type: 'file', expected_source_id: row.id });
    } else { skippedReasons.push('file:no_active_source_row'); }
  } else { skippedReasons.push('file:no_active_chunks'); }

  // Web page (chunk-level, parent must be active website)
  if (webPageParents.size) {
    const parentIds = Array.from(new Set(Array.from(webPageParents.values()).map((v) => v.source_id)));
    const { data: parents } = await sb.from('ai_data_sources')
      .select('id, name, status, metadata').eq('workspace_id', workspaceId).eq('source_type', 'website').eq('status', 'active').in('id', parentIds).limit(50);
    const activeParentIds = new Set((parents || []).map((p: any) => p.id));
    let chosen: { chunkSourceId: string; url: string | null; title: string | null } | null = null;
    for (const [chunkSourceId, info] of webPageParents.entries()) {
      if (activeParentIds.has(info.source_id)) { chosen = { chunkSourceId, url: info.url, title: info.title }; break; }
    }
    if (chosen) {
      const t = chosen.title || chosen.url || 'this page';
      addCase({ name: `Web page: ${String(t).slice(0, 60)}`, input_message: `Tell me about ${t}`, expected_behavior: 'answer', expected_source_type: 'web_page', expected_source_id: chosen.chunkSourceId, expected_source_url: chosen.url || null });
    } else { skippedReasons.push('web_page:no_active_parent_website'); }
  } else { skippedReasons.push('web_page:no_active_chunks'); }

  // Unknown question (always seed)
  addCase({ name: 'Unknown question (no answer expected)', input_message: 'What is the airspeed velocity of an unladen swallow on a Tuesday in 1842?', expected_behavior: 'no_answer', expected_source_type: null, expected_source_id: null });

  if (!toInsert.length) {
    return res.json({ inserted: 0, skipped: skippedReasons.length, created: [], skipped_reasons: skippedReasons });
  }
  const { data, error } = await sb.from('ai_agent_test_cases').insert(toInsert).select('id');
  if (error) return res.status(500).json({ error: 'seed_failed', details: error.message });
  return res.json({ inserted: data?.length || 0, skipped: skippedReasons.length, created, skipped_reasons: skippedReasons });
});

// SUMMARY
aiAgentRouter.get('/test-summary', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const sb = getServiceClient(config);
  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const [casesRes, recentRes] = await Promise.all([
    sb.from('ai_agent_test_cases').select('id,enabled,expected_source_type').eq('workspace_id', workspaceId),
    sb.from('ai_agent_test_runs').select('status,failure_reasons,selected_sources').eq('workspace_id', workspaceId).gte('created_at', since).limit(2000),
  ]);
  const cases = casesRes.data || [];
  const recent = recentRes.data || [];
  const last24Passed = recent.filter((r: any) => r.status === 'passed').length;
  const last24Failed = recent.filter((r: any) => r.status === 'failed').length;
  const last24Errored = recent.filter((r: any) => r.status === 'errored').length;
  const failuresByReason: Record<string, number> = {};
  for (const r of recent) {
    if (r.status === 'passed') continue;
    for (const reason of (r.failure_reasons || [])) {
      const key = String(reason).split(':')[0];
      failuresByReason[key] = (failuresByReason[key] || 0) + 1;
    }
  }
  const coverageByType: Record<string, number> = { qna: 0, learned_qna: 0, kb_article: 0, web_page: 0, file: 0 };
  for (const c of cases) {
    if (c.expected_source_type && coverageByType[c.expected_source_type] !== undefined) {
      coverageByType[c.expected_source_type] += 1;
    }
  }
  const total24 = recent.length;
  return res.json({
    total_cases: cases.length,
    enabled_cases: cases.filter((c: any) => c.enabled).length,
    last_24h_runs: total24,
    last_24h_passed: last24Passed,
    last_24h_failed: last24Failed,
    last_24h_errored: last24Errored,
    pass_rate: total24 ? Number((last24Passed / total24).toFixed(3)) : null,
    failures_by_reason: failuresByReason,
    coverage_by_source_type: coverageByType,
  });
});

// ─────────────────────────────────────────────────────────────────────
// E9 — Suggested regression test cases
// (operator-assist feedback + failed test runs → draft test cases)
//
// Hard rules:
//  - Workspace-scoped only.
//  - Read: workspace members. Generate: operator roles.
//    Accept/reject/delete: owner/admin only.
//  - No conversation_messages / handoff / workflow / learning side effects.
//  - No calls / LiveKit / widget-call code touched.
//  - No MCP / webhooks / external HTTP / Edge Functions.
//  - File expected_source_url is always null. All persisted text is redacted.
// ─────────────────────────────────────────────────────────────────────
const E9_OPERATOR_ROLES = new Set(['owner', 'admin', 'agent', 'support_agent', 'team_lead']);
function e9_canGenerateSuggestion(role: string | null, isAdmin: boolean): boolean {
  if (isAdmin) return true;
  return !!(role && E9_OPERATOR_ROLES.has(role));
}
function e9_canManageSuggestion(role: string | null, isAdmin: boolean): boolean {
  return isOwnerOrAdmin(role, isAdmin);
}

aiAgentRouter.get('/suggested-test-cases', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = String(req.query.workspaceId || '');
  if (!/^[0-9a-f-]{36}$/i.test(workspaceId)) return res.status(400).json({ error: 'invalid_workspace' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const status = req.query.status ? String(req.query.status) : 'pending';
  const valid = new Set(['pending', 'accepted', 'rejected', 'converted', 'all']);
  if (!valid.has(status)) return res.status(400).json({ error: 'invalid_status' });
  const sb = getServiceClient(config);
  try {
    const items = await e9_listSuggestedCases(sb, workspaceId, { status: status as any });
    return res.json({ items });
  } catch (err: any) {
    return res.status(500).json({ error: 'list_failed', details: err?.message });
  }
});

aiAgentRouter.post('/suggested-test-cases/from-feedback/:feedbackId', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const feedbackId = String(req.params.feedbackId);
  if (!/^[0-9a-f-]{36}$/i.test(feedbackId)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: fb } = await sb.from('ai_operator_assist_feedback').select('workspace_id').eq('id', feedbackId).maybeSingle();
  if (!fb) return res.status(404).json({ error: 'feedback_not_found' });
  const auth = await authorizeMember(req, res, config, fb.workspace_id);
  if (!auth) return;
  if (!e9_canGenerateSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'operator_permission_required' });
  }
  const result = await e9_suggestFromAssistFeedback(sb, fb.workspace_id, feedbackId, auth.userId);
  if (!result.ok) {
    const code = result.reason === 'duplicate' ? 409 : (result.reason?.startsWith('insert_failed') ? 500 : 400);
    return res.status(code).json({ error: result.reason || 'suggest_failed', duplicate_of: result.duplicate_of });
  }
  return res.json({ ok: true, suggestion: result.suggestion });
});

aiAgentRouter.post('/suggested-test-cases/from-test-run/:runId', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const runId = String(req.params.runId);
  if (!/^[0-9a-f-]{36}$/i.test(runId)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: run } = await sb.from('ai_agent_test_runs').select('workspace_id').eq('id', runId).maybeSingle();
  if (!run) return res.status(404).json({ error: 'run_not_found' });
  const auth = await authorizeMember(req, res, config, run.workspace_id);
  if (!auth) return;
  if (!e9_canGenerateSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'operator_permission_required' });
  }
  const result = await e9_suggestFromFailedTestRun(sb, run.workspace_id, runId, auth.userId);
  if (!result.ok) {
    const code = result.reason === 'duplicate' ? 409 : (result.reason?.startsWith('insert_failed') ? 500 : 400);
    return res.status(code).json({ error: result.reason || 'suggest_failed', duplicate_of: result.duplicate_of });
  }
  return res.json({ ok: true, suggestion: result.suggestion });
});

aiAgentRouter.post('/suggested-test-cases/:id/accept', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: row } = await sb.from('ai_agent_suggested_test_cases').select('workspace_id').eq('id', id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, row.workspace_id);
  if (!auth) return;
  if (!e9_canManageSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const overrides = (req.body && typeof req.body === 'object') ? req.body : {};
  // Strip workspace_id / id / status / source_* from overrides.
  const safeOverrides = { ...overrides };
  for (const k of ['id', 'workspace_id', 'status', 'source_type', 'source_id', 'created_by', 'reviewed_by', 'reviewed_at', 'created_at', 'updated_at']) {
    delete (safeOverrides as any)[k];
  }
  const result: any = await e9_acceptSuggestedCase(sb, id, auth.userId, safeOverrides);
  if (!result.ok) {
    const r = result.reason as string | undefined;
    return res.status(r === 'not_found' ? 404 : 400).json({ error: r });
  }
  return res.json({ ok: true, test_case_id: result.test_case_id });
});

aiAgentRouter.post('/suggested-test-cases/:id/reject', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: row } = await sb.from('ai_agent_suggested_test_cases').select('workspace_id').eq('id', id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, row.workspace_id);
  if (!auth) return;
  if (!e9_canManageSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const reason = req.body?.reason ? String(req.body.reason) : null;
  const result = await e9_rejectSuggestedCase(sb, id, auth.userId, reason);
  if (!result.ok) {
    return res.status(result.reason === 'not_found' ? 404 : 400).json({ error: result.reason });
  }
  return res.json({ ok: true });
});

aiAgentRouter.delete('/suggested-test-cases/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: row } = await sb.from('ai_agent_suggested_test_cases').select('workspace_id').eq('id', id).maybeSingle();
  if (!row) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, row.workspace_id);
  if (!auth) return;
  if (!e9_canManageSuggestion(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const { error } = await sb.from('ai_agent_suggested_test_cases').delete().eq('id', id);
  if (error) return res.status(500).json({ error: 'delete_failed', details: error.message });
  return res.json({ ok: true });
});

// ─── E10 — Scheduled regression runs ─────────────────────────────────

aiAgentRouter.get('/regression/schedules', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  try {
    const items = await e10_listSchedules(config, workspaceId);
    return res.json({ items });
  } catch (e: any) {
    return res.status(500).json({ error: 'list_failed', details: e?.message });
  }
});

aiAgentRouter.post('/regression/schedules/default', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  try {
    const item = await e10_getOrCreateSchedule(config, workspaceId, auth.userId);
    return res.json({ item });
  } catch (e: any) {
    return res.status(500).json({ error: 'create_failed', details: e?.message });
  }
});

aiAgentRouter.patch('/regression/schedules/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_regression_schedules').select('workspace_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  try {
    const item = await e10_updateSchedule(config, id, req.body || {}, auth.userId);
    return res.json({ item });
  } catch (e: any) {
    return res.status(400).json({ error: 'update_failed', details: e?.message });
  }
});

aiAgentRouter.get('/regression/batches', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  const limitRaw = parseInt(String(req.query.limit || '50'), 10);
  const offsetRaw = parseInt(String(req.query.offset || '0'), 10);
  const allowedStatus = new Set(['queued','running','completed','failed','cancelled']);
  const allowedTrigger = new Set(['manual','scheduled']);
  const status = allowedStatus.has(String(req.query.status)) ? String(req.query.status) as any : null;
  const triggerType = allowedTrigger.has(String(req.query.trigger_type)) ? String(req.query.trigger_type) as any : null;
  const scheduleId = typeof req.query.schedule_id === 'string' && /^[0-9a-f-]{36}$/i.test(req.query.schedule_id) ? req.query.schedule_id : null;
  const dateFrom = typeof req.query.date_from === 'string' ? req.query.date_from : null;
  const dateTo = typeof req.query.date_to === 'string' ? req.query.date_to : null;
  const onlyFailed = String(req.query.only_failed || '') === 'true';
  try {
    const r = await e10_listBatches(config, workspaceId, {
      limit: isFinite(limitRaw) ? limitRaw : 50,
      offset: isFinite(offsetRaw) ? offsetRaw : 0,
      status, triggerType, scheduleId, dateFrom, dateTo, onlyFailed,
    });
    return res.json(r);
  } catch (e: any) {
    return res.status(500).json({ error: 'list_failed', details: e?.message });
  }
});

aiAgentRouter.get('/regression/batches/:id', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  try {
    const detail = await e10_getBatchDetail(config, id);
    if (!detail) return res.status(404).json({ error: 'not_found' });
    const auth = await authorizeMember(req, res, config, detail.batch.workspace_id);
    if (!auth) return;
    // E11.1 — enrich runs with selected_source_summary, build runs_by_status
    // map, expose progress + retry_of_batch_id from batch metadata.
    const rawRuns = (detail.runs || []) as any[];
    const runs_by_status: { errored: any[]; failed: any[]; passed: any[] } = {
      errored: [], failed: [], passed: [],
    };
    const enrichedRuns = rawRuns.map((r) => {
      const ss: any[] = Array.isArray(r.selected_sources) ? r.selected_sources : [];
      const source_types = Array.from(new Set(ss.map((s) => s?.source_type).filter(Boolean))) as string[];
      const top_titles = ss.map((s) => (typeof s?.title === 'string' ? s.title : null)).filter(Boolean).slice(0, 8) as string[];
      const selected_source_summary = { source_types, top_titles, count: ss.length };
      return { ...r, selected_source_summary };
    });
    for (const r of enrichedRuns) {
      if (r.status === 'errored') runs_by_status.errored.push(r);
      else if (r.status === 'failed') runs_by_status.failed.push(r);
      else if (r.status === 'passed') runs_by_status.passed.push(r);
    }
    const meta = ((detail.batch as any).metadata || {}) as Record<string, any>;
    const progress = {
      current_case_index: meta.current_case_index ?? null,
      current_test_case_id: meta.current_test_case_id ?? null,
      current_test_case_name: meta.current_test_case_name ?? null,
      duration_ms: meta.duration_ms ?? null,
      avg_case_duration_ms: meta.avg_case_duration_ms ?? null,
    };
    return res.json({
      batch: detail.batch,
      runs: enrichedRuns,
      runs_by_status,
      progress,
      retry_of_batch_id: meta.retry_of_batch_id ?? null,
      retryChildren: (detail as any).retryChildren || [],
      summary: {
        total: detail.batch.total_cases,
        passed: detail.batch.passed,
        failed: detail.batch.failed,
        errored: detail.batch.errored,
        pass_rate: detail.batch.pass_rate,
      },
    });
  } catch (e: any) {
    return res.status(500).json({ error: 'detail_failed', details: e?.message });
  }
});

aiAgentRouter.post('/regression/run-now', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const schema = z.object({
    workspaceId: z.string().uuid(),
    scheduleId: z.string().uuid().optional().nullable(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const { workspaceId, scheduleId } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  try {
    const batch = await e10_enqueueBatch(config, {
      workspaceId,
      scheduleId: scheduleId || null,
      triggerType: 'manual',
      actorId: auth.userId,
    });
    return res.json({ batch });
  } catch (e: any) {
    return res.status(500).json({ error: 'enqueue_failed', details: e?.message });
  }
});

aiAgentRouter.post('/regression/batches/:id/run', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_regression_batches').select('workspace_id,status').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  if (existing.status !== 'queued') {
    return res.status(409).json({ error: 'batch_not_queued', status: existing.status });
  }
  const claimed = await e10_claimBatch(sb, id);
  if (!claimed) return res.status(409).json({ error: 'claim_lost' });
  try {
    const result = await e10_runBatch(config, id);
    return res.json({ ok: true, result });
  } catch (e: any) {
    await sb.from('ai_agent_regression_batches').update({
      status: 'failed',
      finished_at: new Date().toISOString(),
      last_error: String(e?.message || 'unknown'),
    }).eq('id', id);
    return res.status(500).json({ error: 'run_failed', details: e?.message });
  }
});

aiAgentRouter.post('/regression/batches/:id/cancel', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_regression_batches').select('workspace_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const r = await e10_cancelBatch(config, id, auth.userId);
  if (!r.ok) return res.status(400).json({ error: r.error || 'cancel_failed' });
  return res.json({ ok: true, status: r.status, idempotent: !!r.idempotent });
});

aiAgentRouter.post('/regression/batches/:id/retry-failed', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const sb = getServiceClient(config);
  const { data: existing } = await sb.from('ai_agent_regression_batches').select('workspace_id').eq('id', id).maybeSingle();
  if (!existing) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, existing.workspace_id);
  if (!auth) return;
  if (!isOwnerOrAdmin(auth.role, auth.isAdmin)) {
    return res.status(403).json({ error: 'owner_or_admin_required' });
  }
  const r = await e10_retryFailed(config, id, auth.userId);
  if (!r.ok) {
    const code = r.error === 'no_failed_cases' ? 400 : 500;
    return res.status(code).json({ error: r.error || 'retry_failed' });
  }
  return res.json({ batch: r.batch });
});

// ─── E11 — Regression observability ───

aiAgentRouter.get('/regression/overview', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = requireWorkspace(req);
  if (!workspaceId) return res.status(400).json({ error: 'workspaceId_required' });
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  try {
    const overview = await e11_getOverview(config, workspaceId);
    return res.json(overview);
  } catch (e: any) {
    return res.status(500).json({ error: 'overview_failed', details: e?.message });
  }
});

aiAgentRouter.get('/regression/batches/:id/export.csv', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const id = String(req.params.id);
  if (!/^[0-9a-f-]{36}$/i.test(id)) return res.status(400).json({ error: 'invalid_id' });
  const r = await e11_exportBatchCsv(config, id);
  if (!r) return res.status(404).json({ error: 'not_found' });
  const auth = await authorizeMember(req, res, config, r.workspaceId);
  if (!auth) return;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${r.filename}"`);
  return res.send(r.csv);
});

// ─── Customer-safe Test AI ───
// Wraps runDryRunTest. Returns ONLY action/answer/confidence-bucket/source-titles.
// Never returns retrieval_debug, prompt_preview, source ids, raw scores, chunks,
// embeddings, or storage paths. Respects show_sources_to_operator.
const customerTestAiSchema = z.object({
  workspaceId: z.string().uuid(),
  message: z.string().min(1).max(2000),
  locale: z.string().max(10).optional(),
  pageContext: z.object({
    currentPageUrl: z.string().max(2000).nullable().optional(),
    currentPageOrigin: z.string().max(500).nullable().optional(),
    currentPagePath: z.string().max(1000).nullable().optional(),
    currentPageTitle: z.string().max(500).nullable().optional(),
  }).nullish(),
});
function confidenceBucketLabel(c: number): 'low' | 'medium' | 'high' {
  if (c >= 0.7) return 'high';
  if (c >= 0.4) return 'medium';
  return 'low';
}
function friendlyTestAiReason(action: string, status: string): string {
  if (action === 'answer') return 'A confident answer was generated from your knowledge.';
  if (action === 'clarification') return 'The AI needs more details before it can answer.';
  if (action === 'handoff') return 'The AI would transfer this conversation to a human operator.';
  if (action === 'no_answer') return 'No matching knowledge was found.';
  if (status === 'failed') return 'The test could not be completed. Please try again.';
  return 'The AI evaluated this message.';
}
aiAgentRouter.post('/test-ai', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = customerTestAiSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_params', details: parsed.error.flatten().fieldErrors });
  }
  const { workspaceId, message, locale, pageContext } = parsed.data;
  const auth = await authorizeMember(req, res, config, workspaceId);
  if (!auth) return;
  if (!checkPlaygroundRateLimit(workspaceId, auth.userId)) {
    return res.status(429).json({ error: 'test_ai_rate_limited' });
  }
  try {
    const settings = await getOrCreateSettings(config, workspaceId);
    const result = await e6_runDryRunTest(config, {
      workspaceId,
      message,
      locale: locale || undefined,
      pageContext: pageContext || null,
      callLLM: true,
    });
    const action = result.answer_strategy?.action || 'no_answer';
    const showSources = !!settings.show_sources_to_operator;
    const sources = showSources
      ? (result.selected_sources || []).slice(0, 5).map((s) => ({
          title: s.title || '(untitled)',
          source_type: s.source_type,
        }))
      : [];
    return res.json({
      action,
      answer: result.output_text || null,
      confidence_bucket: confidenceBucketLabel(result.confidence || 0),
      reason: friendlyTestAiReason(action, result.status),
      sources,
      sources_hidden: !showSources,
      // explicit absence of internal fields
      retrieval_debug: undefined,
      prompt_preview: undefined,
    });
  } catch (err: any) {
    return res.status(500).json({ error: 'test_ai_failed', details: err?.message });
  }
});

// ─── Customer-safe Knowledge summary ───
// Returns the same friendly per-source items KnowledgePage needs, without
// exposing any internal counts/metadata. Source-health remains advanced-only.
aiAgentRouter.get('/knowledge/customer-summary', async (req: Request, res: Response) => {
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
