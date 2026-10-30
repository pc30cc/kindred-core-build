/**
 * Email transport belongs to the platform, and to nothing else.
 *
 * One provider, configured by a platform admin in
 * Super Admin → Providers → Communication → Email, stored as
 * `app_runtime_config.default_email_provider`. Every send — auth mail, OTP,
 * verification, password reset, invitations, offline notifications, billing
 * notices, the email channel, the test send — goes through `sendEmail()` /
 * `sendPlatformEmail()` and therefore through that one config.
 *
 * It used to resolve workspace-first:
 *
 *   workspace_provider_settings → provider_configs (workspace) → platform
 *
 * which meant a workspace owner saving a provider in Settings → Providers
 * could put their own Resend key and From address in front of mail the
 * platform sends on its own behalf. These tests pin the new rule.
 *
 * A workspace id is still passed around for entitlements, templates,
 * recipients and `email_logs`. It just no longer selects infrastructure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const read = (p: string) => readFileSync(p, 'utf8');
const stripTs = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');

const SERVICE = 'server/services/email/index.ts';
/** The one reader and writer of the provider rows (secrets decrypted there). */
const STORE = 'server/services/email/providerConfigStore.ts';

// ───────────────────────────────────────────────────────────────────────────
// 2 + 3. The provider is resolved from the platform config and nowhere else.
// ───────────────────────────────────────────────────────────────────────────

describe('the email provider resolves from platform config only', () => {
  const code = stripTs(read(SERVICE));

  it('reads app_runtime_config.default_email_provider, through the config store', () => {
    expect(code).toContain('default_email_provider');
    expect(code).toMatch(/loadEmailProviderConfig\(config, 'default_email_provider'\)/);
    const store = stripTs(read(STORE));
    expect(store).toContain('default_email_provider');
    expect(store).toContain("from('app_runtime_config')");
  });

  it('never consults a workspace-scoped provider table', () => {
    for (const body of [code, stripTs(read(STORE))]) {
      expect(body).not.toContain('workspace_provider_settings');
      expect(body).not.toContain('provider_configs');
    }
  });

  it('the resolver does not even take a workspace id', () => {
    // The strongest form of "no workspace override": the function cannot
    // express one. If this signature grows a workspace argument back, the
    // override is one line away again.
    //
    // It takes one other argument now, and it is deliberately NOT a
    // workspace: `overrideKey` names another row of `app_runtime_config` —
    // platform infrastructure, chosen by a platform admin in Super Admin →
    // Notifications, so operator notification emails can leave by a
    // different transport than password resets. A key is not a tenant, and
    // the assertion still refuses anything that looks like one. The first
    // argument is the server config (the config store reads the row, secrets
    // decrypted), not a workspace either.
    expect(code).toMatch(
      /async function resolveProviderConfig\(\s*config: ServerConfig,\s*overrideKey\?: string,?\s*\)/,
    );
    expect(code).not.toMatch(/resolveProviderConfig\([^)]*workspace/i);
    // and the store's own reader takes a platform key, never a workspace
    expect(stripTs(read(STORE))).toMatch(/async function loadEmailProviderConfig\(config: ServerConfig, key: EmailProviderKey\)/);
  });

  it('and only the platform can name the override', () => {
    // The override travels as `providerConfigKey` on an `EmailRequest`. A
    // workspace admin has no way to set it: the only senders that pass one
    // are the platform's own, and the value they pass comes from the
    // singleton settings row rather than from any request body.
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path);
          continue;
        }
        if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
        if (path === SERVICE) continue;
        if (stripTs(read(path)).includes('providerConfigKey')) callers.push(path);
      }
    };
    walk('server');

    // The Super Admin's "Send test email" of the notification slot names the
    // same row, from its own slot table, never from the request.
    expect(callers.sort()).toEqual(['server/routes/adminEmailProviders.ts', 'server/services/notificationEmail/dispatcher.ts']);
    const route = stripTs(read('server/routes/adminEmailProviders.ts'));
    expect(route).toContain('providerConfigKey: key');
    expect(route).toContain('const key = EMAIL_PROVIDER_SLOTS[slot]');
  });

  it('no other email module reaches for a workspace provider', () => {
    for (const file of readdirSync('server/services/email')) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const body = stripTs(read(join('server/services/email', file)));
      expect(body, file).not.toContain('workspace_provider_settings');
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 1 (route half) + 8. Workspaces keep AI and webhook; email is refused.
// ───────────────────────────────────────────────────────────────────────────

describe('workspace provider settings still cover everything except email', () => {
  const route = stripTs(read('server/routes/workspaceIntegrations.ts'));

  it('the upsert schema accepts ai and webhook, not email', () => {
    const m = route.match(/provider_type:\s*z\.enum\(\[([^\]]*)\]\)/);
    expect(m, 'provider_type enum not found').toBeTruthy();
    const values = m![1].split(',').map((s) => s.trim().replace(/['"]/g, '')).filter(Boolean);
    expect(values.sort()).toEqual(['ai', 'webhook']);
  });

  it('the workspace Providers screen no longer offers an email card', () => {
    const page = read('src/pages/app/settings/ProvidersPage.tsx');
    expect(page).not.toContain('EmailProviderCard');
    expect(stripTs(page)).not.toMatch(/provider_type:\s*'email'/);
    // and still offers the ones a workspace does own
    expect(page).toContain('AIProviderCard');
    expect(page).toContain('WebhookCard');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 7. The localized email-settings table is not in the send path.
// ───────────────────────────────────────────────────────────────────────────

describe('Super Admin shows no email setting the runtime ignores', () => {
  const page = read('src/pages/admin/BrandingPage.tsx');
  const admin = read('server/routes/adminManagement.ts');

  /**
   * Every field that used to sit in Super Admin → Branding → Email Settings
   * and was read by nothing. The last of the seven, `reply_to_email`, went
   * too (2026-10-29): it set no Reply-To on any message, and the one reader
   * of that column (the offline-message fallback in widget.ts) reads the
   * workspace's own row, never the platform's. Reply-To is the provider's
   * `reply_to` now, like From.
   */
  const DEAD = [
    'sender_email',        // From identity lives on the email provider
    'sender_name',         // same
    'email_logo_url',      // no template has an <img> tag
    'email_footer_text',   // no template has a footer placeholder
    'footer_text',         // localized copy of the above
    'support_contact_label',
    'reply_to_email',      // Reply-To lives on the email provider
  ];

  it('the Branding page renders none of them, and has no email settings section', () => {
    for (const field of DEAD) {
      expect(stripTs(page), `${field} still rendered`).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
    expect(stripTs(page)).not.toContain('EmailSettingsSection');
    expect(stripTs(page)).not.toContain('/email-settings');
  });

  it('the admin API has no email-settings route, localized or not', () => {
    // The table has no platform-level consumer at all, so the routes only
    // ever wrote a row nobody would read.
    expect(stripTs(admin)).not.toContain("'/email-settings'");
    expect(stripTs(admin)).not.toContain("'/email-settings-localized'");
    expect(stripTs(admin)).not.toContain('emailSettingsSchema');
    expect(stripTs(page)).not.toContain('email-settings-localized');
  });

  it('Reply-To is a field of every email provider, and the send path reads it there', () => {
    expect(read('shared/emailProviders.ts')).toMatch(/EMAIL_PROVIDER_COMMON_FIELDS = \[[^\]]*'reply_to'/);
    expect(stripTs(read(SERVICE))).toContain('effective.config.reply_to');
    expect(stripTs(read(SERVICE))).not.toContain('reply_to_email');
  });

  it('the send path never reads the localized table', () => {
    expect(stripTs(read(SERVICE))).not.toContain('email_settings_localized');
  });

  it('nothing on the send side reads either dead sender field', () => {
    for (const file of readdirSync('server/services/email')) {
      if (!file.endsWith('.ts')) continue;
      const body = stripTs(read(join('server/services/email', file)));
      expect(body, file).not.toMatch(/\bsender_email\b/);
      expect(body, file).not.toMatch(/\bsender_name\b/);
    }
  });

  it('the logo comes from the one brand-asset resolver, never from an email setting', () => {
    // The ban here was on an email-logo SETTING: email_logo_url and its footer
    // text sat in Branding and nothing read them, which is why they went.
    // Since the layout (owner, 2026-10-30) every mail wears the platform's
    // logo, read from the one place the whole project reads it
    // (server/services/platformBrandAssets.ts): a logo changed in Branding
    // changes every mail with it. So the core names a logo only through that
    // resolver, nothing in the email service reads a logo or footer column,
    // and the layout draws whatever it is handed, naming no image file.
    const service = stripTs(read(SERVICE));
    expect(service).toContain("from '../platformBrandAssets.js'");
    expect(service).toMatch(/resolveBrandAssets\(config, \{ edition, base: basics\.appUrl \}\)/);
    // {brand} is still the platform's own name, in the template's language.
    expect(service).toMatch(/brand: basics\.name/);
    for (const file of readdirSync('server/services/email')) {
      if (!file.endsWith('.ts')) continue;
      const body = stripTs(read(join('server/services/email', file)));
      expect(body, file).not.toMatch(/\b(email_logo_url|email_footer_text|logo_url|footer_text)\b/);
    }
    expect(stripTs(read('server/services/email/layout.ts'))).not.toMatch(/\.(png|svg|jpe?g|gif|webp)\b/i);
    const wrapper = read('server/services/verification/templates.ts');
    expect(wrapper).not.toMatch(/<img/i);
    expect(wrapper).not.toMatch(/\bfooter\b/i);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 5. The API key never leaves the server.
// ───────────────────────────────────────────────────────────────────────────

describe('provider credentials stay server-side', () => {
  it('no browser code reads the platform email provider config', () => {
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || full.includes('/test')) continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name)) {
          const body = stripTs(read(full));
          if (body.includes('default_email_provider')) offenders.push(full);
        }
      }
    };
    walk('src');
    // The admin screen writes it through an admin-gated API by key name built
    // at runtime (`default_${type}_provider`); it must never read the stored
    // value back into the browser by that literal.
    expect(offenders).toEqual([]);
  });

  it('the admin write route is platform-admin gated', () => {
    const admin = read('server/routes/adminManagement.ts');
    const put = admin.slice(admin.indexOf("adminManagementRouter.put('/runtime-config/:key'"));
    expect(put.slice(0, 300)).toContain('requirePlatformAdmin');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// 4 + 6. Behaviour: the real From header, and fail-closed.
// ───────────────────────────────────────────────────────────────────────────

type Row = Record<string, unknown>;

let runtimeConfigValue: Row | null;
let fetchMock: ReturnType<typeof vi.fn>;

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: () => Promise.resolve({ data: null, error: null }),
        maybeSingle: async () => {
          if (table === 'app_runtime_config') return { data: { value: runtimeConfigValue }, error: null };
          if (table === 'platform_branding_localized') {
            return { data: { platform_name: 'Brand From Branding' }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  }),
}));

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;

describe('the Resend request carries the platform From identity', () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: 'msg_1' }),
      text: async () => '',
    });
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.RESEND_API_KEY;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('sends exactly the global from_name and from_email', async () => {
    runtimeConfigValue = {
      provider_name: 'resend',
      config: { api_key: 'key_from_platform', from_email: 'hello@platform.example', from_name: 'Platform Mail' },
    };
    const { sendEmail } = await import('../../../server/services/email/index');
    const result = await sendEmail(CONFIG, {
      workspaceId: 'ws-1', to: 'someone@example.com', subject: 'Hi', html: '<p>Hi</p>',
    });

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe('https://api.resend.com/emails');
    expect(JSON.parse(init.body).from).toBe('Platform Mail <hello@platform.example>');
    // The key travels in the Authorization header and nowhere near the body.
    expect(init.headers.Authorization).toBe('Bearer key_from_platform');
    expect(init.body).not.toContain('key_from_platform');
  });

  it('falls back to the platform brand when from_name is blank, never to a literal', async () => {
    runtimeConfigValue = {
      provider_name: 'resend',
      config: { api_key: 'k', from_email: 'hello@platform.example' },
    };
    const { sendEmail } = await import('../../../server/services/email/index');
    await sendEmail(CONFIG, { workspaceId: 'ws-1', to: 'x@example.com', subject: 'S', html: '<p>b</p>' });
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.from).toBe('Brand From Branding <hello@platform.example>');
  });

  it('fails closed with a configuration error when from_email is missing', async () => {
    runtimeConfigValue = { provider_name: 'resend', config: { api_key: 'k' } };
    const { sendEmail } = await import('../../../server/services/email/index');
    const result = await sendEmail(CONFIG, {
      workspaceId: 'ws-1', to: 'x@example.com', subject: 'S', html: '<p>b</p>',
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/from_email/);
    expect(result.error).toMatch(/Super Admin/);
    // Nothing was sent. The old code invented `noreply@example.com` here and
    // handed it to Resend, which every receiver then rejected — a config
    // mistake that looked like a delivery problem.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never invents a sender address', () => {
    expect(read(SERVICE)).not.toMatch(/from:\s*['"]noreply@/);
    expect(stripTs(read(SERVICE))).not.toContain('noreply@example.com');
  });

  it('fails closed when the provider is configured without an API key', async () => {
    runtimeConfigValue = {
      provider_name: 'resend',
      config: { from_email: 'hello@platform.example', from_name: 'Platform Mail' },
    };
    const { sendEmail } = await import('../../../server/services/email/index');
    const result = await sendEmail(CONFIG, {
      workspaceId: 'ws-1', to: 'x@example.com', subject: 'S', html: '<p>b</p>',
    });
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/API key/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a workspace id does not change which provider is used', async () => {
    runtimeConfigValue = {
      provider_name: 'resend',
      config: { api_key: 'k', from_email: 'hello@platform.example', from_name: 'Platform Mail' },
    };
    const { sendEmail } = await import('../../../server/services/email/index');
    for (const workspaceId of ['ws-1', 'ws-2', 'ws-3']) {
      await sendEmail(CONFIG, { workspaceId, to: 'x@example.com', subject: 'S', html: '<p>b</p>' });
    }
    const froms = fetchMock.mock.calls.map((c) => JSON.parse(c[1].body).from);
    expect(new Set(froms).size).toBe(1);
    expect(froms[0]).toBe('Platform Mail <hello@platform.example>');
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Every sender goes through the one choke point.
// ───────────────────────────────────────────────────────────────────────────

describe('every send path uses the shared sender', () => {
  const SENDERS = [
    'server/services/auth-email.ts',
    'server/services/verification/service.ts',
    'server/services/invitations/worker.ts',
    'server/services/email/outbox.ts',
    'server/services/widget/offlineNotice.ts',
    'server/routes/email.ts',
  ];

  it('none of them resolves its own provider', () => {
    for (const file of SENDERS) {
      expect(existsSync(file), file).toBe(true);
      const body = stripTs(read(file));
      expect(body, `${file} resolves its own email provider`).not.toContain('default_email_provider');
      expect(body, `${file} reads a workspace provider`).not.toContain('workspace_provider_settings');
    }
  });

  it('they all call sendEmail or sendPlatformEmail (the outbox\'s two entry points send through sendEmail)', () => {
    for (const file of SENDERS) {
      const body = stripTs(read(file));
      expect(/sendEmail\(|sendPlatformEmail\(|sendEmailWithRetry\(|enqueueEmail\(/.test(body), file).toBe(true);
    }
    expect(stripTs(read('server/services/email/outbox.ts'))).toMatch(/await sendEmail\(config, request\)/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// No mail without a template (owner, 2026-10-30: «هیچ ایمیلی بدون قالب نباید
// باشه»). Every platform mail is a Super Admin template the Branding page
// shows; a caller's own text is only the fallback for a row that is missing,
// and wears the layout like the row would (index.ts composeMessage).
// ───────────────────────────────────────────────────────────────────────────

/** The last character of the string, template literal or comment that starts at `at`; `at` itself for anything else. */
function tokenEnd(src: string, at: number): number {
  const c = src[at];
  if (c === '/' && src[at + 1] === '/') {
    const nl = src.indexOf('\n', at);
    return nl < 0 ? src.length - 1 : nl;
  }
  if (c === '/' && src[at + 1] === '*') {
    const end = src.indexOf('*/', at + 2);
    return end < 0 ? src.length - 1 : end + 1;
  }
  if (c === '"' || c === "'") {
    let i = at + 1;
    for (; i < src.length && src[i] !== c && src[i] !== '\n'; i++) if (src[i] === '\\') i += 1;
    return Math.min(i, src.length - 1);
  }
  if (c === '`') {
    let i = at + 1;
    for (; i < src.length && src[i] !== '`'; i++) {
      if (src[i] === '\\') i += 1;
      else if (src[i] === '$' && src[i + 1] === '{') {
        const close = closing(src, i + 1);
        if (close < 0) return src.length - 1;
        i = close;
      }
    }
    return Math.min(i, src.length - 1);
  }
  return at;
}

/** Where the bracket opening at `at` closes, reading code as code (strings, template literals and comments skipped); -1 when it never does. */
function closing(src: string, at: number): number {
  let depth = 0;
  for (let i = at; i < src.length; i++) {
    const end = tokenEnd(src, i);
    if (end !== i) {
      i = end;
      continue;
    }
    if ('([{'.includes(src[i])) depth += 1;
    else if (')]}'.includes(src[i])) {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** The top-level parts of an argument list (or an object's members), split at its commas. */
function topLevelParts(list: string): string[] {
  const parts: string[] = [];
  let from = 0;
  for (let i = 0; i < list.length; i++) {
    const end = tokenEnd(list, i);
    if (end !== i) {
      i = end;
    } else if ('([{'.includes(list[i])) {
      i = closing(list, i);
      if (i < 0) break;
    } else if (list[i] === ',') {
      parts.push(list.slice(from, i));
      from = i + 1;
    }
  }
  parts.push(list.slice(from));
  return parts.map((p) => p.trim()).filter(Boolean);
}

const SEND_ENTRY = /\b(sendEmail|sendPlatformEmail|sendEmailWithRetry|enqueueEmail)\(/g;
const isCommentAt = (src: string, at: number) => /^\s*(\/\/|\/?\*)/.test(src.slice(src.lastIndexOf('\n', at) + 1, at));

/** Every call of the email core's four entry points in a source file: where it is, and the request it hands over. */
function sendCallsIn(src: string): Array<{ at: number; request: string }> {
  const calls: Array<{ at: number; request: string }> = [];
  for (const m of src.matchAll(SEND_ENTRY)) {
    const at = m.index ?? 0;
    if (/function\s*$/.test(src.slice(Math.max(0, at - 20), at)) || isCommentAt(src, at)) continue;
    const open = at + m[0].length - 1;
    const args = topLevelParts(src.slice(open + 1, closing(src, open)));
    calls.push({ at, request: args[1] ?? '' });
  }
  return calls;
}

/** The text that defines `name` as seen from `at`: the nearest declaration before it, or a function of that name anywhere. */
function definitionOf(src: string, name: string, at: number): { at: number; text: string } | null {
  const decls = [...src.matchAll(new RegExp(`\\b(?:const|let)\\s+${name}\\b[^=;]*=`, 'g'))].filter((m) => (m.index ?? 0) < at);
  const decl = decls[decls.length - 1];
  if (decl) {
    const start = (decl.index ?? 0) + decl[0].length;
    const rest = src.slice(start);
    const open = rest.search(/\S/);
    const end = '({['.includes(rest[open]) ? closing(rest, open) + 1 : rest.indexOf(';');
    return { at: start, text: rest.slice(0, end) };
  }
  const fn = new RegExp(`\\bfunction\\s+${name}\\s*\\(`).exec(src);
  if (!fn) return null;
  const params = closing(src, fn.index + fn[0].length - 1);
  const body = src.indexOf('{', params);
  return { at: body, text: src.slice(fn.index, closing(src, body) + 1) };
}

/** The function whose body holds `at`: its name, its parameters, and whether it is exported. */
function enclosingFunction(src: string, at: number): { name: string; params: string[]; exported: boolean } | null {
  const fns = [...src.matchAll(/\b(export\s+)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g)].reverse();
  for (const fn of fns) {
    const open = (fn.index ?? 0) + fn[0].length - 1;
    const close = closing(src, open);
    const body = src.indexOf('{', close);
    if (body < at && closing(src, body) > at) {
      return { name: fn[2], params: topLevelParts(src.slice(open + 1, close)).map((p) => p.split(/[:=]/)[0].trim()), exported: !!fn[1] };
    }
  }
  return null;
}

/**
 * Whether a request handed to the core names its template: a `templateSlug`
 * in it, or in what it is built from in the same file (a spread, a builder
 * function, a const, the test mail's builder), or, for a request a local
 * helper passed on, at every call of that helper.
 */
function namesTemplate(src: string, request: string, at: number, depth = 0): boolean {
  if (/\btemplateSlug\b/.test(request) || /\btestMailRequest\(/.test(request)) return true;
  if (depth > 4) return false;
  const names = new Set([...request.matchAll(/(?:\.\.\.\s*|^\s*|\b)([A-Za-z_$][\w$]*)\s*(?=\(|$|[,}\s])/g)].map((m) => m[1]));
  for (const name of names) {
    if (['await', 'async', 'config', 'new'].includes(name)) continue;
    const owner = enclosingFunction(src, at);
    const def = definitionOf(src, name, at);
    const declaredHere = def && owner && def.at > src.lastIndexOf(`function ${owner.name}`, at);
    if (def && (declaredHere || !owner?.params.includes(name)) && namesTemplate(src, def.text, def.at, depth + 1)) return true;
    // A parameter: what each call of the (file-local) helper passes for it.
    if (owner && !owner.exported && owner.params.includes(name) && !declaredHere) {
      const index = owner.params.indexOf(name);
      const callers = [...src.matchAll(new RegExp(`(?<!function\\s)\\b${owner.name}\\(`, 'g'))]
        .map((m) => ({ at: m.index ?? 0, args: topLevelParts(src.slice((m.index ?? 0) + owner.name.length + 1, closing(src, (m.index ?? 0) + owner.name.length))) }));
      if (callers.length && callers.every((c) => namesTemplate(src, c.args[index] ?? '', c.at, depth + 1))) return true;
    }
  }
  return false;
}

describe('no mail without a template', () => {
  /**
   * Every file that hands a mail to the email core, how many times, and the
   * templates it names (in the file itself, or in `namedIn`). A new send
   * path, or one more send in these files, fails here until it is listed,
   * and it can only be listed with a template whose rows exist in fa, en and
   * tr for both editions (291 rewrote every sent one; a later migration adds
   * a new one). The outbox only re-sends what was queued, as it was queued:
   * each queued request is checked where it is queued.
   */
  const SEND_PATHS: Record<string, { calls: number; slugs: string[]; namedIn?: string; resendsQueued?: true }> = {
    'server/services/auth-email.ts': { calls: 1, slugs: ['email_verify', 'password_reset'] },
    'server/services/verification/service.ts': { calls: 2, slugs: ['verification_code'] },
    'server/services/invitations/worker.ts': { calls: 2, slugs: ['invite_otp', 'invite_member'] },
    'server/routes/adminEmailProviders.ts': { calls: 1, slugs: ['email_test'], namedIn: 'server/services/email/testMail.ts' },
    'server/routes/email.ts': { calls: 1, slugs: ['email_test'], namedIn: 'server/services/email/testMail.ts' },
    'server/services/visitorTranscript.ts': { calls: 1, slugs: ['visitor_conversation_transcript'] },
    'server/services/widget/offlineNotice.ts': { calls: 3, slugs: ['offline_message_received', 'offline_messages_summary'] },
    'server/services/notificationEmail/dispatcher.ts': {
      calls: 1,
      slugs: ['operator_unread_digest', 'operator_conversation_transcript', 'operator_invoice_paid', 'operator_weekly_summary', 'operator_product_update'],
      namedIn: 'server/services/notificationEmail/types.ts',
    },
    'server/services/billing/account/notify.ts': {
      calls: 2,
      slugs: [
        'billing_renewal_reminder', 'billing_renewed', 'billing_expired', 'billing_plan_changed', 'billing_change_scheduled',
        'billing_payment_receipt', 'billing_plan_activated', 'billing_trial_ending', 'billing_trial_ended', 'billing_card_renewed',
        'billing_card_payment_failed', 'billing_card_removed', 'billing_locked_data_deletion', 'billing_ai_pack_purchased',
      ],
    },
    'server/services/email/outbox.ts': { calls: 2, slugs: [], resendsQueued: true },
  };

  const ROOTS = ['server', 'worker', 'channels', 'shared', 'runtime', 'ai-runtime', 'scripts'];
  const sourceFiles = (dir: string): string[] =>
    !existsSync(dir) ? [] : readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
      const path = join(dir, e.name);
      if (e.isDirectory()) return ['node_modules', 'dist'].includes(e.name) ? [] : sourceFiles(path);
      return /\.(ts|mts)$/.test(e.name) && !/\.(test|spec)\.|\.d\.ts$/.test(e.name) ? [path] : [];
    });

  it('the reading of a send call finds a request that names no template (the check can fail)', () => {
    const src = [
      'function own(config) {',
      "  const request = { to: 'a@b.example', subject: 'S', html: `<p>${x}</p>` };",
      '  return sendEmail(config, request);',
      '}',
      'async function named(config, request) { await enqueueEmail(config, request, {}); }',
      "named(config, { templateSlug: 'billing_renewed', to });",
      "named(config, { to, subject: 'bare' });",
    ].join('\n');
    const [bare, passedOn] = sendCallsIn(src);
    expect(namesTemplate(src, bare.request, bare.at)).toBe(false);
    // Strings and comments with commas, quotes or brackets in them do not split or end an argument.
    const tricky = "sendEmail(config /* the platform's (default) */, { subject: 'a, b', html: `<p>${f('x)')}</p>`, templateSlug: 'email_test' });";
    expect(sendCallsIn(tricky).map((c) => namesTemplate(tricky, c.request, c.at))).toEqual([true]);
    // One caller of the helper names a template and one does not: not every mail has one.
    expect(namesTemplate(src, passedOn.request, passedOn.at)).toBe(false);
    expect(namesTemplate(src.replace("{ to, subject: 'bare' }", "{ to, templateSlug: 'billing_expired' }"), passedOn.request, passedOn.at)).toBe(true);
  });

  it('every file that sends is listed, with each of its sends', () => {
    const found: Record<string, number> = {};
    for (const file of ROOTS.flatMap(sourceFiles)) {
      if (file === SERVICE) continue;
      const count = sendCallsIn(read(file)).length;
      if (count) found[file] = count;
    }
    expect(found, 'a new send path: give it a templateSlug and list it in SEND_PATHS').toEqual(
      Object.fromEntries(Object.entries(SEND_PATHS).map(([file, p]) => [file, p.calls])),
    );
  });

  it.each(Object.entries(SEND_PATHS).filter(([, p]) => !p.resendsQueued))('%s: every send names its template', (file, path) => {
    const src = read(file);
    for (const call of sendCallsIn(src)) {
      const line = src.slice(0, call.at).split('\n').length;
      expect(namesTemplate(src, call.request, call.at), `${file}:${line} sends ${call.request.slice(0, 80)} without a templateSlug`).toBe(true);
    }
    const names = read(path.namedIn ?? file);
    for (const slug of path.slugs) expect(names, `${file} names ${slug}`).toContain(`'${slug}'`);
  });

  it('the outbox sends only what was queued, as it was queued', () => {
    const src = read('server/services/email/outbox.ts');
    expect(sendCallsIn(src).map((c) => c.request)).toEqual(['request', 'request']);
    // The queued payload, opened (processRow), or the caller's own request, tried once first (sendEmailWithRetry).
    expect(src).toMatch(/const request = openRequest\(config, row\.payload\);/);
    expect(src).toMatch(/export async function sendEmailWithRetry\(\s*config: ServerConfig,\s*request: EmailRequest,/);
  });

  it('the notices and the billing mails send exactly the slugs listed', () => {
    const types = read('server/services/notificationEmail/types.ts');
    expect([...types.matchAll(/\bslug: '([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      [...SEND_PATHS['server/services/notificationEmail/dispatcher.ts'].slugs].sort(),
    );
    const notify = read('server/services/billing/account/notify.ts');
    const union = /export type BillingEmailSlug =([^;]*);/.exec(notify)?.[1] ?? '';
    expect([...union.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort()).toEqual(
      [...SEND_PATHS['server/services/billing/account/notify.ts'].slugs].sort(),
    );
    expect(read('server/services/email/testMail.ts')).toMatch(/templateSlug: 'email_test',/);
  });

  it('every template a sender names has its rows in fa, en and tr, for both editions', () => {
    // 291 writes each sent slug's row per language, and adds it for whichever edition lacks it.
    const sql = read('database/migrations/291_email_templates_redesign.sql');
    expect(sql).toMatch(/CROSS JOIN \(VALUES \('iran'\), \('international'\)\) AS e\(edition\)/);
    const rows = new Set([...sql.matchAll(/\('([a-z_]+)', '(fa|en|tr)', '[0-9a-f]{32}',/g)].map((m) => `${m[1]}/${m[2]}`));
    for (const slug of new Set(Object.values(SEND_PATHS).flatMap((p) => p.slugs))) {
      for (const locale of ['fa', 'en', 'tr']) expect(rows.has(`${slug}/${locale}`), `${slug} (${locale})`).toBe(true);
    }
  });

  it('only the core hands a mail to a provider\'s adapter, once the layout is on it', () => {
    for (const file of ROOTS.flatMap(sourceFiles)) {
      if (file.startsWith('server/services/email/providers/')) continue;
      const body = stripTs(read(file));
      if (!/\bgetEmailAdapter\(/.test(body)) continue;
      expect([SERVICE, STORE], `${file} reaches an email adapter`).toContain(file);
    }
    // The store only checks the connection; it never sends.
    expect(stripTs(read(STORE))).not.toMatch(/adapter\.send\(/);
    const service = stripTs(read(SERVICE));
    expect(service.match(/\badapter\.send\(/g)).toHaveLength(1);
    expect(service.indexOf('adapter.send(')).toBeGreaterThan(service.indexOf('await composeMessage(config, ready,'));
    // The adapters themselves are reached through the registry alone (the
    // Yahoo mailbox client borrows the relay's timeouts, not its adapter).
    for (const file of ROOTS.flatMap(sourceFiles)) {
      if (file.startsWith('server/services/email/providers/')) continue;
      expect(stripTs(read(file)), file).not.toMatch(/\b(smtpAdapter|resendAdapter|sendgridAdapter)\b/);
    }
  });
});

// ───────────────────────────────────────────────────────────────────────────
// The From header cannot be supplied by a caller, at any layer.
// ───────────────────────────────────────────────────────────────────────────

describe('a caller cannot set the sender identity', () => {
  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'm' }), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    delete process.env.RESEND_API_KEY;
    runtimeConfigValue = {
      provider_name: 'resend',
      config: { api_key: 'platform_key', from_email: 'platform@example.com', from_name: 'Platform Mail' },
    };
  });
  afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

  it('ignores a `from` smuggled past the type system', async () => {
    const { sendEmail } = await import('../../../server/services/email/index');
    // The type forbids this; a JSON body reaching an older route would not.
    const smuggled = {
      workspaceId: 'ws-1', to: 'victim@example.com', subject: 'S', html: '<p>b</p>',
      from: 'Support <spoofed@attacker.example>',
      replyTo: 'spoofed@attacker.example',
    } as unknown as Parameters<typeof sendEmail>[1];

    const result = await sendEmail(CONFIG, smuggled);
    expect(result.success).toBe(true);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.from).toBe('Platform Mail <platform@example.com>');
    expect(body.from).not.toContain('attacker.example');
    expect(JSON.stringify(body)).not.toContain('spoofed@attacker.example');
  });

  it('the same holds for the workspace-less platform sender', async () => {
    const { sendPlatformEmail } = await import('../../../server/services/email/index');
    const smuggled = {
      to: 'victim@example.com', subject: 'S', html: '<p>b</p>',
      from: 'spoofed@attacker.example',
    } as unknown as Parameters<typeof sendPlatformEmail>[1];

    await sendPlatformEmail(CONFIG, smuggled);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.from).toBe('Platform Mail <platform@example.com>');
  });

  it('resolves the From unconditionally, with no caller-supplied branch', () => {
    const code = stripTs(read(SERVICE));
    // `let fromAddr = request.from || ''` was the bypass: a value on the
    // request short-circuited the resolver entirely.
    expect(code).not.toMatch(/request\.from/);
    expect(code).not.toMatch(/if \(!fromAddr/);
    // Reply-To is the provider's too (its `reply_to`), never the request's.
    expect(code).not.toMatch(/request\.replyTo|input\.replyTo/);
    expect(code).toMatch(/const replyTo = parseEmailAddress\(effective\.config\.reply_to\)/);
  });

  it('neither request type still offers the escape hatch', () => {
    const code = read(SERVICE);
    for (const name of ['EmailRequest', 'PlatformEmailRequest']) {
      const block = code.slice(code.indexOf(`export interface ${name} {`));
      const body = block.slice(0, block.indexOf('}'));
      expect(body, `${name} still has from`).not.toMatch(/^\s*from\?:/m);
      expect(body, `${name} still has replyTo`).not.toMatch(/^\s*replyTo\?:/m);
    }
  });

  it('no email route sends what a caller composes: /send and /send-channel are retired', () => {
    const route = stripTs(read('server/routes/email.ts'));
    expect(route).toMatch(/emailRouter\.post\('\/send', retired\)/);
    expect(route).toMatch(/emailRouter\.post\('\/send-channel', retired\)/);
    // What is left (the test buttons) takes a workspace and a language, and
    // mails the caller's own verified address: no recipient, subject, body,
    // template or sender off the body.
    expect(route).not.toMatch(/req\.body\??\.(to|subject|html|text|templateSlug|templateData|from|replyTo)\b/);
    expect(route).toMatch(/const testSchema = z\.object\(\{\s*workspaceId: z\.string\(\)\.uuid\(\),\s*locale: z\.enum\(\['en', 'fa', 'tr'\]\)\.optional\(\),\s*\}\)\.strict\(\)/);
    expect(existsSync('server/services/email/sendChannelEmail.ts')).toBe(false);
  });

  it('the browser cannot even express it, and sends no mail of its own', () => {
    const types = read('src/types/providers.ts');
    const block = types.slice(types.indexOf('export interface EmailMessage {'));
    const body = block.slice(0, block.indexOf('}'));
    expect(body).not.toMatch(/\bfrom\?:/);
    expect(body).not.toMatch(/\breplyTo\?:/);
    // Its own sender, which posted any recipient and body to send-channel, is gone.
    expect(existsSync('src/providers/email/api.ts')).toBe(false);
    const callers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || full.includes('/test')) continue;
          walk(full);
        } else if (/\.(ts|tsx)$/.test(entry.name) && /\/api\/email\/send/.test(stripTs(read(full)))) {
          callers.push(full);
        }
      }
    };
    walk('src');
    expect(callers).toEqual([]);
  });

  it('every adapter carries the provider\'s Reply-To, and nothing else sets one', () => {
    // It was once accepted from callers, typed and threaded all the way down,
    // then dropped. Now it comes from the provider config alone (`reply_to`,
    // read once by the service) and every adapter puts it on the wire.
    for (const file of ['resend.ts', 'sendgrid.ts', 'smtp.ts']) {
      const body = stripTs(read(join('server/services/email/providers', file)));
      expect(body, file).toMatch(/message\.replyTo/);
      expect(body, file).not.toMatch(/config\.reply_to|cfg\.reply_to/);
    }
  });

  it('a Reply-To smuggled onto the request never reaches the provider', async () => {
    const { sendEmail } = await import('../../../server/services/email/index');
    const smuggled = {
      workspaceId: 'ws-1', to: 'victim@example.com', subject: 'S', html: '<p>b</p>',
      replyTo: 'spoofed@attacker.example',
    } as unknown as Parameters<typeof sendEmail>[1];
    await sendEmail(CONFIG, smuggled);
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.reply_to).toBeUndefined();

    runtimeConfigValue = {
      provider_name: 'resend',
      config: { api_key: 'platform_key', from_email: 'platform@example.com', from_name: 'Platform Mail', reply_to: 'support@example.com' },
    };
    await sendEmail(CONFIG, smuggled);
    expect(JSON.parse(fetchMock.mock.calls[1][1].body).reply_to).toEqual(['support@example.com']);
  });
});
