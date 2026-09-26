/**
 * C5 — password-reset / verify tokens must never reach a tenant's email_logs.
 *
 * - sendEmail() redacts credential-bearing template data before persisting it.
 * - A platform send (workspaceId: null) writes no email_logs row at all.
 * - The redaction helper covers token/url/code/otp/password/secret keys and
 *   any value containing a URL with a query string.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  REDACTED,
  redactSecrets,
  redactEmailLogRows,
  buildEmailLogMetadata,
} from '../../../server/services/email/redactLogMetadata';

type Row = Record<string, unknown>;
const inserts: Array<{ table: string; row: Row }> = [];

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from(table: string) {
      const builder: Record<string, unknown> = {
        select: () => builder,
        eq: () => builder,
        is: () => builder,
        order: () => builder,
        limit: () => builder,
        insert: (row: Row) => {
          inserts.push({ table, row });
          return Promise.resolve({ data: null, error: null });
        },
        maybeSingle: async () => {
          if (table === 'app_runtime_config') {
            return {
              data: { value: { provider_name: 'resend', config: { api_key: 'k', from_email: 'p@example.com', from_name: 'P' } } },
              error: null,
            };
          }
          if (table === 'email_templates') {
            return { data: { subject: 'Reset', html_body: '<a href="{{action_url}}">x</a>', text_body: null }, error: null };
          }
          return { data: null, error: null };
        },
      };
      return builder;
    },
  }),
}));

// SMTP is not exercised here (Resend is the configured provider).
vi.mock('../../../server/services/email/providers/smtp.js', () => ({
  sendViaSMTP: async () => ({ success: false, provider: 'smtp', error: 'not used' }),
}));

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' } as never;
const RESET_URL = 'https://app.example.com/auth/reset-password?token=11111111-2222-3333-4444-555555555555';

describe('redactSecrets', () => {
  it('redacts token-bearing keys and keeps harmless ones', () => {
    const out = redactSecrets({
      name: 'Ann',
      brand: 'Acme',
      action_url: RESET_URL,
      verifyUrl: 'https://x/verify',
      otp_code: '123456',
      password: 'hunter2',
      client_secret: 's',
      accessToken: 't',
      expiry_time: '24 hours',
    });
    expect(out).toEqual({
      name: 'Ann',
      brand: 'Acme',
      action_url: REDACTED,
      verifyUrl: REDACTED,
      otp_code: REDACTED,
      password: REDACTED,
      client_secret: REDACTED,
      accessToken: REDACTED,
      expiry_time: '24 hours',
    });
  });

  it('redacts a URL with a query string even under an innocuous key, and recurses', () => {
    const out = redactSecrets({ message: `Click ${RESET_URL}`, nested: { list: [{ link: 'x' }, 'plain'] } });
    expect(out).toEqual({ message: REDACTED, nested: { list: [{ link: REDACTED }, 'plain'] } });
  });

  it('does not mutate its input', () => {
    const input = { action_url: RESET_URL };
    redactSecrets(input);
    expect(input.action_url).toBe(RESET_URL);
  });

  it('redacts the metadata of rows read back from email_logs', () => {
    const rows = redactEmailLogRows([
      { id: '1', metadata: { templateData: { action_url: RESET_URL, name: 'A' }, messageId: 'm1' } },
    ]);
    expect(JSON.stringify(rows)).not.toContain('token=');
    expect(rows[0].metadata).toEqual({ templateData: { action_url: REDACTED, name: 'A' }, messageId: 'm1' });
    expect(redactEmailLogRows(null)).toEqual([]);
  });

  it('buildEmailLogMetadata keeps the provider message id', () => {
    expect(buildEmailLogMetadata({ action_url: RESET_URL }, 'msg_9')).toEqual({
      templateData: { action_url: REDACTED },
      messageId: 'msg_9',
    });
  });
});

describe('sendEmail() never persists a secret to email_logs', () => {
  beforeEach(() => {
    inserts.length = 0;
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'msg_1' }), text: async () => '' }));
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('workspace mail: logs the row with redacted template data', async () => {
    const { sendEmail } = await import('../../../server/services/email/index');
    const result = await sendEmail(CONFIG, {
      workspaceId: 'ws-1', to: 'a@example.com', templateSlug: 'password_reset',
      templateData: { name: 'A', action_url: RESET_URL },
    });
    expect(result.success).toBe(true);
    const logs = inserts.filter((i) => i.table === 'email_logs');
    expect(logs).toHaveLength(1);
    expect(logs[0].row.workspace_id).toBe('ws-1');
    expect(JSON.stringify(logs[0].row)).not.toContain('token=');
    expect(JSON.stringify(logs[0].row)).not.toContain('11111111-2222');
  });

  it('platform mail (workspaceId null): sends, but writes no tenant log row', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ id: 'm' }), text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);
    const { sendEmail } = await import('../../../server/services/email/index');
    const result = await sendEmail(CONFIG, {
      workspaceId: null, to: 'a@example.com', templateSlug: 'password_reset',
      templateData: { name: 'A', action_url: RESET_URL },
    });
    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // the real mail still carries the link — only the log is scrubbed
    expect(String(fetchMock.mock.calls[0][1].body)).toContain('token=');
    expect(inserts.filter((i) => i.table === 'email_logs')).toHaveLength(0);
  });

  it('still rejects a missing workspaceId (only an explicit null means platform)', async () => {
    const { sendEmail } = await import('../../../server/services/email/index');
    const result = await sendEmail(CONFIG, { workspaceId: '', to: 'a@example.com', subject: 's', html: 'h' });
    expect(result.success).toBe(false);
  });
});

describe('read paths return redacted metadata', () => {
  it('workspace email-logs route selects explicit columns and redacts', () => {
    const src = readFileSync('server/routes/workspaceIntegrations.ts', 'utf8');
    const route = src.slice(src.indexOf("'/:workspaceId/email-logs'"));
    const body = route.slice(0, route.indexOf('\n});'));
    expect(body).not.toContain(".select('*')");
    expect(body).toContain('redactEmailLogRows(data)');
  });

  it('admin user-messages route redacts email log metadata', () => {
    const src = readFileSync('server/routes/admin.ts', 'utf8');
    const route = src.slice(src.indexOf("adminRouter.get('/users/:userId/messages'"));
    expect(route.slice(0, 4000)).toContain('redactEmailLogRows(');
  });
});
