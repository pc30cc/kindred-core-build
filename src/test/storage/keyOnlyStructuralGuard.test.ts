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

describe('no Workspace-writable schema accepts a media URL', () => {
  /**
   * The product rule, not a style rule: a workspace user, operator or admin
   * must never be able to type a media/file URL and have it persisted.
   * WebYar-managed media has exactly one path —
   *
   *   upload/ingest -> WebYar storage -> canonical key -> URL derived on read
   *
   * — so every one of these fields was removed from its request schema. The
   * previous pass checked only what UPLOAD HANDLERS wrote, which is why it
   * missed the launcher image: nothing was wrong with the upload, the hole
   * was the settings schema next to it. These assertions look at the
   * schemas.
   */
  const CLOSED_INPUTS: Array<{ file: string; schema: RegExp; field: string; what: string }> = [
    {
      file: 'server/routes/contacts.ts',
      schema: /const contactSchema = z\.object\(\{[\s\S]*?\}\)\.strict\(\)/,
      field: 'avatar_url',
      what: 'contact create / bulk / update',
    },
    {
      file: 'server/routes/ai-agent/assistant.ts',
      schema: /const updateSchema = z\.object\(\{[\s\S]*?\n\}\)\.strict\(\)/,
      field: 'agent_logo_url',
      what: 'the AI agent settings PUT',
    },
    {
      file: 'server/routes/callCenter.ts',
      schema: /const settingsPatchSchema = z\.object\(\{[\s\S]*?\n\}\)\.strict\(\)/,
      field: 'avatar_url',
      what: 'the call-centre settings PUT',
    },
    {
      file: 'server/routes/widgetSettings.ts',
      schema: /const widgetSettingsPatchSchema = z\.object\(\{[\s\S]*?\n\}\)\.strict\(\)/,
      field: 'fab_image_url',
      what: 'the generic widget settings PATCH',
    },
  ];

  for (const { file, schema, field, what } of CLOSED_INPUTS) {
    it(`${what} does not accept ${field}`, () => {
      const match = schema.exec(read(file));
      expect(match, `schema not found in ${file}`).toBeTruthy();
      // A comment may mention the field (explaining why it is gone); an
      // actual `field: z.…` declaration may not exist.
      const declarations = (match![0].match(new RegExp(`^\\s*${field}\\s*:`, 'gm')) ?? []);
      expect(declarations).toEqual([]);
    });
  }

  it('every one of those schemas is fail-closed, so a stale client is told', () => {
    // `.strict()` turns "we ignored your avatar_url" into a 400 naming it —
    // the difference between a silently dropped write and a visible one.
    for (const { file, schema } of CLOSED_INPUTS) {
      expect(schema.test(read(file)), file).toBe(true);
    }
  });

  it('the workspace branding PATCH strips media URL columns from its passthrough body', () => {
    const body = read('server/routes/workspaces.ts');
    for (const field of ['logo_storage_key', 'logo_url', 'favicon_url', 'social_image_url']) {
      expect(body, field).toContain(`'${field}'`);
    }
    expect(body).toMatch(/for \(const field of STORAGE_OWNED_BRANDING_FIELDS\) delete updates\[field\];/);
  });

  it('no WebYar upload result URL is persisted into a domain or settings table', () => {
    // A general sweep, not a per-file list: any `<something>_url: <x>.url`
    // where x is an upload result is the exact shape this architecture
    // forbids, wherever it appears.
    const offenders: string[] = [];
    for (const rel of walk('server')) {
      const lines = read(rel).split('\n');
      lines.forEach((line, i) => {
        if (/\w+_url\s*:\s*(result|uploaded|upload|saved|res)\b[^,;)]*\.url\b/.test(line)) {
          offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        }
      });
    }
    expect(offenders).toEqual([]);
  });

  it('the launcher image is uploaded by the server, never by the browser', () => {
    const page = read('src/pages/app/WidgetPage.tsx');
    // The old shape: browser uploads through the generic storage API, then
    // saves whichever provider URL came back.
    expect(page).not.toContain('storageUpload');
    expect(page).not.toMatch(/setField\(\s*'fab_image_url'/);
    // The new shape: hand the bytes to the dedicated endpoint.
    expect(page).toContain('useUploadWidgetFabImage');
    expect(read('server/routes/widgetSettings.ts')).toContain("widgetSettingsRouter.post('/:workspaceId/fab-image'");
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
      'widget_settings_fab_image_storage_key_owned',
    ]) {
      expect(body).toContain(name);
    }
  });

  it('adds the launcher-image key column, scoped to the workspace widget namespace', () => {
    const body = read(SQL);
    expect(body).toContain('ADD COLUMN IF NOT EXISTS fab_image_storage_key text');
    expect(body).toContain("fab_image_storage_key LIKE 'workspace/' || workspace_id::text || '/widget/%'");
  });

  it('recovers legacy launcher keys, and only from the row\'s own workspace', () => {
    const body = read(SQL);
    // Without this backfill an existing WebYar-owned launcher stays pinned to
    // whichever provider was primary when the browser uploaded it.
    expect(body).toContain('SET fab_image_storage_key = substring(');
    expect(body).toContain("'(workspace/' || w.workspace_id::text || '/widget/launcher-[0-9]+\\.[A-Za-z0-9]+)$'");
    expect(body).toContain("split_part(split_part(w.fab_image_url, '#', 1), '?', 1)");
    // Never a generic uuid match.
    expect(body).not.toMatch(/widget\/launcher[^\n]*\[0-9a-fA-F-\]\{36\}/);
  });

  it('neither backfill clears the legacy URL column it read from', () => {
    // 190 lands BEFORE the new backend, so the old code still needs them.
    const body = read(SQL);
    const upToConstraints = body.slice(0, body.indexOf('-- ─── 2.'));
    expect(upToConstraints).not.toMatch(/SET[^;]*\bavatar_url\s*=/);
    expect(upToConstraints).not.toMatch(/SET[^;]*\bfab_image_url\s*=/);
  });

  it('verifies after the fact that no backfilled key escaped its namespace', () => {
    const body = read(SQL);
    expect(body).toContain('contact avatar key(s) are not workspace-scoped');
    expect(body).toContain('launcher image key(s) are not workspace-scoped');
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

/**
 * The AI logo snapshot is the one persisted URL that was not a column.
 *
 * `conversation_messages.metadata.agent_logo_url` was written on every AI
 * reply so the widget could draw the avatar straight off the realtime
 * envelope. It is a provider URL frozen into a row, so it breaks at the
 * first promotion exactly like a column would — and because it lived in
 * jsonb, none of the column-shaped guards above could see it.
 */
describe('no AI reply snapshots its logo into the message row', () => {
  it('the responder writes no agent_logo_url into message metadata', () => {
    const body = read('server/services/ai-agent/responder.ts');
    expect(body).not.toMatch(/agent_logo_url\s*:/);
  });

  it('the responder puts the DERIVED link on the realtime envelope instead', () => {
    // Removing the snapshot without this leaves a live AI reply with no
    // avatar at all until the visitor reloads.
    const body = read('server/services/ai-agent/responder.ts');
    expect(body).toContain('resolveWorkspaceAgentLogoUrl');
    expect(body).toMatch(/sender_avatar\s*:/);
  });

  it('no server read path falls back to the snapshot', () => {
    for (const rel of [...walk('server/routes'), ...walk('server/services')]) {
      const body = read(rel);
      expect(body, rel).not.toMatch(/(metadata|meta)\s*[.?]*\.?\s*\[?['"]?agent_logo_url['"]?\]?\s*(\|\||\?\?)/);
    }
  });

  it('the shipped widget runtime no longer reads it either', () => {
    // The client fallback is what actually surfaced the dead host: it fires
    // whenever `sender_avatar` is falsy, so every legacy row kept drawing a
    // retired provider's image.
    expect(read('public/widget/runtime.js')).not.toMatch(/metadata\.agent_logo_url\s*\|\|/);
  });
});

describe('migration 191 clears the snapshots already written', () => {
  const SQL_191 = 'database/migrations/191_drop_message_agent_logo_snapshot.sql';

  it('removes exactly that one json key, only where present', () => {
    const body = read(SQL_191);
    expect(body).toContain("SET metadata = metadata - 'agent_logo_url'");
    expect(body).toContain("WHERE metadata ? 'agent_logo_url'");
  });

  it('touches nothing else on the row', () => {
    const body = read(SQL_191);
    // One UPDATE, one column, no DELETE anywhere.
    expect(body.match(/^\s*UPDATE /gm)?.length).toBe(1);
    expect(body).not.toMatch(/\bDELETE\s+FROM\b/i);
    expect(body).not.toMatch(/SET[^;]*\b(body|sender_type|created_at)\s*=/);
  });

  it('fails rather than reporting a partial cleanup', () => {
    expect(read(SQL_191)).toContain('still carry metadata.agent_logo_url');
  });

  it('is mirrored to the hosted chain byte for byte', () => {
    expect(read('supabase/migrations/20260916094000_drop_message_agent_logo_snapshot.sql'))
      .toBe(read(SQL_191));
  });
});
