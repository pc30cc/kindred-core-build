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

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { listWorkspacePresence } from '../services/widget/operatorPresence.js';
import { requireUser as requireSessionUser } from '../lib/workspaceAuth.js';

export const availabilityRouter = Router();

async function requireUser(req: any, res: any, next: any) {
  const userId = await requireSessionUser(req, res);
  if (!userId) return;
  req.authUser = { id: userId };
  next();
}

availabilityRouter.use(requireUser);

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
type DayKey = (typeof DAY_KEYS)[number];

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
 * Default timezone per UI locale. Persian operators default to Tehran,
 * Turkish to Istanbul; everyone else falls back to UTC.
 */
const LOCALE_TIMEZONES: Record<string, string> = {
  fa: 'Asia/Tehran',
  tr: 'Europe/Istanbul',
  en: 'UTC',
};

function defaultTimezone(locale?: unknown): string {
  const key = typeof locale === 'string' ? locale.slice(0, 2).toLowerCase() : '';
  return LOCALE_TIMEZONES[key] || 'UTC';
}

const DEFAULTS = {
  force_offline: false,
  available_when_using_app: true,
  schedule_enabled: false,
  timezone: 'UTC',
  weekly_schedule: DEFAULT_WEEKLY,
};

function partsInTz(date: Date, tz: string) {
  let parts: Intl.DateTimeFormatPart[];
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(date);
  } catch {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      weekday: 'short',
    }).formatToParts(date);
  }
  const get = (t: string) => parts.find((p) => p.type === t)?.value || '';
  const dowMap: Record<string, DayKey> = {
    Sun: 'sun', Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat',
  };
  return {
    h: Number(get('hour') === '24' ? '0' : get('hour')),
    m: Number(get('minute')),
    dow: dowMap[get('weekday') as string] ?? 'mon',
  };
}

function isWithinIntervals(intervals: Array<{ from: string; to: string }>, h: number, m: number) {
  const cur = h * 60 + m;
  for (const it of intervals || []) {
    const f = /^(\d{1,2}):(\d{2})$/.exec(it.from || '');
    const t = /^(\d{1,2}):(\d{2})$/.exec(it.to || '');
    if (!f || !t) continue;
    const fm = Number(f[1]) * 60 + Number(f[2]);
    const tm = Number(t[1]) * 60 + Number(t[2]);
    if (fm <= cur && cur < tm) return true;
  }
  return false;
}

/**
 * Live status from prefs. Returned as part of GET so the UI shows the
 * "You are currently seen as: …" banner without duplicating logic.
 *   - force_offline    => 'offline'
 *   - schedule disabled, available_when_using_app => 'online'
 *   - schedule enabled => check today's intervals
 */
function computeLiveStatus(prefs: typeof DEFAULTS): { state: 'online' | 'offline'; reason: string } {
  if (prefs.force_offline) return { state: 'offline', reason: 'force_offline' };

  if (!prefs.schedule_enabled) {
    return prefs.available_when_using_app
      ? { state: 'online', reason: 'available_when_using_app' }
      : { state: 'offline', reason: 'unavailable_when_using_app' };
  }

  const tz = prefs.timezone || 'UTC';
  const { h, m, dow } = partsInTz(new Date(), tz);
  const day = (prefs.weekly_schedule as any)?.[dow];
  if (!day || day.enabled === false) {
    return { state: 'offline', reason: 'day_disabled' };
  }
  return isWithinIntervals(day.intervals || [], h, m)
    ? { state: 'online', reason: 'within_schedule' }
    : { state: 'offline', reason: 'outside_schedule' };
}

function mergeWithDefaults(row: any, locale?: unknown) {
  const weekly = (row?.weekly_schedule && typeof row.weekly_schedule === 'object')
    ? { ...DEFAULT_WEEKLY, ...row.weekly_schedule }
    : DEFAULT_WEEKLY;
  return {
    force_offline: !!row?.force_offline,
    available_when_using_app: row?.available_when_using_app ?? true,
    schedule_enabled: !!row?.schedule_enabled,
    timezone: typeof row?.timezone === 'string' && row.timezone
      ? row.timezone
      : defaultTimezone(locale),
    weekly_schedule: weekly,
  };
}

// ── GET /api/availability ─────────────────────────────────────────
availabilityRouter.get('/', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
    const sb = getServiceClient(config);

    const { data, error } = await sb
      .from('user_availability_prefs')
      .select('*')
      .eq('user_id', user.id)
      .is('workspace_id', null)
      .maybeSingle();

    if (error) return res.status(500).json({ error: error.message });
    const prefs = mergeWithDefaults(data, req.query?.locale);
    const status = computeLiveStatus(prefs);
    return res.json({ prefs, status });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to load availability' });
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
  schedule_enabled: z.boolean().optional(),
  timezone: z.string().min(1).max(60).optional(),
  weekly_schedule: weeklySchema.optional(),
});

availabilityRouter.patch('/', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
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
    const patch: Record<string, unknown> = { ...parsed.data };
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

    const prefs = mergeWithDefaults(row);
    const status = computeLiveStatus(prefs);
    return res.json({ prefs, status });
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to update availability' });
  }
});

// ── GET /api/availability/team/:workspaceId ───────────────────────
// Live presence for every member of a workspace. Used by the inbox
// assignee dropdown and Team page so operators can see who's around.
// Auth: must be a member of the workspace (RLS enforced via membership
// check below; we use service client for the actual computation).
availabilityRouter.get('/team/:workspaceId', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const user = (req as any).authUser;
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
  } catch (err: any) {
    return res.status(500).json({ error: err?.message || 'Failed to load team presence' });
  }
});