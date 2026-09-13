/**
 * Platform-admin Data Retention API.
 *
 * Mounted under adminRouter (server/routes/admin.ts), which already gates
 * every route behind `requirePlatformAdmin`. Express-only — no edge
 * functions, per the project architecture rules.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import {
  listPolicies,
  listRuns,
  runAllPolicies,
  runPolicy,
  updatePolicy,
  RetentionError,
} from '../services/retention/retentionService.js';
import { getArchiveAdapter } from '../services/retention/archive.js';
import { backfillUrlModel, getSeoStorageMetrics } from '../services/seo/urlRepository.js';

export const adminRetentionRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

function fail(res: any, err: unknown) {
  if (err instanceof RetentionError) {
    const status = err.code === 'policy_not_found' ? 404 : err.code === 'policy_protected' ? 403 : 400;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  return res.status(500).json({ error: (err as Error)?.message || 'internal_error' });
}

adminRetentionRouter.get('/policies', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  try {
    const policies = await listPolicies(serverConfigOf(req));
    res.json({ policies, archiveAdapter: getArchiveAdapter().name });
  } catch (err) { fail(res, err); }
});

const patchSchema = z.object({
  enabled: z.boolean().optional(),
  hot_retention_days: z.number().int().positive().nullable().optional(),
  keep_last_n: z.number().int().positive().nullable().optional(),
  archive_enabled: z.boolean().optional(),
  archive_after_days: z.number().int().positive().nullable().optional(),
  delete_after_archive: z.boolean().optional(),
  batch_size: z.number().int().min(100).max(50000).optional(),
  description: z.string().max(2000).optional(),
});

adminRetentionRouter.patch('/policies/:policyKey', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = patchSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  try {
    const policy = await updatePolicy(serverConfigOf(req), req.params.policyKey, parsed.data);
    res.json({ policy });
  } catch (err) { fail(res, err); }
});

const runSchema = z.object({ dryRun: z.boolean().default(false) });

adminRetentionRouter.post('/policies/:policyKey/run', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = runSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  try {
    const outcome = await runPolicy(serverConfigOf(req), req.params.policyKey, {
      dryRun: parsed.data.dryRun,
      triggeredBy: parsed.data.dryRun ? 'admin_dry_run' : 'admin_manual',
      actorUserId: actorId,
    });
    res.json({ outcome });
  } catch (err) { fail(res, err); }
});

adminRetentionRouter.post('/run-all', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = runSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_payload' });
  try {
    const outcomes = await runAllPolicies(serverConfigOf(req), {
      dryRun: parsed.data.dryRun,
      triggeredBy: parsed.data.dryRun ? 'admin_dry_run' : 'admin_manual',
      actorUserId: actorId,
    });
    res.json({ outcomes });
  } catch (err) { fail(res, err); }
});

adminRetentionRouter.get('/runs', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  try {
    const runs = await listRuns(serverConfigOf(req), {
      policyKey: typeof req.query.policyKey === 'string' ? req.query.policyKey : undefined,
      limit: req.query.limit ? parseInt(String(req.query.limit), 10) : undefined,
    });
    res.json({ runs });
  } catch (err) { fail(res, err); }
});

// ─── SEO storage diagnostics + backfill ──────────────────────────────────
adminRetentionRouter.get('/seo-storage', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  try {
    res.json({ metrics: await getSeoStorageMetrics(serverConfigOf(req)) });
  } catch (err) { fail(res, err); }
});

adminRetentionRouter.post('/seo-storage/backfill', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const maxCrawls = Math.min(Math.max(parseInt(String((req.body ?? {}).maxCrawls ?? 25), 10) || 25, 1), 200);
  try {
    res.json({ result: await backfillUrlModel(serverConfigOf(req), maxCrawls) });
  } catch (err) { fail(res, err); }
});
