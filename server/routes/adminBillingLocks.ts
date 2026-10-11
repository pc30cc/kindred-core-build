/**
 * SUPER ADMIN → billing locks (simple billing phase 4, design §10).
 *
 *   GET /           the running edition's switch
 *   PUT /           turn it on or off ({ enabled })
 *   GET /preview    what the switch would lock now: every active workspace
 *                   over a limit of its plan, with counts, and the workspaces
 *                   whose X channel stops
 *
 * Mount at /api/admin/billing/locks (before /api/admin/billing). Platform
 * Super Admin only: the gate runs here, before any query, whatever it is
 * mounted under.
 *
 * The switch is per edition (billing_settings.locks_enabled, migration 265,
 * off by default): WebYar and RESPOK have their own databases and each turns
 * it on after reviewing the preview. While it is off nothing is locked; the
 * preview computes as if it were on.
 */
import { Router } from 'express';
import { z } from 'zod';
import { requirePlatformAdmin, serverConfigOf } from '../lib/workspaceAuth.js';
import { getServiceClient } from '../supabase.js';
import { getPlatformEdition, EditionUnavailableError } from '../services/platformRegion.js';
import { checkChannelAccess } from '../middleware/featureGating.js';
import { clearLockStateCache, parseCutoffRow } from '../services/billing/locks/state.js';
import { enqueueKnowledgeBaseCatchup } from '../services/ai-agent/knowledgeIndex/kbEvents.js';
import { clearPlanStopCache } from '../services/billing/planStops.js';
import { parseSqlLockReport } from '../services/billing/locks/report.js';
import type { ServerConfig } from '../config.js';

export const adminBillingLocksRouter = Router();

adminBillingLocksRouter.use(async (req, res, next) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  next();
});

function fail(res: { status(code: number): { json(body: unknown): unknown } }, e: unknown) {
  if (e instanceof EditionUnavailableError) return res.status(503).json({ error: 'EDITION_UNAVAILABLE' });
  console.error('[admin-billing-locks]', e instanceof Error ? e.message : e);
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
}

async function readSwitch(config: ServerConfig, edition: string): Promise<boolean> {
  const { data, error } = await getServiceClient(config)
    .from('billing_settings')
    .select('locks_enabled')
    .eq('edition', edition)
    .maybeSingle();
  if (error) throw new Error(error.message || 'billing settings read failed');
  return (data as { locks_enabled?: unknown } | null)?.locks_enabled === true;
}

adminBillingLocksRouter.get('/', async (req, res) => {
  try {
    const cfg = serverConfigOf(req);
    const edition = await getPlatformEdition(cfg);
    res.json({ edition, locks_enabled: await readSwitch(cfg, edition) });
  } catch (e) {
    fail(res, e);
  }
});

const switchSchema = z.object({ enabled: z.boolean() });

adminBillingLocksRouter.put('/', async (req, res) => {
  const parsed = switchSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'INVALID_REQUEST' });
  try {
    const cfg = serverConfigOf(req);
    const edition = await getPlatformEdition(cfg);
    const was = await readSwitch(cfg, edition);
    // Only this column: the seller, VAT and prefix of the row stay as they are.
    const { error } = await getServiceClient(cfg).from('billing_settings').upsert(
      {
        edition,
        locks_enabled: parsed.data.enabled,
        updated_at: new Date().toISOString(),
        updated_by: (req as unknown as { adminUser?: { id?: string } }).adminUser?.id ?? null,
      },
      { onConflict: 'edition' },
    );
    if (error) throw new Error(error.message || 'billing settings write failed');
    // Every workspace's lock state follows the switch at once.
    clearLockStateCache();
    clearPlanStopCache();
    console.info('[admin-billing-locks] billing locks', parsed.data.enabled ? 'on' : 'off', 'for', edition);
    if (was && !parsed.data.enabled) {
      // While on, the AI index retired the chunks of locked articles; off,
      // they are served again only once re-indexed. In the background: the
      // switch is already off whatever this does.
      void requeueKbIndexAfterSwitchOff(cfg).catch((e) =>
        console.warn('[admin-billing-locks] KB re-index after switch off failed:', e instanceof Error ? e.message : e));
    }
    res.json({ edition, locks_enabled: parsed.data.enabled });
  } catch (e) {
    fail(res, e);
  }
});

// ─── Preview ──────────────────────────────────────────────────────────────

/** Workspaces read per preview; past it the answer says `truncated`. */
const PREVIEW_MAX_WORKSPACES = 5000;
const PAGE = 1000;
const CONCURRENCY = 8;

interface PreviewRow {
  workspace_id: string;
  name: string | null;
  plan_id: string;
  kb_article: number;
  contact: number;
  member: number;
  conversation: number;
}

async function mapLimited<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * After the switch is turned off: one idempotent knowledge-base catch-up
 * (a rebuild of the AI index) for every active workspace whose plan locks
 * articles (computed as if the switch were on), the only ones whose chunks
 * the index retired while it was on. Returns the workspaces queued.
 */
export async function requeueKbIndexAfterSwitchOff(cfg: ServerConfig): Promise<number> {
  const sb = getServiceClient(cfg);
  let queued = 0;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await sb
      .from('workspaces')
      .select('id')
      .eq('status', 'active')
      .order('id', { ascending: true })
      .range(from, from + PAGE - 1);
    if (error) throw new Error(error.message || 'workspaces read failed');
    const ids = ((data ?? []) as Array<{ id: string }>).map((r) => r.id);
    const hits = await mapLimited(ids, CONCURRENCY, async (id) => {
      const { data: cut, error: cutError } = await sb.rpc('billing_lock_compute', { p_workspace_id: id, p_kind: 'kb_article', p_plan_id: null });
      // Unreadable: queued anyway (a catch-up is idempotent and only re-indexes).
      if (!cutError && parseCutoffRow(cut).locked === 0) return false;
      return (await enqueueKnowledgeBaseCatchup(cfg, id)).ok;
    });
    queued += hits.filter(Boolean).length;
    if (ids.length < PAGE) break;
  }
  console.info(`[admin-billing-locks] KB re-index queued for ${queued} workspace(s) after the switch went off`);
  return queued;
}

adminBillingLocksRouter.get('/preview', async (req, res) => {
  try {
    const cfg = serverConfigOf(req);
    const sb = getServiceClient(cfg);
    const edition = await getPlatformEdition(cfg);
    const locksEnabled = await readSwitch(cfg, edition);

    const workspaces: Array<{ id: string; name: string | null }> = [];
    let truncated = false;
    // One more than the cap is read, to tell a full list from a cut one.
    for (let from = 0; from <= PREVIEW_MAX_WORKSPACES; from += PAGE) {
      const to = Math.min(from + PAGE, PREVIEW_MAX_WORKSPACES + 1) - 1;
      const { data, error } = await sb
        .from('workspaces')
        .select('id, name')
        .eq('status', 'active')
        .order('created_at', { ascending: true })
        .order('id', { ascending: true })
        .range(from, to);
      if (error) throw new Error(error.message || 'workspaces read failed');
      const rows = (data ?? []) as Array<{ id: string; name: string | null }>;
      workspaces.push(...rows);
      if (rows.length < to - from + 1) break;
    }
    if (workspaces.length > PREVIEW_MAX_WORKSPACES) {
      truncated = true;
      workspaces.length = PREVIEW_MAX_WORKSPACES;
    }

    let failed = 0;
    const reports = await mapLimited(workspaces, CONCURRENCY, async (ws): Promise<PreviewRow | null> => {
      // The plan in force (p_plan_id NULL), computed as if the switch were on.
      const { data, error } = await sb.rpc('billing_lock_report', { p_workspace_id: ws.id, p_plan_id: null });
      if (error) {
        failed += 1;
        return null;
      }
      const planId = String((data as { plan_id?: unknown } | null)?.plan_id ?? '');
      const r = parseSqlLockReport(data, planId);
      const row: PreviewRow = {
        workspace_id: ws.id,
        name: ws.name ?? null,
        plan_id: planId,
        kb_article: r.kb_article.locked,
        contact: r.contact.locked,
        member: r.member.locked,
        conversation: r.conversation.locked,
      };
      return row.kb_article + row.contact + row.member + row.conversation > 0 ? row : null;
    });
    const locked = reports.filter((r): r is PreviewRow => r !== null);

    // The X channel had no plan key before (design §6): an installation on a
    // plan that does not name it stops receiving once ingest is plan-gated.
    const { data: xRows, error: xError } = await sb
      .from('workspace_plugin_installations')
      .select('workspace_id')
      .eq('plugin_id', 'x')
      .neq('status', 'uninstalled');
    if (xError) throw new Error(xError.message || 'plugin installations read failed');
    const xWorkspaces = [...new Set(((xRows ?? []) as Array<{ workspace_id: string }>).map((r) => r.workspace_id))];
    const names = new Map(workspaces.map((w) => [w.id, w.name]));
    const xStops = (await mapLimited(xWorkspaces, CONCURRENCY, async (workspaceId) => {
      const access = await checkChannelAccess(cfg.supabaseUrl, cfg.supabaseServiceRoleKey, workspaceId, 'x', {
        selfHostBillingUnlimited: cfg.selfHostBillingUnlimited === true,
      });
      return access.allowed ? null : { workspace_id: workspaceId, name: names.get(workspaceId) ?? null };
    })).filter((r): r is { workspace_id: string; name: string | null } => r !== null);

    const totals = locked.reduce(
      (t, r) => ({
        kb_article: t.kb_article + r.kb_article,
        contact: t.contact + r.contact,
        member: t.member + r.member,
        conversation: t.conversation + r.conversation,
      }),
      { kb_article: 0, contact: 0, member: 0, conversation: 0 },
    );
    res.json({
      edition,
      locks_enabled: locksEnabled,
      scanned: workspaces.length,
      truncated,
      failed,
      workspaces_locking: locked.length,
      totals,
      workspaces: locked.sort((a, b) =>
        (b.kb_article + b.contact + b.member + b.conversation) - (a.kb_article + a.contact + a.member + a.conversation)),
      x_channel_stops: xStops,
    });
  } catch (e) {
    fail(res, e);
  }
});
