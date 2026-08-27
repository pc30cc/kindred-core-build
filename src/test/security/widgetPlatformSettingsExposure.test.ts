/**
 * Security regression — widget_platform_settings must never be readable
 * (in full) by anon, and the public runtime getter must never leak
 * alert_webhook_secret / admin-only metadata.
 *
 * The singleton row carries:
 *   BACKEND_ADMIN_ONLY : alert_webhook_secret, alert_webhook_url, admin_notes,
 *                        updated_by, observability_*, alerting_enabled,
 *                        perf_memory_budget_mb, embed_* comments
 *   PUBLIC_RUNTIME_SAFE: max_message_length, rate_limit_messages_per_minute,
 *                        default_welcome_message, realtime_* hardening knobs
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import express from 'express';
import request from 'supertest';

const SELFHOST_DIR = join(process.cwd(), 'database', 'migrations');
const HOSTED_DIR = join(process.cwd(), 'supabase', 'migrations');

const SECRET_FIELDS = [
  'alert_webhook_secret',
  'alert_webhook_url',
  'admin_notes',
  'updated_by',
];

function selfhostSql(): string {
  return readdirSync(SELFHOST_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(SELFHOST_DIR, f), 'utf8'))
    .join('\n');
}

function hostedSql(): string {
  return readdirSync(HOSTED_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .map((f) => readFileSync(join(HOSTED_DIR, f), 'utf8'))
    .join('\n');
}

function lastGetterBody(sql: string): string {
  const parts = sql.split(/CREATE OR REPLACE FUNCTION public\.get_widget_platform_settings\(\)/);
  expect(parts.length).toBeGreaterThan(1);
  return parts[parts.length - 1].split('$$;')[0];
}

describe('widget_platform_settings — anon exposure', () => {
  it('self-host chain never leaves anon with table SELECT', () => {
    const sql = selfhostSql();
    // The last statement touching anon privileges must be a revoke.
    const privLines = sql
      .split('\n')
      .filter(
        (l) =>
          /public\.widget_platform_settings/.test(l) &&
          !/ON FUNCTION/i.test(l) &&
          /anon/.test(l) &&
          /GRANT|REVOKE/i.test(l),
      );

    expect(privLines.length).toBeGreaterThan(0);
    expect(/^\s*REVOKE/i.test(privLines[privLines.length - 1])).toBe(true);
    expect(privLines.some((l) => /^\s*GRANT\s+SELECT/i.test(l))).toBe(false);
  });

  it('self-host chain leaves no anon read policy in place', () => {
    const sql = selfhostSql();
    const policyOps = sql
      .split(/;\s*\n/)
      .filter((s) => /"Anon can read widget platform settings"/.test(s));
    expect(policyOps.length).toBeGreaterThan(0);
    expect(/DROP POLICY/i.test(policyOps[policyOps.length - 1])).toBe(true);
  });

  it('self-host chain never leaves authenticated with table SELECT', () => {
    const sql = selfhostSql();
    const privLines = sql
      .split('\n')
      .filter(
        (l) =>
          /public\.widget_platform_settings/.test(l) &&
          !/ON FUNCTION/i.test(l) &&
          /authenticated/.test(l) &&
          /GRANT|REVOKE/i.test(l),
      );

    expect(privLines.length).toBeGreaterThan(0);
    expect(/^\s*REVOKE/i.test(privLines[privLines.length - 1])).toBe(true);
  });

  it('self-host chain leaves no authenticated raw read policy in place', () => {
    const sql = selfhostSql();
    const policyOps = sql
      .split(/;\s*\n/)
      .filter((s) => /"Authenticated can read widget platform settings"/.test(s));
    expect(policyOps.length).toBeGreaterThan(0);
    expect(/DROP POLICY/i.test(policyOps[policyOps.length - 1])).toBe(true);
  });

  it('self-host chain keeps service_role full raw-table access', () => {
    expect(selfhostSql()).toMatch(
      /GRANT ALL\s+ON public\.widget_platform_settings TO service_role/,
    );
  });

  it('hosted chain never leaves anon or authenticated with raw table SELECT', () => {
    const sql = hostedSql();
    for (const role of ['anon', 'authenticated']) {
      const privLines = sql
        .split('\n')
        .filter(
          (l) =>
            /public\.widget_platform_settings/.test(l) &&
            !/ON FUNCTION/i.test(l) &&
            new RegExp(`\\b${role}\\b`).test(l) &&
            /GRANT|REVOKE/i.test(l),
        );
      expect(privLines.length).toBeGreaterThan(0);
      expect(/^\s*REVOKE/i.test(privLines[privLines.length - 1])).toBe(true);
    }
  });

  it('hosted chain leaves no raw read policy for anon or authenticated', () => {
    const sql = hostedSql();
    for (const name of [
      'Anon can read widget platform settings',
      'Authenticated can read widget platform settings',
    ]) {
      const policyOps = sql.split(/;\s*\n/).filter((s) => s.includes(`"${name}"`));
      expect(policyOps.length).toBeGreaterThan(0);
      expect(/DROP POLICY/i.test(policyOps[policyOps.length - 1])).toBe(true);
    }
  });

  it('public getter is a sanitized allowlist, never to_jsonb(s.*)', () => {
    for (const body of [lastGetterBody(selfhostSql()), lastGetterBody(hostedSql())]) {
      expect(body).not.toMatch(/to_jsonb\s*\(\s*s\.\*\s*\)/);
      expect(body).toMatch(/jsonb_build_object/);
      for (const field of SECRET_FIELDS) expect(body).not.toContain(field);
    }
  });

  it('getter EXECUTE is explicitly revoked from PUBLIC and re-granted', () => {
    const sql = selfhostSql();
    expect(sql).toMatch(
      /REVOKE ALL ON FUNCTION public\.get_widget_platform_settings\(\) FROM PUBLIC/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_widget_platform_settings\(\) TO anon/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_widget_platform_settings\(\) TO authenticated/,
    );
    expect(sql).toMatch(
      /GRANT EXECUTE ON FUNCTION public\.get_widget_platform_settings\(\) TO service_role/,
    );
  });

  it('no browser code selects the raw widget_platform_settings table', () => {
    const src = join(process.cwd(), 'src');
    const stack: string[] = [src];
    const offenders: string[] = [];
    while (stack.length) {
      const dir = stack.pop()!;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'test') stack.push(p);
          continue;
        }
        if (!/\.(ts|tsx)$/.test(entry.name)) continue;
        const text = readFileSync(p, 'utf8');
        if (/\.from\(\s*['"]widget_platform_settings['"]\s*\)/.test(text)) offenders.push(p);
      }
    }
    expect(offenders).toEqual([]);
  });
});

// ── Backend platform-admin endpoint + self-heal ────────────────────

type Row = Record<string, any>;
let rows: Row[] = [];
let admin = true;
let authed = true;

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from() {
      const builder: any = {
        select: () => builder,
        limit: () => builder,
        eq: () => builder,
        maybeSingle: async () => ({ data: rows[0] ?? null, error: null }),
        single: async () => ({ data: rows[0] ?? null, error: rows[0] ? null : { message: 'no row' } }),
        insert(row: Row) {
          if (rows.length > 0) {
            return {
              select: () => ({
                single: async () => ({ data: null, error: { message: 'duplicate key: singleton' } }),
              }),
            };
          }
          rows.push({ id: 'singleton-id', alert_webhook_secret: 'shh', ...row });
          return { select: () => ({ single: async () => ({ data: rows[0], error: null }) }) };
        },
        update(patch: Row) {
          Object.assign(rows[0], patch);
          return { eq: () => ({ select: () => ({ single: async () => ({ data: rows[0], error: null }) }) }) };
        },
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/lib/workspaceAuth.js', () => ({
  authorizeWorkspaceAccess: async () => null,
  requirePlatformAdmin: async (_req: any, res: any) => {
    if (!authed) {
      res.status(401).json({ error: 'Unauthorized' });
      return null;
    }
    if (!admin) {
      res.status(403).json({ error: 'Not authorized' });
      return null;
    }
    return 'admin-user';
  },
}));

async function app() {
  const { widgetSettingsRouter } = await import('../../../server/routes/widgetSettings.js');
  const a = express();
  a.use(express.json());
  a.use((req: any, _res, next) => {
    req.serverConfig = {};
    next();
  });
  a.use('/api/widget-settings', widgetSettingsRouter);
  return a;
}

describe('platform widget settings endpoint', () => {
  beforeEach(() => {
    rows = [];
    admin = true;
    authed = true;
  });

  it('self-heals a missing singleton row for platform admin', async () => {
    const res = await request(await app()).get('/api/widget-settings/platform/config');
    expect(res.status).toBe(200);
    expect(rows).toHaveLength(1);
  });

  it('keeps exactly one row under concurrent initialization', async () => {
    const a = await app();
    const [r1, r2] = await Promise.all([
      request(a).get('/api/widget-settings/platform/config'),
      request(a).get('/api/widget-settings/platform/config'),
    ]);
    expect(rows).toHaveLength(1);
    expect([r1.status, r2.status]).toEqual([200, 200]);
  });

  it('returns the complete row (including secrets) to platform admin', async () => {
    const a = await app();
    await request(a).get('/api/widget-settings/platform/config');
    const res = await request(a).get('/api/widget-settings/platform/config');
    expect(res.body.settings.alert_webhook_secret).toBe('shh');
  });

  it('allows platform admin to update settings', async () => {
    const a = await app();
    await request(a).get('/api/widget-settings/platform/config');
    const res = await request(a)
      .patch('/api/widget-settings/platform/config')
      .send({ id: 'singleton-id', max_message_length: 1234 });
    expect(res.status).toBe(200);
    expect(rows[0].max_message_length).toBe(1234);
  });

  it('rejects non-admin with 403 and does not self-heal', async () => {
    admin = false;
    const res = await request(await app()).get('/api/widget-settings/platform/config');
    expect(res.status).toBe(403);
    expect(rows).toHaveLength(0);
  });

  it('rejects unauthenticated with 401 and does not self-heal', async () => {
    authed = false;
    const res = await request(await app()).get('/api/widget-settings/platform/config');
    expect(res.status).toBe(401);
    expect(rows).toHaveLength(0);
  });
});
