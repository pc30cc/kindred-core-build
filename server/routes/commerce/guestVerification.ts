/**
 * Guest order verification — widget-facing (visitor is anonymous, no
 * workspace session). Rate-limited harder than public product lookups
 * (spec §47 — order/customer endpoints need stricter limits).
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../../config.js';
import { CommerceError } from '../../../shared/commerce/types.js';
import { startGuestOrderVerification, confirmGuestOrderVerification } from '../../services/commerce/guestVerification.js';

export const commerceGuestVerificationRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

const strictLimiter = rateLimit({ windowMs: 15 * 60_000, max: 5, standardHeaders: true, legacyHeaders: false });

const startSchema = z.object({
  workspaceId: z.string().uuid(),
  connectionId: z.string().uuid(),
  orderNumber: z.string().min(1).max(50),
  channel: z.enum(['email', 'sms']),
  destination: z.string().min(3).max(200),
}).strict();

commerceGuestVerificationRouter.post('/start', strictLimiter, async (req, res) => {
  const parsed = startSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
  try {
    const result = await startGuestOrderVerification(serverConfigOf(req), {
      workspaceId: parsed.data.workspaceId,
      connectionId: parsed.data.connectionId,
      externalOrderId: parsed.data.orderNumber,
      channel: parsed.data.channel,
      destination: parsed.data.destination,
      idempotencyKey: `${req.ip}-${parsed.data.orderNumber}-${Date.now()}`,
      ipAddress: getClientIp(req) || undefined,
    });
    // Never echo back matched/unmatched contact details — only the OTP
    // dispatch handle, exactly like every other OTP-request endpoint.
    res.json({ handle: result.handle, expiresAt: result.expiresAt, resendAvailableAt: result.resendAvailableAt });
  } catch (err) {
    if (err instanceof CommerceError) return res.status(400).json({ error: err.code });
    console.error('[commerce.guest-verification] start failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});

const confirmSchema = z.object({
  workspaceId: z.string().uuid(),
  connectionId: z.string().uuid(),
  orderNumber: z.string().min(1).max(50),
  channel: z.enum(['email', 'sms']),
  handle: z.string().min(1).max(200),
  code: z.string().min(4).max(10),
  requestId: z.string().min(1).max(200),
}).strict();

commerceGuestVerificationRouter.post('/confirm', strictLimiter, async (req, res) => {
  const parsed = confirmSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_request' });
  try {
    const result = await confirmGuestOrderVerification(serverConfigOf(req), {
      workspaceId: parsed.data.workspaceId,
      connectionId: parsed.data.connectionId,
      externalOrderId: parsed.data.orderNumber,
      channel: parsed.data.channel,
      handle: parsed.data.handle,
      code: parsed.data.code,
      requestId: parsed.data.requestId,
    });
    res.json({ ok: true, proofToken: result.proofToken });
  } catch (err) {
    if (err instanceof CommerceError) return res.status(400).json({ error: err.code });
    console.error('[commerce.guest-verification] confirm failed:', err);
    res.status(500).json({ error: 'internal_error' });
  }
});
