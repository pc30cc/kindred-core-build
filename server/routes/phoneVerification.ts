/**
 * USER-FACING PHONE VERIFICATION ROUTES
 *
 * Every route derives identity from a real Supabase JWT and resolves the
 * verification subject server-side from the purpose registry. The client can
 * never name the subject user, the owner or a role. Responses are sanitized:
 * no provider name, template, sender, message id or raw provider error.
 */

import { Router } from 'express';
import { z } from 'zod';
import { requireUser, serverConfigOf } from '../lib/workspaceAuth.js';
import { getClientIp } from '../utils/clientIp.js';
import {
  checkVerification,
  cancelVerification,
  getStatusForActor,
  PhoneVerificationError,
  resendVerification,
  startVerification,
} from '../services/phoneVerification/index.js';
import { isPhoneVerificationPurpose } from '../services/phoneVerification/policies.js';

export const phoneVerificationRouter = Router();

const purposeSchema = z.string().refine(isPhoneVerificationPurpose, 'invalid purpose');
const contextSchema = {
  purpose: purposeSchema,
  workspaceId: z.string().uuid().optional(),
  workspaceSlug: z.string().min(1).max(120).optional(),
};

function fail(res: any, err: unknown) {
  if (err instanceof PhoneVerificationError) {
    const body: Record<string, unknown> = { error: err.code };
    if (err.retryAfterSeconds !== undefined) body.retryAfterSeconds = err.retryAfterSeconds;
    return res.status(err.status).json(body);
  }
  return res.status(500).json({ error: 'phone_verification_unavailable' });
}

phoneVerificationRouter.get('/status', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const parsed = z.object(contextSchema).safeParse({
    purpose: req.query.purpose,
    workspaceId: typeof req.query.workspaceId === 'string' ? req.query.workspaceId : undefined,
    workspaceSlug: typeof req.query.workspaceSlug === 'string' ? req.query.workspaceSlug : undefined,
  });
  if (!parsed.success) return res.status(400).json({ error: 'phone_verification_not_allowed' });
  try {
    const status = await getStatusForActor(serverConfigOf(req), {
      purpose: parsed.data.purpose as 'widget_access',
      actorUserId: userId,
      ...(parsed.data.workspaceId ? { workspaceId: parsed.data.workspaceId } : {}),
      ...(parsed.data.workspaceSlug ? { workspaceSlug: parsed.data.workspaceSlug } : {}),
    });
    res.json(status);
  } catch (err) {
    fail(res, err);
  }
});

const startSchema = z.object({
  ...contextSchema,
  country: z.string().min(2).max(2),
  phone: z.string().min(4).max(32),
});

phoneVerificationRouter.post('/start', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'phone_invalid' });
  try {
    const result = await startVerification(serverConfigOf(req), {
      purpose: parsed.data.purpose as 'widget_access',
      actorUserId: userId,
      ...(parsed.data.workspaceId ? { workspaceId: parsed.data.workspaceId } : {}),
      ...(parsed.data.workspaceSlug ? { workspaceSlug: parsed.data.workspaceSlug } : {}),
      phone: parsed.data.phone,
      country: parsed.data.country.toUpperCase(),
      clientIp: getClientIp(req as any),
    });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

phoneVerificationRouter.post('/resend', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const parsed = z.object(contextSchema).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'phone_verification_not_allowed' });
  try {
    const result = await resendVerification(serverConfigOf(req), {
      purpose: parsed.data.purpose as 'widget_access',
      actorUserId: userId,
      ...(parsed.data.workspaceId ? { workspaceId: parsed.data.workspaceId } : {}),
      ...(parsed.data.workspaceSlug ? { workspaceSlug: parsed.data.workspaceSlug } : {}),
      clientIp: getClientIp(req as any),
    });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

const checkSchema = z.object({
  ...contextSchema,
  challengeId: z.string().uuid(),
  code: z.string().min(4).max(10),
});

phoneVerificationRouter.post('/check', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const parsed = checkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'phone_code_invalid' });
  try {
    const result = await checkVerification(serverConfigOf(req), {
      purpose: parsed.data.purpose as 'widget_access',
      actorUserId: userId,
      ...(parsed.data.workspaceId ? { workspaceId: parsed.data.workspaceId } : {}),
      ...(parsed.data.workspaceSlug ? { workspaceSlug: parsed.data.workspaceSlug } : {}),
      challengeId: parsed.data.challengeId,
      code: parsed.data.code,
    });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

const cancelSchema = z.object({
  ...contextSchema,
  challengeId: z.string().uuid().optional(),
});

/**
 * "Change number" is a server-side operation: the outstanding code is
 * invalidated in the database, never merely hidden in the UI.
 */
phoneVerificationRouter.post('/cancel', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const parsed = cancelSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'phone_verification_not_allowed' });
  try {
    const result = await cancelVerification(serverConfigOf(req), {
      purpose: parsed.data.purpose as 'widget_access',
      actorUserId: userId,
      ...(parsed.data.workspaceId ? { workspaceId: parsed.data.workspaceId } : {}),
      ...(parsed.data.workspaceSlug ? { workspaceSlug: parsed.data.workspaceSlug } : {}),
      challengeId: parsed.data.challengeId ?? null,
    });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});