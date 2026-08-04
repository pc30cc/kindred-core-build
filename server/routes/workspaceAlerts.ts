/**
 * WORKSPACE OPERATIONAL ALERTS — lightweight, derived, read-only.
 *
 * GET /api/workspace-alerts/:workspaceId
 *
 * Deliberately NOT a notification feed: conversation / team-chat activity is
 * already surfaced by the Inbox tabs. This endpoint only reports *operational*
 * conditions the operator must act on (plan, quota, billing, verification).
 *
 * No new tables, no realtime, no background jobs — everything is derived from
 * data the app already stores, in a handful of parallel reads.
 */

import { Router } from 'express';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { getWorkspacePlanInfo } from '../middleware/featureGating.js';

export const workspaceAlertsRouter = Router();

export type AlertSeverity = 'critical' | 'warning' | 'info';

export interface WorkspaceAlert {
  id: string;
  kind: string;
  severity: AlertSeverity;
  /** Interpolation params for the i18n string on the client. */
  params?: Record<string, string>;
  /** Workspace-relative path (without the /app/w/<id> prefix). */
  action?: string;
}

/** Usage-counter column backing each finite plan limit we can evaluate cheaply. */
const USAGE_MAP: Array<{
  limitKey: string;
  column: string;
  /** Converts the raw counter value into the limit's unit. */
  scale?: (raw: number) => number;
}> = [
  { limitKey: 'max_conversations', column: 'conversations_count' },
  { limitKey: 'max_visitors', column: 'visitors_count' },
  { limitKey: 'ai_credits_per_month', column: 'ai_credits_used' },
  { limitKey: 'max_call_minutes_per_month', column: 'call_minutes_used' },
  { limitKey: 'storage_gb', column: 'storage_bytes', scale: (b) => b / 1024 ** 3 },
];

const DAY_MS = 86_400_000;

function daysUntil(iso: string | null | undefined): number | null {
  if (!iso) return null;
  const ts = Date.parse(iso);
  if (Number.isNaN(ts)) return null;
  return Math.ceil((ts - Date.now()) / DAY_MS);
}

workspaceAlertsRouter.get('/:workspaceId', async (req, res) => {
  const workspaceId = req.params.workspaceId;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;

  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const period = new Date().toISOString().slice(0, 7);

  try {
    const [planInfo, usageRes, overridesRes, paymentsRes, userRes] = await Promise.all([
      getWorkspacePlanInfo(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId).catch(
        () => null,
      ),
      sb
        .from('workspace_usage_counters')
        .select('*')
        .eq('workspace_id', workspaceId)
        .eq('period', period)
        .maybeSingle(),
      sb.from('workspace_limit_overrides').select('limit_key, limit_value').eq('workspace_id', workspaceId),
      sb
        .from('billing_payments')
        .select('id, status, created_at')
        .eq('workspace_id', workspaceId)
        .order('created_at', { ascending: false })
        .limit(5),
      sb.auth.admin.getUserById(auth.userId).catch(() => null as any),
    ]);

    const alerts: WorkspaceAlert[] = [];

    // ── 1. Account verification ──────────────────────────────
    const authUser = userRes?.data?.user;
    if (authUser && !authUser.email_confirmed_at) {
      alerts.push({ id: 'email_unverified', kind: 'email_unverified', severity: 'warning' });
    }

    // ── 2. Subscription / trial lifecycle ────────────────────
    const sub = (planInfo as any)?.subscription ?? null;
    const plan = (planInfo as any)?.plan ?? null;
    const planName: string = plan?.name || plan?.slug || '';

    if (sub) {
      const trialLeft = daysUntil(sub.trial_end);
      const periodLeft = daysUntil(sub.current_period_end);

      if (sub.status === 'trialing' && trialLeft !== null && trialLeft <= 7) {
        alerts.push({
          id: 'trial_ending',
          kind: trialLeft <= 0 ? 'trial_expired' : 'trial_ending',
          severity: trialLeft <= 2 ? 'critical' : 'warning',
          params: { days: String(Math.max(trialLeft, 0)), plan: planName },
          action: '/billing',
        });
      } else if (
        sub.status === 'active' &&
        periodLeft !== null &&
        periodLeft <= 7 &&
        sub.cancel_at_period_end
      ) {
        alerts.push({
          id: 'subscription_ending',
          kind: 'subscription_ending',
          severity: periodLeft <= 2 ? 'critical' : 'warning',
          params: { days: String(Math.max(periodLeft, 0)), plan: planName },
          action: '/billing',
        });
      } else if (['past_due', 'unpaid', 'incomplete'].includes(String(sub.status))) {
        alerts.push({
          id: 'subscription_past_due',
          kind: 'subscription_past_due',
          severity: 'critical',
          action: '/billing',
        });
      }
    }

    // ── 3. Failed payment in the last 14 days ────────────────
    const failed = (paymentsRes.data || []).find(
      (p: any) =>
        ['failed', 'canceled', 'cancelled'].includes(String(p.status)) &&
        Date.now() - Date.parse(p.created_at || '') < 14 * DAY_MS,
    );
    if (failed) {
      alerts.push({
        id: `payment_failed_${failed.id}`,
        kind: 'payment_failed',
        severity: 'critical',
        action: '/billing',
      });
    }

    // ── 4. Quota pressure (>=80% warn, >=100% critical) ──────
    const overrideMap = new Map<string, number>(
      (overridesRes.data || []).map((o: any) => [o.limit_key, Number(o.limit_value)]),
    );
    const planLimits: Record<string, number> = ((planInfo as any)?.limits || {}) as any;
    const usage: any = usageRes.data || {};

    for (const entry of USAGE_MAP) {
      const limit = overrideMap.has(entry.limitKey)
        ? overrideMap.get(entry.limitKey)!
        : Number(planLimits[entry.limitKey]);
      if (!Number.isFinite(limit) || limit <= 0) continue; // -1 / 0 / missing = unlimited or n/a

      const raw = Number(usage[entry.column] || 0);
      const used = entry.scale ? entry.scale(raw) : raw;
      const pct = Math.round((used / limit) * 100);
      if (pct < 80) continue;

      alerts.push({
        id: `limit_${entry.limitKey}`,
        kind: pct >= 100 ? 'limit_reached' : 'limit_near',
        severity: pct >= 100 ? 'critical' : 'warning',
        params: { limit: entry.limitKey, percent: String(Math.min(pct, 999)) },
        action: '/billing',
      });
    }

    const severityRank: Record<AlertSeverity, number> = { critical: 0, warning: 1, info: 2 };
    alerts.sort((a, b) => severityRank[a.severity] - severityRank[b.severity]);

    res.json({
      alerts,
      counts: {
        total: alerts.length,
        critical: alerts.filter((a) => a.severity === 'critical').length,
      },
      generatedAt: new Date().toISOString(),
    });
  } catch {
    res.status(500).json({ error: 'Failed to resolve workspace alerts' });
  }
});