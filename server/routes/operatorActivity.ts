/**
 * OPERATOR ACTIVITY — online-time tracking & productivity stats.
 *
 * Self-hosted Express only (no edge functions).
 *
 * How online time is measured:
 *   The operator panel heartbeats while the tab is open and visible. Each
 *   heartbeat maps to a FIVE-MINUTE bucket in `operator_activity_samples`
 *   keyed by (workspace, user, bucket), storing whether the operator was
 *   *available* at that moment (derived from `user_availability_prefs`,
 *   the same logic the widget uses).
 *
 *   Write cost: at most one row — and, thanks to the in-process
 *   `lastWrittenBucket` guard, at most one INSERT attempt — per
 *   (workspace, user, 5-minute bucket). Repeat heartbeats inside the same
 *   bucket touch the database zero times. The UNIQUE index remains the
 *   authority across replicas/restarts (UPSERT, ignoreDuplicates).
 *
 *   Online minutes = distinct available buckets × 5. Legacy 1-minute rows
 *   collapse into their 5-minute slot, so history stays readable.
 *
 * Retention: rows older than RETENTION_DAYS are pruned at most once an hour
 * from this process, which covers the full MAX_DAYS reporting window.
 *
 * ─── ROUTES ────────────────────────────────────────────────────────
 *   POST /api/operator-activity/heartbeat  { workspace_id }
 *   GET  /api/operator-activity/:workspaceId/stats?days=7   (owner/admin)
 */

import { Router } from 'express';
import { z } from 'zod';
import { getServiceClient } from '../supabase.js';
import {
  authorizeWorkspaceAccess,
  serverConfigOf,
} from '../lib/workspaceAuth.js';
import { computeOperatorState } from '../services/widget/operatorPresence.js';

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

let lastPruneAt = 0;
const PRUNE_EVERY_MS = 60 * 60_000;

async function pruneOldSamples(sb: ReturnType<typeof getServiceClient>): Promise<void> {
  const now = Date.now();
  if (now - lastPruneAt < PRUNE_EVERY_MS) return;
  lastPruneAt = now;
  const cutoff = new Date(now - RETENTION_DAYS * 86_400_000).toISOString();
  const { error } = await sb.from('operator_activity_samples').delete().lt('bucket', cutoff);
  if (error) console.warn('[operator-activity] retention prune failed:', error.message);
}

// ── POST /heartbeat ───────────────────────────────────────────────
operatorActivityRouter.post('/heartbeat', async (req, res) => {
  try {
    const parsed = z.object({ workspace_id: z.string().uuid() }).safeParse(req.body || {});
    if (!parsed.success) return res.status(400).json({ error: 'workspace_id required' });
    const workspaceId = parsed.data.workspace_id;

    const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
    if (!auth) return;

    const config = serverConfigOf(req);
    const sb = getServiceClient(config);

    const bucket = floorToBucket(new Date());
    const memoKey = `${workspaceId}:${auth.userId}`;

    // Already recorded this bucket in this process → no database write at all.
    // Presence itself is served by visitor/operator presence, not by this row,
    // so skipping the write cannot change anyone's online state.
    if (lastWrittenBucket.get(memoKey) === bucket) {
      return res.json({ ok: true, state: 'skipped', bucket });
    }

    const { data: prefs } = await sb
      .from('user_availability_prefs')
      .select('user_id, force_offline, available_when_using_app, schedule_enabled, timezone, weekly_schedule')
      .eq('user_id', auth.userId)
      .is('workspace_id', null)
      .maybeSingle();

    const { state } = computeOperatorState(prefs as any, new Date());

    const { error } = await sb
      .from('operator_activity_samples')
      .upsert(
        {
          workspace_id: workspaceId,
          user_id: auth.userId,
          bucket,
          available: state === 'online',
        },
        { onConflict: 'workspace_id,user_id,bucket', ignoreDuplicates: true },
      );
    if (error) return res.status(500).json({ error: error.message });

    if (lastWrittenBucket.size >= LAST_WRITTEN_MAX) lastWrittenBucket.clear();
    lastWrittenBucket.set(memoKey, bucket);

    void pruneOldSamples(sb);

    return res.json({ ok: true, state });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Heartbeat failed' });
  }
});


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

    const userIds = (members || []).map((m: any) => m.user_id);
    const [{ data: profiles }, { data: prefsRows }] = await Promise.all([
      userIds.length
        ? sb.from('profiles').select('id, full_name, email, avatar_url').in('id', userIds)
        : Promise.resolve({ data: [] as any[] } as any),
      userIds.length
        ? sb
            .from('user_availability_prefs')
            .select('user_id, force_offline, available_when_using_app, schedule_enabled, timezone, weekly_schedule')
            .in('user_id', userIds)
            .is('workspace_id', null)
        : Promise.resolve({ data: [] as any[] } as any),
    ]);

    // Activity samples for the window (bounded).
    const samples: Array<{ user_id: string; bucket: string; available: boolean }> = [];
    const PAGE = 1000;
    for (let page = 0; page < 50; page++) {
      const { data, error } = await sb
        .from('operator_activity_samples')
        .select('user_id, bucket, available')
        .eq('workspace_id', workspaceId)
        .gte('bucket', sinceIso)
        .order('bucket', { ascending: true })
        .range(page * PAGE, page * PAGE + PAGE - 1);
      if (error) return res.status(500).json({ error: error.message });
      samples.push(...((data || []) as any));
      if (!data || data.length < PAGE) break;
    }

    // Conversations assigned + operator messages in the window.
    const { data: convs } = await sb
      .from('conversations')
      .select('id, assigned_to, status, created_at')
      .eq('workspace_id', workspaceId)
      .gte('created_at', sinceIso)
      .limit(5000);

    const convIds = (convs || []).map((c: any) => c.id);
    let messages: Array<{ sender_id: string | null; sender_type: string; conversation_id: string }> = [];
    if (convIds.length) {
      const { data: msgs } = await sb
        .from('conversation_messages')
        .select('sender_id, sender_type, conversation_id')
        .in('conversation_id', convIds.slice(0, 500))
        .eq('sender_type', 'agent')
        .gte('created_at', sinceIso)
        .limit(10000);
      messages = (msgs || []) as any;
    }

    const profileMap = new Map((profiles || []).map((p: any) => [p.id, p]));
    const prefsMap = new Map((prefsRows || []).map((p: any) => [p.user_id, p]));
    const now = new Date();

    const rows = (members || []).map((m: any) => {
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


      const assigned = (convs || []).filter((c: any) => c.assigned_to === m.user_id);
      const resolved = assigned.filter((c: any) => c.status === 'resolved' || c.status === 'closed').length;
      const replies = messages.filter((x) => x.sender_id === m.user_id).length;

      const live = computeOperatorState(prefsMap.get(m.user_id) as any, now);

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
        current_state: live.state,
        current_reason: live.reason,
      };
    });

    rows.sort((a, b) => b.online_minutes - a.online_minutes);

    return res.json({
      days,
      since: sinceIso,
      totals: {
        operators: rows.length,
        online_minutes: rows.reduce((s, r) => s + r.online_minutes, 0),
        replies_sent: rows.reduce((s, r) => s + r.replies_sent, 0),
        conversations_assigned: rows.reduce((s, r) => s + r.conversations_assigned, 0),
        online_now: rows.filter((r) => r.current_state === 'online').length,
      },
      operators: rows,
    });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to load activity stats' });
  }
});
