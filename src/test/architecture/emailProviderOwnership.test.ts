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

// ───────────────────────────────────────────────────────────────────────────
// 2 + 3. The provider is resolved from the platform config and nowhere else.
// ───────────────────────────────────────────────────────────────────────────

describe('the email provider resolves from platform config only', () => {
  const code = stripTs(read(SERVICE));

  it('reads app_runtime_config.default_email_provider', () => {
    expect(code).toContain('default_email_provider');
    expect(code).toContain("from('app_runtime_config')");
  });

  it('never consults a workspace-scoped provider table', () => {
    expect(code).not.toContain('workspace_provider_settings');
    expect(code).not.toContain('provider_configs');
  });

  it('the resolver does not even take a workspace id', () => {
    // The strongest form of "no workspace override": the function cannot
    // express one. If this signature grows a workspace argument back, the
    // override is one line away again.
    expect(code).toMatch(/async function resolveProviderConfig\(\s*supabase: \w+,?\s*\)/);
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
  const section = page.slice(page.indexOf('function EmailSettingsSection'));
  const admin = read('server/routes/adminManagement.ts');

  /**
   * Every field that used to sit in Super Admin → Branding → Email Settings
   * and was read by nothing. Six of the seven.
   */
  const DEAD = [
    'sender_email',        // From identity lives on the email provider
    'sender_name',         // same
    'email_logo_url',      // no template has an <img> tag
    'email_footer_text',   // no template has a footer placeholder
    'footer_text',         // localized copy of the above
    'support_contact_label',
  ];

  it('the section renders none of them', () => {
    for (const field of DEAD) {
      expect(stripTs(section), `${field} still rendered`).not.toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it('the admin API accepts none of them', () => {
    const schema = admin.slice(admin.indexOf('const emailSettingsSchema'));
    const body = schema.slice(0, schema.indexOf('});'));
    for (const field of DEAD) {
      expect(body, `${field} still accepted`).not.toMatch(new RegExp(`\\b${field}:`));
    }
  });

  it('the localized email-settings routes are gone', () => {
    // The table has no runtime consumer at all, so the routes only ever wrote
    // a row nobody would read.
    expect(stripTs(admin)).not.toContain("'/email-settings-localized'");
    expect(stripTs(read('src/pages/admin/BrandingPage.tsx'))).not.toContain('email-settings-localized');
  });

  it('keeps reply_to_email, which has a real consumer', () => {
    expect(section).toContain('reply_to_email');
    const schema = admin.slice(admin.indexOf('const emailSettingsSchema'));
    expect(schema.slice(0, schema.indexOf('});'))).toContain('reply_to_email');
    // widget.ts sends an offline visitor message here when no operator has an
    // address — a recipient, not a sender.
    expect(read('server/routes/widget.ts')).toContain('reply_to_email');
  });

  it('labels it as a recipient, not as the From address', () => {
    const en = read('src/i18n/locales/en.ts');
    const block = en.slice(en.indexOf('emailSettings: {'));
    const hint = block.slice(0, block.indexOf('}'));
    expect(hint).toContain('replyToEmailHint');
    expect(hint).toMatch(/NOT the From address/i);
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
    'server/services/billing/notifications/dispatcher.ts',
    'server/services/email/sendChannelEmail.ts',
    'server/routes/widget.ts',
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

  it('they all call sendEmail or sendPlatformEmail', () => {
    for (const file of SENDERS) {
      const body = stripTs(read(file));
      expect(/sendEmail\(|sendPlatformEmail\(/.test(body), file).toBe(true);
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
    expect(code).not.toMatch(/\breplyTo\b/);
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

  it('the send-channel route rejects the fields instead of dropping them', () => {
    const route = read('server/routes/email.ts');
    expect(route).toContain('.strict()');
    expect(route).toContain('UNSUPPORTED_FIELDS');
    // and no longer reads them off the body
    expect(stripTs(route)).not.toMatch(/\bfrom\b\s*,|\breplyTo\b/);
  });

  it('the browser cannot even express it', () => {
    const types = read('src/types/providers.ts');
    const block = types.slice(types.indexOf('export interface EmailMessage {'));
    const body = block.slice(0, block.indexOf('}'));
    expect(body).not.toMatch(/\bfrom\?:/);
    expect(body).not.toMatch(/\breplyTo\?:/);
    expect(stripTs(read('src/providers/email/api.ts'))).not.toMatch(/from: message\.from|replyTo: message\.replyTo/);
  });

  it('replyTo reaches no provider, which is why it is gone', () => {
    // It was accepted, typed and threaded all the way down, then dropped.
    for (const file of readdirSync('server/services/email/providers')) {
      if (!file.endsWith('.ts')) continue;
      const body = stripTs(read(join('server/services/email/providers', file)));
      expect(body, file).not.toMatch(/reply_to|replyTo/);
    }
  });
});
