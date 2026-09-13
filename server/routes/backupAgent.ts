/**
 * Host-side backup agent API.
 *
 * The backup tooling runs next to PostgreSQL on the database host (it needs the
 * data directory and the WAL archive); it is not part of this Node process.
 * It reports what it did through this router, authenticated with a dedicated
 * shared token — not an admin session, not the service-role key.
 *
 * Mounted outside the admin router. Every route is a no-op unless
 * BACKUP_AGENT_TOKEN is configured.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import type { ServerConfig } from '../config.js';
import {
  claimCommand,
  completeCommand,
  recordBackupReport,
  recordRestoreDrill,
} from '../services/backup/backupService.js';

export const backupAgentRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig?: ServerConfig }).serverConfig as ServerConfig;
}

function authorized(req: Request): boolean {
  const expected = process.env.BACKUP_AGENT_TOKEN;
  if (!expected) return false;
  const raw = req.header('x-backup-agent-token') || '';
  const a = Buffer.from(raw);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

backupAgentRouter.use((req, res, next) => {
  if (!authorized(req)) return res.status(401).json({ error: 'unauthorized' });
  next();
});

const reportSchema = z.object({
  backup_id: z.string().min(1).max(200),
  kind: z.enum(['base', 'wal', 'logical', 'object']),
  status: z.enum(['running', 'succeeded', 'failed']),
  started_at: z.string().optional(),
  finished_at: z.string().optional(),
  bytes: z.number().int().nonnegative().optional(),
  checksum: z.string().max(200).optional(),
  destination: z.string().max(500).optional(),
  lsn: z.string().max(100).optional(),
  encrypted: z.boolean().optional(),
  verification_status: z.enum(['unverified', 'verified', 'failed']).optional(),
  verified_at: z.string().optional(),
  error: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
});

backupAgentRouter.post('/report', async (req: Request, res: Response) => {
  const parsed = reportSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_report' });
  try {
    const run = await recordBackupReport(serverConfigOf(req), parsed.data);
    res.json({ ok: true, id: run.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || 'report_failed' });
  }
});

const drillSchema = z.object({
  drill_kind: z.enum(['full_restore', 'pitr', 'object_storage']),
  environment: z.string().min(1).max(120),
  source_backup_id: z.string().max(200).nullable().optional(),
  target_time: z.string().nullable().optional(),
  finished_at: z.string().nullable().optional(),
  status: z.enum(['running', 'passed', 'failed']),
  findings: z.record(z.unknown()).optional(),
  notes: z.string().max(4000).nullable().optional(),
});

backupAgentRouter.post('/drill', async (req: Request, res: Response) => {
  const parsed = drillSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_drill' });
  try {
    const drill = await recordRestoreDrill(serverConfigOf(req), {
      drill_kind: parsed.data.drill_kind,
      environment: parsed.data.environment,
      source_backup_id: parsed.data.source_backup_id ?? null,
      target_time: parsed.data.target_time ?? null,
      finished_at: parsed.data.finished_at ?? new Date().toISOString(),
      status: parsed.data.status,
      findings: parsed.data.findings ?? {},
      notes: parsed.data.notes ?? null,
    });
    res.json({ ok: true, id: drill.id });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || 'drill_failed' });
  }
});

/** The agent polls this to pick up "Run backup now" / "Verify latest" requests. */
backupAgentRouter.post('/claim', async (req: Request, res: Response) => {
  try {
    res.json({ command: await claimCommand(serverConfigOf(req)) });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || 'claim_failed' });
  }
});

const completeSchema = z.object({
  id: z.string().uuid(),
  status: z.enum(['succeeded', 'failed']),
  result: z.record(z.unknown()).optional(),
  error: z.string().max(2000).optional(),
});

backupAgentRouter.post('/complete', async (req: Request, res: Response) => {
  const parsed = completeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'invalid_completion' });
  try {
    await completeCommand(
      serverConfigOf(req),
      parsed.data.id,
      parsed.data.status,
      parsed.data.result ?? {},
      parsed.data.error,
    );
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: (err as Error)?.message || 'complete_failed' });
  }
});
