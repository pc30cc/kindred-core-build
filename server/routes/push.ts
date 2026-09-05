/**
 * PUSH DEVICE ENDPOINTS (native mobile app only).
 *
 * Auth: the existing first-party session — the mobile app's
 * `Authorization: Bearer <opaque session token>`, validated by the SAME
 * `requireUser` every dashboard route uses. There is no new identity system,
 * and the caller's user is resolved server-side: `user_id` is not accepted
 * from the body under any circumstance.
 */
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { requireUser } from '../lib/workspaceAuth.js';
import { registerDevice, disableDevice, touchDevice } from '../services/push/devices.js';
import { unreadBadgeCount } from '../services/push/recipients.js';
import { isPushConfigured } from '../services/push/fcm.js';

export const pushRouter = Router();

const writeLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const registerSchema = z.object({
  platform: z.enum(['ios', 'android']),
  // FCM registration tokens are long opaque strings; bound them defensively.
  push_token: z.string().min(20).max(4096).regex(/^[\w:.\-]+$/),
  device_id: z.string().min(4).max(128),
  device_name: z.string().max(120).optional().nullable(),
  app_version: z.string().max(40).optional().nullable(),
  permission_status: z.enum(['granted', 'denied', 'prompt']).optional().nullable(),
  workspace_id: z.string().regex(UUID_RE).optional().nullable(),
});

// POST /api/push/devices — register or rotate this device's token.
pushRouter.post('/devices', writeLimiter, async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const parsed = registerSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid device payload' });

  const config: ServerConfig = (req as any).serverConfig;
  const result = await registerDevice(config, {
    userId,
    workspaceId: parsed.data.workspace_id ?? null,
    platform: parsed.data.platform,
    pushToken: parsed.data.push_token,
    deviceId: parsed.data.device_id,
    deviceName: parsed.data.device_name ?? null,
    appVersion: parsed.data.app_version ?? null,
    permissionStatus: parsed.data.permission_status ?? null,
  });
  if (!result) return res.status(500).json({ error: 'Registration failed' });
  return res.json({ ok: true, device_id: parsed.data.device_id, push_enabled: isPushConfigured() });
});

const deviceIdSchema = z.object({ device_id: z.string().min(4).max(128) });

// POST /api/push/devices/unregister — logout / disable THIS device only.
pushRouter.post('/devices/unregister', writeLimiter, async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const parsed = deviceIdSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid device id' });
  const config: ServerConfig = (req as any).serverConfig;
  await disableDevice(config, userId, parsed.data.device_id, 'user_logout');
  return res.json({ ok: true });
});

// POST /api/push/devices/heartbeat — keeps last_seen_at fresh.
pushRouter.post('/devices/heartbeat', writeLimiter, async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const parsed = deviceIdSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid device id' });
  const config: ServerConfig = (req as any).serverConfig;
  await touchDevice(config, userId, parsed.data.device_id);
  return res.json({ ok: true });
});

// GET /api/push/badge?workspace_id=... — server-authoritative unread count.
pushRouter.get('/badge', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const config: ServerConfig = (req as any).serverConfig;
  const workspaceId = typeof req.query.workspace_id === 'string' && UUID_RE.test(req.query.workspace_id)
    ? req.query.workspace_id
    : null;
  const count = await unreadBadgeCount(config, userId, workspaceId);
  return res.json({ badge: count });
});
