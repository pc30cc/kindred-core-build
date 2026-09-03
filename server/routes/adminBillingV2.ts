// ============================================================
// BILLING V2 ROLLOUT API — Platform Admin only.
//
// Every route re-verifies platform admin identity from the first-party session
// before any service-role database access. The rollout state is
// server-authoritative: there is no customer-facing endpoint that can move a
// workspace onto (or off) V2.
//
// Activation is a single atomic RPC — the readiness check runs AGAIN inside the
// activation transaction, so an evaluation that was green a second ago cannot
// authorize a cutover that is no longer safe.
// ============================================================

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import {
  activateV2,
  CutoverBlockedError,
  enableShadow,
  evaluateCutover,
  getRolloutState,
  readMetrics,
} from '../services/billing/rollout.js';
import { compareShadow } from '../services/billing/shadow.js';
import { readSchedulerHealth } from '../services/billing/scheduler/index.js';
import { getBillingV2SchedulerStatus } from '../services/billing/scheduler/ticker.js';
import { buildWorkspaceBillingReadModel } from '../services/billing/readModel.js';
import { getServiceClient } from '../supabase.js';

export const adminBillingV2Router = Router();

function cfg(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

adminBillingV2Router.get('/metrics', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  res.json({ metrics: readMetrics() });
});

// Read-only: scheduler health never moves money.
adminBillingV2Router.get('/scheduler/health', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    res.json({ ...(await readSchedulerHealth(cfg(req))), ticker: getBillingV2SchedulerStatus() });
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

adminBillingV2Router.get('/workspaces/:id/state', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const state = await getRolloutState(cfg(req), req.params.id);
  res.json({ workspaceId: req.params.id, state });
});

adminBillingV2Router.get('/workspaces/:id/readiness', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  try {
    res.json(await evaluateCutover(cfg(req), req.params.id));
  } catch (e: any) {
    res.status(500).json({ error: String(e?.message || e) });
  }
});

adminBillingV2Router.get('/workspaces/:id/read-model', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  res.json(await buildWorkspaceBillingReadModel(cfg(req), req.params.id));
});

adminBillingV2Router.get('/workspaces/:id/shadow-report', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  res.json(await compareShadow(cfg(req), req.params.id));
});

const reasonSchema = z.object({ reason: z.string().min(3).max(300).optional() });

adminBillingV2Router.post('/workspaces/:id/shadow', async (req, res) => {
  const adminId = await requirePlatformAdmin(req, res);
  if (!adminId) return;
  const parsed = reasonSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
  try {
    const result = await enableShadow(cfg(req), {
      workspaceId: req.params.id,
      actorId: adminId,
      reason: parsed.data.reason ?? null,
    });
    res.json(result);
  } catch (e: any) {
    const msg = String(e?.message || e);
    if (msg.includes('billing_v2_rollback_forbidden')) {
      return res.status(409).json({ error: 'BILLING_V2_ROLLBACK_FORBIDDEN', detail: msg });
    }
    res.status(500).json({ error: msg });
  }
});

adminBillingV2Router.post('/workspaces/:id/activate', async (req, res) => {
  const adminId = await requirePlatformAdmin(req, res);
  if (!adminId) return;
  const parsed = reasonSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
  try {
    const result = await activateV2(cfg(req), {
      workspaceId: req.params.id,
      actorId: adminId,
      reason: parsed.data.reason ?? null,
    });
    res.json(result);
  } catch (e: any) {
    if (e instanceof CutoverBlockedError) {
      return res.status(409).json({ error: 'BILLING_V2_CUTOVER_BLOCKED', readiness: e.readiness });
    }
    res.status(500).json({ error: String(e?.message || e) });
  }
});

/**
 * Batch READINESS evaluation. Deliberately evaluation-only and per-workspace
 * isolated: one workspace's failure never poisons the batch, and no mass
 * rollout is performed here.
 */
adminBillingV2Router.post('/evaluate-batch', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = z
    .object({ workspaceIds: z.array(z.string().uuid()).min(1).max(200) })
    .safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });

  const results = [];
  for (const id of parsed.data.workspaceIds) {
    try {
      results.push({ workspaceId: id, ...(await evaluateCutover(cfg(req), id)) });
    } catch (e: any) {
      results.push({ workspaceId: id, ready: false, error: String(e?.message || e) });
    }
  }
  res.json({ results });
});

adminBillingV2Router.get('/workspaces/:id/audit', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const { data } = await getServiceClient(cfg(req))
    .from('billing_v2_audit')
    .select('id, event, actor_id, reason, details, created_at')
    .eq('workspace_id', req.params.id)
    .order('created_at', { ascending: false })
    .limit(100);
  res.json({ events: data || [] });
});
