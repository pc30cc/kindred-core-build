/**
 * NOTIFICATION PREFERENCES — self-service for the authenticated user.
 *
 * Auth: first-party session cookie (server/lib/workspaceAuth.ts).
 * Storage: `user_notification_prefs`, one row per (operator, workspace,
 * SURFACE), where `workspace_id NULL` means "my account, everywhere" and the
 * surface is the browser or the phone app.
 *
 * TWO SURFACES, TWO ROWS. They were one, and both clients wrote to it, so
 * silencing the phone silenced the browser and narrowing the browser
 * narrowed the phone. A phone is carried and a browser is sat in front of;
 * they are different questions and they now have different answers. Every
 * request says which surface it speaks for.
 *
 * WHAT IS NOT HERE. Six email switches and a "visitor browsing" switch used
 * to be — `email_unread_messages`, `email_transcripts`, `email_user_ratings`,
 * `email_paid_invoices`, `email_weekly_summary`, `email_product_updates`,
 * `push_visitor_browsing`. Nothing in this codebase ever read one of them:
 * no unread digest exists, no transcript is mailed to an operator, billing
 * mail goes to the workspace's billing contact rather than to whoever ticked
 * a box here, and nothing emits a "visitor is browsing" event at all. They
 * saved, answered 200, and changed nothing — which is worse than not
 * offering them, because an operator who turns one off believes it. The
 * columns stay (dropping them is irreversible, and they cost nothing); the
 * API no longer pretends. When one of those features is built, its switch
 * comes back with it.
 */

import { Router } from 'express';
import type { NextFunction, Request, Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser as requireSessionUser, serverConfigOf } from '../lib/workspaceAuth.js';

export const notificationsRouter = Router();

/** The signed-in operator, set by `requireUser` below for every route here. */
type AuthedRequest = Request & { authUser?: { id: string } };

async function requireUser(req: AuthedRequest, res: Response, next: NextFunction) {
  const userId = await requireSessionUser(req, res);
  if (!userId) return;
  req.authUser = { id: userId };
  next();
}

function authUserOf(req: Request): { id: string } {
  return (req as AuthedRequest).authUser as { id: string };
}

function messageOf(err: unknown, fallback: string): string {
  return (err as { message?: string } | null)?.message || fallback;
}

notificationsRouter.use(requireUser);

/** The surfaces an operator sets preferences for. */
export const PLATFORMS = ['web', 'mobile'] as const;
export type NotificationPlatform = (typeof PLATFORMS)[number];

/**
 * Which surface a request speaks for.
 *
 * 'web' when unsaid, because the browser is the older client and shipped
 * without ever naming itself — a build in somebody's tab right now is still
 * asking the old way, and must not start reading the phone's row.
 */
function platformOf(value: unknown): NotificationPlatform | null {
  if (value === undefined || value === null || value === '') return 'web';
  return (PLATFORMS as readonly string[]).includes(String(value))
    ? (String(value) as NotificationPlatform)
    : null;
}

/**
 * What an operator gets before they have ever opened the page.
 *
 * Every one of these is read by something that sends: `disable_all`,
 * `push_scope`, `push_preview`, `push_internal_notes`, the three event
 * switches and the quiet hours by `services/push/recipients.ts`, `play_sound`
 * by both that and the browser's own chime, and the two presence switches by
 * the same resolver.
 */
const DEFAULTS = {
  disable_all: false,
  push_scope: 'all' as 'all' | 'assigned' | 'mentions' | 'none',
  push_preview: true,
  push_internal_notes: true,
  // A colleague's direct message, a conversation handed to me (by a
  // colleague, by routing, or by the AI), a new email in the shared inbox.
  push_team_chat: true,
  push_assignments: true,
  push_email: true,
  push_when_online: true,
  push_when_offline: true,
  play_sound: true,
  quiet_hours_enabled: false,
  quiet_hours_start: null as string | null,
  quiet_hours_end: null as string | null,
  quiet_hours_timezone: null as string | null,
};

/** The columns the API reads and writes — never `select('*')`. */
const LEGACY_COLUMNS =
  'disable_all, push_scope, push_preview, push_internal_notes, push_when_online, push_when_offline, play_sound, quiet_hours_enabled, quiet_hours_start, quiet_hours_end, quiet_hours_timezone';
/** Migration 235's switches. */
const EVENT_KEYS = ['push_team_chat', 'push_assignments', 'push_email'] as const;
const COLUMNS = `${LEGACY_COLUMNS}, ${EVENT_KEYS.join(', ')}`;

/**
 * Postgres' "column does not exist": a database that has not had migration
 * 235 yet. Reads fall back to the older columns (the new switches then show
 * their defaults, which is what the sender assumes too) rather than failing
 * the whole page.
 */
function isMissingColumn(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42703' || error?.code === 'PGRST204';
}

function withoutEventKeys<T extends Record<string, unknown>>(patch: T): Partial<T> {
  const out: Record<string, unknown> = { ...patch };
  for (const key of EVENT_KEYS) delete out[key];
  return out as Partial<T>;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const updateSchema = z.object({
  disable_all: z.boolean().optional(),
  // Mirrors the table's own CHECK constraint, so an invalid scope is a 400
  // here rather than a 500 from Postgres.
  push_scope: z.enum(['all', 'assigned', 'mentions', 'none']).optional(),
  push_preview: z.boolean().optional(),
  push_internal_notes: z.boolean().optional(),
  push_team_chat: z.boolean().optional(),
  push_assignments: z.boolean().optional(),
  push_email: z.boolean().optional(),
  push_when_online: z.boolean().optional(),
  push_when_offline: z.boolean().optional(),
  play_sound: z.boolean().optional(),
  quiet_hours_enabled: z.boolean().optional(),
  quiet_hours_start: z.string().regex(TIME_RE).nullable().optional(),
  quiet_hours_end: z.string().regex(TIME_RE).nullable().optional(),
  quiet_hours_timezone: z.string().max(60).nullable().optional(),
});

// GET /api/notifications/prefs?platform=web|mobile
notificationsRouter.get('/prefs', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const user = authUserOf(req);
    const platform = platformOf(req.query.platform);
    if (!platform) return res.status(400).json({ error: 'Unknown platform' });

    const sb = getServiceClient(config);

    const read = (columns: string) => sb
      .from('user_notification_prefs')
      .select(columns)
      .eq('user_id', user.id)
      .eq('platform', platform)
      .is('workspace_id', null)
      .maybeSingle();

    let { data, error } = await read(COLUMNS);
    if (isMissingColumn(error)) ({ data, error } = await read(LEGACY_COLUMNS));

    if (error) return res.status(500).json({ error: error.message });
    return res.json({ platform, prefs: { ...DEFAULTS, ...((data as unknown as Record<string, unknown> | null) || {}) } });
  } catch (err) {
    return res.status(500).json({ error: messageOf(err, 'Failed to load preferences') });
  }
});

// PATCH /api/notifications/prefs — upsert by (user_id, workspace_id NULL, platform)
notificationsRouter.patch('/prefs', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const user = authUserOf(req);

    // The surface may travel in the body or the query string. The body is
    // where a JSON client naturally puts it; the query is what a client
    // sending a bare patch object already has to hand.
    const { platform: bodyPlatform, ...rest } = (req.body ?? {}) as Record<string, unknown>;
    const platform = platformOf(bodyPlatform ?? req.query.platform);
    if (!platform) return res.status(400).json({ error: 'Unknown platform' });

    const parsed = updateSchema.safeParse(rest);
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid input',
        details: parsed.error.flatten().fieldErrors,
      });
    }

    const sb = getServiceClient(config);

    const { data: existing } = await sb
      .from('user_notification_prefs')
      .select('id')
      .eq('user_id', user.id)
      .eq('platform', platform)
      .is('workspace_id', null)
      .maybeSingle();

    // Written with the new switches, and — on a database without them yet —
    // again without, so the rest of the change still saves.
    const write = (patch: Record<string, unknown>, columns: string) => existing?.id
      ? sb
        .from('user_notification_prefs')
        .update(patch)
        .eq('id', existing.id)
        .select(columns)
        .maybeSingle()
      : sb
        .from('user_notification_prefs')
        .insert({ user_id: user.id, workspace_id: null, platform, ...patch })
        .select(columns)
        .maybeSingle();

    let { data, error } = await write(parsed.data, COLUMNS);
    if (isMissingColumn(error)) ({ data, error } = await write(withoutEventKeys(parsed.data), LEGACY_COLUMNS));
    if (error) return res.status(500).json({ error: error.message });
    return res.json({ platform, prefs: { ...DEFAULTS, ...((data as unknown as Record<string, unknown> | null) || {}) } });
  } catch (err) {
    return res.status(500).json({ error: messageOf(err, 'Failed to update preferences') });
  }
});
