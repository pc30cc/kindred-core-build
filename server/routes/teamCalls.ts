/**
 * Colleague calls (team calls) — voice and video calls between two members
 * of one workspace, from the team chat, on the phones (owner, 2026-11-01).
 * The contract with the iOS and Android apps is docs/operations/TEAM_CALLS.md;
 * change it together with this file.
 *
 * Session auth (the cookie or the apps' Bearer token, server/lib/
 * workspaceAuth.ts). Every answer carries one `TeamCall` (teamCall.ts
 * `teamCallView`), seen from the caller's side of it.
 *
 * ─── ROUTES ────────────────────────────────────────────────────────
 *   POST /api/team-calls               { workspace_id, callee_id, channel }  → 201 { call }
 *   GET  /api/team-calls/:id                                                → { call }
 *   POST /api/team-calls/:id/accept    { device_id? }   callee             → { call } | 409 not_ringing
 *   POST /api/team-calls/:id/decline                    callee             → { call }
 *   POST /api/team-calls/:id/cancel                     caller             → { call }
 *   POST /api/team-calls/:id/hangup                     either             → { call }
 *   POST /api/team-calls/:id/token                      either, answered   → POST /api/calls/:id/token's answer
 *
 * A call is placed only when, all together: the caller and the callee are
 * two active members of the workspace (not suspended, no paused seat), the
 * plan has `team_calls` and the call composer allows the channel (plan
 * `voice_video` + `voice`/`video`, and the platform's and workspace's runtime
 * switches), the plan's `max_concurrent_calls` and
 * `max_call_minutes_per_month` have room (checked as POST /api/calls/create
 * checks them), and neither of the two is already on a call. The last is
 * read early (busyMembers) and decided for good where the row is written
 * (public.team_call_place, migration 293: the busy check and the insert
 * under a lock per member), so two calls placed at the same moment that
 * share a member never both ring. Deny on create, allow on continuity:
 * nothing after the create looks at the plan again — a token asked for again
 * mid-call does not look at the member's seat either — so a plan change
 * never cuts a call in flight.
 *
 * Only the two members of a call can see it or move it: anyone else gets 404
 * for it, as for a call that does not exist. Every move is a compare-and-set
 * (teamCallLifecycle.ts), so a repeat — a retried decline, a second hang-up,
 * a phone answering after another did — answers with the call as it is.
 *
 * Ringing (teamCallRing.ts), realtime and the missed-call notification never
 * hold up an answer: a call is placed even when no phone can be reached.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser, serverConfigOf } from '../lib/workspaceAuth.js';
import { checkEntitlementFromDB } from '../middleware/featureGating.js';
import { isUnreadableEntitlementReason } from '../services/billing/entitlementParse.js';
import { loadEffectiveCallEntitlements } from '../services/calls/entitlementComposer.js';
import { checkPlanConcurrencyCeiling } from '../services/calls/concurrencyLimit.js';
import { checkPlanMonthlyMinutesCeiling } from '../services/calls/monthlyMinutesLimit.js';
import { resolveEffectiveCallProvider } from '../services/calls/providerResolver.js';
import { CallProviderNotReadyError } from '../services/calls/providers/types.js';
import { CALL_ERROR_CODES, CALL_ERROR_HTTP_STATUS, callErrorBody } from '../services/calls/errorCodes.js';
import { emitCallMetric } from '../services/calls/metrics.js';
import { publicMemberName } from '../services/calls/operatorIdentity.js';
import { issueParticipantToken } from '../services/calls/participantToken.js';
import {
  TEAM_CALL_COLUMNS,
  isRingingNow,
  readTeamCallMeta,
  teamCallExpiresAt,
  teamCallPeerId,
  teamCallRingCutoff,
  teamCallRole,
  teamCallView,
  type TeamCallChannel,
  type TeamCallMeta,
  type TeamCallRow,
} from '../services/calls/teamCall.js';
import {
  acceptTeamCall,
  announceTeamCall,
  cancelTeamCall,
  declineTeamCall,
  expireTeamCall,
  failTeamCall,
  hangUpTeamCall,
  loadTeamCall,
} from '../services/calls/teamCallLifecycle.js';
import {
  busyMembers,
  isActiveMember,
  liveCallCutoff,
  remainsMember,
  teamCallPeers,
  workspaceDisplayName,
} from '../services/calls/teamCallPeople.js';
import { ringTeamCall, teamCallRingTargets } from '../services/push/teamCallRing.js';

export const teamCallsRouter = Router();

type TeamCallRequest = Request & { teamCallUserId?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The signed-in user, from the session only; every route below needs one. */
function userOf(req: Request): string {
  return (req as TeamCallRequest).teamCallUserId as string;
}

teamCallsRouter.use((req: Request, res: Response, next: NextFunction) => {
  requireUser(req, res)
    .then((userId) => {
      if (!userId) return;
      (req as TeamCallRequest).teamCallUserId = userId;
      next();
    })
    .catch(next);
});

// ─── Rate limits ─────────────────────────────────────────────────────
// A caller rings at most CALLER_RINGS_PER_MINUTE times a minute (every
// attempt counts, per user, whichever device it comes from); a callee is
// rung at most CALLEE_RINGS_PER_MINUTE times a minute, by everyone together,
// so a colleague cannot be rung over and over by several callers. The
// second is per process, counted only for calls that ring: a ring taken
// before the placement is given back when the placement does not place the
// call (busy, a failure), so attempts that never rang — a burst of them
// racing the busy check included — cannot use up a colleague's share. One
// replica is the common case, and the caller's limit holds whatever the count.
const CALLER_RINGS_PER_MINUTE = 10;
const CALLEE_RINGS_PER_MINUTE = 6;
const WINDOW_MS = 60_000;

const callerLimiter = rateLimit({
  windowMs: WINDOW_MS,
  limit: CALLER_RINGS_PER_MINUTE,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `team-call:${userOf(req)}`,
  handler: (_req, res) => {
    res.status(429).json({ error: 'too_many_calls' });
  },
});

const calleeRings = new Map<string, number[]>();

/** A ring taken from a callee's share, to keep or give back. */
interface CalleeRing {
  calleeId: string;
  at: number;
}

/** Takes one of the callee's rings for this minute; null when they have had their share. */
function takeCalleeRing(calleeId: string, now: number = Date.now()): CalleeRing | null {
  const since = now - WINDOW_MS;
  const recent = (calleeRings.get(calleeId) ?? []).filter((t) => t > since);
  if (recent.length >= CALLEE_RINGS_PER_MINUTE) {
    calleeRings.set(calleeId, recent);
    return null;
  }
  recent.push(now);
  calleeRings.set(calleeId, recent);
  // Keep the map to the callees rung within the window.
  if (calleeRings.size > 5_000) {
    for (const [id, times] of calleeRings) {
      if (!times.some((t) => t > since)) calleeRings.delete(id);
    }
  }
  return { calleeId, at: now };
}

/** Gives back a ring the placement did not use: the callee was never rung. */
function giveBackCalleeRing(ring: CalleeRing): void {
  const times = calleeRings.get(ring.calleeId);
  if (!times) return;
  const i = times.indexOf(ring.at);
  if (i >= 0) times.splice(i, 1);
  if (!times.length) calleeRings.delete(ring.calleeId);
}

/** Tests: forget every callee's rings, and these callers' attempts. */
export function __resetTeamCallRateLimitsForTests(callerIds: readonly string[] = []): void {
  calleeRings.clear();
  for (const id of callerIds) callerLimiter.resetKey(`team-call:${id}`);
}

// ─── Answers ─────────────────────────────────────────────────────────

/** `{ call }` (with [extra] fields), seen by [viewerId]. */
async function answerWithCall(
  res: Response,
  config: ServerConfig,
  row: TeamCallRow,
  viewerId: string,
  status = 200,
  extra: Record<string, unknown> = {},
): Promise<void> {
  const peerId = teamCallPeerId(readTeamCallMeta(row), viewerId);
  const peers = await teamCallPeers(config, [peerId]);
  const peer = peers.get(peerId) ?? { user_id: peerId, name: null, avatar_url: null };
  res.status(status).json({ ...extra, call: teamCallView(row, viewerId, peer) });
}

function failure(res: Response, where: string, err: unknown): void {
  console.error(`[team-calls ${where}] error:`, err instanceof Error ? err.message : err);
  if (res.headersSent) return;
  if (err instanceof CallProviderNotReadyError) {
    res.status(CALL_ERROR_HTTP_STATUS.provider_not_ready).json(
      callErrorBody(CALL_ERROR_CODES.PROVIDER_NOT_READY, err.message, { provider: err.providerId }),
    );
    return;
  }
  res.status(500).json({ error: 'internal_error' });
}

/**
 * The call [req] names, when the signed-in user is one of its two members;
 * otherwise 404, exactly as for a call that does not exist.
 */
async function participantCall(
  req: Request,
  res: Response,
): Promise<{ config: ServerConfig; row: TeamCallRow; meta: TeamCallMeta; userId: string; role: 'caller' | 'callee' } | null> {
  const config = serverConfigOf(req);
  const userId = userOf(req);
  const id = String(req.params.id || '');
  const row = UUID_RE.test(id) ? await loadTeamCall(config, id) : null;
  const meta = row ? readTeamCallMeta(row) : null;
  const role = meta ? teamCallRole(meta, userId) : null;
  if (!row || !meta || !role) {
    res.status(404).json({ error: 'not_found' });
    return null;
  }
  return { config, row, meta, userId, role };
}

/** A ring that ran out and that nobody marked missed yet is missed now. */
async function current(config: ServerConfig, row: TeamCallRow): Promise<TeamCallRow> {
  if (row.state === 'ringing' && !isRingingNow(row)) return (await expireTeamCall(config, row)).row;
  return row;
}

// ═══ POST /api/team-calls ═══════════════════════════════════════════
const createSchema = z.object({
  workspace_id: z.string().uuid(),
  callee_id: z.string().uuid(),
  channel: z.enum(['audio', 'video']),
});

teamCallsRouter.post('/', callerLimiter, async (req, res) => {
  const config = serverConfigOf(req);
  const callerId = userOf(req);
  // The callee's ring, held from just before the placement until it places
  // the call; any other way out of this handler gives it back (finally).
  let heldRing: CalleeRing | null = null;
  try {
    const parsed = createSchema.safeParse(req.body);
    if (!parsed.success || parsed.data.callee_id === callerId) {
      return res.status(400).json({ error: 'invalid_params' });
    }
    const { workspace_id: workspaceId, callee_id: calleeId } = parsed.data;
    const channel: TeamCallChannel = parsed.data.channel;

    // Two active members of this workspace. The caller's own check is not
    // authorizeWorkspaceAccess: a platform admin passes that without being a
    // member, and a colleague call is between members.
    const [callerActive, calleeActive] = await Promise.all([
      isActiveMember(config, workspaceId, callerId),
      isActiveMember(config, workspaceId, calleeId),
    ]);
    if (!callerActive || !calleeActive) return res.status(403).json({ error: 'not_a_member' });

    // The plan: `team_calls`, and the call composer for the channel.
    const [feature, eff] = await Promise.all([
      checkEntitlementFromDB(config.supabaseUrl, config.supabaseServiceRoleKey, workspaceId, 'team_calls', {
        selfHostBillingUnlimited: config.selfHostBillingUnlimited === true,
      }),
      loadEffectiveCallEntitlements(config, workspaceId),
    ]);
    // An unreadable entitlement is an outage to retry, not a plan to upgrade.
    if (isUnreadableEntitlementReason(feature.reason)) {
      return res.status(503).json({ error: 'entitlement_status_unavailable', retryable: true });
    }
    if (!feature.allowed) {
      return res.status(403).json({ error: 'upgrade_required', feature: 'team_calls', upgrade_required: true });
    }
    const channelAllowed = channel === 'video' ? eff.video_enabled : eff.voice_enabled;
    if (!channelAllowed) {
      // Which half said no: the plan (voice_video, the channel) or the
      // platform's or workspace's switches.
      const planAllows = eff.plan.voice_video && (channel === 'video' ? eff.plan.video : eff.plan.voice);
      return res.status(403).json({
        error: 'upgrade_required',
        feature: 'team_calls',
        capability: channel === 'video' ? 'voice_video.video' : 'voice_video.voice',
        reason: planAllows ? 'runtime' : 'plan',
        upgrade_required: !planAllows,
      });
    }

    // The plan's call limits, exactly as POST /api/calls/create reads them.
    const [concurrency, minutes] = await Promise.all([
      checkPlanConcurrencyCeiling(config, workspaceId),
      checkPlanMonthlyMinutesCeiling(config, workspaceId),
    ]);
    for (const [limit, decision] of [
      ['max_concurrent_calls', concurrency],
      ['max_call_minutes_per_month', minutes],
    ] as const) {
      if (!decision.allowed) {
        return res.status(422).json({
          error: 'limit_reached',
          limit,
          reason: decision.reason,
          max: decision.limit,
          used: decision.used,
          upgrade_required: decision.reason !== 'usage_unavailable',
        });
      }
    }

    const busy = await busyMembers(config, [callerId, calleeId]);
    if (busy.has(callerId)) return res.status(409).json({ error: 'caller_busy' });
    if (busy.has(calleeId)) return res.status(409).json({ error: 'callee_busy' });
    heldRing = takeCalleeRing(calleeId);
    if (!heldRing) return res.status(429).json({ error: 'too_many_calls' });

    const { id: providerId, provider } = await resolveEffectiveCallProvider(config, workspaceId);

    // The phones are chosen before the row exists and recorded in it: the
    // cancel goes to exactly these, and nothing writes the row while it rings.
    const targets = await teamCallRingTargets(config, calleeId);
    const meta: TeamCallMeta = {
      caller_user_id: callerId,
      callee_user_id: calleeId,
      channel,
      outcome: null,
      answered_device_id: null,
      answered_at: null,
      rung_android_device_ids: targets.android.map((d) => d.deviceId),
      rung_ios_device_ids: targets.ios.map((d) => d.deviceId),
    };
    // The busy check again and the row, in one transaction under both
    // members' locks: whoever got there first in the meantime keeps the line.
    const sb = getServiceClient(config);
    const { data: placed, error: placeError } = await sb.rpc('team_call_place', {
      p_workspace_id: workspaceId,
      p_caller_id: callerId,
      p_callee_id: calleeId,
      p_channel: channel,
      p_provider: providerId,
      p_metadata: { team_call: meta },
      p_ring_cutoff: teamCallRingCutoff().toISOString(),
      p_live_since: liveCallCutoff().toISOString(),
    });
    const verdict = (placed ?? null) as { verdict?: string; call?: TeamCallRow } | null;
    if (verdict?.verdict === 'caller_busy' || verdict?.verdict === 'callee_busy') {
      return res.status(409).json({ error: verdict.verdict });
    }
    if (placeError || verdict?.verdict !== 'placed' || !verdict.call?.id) {
      console.error('[team-calls create] placement failed:', placeError?.message ?? `verdict ${String(verdict?.verdict)}`);
      return res.status(500).json({ error: 'internal_error' });
    }
    let row: TeamCallRow = verdict.call;
    // Placed: the callee is being rung, so the ring counts from here on.
    heldRing = null;

    // The room, with no one named in it: its metadata is the workspace and
    // the call id (livekitProvider), never a user. Room for a rejoin, which
    // replaces a member's earlier connection.
    try {
      const room = await provider.createRoom(config, {
        workspaceId,
        callSessionId: row.id,
        callType: channel,
        maxParticipants: 4,
        recordingEnabled: false,
      });
      const { data: withRoom, error: roomError } = await sb
        .from('call_sessions')
        .update({ provider_room_id: room.providerRoomId })
        .eq('id', row.id)
        .select(TEAM_CALL_COLUMNS)
        .single();
      if (roomError || !withRoom) throw new Error(roomError?.message || 'room_not_recorded');
      row = withRoom as TeamCallRow;
    } catch (err) {
      void failTeamCall(config, row).catch(() => { /* the row stays ringing until the ticker misses it */ });
      emitCallMetric(config, {
        metric: err instanceof CallProviderNotReadyError ? 'call.provider.not_ready' : 'call.create.failure',
        workspaceId,
        provider: providerId,
        callId: row.id,
        reason: String(err instanceof Error ? err.message : err).slice(0, 120),
      });
      return failure(res, 'create', err);
    }

    const [peers, workspaceName] = await Promise.all([
      teamCallPeers(config, [callerId, calleeId]),
      workspaceDisplayName(config, workspaceId),
    ]);
    const caller = peers.get(callerId);
    // Started before the answer leaves, so that anything stopping the call —
    // which needs the call's id from this answer — finds the ring under way
    // and sends its stop after it (teamCallRing.ts). Never rejects.
    void ringTeamCall(config, {
      callId: row.id,
      workspaceId,
      workspaceName,
      channel,
      callerUserId: callerId,
      callerName: caller?.name ?? '',
      callerAvatarUrl: caller?.avatar_url ?? null,
      expiresAt: Math.floor(teamCallExpiresAt(row).getTime() / 1000),
    }, targets);
    void announceTeamCall(config, row, { actorId: callerId });
    emitCallMetric(config, {
      metric: 'call.create.success',
      workspaceId,
      provider: providerId,
      callId: row.id,
      callType: channel,
    });

    const callee = peers.get(calleeId) ?? { user_id: calleeId, name: null, avatar_url: null };
    return res.status(201).json({ call: teamCallView(row, callerId, callee) });
  } catch (err) {
    return failure(res, 'create', err);
  } finally {
    if (heldRing) giveBackCalleeRing(heldRing);
  }
});

// ═══ GET /api/team-calls/:id ════════════════════════════════════════
teamCallsRouter.get('/:id', async (req, res) => {
  try {
    const ctx = await participantCall(req, res);
    if (!ctx) return;
    await answerWithCall(res, ctx.config, await current(ctx.config, ctx.row), ctx.userId);
  } catch (err) {
    failure(res, 'get', err);
  }
});

// ═══ POST /api/team-calls/:id/accept ════════════════════════════════
const acceptSchema = z.object({
  device_id: z.string().min(4).max(128).optional(),
});

teamCallsRouter.post('/:id/accept', async (req, res) => {
  try {
    const ctx = await participantCall(req, res);
    if (!ctx) return;
    if (ctx.role !== 'callee') return res.status(403).json({ error: 'forbidden' });
    const parsed = acceptSchema.safeParse(req.body ?? {});
    if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
    // Answering joins the call: only while still an active member.
    if (!(await isActiveMember(ctx.config, ctx.row.workspace_id, ctx.userId))) {
      return res.status(403).json({ error: 'not_a_member' });
    }
    const move = await acceptTeamCall(ctx.config, ctx.row, {
      userId: ctx.userId,
      deviceId: parsed.data.device_id ?? null,
    });
    if (!move.moved) return answerWithCall(res, ctx.config, move.row, ctx.userId, 409, { error: 'not_ringing' });
    await answerWithCall(res, ctx.config, move.row, ctx.userId);
  } catch (err) {
    failure(res, 'accept', err);
  }
});

// ═══ POST /api/team-calls/:id/decline ═══════════════════════════════
teamCallsRouter.post('/:id/decline', async (req, res) => {
  try {
    const ctx = await participantCall(req, res);
    if (!ctx) return;
    if (ctx.role !== 'callee') return res.status(403).json({ error: 'forbidden' });
    const move = await declineTeamCall(ctx.config, ctx.row, ctx.userId);
    await answerWithCall(res, ctx.config, move.row, ctx.userId);
  } catch (err) {
    failure(res, 'decline', err);
  }
});

// ═══ POST /api/team-calls/:id/cancel ════════════════════════════════
teamCallsRouter.post('/:id/cancel', async (req, res) => {
  try {
    const ctx = await participantCall(req, res);
    if (!ctx) return;
    if (ctx.role !== 'caller') return res.status(403).json({ error: 'forbidden' });
    const move = await cancelTeamCall(ctx.config, ctx.row, ctx.userId);
    await answerWithCall(res, ctx.config, move.row, ctx.userId);
  } catch (err) {
    failure(res, 'cancel', err);
  }
});

// ═══ POST /api/team-calls/:id/hangup ════════════════════════════════
teamCallsRouter.post('/:id/hangup', async (req, res) => {
  try {
    const ctx = await participantCall(req, res);
    if (!ctx) return;
    const move = await hangUpTeamCall(ctx.config, ctx.row, ctx.userId);
    await answerWithCall(res, ctx.config, move.row, ctx.userId);
  } catch (err) {
    failure(res, 'hangup', err);
  }
});

// ═══ POST /api/team-calls/:id/token ═════════════════════════════════
// This user's own token, in the answer POST /api/calls/:id/token gives:
// identity and name from the session (an `internal:<opaque ref>` identity
// and the profile's own name), never from the body.
//
// Asked for once the call is answered, and again whenever an app has to
// rejoin the room (a network change the media layer could not ride out): it
// is the call going on, not a new one. So a seat the plan paused since the
// call was placed does not refuse it — a plan change never cuts a call in
// flight — while a member removed or suspended since is out.
teamCallsRouter.post('/:id/token', async (req, res) => {
  try {
    const ctx = await participantCall(req, res);
    if (!ctx) return;
    if (ctx.row.state !== 'connecting' && ctx.row.state !== 'active') {
      return answerWithCall(res, ctx.config, await current(ctx.config, ctx.row), ctx.userId, 409, { error: 'not_connected' });
    }
    if (!(await remainsMember(ctx.config, ctx.row.workspace_id, ctx.userId))) {
      return res.status(403).json({ error: 'not_a_member' });
    }
    const answer = await issueParticipantToken(ctx.config, {
      id: ctx.row.id,
      workspace_id: ctx.row.workspace_id,
      provider: ctx.row.provider as Parameters<typeof issueParticipantToken>[1]['provider'],
      provider_room_id: ctx.row.provider_room_id,
    }, {
      participantType: 'internal',
      participantId: ctx.userId,
      displayName: await publicMemberName(ctx.config, ctx.userId),
    });
    res.status(answer.status).json(answer.body);
  } catch (err) {
    failure(res, 'token', err);
  }
});
