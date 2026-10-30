// @vitest-environment node
/**
 * The email provider config store (server/services/email/providerConfigStore.ts):
 *
 *   - today's production rows (every key, the relay password included, in
 *     plain text under "config") read exactly as before, so nothing breaks
 *     on deploy;
 *   - the Super Admin's read never carries a secret's value, encrypted or
 *     not, under its current name or an older one;
 *   - a write keeps a blank secret, encrypts what it stores (and an older
 *     row's plain one when it is next written), refuses a new secret without
 *     PLUGIN_SECRETS_MASTER_KEY, never carries a secret across providers,
 *     refuses a provider without an adapter, an unknown field and a config
 *     that cannot send, and `disabled` removes the row;
 *   - every change leaves an audit row naming fields, never values;
 *   - verifyEmailProvider goes through the registry.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  runtime: {} as Record<string, unknown>,
  audit: [] as Row[],
  readError: null as string | null,
}));

// The store reads and writes through the server's own client.
vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        maybeSingle: async () => {
          if (db.readError) return { data: null, error: { message: db.readError } };
          const value = db.runtime[filters.key as string];
          return { data: value === undefined ? null : { value: structuredClone(value) }, error: null };
        },
        upsert: async (row: { key: string; value: unknown }) => {
          db.runtime[row.key] = structuredClone(row.value);
          return { data: null, error: null };
        },
        delete: () => ({
          eq: async (_column: string, key: string) => {
            delete db.runtime[key];
            return { data: null, error: null };
          },
        }),
        insert: async (row: Row) => {
          if (table === 'audit_logs') db.audit.push(row);
          return { data: null, error: null };
        },
      };
      return builder;
    },
  }),
}));

const MASTER = 'a'.repeat(64);
const store = await import('../../../server/services/email/providerConfigStore.js');
/** `null`: no PLUGIN_SECRETS_MASTER_KEY on this server. */
const cfg = (masterKey: string | null = MASTER) =>
  ({ supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', pluginSecretsMasterKey: masterKey ?? undefined, complianceAuditLoggingEnabled: true }) as never;
const ACTOR = { userId: '00000000-0000-4000-8000-000000000001' };

/** default_email_provider on both brands since 2026-10-29 15:11 UTC. */
const PRODUCTION = {
  provider_name: 'smtp',
  config: {
    smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.ai', smtp_pass: 'relay-secret-1',
    from_email: 'noreply@webyar.ai', from_name: 'Webyar',
  },
};

beforeEach(() => {
  db.runtime = { default_email_provider: structuredClone(PRODUCTION) };
  db.audit = [];
  db.readError = null;
  delete process.env.SMTP_PASS;
  delete process.env.RESEND_API_KEY;
});
afterEach(() => vi.restoreAllMocks());

describe('reading', () => {
  it('today\'s production row reads unchanged', async () => {
    expect(await store.readEmailProviderConfig(cfg(), 'default_email_provider')).toEqual({
      provider_name: 'smtp', config: PRODUCTION.config,
    });
    // and without the master key too: nothing in it is encrypted
    expect(await store.readEmailProviderConfig(cfg(null), 'default_email_provider')).toEqual({
      provider_name: 'smtp', config: PRODUCTION.config,
    });
  });

  it('none, disabled and an unreadable setting are told apart', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await store.loadEmailProviderConfig(cfg(), 'notification_email_provider')).toEqual({ status: 'none' });
    db.runtime.notification_email_provider = { provider_name: 'disabled' };
    expect(await store.loadEmailProviderConfig(cfg(), 'notification_email_provider')).toEqual({ status: 'none' });
    db.readError = 'boom';
    expect(await store.loadEmailProviderConfig(cfg(), 'default_email_provider')).toMatchObject({ status: 'error' });
    expect(await store.readEmailProviderConfig(cfg(), 'default_email_provider')).toBeNull();
  });

  it('the Super Admin\'s read carries no secret, only which are set', async () => {
    const admin = await store.readEmailProviderForAdmin(cfg(), 'default_email_provider');
    expect(admin).toEqual({
      provider_name: 'smtp',
      config: { smtp_host: 'mail-relay', smtp_port: '587', smtp_user: 'noreply@webyar.ai', from_email: 'noreply@webyar.ai', from_name: 'Webyar' },
      secretKeysSet: ['smtp_pass'],
    });
    expect(JSON.stringify(admin)).not.toContain('relay-secret-1');
  });

  it('older names and other vendors\' secrets stay hidden too', async () => {
    db.runtime.default_email_provider = {
      provider_name: 'smtp', config: { smtp_host: 'h', smtp_password: 'old-pass', from_email: 'a@b.example', smtp_secure: 'true' },
    };
    const smtp = await store.readEmailProviderForAdmin(cfg(), 'default_email_provider');
    expect(smtp.secretKeysSet).toEqual(['smtp_pass']);
    expect(smtp.config).toEqual({ smtp_host: 'h', from_email: 'a@b.example', encryption: 'starttls' });
    db.runtime.default_email_provider = { provider_name: 'postmark', config: { server_token: 'pm-secret', from_email: 'a@b.example' } };
    const pm = await store.readEmailProviderForAdmin(cfg(), 'default_email_provider');
    expect(JSON.stringify(pm)).not.toContain('pm-secret');
    expect(pm.secretKeysSet).toEqual(['server_token']);
  });
});

describe('writing', () => {
  const write = (provider: string, config: Row, master: string | null = MASTER, key: 'default_email_provider' | 'notification_email_provider' = 'default_email_provider') =>
    store.writeEmailProviderConfig(cfg(master), key, { provider_name: provider, config }, ACTOR);
  const stored = () => db.runtime.default_email_provider as { provider_name: string; config: Row; secrets?: Row };

  it('a blank password keeps the stored one, which is encrypted now; the row still sends the same', async () => {
    const { smtp_pass: _pass, ...rest } = PRODUCTION.config;
    expect(await write('smtp', { ...rest, smtp_pass: '' })).toEqual({ ok: true });
    expect(JSON.stringify(stored())).not.toContain('relay-secret-1');
    expect(stored().config).not.toHaveProperty('smtp_pass');
    expect(stored().secrets?.smtp_pass).toMatchObject({ algorithm: 'aes-256-gcm' });
    expect(stored().secrets?.smtp_pass).not.toHaveProperty('fingerprint');
    expect(await store.readEmailProviderConfig(cfg(), 'default_email_provider')).toEqual({ provider_name: 'smtp', config: PRODUCTION.config });
    // nothing changed but where the password lives, so the audit names no field
    expect(db.audit).toHaveLength(1);
    expect(db.audit[0]).toMatchObject({
      action: 'admin.email_provider.changed', user_id: ACTOR.userId, workspace_id: null,
      new_value: { key: 'default_email_provider', provider_name: 'smtp', changed_fields: [] },
    });
  });

  it('a new password is encrypted, and the audit names the field, never the value', async () => {
    expect(await write('smtp', { ...PRODUCTION.config, smtp_pass: 'brand-new-pass', from_name: 'WebYar' })).toEqual({ ok: true });
    expect(JSON.stringify(stored())).not.toContain('brand-new-pass');
    expect((await store.readEmailProviderConfig(cfg(), 'default_email_provider'))?.config.smtp_pass).toBe('brand-new-pass');
    expect(db.audit[0].new_value).toEqual({ key: 'default_email_provider', provider_name: 'smtp', changed_fields: ['from_name', 'smtp_pass'] });
    expect(JSON.stringify(db.audit)).not.toContain('brand-new-pass');
    expect(JSON.stringify(db.audit)).not.toContain('relay-secret-1');
  });

  it('a new secret is refused without the master key; a kept one is left as it was', async () => {
    expect(await write('smtp', { ...PRODUCTION.config, smtp_pass: 'other' }, null)).toEqual({ ok: false, error: 'encryption_unavailable', field: 'smtp_pass' });
    expect(stored()).toEqual(PRODUCTION);
    expect(await write('smtp', { ...PRODUCTION.config, smtp_pass: '', from_name: 'X' }, null)).toEqual({ ok: true });
    expect(stored().secrets?.smtp_pass).toBe('relay-secret-1');
    expect((await store.readEmailProviderConfig(cfg(null), 'default_email_provider'))?.config.smtp_pass).toBe('relay-secret-1');
  });

  it('a secret that cannot be decrypted reads as missing, and the console names only the field', async () => {
    await write('smtp', { ...PRODUCTION.config });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const read = await store.readEmailProviderConfig(cfg('b'.repeat(64)), 'default_email_provider');
    expect(read?.config).not.toHaveProperty('smtp_pass');
    expect(warn.mock.calls.join(' ')).toContain('smtp_pass');
    expect(warn.mock.calls.join(' ')).not.toContain('relay-secret-1');
  });

  it.each([
    ['host', { smtp_host: 'attacker.example', encryption: 'none' }],
    ['port', { smtp_port: '2525' }],
    ['user', { smtp_user: 'other@webyar.ai' }],
  ])('a stored password does not follow a new %s: it must be typed again', async (_what, change) => {
    const { smtp_pass: _pass, ...rest } = PRODUCTION.config;
    expect(await write('smtp', { ...rest, ...change })).toEqual({ ok: false, error: 'missing_field', field: 'smtp_pass' });
    expect(stored()).toEqual(PRODUCTION);
    expect(db.audit).toEqual([]);
    // Typed again, it is stored for the new destination.
    expect(await write('smtp', { ...rest, ...change, smtp_pass: 'typed-again' })).toEqual({ ok: true });
    expect((await store.readEmailProviderConfig(cfg(), 'default_email_provider'))?.config.smtp_pass).toBe('typed-again');
    expect(db.audit[0].new_value).toMatchObject({ changed_fields: expect.arrayContaining(['smtp_pass']) });
  });

  it('a destination without a sign-in drops the stored password; the same one in other words keeps it', async () => {
    const { smtp_pass: _pass, smtp_user: _user, ...rest } = PRODUCTION.config;
    expect(await write('smtp', { ...rest, smtp_host: 'other-relay' })).toEqual({ ok: true });
    expect(stored().secrets).toBeUndefined();
    expect(db.audit[0].new_value).toMatchObject({ changed_fields: ['smtp_host', 'smtp_pass', 'smtp_user'] });

    db.runtime.default_email_provider = structuredClone(PRODUCTION);
    const { smtp_pass: _p, smtp_port: _port, ...samePlace } = PRODUCTION.config;
    // A host's case does not matter, and a blank port is 587.
    expect(await write('smtp', { ...samePlace, smtp_host: 'Mail-Relay' })).toEqual({ ok: true });
    expect((await store.readEmailProviderConfig(cfg(), 'default_email_provider'))?.config.smtp_pass).toBe('relay-secret-1');
  });

  it('SMTP_PASS fills a blank password only for SMTP_HOST\'s own relay', async () => {
    process.env.SMTP_HOST = 'mail-relay';
    process.env.SMTP_PASS = 'env-relay-pass';
    try {
      db.runtime = {};
      const base = { smtp_user: 'noreply@webyar.ai', from_email: 'noreply@webyar.ai' };
      expect(await write('smtp', { ...base, smtp_host: 'attacker.example' })).toEqual({ ok: false, error: 'missing_field', field: 'smtp_pass' });
      expect(await write('smtp', { ...base, smtp_host: 'mail-relay' })).toEqual({ ok: true });
      expect(await write('smtp', base)).toEqual({ ok: true });
    } finally {
      delete process.env.SMTP_HOST;
    }
  });

  it('a CA certificate (PEM) is an ordinary field, longer than the others; anything else is refused', async () => {
    const body = 'A'.repeat(3000);
    const pem = `-----BEGIN CERTIFICATE-----\n${body.match(/.{1,64}/g)!.join('\n')}\n-----END CERTIFICATE-----`;
    expect(await write('smtp', { ...PRODUCTION.config, encryption: 'starttls', tls_servername: 'mail-relay', tls_ca: pem })).toEqual({ ok: true });
    expect(stored().config.tls_ca).toBe(pem);
    expect((await store.readEmailProviderForAdmin(cfg(), 'default_email_provider')).config.tls_ca).toBe(pem);
    expect(db.audit[0].new_value).toMatchObject({ changed_fields: ['encryption', 'tls_ca', 'tls_servername'] });
    for (const bad of [
      'not a certificate',
      `-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n-----END PRIVATE KEY-----`,
      `${pem}\n-----BEGIN PRIVATE KEY-----\n${'A'.repeat(64)}\n-----END PRIVATE KEY-----`,
      `-----BEGIN CERTIFICATE-----\n${'A'.repeat(33 * 1024)}\n-----END CERTIFICATE-----`,
    ]) {
      expect(await write('smtp', { ...PRODUCTION.config, tls_ca: bad })).toEqual({ ok: false, error: 'invalid_field', field: 'tls_ca' });
    }
  });

  it('a secret never crosses to another provider', async () => {
    db.runtime.default_email_provider = { provider_name: 'resend', config: { api_key: 're_old', from_email: 'a@b.example' } };
    expect(await write('sendgrid', { api_key: '', from_email: 'a@b.example' })).toEqual({ ok: false, error: 'missing_field', field: 'api_key' });
    expect(await write('sendgrid', { api_key: 'SG.new', from_email: 'a@b.example' })).toEqual({ ok: true });
    expect(db.audit.at(-1)?.new_value).toMatchObject({ provider_name: 'sendgrid', changed_fields: ['api_key', 'from_email', 'provider_name'] });
  });

  it('an environment variable may fill a required secret left blank', async () => {
    db.runtime = {};
    process.env.RESEND_API_KEY = 're_env';
    expect(await write('resend', { from_email: 'a@b.example' })).toEqual({ ok: true });
    expect(stored().secrets).toBeUndefined();
  });

  it.each([
    ['mailgun', { api_key: 'k', from_email: 'a@b.example' }, { error: 'unknown_provider', field: 'provider_name' }],
    ['smtp', { smtp_host: 'h', from_email: 'a@b.example', smtp_secret_sauce: 'x' }, { error: 'unknown_field', field: 'smtp_secret_sauce' }],
    ['smtp', { smtp_host: 'h' }, { error: 'missing_field', field: 'from_email' }],
    ['smtp', { smtp_host: 'h', from_email: 'a@b.example, c@d.example' }, { error: 'invalid_field', field: 'from_email' }],
    ['smtp', { smtp_host: 'h', from_email: 'a@b.example', smtp_port: '70000' }, { error: 'invalid_field', field: 'smtp_port' }],
    ['smtp', { smtp_host: 'h', from_email: 'a@b.example', encryption: 'maybe' }, { error: 'invalid_field', field: 'encryption' }],
    ['smtp', { smtp_host: 'smtp://h', from_email: 'a@b.example' }, { error: 'invalid_field', field: 'smtp_host' }],
    ['smtp', { smtp_host: 'h', from_email: 'a@b.example', reply_to: 'nope' }, { error: 'invalid_field', field: 'reply_to' }],
    ['smtp', { smtp_host: 'h', from_email: 'a@b.example', smtp_user: 'u' }, { error: 'missing_field', field: 'smtp_pass' }],
    ['smtp', { smtp_host: 'h', from_email: 'a@b.example', smtp_port: true }, { error: 'invalid_field', field: 'smtp_port' }],
  ])('%s %j is refused: %j', async (provider, config, expected) => {
    db.runtime = {};
    expect(await write(provider, config)).toEqual({ ok: false, ...expected });
    expect(db.runtime).toEqual({});
    expect(db.audit).toEqual([]);
  });

  it('the old form\'s TLS switch is stored as the mode it meant', async () => {
    expect(await write('smtp', { ...PRODUCTION.config, smtp_secure: 'true' })).toEqual({ ok: true });
    expect(stored().config).toMatchObject({ encryption: 'starttls' });
    expect(stored().config).not.toHaveProperty('smtp_secure');
  });

  it('disabled removes the row', async () => {
    expect(await write('disabled', {})).toEqual({ ok: true });
    expect(db.runtime).toEqual({});
    expect(db.audit[0].new_value).toMatchObject({ provider_name: 'disabled', changed_fields: ['provider_name'] });
  });

  it('only the two provider keys can be written', async () => {
    const result = await store.writeEmailProviderConfig(cfg(), 'default_storage_provider' as never, { provider_name: 'smtp', config: {} }, ACTOR);
    expect(result).toEqual({ ok: false, error: 'unknown_key' });
  });
});

describe('verifyEmailProvider', () => {
  it('names what is missing before trying anything', async () => {
    expect(await store.verifyEmailProvider(cfg(), 'notification_email_provider')).toEqual({ ok: false, detail: 'unconfigured: no email provider is set' });
    db.runtime.default_email_provider = { provider_name: 'resend', config: { from_email: 'a@b.example' } };
    expect((await store.verifyEmailProvider(cfg(), 'default_email_provider')).detail).toMatch(/^unconfigured: .*api_key/);
    db.runtime.default_email_provider = { provider_name: 'ses', config: { from_email: 'a@b.example' } };
    expect((await store.verifyEmailProvider(cfg(), 'default_email_provider')).detail).toMatch(/no adapter/);
  });

  it('calls the adapter\'s authenticated read with the decrypted key', async () => {
    db.runtime.default_email_provider = { provider_name: 'resend', config: { from_email: 'noreply@webyar.ai' } };
    await store.writeEmailProviderConfig(cfg(), 'default_email_provider', { provider_name: 'resend', config: { from_email: 'noreply@webyar.ai', api_key: 're_live' } }, ACTOR);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ name: 'webyar.ai', status: 'verified' }] }) });
    vi.stubGlobal('fetch', fetchMock);
    try {
      expect(await store.verifyEmailProvider(cfg(), 'default_email_provider')).toEqual({ ok: true, detail: 'the key is accepted and webyar.ai is verified' });
      expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.resend.com/domains');
      expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer re_live');
      fetchMock.mockResolvedValueOnce({ ok: true, status: 200, text: async () => JSON.stringify({ data: [{ name: 'webyar.ai', status: 'pending' }] }) });
      expect((await store.verifyEmailProvider(cfg(), 'default_email_provider')).detail).toMatch(/not verified/);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
