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
 * of work exists to stop. The offline-message notice has no platform switch:
 * its switch is offered to whoever gets it, an owner or admin of some
 * workspace, once the database can store it (migration 289g).
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requireUser as requireSessionUser, serverConfigOf } from '../lib/workspaceAuth.js';
import {
  EMAIL_PREFERENCE_TYPES,
  NOTIFICATION_EMAIL_TYPES,
  OFFLINE_MESSAGES_EMAIL,
  OFFLINE_NOTICE_ROLES,
  type EmailPreferenceType,
} from '../services/notificationEmail/types.js';
import { enabledTypes, loadNotificationEmailSettings } from '../services/notificationEmail/settings.js';
import { isMissingColumn } from '../services/notificationEmail/queue.js';

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
  EMAIL_PREFERENCE_TYPES.map((type) => [type, true]),
);

const COLUMNS = EMAIL_PREFERENCE_TYPES.join(', ');
/** The columns of a database before migration 289g. */
const COLUMNS_BEFORE_289G = NOTIFICATION_EMAIL_TYPES.join(', ');

const updateSchema = z.object(
  Object.fromEntries(
    EMAIL_PREFERENCE_TYPES.map((type) => [type, z.boolean().optional()]),
  ) as Record<EmailPreferenceType, z.ZodOptional<z.ZodBoolean>>,
);

/**
 * The operator's row, and whether the database has the offline notice's
 * column: before migration 289g it is read without it (and its switch is not
 * offered, since it could not be saved).
 */
async function readPrefs(
  config: ServerConfig,
  userId: string,
): Promise<{ prefs: Record<string, unknown>; offlineColumn: boolean } | { error: string }> {
  const sb = getServiceClient(config);
  let { data, error } = await sb.from('user_email_notification_prefs').select(COLUMNS).eq('user_id', userId).maybeSingle();
  let offlineColumn = true;
  if (error && isMissingColumn(error)) {
    offlineColumn = false;
    ({ data, error } = await sb.from('user_email_notification_prefs').select(COLUMNS_BEFORE_289G).eq('user_id', userId).maybeSingle());
  }
  if (error) return { error: error.message };
  return { prefs: { ...DEFAULTS, ...((data as unknown as Record<string, unknown> | null) || {}) }, offlineColumn };
}

/** What the page offers: the types the platform sends, and the offline notice to those who get it. */
async function availableTypes(config: ServerConfig, userId: string, offlineColumn: boolean): Promise<EmailPreferenceType[]> {
  const available: EmailPreferenceType[] = enabledTypes(await loadNotificationEmailSettings(config));
  if (!offlineColumn) return available;
  const { data } = await getServiceClient(config)
    .from('workspace_members')
    .select('workspace_id')
    .eq('user_id', userId)
    .in('role', [...OFFLINE_NOTICE_ROLES])
    .limit(1);
  if (Array.isArray(data) && data.length > 0) available.push(OFFLINE_MESSAGES_EMAIL);
  return available;
}

// GET /api/notifications/email
notificationEmailRouter.get('/', async (req, res) => {
  try {
    const config: ServerConfig = serverConfigOf(req);
    const user = (req as AuthedRequest).authUser!;

    const row = await readPrefs(config, user.id);
    if ('error' in row) return res.status(500).json({ error: row.error });

    return res.json({
      available: await availableTypes(config, user.id, row.offlineColumn),
      prefs: row.prefs,
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

    const row = await readPrefs(config, user.id);
    if ('error' in row) return res.status(500).json({ error: row.error });

    return res.json({
      available: await availableTypes(config, user.id, row.offlineColumn),
      prefs: row.prefs,
    });
  } catch (err: unknown) {
    return res.status(500).json({ error: messageOf(err, 'Failed to update email preferences') });
  }
});
