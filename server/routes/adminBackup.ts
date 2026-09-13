/**
 * Platform-admin Backup & Recovery API (read-focused).
 *
 * Mounted under adminRouter, which already gates everything behind
 * `requirePlatformAdmin`. Express-only, per the project architecture rules.
 *
 * There is NO restore endpoint here and there never should be: restoring
 * production is a controlled operational procedure documented in
 * docs/BACKUP_AND_DISASTER_RECOVERY.md, not a button in a web page.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';
import {
  BackupError,
  getBackupOverview,
  listBackupRuns,
  listCommands,
  listRestoreDrills,
  requestCommand,
} from '../services/backup/backupService.js';

export const adminBackupRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as Request & { serverConfig?: ServerConfig }).serverConfig as ServerConfig;
}

function fail(res: Response, err: unknown) {
  if (err instanceof BackupError) {
    const status = err.code === 'command_not_allowed' ? 403 : 400;
    return res.status(status).json({ error: err.code, message: err.message });
  }
  return res.status(500).json({ error: (err as Error)?.message || 'internal_error' });
}

adminBackupRouter.get('/overview', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  try {
    res.json(await getBackupOverview(serverConfigOf(req)));
  } catch (err) { fail(res, err); }
});

adminBackupRouter.get('/runs', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  try {
    const kind = typeof req.query.kind === 'string' ? req.query.kind : undefined;
    const runs = await listBackupRuns(serverConfigOf(req), {
      kind: (kind as 'base' | 'wal' | 'logical' | 'object') || undefined,
      limit: 50,
    });
    res.json({ runs });
  } catch (err) { fail(res, err); }
});

adminBackupRouter.get('/drills', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  try {
    res.json({ drills: await listRestoreDrills(serverConfigOf(req)) });
  } catch (err) { fail(res, err); }
});

adminBackupRouter.get('/commands', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  try {
    res.json({ commands: await listCommands(serverConfigOf(req)) });
  } catch (err) { fail(res, err); }
});

const commandSchema = z.object({
  command: z.enum(['run_logical_backup', 'run_base_backup', 'verify_latest_backup']),
});

adminBackupRouter.post('/commands', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = commandSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'command_not_allowed' });
  try {
    res.json({ command: await requestCommand(serverConfigOf(req), parsed.data.command, actorId) });
  } catch (err) { fail(res, err); }
});
