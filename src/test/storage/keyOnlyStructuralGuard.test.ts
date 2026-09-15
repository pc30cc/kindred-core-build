/**
 * STRUCTURAL GUARD — the invariant, enforced against the source tree itself.
 *
 * Every rule below is already true of the code today; the point of asserting
 * it here is that the NEXT person to add an upload cannot quietly reintroduce
 * a persisted URL. A regression of this kind is invisible until someone
 * promotes a new storage provider and half the avatars point at a vendor that
 * is no longer serving them — by which time there is no stored key to repair
 * from. Catching it as a failing test is much cheaper.
 *
 * These are deliberately narrow, name-anchored checks over the specific
 * writers this architecture covers, not a blanket ban on the substring
 * "url" — a broad grep would break on every unrelated feature and be
 * disabled within a week.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function read(rel: string): string {
  return fs.readFileSync(path.join(ROOT, rel), 'utf8');
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(path.join(ROOT, dir), { withFileTypes: true })) {
    const rel = `${dir}/${entry.name}`;
    if (entry.isDirectory()) walk(rel, out);
    else if (entry.name.endsWith('.ts')) out.push(rel);
  }
  return out;
}

describe('no writer persists a provider URL', () => {
  /**
   * The five columns that used to hold one. Each is now written only as
   * `<column>: null` (an explicit clear) or read for an externally supplied
   * value — never assigned a URL the platform just built.
   */
  const FORBIDDEN_ASSIGNMENTS: Array<{ file: string; pattern: RegExp; what: string }> = [
    {
      file: 'server/routes/account.ts',
      pattern: /avatar_url:\s*(result|uploaded|upload)\b/,
      what: 'profiles.avatar_url from an upload result',
    },
    {
      file: 'server/routes/account.ts',
      pattern: /logo_url:\s*(result|uploaded|upload)\b/,
      what: 'workspace_branding.logo_url from an upload result',
    },
    {
      file: 'server/routes/callCenter.ts',
      pattern: /avatar_url:\s*(result|uploaded|upload)\b/,
      what: 'call_center_settings.avatar_url from an upload result',
    },
    {
      file: 'server/routes/callCenter.ts',
      pattern: /ringback_music_url\s*=\s*url\b/,
      what: 'platform_call_center_settings.ringback_music_url from a derived link',
    },
    {
      file: 'server/routes/ai-agent/assistant.ts',
      pattern: /agent_logo_url:\s*(uploaded|result|upload)\b/,
      what: 'ai_agent_settings.agent_logo_url from an upload result',
    },
    {
      file: 'server/services/channels/telegram/mediaIngest.ts',
      pattern: /avatar_url:\s*(url|uploaded|result)\b/,
      what: 'contacts.avatar_url from an upload result',
    },
    {
      file: 'server/services/ai-agent/responder.ts',
      pattern: /agent_logo_url:\s*input\./,
      what: 'a provider URL snapshotted into conversation_messages.metadata',
    },
    {
      file: 'server/services/storage/legacyMigration/categories.ts',
      pattern: /logo_url:\s*url\b/,
      what: 'workspace_branding.logo_url rewritten by the legacy key migration',
    },
  ];

  for (const { file, pattern, what } of FORBIDDEN_ASSIGNMENTS) {
    it(`does not write ${what}`, () => {
      expect(read(file)).not.toMatch(pattern);
    });
  }

  it('keeps the abandoned URL-cache subsystem deleted', () => {
    expect(fs.existsSync(path.join(ROOT, 'server/services/storage/urlRefresh.ts'))).toBe(false);
    const sources = [
      ...walk('server'),
      ...walk('src/lib'),
      ...walk('src/features'),
    ];
    for (const rel of sources) {
      const body = read(rel);
      expect(body, rel).not.toContain('refreshStoredFileUrls');
      expect(body, rel).not.toContain('refresh-urls');
    }
  });
});

describe('URL derivation has exactly one home', () => {
  const RESOLVER = 'server/services/storage/urlResolver.ts';

  it('is the only module outside the storage service that builds a link from a key', () => {
    // `getFileUrlWithConfig` is the raw string builder. Read paths must go
    // through the resolver instead, which adds the ownership check and the
    // per-request provider cache; the exceptions below own a provider config
    // directly and are not serializing a tenant's row.
    const ALLOWED = new Set([
      'server/services/storage/index.ts',          // defines it
      RESOLVER,                                     // the one derivation layer
      'server/routes/callCenter.ts',                // platform ringback upload, explicit config
    ]);
    const offenders = walk('server')
      .filter((rel) => !ALLOWED.has(rel))
      .filter((rel) => read(rel).includes('getFileUrlWithConfig'));

    expect(offenders).toEqual([]);
  });

  it('never caches a resolver beyond one request', () => {
    const body = read(RESOLVER);
    // A module-level provider cache would keep serving the old vendor after
    // a promotion — the exact failure this architecture exists to remove.
    expect(body).not.toMatch(/^const\s+\w*[Cc]ache\w*\s*=\s*new Map/m);
    expect(body).toContain('export function createStorageUrlResolver');
  });

  it('derives without touching the provider or writing a row', () => {
    const body = read(RESOLVER);
    for (const forbidden of ['fetch(', 'recordStorageUsage', 'storage_usage_logs', 'markReplicaDirty']) {
      expect(body, forbidden).not.toContain(forbidden);
    }
  });
});

describe('migration 190 backfills conservatively', () => {
  const SQL = 'database/migrations/190_storage_key_ownership.sql';

  it('only adopts a key that names the row\'s OWN workspace', () => {
    const body = read(SQL);
    // A generic `workspace/<any-uuid>/` match would happily adopt another
    // tenant's path out of an integrator-supplied avatar URL.
    expect(body).not.toMatch(/workspace\/\[0-9a-fA-F-\]\{36\}/);
    expect(body).toContain("'(workspace/' || c.workspace_id::text || '/avatars/telegram/.*)$'");
  });

  it('strips query strings and fragments before slicing the key', () => {
    const body = read(SQL);
    expect(body).toContain("split_part(split_part(c.avatar_url, '#', 1), '?', 1)");
  });

  it('adds an ownership CHECK for every key column it knows about', () => {
    const body = read(SQL);
    for (const name of [
      'contacts_avatar_storage_key_owned',
      'profiles_avatar_storage_key_owned',
      'workspace_branding_logo_storage_key_owned',
      'call_center_settings_avatar_storage_path_owned',
    ]) {
      expect(body).toContain(name);
    }
  });

  it('leaves migration 189 untouched by this change', () => {
    // 189 is already applied in production; editing it would silently skip
    // on every environment that has recorded it.
    expect(read('database/migrations/189_storage_provider_pool_atomic.sql'))
      .toContain('set_storage_provider_pool');
  });

  it('is mirrored to the hosted chain byte for byte', () => {
    expect(read('supabase/migrations/20260916093000_storage_key_ownership.sql')).toBe(read(SQL));
  });
});
