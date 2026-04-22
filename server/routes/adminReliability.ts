/**
 * Phase 7 — Admin reliability / SLA / business KPIs / workspace health API.
 * Mounted under /api/admin/reliability (admin-auth applied by adminRouter).
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { z } from 'zod';

export const adminReliabilityRouter = Router();

const RANGE_MS: Record<string, number> = {
  '1h': 60 * 60 * 1000,
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
};

function rangeSince(range: string): string {
  return new Date(Date.now() - (RANGE_MS[range] ?? RANGE_MS['24h'])).toISOString();
}

// ─── SLA / reliability rollups ─────────────────────────────────────────────
adminReliabilityRouter.get('/sla', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const range = String(req.query.range || '24h');
    const scopeType = String(req.query.scope_type || 'platform');
    const since = rangeSince(range);
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('sla_reliability_hourly')
      .select('*')
      .eq('scope_type', scopeType)
      .gte('bucket_hour', since)
      .order('bucket_hour', { ascending: false })
      .limit(2000);
    if (error) return res.status(500).json({ error: error.message });
    const rows = data || [];
    const summary = {
      uptime_pct: avg(rows.map((r: any) => Number(r.uptime_pct))),
      realtime_availability_pct: avg(rows.map((r: any) => Number(r.realtime_availability_pct))),
      degraded_minutes: sum(rows.map((r: any) => Number(r.degraded_minutes))),
      forced_polling_minutes: sum(rows.map((r: any) => Number(r.forced_polling_minutes))),
      critical_alert_count: sum(rows.map((r: any) => Number(r.critical_alert_count))),
      warn_alert_count: sum(rows.map((r: any) => Number(r.warn_alert_count))),
      failover_count: sum(rows.map((r: any) => Number(r.failover_count))),
      recovery_count: sum(rows.map((r: any) => Number(r.recovery_count))),
      mean_failover_recovery_seconds: avg(
        rows.map((r: any) => Number(r.mean_failover_recovery_seconds)).filter((n: number) => n > 0),
      ),
    };
    res.json({ range, since, scope_type: scopeType, summary, rows });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load SLA data' });
  }
});

// ─── Business metrics rollups ──────────────────────────────────────────────
adminReliabilityRouter.get('/business', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const range = String(req.query.range || '24h');
    const since = rangeSince(range);
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('business_metrics_hourly')
      .select('*')
      .gte('bucket_hour', since)
      .order('bucket_hour', { ascending: false })
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });
    const rows = data || [];
    const summary = {
      new_conversations: sum(rows.map((r: any) => r.new_conversations)),
      resolved_conversations: sum(rows.map((r: any) => r.resolved_conversations)),
      unanswered_conversations: sum(rows.map((r: any) => r.unanswered_conversations)),
      stale_open_conversations: sum(rows.map((r: any) => r.stale_open_conversations)),
      messages_sent: sum(rows.map((r: any) => r.messages_sent)),
      avg_first_response_p50: avg(
        rows.map((r: any) => Number(r.first_response_time_p50)).filter((n: number) => n > 0),
      ),
      avg_first_response_p95: avg(
        rows.map((r: any) => Number(r.first_response_time_p95)).filter((n: number) => n > 0),
      ),
      avg_resolution_seconds: avg(
        rows.map((r: any) => Number(r.avg_resolution_time_seconds)).filter((n: number) => n > 0),
      ),
    };
    res.json({ range, since, summary, rows });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load business metrics' });
  }
});

// ─── Workspace health snapshots ────────────────────────────────────────────
adminReliabilityRouter.get('/workspace-health', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    // Latest snapshot per workspace (last 7d window)
    const { data, error } = await sb
      .from('workspace_health_snapshots')
      .select('id, workspace_id, captured_at, health_score, state, components')
      .gte('captured_at', new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString())
      .order('captured_at', { ascending: false })
      .limit(5000);
    if (error) return res.status(500).json({ error: error.message });
    const seen = new Set<string>();
    const latest: any[] = [];
    for (const row of data || []) {
      if (seen.has(row.workspace_id)) continue;
      seen.add(row.workspace_id);
      latest.push(row);
    }
    const counts = {
      healthy: latest.filter((r) => r.state === 'healthy').length,
      warning: latest.filter((r) => r.state === 'warning').length,
      at_risk: latest.filter((r) => r.state === 'at_risk').length,
    };
    const at_risk = latest
      .filter((r) => r.state !== 'healthy')
      .sort((a, b) => a.health_score - b.health_score)
      .slice(0, 10);
    res.json({ counts, total: latest.length, latest, at_risk });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load workspace health' });
  }
});

// ─── SLO definitions ───────────────────────────────────────────────────────
adminReliabilityRouter.get('/slos', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('slo_definitions')
      .select('*')
      .order('slug', { ascending: true });
    if (error) return res.status(500).json({ error: error.message });
    res.json({ slos: data || [] });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to load SLOs' });
  }
});

const sloPatchSchema = z.object({
  target_value: z.number().finite().optional(),
  window_seconds: z.number().int().positive().optional(),
  enabled: z.boolean().optional(),
});

adminReliabilityRouter.patch('/slos/:id', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const id = String(req.params.id);
    const patch = sloPatchSchema.parse(req.body);
    const sb = getServiceClient(config);
    const { data, error } = await sb
      .from('slo_definitions')
      .update(patch)
      .eq('id', id)
      .select('*')
      .maybeSingle();
    if (error) return res.status(400).json({ error: error.message });
    res.json({ slo: data });
  } catch (err: any) {
    res.status(400).json({ error: err?.message || 'Failed to update SLO' });
  }
});

// ─── Manual rollup trigger (admin only) ────────────────────────────────────
adminReliabilityRouter.post('/rollup', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const sla = await (sb as any).rpc('sla_reliability_rollup_and_prune');
    const biz = await (sb as any).rpc('business_metrics_rollup_and_prune');
    const hs = await (sb as any).rpc('workspace_health_snapshot_compute');
    res.json({
      ok: true,
      sla: sla.error ? { error: sla.error.message } : sla.data,
      business: biz.error ? { error: biz.error.message } : biz.data,
      health: hs.error ? { error: hs.error.message } : hs.data,
    });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Rollup failed' });
  }
});

function sum(arr: number[]): number {
  return arr.reduce((a, b) => a + (Number.isFinite(b) ? b : 0), 0);
}
function avg(arr: number[]): number | null {
  const cleaned = arr.filter((n) => Number.isFinite(n));
  if (cleaned.length === 0) return null;
  return cleaned.reduce((a, b) => a + b, 0) / cleaned.length;
}