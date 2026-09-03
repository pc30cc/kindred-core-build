/**
 * SUPER-ADMIN GENERIC VERIFICATION CORE MANAGEMENT ROUTES.
 *
 * Mounted under the admin router, so `requireAdmin` (server/routes/admin.ts)
 * — which resolves the caller from the first-party `gs_session` cookie and
 * requires the platform `admin` role via `requirePlatformAdmin` — runs
 * before any handler here. `requireUser`/`requirePlatformAdmin` (server/lib/
 * workspaceAuth.ts) ALSO enforce `verifyOriginForMutation` for every
 * state-changing method, so every PUT/POST below already gets the
 * codebase's canonical CSRF/origin protection for free, at the same choke
 * point every other admin route goes through — nothing extra is wired here.
 *
 * A workspace owner/admin/agent/viewer is NOT a Super Admin: `isGlobalAdmin`
 * checks the platform-level `has_role(_, 'admin')` flag, entirely
 * independent of any workspace_members row, so such a caller gets the same
 * 403 as an unauthenticated one.
 *
 * Nothing here creates a challenge, sends an email/SMS, or writes to
 * verification_challenges/proofs/attempts. Template preview
 * (POST .../templates/preview) renders with a fixed fake code and never
 * calls a provider — see templatePreview.ts.
 */
import { Router, type Request, type Response } from 'express';
import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getClientIp } from '../utils/clientIp.js';
import { hashIpForRateLimit } from '../services/verification/crypto.js';
import { ALL_VERIFICATION_PURPOSES, PLATFORM_MAXIMUMS } from '../services/verification/types.js';
import {
  getAllPurposeOverviews,
  getPurposeOverview,
  updatePurposeSettings,
  resetPurposeSettings,
  getAuditHistory,
  getPlatformCeilings,
  VerificationAdminError,
} from '../services/verification/adminSettings.js';
import { getReadinessSnapshot } from '../services/verification/readiness.js';
import { renderTemplatePreview } from '../services/verification/templatePreview.js';

export const adminVerificationRouter = Router({ mergeParams: true });

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
  if (err instanceof VerificationAdminError) return res.status(err.status).json({ error: err.code });
  if (err instanceof z.ZodError) return res.status(400).json({ error: 'VALIDATION_FAILED', details: err.flatten() });
  // eslint-disable-next-line no-console
  console.error('[admin-verification] unexpected error:', err instanceof Error ? err.message : err);
  return res.status(500).json({ error: 'VERIFICATION_ADMIN_UNAVAILABLE' });
}

const mutationLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `gv-admin:${(req as AdminRequest).adminUser?.id || ipKeyGenerator(req.ip || '')}`,
});

const purposeParamSchema = z.enum(ALL_VERIFICATION_PURPOSES as unknown as [string, ...string[]]);

const settingsBodySchema = z.object({
  requestId: z.string().min(8).max(200),
  expectedRevision: z.number().int().min(1),
  adminEnabled: z.boolean(),
  otpLength: z.number().int().min(4).max(PLATFORM_MAXIMUMS.otpLength),
  otpTtlSeconds: z.number().int().min(30).max(PLATFORM_MAXIMUMS.otpTtlSeconds),
  maxVerificationAttempts: z.number().int().min(1).max(PLATFORM_MAXIMUMS.maxVerificationAttempts),
  resendCooldownSeconds: z.number().int().min(PLATFORM_MAXIMUMS.resendCooldownSecondsMin),
  maxSendsPerWindow: z.number().int().min(1).max(PLATFORM_MAXIMUMS.maxSendsPerWindow),
  rateWindowSeconds: z.number().int().min(60).max(PLATFORM_MAXIMUMS.rateWindowSeconds),
  proofTtlSeconds: z.number().int().min(30).max(PLATFORM_MAXIMUMS.proofTtlSeconds),
  globalRateLimitEnabled: z.boolean(),
  globalRateLimitMaxPerWindow: z.number().int().min(1).max(PLATFORM_MAXIMUMS.globalRateLimitMaxPerWindowMax).nullable(),
  globalRateLimitWindowSeconds: z.number().int().min(60).max(PLATFORM_MAXIMUMS.globalRateLimitWindowSecondsMax).nullable(),
  defaultLocale: z.enum(['fa', 'tr', 'en']),
  locale: z.enum(['fa', 'tr', 'en']),
}).refine(
  (v) => !v.globalRateLimitEnabled || (v.globalRateLimitMaxPerWindow != null && v.globalRateLimitWindowSeconds != null),
  { message: 'globalRateLimitMaxPerWindow and globalRateLimitWindowSeconds are required when globalRateLimitEnabled is true' },
);

const resetBodySchema = z.object({
  requestId: z.string().min(8).max(200),
  expectedRevision: z.number().int().min(1),
  locale: z.enum(['fa', 'tr', 'en']),
});

const auditQuerySchema = z.object({
  purpose: z.enum(ALL_VERIFICATION_PURPOSES as unknown as [string, ...string[]]).optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
  before: z.string().datetime().optional(),
});

const previewBodySchema = z.object({
  locale: z.enum(['fa', 'tr', 'en']),
});

// ─── GET /overview ──────────────────────────────────────────────────────
adminVerificationRouter.get('/overview', async (req, res) => {
  try {
    const [readiness, purposes] = await Promise.all([
      getReadinessSnapshot(configOf(req)),
      getAllPurposeOverviews(configOf(req)),
    ]);
    res.json({ readiness, purposes, platformCeilings: getPlatformCeilings() });
  } catch (err) {
    fail(res, err);
  }
});

// ─── GET /purposes ──────────────────────────────────────────────────────
adminVerificationRouter.get('/purposes', async (req, res) => {
  try {
    const purposes = await getAllPurposeOverviews(configOf(req));
    res.json({ purposes, platformCeilings: getPlatformCeilings() });
  } catch (err) {
    fail(res, err);
  }
});

// ─── GET /purposes/:purpose ─────────────────────────────────────────────
adminVerificationRouter.get('/purposes/:purpose', async (req, res) => {
  const parsed = purposeParamSchema.safeParse(req.params.purpose);
  if (!parsed.success) return res.status(404).json({ error: 'PURPOSE_UNKNOWN' });
  try {
    const overview = await getPurposeOverview(configOf(req), parsed.data);
    res.json({ ...overview, platformCeilings: getPlatformCeilings() });
  } catch (err) {
    fail(res, err);
  }
});

// ─── PUT /purposes/:purpose ─────────────────────────────────────────────
adminVerificationRouter.put('/purposes/:purpose', mutationLimiter, async (req, res) => {
  const purposeParsed = purposeParamSchema.safeParse(req.params.purpose);
  if (!purposeParsed.success) return res.status(404).json({ error: 'PURPOSE_UNKNOWN' });
  const bodyParsed = settingsBodySchema.safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: 'VALIDATION_FAILED', details: bodyParsed.error.flatten() });
  const body = bodyParsed.data;

  try {
    const clientIp = getClientIp(req);
    const result = await updatePurposeSettings(configOf(req), {
      purpose: purposeParsed.data,
      requestId: body.requestId,
      actorProfileId: adminIdOf(req),
      expectedRevision: body.expectedRevision,
      adminEnabled: body.adminEnabled,
      otpLength: body.otpLength,
      otpTtlSeconds: body.otpTtlSeconds,
      maxVerificationAttempts: body.maxVerificationAttempts,
      resendCooldownSeconds: body.resendCooldownSeconds,
      maxSendsPerWindow: body.maxSendsPerWindow,
      rateWindowSeconds: body.rateWindowSeconds,
      proofTtlSeconds: body.proofTtlSeconds,
      globalRateLimitEnabled: body.globalRateLimitEnabled,
      globalRateLimitMaxPerWindow: body.globalRateLimitMaxPerWindow,
      globalRateLimitWindowSeconds: body.globalRateLimitWindowSeconds,
      defaultLocale: body.defaultLocale,
      ipHash: clientIp ? hashIpForRateLimit(clientIp) : null,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      locale: body.locale,
    });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

// ─── POST /purposes/:purpose/reset ──────────────────────────────────────
adminVerificationRouter.post('/purposes/:purpose/reset', mutationLimiter, async (req, res) => {
  const purposeParsed = purposeParamSchema.safeParse(req.params.purpose);
  if (!purposeParsed.success) return res.status(404).json({ error: 'PURPOSE_UNKNOWN' });
  const bodyParsed = resetBodySchema.safeParse(req.body);
  if (!bodyParsed.success) return res.status(400).json({ error: 'VALIDATION_FAILED', details: bodyParsed.error.flatten() });
  const body = bodyParsed.data;

  try {
    const clientIp = getClientIp(req);
    const result = await resetPurposeSettings(configOf(req), {
      purpose: purposeParsed.data,
      requestId: body.requestId,
      actorProfileId: adminIdOf(req),
      expectedRevision: body.expectedRevision,
      ipHash: clientIp ? hashIpForRateLimit(clientIp) : null,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      locale: body.locale,
    });
    res.json(result);
  } catch (err) {
    fail(res, err);
  }
});

// ─── GET /audit ─────────────────────────────────────────────────────────
adminVerificationRouter.get('/audit', async (req, res) => {
  const parsed = auditQuerySchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_FAILED', details: parsed.error.flatten() });
  try {
    const rows = await getAuditHistory(configOf(req), parsed.data);
    res.json({ rows });
  } catch (err) {
    fail(res, err);
  }
});

// ─── POST /templates/preview ────────────────────────────────────────────
// Never creates a challenge, never calls a provider — see templatePreview.ts.
const previewLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => `gv-admin-preview:${(req as AdminRequest).adminUser?.id || ipKeyGenerator(req.ip || '')}`,
});
adminVerificationRouter.post('/templates/preview', previewLimiter, async (req, res) => {
  const parsed = previewBodySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_FAILED', details: parsed.error.flatten() });
  try {
    res.json(renderTemplatePreview(parsed.data.locale));
  } catch (err) {
    fail(res, err);
  }
});
