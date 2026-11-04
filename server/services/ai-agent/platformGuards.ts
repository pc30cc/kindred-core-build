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
import {
  getPlatformAiAgentSettings,
  isPlatformSettingsLookupFailed,
  type PlatformAiAgentSettings,
} from './platformSettings.js';
import { validateSessionToken, SESSION_COOKIE_NAME } from '../auth/sessions.js';
import { readSessionToken } from '../../lib/sessionTransport.js';

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

/**
 * The Advanced tools' features. A plan feature since 2026-11-03 (owner):
 * the advanced-tools guard of server/routes/ai-agent/index.ts, which runs
 * before this one on every one of their routes, opens them (the Super
 * Admin, or the plan's `ai_advanced_tools` and the workspace's owner or an
 * admin; shared/aiAdvancedTools.ts). The platform switches that used to
 * decide them for customers (advanced_tools_enabled, regression_runner_enabled,
 * source_health_visible_to_customers, test_harness_visible_to_customers)
 * no longer open or close anything: a plan with the key gets every tab.
 */
type AdvancedFeatureKey = 'regression' | 'test_harness' | 'source_health';
const ADVANCED_FEATURES: ReadonlySet<PlatformFeatureKey> = new Set<AdvancedFeatureKey>([
  'regression',
  'test_harness',
  'source_health',
]);

/** Maps a platform-switched feature key to (settings flag name, error code). */
const FEATURE_FLAG: Record<
  Exclude<PlatformFeatureKey, AdvancedFeatureKey>,
  { flag: keyof PlatformAiAgentSettings; error: string }
> = {
  operator_assist: { flag: 'operator_assist_enabled', error: 'operator_assist_disabled_by_platform' },
  auto_answer:    { flag: 'auto_answer_enabled',     error: 'auto_answer_disabled_by_platform' },
  learning:       { flag: 'learning_enabled',        error: 'learning_disabled_by_platform' },
  files:          { flag: 'files_enabled',           error: 'files_disabled_by_platform' },
  websites:       { flag: 'websites_enabled',        error: 'websites_disabled_by_platform' },
  qna:            { flag: 'qna_enabled',             error: 'qna_disabled_by_platform' },
  kb:             { flag: 'kb_enabled',              error: 'kb_disabled_by_platform' },
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
      const meta = ((row as { metadata?: unknown } | null)?.metadata || {}) as Record<string, unknown>;
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
 * Per-feature platform gate: the Super Admin's per-feature switches. The
 * Advanced tools' features (regression, test harness, source health) are not
 * switched here any more: their guard is the plan rule (ADVANCED_FEATURES
 * above), so they always pass this one. `opts.userId` is kept for callers.
 */
export async function assertFeatureEnabled(
  config: ServerConfig,
  feature: PlatformFeatureKey,
  _opts: { userId?: string | null } = {},
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (ADVANCED_FEATURES.has(feature)) return { ok: true };
  try {
    const platform = await getPlatformAiAgentSettings(config);
    const def = FEATURE_FLAG[feature as Exclude<PlatformFeatureKey, AdvancedFeatureKey>];
    return platform[def.flag]
      ? { ok: true }
      : { ok: false, status: 403, error: def.error };
  } catch {
    return { ok: true };
  }
}

/** Path patterns → feature key. Matched against normalizeAiAgentGuardPath(req.path). */
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

/**
 * The AI Agent resources a path names by id below another segment, and the
 * table that says whose workspace each belongs to: regression batches and
 * schedules, and the suggestions made from an operator-assist feedback or a
 * test run. Checked before the flat `/<resource>/<id>` map below, which
 * cannot read them (its second segment is not an id).
 */
const NESTED_RESOURCE_ROUTES: Array<{ rx: RegExp; table: string }> = [
  { rx: /^\/regression\/batches\/([^/]+)(\/|$)/i, table: 'ai_agent_regression_batches' },
  { rx: /^\/regression\/schedules\/([^/]+)(\/|$)/i, table: 'ai_agent_regression_schedules' },
  { rx: /^\/suggested-test-cases\/from-feedback\/([^/]+)(\/|$)/i, table: 'ai_operator_assist_feedback' },
  { rx: /^\/suggested-test-cases\/from-test-run\/([^/]+)(\/|$)/i, table: 'ai_agent_test_runs' },
];

/**
 * The id a path segment names, read as its route handler will read it:
 * Express hands `req.params` percent-decoded, and Postgres takes a uuid in
 * any case, with or without its hyphens, in braces. So the segment is
 * decoded, and anything uuid-shaped (32 hex digits among hyphens, braces or
 * spaces) is an id, looked up as written: the same row the handler reads.
 * Matching only the canonical 36-character form let a re-spelled id
 * (`%62…`, no hyphens, `{…}`) skip the lookup, so the guard judged the
 * workspace the query named while the handler read another one's row.
 * null: not an id (a literal sub-route such as `run-bulk` or `default`);
 * undefined: not decodable (Express refuses such a param too).
 */
function resourceIdOfSegment(segment: string): string | null | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(segment);
  } catch {
    return undefined;
  }
  if (!/^[0-9a-f{}\s-]+$/i.test(decoded)) return null;
  return /^[0-9a-f]{32}$/i.test(decoded.replace(/[{}\s-]/g, '')) ? decoded : null;
}

// NOTE: file uploads live in ai_data_sources with source_type='file'.
// There is no separate ai_agent_files table in this schema.
const FLAT_RESOURCE_TABLES: Record<
  string,
  string | { table: string; filter?: { col: string; eq: string }; alternate?: string }
> = {
  'files': { table: 'ai_data_sources', filter: { col: 'source_type', eq: 'file' } },
  'data-sources': { table: 'ai_data_sources' },
  'qna': 'ai_agent_qna',
  'learning-candidates': 'ai_agent_learning_candidates',
  'test-cases': 'ai_agent_test_cases',
  'test-runs': 'ai_agent_test_runs',
  'suggested-test-cases': 'ai_agent_suggested_test_cases',
  // Operator assist run ids live in their own table (ai_operator_assist_runs),
  // NOT ai_agent_runs — otherwise feedback POSTs fail workspace resolution.
  'operator-assist': 'ai_operator_assist_runs',
  'conversations': 'conversations',
  'suggestions': 'ai_agent_suggestions',
  // `/guidance/:id` is an automation rule (automation.ts) or, when no rule
  // has that id, an operator's guidance for one conversation (humanGuidance.ts).
  'guidance': { table: 'ai_agent_guidance_rules', alternate: 'ai_agent_guidance' },
  'guidance-requests': 'ai_agent_guidance_requests',
  'routing': 'ai_agent_routing_rules',
  'topics': 'ai_agent_topics',
  'workflows': 'ai_agent_workflows',
  'message-triggers': 'ai_agent_message_triggers',
  'tools': 'ai_agent_tools',
  'tool-servers': 'ai_agent_tool_servers',
  'runs': 'ai_agent_runs',
};

/** What the resource a path names by id says about its workspace. */
export type AiAgentResourceWorkspace =
  /** The path names no resource by id. */
  | { kind: 'none' }
  | { kind: 'found'; workspaceId: string }
  /** No such row. */
  | { kind: 'missing' }
  /** The read failed. */
  | { kind: 'error' };

/**
 * The workspace of the resource `reqPath` names by id (`/<resource>/<id>`,
 * or one of NESTED_RESOURCE_ROUTES). Matched case-insensitively on the path
 * with repeated and trailing slashes folded, as Express routes it; the id is
 * read as its handler reads it (resourceIdOfSegment).
 */
export async function lookupAiAgentResourceWorkspace(
  config: ServerConfig,
  reqPath: string,
): Promise<AiAgentResourceWorkspace> {
  let path = String(reqPath || '/').replace(/\/{2,}/g, '/');
  while (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
  let table: string | null = null;
  let filter: { col: string; eq: string } | null = null;
  let alternate: string | null = null;
  let id: string | null = null;
  for (const route of NESTED_RESOURCE_ROUTES) {
    const m = path.match(route.rx);
    if (!m) continue;
    const nestedId = resourceIdOfSegment(m[1]);
    if (nestedId === undefined) return { kind: 'missing' };
    if (nestedId === null) continue;
    table = route.table;
    id = nestedId;
    break;
  }
  if (!table) {
    // Match /<resource>/<id>(/...)
    const m = path.match(/^\/([^/]+)\/([^/]+)(\/|$)/);
    const entry = m ? FLAT_RESOURCE_TABLES[m[1].toLowerCase()] : undefined;
    if (!m || !entry) return { kind: 'none' };
    const flatId = resourceIdOfSegment(m[2]);
    if (flatId === undefined) return { kind: 'missing' };
    if (flatId === null) return { kind: 'none' };
    table = typeof entry === 'string' ? entry : entry.table;
    filter = typeof entry === 'string' ? null : entry.filter || null;
    alternate = typeof entry === 'string' ? null : entry.alternate || null;
    id = flatId;
  }
  const found = await readResourceWorkspace(config, table, id as string, filter);
  if (found.kind === 'missing' && alternate) return readResourceWorkspace(config, alternate, id as string, null);
  return found;
}

async function readResourceWorkspace(
  config: ServerConfig,
  table: string,
  id: string,
  filter: { col: string; eq: string } | null,
): Promise<AiAgentResourceWorkspace> {
  try {
    const sb = getServiceClient(config);
    let q = sb
      .from(table)
      .select('workspace_id')
      .eq('id', id);
    if (filter) q = q.eq(filter.col, filter.eq);
    const { data, error } = await q.maybeSingle();
    if (error) return { kind: 'error' };
    const workspaceId = (data as { workspace_id?: unknown } | null)?.workspace_id;
    return typeof workspaceId === 'string' && workspaceId
      ? { kind: 'found', workspaceId }
      : { kind: 'missing' };
  } catch {
    return { kind: 'error' };
  }
}

/** The workspace ids a request names (query and body), all of them, as written. */
function namedWorkspaceIds(req: Request): { ok: true; ids: string[] } | { ok: false } {
  const query = (req.query || {}) as Record<string, unknown>;
  const body = (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
  const ids: string[] = [];
  for (const value of [query.workspaceId, query.workspace_id, body.workspaceId, body.workspace_id]) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value !== 'string') return { ok: false };
    ids.push(value);
  }
  return { ok: true, ids };
}

export type AiAgentRequestWorkspace =
  | { ok: true; workspaceId: string }
  | { ok: false; status: number; error: string };

/**
 * The one workspace an AI Agent request reads or writes, for a guard that
 * judges that workspace (the Advanced tools' plan rule). Its handlers act on
 * either the workspace the request names (query `workspaceId` /
 * `workspace_id`, body `workspaceId`) or, for a path naming a resource by id,
 * that resource's own workspace. So:
 *   - every workspace id the request names must be the same one (400
 *     `workspace_id_mismatch`), so the guard and the handler cannot read
 *     different ones;
 *   - a resource named by id decides, and a named workspace must be its
 *     (403 `workspace_id_mismatch`); a missing resource is 404, an
 *     unreadable one 503;
 *   - otherwise the named workspace; none at all is 400
 *     `ai_agent_workspace_unresolved`, as aiAgentPlatformGuard answers.
 */
export async function resolveAiAgentRequestWorkspace(
  config: ServerConfig,
  req: Request,
): Promise<AiAgentRequestWorkspace> {
  const named = namedWorkspaceIds(req);
  if (!named.ok) return { ok: false, status: 400, error: 'invalid_workspace_id' };
  const distinct = new Set(named.ids.map((id) => id.toLowerCase()));
  if (distinct.size > 1) return { ok: false, status: 400, error: 'workspace_id_mismatch' };
  const explicit = named.ids[0] ?? null;

  const resource = await lookupAiAgentResourceWorkspace(config, req.path);
  if (resource.kind === 'error') return { ok: false, status: 503, error: PLATFORM_STATUS_UNAVAILABLE };
  if (resource.kind === 'missing') return { ok: false, status: 404, error: 'not_found' };
  if (resource.kind === 'found') {
    if (explicit && explicit.toLowerCase() !== resource.workspaceId.toLowerCase()) {
      return { ok: false, status: 403, error: 'workspace_id_mismatch' };
    }
    return { ok: true, workspaceId: resource.workspaceId };
  }
  if (!explicit) return { ok: false, status: 400, error: 'ai_agent_workspace_unresolved' };
  return { ok: true, workspaceId: explicit };
}

/**
 * The workspace aiAgentPlatformGuard judges. As resolveAiAgentRequestWorkspace,
 * with two differences kept from before: no workspace at all is '' (the
 * guard then decides, as some paths need none), and an id the resource map
 * cannot find falls back to the named workspace, since a few paths name rows
 * of another table than the map's (their handlers authorize those rows).
 */
async function resolveAiAgentGuardWorkspace(
  config: ServerConfig,
  req: Request,
): Promise<{ ok: true; workspaceId: string } | { ok: false; status: number; error: string }> {
  const named = namedWorkspaceIds(req);
  if (!named.ok) return { ok: false, status: 400, error: 'invalid_workspace_id' };
  const distinct = new Set(named.ids.map((id) => id.toLowerCase()));
  if (distinct.size > 1) return { ok: false, status: 400, error: 'workspace_id_mismatch' };
  const explicit = named.ids[0] ?? '';
  const resource = await lookupAiAgentResourceWorkspace(config, req.path);
  if (resource.kind === 'error') return { ok: false, status: 503, error: PLATFORM_STATUS_UNAVAILABLE };
  if (resource.kind === 'found') {
    if (explicit && explicit.toLowerCase() !== resource.workspaceId.toLowerCase()) {
      return { ok: false, status: 403, error: 'workspace_id_mismatch' };
    }
    return { ok: true, workspaceId: resource.workspaceId };
  }
  return { ok: true, workspaceId: explicit };
}

/**
 * Canonical form of an AI Agent sub-path for guard matching.
 *
 * Express routers are case-insensitive and non-strict by default, so
 * `/Platform/Settings` and `/platform/settings/` both reach the
 * `/platform/settings` handler. Guards that pattern-match
 * `req.path` must therefore match on the same equivalence class or they can
 * be skipped by a trivially re-spelled URL. Lowercases, collapses repeated
 * slashes (defensively) and strips trailing slashes (root stays `/`). Used for matching
 * only — never for DB lookups.
 */
export function normalizeAiAgentGuardPath(rawPath: string): string {
  let p = String(rawPath || '/').toLowerCase().replace(/\/{2,}/g, '/');
  if (!p.startsWith('/')) p = `/${p}`;
  while (p.length > 1 && p.endsWith('/')) p = p.slice(0, -1);
  return p;
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
    // Matched on the normalized path so re-spelled URLs (case, trailing or
    // doubled slashes) classify exactly like the route Express will run.
    // `/platform/*` is only safe to skip because the ADVANCED_PATH_PATTERNS
    // guard (and the handlers themselves) require a platform admin there.
    const guardPath = normalizeAiAgentGuardPath(req.path);
    if (guardPath === '/capabilities' || guardPath.startsWith('/platform/')) {
      return next();
    }

    // Routes that legitimately don't need a workspace context.
    // Anything not on this list MUST resolve a workspaceId or fail closed.
    const WORKSPACE_EXEMPT: RegExp[] = [
      /^\/workflows\/_meta$/,
    ];
    const isWorkspaceExempt = WORKSPACE_EXEMPT.some((rx) => rx.test(guardPath));

    const config = (req as Request & { serverConfig?: ServerConfig }).serverConfig as ServerConfig;

    // The workspace judged is the one the handler acts on (audit ai-1,
    // 2026-11-04): every workspace id the request names (query
    // `workspaceId`/`workspace_id`, body `workspaceId`/`workspace_id`) must be
    // the same one, and a resource named by id decides over them (a named
    // workspace must be its). Before, the query's id won, so naming a
    // workspace whose plan has `ai_assistant` opened a handler that acts on
    // the resource's (or the body's) workspace.
    const target = await resolveAiAgentGuardWorkspace(config, req);
    if (target.ok === false) return res.status(target.status).json({ error: target.error });
    const workspaceId = target.workspaceId;

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
      const token = readSessionToken(req).token;
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
    const matched = FEATURE_ROUTES.find((r) => r.rx.test(guardPath));
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
 *
 * P0-G — this is the ONE canonical visitor-facing gate. It honors the global
 * kill switch, the customer-surface toggle, the auto_answer feature toggle,
 * the plan module, and the per-workspace platform_disabled latch. Callers
 * must not re-implement any of these checks locally: a second copy is how
 * the widget and the engine drifted into disagreeing about whether AI was
 * live. Never throws — always returns a verdict so the engine can record
 * skip reasons.
 */
export async function isAutoAnswerAllowedForWorkspace(
  config: ServerConfig,
  workspaceId: string,
): Promise<{ allowed: true } | { allowed: false; reason: string }> {
  try {
    const platform = await getPlatformAiAgentSettings(config);
    // P0-AI-2 — an UNRESOLVED platform lookup is not "enabled". Without this
    // a transient settings-read failure silently turned the visitor-facing
    // AI gate back ON.
    if (isPlatformSettingsLookupFailed(platform)) {
      return { allowed: false, reason: PLATFORM_STATUS_UNAVAILABLE };
    }
    if (!platform.ai_agent_enabled) {
      return { allowed: false, reason: 'ai_agent_platform_disabled' };
    }
    // Customer-facing surface switch: when off, AI must be invisible to
    // visitors even though operator-side suggestions may still run.
    if (platform.customer_ai_agent_visible === false) {
      return { allowed: false, reason: 'customer_ai_agent_hidden_by_platform' };
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
      const { data: row, error } = await sb
        .from('ai_agent_settings')
        .select('metadata')
        .eq('workspace_id', workspaceId)
        .maybeSingle();
      // P0-AI-2 — fail CLOSED: a failed read cannot prove the workspace is
      // not platform-disabled.
      if (error) {
        return { allowed: false, reason: PLATFORM_STATUS_UNAVAILABLE };
      }
      const meta = ((row as { metadata?: unknown } | null)?.metadata || {}) as Record<string, unknown>;
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