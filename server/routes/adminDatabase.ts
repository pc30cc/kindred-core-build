/**
 * Platform-admin database maintenance: JSON backup / restore / purge.
 *
 * Mounted under adminRouter (server/routes/admin.ts), which already gates
 * every route behind `requirePlatformAdmin`. All heavy lifting happens in
 * SECURITY DEFINER SQL functions added by
 * database/migrations/110_admin_data_reset.sql, which re-check the actor's
 * admin role explicitly (service_role has no auth.uid()).
 *
 * No edge functions — this is Express-only, per project architecture rules.
 */
import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { requirePlatformAdmin } from '../lib/workspaceAuth.js';

export const adminDatabaseRouter = Router();

function serverConfigOf(req: any): ServerConfig {
  return req.serverConfig as ServerConfig;
}

const scopeSchema = z.object({
  scope: z.enum(['data', 'full']).default('data'),
});

// ─── Backup (streamed table-by-table as downloadable JSON) ───────────────
// A single admin_export_database() call serialises the whole database in one
// statement and trips Postgres' statement_timeout. Instead we list the tables
// and stream each one in pages, writing the JSON document as we go.
const EXPORT_PAGE_SIZE = 1000;

adminDatabaseRouter.get('/backup', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  // ?full=1 → include the schema (DDL) so the dump can rebuild an empty database.
  const includeSchema = req.query.full === '1' || req.query.full === 'true';

  const { data: tables, error: listError } = await sb.rpc('admin_list_export_tables', {
    _actor_user_id: actorId,
    _scope: 'all',
  });
  if (listError) return res.status(500).json({ error: listError.message });

  let schema: string[] = [];
  if (includeSchema) {
    const { data: ddl, error: ddlError } = await sb.rpc('admin_export_schema_ddl', {
      _actor_user_id: actorId,
    });
    if (ddlError) return res.status(500).json({ error: ddlError.message });
    schema = ((ddl as unknown as (string | { admin_export_schema_ddl: string })[]) ?? []).map((s) =>
      typeof s === 'string' ? s : s.admin_export_schema_ddl,
    );
  }

  const tableNames: string[] = ((tables as unknown as (string | { admin_list_export_tables: string })[]) ?? []).map(
    (t) => (typeof t === 'string' ? t : t.admin_list_export_tables),
  );

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${includeSchema ? 'full_' : ''}backup_${stamp}.json"`,
  );

  res.write(
    `{"version":1,"scope":${JSON.stringify(includeSchema ? 'full' : 'all')},"exported_at":${JSON.stringify(new Date().toISOString())},` +
      (includeSchema ? `"schema":${JSON.stringify(schema)},` : '') +
      `"tables":{`,
  );


  let first = true;
  try {
    for (const table of tableNames) {
      const rows: unknown[] = [];
      for (let offset = 0; ; offset += EXPORT_PAGE_SIZE) {
        const { data, error } = await sb.rpc('admin_export_table', {
          _actor_user_id: actorId,
          _table: table,
          _limit: EXPORT_PAGE_SIZE,
          _offset: offset,
        });
        if (error) throw new Error(`${table}: ${error.message}`);
        const page = (data as unknown[] | null) ?? [];
        rows.push(...page);
        if (page.length < EXPORT_PAGE_SIZE) break;
      }
      res.write(`${first ? '' : ','}${JSON.stringify(table)}:${JSON.stringify(rows)}`);
      first = false;
    }
    res.write('}}');
    res.end();
  } catch (err) {
    // Headers are already sent — close the stream with an explicit error marker
    // so a truncated backup can never be mistaken for a complete one.
    res.write(`${first ? '' : ','}"__error__":${JSON.stringify(String((err as Error).message))}}}`);
    res.end();
  }
});


// ─── Restore ─────────────────────────────────────────────────────────────
adminDatabaseRouter.post('/restore', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const payload = req.body?.payload;
  if (!payload || typeof payload !== 'object' || !payload.tables) {
    return res.status(400).json({ error: 'Invalid backup payload' });
  }
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_restore_database', {
    _actor_user_id: actorId,
    _payload: payload,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, result: data });
});

// ─── Purge ───────────────────────────────────────────────────────────────
adminDatabaseRouter.post('/purge', async (req, res) => {
  const actorId = await requirePlatformAdmin(req, res);
  if (!actorId) return;
  const parsed = scopeSchema.safeParse(req.body ?? {});
  if (!parsed.success) return res.status(400).json({ error: 'Invalid scope' });
  if (req.body?.confirm !== 'DELETE') {
    return res.status(400).json({ error: 'Confirmation required' });
  }
  const config = serverConfigOf(req);
  const sb = getServiceClient(config);
  const { data, error } = await sb.rpc('admin_purge_database', {
    _actor_user_id: actorId,
    _scope: parsed.data.scope,
  });
  if (error) return res.status(500).json({ error: error.message });
  res.json({ ok: true, result: data });
});
