/**
 * Super Admin → Mobile App → App Review: the account Apple's reviewers sign
 * in with (migration 248).
 *
 *   GET  /api/admin/mobile-app/app-review          where it stands
 *   POST /api/admin/mobile-app/app-review/seed     create it, or refresh its
 *        { password? }                             demo content before a new
 *                                                  submission (a password is
 *                                                  needed only to create it)
 *   POST /api/admin/mobile-app/app-review/enabled  let it sign in, or not
 *        { enabled }
 *
 * The database does the work; the password is hashed here, as at sign-up,
 * and never stored or logged in the clear.
 */
import { Router } from 'express';
import type { Request } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import { hashPassword } from '../services/auth/password.js';
import { getPlatformEdition } from '../services/platformRegion.js';
import { readEditionSettingsRow, respondEditionUnavailable, saveEditionSettingsRow } from '../services/editionSettings.js';
import { invalidateMobileAppSettingsCache, mobileInsertDefaults } from '../services/mobileApp/settings.js';

export const adminAppReviewRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

const seedSchema = z.object({
  password: z.string().min(8).max(200).optional(),
});

const enabledSchema = z.object({
  enabled: z.boolean(),
});

/** The database's own refusals, as answers the screen can word. */
function refusal(message: string | undefined): { status: number; error: string } | null {
  if (message?.includes('app_review_password_required')) return { status: 400, error: 'password_required' };
  if (message?.includes('app_review_account_missing')) return { status: 404, error: 'account_missing' };
  return null;
}

adminAppReviewRouter.get('/', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const { data, error } = await getServiceClient(serverConfigOf(req)).rpc('app_review_status');
  if (error) return res.status(500).json({ error: error.message });
  return res.json(data);
});

adminAppReviewRouter.post('/seed', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = seedSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'password_too_short' });

  const config = serverConfigOf(req);
  // The seed records itself on the running edition's mobile settings row
  // (migrations 257, 258). An edition gets its row on the first save of its
  // Mobile page; seeding before that creates it here, from that edition's own
  // defaults, so the seed is never recorded nowhere.
  try {
    const edition = await getPlatformEdition(config);
    const existing = await readEditionSettingsRow(config, 'mobile_app_settings', edition);
    if (!existing) {
      const { error: insertError } = await saveEditionSettingsRow(
        config, 'mobile_app_settings', edition, null,
        { updated_at: new Date().toISOString() }, mobileInsertDefaults(edition),
      );
      if (insertError) return res.status(500).json({ error: insertError.message });
    }
  } catch (err) {
    if (respondEditionUnavailable(res, err)) return;
    return res.status(500).json({ error: (err as Error).message });
  }

  const passwordHash = parsed.data.password ? await hashPassword(parsed.data.password) : null;
  const { data, error } = await getServiceClient(config).rpc('app_review_seed', {
    _password_hash: passwordHash,
  });
  invalidateMobileAppSettingsCache();
  if (error) {
    const known = refusal(error.message);
    return res.status(known?.status ?? 500).json({ error: known?.error ?? error.message });
  }
  return res.json(data);
});

adminAppReviewRouter.post('/enabled', async (req, res) => {
  if (!(await requirePlatformAdmin(req, res))) return;
  const parsed = enabledSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid input' });

  const { data, error } = await getServiceClient(serverConfigOf(req)).rpc('app_review_set_enabled', {
    _enabled: parsed.data.enabled,
  });
  if (error) {
    const known = refusal(error.message);
    return res.status(known?.status ?? 500).json({ error: known?.error ?? error.message });
  }
  return res.json(data);
});
