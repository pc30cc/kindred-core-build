/**
 * Operator heartbeat — LIVE PRESENCE + internal active/away ONLY.
 *
 * Two independent signals, neither of which keeps history:
 *   1. INTERNAL ACTIVITY (active vs. away) — ephemeral, process-local with an
 *      optional exact Redis index. Stamped only when the operator actually
 *      interacted. See server/services/widget/operatorActivity.ts.
 *   2. LIVE PRESENCE — the `operator_presence_live` lease: one row per
 *      (workspace, user), overwritten on every beat, no history. See
 *      server/services/widget/operatorPresenceSource.ts.
 *
 * The operator panel beats every 2 minutes while the tab is open (tab hidden
 * => no beat => the operator goes offline within the liveness window; that is
 * the product's "available when using the app" semantics).
 *
 * NO periodic PostgreSQL history is written here. The former
 * `operator_activity_samples` 5-minute analytics buckets — and the online-time
 * report built on them — were removed deliberately; per-operator time-series
 * grew linearly with the operator count for a report that is not used.
 *
 * ─── ROUTES ────────────────────────────────────────────────────────
 *   POST /api/operator-activity/heartbeat  { workspace_id, interacted? }
 */

import { Router } from 'express';
import { z } from 'zod';
import {
  authorizeWorkspaceAccess,
  serverConfigOf,
} from '../lib/workspaceAuth.js';
import { recordOperatorPresenceBeat } from '../services/widget/operatorPresence.js';
import { shouldWriteFallbackPresence } from '../services/widget/operatorPresenceSource.js';
import { recordOperatorActivity } from '../services/widget/operatorActivity.js';

export const operatorActivityRouter = Router();

// ── POST /heartbeat ───────────────────────────────────────────────
operatorActivityRouter.post('/heartbeat', async (req, res) => {
  try {
    const parsed = z
      .object({ workspace_id: z.string().uuid(), interacted: z.boolean().optional() })
      .safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'workspace_id required' });
    const workspaceId = parsed.data.workspace_id;

    const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
    if (!auth) return;

    const config = serverConfigOf(req);
    const now = new Date();

    // INTERNAL activity stamp (ephemeral, in-memory, zero writes). The client
    // only beats when the operator actually interacted, so this drives the
    // 5-minute active/away threshold.
    // Only real interaction refreshes the stamp; idle beats keep the
    // connection alive but let internal presence decay to "away".
    if (parsed.data.interacted !== false) {
      recordOperatorActivity(workspaceId, auth.userId, now.getTime());
    }

    // LIVE PRESENCE — the lease is refreshed on EVERY beat, not only in
    // database-fallback mode. Rationale: a *successful but empty* Centrifugo
    // presence read is indistinguishable from "this operator's subscription
    // silently died", which used to pin a working, open panel to "offline"
    // for its whole session. The lease is one upsert per operator per
    // heartbeat interval (2 min) on a bounded, single-row-per-operator table
    // — operators are dozens, unlike visitors — so it is a cheap, durable
    // second signal. Presence reads UNION realtime with this lease; realtime
    // remains the fast path and the lease can only ever add an operator.
    const fallbackPresence = await shouldWriteFallbackPresence(config, now.getTime(), workspaceId);
    await recordOperatorPresenceBeat(config, workspaceId, auth.userId, now);

    return res.json({ ok: true, presence_mode: fallbackPresence ? 'database' : 'realtime' });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Heartbeat failed' });
  }
});
