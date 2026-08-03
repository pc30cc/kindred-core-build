/**
 * CI hotfix integrity tests.
 *
 * 1. The self-host Auth bootstrap must pass the UNPREFIXED `API_EXTERNAL_URL`
 *    that the official GoTrue image requires (`GOTRUE_API_EXTERNAL_URL` is
 *    NOT accepted and must never be substituted).
 * 2. `supabase/migrations` must be self-contained in timestamp order: a table
 *    may not be ALTERed, policied, triggered or inserted into before the
 *    migration that first creates it.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

const WORKFLOW = '.github/workflows/ci.yml';

describe('self-host GoTrue bootstrap', () => {
  const yml = readFileSync(WORKFLOW, 'utf8');

  it('passes the unprefixed API_EXTERNAL_URL', () => {
    expect(yml).toContain('API_EXTERNAL_URL=http://localhost:9999');
  });

  it('never substitutes GOTRUE_API_EXTERNAL_URL', () => {
    expect(yml).not.toContain('GOTRUE_API_EXTERNAL_URL');
  });

  it('keeps the rest of the documented bootstrap environment', () => {
    for (const v of [
      'GOTRUE_API_HOST=localhost',
      'PORT=9999',
      'GOTRUE_SITE_URL=http://localhost:3000',
    ]) {
      expect(yml).toContain(v);
    }
  });
});

describe('supabase migration chain — dependency order', () => {
  const dir = 'supabase/migrations';
  const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();

  /** Table name → first migration that creates it. */
  const created = new Map<string, string>();
  /** Offences: a table used before any migration created it. */
  const violations: string[] = [];

  for (const file of files) {
    const sql = readFileSync(`${dir}/${file}`, 'utf8').replace(/--[^\n]*/g, '');

    for (const m of sql.matchAll(
      /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?(?:public\.)?"?([a-z0-9_]+)"?/gi,
    )) {
      const t = m[1].toLowerCase();
      if (!created.has(t)) created.set(t, file);
    }

    const refs: Array<[RegExp, string]> = [
      [/ALTER\s+TABLE\s+(?:ONLY\s+)?(?:IF\s+EXISTS\s+)?public\.([a-z0-9_]+)/gi, 'ALTER TABLE'],
      [/CREATE\s+POLICY[^;]*?\sON\s+(?:public\.)?([a-z0-9_"]+)/gi, 'CREATE POLICY'],
      [/CREATE\s+(?:OR\s+REPLACE\s+)?TRIGGER[^;]*?\sON\s+public\.([a-z0-9_]+)/gi, 'CREATE TRIGGER'],
      [/INSERT\s+INTO\s+public\.([a-z0-9_]+)/gi, 'INSERT INTO'],
    ];

    for (const [re, kind] of refs) {
      for (const m of sql.matchAll(re)) {
        const t = m[1].replace(/"/g, '').toLowerCase();
        if (!created.has(t)) violations.push(`${file}: ${kind} public.${t} before its creation`);
      }
    }
  }

  it('creates public.platform_settings before its first ALTER', () => {
    const origin = created.get('platform_settings');
    expect(origin).toBeDefined();
    expect(origin! < '20260414134641').toBe(true);
  });

  it('creates public.workspace_domains_extended before its first policy', () => {
    const origin = created.get('workspace_domains_extended');
    expect(origin).toBeDefined();
    expect(origin! < '20260415082424').toBe(true);
  });

  it('never references a table before the migration that creates it', () => {
    expect(violations).toEqual([]);
  });
});
