/**
 * SUPER-ADMIN PHONE VERIFICATION ROUTES
 * Mounted under the admin router, so `requireAdmin` runs before any database
 * read, SMS send or SDK initialization.
 */

import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getClientIp } from '../utils/clientIp.js';
import {
  adminGetPhoneVerification,
  adminManualVerify,
  adminResendVerification,
} from '../services/phoneVerification/admin.js';
import { PhoneVerificationError } from '../services/phoneVerification/types.js';

export const adminPhoneVerificationRouter = Router({ mergeParams: true });

const userIdSchema = z.string().uuid();

interface AdminRequest extends Request {
  serverConfig?: ServerConfig;
  adminUser?: { id: string };
}

function configOf(req: Request): ServerConfig {
  return (req as AdminRequest).serverConfig as ServerConfig;
}

function adminIdOf(req: Request): string {
  return (req as AdminRequest).adminUser?.id ?? '';
}

function fail(res: Response, err: unknown) {
  if (err instanceof PhoneVerificationError) return res.status(err.status).json({ error: err.code });
  return res.status(500).json({ error: 'phone_verification_unavailable' });
}

adminPhoneVerificationRouter.get('/:userId/phone-verification', async (req, res) => {
  const parsed = userIdSchema.safeParse(req.params.userId);
  if (!parsed.success) return res.status(400).json({ error: 'phone_invalid' });
  try {
    res.json(await adminGetPhoneVerification(configOf(req), parsed.data));
  } catch (err) {
    fail(res, err);
  }
});

adminPhoneVerificationRouter.post('/:userId/phone-verification/resend', async (req, res) => {
  const parsed = userIdSchema.safeParse(req.params.userId);
  if (!parsed.success) return res.status(400).json({ error: 'phone_invalid' });
  try {
    res.json(
      await adminResendVerification(configOf(req), {
        targetUserId: parsed.data,
        adminUserId: adminIdOf(req),
        clientIp: getClientIp(req),
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});

const manualSchema = z.object({ reason: z.string().trim().min(5).max(500) });

adminPhoneVerificationRouter.post('/:userId/phone-verification/manual-verify', async (req, res) => {
  const parsedId = userIdSchema.safeParse(req.params.userId);
  if (!parsedId.success) return res.status(400).json({ error: 'phone_invalid' });
  const parsed = manualSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'phone_verification_not_allowed' });
  try {
    res.json(
      await adminManualVerify(configOf(req), {
        targetUserId: parsedId.data,
        adminUserId: adminIdOf(req),
        reason: parsed.data.reason,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});