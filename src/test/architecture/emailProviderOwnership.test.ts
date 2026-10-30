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
import { join, posix } from 'node:path';
import ts from 'typescript';

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

// The senders are read as TypeScript, with the compiler's own parser and
// binder: a name means the declaration it means in that scope (a parameter of
// an arrow function is that parameter, not a const of the same name elsewhere
// in the file), and the core is found by what a file imports, under whatever
// name it imports it. Anything the reading cannot follow fails, with where.

/** The email core's entry points, by the module that exports them. */
const CORE_ENTRIES: Record<string, readonly string[]> = {
  [SERVICE]: ['sendEmail', 'sendPlatformEmail'],
  'server/services/email/outbox.ts': ['sendEmailWithRetry', 'enqueueEmail'],
};

/** The repo file a relative module specifier names from `from` (`./x.js` is `./x.ts`); null for a package. */
function moduleFile(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return posix.normalize(posix.join(posix.dirname(from), specifier)).replace(/\.(m?)js$/, '.$1ts');
}

type Source = { file: string; sf: ts.SourceFile; checker: ts.TypeChecker };

/** One file parsed and bound on its own (no lib, no import followed): enough to tell which declaration a name is. */
function bind(file: string, text: string): Source {
  const options: ts.CompilerOptions = { noLib: true, noResolve: true, types: [], target: ts.ScriptTarget.Latest, module: ts.ModuleKind.ESNext };
  const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const host = ts.createCompilerHost(options);
  host.getSourceFile = (name) => (name === file ? sf : undefined);
  return { file, sf, checker: ts.createProgram([file], options, host).getTypeChecker() };
}

const sources = new Map<string, Source>();
function sourceOf(file: string): Source {
  if (!sources.has(file)) sources.set(file, bind(file, read(file)));
  return sources.get(file) as Source;
}

const where = (src: Source, node: ts.Node) => `${src.file}:${src.sf.getLineAndCharacterOfPosition(node.getStart(src.sf)).line + 1}`;

/** The expression under parentheses, `await`, `as`, `satisfies` and `!`. */
function inner(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e) || ts.isAsExpression(e) || ts.isSatisfiesExpression(e) || ts.isNonNullExpression(e) || ts.isTypeAssertionExpression(e)) e = e.expression;
  return e;
}

const isConst = (decl: ts.VariableDeclaration) => (ts.getCombinedNodeFlags(decl) & ts.NodeFlags.Const) !== 0;
const exportedStatement = (node: ts.Node) => ts.canHaveModifiers(node) && !!ts.getModifiers(node)?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword);
/** A property's written name; null for a computed one (`[key]: …`). */
const propertyKey = (p: ts.ObjectLiteralElementLike) => (p.name && !ts.isComputedPropertyName(p.name) ? p.name.text : null);

/** The symbol a name refers to; for `{ name }`, the value's rather than the property's. */
const symbolOf = (src: Source, id: ts.Identifier) =>
  ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id
    ? src.checker.getShorthandAssignmentValueSymbol(id.parent)
    : src.checker.getSymbolAtLocation(id);

/** The declaration a file exports under `name` (a function, a const or a type), or null. */
function exportedDeclaration(src: Source, name: string): ts.Node | null {
  for (const st of src.sf.statements) {
    if (!exportedStatement(st)) continue;
    if (ts.isFunctionDeclaration(st) && st.body && st.name?.text === name) return st;
    if (ts.isTypeAliasDeclaration(st) && st.name.text === name) return st;
    if (ts.isVariableStatement(st)) {
      const decl = st.declarationList.declarations.find((d) => ts.isIdentifier(d.name) && d.name.text === name);
      if (decl) return decl;
    }
  }
  return null;
}

/** The declaration a name stands for where it is written, followed through an import to what the repo file it comes from exports. */
function declarationOf(src: Source, id: ts.Identifier): { src: Source; decl: ts.Node } | null {
  const symbol = symbolOf(src, id);
  const decl = symbol?.declarations?.find((d) => ts.isFunctionDeclaration(d) && d.body) ?? symbol?.valueDeclaration ?? symbol?.declarations?.[0];
  if (!decl) return null;
  if (!ts.isImportSpecifier(decl)) return { src, decl };
  const target = moduleFile(src.file, (decl.parent.parent.parent.moduleSpecifier as ts.StringLiteral).text);
  if (!target || !existsSync(target)) return null;
  const there = sourceOf(target);
  const exported = exportedDeclaration(there, (decl.propertyName ?? decl.name).text);
  return exported ? { src: there, decl: exported } : null;
}

type Fn = ts.FunctionDeclaration | ts.ArrowFunction | ts.FunctionExpression;

/** The function a name stands for: a function declaration, or a const that holds an arrow or a function expression. */
function functionOf(src: Source, id: ts.Identifier): { src: Source; fn: Fn } | null {
  const found = declarationOf(src, id);
  if (!found) return null;
  if (ts.isFunctionDeclaration(found.decl) && found.decl.body) return { src: found.src, fn: found.decl };
  if (ts.isVariableDeclaration(found.decl) && isConst(found.decl) && found.decl.initializer) {
    const init = inner(found.decl.initializer);
    if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return { src: found.src, fn: init };
  }
  return null;
}

/** What a function can return: its expression body, or the value of each `return` of its own; null when one returns nothing. */
function returnsOf(fn: Fn): ts.Expression[] | null {
  if (!fn.body) return null;
  if (!ts.isBlock(fn.body)) return [fn.body];
  const values: ts.Expression[] = [];
  let empty = false;
  const visit = (node: ts.Node) => {
    if (ts.isReturnStatement(node)) {
      if (node.expression) values.push(node.expression);
      else empty = true;
    }
    if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  return empty || !values.length ? null : values;
}

/** The name a function is called by in its file: its own, or that of the const holding it. */
function functionName(fn: ts.SignatureDeclaration): ts.Identifier | null {
  if (ts.isFunctionDeclaration(fn)) return fn.name ?? null;
  const holder = fn.parent;
  if ((ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && ts.isVariableDeclaration(holder) && holder.initializer === fn && ts.isIdentifier(holder.name)) return holder.name;
  return null;
}

/** Whether other files can call the function: exported where it is declared, or by an `export { … }`. */
function isExported(src: Source, fn: ts.SignatureDeclaration, name: ts.Identifier): boolean {
  if (exportedStatement(ts.isFunctionDeclaration(fn) ? fn : fn.parent.parent.parent)) return true;
  return src.sf.statements.some((st) =>
    ts.isExportDeclaration(st) && !st.moduleSpecifier && !!st.exportClause && ts.isNamedExports(st.exportClause)
    && st.exportClause.elements.some((el) => (el.propertyName ?? el.name).text === name.text));
}

/** Every other place the file names the same declaration as `name` does. */
function usesOf(src: Source, name: ts.Identifier): ts.Identifier[] {
  const symbol = symbolOf(src, name);
  const uses: ts.Identifier[] = [];
  const visit = (node: ts.Node) => {
    if (ts.isIdentifier(node) && node !== name && node.text === name.text && symbolOf(src, node) === symbol) uses.push(node);
    ts.forEachChild(node, visit);
  };
  visit(src.sf);
  return uses;
}

/**
 * What a request, or the templateSlug in it, can be: the templates it may
 * name, whether some way through it names none (`bare`), and what could not
 * be followed (each with where, so a failure says where to look).
 */
type Reading = { slugs: string[]; bare: boolean; unread: string[] };
type Reader = (src: Source, node: ts.Expression, depth: number) => Reading;
const named = (slugs: string[]): Reading => ({ slugs, bare: false, unread: [] });
const BARE: Reading = { slugs: [], bare: true, unread: [] };
const unread = (src: Source, node: ts.Node, why: string): Reading => ({ slugs: [], bare: false, unread: [`${where(src, node)}: ${why}`] });
/** One of several readings, any of which can be the one: every template any names, bare when one is. */
const either = (readings: Reading[]): Reading => ({
  slugs: [...new Set(readings.flatMap((r) => r.slugs))],
  bare: readings.some((r) => r.bare),
  unread: readings.flatMap((r) => r.unread),
});
const DEPTH = 12;

/**
 * What a parameter can be. Only for a function its file calls by name and
 * does nothing else with (never exports, never hands on as a value), so that
 * every call is in sight: whatever each of them passes.
 */
function readParameter(src: Source, param: ts.ParameterDeclaration, read: Reader, depth: number): Reading {
  const fn = param.parent;
  const name = functionName(fn);
  const label = param.name.getText(src.sf);
  if (!name || !ts.isIdentifier(param.name) || param.dotDotDotToken) return unread(src, param, `${label}: a parameter whose callers the check cannot see`);
  if (isExported(src, fn, name)) return unread(src, param, `${label}: a parameter of ${name.text}, which is exported, so its callers are in other files`);
  const index = fn.parameters.indexOf(param);
  const uses = usesOf(src, name);
  if (!uses.length) return unread(src, param, `${name.text} is never called`);
  return either(uses.map((use) => {
    const call = use.parent;
    if (!ts.isCallExpression(call) || call.expression !== use) return unread(src, use, `${name.text} is used other than called, so not every call is in sight`);
    if (call.arguments.slice(0, index + 1).some(ts.isSpreadElement)) return unread(src, call, `${name.text} is called with a spread`);
    const arg = call.arguments[index] ?? param.initializer;
    return arg ? read(src, arg, depth + 1) : unread(src, call, `${name.text} is called without its ${label}`);
  }));
}

/** What a name can be, by its declaration: a const's value, or a parameter's arguments. */
function readName(src: Source, id: ts.Identifier, read: Reader, depth: number): Reading {
  const found = declarationOf(src, id);
  if (!found) return unread(src, id, `${id.text} is not declared in a file the check can read`);
  const { decl } = found;
  if (ts.isVariableDeclaration(decl) && isConst(decl) && decl.initializer && ts.isIdentifier(decl.name)) return read(found.src, decl.initializer, depth + 1);
  if (ts.isParameter(decl)) return readParameter(found.src, decl, read, depth);
  return unread(src, id, `${id.text} is not a const or a parameter the check can follow`);
}

type Objects = Array<{ src: Source; obj: ts.ObjectLiteralExpression }>;

/** The object literals an expression can be: one written there, a const's, or a map's member (any member, for a key not written out). */
function readObjects(src: Source, node: ts.Expression, depth: number): Objects | Reading {
  const e = inner(node);
  if (depth > DEPTH) return unread(src, e, 'built through too many steps to follow');
  if (ts.isObjectLiteralExpression(e)) return [{ src, obj: e }];
  if (ts.isIdentifier(e)) {
    const found = declarationOf(src, e);
    if (found && ts.isVariableDeclaration(found.decl) && isConst(found.decl) && found.decl.initializer) return readObjects(found.src, found.decl.initializer, depth + 1);
    return unread(src, e, `${e.text} is not a const the check can read`);
  }
  if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
    const key = ts.isPropertyAccessExpression(e) ? e.name.text : ts.isStringLiteralLike(e.argumentExpression) ? e.argumentExpression.text : null;
    const outer = readObjects(src, e.expression, depth + 1);
    if (!Array.isArray(outer)) return outer;
    const found: Objects = [];
    for (const o of outer) {
      for (const p of o.obj.properties) {
        if (!ts.isPropertyAssignment(p) || propertyKey(p) === null) return unread(o.src, p, 'a member the check cannot read');
        if (key !== null && propertyKey(p) !== key) continue;
        const member = readObjects(o.src, p.initializer, depth + 1);
        if (!Array.isArray(member)) return member;
        found.push(...member);
      }
    }
    return found;
  }
  return unread(src, e, `cannot read a ${ts.SyntaxKind[e.kind]} as an object`);
}

/** The string literals a type allows, when it is nothing but them (written there, or through a type alias); null otherwise. */
function literalUnion(src: Source, type: ts.TypeNode): string[] | null {
  if (ts.isLiteralTypeNode(type)) return ts.isStringLiteral(type.literal) ? [type.literal.text] : null;
  if (ts.isParenthesizedTypeNode(type)) return literalUnion(src, type.type);
  if (ts.isUnionTypeNode(type)) {
    const parts = type.types.map((t) => literalUnion(src, t));
    return parts.every((p) => p !== null) ? (parts as string[][]).flat() : null;
  }
  if (ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && !type.typeArguments) {
    const found = declarationOf(src, type.typeName);
    return found && ts.isTypeAliasDeclaration(found.decl) ? literalUnion(found.src, found.decl.type) : null;
  }
  return null;
}

/** What templates a templateSlug value can be. */
function readSlug(src: Source, node: ts.Expression, depth: number): Reading {
  const e = inner(node);
  if (depth > DEPTH) return unread(src, e, 'built through too many steps to follow');
  if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return named([e.text]);
  if (ts.isConditionalExpression(e)) return either([readSlug(src, e.whenTrue, depth + 1), readSlug(src, e.whenFalse, depth + 1)]);
  if (ts.isIdentifier(e)) {
    // A parameter typed as a union of literals is one of them: tsc holds
    // every caller to it, in whichever file.
    const found = declarationOf(src, e);
    const literals = found && ts.isParameter(found.decl) && found.decl.type ? literalUnion(found.src, found.decl.type) : null;
    return literals ? named(literals) : readName(src, e, readSlug, depth);
  }
  if (ts.isPropertyAccessExpression(e) || (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))) {
    const key = ts.isPropertyAccessExpression(e) ? e.name.text : (e.argumentExpression as ts.StringLiteralLike).text;
    const objects = readObjects(src, e.expression, depth + 1);
    if (!Array.isArray(objects)) return objects;
    return either(objects.map(({ src: at, obj }) => {
      if (obj.properties.some((p) => !ts.isPropertyAssignment(p) || propertyKey(p) === null)) return unread(at, obj, `cannot tell what its ${key} is`);
      const member = obj.properties.find((p) => propertyKey(p) === key) as ts.PropertyAssignment | undefined;
      return member ? readSlug(at, member.initializer, depth + 1) : BARE;
    }));
  }
  return unread(src, e, `cannot read a templateSlug written as a ${ts.SyntaxKind[e.kind]}`);
}

/**
 * What templates a request handed to the core can name: its own
 * templateSlug, or one a spread brings (a builder's return, a const), with
 * every way through it (each branch of a condition, each `return` of a
 * builder, each call of a local helper that passes it on) followed.
 */
function readRequest(src: Source, node: ts.Expression, depth = 0): Reading {
  const e = inner(node);
  if (depth > DEPTH) return unread(src, e, 'built through too many steps to follow');
  if (ts.isObjectLiteralExpression(e)) {
    const own: Reading[] = [];
    const spreads: Reading[] = [];
    for (const p of e.properties) {
      if (ts.isSpreadAssignment(p)) spreads.push(readRequest(src, p.expression, depth + 1));
      else if (propertyKey(p) === null) own.push(unread(src, p, 'a computed key, which could be templateSlug'));
      else if (propertyKey(p) !== 'templateSlug') continue;
      else if (ts.isPropertyAssignment(p)) own.push(readSlug(src, p.initializer, depth + 1));
      else if (ts.isShorthandPropertyAssignment(p)) own.push(readSlug(src, p.name, depth + 1));
      else own.push(unread(src, p, 'a templateSlug that is not a value'));
    }
    // Its own templateSlug names the template, or else a spread that always brings one.
    return { ...either([...own, ...spreads]), bare: own.length ? own.some((r) => r.bare) : spreads.every((r) => r.bare) };
  }
  if (ts.isIdentifier(e)) return readName(src, e, readRequest, depth);
  if (ts.isCallExpression(e)) {
    const called = ts.isIdentifier(e.expression) ? functionOf(src, e.expression) : null;
    const returns = called && returnsOf(called.fn);
    if (!called || !returns) return unread(src, e, `cannot see what ${e.expression.getText(src.sf)} returns`);
    return either(returns.map((r) => readRequest(called.src, r, depth + 1)));
  }
  if (ts.isConditionalExpression(e)) return either([readRequest(src, e.whenTrue, depth + 1), readRequest(src, e.whenFalse, depth + 1)]);
  return unread(src, e, `cannot read a request written as a ${ts.SyntaxKind[e.kind]}`);
}

/** Whether a name is written inside a type (`typeof sendEmail`), where it sends nothing. */
function inType(node: ts.Node): boolean {
  for (let at = node.parent; at && !ts.isStatement(at); at = at.parent) if (ts.isTypeNode(at)) return true;
  return false;
}

/**
 * How a file reaches the email core: whether it binds one of the entry
 * points (a named import under any name, a namespace or a dynamic import),
 * every call of one, and every other use of one, which cannot be followed (a
 * sender or the module handed on as a value, a re-export).
 */
function sendsIn(src: Source): { reaches: boolean; calls: ts.CallExpression[]; unread: string[] } {
  const entries = new Set<ts.Symbol>();
  const modules = new Map<ts.Symbol, readonly string[]>();
  const calls: ts.CallExpression[] = [];
  const problems: string[] = [];
  let reaches = false;
  const coreOf = (spec: ts.Node | undefined) => (spec && ts.isStringLiteralLike(spec) ? CORE_ENTRIES[moduleFile(src.file, spec.text) ?? ''] : undefined);
  const add = (set: Set<ts.Symbol>, id: ts.Identifier) => { const s = src.checker.getSymbolAtLocation(id); if (s) set.add(s); };
  // A use of an entry point: a call is a send; anything else hides one.
  const reach = (callee: ts.Expression, what: string) => {
    reaches = true;
    if (ts.isCallExpression(callee.parent) && callee.parent.expression === callee) calls.push(callee.parent);
    else problems.push(`${where(src, callee)}: ${what} is used other than called`);
  };
  /** What a dynamic import of a core module is bound to; false when it is not bound to names. */
  const bindModule = (name: ts.BindingName, core: readonly string[]): boolean => {
    if (ts.isIdentifier(name)) {
      const s = src.checker.getSymbolAtLocation(name);
      if (s) modules.set(s, core);
      return true;
    }
    if (!ts.isObjectBindingPattern(name)) return false;
    return name.elements.every((el) => {
      if (!ts.isIdentifier(el.name)) return false;
      if (el.dotDotDotToken) return bindModule(el.name, core);
      const imported = el.propertyName ? (ts.isIdentifier(el.propertyName) || ts.isStringLiteral(el.propertyName) ? el.propertyName.text : null) : el.name.text;
      if (imported === null) return false;
      if (core.includes(imported)) add(entries, el.name);
      return true;
    });
  };
  const collect = (node: ts.Node) => {
    if (ts.isImportDeclaration(node)) {
      const core = coreOf(node.moduleSpecifier);
      const clause = node.importClause;
      if (core && clause && !clause.isTypeOnly) {
        const bindings = clause.namedBindings;
        if (clause.name) bindModule(clause.name, core);
        if (bindings && ts.isNamespaceImport(bindings)) bindModule(bindings.name, core);
        if (bindings && ts.isNamedImports(bindings)) {
          for (const el of bindings.elements) if (!el.isTypeOnly && core.includes((el.propertyName ?? el.name).text)) add(entries, el.name);
        }
      }
    } else if (ts.isExportDeclaration(node)) {
      const core = coreOf(node.moduleSpecifier);
      const clause = node.exportClause;
      if (core && !node.isTypeOnly && (!clause || !ts.isNamedExports(clause) || clause.elements.some((el) => !el.isTypeOnly && core.includes((el.propertyName ?? el.name).text)))) {
        problems.push(`${where(src, node)}: re-exports the email core's senders`);
      }
    } else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && coreOf(node.arguments[0])) {
      const core = coreOf(node.arguments[0]) as readonly string[];
      const climb = (n: ts.Node) => { while (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent)) n = n.parent; return n; };
      const at = climb(node);
      const up = at.parent;
      if (ts.isPropertyAccessExpression(up) && up.expression === at) {
        // (await import(…)).sendEmail(…)
        if (core.includes(up.name.text)) reach(up, up.name.text);
      } else {
        let name: ts.BindingName | undefined;
        if (ts.isVariableDeclaration(up) && up.initializer === at) name = up.name;
        else if (ts.isArrayLiteralExpression(up) && ts.isCallExpression(up.parent) && up.parent.expression.getText(src.sf) === 'Promise.all') {
          // const [config, mod] = await Promise.all([import(…), import(…)])
          const all = climb(up.parent);
          const pattern = ts.isVariableDeclaration(all.parent) && all.parent.initializer === all ? all.parent.name : undefined;
          const el = pattern && ts.isArrayBindingPattern(pattern) ? pattern.elements[up.elements.indexOf(at as ts.Expression)] : undefined;
          if (el && ts.isBindingElement(el) && !el.dotDotDotToken) name = el.name;
        }
        if (!name || !bindModule(name, core)) problems.push(`${where(src, node)}: an import of the email core the check cannot follow`);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(src.sf);
  const look = (node: ts.Node) => {
    if (ts.isIdentifier(node) && !inType(node)) {
      const parent = node.parent;
      const declares = (ts.isImportSpecifier(parent) || ts.isNamespaceImport(parent) || ts.isImportClause(parent) || ts.isBindingElement(parent) || ts.isVariableDeclaration(parent))
        && (parent.name === node || (ts.isImportSpecifier(parent) && parent.propertyName === node) || (ts.isBindingElement(parent) && parent.propertyName === node));
      const symbol = ts.isExportSpecifier(parent) ? src.checker.getExportSpecifierLocalTargetSymbol(parent) : symbolOf(src, node);
      if (!declares && symbol && entries.has(symbol)) reach(node, node.text);
      else if (!declares && symbol && modules.has(symbol)) {
        const core = modules.get(symbol) as readonly string[];
        if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node) problems.push(`${where(src, node)}: the email core's module is handed on as a value`);
        else if (core.includes(parent.name.text)) reach(parent, parent.name.text);
      }
    }
    ts.forEachChild(node, look);
  };
  look(src.sf);
  return { reaches, calls: calls.sort((a, b) => a.pos - b.pos), unread: problems };
}

/** Every repo file whose imports (static, dynamic or re-exports) name one of the core's two modules. */
function coreImporters(files: string[]): string[] {
  return files.filter((file) => {
    const text = read(file);
    // A path to server/services/email/… has `email/` in it unless it starts
    // there: the rest cannot import the core, and are not read as code.
    if (!file.startsWith('server/services/email/') && !text.includes('email/')) return false;
    return ts.preProcessFile(text, true, true).importedFiles.some((imp) => (moduleFile(file, imp.fileName) ?? '') in CORE_ENTRIES);
  });
}

describe('no mail without a template', () => {
  /**
   * Every file that hands a mail to the email core, how many times, and every
   * template it can send, read from the file and what it imports (a literal,
   * a const, each member of a map like AUTH_LINKS or NOTIFICATION_EMAILS, a
   * slug parameter's union type, a builder's returns): exactly these, so a
   * template is sent only once it is listed here, and it is listed only with
   * its rows in fa, en and tr for both editions (291 rewrote every sent one;
   * a later migration adds a new one). A new send path, or one more send in
   * these files, fails until it is listed. The outbox only re-sends what was
   * queued, as it was queued: each queued request is checked where it is
   * queued.
   */
  const SEND_PATHS: Record<string, { calls: number; slugs: string[]; resendsQueued?: true }> = {
    'server/services/auth-email.ts': { calls: 1, slugs: ['email_verify', 'password_reset'] },
    'server/services/verification/service.ts': { calls: 2, slugs: ['verification_code'] },
    'server/services/invitations/worker.ts': { calls: 2, slugs: ['invite_otp', 'invite_member'] },
    'server/routes/adminEmailProviders.ts': { calls: 1, slugs: ['email_test'] },
    'server/routes/email.ts': { calls: 1, slugs: ['email_test'] },
    'server/services/visitorTranscript.ts': { calls: 1, slugs: ['visitor_conversation_transcript'] },
    'server/services/widget/offlineNotice.ts': { calls: 3, slugs: ['offline_message_received', 'offline_messages_summary'] },
    'server/services/notificationEmail/dispatcher.ts': {
      calls: 1,
      slugs: ['operator_unread_digest', 'operator_conversation_transcript', 'operator_invoice_paid', 'operator_weekly_summary', 'operator_product_update'],
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
  /** A reading of a request that always names a template, all of it followed. */
  const templated = (r: Reading) => !r.bare && !r.unread.length && r.slugs.length > 0;

  it('the reading of a send call finds a request that names no template (the check can fail)', () => {
    const probe = (...lines: string[]) => {
      const src = bind('server/services/probe/probe.ts', lines.join('\n'));
      const sends = sendsIn(src);
      return { sends, readings: sends.calls.map((c) => readRequest(src, c.arguments[1])) };
    };
    const bare = probe(
      "import { sendEmail } from '../email/index.js';",
      'function own(config) {',
      "  const request = { to: 'a@b.example', subject: 'S', html: `<p>${x}</p>` };",
      '  return sendEmail(config, request);',
      '}',
      // Its callers are in other files: what they pass is out of sight.
      'export function passOn(config, request) { return sendEmail(config, request); }',
    );
    expect(bare.readings.map(templated)).toEqual([false, false]);
    expect(bare.readings[1].unread[0]).toMatch(/probe\.ts:6: request: a parameter of passOn, which is exported/);
    // Strings and comments with commas, quotes or brackets in them are read as what they are.
    const tricky = probe(
      "import { sendEmail } from '../email/index.js';",
      "sendEmail(config /* the platform's (default) */, { subject: 'a, b', html: `<p>${f('x)')}</p>`, templateSlug: 'email_test' });",
    );
    expect(tricky.readings.map((r) => r.slugs)).toEqual([['email_test']]);
    // One caller of a local helper names a template and one does not: not every mail has one.
    const helper = (second: string) => probe(
      "import { enqueueEmail } from '../email/outbox.js';",
      'async function named(config, request) { await enqueueEmail(config, request, {}); }',
      "named(config, { templateSlug: 'billing_renewed', to });",
      `named(config, ${second});`,
    );
    expect(helper("{ to, subject: 'bare' }").readings.map(templated)).toEqual([false]);
    expect(helper("{ to, templateSlug: 'billing_expired' }").readings.map((r) => [...r.slugs].sort())).toEqual([['billing_expired', 'billing_renewed']]);
    // An arrow helper's parameter is that parameter, not another function's const of the same name.
    const arrow = probe(
      "import { sendEmail } from '../email/index.js';",
      "function other(config) { const request = { templateSlug: 'billing_renewed', to }; return enqueue(config, request); }",
      'const sendNow = (config, request) => sendEmail(config, request);',
      "export function reminder(config) { return sendNow(config, { to, subject: 'Reminder', html: '<p>bare</p>' }); }",
    );
    expect(arrow.readings.map(templated)).toEqual([false]);
    expect(arrow.readings[0].bare).toBe(true);
    // A sender imported under another name, or reached through its module,
    // still sends; one handed on as a value hides its sends.
    const alias = probe(
      "import { sendEmail as deliverMail } from '../email/index.js';",
      "import * as mail from '../email/index.js';",
      "deliverMail(config, { workspaceId: null, to, subject: 'Hello', html: '<p>bare</p>' });",
      "mail.sendPlatformEmail(config, { to, templateSlug: 'email_test' });",
      'retry(deliverMail);',
      'register(mail);',
      'type Send = typeof deliverMail;',
    );
    expect(alias.sends.reaches).toBe(true);
    expect(alias.readings.map(templated)).toEqual([false, true]);
    expect(alias.sends.unread).toEqual([
      'server/services/probe/probe.ts:5: deliverMail is used other than called',
      "server/services/probe/probe.ts:6: the email core's module is handed on as a value",
    ]);
    // So does one imported on demand.
    const dynamic = probe(
      'export async function later(config) {',
      "  const { enqueueEmail: queue } = await import('../email/outbox.js');",
      "  const [, core] = await Promise.all([import('../config.js'), import('../email/index.js')]);",
      "  await queue(config, { to, subject: 'bare' });",
      "  await core.sendEmail(config, { to, templateSlug: 'email_test' });",
      "  await (await import('../email/index.js')).sendEmail(config, { to, templateSlug: 'email_test' });",
      '}',
    );
    expect(dynamic.sends.unread).toEqual([]);
    expect(dynamic.readings.map(templated)).toEqual([false, true, true]);
    // Every template a send can name is read: each member of a map indexed by
    // a key (one more kind is one more template), a slug parameter's union type.
    const slugs = probe(
      "import { sendEmail } from '../email/index.js';",
      "const LINKS = { verify: { slug: 'email_verify' }, change: { slug: 'email_change_confirm' } } as const;",
      "type Slug = 'billing_renewed' | 'billing_expired';",
      'export function link(config, kind) { const l = LINKS[kind]; return sendEmail(config, { to, templateSlug: l.slug }); }',
      'export function billing(config, slug: Slug) { return sendEmail(config, { to, templateSlug: slug }); }',
    );
    expect(slugs.readings.map((r) => [...r.slugs].sort())).toEqual([['email_change_confirm', 'email_verify'], ['billing_expired', 'billing_renewed']]);
  });

  it('every file that sends is listed, with each of its sends', () => {
    const found: Record<string, number> = {};
    const unreadUses: string[] = [];
    for (const file of coreImporters(ROOTS.flatMap(sourceFiles))) {
      const sends = sendsIn(sourceOf(file));
      unreadUses.push(...sends.unread);
      if (sends.reaches) found[file] = sends.calls.length;
    }
    expect(unreadUses, 'a use of the email core this check cannot follow').toEqual([]);
    expect(found, 'a new send path: give it a templateSlug and list it in SEND_PATHS').toEqual(
      Object.fromEntries(Object.entries(SEND_PATHS).map(([file, p]) => [file, p.calls])),
    );
  });

  it.each(Object.entries(SEND_PATHS).filter(([, p]) => !p.resendsQueued))('%s: every send names its template, and sends only the ones listed', (file, path) => {
    const src = sourceOf(file);
    const sent = new Set<string>();
    for (const call of sendsIn(src).calls) {
      const request = call.arguments[1];
      expect(request, `${where(src, call)} hands over no request`).toBeDefined();
      const reading = readRequest(src, request);
      expect(reading.unread, `${where(src, call)}: the check cannot tell which template it sends`).toEqual([]);
      expect(reading.bare, `${where(src, call)} can send ${request.getText(src.sf).slice(0, 80)} without a templateSlug`).toBe(false);
      for (const slug of reading.slugs) sent.add(slug);
    }
    expect([...sent].sort(), `${file} sends these templates`).toEqual([...path.slugs].sort());
  });

  it('the outbox sends only what was queued, as it was queued', () => {
    const outbox = sourceOf('server/services/email/outbox.ts');
    expect(sendsIn(outbox).calls.map((c) => c.arguments[1].getText(outbox.sf))).toEqual(['request', 'request']);
    // The queued payload, opened (processRow), or the caller's own request, tried once first (sendEmailWithRetry).
    const src = read('server/services/email/outbox.ts');
    expect(src).toMatch(/const request = openRequest\(config, row\.payload\);/);
    expect(src).toMatch(/export async function sendEmailWithRetry\(\s*config: ServerConfig,\s*request: EmailRequest,/);
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
