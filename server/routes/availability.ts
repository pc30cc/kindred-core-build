/**
 * USER AVAILABILITY — per-operator presence schedule.
 *
 * Auth: first-party session cookie (server/lib/workspaceAuth.ts).
 * Storage: row-per-(user, workspace) — workspace_id NULL = global default.
 * Computes a live snapshot (online/offline/away) on every GET so the UI
 * can show "You are currently seen as: …" without reimplementing logic.
 *
 * Design notes:
 *   - This is the OPERATOR's own availability, not the workspace-wide
 *     widget business hours (those live in `widget_settings.business_hours`
 *     and are resolved by `server/services/widget/availability.ts`).
 *   - We never block: missing row returns sensible defaults so the page
 *     always renders.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { publishCacheInvalidation } from '../lib/cacheBus.js';
import { listWorkspacePresence } from '../services/widget/operatorPresence.js';
import {
  computeCustomerAvailability,
  type CustomerAvailabilityReason,
} from '../services/widget/customerAvailability.js';
import { requireUser as requireSessionUser } from '../lib/workspaceAuth.js';
import { getPlatformEditionOrNull } from '../services/platformRegion.js';
import type { Edition } from '../../shared/edition.js';

export const availabilityRouter = Router();

/** What this router reads off a request (set by the server and by requireUser below). */
type AvailabilityRequest = Request & { serverConfig: ServerConfig; authUser: { id: string } };

function ctx(req: Request): { config: ServerConfig; user: { id: string } } {
  const r = req as AvailabilityRequest;
  return { config: r.serverConfig, user: r.authUser };
}

function errorMessage(err: unknown): string | undefined {
  return err instanceof Error ? err.message : undefined;
}

async function requireUser(req: Request, res: Response, next: NextFunction) {
  const userId = await requireSessionUser(req, res);
  if (!userId) return;
  (req as AvailabilityRequest).authUser = { id: userId };
  next();
}

availabilityRouter.use(requireUser);

const DEFAULT_WEEKLY = {
  mon: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  tue: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  wed: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  thu: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  fri: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  sat: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
  sun: { enabled: true, intervals: [{ from: '09:00', to: '18:00' }] },
};

/**
 * Default timezone per UI locale in the Iranian edition: Persian operators
 * default to Tehran, Turkish to Istanbul; everyone else falls back to UTC.
 */
const LOCALE_TIMEZONES: Record<string, string> = {
  fa: 'Asia/Tehran',
  tr: 'Europe/Istanbul',
  en: 'UTC',
};

/** A valid IANA zone name, or null. */
function validTimeZone(tz: unknown): string | null {
  if (typeof tz !== 'string' || !tz.trim() || tz.length > 64) return null;
  try {
    return new Intl.DateTimeFormat('en-US', { timeZone: tz.trim() }).resolvedOptions().timeZone;
  } catch {
    return null;
  }
}

/**
 * The zone of an operator who never saved one. Iranian edition (or an
 * unknown edition): by UI locale, exactly as before. International: the
 * browser's zone when the client sent it, else UTC — Persian never means
 * Tehran there.
 */
export function defaultTimezone(locale?: unknown, edition: Edition | null = 'iran', browserTz?: unknown): string {
  const key = typeof locale === 'string' ? locale.slice(0, 2).toLowerCase() : '';
  if (edition !== 'international') return LOCALE_TIMEZONES[key] || 'UTC';
  return validTimeZone(browserTz) || 'UTC';
}

const DEFAULTS = {
  force_offline: false,
  available_when_using_app: true,
  manual_away: false,
  schedule_enabled: false,
  timezone: 'UTC',
  weekly_schedule: DEFAULT_WEEKLY,
};

/** The banner's reason codes (the macOS app reads outside_schedule / day_disabled). */
const LIVE_STATUS_REASON: Record<CustomerAvailabilityReason, string> = {
  manual_offline: 'force_offline',
  manual_invisible: 'unavailable_when_using_app',
  manual_away: 'manual_away',
  always_available: 'available_when_using_app',
  no_prefs: 'available_when_using_app',
  within_schedule: 'within_schedule',
  outside_schedule: 'outside_schedule',
  day_disabled: 'day_disabled',
};

/**
 * Live status from prefs, returned with GET and PATCH so the UI shows the
 * "You are currently seen as: …" banner. It is the customer-facing resolver
 * itself (computeCustomerAvailability: what the widget and routing read), so
 * the banner never says something visitors do not see (R-07: it used to
 * follow the schedule while "Show me as available" was off, which the widget
 * reads as invisible whatever the schedule says).
 */
export function computeLiveStatus(
  prefs: typeof DEFAULTS,
  now: Date = new Date(),
): { state: 'online' | 'offline'; reason: string } {
  const { availability, reason } = computeCustomerAvailability(prefs, now);
  return {
    state: availability === 'available' ? 'online' : 'offline',
    reason: LIVE_STATUS_REASON[reason] || reason,
  };
}

/** A stored `user_availability_prefs` row (or nothing yet). */
interface AvailabilityRow {
  force_offline?: boolean | null;
  available_when_using_app?: boolean | null;
  manual_away?: boolean | null;
  schedule_enabled?: boolean | null;
  timezone?: unknown;
  weekly_schedule?: unknown;
}

function mergeWithDefaults(row: AvailabilityRow | null | undefined, locale?: unknown, edition: Edition | null = 'iran', browserTz?: unknown) {
  const weekly = (row?.weekly_schedule && typeof row.weekly_schedule === 'object')
    ? { ...DEFAULT_WEEKLY, ...(row.weekly_schedule as Partial<typeof DEFAULT_WEEKLY>) }
    : DEFAULT_WEEKLY;
  return {
    force_offline: !!row?.force_offline,
    available_when_using_app: row?.available_when_using_app ?? true,
    manual_away: row?.manual_away === true,
    schedule_enabled: !!row?.schedule_enabled,
    timezone: typeof row?.timezone === 'string' && row.timezone
      ? (row.timezone as string)
      : defaultTimezone(locale, edition, browserTz),
    weekly_schedule: weekly,
  };
}

// ── GET /api/availability ─────────────────────────────────────────
availabilityRouter.get('/', async (req, res) => {
  try {
    const { config, user } = ctx(req);
    const sb = getServiceClient(config);

    const { data, error } = await sb
      .from('user_availability_prefs')
      .select('*')
      .eq('user_id', user.id)
      .is('workspace_id', null)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    // Only an operator with no saved zone needs the edition.
    const edition = data?.timezone ? 'iran' : await getPlatformEditionOrNull(config);
    const prefs = mergeWithDefaults(data, req.query?.locale, edition, req.query?.tz);
    const status = computeLiveStatus(prefs);
    return res.json({ prefs, status });
  } catch (err: unknown) {
    return res.status(500).json({ error: errorMessage(err) || 'Failed to load availability' });
  }
});

// ── PATCH /api/availability ───────────────────────────────────────
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

const intervalSchema = z.object({
  from: z.string().regex(TIME_RE),
  to: z.string().regex(TIME_RE),
});

const daySchema = z.object({
  enabled: z.boolean(),
  intervals: z.array(intervalSchema).max(8),
});

const weeklySchema = z.object({
  mon: daySchema, tue: daySchema, wed: daySchema, thu: daySchema,
  fri: daySchema, sat: daySchema, sun: daySchema,
}).partial();

const updateSchema = z.object({
  force_offline: z.boolean().optional(),
  available_when_using_app: z.boolean().optional(),
  /** "Away from desk" (migration 282): no new chats, keeps the ones they hold. */
  manual_away: z.boolean().optional(),
  schedule_enabled: z.boolean().optional(),
  timezone: z.string().min(1).max(60).optional(),
  weekly_schedule: weeklySchema.optional(),
});

/**
 * What a PATCH writes. A client that knows only force_offline (the desktop
 * and phone apps, the Availability page's "Appear offline") means Online or
 * Offline by it, so writing force_offline without manual_away also ends an
 * "Away from desk": otherwise their Online would leave them away, out of
 * routing, with nothing on their screen to say so.
 */
export function availabilityPatchOf(data: z.infer<typeof updateSchema>): Record<string, unknown> {
  const patch: Record<string, unknown> = { ...data };
  if (data.force_offline !== undefined && data.manual_away === undefined) patch.manual_away = false;
  return patch;
}

availabilityRouter.patch('/', async (req, res) => {
  try {
    const { config, user } = ctx(req);
    const parsed = updateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid input',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    const sb = getServiceClient(config);

    const { data: existing } = await sb
      .from('user_availability_prefs')
      .select('*')
      .eq('user_id', user.id)
      .is('workspace_id', null)
      .maybeSingle();

    // Merge weekly_schedule patches with the current row so a partial
    // PATCH (e.g. just toggling Tuesday) doesn't wipe other days.
    const patch = availabilityPatchOf(parsed.data);
    if (parsed.data.weekly_schedule) {
      const current = mergeWithDefaults(existing).weekly_schedule;
      patch.weekly_schedule = { ...current, ...parsed.data.weekly_schedule };
    }

    let row;
    if (existing?.id) {
      const { data, error } = await sb
        .from('user_availability_prefs')
        .update(patch)
        .eq('id', existing.id)
        .select('*')
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      row = data;
    } else {
      const { data, error } = await sb
        .from('user_availability_prefs')
        .insert({ user_id: user.id, workspace_id: null, ...patch })
        .select('*')
        .maybeSingle();
      if (error) return res.status(500).json({ error: error.message });
      row = data;
    }

    // Every workspace whose widget shows this operator.
    publishCacheInvalidation([`user:${user.id}`]);
    const prefs = mergeWithDefaults(row);
    const status = computeLiveStatus(prefs);
    return res.json({ prefs, status });
  } catch (err: unknown) {
    return res.status(500).json({ error: errorMessage(err) || 'Failed to update availability' });
  }
});

// ── GET /api/availability/team/:workspaceId ───────────────────────
// Live presence for every member of a workspace. Used by the inbox
// assignee dropdown and Team page so operators can see who's around.
// Auth: must be a member of the workspace (RLS enforced via membership
// check below; we use service client for the actual computation).
availabilityRouter.get('/team/:workspaceId', async (req, res) => {
  try {
    const { config, user } = ctx(req);
    const workspaceId = req.params.workspaceId;
    if (!workspaceId) return res.status(400).json({ error: 'Missing workspaceId' });

    const sb = getServiceClient(config);
    const { data: membership } = await sb
      .from('workspace_members')
      .select('user_id')
      .eq('workspace_id', workspaceId)
      .eq('user_id', user.id)
      .maybeSingle();
    if (!membership) return res.status(403).json({ error: 'Not a workspace member' });

    const presence = await listWorkspacePresence(config, workspaceId);
    return res.json({ presence, fetched_at: new Date().toISOString() });
  } catch (err: unknown) {
    return res.status(500).json({ error: errorMessage(err) || 'Failed to load team presence' });
  }
});