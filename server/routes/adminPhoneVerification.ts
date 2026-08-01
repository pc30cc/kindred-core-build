/**
 * SUPER-ADMIN PHONE VERIFICATION ROUTES
 * Mounted under the admin router, so `requireAdmin` runs before any database
 * read, SMS send or SDK initialization.
 */

import { Router } from 'express';
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

function fail(res: any, err: unknown) {
  if (err instanceof PhoneVerificationError) return res.status(err.status).json({ error: err.code });
  return res.status(500).json({ error: 'phone_verification_unavailable' });
}

adminPhoneVerificationRouter.get('/:userId/phone-verification', async (req, res) => {
  const parsed = userIdSchema.safeParse(req.params.userId);
  if (!parsed.success) return res.status(400).json({ error: 'phone_invalid' });
  try {
    res.json(await adminGetPhoneVerification((req as any).serverConfig as ServerConfig, parsed.data));
  } catch (err) {
    fail(res, err);
  }
});

adminPhoneVerificationRouter.post('/:userId/phone-verification/resend', async (req, res) => {
  const parsed = userIdSchema.safeParse(req.params.userId);
  if (!parsed.success) return res.status(400).json({ error: 'phone_invalid' });
  try {
    res.json(
      await adminResendVerification((req as any).serverConfig as ServerConfig, {
        targetUserId: parsed.data,
        adminUserId: (req as any).adminUser?.id ?? '',
        clientIp: getClientIp(req as any),
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
      await adminManualVerify((req as any).serverConfig as ServerConfig, {
        targetUserId: parsedId.data,
        adminUserId: (req as any).adminUser?.id ?? '',
        reason: parsed.data.reason,
      }),
    );
  } catch (err) {
    fail(res, err);
  }
});