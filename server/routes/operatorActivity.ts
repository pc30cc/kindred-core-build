/**
 * OPERATOR ACTIVITY — heartbeat & productivity stats.
 *
 * Self-hosted Express only (no edge functions).
 *
 * The heartbeat carries LIVE PRESENCE — realtime-first. While Centrifugo
 * presence is the active source, channel membership carries liveness and
 * this beat writes NOTHING. Only in database-fallback mode (polling/disabled/
 * Supabase, or a tripped presence circuit breaker — shared across instances
 * via `operator_presence_fallback_state`) does the beat UPSERT the
 * `operator_presence_live` lease: one row per (workspace, user), no history.
 * See server/services/widget/operatorPresenceSource.ts.
 *
 * The operator panel heartbeats every 2 minutes while the tab is open and
 * visible (tab hidden => no beat => operator goes offline within the
 * liveness window; that is the product's "available when using the app"
 * semantics).
 *
 * ONLINE TIME is no longer recorded. It came from `operator_activity_samples`
 * (5-minute buckets), which is dropped — in production since 2026-09-17, in
 * the migration chains by database/migrations/223 and its hosted mirror — so
 * the stats endpoint reports zero online minutes, and says so
 * (`online_time_tracked: false`, for the report to hide those columns rather
 * than show zeros as "accurate online time"); assignments and message counts
 * still come from live tables.
 *
 * WHO IS ONLINE NOW is live presence (R-25): each operator's
 * `presence_state` — active, away, disconnected (available but no panel or
 * app connected) or offline — the same reading routing uses, and
 * `totals.online_now` counts those connected (active or away).
 * `current_state` stays the status-and-schedule availability it always was.
 *
 * SATISFACTION comes from the visitors' ratings after a chat
 * (`conversation_ratings`, migration 276): per operator the average score
 * (one decimal) and the number of ratings given in the window, credited to
 * the operator each rated closure names. Null averages, and the report's
 * column stays hidden, while there are none (or before 276).
 *
 * A TAB THAT GOES AWAY (R-11): the panel names its tab in every beat
 * (`source_id`, a random id per tab) and, when the tab goes away (pagehide;
 * on iPhone and iPad also when it is hidden), sends a beacon to /leave with
 * the same id. That ends this tab's part of the lease at once (migration
 * 282b): routing stops picking an operator who just closed their last tab,
 * instead of for up to 5 minutes, while their other tabs, the desktop app
 * and the phone (beats without an id) keep them here.
 *
 * ─── ROUTES ────────────────────────────────────────────────────────
 *   POST /api/operator-activity/heartbeat  { workspace_id, interacted?, source_id? }
 *   POST /api/operator-activity/leave      { workspace_id, source_id }  (a beacon: text/plain JSON)
 *   GET  /api/operator-activity/:workspaceId/stats?days=7   (owner/admin)
 */

import express, { Router } from 'express';
import { z } from 'zod';
import { getServiceClient } from '../supabase.js';
import {
  authorizeWorkspaceAccess,
  serverConfigOf,
} from '../lib/workspaceAuth.js';
import {
  computeOperatorState,
  endOperatorPresenceSource,
  LEGACY_PRESENCE_SOURCE,
  presenceSourceOf,
  readRoutingPresence,
  recordOperatorPresenceBeat,
} from '../services/widget/operatorPresence.js';
import { readGlobalAvailabilityPrefs } from '../services/widget/customerAvailability.js';
import { shouldWriteFallbackPresence } from '../services/widget/operatorPresenceSource.js';
import { recordOperatorActivity } from '../services/widget/operatorActivity.js';
import { hydrateUserAvatars } from '../services/storage/urlResolver.js';
import { isRelationMissing } from '../services/billing/entitlementParse.js';

export const operatorActivityRouter = Router();

const MAX_DAYS = 90;
export const BUCKET_MINUTES = 5;
const BUCKET_MS = BUCKET_MINUTES * 60_000;
const RETENTION_DAYS = 120; // > MAX_DAYS, so every reportable window stays intact

/** Floors a timestamp to the containing 5-minute bucket. */
export function floorToBucket(d: Date | string): string {
  const ms = typeof d === 'string' ? new Date(d).getTime() : d.getTime();
  return new Date(Math.floor(ms / BUCKET_MS) * BUCKET_MS).toISOString();
}

/**
 * Per-process memo of the last bucket already persisted for a given
 * (workspace, user). Bounded: one entry per active operator, swept whenever
 * it grows past the cap. Losing it only costs one redundant idempotent
 * UPSERT after a restart.
 */
const lastWrittenBucket = new Map<string, string>();
const LAST_WRITTEN_MAX = 5000;

/**
 * Per-process memo of the last successful live-presence lease write for a
 * (workspace, user, source). A source beats every 2 minutes; a beat of the
 * same source within LEASE_REWRITE_MS of its last write (a remount, a burst)
 * skips the write. It is per source, not per operator, since migration 282b:
 * each source's own stamp in the lease must stay fresh, or the beacon of one
 * tab would end the lease while another tab, whose beats were skipped, is
 * still open. 90s keeps every stamp under ~2 minutes old, far inside the
 * 5-minute liveness window (PRESENCE_LIVENESS_MS, operatorPresenceSource.ts).
 * A lone source writes on every beat (its beats are 120s apart). The beacon
 * forgets its source's entry (the panel also starts a new id after it); a
 * failed write is not remembered, so the next beat retries.
 */
const LEASE_REWRITE_MS = 90_000;
const lastLeaseWriteAt = new Map<string, number>();

/** The body of a beacon: sendBeacon sends a string as text/plain (CORS-simple, no preflight). */
const beaconText = express.text({ type: 'text/plain', limit: '2kb' });

function beaconBody(body: unknown): Record<string, unknown> {
  if (typeof body === 'string') {
    try {
      const parsed = JSON.parse(body) as unknown;
      return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {};
    } catch {
      return {};
    }
  }
  return body && typeof body === 'object' ? body as Record<string, unknown> : {};
}

// operator_activity_samples was dropped from the database, so there is
// nothing left to prune. Kept as a no-op rather than deleted so the call
// sites stay in one place if the analytics table is ever reinstated; the
// hourly-throttle state it used to carry went with the body, since a no-op
// has nothing to throttle. RETENTION_DAYS above is left as the documented
// retention window.
async function pruneOldSamples(_sb: ReturnType<typeof getServiceClient>): Promise<void> {
  return;
}

// ── POST /heartbeat ───────────────────────────────────────────────
operatorActivityRouter.post('/heartbeat', async (req, res) => {
  try {
    const parsed = z
      .object({ workspace_id: z.string().uuid(), interacted: z.boolean().optional() })
      .safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'workspace_id required' });
    const workspaceId = parsed.data.workspace_id;
    // A panel tab names itself; anything else (the apps) is the legacy source.
    const source = presenceSourceOf((req.body as { source_id?: unknown } | undefined)?.source_id) ?? LEGACY_PRESENCE_SOURCE;

    const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
    if (!auth) return;

    const config = serverConfigOf(req);
    const sb = getServiceClient(config);

    const now = new Date();
    // INTERNAL activity stamp (ephemeral, in-memory, zero writes). The client
    // only beats when the operator actually interacted, so this drives the
    // 5-minute active/away threshold.
    // Only real interaction refreshes the stamp; idle beats keep the
    // connection alive but let internal presence decay to "away".
    if (parsed.data.interacted !== false) {
      recordOperatorActivity(workspaceId, auth.userId, now.getTime());
    }
    const bucket = floorToBucket(now);
    const memoKey = `${workspaceId}:${auth.userId}`;
    const leaseKey = `${memoKey}:${source}`;

    // LIVE PRESENCE — the lease is now refreshed on every beat (at most one
    // write per LEASE_REWRITE_MS per source per process, see the memo), not
    // only in database-fallback mode. Rationale: a *successful but empty*
    // Centrifugo presence read is indistinguishable from "this operator's
    // subscription silently died", which used to pin a working, open panel to
    // "offline" for its whole session. The lease is one write per source per
    // heartbeat interval (2 min) on a bounded, single-row-per-operator table
    // — operators are dozens, unlike visitors — so it is a cheap, durable
    // second signal. Presence reads UNION realtime with this lease; realtime
    // remains the fast path and the lease can only ever add an operator.
    const fallbackPresence = await shouldWriteFallbackPresence(config, now.getTime(), workspaceId);
    const lastLease = lastLeaseWriteAt.get(leaseKey);
    if (lastLease === undefined || now.getTime() - lastLease >= LEASE_REWRITE_MS) {
      if (await recordOperatorPresenceBeat(config, workspaceId, auth.userId, now, source)) {
        if (lastLeaseWriteAt.size >= LAST_WRITTEN_MAX) lastLeaseWriteAt.clear();
        lastLeaseWriteAt.set(leaseKey, now.getTime());
      }
    }


    // ANALYTICS — already recorded this bucket in this process, so no sample
    // write at all. Safe: live presence was just refreshed above, so skipping
    // the analytics row cannot change anyone's online state.
    if (lastWrittenBucket.get(memoKey) === bucket) {
      return res.json({ ok: true, state: 'skipped', bucket, presence_mode: fallbackPresence ? 'database' : 'realtime' });
    }

    const { data: prefRows } = await readGlobalAvailabilityPrefs(sb, [auth.userId]);
    const prefs = (prefRows?.[0] ?? null) as Parameters<typeof computeOperatorState>[0];

    const { state } = computeOperatorState(prefs, now);

    // The analytics sample write is gone with its table: operator_activity_samples
    // was dropped from the database. It used to 404 here and this handler
    // turned that into a 500 — on the FIRST beat of every five-minute bucket
    // for every operator, since later beats in the same bucket short-circuit
    // on the memo above. Live presence is unaffected either way: the lease on
    // operator_presence_live is written earlier in this handler, before this
    // point, and that table still exists. So the beat now succeeds and
    // reports the operator's state exactly as it did before; only the
    // online-time history is no longer recorded.
    if (lastWrittenBucket.size >= LAST_WRITTEN_MAX) lastWrittenBucket.clear();
    lastWrittenBucket.set(memoKey, bucket);

    void pruneOldSamples(sb);

    return res.json({ ok: true, state, presence_mode: fallbackPresence ? 'database' : 'realtime' });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Heartbeat failed' });
  }
});

// ── POST /leave ───────────────────────────────────────────────────
// The panel's beacon when a tab goes away (header). Authenticated exactly as
// the heartbeat is (the session cookie, and the Origin check every cookie
// mutation gets). Ends only that tab's part of the lease; always 204, since
// a beacon reads no answer: a lease it could not end expires as before.
operatorActivityRouter.post('/leave', beaconText, async (req, res) => {
  try {
    const body = beaconBody(req.body);
    const workspaceId = typeof body.workspace_id === 'string' ? body.workspace_id : '';
    const source = presenceSourceOf(body.source_id);
    if (!z.string().uuid().safeParse(workspaceId).success || !source) {
      return res.status(400).json({ error: 'workspace_id and source_id required' });
    }
    const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
    if (!auth) return;
    lastLeaseWriteAt.delete(`${workspaceId}:${auth.userId}:${source}`);
    await endOperatorPresenceSource(serverConfigOf(req), workspaceId, auth.userId, source);
    return res.status(204).end();
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Leave failed' });
  }
});

/** One decimal, or null without ratings. */
function averageScore(sum: number, count: number): number | null {
  return count ? Math.round((sum / count) * 10) / 10 : null;
}

/**
 * Visitors' ratings in the window, per rated operator: { sum, count }. Empty
 * before migration 276, and when the read fails: the satisfaction column is
 * left out then, never the rest of the report.
 */
export async function ratingsByOperator(
  sb: ReturnType<typeof getServiceClient>,
  workspaceId: string,
  sinceIso: string,
): Promise<Map<string, { sum: number; count: number }>> {
  const out = new Map<string, { sum: number; count: number }>();
  const { data, error } = await sb
    .from('conversation_ratings')
    .select('operator_id, score')
    .eq('workspace_id', workspaceId)
    .gte('created_at', sinceIso)
    .limit(5000);
  if (error) {
    if (!isRelationMissing(error, 'conversation_ratings')) {
      console.warn('[operator-activity] ratings read failed:', error.message);
    }
    return out;
  }
  for (const r of (data || []) as Array<{ operator_id: string | null; score: number }>) {
    if (!r.operator_id) continue;
    const cur = out.get(r.operator_id) || { sum: 0, count: 0 };
    cur.sum += Number(r.score) || 0;
    cur.count += 1;
    out.set(r.operator_id, cur);
  }
  return out;
}

// ── GET /:workspaceId/stats ───────────────────────────────────────
operatorActivityRouter.get('/:workspaceId/stats', async (req, res) => {
  try {
    const workspaceId = req.params.workspaceId;
    // Only workspace owners/admins (or global admins) may see team stats.
    const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
    if (!auth) return;

    const days = Math.min(Math.max(parseInt(String(req.query.days || '7'), 10) || 7, 1), MAX_DAYS);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const sinceIso = since.toISOString();

    const config = serverConfigOf(req);
    const sb = getServiceClient(config);

    // Members + profiles
    const { data: members, error: memErr } = await sb
      .from('workspace_members')
      .select('user_id, role')
      .eq('workspace_id', workspaceId);
    if (memErr) return res.status(500).json({ error: memErr.message });

    const userIds = (members || []).map((m) => m.user_id);
    const [{ data: profiles }, { data: prefsRows }] = await Promise.all([
      userIds.length
        ? sb.from('profiles').select('id, full_name, email, avatar_storage_key').in('id', userIds)
        : Promise.resolve({ data: [] }),
      userIds.length
        ? readGlobalAvailabilityPrefs(sb, userIds)
        : Promise.resolve({ data: [] }),
    ]);

    await hydrateUserAvatars(config, (profiles || []));

    // Activity samples for the window. Always empty now: the
    // operator_activity_samples table was dropped from the database, so the
    // online-time series this report was built on no longer exists. The rest
    // of the report — assigned conversations and operator message counts —
    // still comes from live tables and is unaffected, so the endpoint keeps
    // its shape and returns zero online minutes instead of a 500.
    const samples: Array<{ user_id: string; bucket: string; available: boolean }> = [];

    // Conversations assigned + operator messages in the window.
    const { data: convs } = await sb
      .from('conversations')
      .select('id, assigned_to, status, created_at')
      .eq('workspace_id', workspaceId)
      .gte('created_at', sinceIso)
      .limit(5000);

    const convIds = (convs || []).map((c) => c.id);
    let messages: Array<{ sender_id: string | null; sender_type: string; conversation_id: string }> = [];
    if (convIds.length) {
      const { data: msgs } = await sb
        .from('conversation_messages')
        .select('sender_id, sender_type, conversation_id')
        .in('conversation_id', convIds.slice(0, 500))
        .eq('sender_type', 'agent')
        .gte('created_at', sinceIso)
        .limit(10000);
      messages = msgs || [];
    }

    const [ratings, presence] = await Promise.all([
      ratingsByOperator(sb, workspaceId, sinceIso),
      // Live presence, not the settings alone: who has a panel or the app
      // open right now (never fails: unknown reads as not connected).
      readRoutingPresence(config, workspaceId, userIds),
    ]);

    const profileMap = new Map((profiles || []).map((p) => [p.id, p]));
    const prefsMap = new Map((prefsRows || []).map((p) => [p.user_id, p]));
    const now = new Date();

    const rows = (members || []).map((m) => {
      const mine = samples.filter((s) => s.user_id === m.user_id);
      // Each stored row represents one 5-minute bucket. Legacy per-minute rows
      // are collapsed onto their bucket so a minute is never counted twice.
      const presentBuckets = new Set<string>();
      const onlineBuckets = new Set<string>();
      for (const s of mine) {
        const b = floorToBucket(s.bucket);
        presentBuckets.add(b);
        if (s.available) onlineBuckets.add(b);
      }
      const onlineMinutes = onlineBuckets.size * BUCKET_MINUTES;
      const presentMinutes = presentBuckets.size * BUCKET_MINUTES;
      const dayKeys = new Set(Array.from(presentBuckets).map((b) => b.slice(0, 10)));
      const lastSeen = mine.length ? mine[mine.length - 1].bucket : null;

      // per-day online minutes (chart series)
      const daily: Record<string, number> = {};
      for (const b of onlineBuckets) {
        const k = b.slice(0, 10);
        daily[k] = (daily[k] || 0) + BUCKET_MINUTES;
      }


      const assigned = (convs || []).filter((c) => c.assigned_to === m.user_id);
      const resolved = assigned.filter((c) => c.status === 'resolved' || c.status === 'closed').length;
      const replies = messages.filter((x) => x.sender_id === m.user_id).length;

      const live = computeOperatorState(prefsMap.get(m.user_id), now);
      const rated = ratings.get(m.user_id);
      const presenceState = presence.get(m.user_id)?.state ?? 'offline';

      return {
        user_id: m.user_id,
        role: m.role,
        profile: profileMap.get(m.user_id) || null,
        online_minutes: onlineMinutes,
        present_minutes: presentMinutes,
        active_days: dayKeys.size,
        avg_minutes_per_active_day: dayKeys.size ? Math.round(onlineMinutes / dayKeys.size) : 0,
        last_seen: lastSeen,
        daily,
        conversations_assigned: assigned.length,
        conversations_resolved: resolved,
        replies_sent: replies,
        csat_avg: averageScore(rated?.sum ?? 0, rated?.count ?? 0),
        csat_count: rated?.count ?? 0,
        current_state: live.state,
        current_reason: live.reason,
        presence_state: presenceState,
      };
    });

    rows.sort((a, b) => b.online_minutes - a.online_minutes);

    return res.json({
      days,
      since: sinceIso,
      // The online-time series is not recorded (header): online_minutes,
      // present_minutes, daily and last_seen are empty, not measured zeros.
      online_time_tracked: false,
      totals: {
        operators: rows.length,
        online_minutes: rows.reduce((s, r) => s + r.online_minutes, 0),
        replies_sent: rows.reduce((s, r) => s + r.replies_sent, 0),
        conversations_assigned: rows.reduce((s, r) => s + r.conversations_assigned, 0),
        // Connected right now (active or away), not merely "available" in
        // their settings.
        online_now: rows.filter((r) => r.presence_state === 'active' || r.presence_state === 'away').length,
        available_now: rows.filter((r) => r.current_state === 'online').length,
        // Every rating in the window, members' or not (a removed operator's
        // ratings still count for the team).
        csat_avg: averageScore(
          [...ratings.values()].reduce((s, r) => s + r.sum, 0),
          [...ratings.values()].reduce((s, r) => s + r.count, 0),
        ),
        csat_count: [...ratings.values()].reduce((s, r) => s + r.count, 0),
      },
      operators: rows,
    });
  } catch (err) {
    return res.status(500).json({ error: err?.message || 'Failed to load activity stats' });
  }
});
