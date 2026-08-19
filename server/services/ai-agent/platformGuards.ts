/**
 * E12-Fix Phase 2 + 3 — Central platform kill-switch + per-feature
 * backend enforcement helpers and a path-based Express middleware.
 *
 * SELF-HOSTED. PROVIDER-AGNOSTIC.
 * No new writes to conversation_messages, ai_handoff_*, workflows, or
 * learning_candidates from this module.
 */
import type { Request, Response, NextFunction } from 'express';
import type { ServerConfig } from '../../config.js';
import { checkModuleAccess } from '../../middleware/featureGating.js';
import { getServiceClient } from '../../supabase.js';
import { isGlobalAdmin } from '../../middleware/adminBypass.js';
import { getPlatformAiAgentSettings, isPlatformSettingsLookupFailed } from './platformSettings.js';
import { validateSessionToken, SESSION_COOKIE_NAME } from '../auth/sessions.js';

/** Transient, retryable: platform AI state could not be resolved. */
export const PLATFORM_STATUS_UNAVAILABLE = 'ai_platform_status_unavailable';

export type PlatformFeatureKey =
  | 'operator_assist'
  | 'auto_answer'
  | 'learning'
  | 'files'
  | 'websites'
  | 'qna'
  | 'kb'
  | 'regression'
  | 'test_harness'
  | 'source_health';

/** Maps a feature key to (settings flag name, error code) */
const FEATURE_FLAG: Record<
  PlatformFeatureKey,
  { flag: string; error: string; customerVisibilityFlag?: string }
> = {
  operator_assist: { flag: 'operator_assist_enabled', error: 'operator_assist_disabled_by_platform' },
  auto_answer:    { flag: 'auto_answer_enabled',     error: 'auto_answer_disabled_by_platform' },
  learning:       { flag: 'learning_enabled',        error: 'learning_disabled_by_platform' },
  files:          { flag: 'files_enabled',           error: 'files_disabled_by_platform' },
  websites:       { flag: 'websites_enabled',        error: 'websites_disabled_by_platform' },
  qna:            { flag: 'qna_enabled',             error: 'qna_disabled_by_platform' },
  kb:             { flag: 'kb_enabled',              error: 'kb_disabled_by_platform' },
  regression:     { flag: 'regression_runner_enabled', error: 'regression_disabled_by_platform' },
  test_harness:   { flag: 'advanced_tools_enabled',  error: 'test_harness_disabled_by_platform', customerVisibilityFlag: 'test_harness_visible_to_customers' },
  source_health:  { flag: 'advanced_tools_enabled',  error: 'source_health_disabled_by_platform', customerVisibilityFlag: 'source_health_visible_to_customers' },
};

/**
 * Throws (via res.status().json + return false) if AI Agent platform is
 * disabled. Returns true when the request may proceed.
 * Default-open ONLY when the platform settings table is missing entirely
 * (fail-open for greenfield self-host installs); a row that says disabled
 * is honored.
 */
export async function assertAiAgentPlatformEnabledForWorkspace(
  config: ServerConfig,
  workspaceId: string,
  opts: { customerFacing?: boolean } = {},
): Promise<{ ok: true } | { ok: false; status: number; error: string; reason?: 'kill_switch' | 'customer_hidden' | 'workspace_disabled' | 'lookup_failed' }> {
  // Phase 6-S5-R6 — an UNRESOLVED platform lookup is reported as its own
  // 503 `ai_platform_status_unavailable`, never conflated with a deliberate
  // 403 kill switch. Callers must surface the transient nature to the client.
  try {
    const platform = await getPlatformAiAgentSettings(config);
    // Phase 6-S5-R4 — an UNRESOLVED settings lookup is not "enabled".
    // Only a genuinely missing table defaults open (handled upstream).
    if (isPlatformSettingsLookupFailed(platform)) {
      return { ok: false, status: 503, error: PLATFORM_STATUS_UNAVAILABLE, reason: 'lookup_failed' };
    }
    if (!platform.ai_agent_enabled) {
      return { ok: false, status: 403, error: 'ai_agent_platform_disabled', reason: 'kill_switch' };
    }
    if (opts.customerFacing && !platform.customer_ai_agent_visible) {
      return { ok: false, status: 403, error: 'ai_agent_platform_disabled', reason: 'customer_hidden' };
    }
    if (workspaceId) {
      const sb = getServiceClient(config);
      const { data: row, error } = await sb
        .from('ai_agent_settings')
        .select('metadata')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      // Fail closed: we cannot prove the workspace is NOT disabled.
      if (error) {
        return { ok: false, status: 503, error: PLATFORM_STATUS_UNAVAILABLE, reason: 'lookup_failed' };
      }
      const meta = ((row as any)?.metadata || {}) as Record<string, unknown>;
      if (meta.platform_disabled === true) {
        return { ok: false, status: 403, error: 'ai_agent_platform_disabled', reason: 'workspace_disabled' };
      }
    }
    return { ok: true };
  } catch {
    // Unexpected failure while evaluating a security gate → fail CLOSED.
    return { ok: false, status: 503, error: PLATFORM_STATUS_UNAVAILABLE, reason: 'lookup_failed' };
  }
}

/**
 * Per-feature platform gate. Super admins bypass for advanced features
 * (test_harness, source_health, regression) so they can keep operating.
 */
export async function assertFeatureEnabled(
  config: ServerConfig,
  feature: PlatformFeatureKey,
  opts: { userId?: string | null } = {},
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const platform = await getPlatformAiAgentSettings(config) as any;
    const def = FEATURE_FLAG[feature];
    const enabled = !!platform[def.flag];
    const isAdmin = opts.userId
      ? await isGlobalAdmin(config, opts.userId).catch(() => false)
      : false;

    if (feature === 'test_harness' || feature === 'source_health') {
      // Allowed when: admin OR (advanced_tools_enabled AND customer-visibility flag).
      if (isAdmin) return { ok: true };
      const customerOk =
        enabled &&
        !!platform[def.customerVisibilityFlag as string];
      return customerOk
        ? { ok: true }
        : { ok: false, status: 403, error: def.error };
    }
    if (feature === 'regression') {
      if (isAdmin) return { ok: true };
      return enabled
        ? { ok: true }
        : { ok: false, status: 403, error: def.error };
    }
    return enabled
      ? { ok: true }
      : { ok: false, status: 403, error: def.error };
  } catch {
    return { ok: true };
  }
}

/** Path patterns → feature key. Matched against req.path. */
const FEATURE_ROUTES: Array<{ rx: RegExp; feature: PlatformFeatureKey }> = [
  // Files
  { rx: /^\/files(\/|$)/, feature: 'files' },
  // Website data sources (websites + crawl/sync)
  { rx: /^\/data-sources(\/|$)/, feature: 'websites' },
  // Q&A
  { rx: /^\/qna(\/|$)/, feature: 'qna' },
  // Learning candidates
  { rx: /^\/learning-candidates(\/|$)/, feature: 'learning' },
  // Operator assist
  { rx: /^\/operator-assist(\/|$)/, feature: 'operator_assist' },
  { rx: /^\/operator\/suggest-reply$/, feature: 'operator_assist' },
  { rx: /^\/conversations\/[^/]+\/suggestions$/, feature: 'operator_assist' },
  { rx: /^\/suggestions\/[^/]+\/(use|dismiss)$/, feature: 'operator_assist' },
  // Knowledge index (KB)
  { rx: /^\/knowledge-index(\/|$)/, feature: 'kb' },
  { rx: /^\/train(\/|$)/, feature: 'kb' },
  // Regression runner
  { rx: /^\/regression(\/|$)/, feature: 'regression' },
  // Test harness
  { rx: /^\/test-cases(\/|$)/, feature: 'test_harness' },
  { rx: /^\/test-runs(\/|$)/, feature: 'test_harness' },
  { rx: /^\/suggested-test-cases(\/|$)/, feature: 'test_harness' },
  { rx: /^\/test-summary$/, feature: 'test_harness' },
  { rx: /^\/debug\/run-test$/, feature: 'test_harness' },
  { rx: /^\/playground\/test$/, feature: 'auto_answer' },
  // Source health
  { rx: /^\/source-health$/, feature: 'source_health' },
  // Retrieval debug
  { rx: /^\/debug\/retrieval$/, feature: 'test_harness' },
  // Suggested test cases
  { rx: /^\/suggested-test-cases(\/|$)/, feature: 'test_harness' },
];

/** Best-effort workspace_id resolver from common `:id` route params. */
async function resolveWorkspaceFromIdParam(
  config: ServerConfig,
  reqPath: string,
): Promise<string | null> {
  // Match /<resource>/<id>(/...)
  const m = reqPath.match(/^\/([^/]+)\/([0-9a-fA-F-]{36})(\/|$)/);
  if (!m) return null;
  const resource = m[1];
  const id = m[2];
  // NOTE: file uploads live in ai_data_sources with source_type='file'.
  // There is no separate ai_agent_files table in this schema.
  const tableMap: Record<string, { table: string; filter?: { col: string; eq: string } }> = {
    'files': { table: 'ai_data_sources', filter: { col: 'source_type', eq: 'file' } },
    'data-sources': { table: 'ai_data_sources' },
    'qna': 'ai_agent_qna',
    'learning-candidates': 'ai_agent_learning_candidates',
    'test-cases': 'ai_agent_test_cases',
    'test-runs': 'ai_agent_test_runs',
    'suggested-test-cases': 'ai_agent_suggested_test_cases',
    'operator-assist': 'ai_agent_runs',
    'conversations': 'conversations',
    'suggestions': 'ai_agent_suggestions',
    'guidance': 'ai_agent_guidance_rules',
    'routing': 'ai_agent_routing_rules',
    'topics': 'ai_agent_topics',
    'workflows': 'ai_agent_workflows',
    'message-triggers': 'ai_agent_message_triggers',
    'tools': 'ai_agent_tools',
    'tool-servers': 'ai_agent_tool_servers',
    'runs': 'ai_agent_runs',
  } as any;
  const entry = (tableMap as any)[resource];
  if (!entry) return null;
  const table = typeof entry === 'string' ? entry : entry.table;
  const filter = typeof entry === 'string' ? null : entry.filter || null;
  try {
    const sb = getServiceClient(config);
    let q: any = sb
      .from(table as any)
      .select('workspace_id')
      .eq('id', id);
    if (filter) q = q.eq(filter.col, filter.eq);
    const { data } = await q.maybeSingle();
    return ((data as any)?.workspace_id as string) || null;
  } catch {
    return null;
  }
}

/**
 * Combined kill-switch + per-feature path middleware.
 * Skips: /capabilities, /platform/*, /settings (avatar etc handled separately
 * by their own auth code paths but kill switch still applies via direct
 * workspace param).
 */
export function aiAgentPlatformGuard() {
  return async (req: Request, res: Response, next: NextFunction) => {
    // Always allow capabilities + platform settings + admin debug.
    if (req.path === '/capabilities' || req.path.startsWith('/platform/')) {
      return next();
    }

    // Routes that legitimately don't need a workspace context.
    // Anything not on this list MUST resolve a workspaceId or fail closed.
    const WORKSPACE_EXEMPT: RegExp[] = [
      /^\/workflows\/_meta$/,
    ];
    const isWorkspaceExempt = WORKSPACE_EXEMPT.some((rx) => rx.test(req.path));

    const config = (req as any).serverConfig as ServerConfig;

    // Resolve workspaceId: prefer query/body, else look up by :id.
    let workspaceId =
      String(
        req.query.workspaceId ||
          req.query.workspace_id ||
          (req.body && req.body.workspaceId) ||
          '',
      ) || '';
    if (!workspaceId) {
      const fromId = await resolveWorkspaceFromIdParam(config, req.path);
      if (fromId) workspaceId = fromId;
    }

    // Phase 1 — strict resolution. Workspace-scoped routes that cannot
    // resolve a workspaceId must NEVER fall through silently; treat as
    // a controlled error so the platform kill-switch + per-feature gates
    // cannot be bypassed via missing context.
    if (!workspaceId && !isWorkspaceExempt) {
      return res.status(400).json({ error: 'ai_agent_workspace_unresolved' });
    }

    // Resolve caller user (best-effort) early so we can:
    //   1. let super admins bypass `customer_ai_agent_visible=false` for diagnostics
    //   2. let super admins bypass advanced/regression/test_harness gates
    // BUT: super admins NEVER bypass `ai_agent_enabled=false` (true kill switch).
    let userId: string | null = null;
    try {
      const token = (req as any).cookies?.[SESSION_COOKIE_NAME];
      const session = await validateSessionToken(config, token);
      userId = session?.userId || null;
    } catch { /* ignore */ }
    const isAdmin = userId
      ? await isGlobalAdmin(config, userId).catch(() => false)
      : false;

    // Kill switch: applies whenever we have any AI Agent context.
    const killCheck = await assertAiAgentPlatformEnabledForWorkspace(
      config,
      workspaceId,
      { customerFacing: true },
    );
    if (!('ok' in killCheck) || killCheck.ok !== true) {
      const err = killCheck as { status: number; error: string; reason?: string };
      // Super admin diagnostic bypass: customer-hidden only, never the
      // hard kill-switch and never workspace-level disable.
      if (isAdmin && err.reason === 'customer_hidden') {
        // fall through
      } else {
        return res.status(err.status).json({ error: err.error });
      }
    }

    // ── Phase 6-S5-R1 — CENTRAL customer AI plan enforcement. ──
    // Every customer-facing AI route requires the `ai_assistant` module.
    // Super admins bypass for platform administration/diagnostics only.
    if (workspaceId && !isAdmin) {
      const planAccess = await checkModuleAccess(
        config.supabaseUrl,
        config.supabaseServiceRoleKey,
        workspaceId,
        'ai_assistant',
      ).catch(() => ({ allowed: false, plan: undefined }));
      if (!planAccess.allowed) {
        return res.status(403).json({
          error: 'ai_assistant_plan_required',
          module: 'ai_assistant',
          plan: (planAccess as { plan?: string }).plan ?? null,
          upgrade_required: true,
        });
      }
    }

    // Per-feature toggle.
    const matched = FEATURE_ROUTES.find((r) => r.rx.test(req.path));
    if (matched) {
      const featCheck = await assertFeatureEnabled(config, matched.feature, { userId });
      if (!('ok' in featCheck) || featCheck.ok !== true) {
        const err = featCheck as { status: number; error: string };
        return res.status(err.status).json({ error: err.error });
      }
    }
    return next();
  };
}

/**
 * Visitor-runtime helper (used by the engine, not by the Express middleware).
 * Returns whether AI auto-answer is allowed RIGHT NOW for this workspace.
 * Honors the global kill switch AND the auto_answer feature toggle. Never
 * throws — always returns a verdict so the engine can record skip reasons.
 */
export async function isAutoAnswerAllowedForWorkspace(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  try {
    const platform = await getPlatformAiAgentSettings(config) as any;
    if (!platform.ai_agent_enabled) {
      return { allowed: false, reason: 'ai_agent_platform_disabled' };
    }
    if (!platform.auto_answer_enabled) {
      return { allowed: false, reason: 'auto_answer_disabled_by_platform' };
    }
    if (workspaceId) {
      // Phase 6-S5 — plan gate: no AI auto-answer without the `ai_assistant`
      // module. Fail-closed on lookup problems.
      const planAccess = await checkModuleAccess(
        config.supabaseUrl,
        config.supabaseServiceRoleKey,
        workspaceId,
        'ai_assistant',
      ).catch(() => ({ allowed: false }));
      if (!planAccess.allowed) {
        return { allowed: false, reason: 'ai_assistant_plan_required' };
      }
    }
    if (workspaceId) {
      const sb = getServiceClient(config);
      const { data: row } = await sb
        .from('ai_agent_settings')
        .select('metadata')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      const meta = ((row as any)?.metadata || {}) as Record<string, unknown>;
      if (meta.platform_disabled === true) {
        return { allowed: false, reason: 'ai_agent_platform_disabled' };
      }
    }
    return { allowed: true };
  } catch {
    // Fail-closed: an unexpected error must not enable AI auto-answer.
    return { allowed: false, reason: 'auto_answer_guard_error' };
  }
}