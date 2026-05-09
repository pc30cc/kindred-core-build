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
import { getServiceClient } from '../../supabase.js';
import { isGlobalAdmin } from '../../middleware/adminBypass.js';
import { getPlatformAiAgentSettings } from './platformSettings.js';

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
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  try {
    const platform = await getPlatformAiAgentSettings(config);
    if (!platform.ai_agent_enabled) {
      return { ok: false, status: 403, error: 'ai_agent_platform_disabled' };
    }
    if (opts.customerFacing && !platform.customer_ai_agent_visible) {
      return { ok: false, status: 403, error: 'ai_agent_platform_disabled' };
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
        return { ok: false, status: 403, error: 'ai_agent_platform_disabled' };
      }
    }
    return { ok: true };
  } catch {
    return { ok: true }; // table missing → fail open
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
  const tableMap: Record<string, string> = {
    'files': 'ai_agent_files',
    'data-sources': 'ai_data_sources',
    'qna': 'ai_agent_qna',
    'learning-candidates': 'ai_agent_learning_candidates',
    'test-cases': 'ai_agent_test_cases',
    'test-runs': 'ai_agent_test_runs',
    'operator-assist': 'ai_agent_runs',
  };
  const table = tableMap[resource];
  if (!table) return null;
  try {
    const sb = getServiceClient(config);
    const { data } = await sb
      .from(table as any)
      .select('workspace_id')
      .eq('id', id)
      .maybeSingle();
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

    // Kill switch: applies whenever we have any AI Agent context.
    const killCheck = await assertAiAgentPlatformEnabledForWorkspace(
      config,
      workspaceId,
      { customerFacing: true },
    );
    if (!('ok' in killCheck) || killCheck.ok !== true) {
      const err = killCheck as { status: number; error: string };
      return res.status(err.status).json({ error: err.error });
    }

    // Per-feature toggle.
    const matched = FEATURE_ROUTES.find((r) => r.rx.test(req.path));
    if (matched) {
      // Resolve user (best-effort) for super-admin bypass on advanced features.
      let userId: string | null = null;
      try {
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          const token = authHeader.replace('Bearer ', '').trim();
          if (token) {
            const sb = getServiceClient(config);
            const { data: { user } } = await sb.auth.getUser(token);
            userId = user?.id || null;
          }
        }
      } catch { /* ignore */ }
      const featCheck = await assertFeatureEnabled(config, matched.feature, { userId });
      if (!('ok' in featCheck) || featCheck.ok !== true) {
        const err = featCheck as { status: number; error: string };
        return res.status(err.status).json({ error: err.error });
      }
    }
    return next();
  };
}