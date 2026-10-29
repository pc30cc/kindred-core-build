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

  it('no email template can express a logo or a footer, which is why they went', () => {
    // The evidence for removing them rather than wiring them up: `{brand}` is
    // the only branding hook the renderer provides, and the code-side wrapper
    // has no slot for anything else.
    const service = read(SERVICE);
    expect(service).toContain('brand: await resolveBrandName');
    expect(service).not.toMatch(/\blogo\b/i);
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
