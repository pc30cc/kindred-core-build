// @vitest-environment node
/**
 * The send path every provider shares (server/services/email/index.ts,
 * owner 2026-10-29: email is provider-driven, so every rule here holds for
 * every adapter and none is a provider's special case):
 *
 *   - `to` is exactly one plain address, or nothing is sent: a comma list
 *     handed to SMTP becomes several RCPT TO (one send-channel call could
 *     reach a dozen people);
 *   - a suppressed address is not mailed; a failed lookup suppresses nothing;
 *   - every message carries Auto-Submitted, a text part (derived from the
 *     HTML, links kept, when there is none), the provider's Reply-To, and the
 *     one-click unsubscribe pair when the caller gives an https URL;
 *   - every failure has an errorCode and `permanent`, and `error` (also the
 *     email_logs row's error_message, which workspace admins read) is ours,
 *     never the provider's raw text;
 *   - the database wins over an environment variable, which fills a blank;
 *   - the From name is quoted for an API that takes one string.
 *
 * The database is an in-memory stand-in; the adapters are the real ones,
 * over a stubbed fetch (Resend and SendGrid).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;

const db = vi.hoisted(() => ({
  runtime: {} as Record<string, unknown>,
  suppressions: {} as Record<string, { expires_at: string | null }>,
  runtimeError: null as string | null,
  suppressionError: null as string | null,
  inserts: [] as Array<{ table: string; row: Row }>,
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const filters: Record<string, unknown> = {};
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: (column: string, value: unknown) => {
          filters[column] = value;
          return builder;
        },
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: (row: Row) => {
          db.inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: async () => {
          if (table === 'app_runtime_config') {
            if (db.runtimeError) return { data: null, error: { message: db.runtimeError } };
            const value = db.runtime[filters.key as string];
            return { data: value === undefined ? null : { value }, error: null };
          }
          if (table === 'email_suppressions') {
            if (db.suppressionError) return { data: null, error: { message: db.suppressionError } };
            const row = db.suppressions[filters.address as string];
            return { data: row ? { address: filters.address, ...row } : null, error: null };
          }
          if (table === 'platform_branding_localized') return { data: { platform_name: 'Brand' }, error: null };
          return { data: null, error: null };
        },
      };
      return builder;
    },
  }),
}));

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const RESEND = { provider_name: 'resend', config: { api_key: 're_db_key', from_email: 'noreply@platform.example', from_name: 'Platform' } };

let fetchMock: ReturnType<typeof vi.fn>;
const ok = () => ({ ok: true, status: 200, json: async () => ({ id: 'msg_1' }), text: async () => '', headers: new Headers() });
const body = (call = 0) => JSON.parse(fetchMock.mock.calls[call][1].body as string);
const logs = () => db.inserts.filter((i) => i.table === 'email_logs').map((i) => i.row);

const { sendEmail, sendPlatformEmail, isTransientEmailFailure, htmlToText } = await import('../../../server/services/email/index.js');

beforeEach(() => {
  db.runtime = { default_email_provider: structuredClone(RESEND) };
  db.suppressions = {};
  db.runtimeError = null;
  db.suppressionError = null;
  db.inserts = [];
  fetchMock = vi.fn().mockResolvedValue(ok());
  vi.stubGlobal('fetch', fetchMock);
  delete process.env.RESEND_API_KEY;
  delete process.env.SENDGRID_API_KEY;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const send = (over: Record<string, unknown> = {}) =>
  sendEmail(CONFIG, { workspaceId: 'ws-1', to: 'person@example.com', subject: 'Hello', html: '<p>Hi</p>', ...over } as never);

describe('one recipient, one plain address', () => {
  it.each([
    'a@example.com, b@example.com',
    'a@example.com;b@example.com',
    'Someone <a@example.com>',
    '<a@example.com>',
    'a b@example.com',
    'a@exa mple.com',
    'a@@example.com',
    '"quoted"@example.com',
    'nobody',
    `${'x'.repeat(250)}@example.com`,
  ])('%s is refused before any provider is called', async (to) => {
    const result = await send({ to });
    expect(result).toMatchObject({ success: false, errorCode: 'invalid_recipient', permanent: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs()[0].error_message).toMatch(/^invalid_recipient: /);
  });

  it('a plain address (surrounding spaces ignored) is sent as one recipient', async () => {
    expect((await send({ to: '  person@example.com ' })).success).toBe(true);
    expect(body().to).toEqual(['person@example.com']);
  });

  it('the workspace-less sender holds the same rule', async () => {
    const result = await sendPlatformEmail(CONFIG, { to: 'a@example.com,b@example.com', subject: 'S', html: '<p>x</p>' });
    expect(result.errorCode).toBe('invalid_recipient');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('suppressed addresses', () => {
  it('an address on the list is not mailed, whatever its case', async () => {
    db.suppressions['person@example.com'] = { expires_at: null };
    const result = await send({ to: 'Person@Example.com' });
    expect(result).toMatchObject({ success: false, errorCode: 'suppressed', permanent: true });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(logs()[0]).toMatchObject({ status: 'failed', error_message: expect.stringMatching(/^suppressed: /) });
    expect((await sendPlatformEmail(CONFIG, { to: 'person@example.com', subject: 'S', html: 'h' })).errorCode).toBe('suppressed');
  });

  it('an expired row holds nothing back', async () => {
    db.suppressions['person@example.com'] = { expires_at: new Date(Date.now() - 60_000).toISOString() };
    expect((await send()).success).toBe(true);
  });

  it('a list that cannot be read suppresses nothing: the mail matters more', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.suppressionError = 'relation "public.email_suppressions" does not exist';
    expect((await send()).success).toBe(true);
  });
});

describe('what every message carries', () => {
  it('Auto-Submitted on every message, and no unsubscribe pair unless asked', async () => {
    await send();
    expect(body().headers).toEqual({ 'Auto-Submitted': 'auto-generated' });
  });

  it('one-click unsubscribe (RFC 8058) for an https URL, with a mailto beside it', async () => {
    await send({ listUnsubscribe: { url: 'https://app.example.com/u/abc?t=1', mailto: 'mailto:unsub@example.com?subject=x' }, category: 'notification' });
    expect(body().headers).toEqual({
      'Auto-Submitted': 'auto-generated',
      'List-Unsubscribe': '<https://app.example.com/u/abc?t=1>, <mailto:unsub@example.com>',
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
    });
    expect(body().tags).toEqual([{ name: 'category', value: 'notification' }]);
    expect(logs()[0].metadata).toMatchObject({ category: 'notification' });
  });

  it('a non-https unsubscribe URL is left out rather than sent', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await send({ listUnsubscribe: { url: 'http://app.example.com/u/abc' } });
    expect(body().headers['List-Unsubscribe']).toBeUndefined();
    await send({ listUnsubscribe: { url: 'javascript:alert(1)' } });
    expect(body(1).headers['List-Unsubscribe']).toBeUndefined();
  });

  it('a text part always: derived from the HTML, with link targets kept', async () => {
    await send({
      html: '<html><head><style>p{}</style></head><body><p>Hello &amp; welcome</p><p><a href="https://x.example/reset?t=1">Reset password</a></p><a href="https://x.example/raw">https://x.example/raw</a><br>Bye</body></html>',
    });
    expect(body().text).toBe('Hello & welcome\n\nReset password (https://x.example/reset?t=1)\nhttps://x.example/raw\nBye');
    await send({ text: 'Own text' });
    expect(body(1).text).toBe('Own text');
  });

  it('Reply-To is the provider config\'s reply_to, only when it is one address', async () => {
    await send();
    expect(body().reply_to).toBeUndefined();
    (db.runtime.default_email_provider as { config: Row }).config.reply_to = 'support@platform.example';
    await send();
    expect(body(1).reply_to).toEqual(['support@platform.example']);
  });

  it('a From name that a parser would split is quoted', async () => {
    (db.runtime.default_email_provider as { config: Row }).config.from_name = 'Acme, "Inc." <x@y>';
    await send();
    expect(body().from).toBe('"Acme, \\"Inc.\\" <x@y>" <noreply@platform.example>');
  });
});

describe('failures: an errorCode, permanent or not, and never the provider\'s own words', () => {
  it('a provider 500 is transient; its body goes to the console only', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'upstream 10.0.0.5:587 exploded (key re_db_key)' });
    const result = await send();
    expect(result).toMatchObject({ success: false, errorCode: 'provider_error', permanent: false });
    expect(isTransientEmailFailure(result)).toBe(true);
    expect(result.error).toBe('provider_error: the provider failed (HTTP 500)');
    expect(logs()[0].error_message).toBe(result.error);
    expect(JSON.stringify(logs()[0])).not.toContain('10.0.0.5');
    const printed = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('10.0.0.5');
    expect(printed).not.toContain('re_db_key');
  });

  it.each([
    [401, 'auth', true],
    [403, 'auth', true],
    [422, 'rejected', true],
    [429, 'provider_error', false],
    [503, 'provider_error', false],
  ])('HTTP %i is %s (permanent: %s)', async (status, code, permanent) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ ok: false, status, text: async () => '{}' });
    expect(await send()).toMatchObject({ errorCode: code, permanent });
  });

  it('a network failure and a timeout are transient', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect(await send()).toMatchObject({ errorCode: 'connection', permanent: false });
    fetchMock.mockRejectedValueOnce(Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }));
    expect(await send()).toMatchObject({ errorCode: 'timeout', permanent: false });
  });

  it('every HTTP adapter gives up after its timeout', async () => {
    await send();
    expect(fetchMock.mock.calls[0][1].signal).toBeInstanceOf(AbortSignal);
  });

  it('no provider: the stub, unconfigured, permanent', async () => {
    db.runtime = {};
    const result = await send();
    expect(result).toMatchObject({ success: false, provider: 'stub', errorCode: 'unconfigured', permanent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a provider with no adapter here (an old form\'s vendor) is unconfigured, never a guess', async () => {
    db.runtime = { default_email_provider: { provider_name: 'mailgun', config: { api_key: 'k', from_email: 'a@b.example' } } };
    const result = await send();
    expect(result).toMatchObject({ success: false, provider: 'mailgun', errorCode: 'unconfigured', permanent: true });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a setting that cannot be read is transient (a retry may get past it)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    db.runtimeError = 'connection terminated';
    expect(await send()).toMatchObject({ success: false, errorCode: 'provider_error', permanent: false });
  });

  it('isTransientEmailFailure', () => {
    expect(isTransientEmailFailure({ success: true, provider: 'x' })).toBe(false);
    expect(isTransientEmailFailure({ success: false, provider: 'x', permanent: true })).toBe(false);
    expect(isTransientEmailFailure({ success: false, provider: 'x', permanent: false })).toBe(true);
  });
});

describe('the database wins; an environment variable only fills a blank', () => {
  it('a leftover RESEND_API_KEY does not override the key in the database', async () => {
    process.env.RESEND_API_KEY = 're_env_leftover';
    await send();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer re_db_key');
  });

  it('the variable is used when the database has no key', async () => {
    process.env.RESEND_API_KEY = 're_env';
    delete (db.runtime.default_email_provider as { config: Row }).config.api_key;
    await send();
    expect(fetchMock.mock.calls[0][1].headers.Authorization).toBe('Bearer re_env');
  });
});

describe('the operator-notification override', () => {
  it('an override that cannot send falls back to the default', async () => {
    db.runtime.notification_email_provider = { provider_name: 'sendgrid', config: { from_email: 'n@platform.example' } };
    await send({ providerConfigKey: 'notification_email_provider' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.resend.com/emails');
  });

  it('a usable override is used', async () => {
    db.runtime.notification_email_provider = { provider_name: 'sendgrid', config: { api_key: 'sg_key', from_email: 'n@platform.example', from_name: 'N', reply_to: 'r@platform.example' } };
    fetchMock.mockResolvedValueOnce({ ok: true, status: 202, text: async () => '', headers: new Headers({ 'x-message-id': 'sg-1' }) });
    const result = await send({ providerConfigKey: 'notification_email_provider', category: 'notification' });
    expect(result).toMatchObject({ success: true, provider: 'sendgrid', id: 'sg-1' });
    const sg = body();
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.sendgrid.com/v3/mail/send');
    expect(sg.from).toEqual({ email: 'n@platform.example', name: 'N' });
    expect(sg.reply_to).toEqual({ email: 'r@platform.example' });
    expect(sg.content.map((c: { type: string }) => c.type)).toEqual(['text/plain', 'text/html']);
    expect(sg.headers['Auto-Submitted']).toBe('auto-generated');
    expect(sg.categories).toEqual(['notification']);
  });

  it('a key that is not one of the store\'s is never read', async () => {
    db.runtime.default_storage_provider = { provider_name: 'sendgrid', config: { api_key: 'sg', from_email: 'x@platform.example' } };
    await send({ providerConfigKey: 'default_storage_provider' });
    expect(String(fetchMock.mock.calls[0][0])).toBe('https://api.resend.com/emails');
  });
});

describe('the log keeps no code', () => {
  it('a code in the subject is cut out of the logged subject', async () => {
    await send({ subject: 'Your code: 482913', templateData: { code: '482913', name: 'Ann' } });
    expect(body().subject).toBe('Your code: 482913');
    expect(logs()[0].subject).toBe('Your code: [REDACTED]');
  });
});

describe('htmlToText', () => {
  it('stays linear on hostile HTML (unclosed openers, a lone angle bracket)', () => {
    const started = Date.now();
    for (const piece of ['<a href="x">', '<style>', '<!--', '<', '<li', '<p']) {
      expect(typeof htmlToText(piece.repeat(40_000))).toBe('string');
    }
    expect(Date.now() - started).toBeLessThan(3_000);
    expect(htmlToText('<p>Keep</p><style>a{}')).toBe('Keep');
    expect(htmlToText('<a href="https://x.example">open</a> and <a href="y">unclosed')).toBe('open (https://x.example) and unclosed');
  });

  it('drops scripts and comments, keeps list items and mailto targets', () => {
    expect(htmlToText('<script>x()</script><!-- c --><ul><li>One</li><li>Two</li></ul><a href="mailto:a@b.example">write</a>'))
      .toBe('- One\n- Two\nwrite (a@b.example)');
    expect(htmlToText('')).toBe('');
    expect(htmlToText('<p>&#1587;&#1604;&#1575;&#1605;&nbsp;</p><p>می&zwnj;خواهم</p>')).toBe('سلام\n\nمی\u200cخواهم');
  });
});
