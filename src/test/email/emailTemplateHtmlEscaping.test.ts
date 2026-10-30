// @vitest-environment node
/**
 * Template values reach a mail's HTML part as text (server/services/email/
 * index.ts, fillEmailTemplate):
 *
 *   - every templateData value is escaped for the HTML part, and only there:
 *     the subject and the text part get it as it is;
 *   - htmlData (HTML a caller made itself: an escaped copy, a transcript's
 *     rows) goes in as it is, never escaped a second time;
 *   - the sign-up's full name, which anyone can type for an address that is
 *     not theirs, used to reach the verification mail's HTML as markup: a
 *     stranger could put a link of their own into a platform mail. Through
 *     the real issueVerificationEmail, the outbox and sendEmail, it is text;
 *   - no caller escapes a value by hand in templateData any more, which
 *     would now show its `&amp;` (a guard over every caller in server/ and
 *     worker/).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const db = vi.hoisted(() => ({
  runtime: {} as Record<string, unknown>,
  template: null as null | { subject: string; html_body: string; text_body: string | null },
}));

const fakeClient = vi.hoisted(() => () => ({
  from(table: string) {
    const filters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {
      select: () => builder,
      insert: () => builder,
      update: () => builder,
      upsert: () => builder,
      delete: () => builder,
      eq: (column: string, value: unknown) => {
        filters[column] = value;
        return builder;
      },
      neq: () => builder,
      is: () => builder,
      in: () => builder,
      lt: () => builder,
      lte: () => builder,
      gt: () => builder,
      order: () => builder,
      limit: () => builder,
      then: (resolve: (v: unknown) => unknown) => resolve({ data: null, error: null }),
      single: async () => ({ data: { id: 'token-1', created_at: '2026-10-30T10:00:00.000000+00:00' }, error: null }),
      maybeSingle: async () => {
        if (table === 'app_runtime_config') {
          const value = db.runtime[filters.key as string];
          return { data: value === undefined ? null : { value }, error: null };
        }
        if (table === 'email_templates') return { data: db.template, error: null };
        if (table === 'platform_domains') return { data: { app_base_url: 'https://app.webyar.ai' }, error: null };
        if (table === 'platform_branding_localized') return { data: { platform_name: 'Webyar' }, error: null };
        return { data: null, error: null };
      },
    };
    return builder;
  },
}));

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: fakeClient }));
vi.mock('../../../server/lib/serviceClient.js', () => ({ serviceClientFor: fakeClient }));
vi.mock('../../../server/services/platformRegion.js', () => ({
  getPlatformEditionOrNull: async () => 'iran',
  getPlatformAllowedLocales: async () => ['fa'],
}));

const { fillEmailTemplate } = await import('../../../server/services/email/index.js');
const { issueVerificationEmail, issueRecoveryEmail } = await import('../../../server/services/auth-email.js');

const CONFIG = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k', corsOrigins: ['*'], deliveryDiagnosticsLoggingEnabled: false } as never;

/** The name an attacker types at sign-up, for the victim's address. */
const HOSTILE_NAME = '<a href="https://evil.example/refund">Confirm your refund</a><div style="display:none">';

/** The seeded email_verify body's greeting and button (239_selfhost_hosted_parity.sql). */
const VERIFY_TEMPLATE = {
  subject: 'Verify your email for {brand}',
  html_body: '<p style="margin:0">Hi {name},</p><p><a href="{action_url}">Verify email</a></p><p>{email}</p>',
  text_body: 'Hi {name},\n\n{action_url}',
};

let fetchMock: ReturnType<typeof vi.fn>;
const sentBody = () => JSON.parse(fetchMock.mock.calls[0][1].body as string) as { html: string; text: string; subject: string };

beforeEach(() => {
  db.runtime = {
    default_email_provider: { provider_name: 'resend', config: { api_key: 're_test', from_email: 'noreply@webyar.ai', from_name: 'Webyar' } },
  };
  db.template = structuredClone(VERIFY_TEMPLATE);
  fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({ id: 'msg_1' }), text: async () => '' });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('fillEmailTemplate', () => {
  const tpl = { subject: 'Hi {name}', html_body: '<p>Hi {name}</p><div>{rows}</div>', text_body: 'Hi {name}\n{rows}' };

  it('escapes every value for the HTML part, and only there', () => {
    const out = fillEmailTemplate(tpl, { name: 'A & "B" <i>\'C\'</i>', rows: '<tr>' });
    expect(out.html).toBe('<p>Hi A &amp; &quot;B&quot; &lt;i&gt;&#39;C&#39;&lt;/i&gt;</p><div>&lt;tr&gt;</div>');
    expect(out.subject).toBe('Hi A & "B" <i>\'C\'</i>');
    expect(out.text).toBe('Hi A & "B" <i>\'C\'</i>\n<tr>');
  });

  it('takes htmlData as it is, never escaped twice', () => {
    const out = fillEmailTemplate(tpl, { name: 'A & B', rows: 'one\ntwo' }, { name: 'A &amp; B', rows: '<p>one</p><p>two</p>' });
    expect(out.html).toBe('<p>Hi A &amp; B</p><div><p>one</p><p>two</p></div>');
    expect(out.html).not.toContain('&amp;amp;');
    expect(out.text).toBe('Hi A & B\none\ntwo');
  });

  it('a value is filled once: a placeholder typed inside one stays as typed', () => {
    const out = fillEmailTemplate(tpl, { name: '{rows} $& $1', rows: 'x' });
    expect(out.html).toBe('<p>Hi {rows} $&amp; $1</p><div>x</div>');
  });
});

describe('the verification and reset mails', () => {
  it.each([
    ['verification', issueVerificationEmail],
    ['reset', issueRecoveryEmail],
  ])('%s: the full name a stranger typed reaches the HTML as text', async (_kind, issue) => {
    const result = await issue(CONFIG, { userId: 'u-1', email: 'victim@example.com', fullName: `${HOSTILE_NAME}\r\nBcc: x@evil.example`, locale: 'fa' });
    expect(result).toEqual({ success: true });
    const mail = sentBody();
    expect(mail.html).not.toContain('<a href="https://evil.example');
    expect(mail.html).not.toContain('<div style="display:none">');
    expect(mail.html).toContain('Hi &lt;a href=&quot;https://evil.example/refund&quot;&gt;Confirm your refund&lt;/a&gt;');
    // The mail's own link is still a link.
    expect(mail.html).toMatch(/<a href="https:\/\/app\.webyar\.ai\/auth\/[a-z-]+\?token=[0-9a-f-]+">/);
    // One line: the name holds no line break anywhere.
    expect(mail.text).toContain('Hi <a href="https://evil.example/refund">Confirm your refund</a><div style="display:none"> Bcc: x@evil.example,');
    expect(mail.subject).toBe('Verify your email for Webyar');
  });

  it('a blank name falls back to the address\'s local part', async () => {
    await issueVerificationEmail(CONFIG, { userId: 'u-1', email: 'ali@example.com', fullName: '  \n ', locale: 'fa' });
    expect(sentBody().html).toContain('Hi ali,');
  });
});

describe('no caller escapes a template value by hand', () => {
  const ROOT = join(__dirname, '..', '..', '..');

  function sources(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const path = join(dir, name);
      if (statSync(path).isDirectory()) out.push(...sources(path));
      else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) out.push(path);
    }
    return out;
  }

  /** Each `templateData: { … }` beside a `templateSlug` whose values call an escape function, as file:line. */
  function escapedTemplateData(file: string, text: string): string[] {
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const found: string[] = [];
    const callsEscape = (node: ts.Node): boolean => {
      if (ts.isCallExpression(node)) {
        const callee = node.expression;
        const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
        if (/escape/i.test(name)) return true;
      }
      return ts.forEachChild(node, callsEscape) ?? false;
    };
    const visit = (node: ts.Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const props = node.properties.filter(ts.isPropertyAssignment);
        const named = (key: string) => props.find((p) => p.name.getText(source) === key);
        const data = named('templateData');
        if (named('templateSlug') && data && callsEscape(data.initializer)) {
          const { line } = source.getLineAndCharacterOfPosition(data.getStart(source));
          found.push(`${relative(ROOT, file)}:${line + 1}`);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
  }

  it('in server/ and worker/: escaped copies go in htmlData, text in templateData', () => {
    const files = [...sources(join(ROOT, 'server')), ...sources(join(ROOT, 'worker'))];
    expect(files.length).toBeGreaterThan(100);
    expect(files.flatMap((file) => escapedTemplateData(file, readFileSync(file, 'utf8')))).toEqual([]);
  });

  it('the guard finds a hand-escaped value, and leaves htmlData alone', () => {
    const file = join(ROOT, 'server', 'probe.ts');
    expect(escapedTemplateData(file, "send({ templateSlug: 'x', templateData: { name: escapeHtml(n) } });")).toEqual(['server/probe.ts:1']);
    expect(escapedTemplateData(file, "send({ templateSlug: 'x', templateData: { name: n }, htmlData: { name: escapeHtml(n) } });")).toEqual([]);
  });
});
