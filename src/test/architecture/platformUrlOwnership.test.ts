/**
 * Who owns which URL, and proof that nothing else answers for it.
 *
 * The platform names its hosts in two places and only two:
 *
 *   platform_domains          → canonical, app, api, public, help centre, email
 *   widget_platform_settings  → widget loader, assets, public origin, widget API
 *
 * Both are edited in Super Admin. Everything else — the compiled iOS bootstrap,
 * `VITE_API_BASE_URL`, `runtime-config.js` — is a bootstrap of last resort,
 * used only until the platform can be asked, because you cannot ask the API
 * where the API is without an API.
 *
 * That arrangement decays quietly. A column gets written by a form nobody
 * reads back; a build script pins a value the platform later moves; a hostname
 * lands in a fixture and is copied into a config. These tests pin the shape so
 * the decay shows up as a red test instead of a dead link in production.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(p, 'utf8');

/** Comments are stripped before a presence check, for the same reason they are
 *  in the iOS privacy-manifest test: this repo explains at length what it
 *  deliberately does NOT do, and a sentence saying "never read X" must not be
 *  mistaken for reading X. */
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
const stripSql = (s: string) => s.replace(/--[^\n]*/g, ' ');

const LEGACY = 'destekly';

// ───────────────────────────────────────────────────────────────────────────
// 1 + 2. Widget URLs come from widget_platform_settings, never from the
//        deprecated platform_domains columns.
// ───────────────────────────────────────────────────────────────────────────

describe('widget URLs are owned by widget_platform_settings', () => {
  const RUNTIME_DIRS = ['server', 'src', 'worker'];

  function walk(dir: string, out: string[] = []): string[] {
    if (!existsSync(dir)) return out;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(full, out);
      } else if (/\.(ts|tsx)$/.test(entry.name)) {
        out.push(full);
      }
    }
    return out;
  }

  const runtimeFiles = RUNTIME_DIRS.flatMap((d) => walk(d)).filter(
    (f) =>
      !f.includes('/test/') &&
      !f.endsWith('.test.ts') &&
      !f.endsWith('.test.tsx') &&
      // Type-declaration modules describe columns that exist in the schema.
      // That is true, and it is not a read. Both are checked separately below:
      // the generated one is left alone, and the hand-written one must carry a
      // DEPRECATED marker so nobody reaches for these fields on purpose.
      !f.endsWith('src/integrations/supabase/types.ts') &&
      !f.endsWith('src/types/models.ts'),
  );

  it('no runtime code reads platform_domains.widget_base_url or .asset_base_url', () => {
    const offenders: string[] = [];
    for (const file of runtimeFiles) {
      const code = stripTs(read(file));
      // `widget_asset_base_url` is the CORRECT column on widget_platform_settings
      // and must not be mistaken for the deprecated `asset_base_url`.
      const bare = code.replace(/widget_asset_base_url/g, '');
      if (/\bwidget_base_url\b/.test(bare) || /\basset_base_url\b/.test(bare)) {
        offenders.push(file);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the admin API refuses them as settings', () => {
    // A zod object strips undeclared keys, so a client that still sends these
    // is ignored rather than writing a competing answer for the same URL.
    const schema = stripTs(read('server/routes/adminManagement.ts'));
    const block = schema.slice(schema.indexOf('const platformDomainsSchema'));
    const body = block.slice(0, block.indexOf('});'));
    expect(body).not.toMatch(/\bwidget_base_url\b/);
    expect(body).not.toMatch(/\basset_base_url\b/);
    // and still accepts the platform URLs it does own
    for (const key of ['app_base_url', 'api_base_url', 'public_base_url', 'help_center_base_url']) {
      expect(body).toContain(key);
    }
  });

  it('the workspace-level copies are marked deprecated where they are declared', () => {
    const models = read('src/types/models.ts');
    const block = models.slice(
      models.indexOf('canonical_base_url') - 900,
      models.indexOf('canonical_base_url'),
    );
    expect(block).toContain('DEPRECATED');
    expect(block).toContain('/api/platform/origins');
  });

  it('the frontend type does not offer them as a setting', () => {
    const hook = stripTs(read('src/hooks/usePlatformBranding.ts'));
    const block = hook.slice(hook.indexOf('export interface PlatformDomains'));
    const body = block.slice(0, block.indexOf('}'));
    expect(body).not.toMatch(/\bwidget_base_url\b/);
    expect(body).not.toMatch(/\basset_base_url\b/);
  });

  it('no Super Admin form edits them', () => {
    const offenders: string[] = [];
    for (const file of runtimeFiles.filter((f) => f.endsWith('.tsx'))) {
      const code = stripTs(read(file)).replace(/widget_asset_base_url/g, '');
      if (/\bwidget_base_url\b|\basset_base_url\b/.test(code)) offenders.push(file);
    }
    expect(offenders).toEqual([]);
  });

  it('the widget resolves its URLs from widget_platform_settings', () => {
    const widget = read('server/routes/widget.ts');
    expect(widget).toContain("from('widget_platform_settings')");
    expect(widget).toMatch(
      /widget_loader_base_url[\s\S]{0,120}widget_asset_base_url[\s\S]{0,120}widget_public_base_url[\s\S]{0,120}widget_api_base_url/,
    );
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 3. platform_domains drives the dynamic consumers.
// ───────────────────────────────────────────────────────────────────────────

describe('platform_domains reaches every dynamic consumer', () => {
  const route = read('server/routes/platformOriginsPublic.ts');

  it('the public origins route reads platform_domains', () => {
    expect(route).toContain("from('platform_domains')");
    for (const col of ['api_base_url', 'app_base_url', 'public_base_url', 'canonical_base_url', 'help_center_base_url']) {
      expect(route).toContain(col);
    }
  });

  it('it answers with every field its clients rely on', () => {
    for (const field of ['apiBaseUrl', 'appBaseUrl', 'publicBaseUrl', 'helpCenterUrl', 'supportUrl', 'canonicalBaseUrl']) {
      expect(route, `${field} missing from the origins answer`).toContain(field);
    }
  });

  it('is public, so the app can ask before anyone signs in', () => {
    const index = read('server/index.ts');
    expect(index).toContain('platformOriginsPublicRouter');
    // It must not sit behind the admin guard.
    expect(stripTs(route)).not.toContain('requirePlatformAdmin');
  });

  it('the dashboard takes its canonical URL from the platform, not a workspace copy', () => {
    const ctx = stripTs(read('src/features/branding/BrandingContext.tsx'));
    expect(ctx).toContain('usePlatformOrigins');
    expect(ctx).toContain('canonicalBaseUrl');
    // The bug this replaced: building the tag from workspace_branding.
    expect(ctx).not.toMatch(/branding\??\.canonical_base_url/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4. The native bootstrap is a bootstrap, and the platform overrules it.
// ───────────────────────────────────────────────────────────────────────────

describe('native iOS API bootstrap defers to the platform', () => {
  const script = read('scripts/ios/write-native-config.mjs');
  const cfg = JSON.parse(read('config/mobile-runtime.json'));
  const origin = read('ios/WebyarNative/Sources/Core/Networking/PlatformOrigin.swift');

  it('ships an https bootstrap origin so a fresh install can make its first request', () => {
    expect(cfg.apiBaseUrl).toMatch(/^https:\/\/[^/]+$/);
  });

  it('the build script follows the platform when it disagrees', () => {
    expect(script).toContain('/api/platform/origins');
    // apiBaseUrl: platform answer wins and is written back to the config file.
    expect(script).toMatch(/apiBaseUrl = resolved/);
    expect(script).toMatch(/cfg\.apiBaseUrl = resolved/);
  });

  it('the platform also overrules a support URL already in the file', () => {
    // This once read `if (help && !supportUrl)`, which inverted the rule: a
    // stale value blocked the platform from ever correcting it.
    expect(stripTs(script)).not.toMatch(/&&\s*!supportUrl/);
    expect(script).toMatch(/cfg\.supportUrl = resolvedSupport/);
  });

  it('the app replaces the compiled origin with the platform answer at runtime', () => {
    expect(origin).toContain('PlatformOrigins');
    expect(origin).toContain('GeneratedConfig.apiBaseURL');
    // A stored origin that stops answering must be abandoned, or one typo in
    // Super Admin bricks every installed copy.
    expect(origin).toContain('forget()');
    const client = read('ios/WebyarNative/Sources/Core/Networking/APIClient.swift');
    expect(client).toContain('refreshOrigin');
    expect(client).toContain('PlatformOrigin.forget()');
  });

  it('only accepts https, so no platform answer can downgrade the transport', () => {
    expect(origin).toMatch(/scheme\?\.lowercased\(\)\s*==\s*"https"/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5 + 6. No active configuration or support link points at the legacy domain.
// ───────────────────────────────────────────────────────────────────────────

describe('no active configuration points at the legacy domain', () => {
  it('the build-time API base does not', () => {
    const env = read('.env');
    const line = env.split('\n').find((l) => l.startsWith('VITE_API_BASE_URL='));
    expect(line).toBeDefined();
    expect(line!.toLowerCase()).not.toContain(LEGACY);
  });

  it('the native bootstrap does not', () => {
    const raw = read('config/mobile-runtime.json').toLowerCase();
    expect(raw).not.toContain(LEGACY);
    const generated = read('ios/WebyarNative/Sources/Core/Networking/GeneratedConfig.swift');
    expect(generated.toLowerCase()).not.toContain(LEGACY);
  });

  it('no support link does', () => {
    const cfg = JSON.parse(read('config/mobile-runtime.json'));
    expect(String(cfg.supportUrl ?? '').toLowerCase()).not.toContain(LEGACY);
    // And the support URL is resolved by the platform, not assembled by a
    // client guessing at a path. `/contact` was such a guess, and it was never
    // a route this app served.
    expect(read('server/routes/platformOriginsPublic.ts')).toContain('supportUrl');
    expect(stripTs(read('scripts/ios/write-native-config.mjs'))).not.toContain('/contact');
  });

  it('no page served from public/ does', () => {
    for (const entry of readdirSync('public', { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!/\.(html|js|json|webmanifest)$/.test(entry.name)) continue;
      expect(read(join('public', entry.name)).toLowerCase(), entry.name).not.toContain(LEGACY);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7 + 8 + 9. The cleanup migration is targeted, and history is untouched.
// ───────────────────────────────────────────────────────────────────────────

describe('the cleanup migration is safe to run anywhere, twice', () => {
  const PATH = 'database/migrations/197_retire_legacy_platform_url_shadows.sql';
  const sql = read(PATH);
  const body = stripSql(sql);

  it('only ever sets the retired columns to NULL', () => {
    const sets = body.match(/SET\s+%I\s*=\s*[^,\s]+/gi) ?? [];
    expect(sets.length).toBeGreaterThan(0);
    for (const s of sets) expect(s).toMatch(/=\s*NULL/i);
  });

  it('matches an explicit legacy list, never a pattern', () => {
    // A LIKE/wildcard match is how a cleanup eats somebody's custom value.
    expect(body).toContain('= ANY($1)');
    expect(body).not.toMatch(/ILIKE|LIKE\s+'%/i);
    expect(body).toMatch(/legacy text\[\] := ARRAY\[/);
  });

  it('touches only the two retired platform_domains columns', () => {
    const cols = body.match(/ARRAY\['([a-z_]+)',\s*'([a-z_]+)'\]/);
    expect(cols?.slice(1, 3).sort()).toEqual(['asset_base_url', 'widget_base_url']);
  });

  it('never weakens a protection trigger to force a write through', () => {
    // `trg_protect_workspace_domains` silently reverts non-admin writes, so a
    // migration cannot clean workspace_branding without disabling it — and
    // disabling a guard to NULL columns nothing reads is not a trade worth
    // making. Those rows are cleared from Super Admin instead.
    expect(body).not.toMatch(/DISABLE\s+TRIGGER/i);
    expect(body).not.toMatch(/session_replication_role/i);
    expect(body).not.toMatch(/DROP\s+TRIGGER/i);
    expect(body).not.toMatch(/DISABLE\s+ROW\s+LEVEL\s+SECURITY/i);
  });

  it('guards every table and column it touches, so a partial chain still applies', () => {
    expect(body).toContain("to_regclass('public.platform_domains')");
    expect(body).toContain('information_schema.columns');
  });

  it('has a number of its own in the self-host chain', () => {
    // This used to assert 197 was the *highest* number, which was true on the
    // day it was written and is not a property worth defending: the next
    // migration anybody adds makes it false, and the failure says nothing
    // about whether this file is correct. What matters is that 197 is taken
    // once — two files sharing a number apply in an order nobody chose.
    const numbers = readdirSync('database/migrations')
      .map((f) => Number(f.split('_')[0]))
      .filter((n) => Number.isFinite(n));
    expect(numbers.filter((n) => n === 197)).toHaveLength(1);
    expect(new Set(numbers).size).toBe(numbers.length);
  });
});

describe('history is not rewritten', () => {
  // Rewriting a migration that already ran on production does not correct
  // history — it only breaks checksum parity and self-host upgrades. These
  // files keep the legacy domain on purpose.
  const HISTORICAL = [
    'supabase/migrations/20260415151702_f5980fe3-0727-466d-8035-b28fac940c98.sql',
    'supabase/migrations/20260504091511_8d47febd-5e1e-47a9-8d3f-de466abf6fc0.sql',
    'supabase/migrations/20260807105928_clear_stale_turkish_intro_seed.sql',
    'supabase/migrations/20260807114711_8d38d11a-2c54-4da3-8ffa-5170ee6f63de.sql',
    'database/migrations/159_workspace_branding_name_cleared.sql',
  ];

  it('the historical migrations still carry their original values', () => {
    for (const file of HISTORICAL) {
      expect(existsSync(file), file).toBe(true);
      expect(read(file).toLowerCase(), file).toContain(LEGACY);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 10. The allowlist. Anything else is a regression.
// ───────────────────────────────────────────────────────────────────────────

describe('the legacy domain survives only where it is meant to', () => {
  /**
   * Every file here is deliberate, and the reason is stated. A new entry is
   * not a formality: adding one means a live reference came back, and the fix
   * is almost always the file, not this list.
   */
  const ALLOWED: Record<string, string> = {
    'supabase/migrations/20260415151702_f5980fe3-0727-466d-8035-b28fac940c98.sql':
      'historical — seeded the hosted tenant domain; already applied in production',
    'supabase/migrations/20260504091511_8d47febd-5e1e-47a9-8d3f-de466abf6fc0.sql':
      'historical — the original AI/demo content seed',
    'supabase/migrations/20260807105928_clear_stale_turkish_intro_seed.sql':
      'historical — the earlier targeted cleanup; must name the exact text it clears',
    'supabase/migrations/20260807114711_8d38d11a-2c54-4da3-8ffa-5170ee6f63de.sql':
      'historical — follow-up to the same seed',
    'database/migrations/159_workspace_branding_name_cleared.sql':
      'historical — a comment naming the legacy value it cleared',
    'database/migrations/197_retire_legacy_platform_url_shadows.sql':
      'the cleanup itself — must list the exact legacy values it targets',
    'src/test/ci/migrationForeignKeySeedSafety.test.ts':
      'guards the historical seeds above; names them by design',
    'src/test/architecture/platformUrlOwnership.test.ts':
      'this file — it searches for the string',
  };

  const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '.next', 'ios/App/App/public']);

  function walkAll(dir: string, out: string[] = []): string[] {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || SKIP_DIRS.has(full)) continue;
        walkAll(full, out);
      } else {
        out.push(full);
      }
    }
    return out;
  }

  it('appears in no file outside the allowlist', () => {
    const hits: string[] = [];
    for (const file of walkAll('.')) {
      if (/\.(png|jpg|jpeg|gif|webp|ico|woff2?|ttf|mp3|mp4|zip|pdf|lockb)$/i.test(file)) continue;
      let text: string;
      try {
        text = read(file);
      } catch {
        continue;
      }
      if (text.toLowerCase().includes(LEGACY)) hits.push(file.replace(/^\.\//, ''));
    }
    expect(hits.sort()).toEqual(Object.keys(ALLOWED).sort());
  });

  it('every allowlist entry states why, and still exists', () => {
    for (const [file, reason] of Object.entries(ALLOWED)) {
      expect(existsSync(file), `${file} is allowlisted but missing`).toBe(true);
      expect(reason.length, file).toBeGreaterThan(20);
    }
  });
});
