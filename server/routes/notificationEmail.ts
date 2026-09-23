/**
 * THE OPERATOR'S OWN EMAIL SWITCHES.
 *
 * Separate from `/api/notifications/prefs`, which carries a SURFACE — the
 * browser's preferences or the phone's. An email is not sent to a browser or
 * to a phone; it is sent to a person, once, so it has a row of its own and
 * an endpoint of its own.
 *
 * The response carries `available` as well as the preferences, because the
 * operator's page must show only what the platform actually offers: a switch
 * for a type Super Admin has turned off is the exact thing this whole piece
 * of work exists to stop.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser as requireSessionUser, serverConfigOf } from '../lib/workspaceAuth.js';
import { NOTIFICATION_EMAIL_TYPES } from '../services/notificationEmail/types.js';
import { enabledTypes, loadNotificationEmailSettings } from '../services/notificationEmail/settings.js';

export const notificationEmailRouter = Router();

/** A request once `requireUser` has let it through. */
type AuthedRequest = Request & { authUser?: { id: string } };

async function requireUser(req: Request, res: Response, next: NextFunction) {
  const userId = await requireSessionUser(req, res);
  if (!userId) return;
  (req as AuthedRequest).authUser = { id: userId };
  next();
}

function messageOf(err: unknown, fallback: string): string {
  return err instanceof Error && err.message ? err.message : fallback;
}

notificationEmailRouter.use(requireUser);

/** On, every one, because the platform switch decides what is offered. */
const DEFAULTS: Record<string, boolean> = Object.fromEntries(
  NOTIFICATION_EMAIL_TYPES.map((type) => [type, true]),
);

const COLUMNS = NOTIFICATION_EMAIL_TYPES.join(', ');

const updateSchema = z.object(
  Object.fromEntries(
    NOTIFICATION_EMAIL_TYPES.map((type) => [type, z.boolean().optional()]),
  ) as Record<(typeof NOTIFICATION_EMAIL_TYPES)[number], z.ZodOptional<z.ZodBoolean>>,
);

// GET /api/notifications/email
notificationEmailRouter.get('/', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const user = (req as AuthedRequest).authUser!;
    const sb = getServiceClient(config);

    const [settings, row] = await Promise.all([
      loadNotificationEmailSettings(config),
      sb
        .from('user_email_notification_prefs')
        .select(COLUMNS)
        .eq('user_id', user.id)
        .maybeSingle(),
    ]);

    if (row.error) return res.status(500).json({ error: row.error.message });

    return res.json({
      available: enabledTypes(settings),
      prefs: { ...DEFAULTS, ...((row.data as unknown as Record<string, unknown> | null) || {}) },
    });
  } catch (err: unknown) {
    return res.status(500).json({ error: messageOf(err, 'Failed to load email preferences') });
  }
});

// PATCH /api/notifications/email
notificationEmailRouter.patch('/', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const user = (req as AuthedRequest).authUser!;

    const parsed = updateSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return res.status(400).json({
        error: 'Invalid input',
        details: parsed.error.flatten().fieldErrors,
      });
    }
    if (!Object.keys(parsed.data).length) {
      return res.status(400).json({ error: 'Nothing to change' });
    }

    const sb = getServiceClient(config);

    // Upsert on the primary key. One row per operator, so there is no
    // "which of my rows" question to get wrong.
    const { error } = await sb
      .from('user_email_notification_prefs')
      .upsert(
        { user_id: user.id, ...parsed.data, updated_at: new Date().toISOString() },
        { onConflict: 'user_id' },
      );
    if (error) return res.status(500).json({ error: error.message });

    const [settings, row] = await Promise.all([
      loadNotificationEmailSettings(config),
      sb.from('user_email_notification_prefs').select(COLUMNS).eq('user_id', user.id).maybeSingle(),
    ]);

    return res.json({
      available: enabledTypes(settings),
      prefs: { ...DEFAULTS, ...((row.data as unknown as Record<string, unknown> | null) || {}) },
    });
  } catch (err: unknown) {
    return res.status(500).json({ error: messageOf(err, 'Failed to update email preferences') });
  }
});
