// @vitest-environment node
/**
 * The email template catalog (server/services/email/templateCatalog.ts) is
 * the one list of every template the platform keeps, and Super Admin →
 * Branding → Email templates is drawn from it. The owner's rule — every
 * email has a template, every template is viewable there — holds only while
 * the list is true, so this reads the senders:
 *
 *   - every slug a sender names is in the catalog as `sent`, and every
 *     `sent` slug has a sender: a new mail, or a new way of naming one,
 *     fails here until the catalog knows it;
 *   - each sent slug's keys in the catalog are the ones its senders fill,
 *     read from their own code (the request's templateData and
 *     localizedData, each billing mail's values, each operator notice's
 *     payload through the dispatcher's fill): a key a sender drops or
 *     renames, or a new one, fails here;
 *   - the slugs nothing sends are listed as `legacy`, never left out;
 *   - each sent slug's sample values are exactly the catalog's keys, in
 *     every language and both editions, and name no brand (the core fills
 *     {brand}); the operator notices keep their {{double}} braces;
 *   - every template has a name and a description in en, fa and tr.
 *
 * That each `sent` slug is seeded for both editions in fa, en and tr, and
 * that its rows print only the catalog's keys, is checked against a real
 * migration chain by integration/emailTemplatesRedesign291.pg.test.ts, which
 * takes its list from the catalog.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import {
  CORE_TEMPLATE_KEYS,
  EMAIL_TEMPLATE_CATALOG,
  catalogEntry,
  catalogView,
  isSentTemplate,
  sampleTemplateData,
  templateVariables,
} from '../../../server/services/email/templateCatalog.js';
import { NOTIFICATION_EMAILS, type NotificationEmailType } from '../../../server/services/notificationEmail/types.js';
import { templateValues } from '../../../server/services/notificationEmail/dispatcher.js';
import { TRANSCRIPT_TEMPLATE_SLUG } from '../../../server/services/visitorTranscript.js';

function read(path: string): string {
  return readFileSync(path, 'utf8');
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (['node_modules', 'dist'].includes(name)) continue;
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

/** The members of a string-literal union or object list in a file, between two markers. */
function literalsBetween(path: string, start: string, end: string): string[] {
  const source = read(path);
  const from = source.indexOf(start);
  expect(from, `${path}: ${start}`).toBeGreaterThan(-1);
  const to = source.indexOf(end, from);
  return [...source.slice(from, to).matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
}

/**
 * Every way a sender names a template today, and the slugs each can name.
 * A `templateSlug:` written any other way is a sender this test does not
 * know: it fails until it is added here (and its slug to the catalog).
 */
const INDIRECTIONS: Record<string, { file: string; slugs: () => string[] }> = {
  'definition.slug': {
    file: 'server/services/notificationEmail/dispatcher.ts',
    slugs: () => Object.values(NOTIFICATION_EMAILS).map((d) => d.slug),
  },
  'link.slug': {
    file: 'server/services/auth-email.ts',
    slugs: () => literalsBetween('server/services/auth-email.ts', 'const AUTH_LINKS = {', '} as const;').filter((s) => s.includes('_') && !s.startsWith('auth_')),
  },
  slug: {
    file: 'server/services/billing/account/notify.ts',
    slugs: () => literalsBetween('server/services/billing/account/notify.ts', 'export type BillingEmailSlug =', ';'),
  },
  TRANSCRIPT_TEMPLATE_SLUG: {
    file: 'server/services/visitorTranscript.ts',
    slugs: () => [TRANSCRIPT_TEMPLATE_SLUG],
  },
};
/** Pass a slug through rather than name one: the core's outbox, and Super Admin's test of any catalog template. */
const PASS_THROUGH: Record<string, string> = {
  'request.templateSlug': 'server/services/email/outbox.ts',
  'input.slug': 'server/services/email/templateAdmin.ts',
};

function sentByCode(): { slugs: Set<string>; unknown: string[] } {
  const slugs = new Set<string>();
  const unknown: string[] = [];
  const files = [...sourceFiles('server'), ...sourceFiles('worker')].filter((f) => f !== join('server/services/email/index.ts'));
  for (const file of files) {
    for (const m of read(file).matchAll(/templateSlug:\s*([^,;\n}]+)/g)) {
      const named = m[1].trim();
      const literal = /^'([a-z_]+)'$/.exec(named);
      if (literal) {
        slugs.add(literal[1]);
        continue;
      }
      const indirection = INDIRECTIONS[named];
      if (indirection && indirection.file === file) {
        for (const slug of indirection.slugs()) slugs.add(slug);
        continue;
      }
      if (PASS_THROUGH[named] === file) continue;
      unknown.push(`${file}: templateSlug: ${named}`);
    }
  }
  return { slugs, unknown };
}

// ─── The keys each sender fills, read from its own code ────────────────────

/**
 * The keys a sender fills: in every send (`always`), or only in some (`maybe`:
 * spread in under a condition). A shape the reading does not know fails with
 * its place and text rather than counting as no keys, so a sender written
 * another way is noticed here, not passed.
 */
interface Filled { always: Set<string>; maybe: Set<string> }

const none = (): Filled => ({ always: new Set(), maybe: new Set() });
const everyKey = (f: Filled) => new Set([...f.always, ...f.maybe]);

function merged(...parts: Filled[]): Filled {
  const out = none();
  for (const part of parts) {
    part.always.forEach((k) => out.always.add(k));
    part.maybe.forEach((k) => out.maybe.add(k));
  }
  for (const k of out.always) out.maybe.delete(k);
  return out;
}

/** One of several shapes (a condition's two sides, a function's returns): always there only when each has it. */
function eitherOf(...shapes: Filled[]): Filled {
  const always = new Set([...shapes[0].always].filter((k) => shapes.every((s) => s.always.has(k))));
  return { always, maybe: new Set(shapes.flatMap((s) => [...everyKey(s)]).filter((k) => !always.has(k))) };
}

const parsed = new Map<string, ts.SourceFile>();
function sourceOf(file: string): ts.SourceFile {
  if (!parsed.has(file)) parsed.set(file, ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true, ts.ScriptKind.TS));
  return parsed.get(file)!;
}

function placeOf(node: ts.Node): string {
  const file = node.getSourceFile();
  return `${file.fileName}:${file.getLineAndCharacterOfPosition(node.getStart()).line + 1}`;
}

function unread(node: ts.Node): never {
  throw new Error(`${placeOf(node)}: the keys of \`${node.getText().slice(0, 120)}\` cannot be read; teach this test the shape`);
}

function bare(node: ts.Expression): ts.Expression {
  let out = node;
  while (ts.isParenthesizedExpression(out) || ts.isAsExpression(out) || ts.isSatisfiesExpression(out) || ts.isNonNullExpression(out)) out = out.expression;
  return out;
}

function nodesIn<T extends ts.Node>(root: ts.Node, test: (node: ts.Node) => node is T): T[] {
  const out: T[] = [];
  const visit = (node: ts.Node) => {
    if (test(node)) out.push(node);
    ts.forEachChild(node, visit);
  };
  visit(root);
  return out;
}

/** What `name` is where `at` reads it: the nearest const or function of that name in a block around it. */
function definitionOf(name: string, at: ts.Node): ts.Expression | ts.FunctionDeclaration | null {
  for (let scope: ts.Node | undefined = at.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (ts.isFunctionDeclaration(statement) && statement.name?.text === name) return statement;
      if (!ts.isVariableStatement(statement)) continue;
      for (const d of statement.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.name.text === name && d.initializer) return d.initializer;
      }
    }
  }
  return null;
}

/** What a function of the sender's own file returns: its expression body, or each of its own `return`s. */
function returnedBy(fn: ts.Node | null, at: ts.Node): ts.Expression[] {
  if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn) || ts.isFunctionDeclaration(fn)) && fn.body) {
    if (!ts.isBlock(fn.body)) return [fn.body];
    const returns: ts.Expression[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isReturnStatement(node) && node.expression) returns.push(node.expression);
      else if (!ts.isFunctionLike(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(fn.body, visit);
    if (returns.length) return returns;
  }
  return unread(at);
}

function calledFunction(call: ts.CallExpression): ts.Node | null {
  return ts.isIdentifier(call.expression) ? definitionOf(call.expression.text, call) : null;
}

function nameOf(name: ts.PropertyName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : unread(name);
}

/** The value of an object literal's property, a shorthand one included. */
function propertyOf(object: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const p of object.properties) {
    if (ts.isPropertyAssignment(p) && nameOf(p.name) === name) return p.initializer;
    if (ts.isShorthandPropertyAssignment(p) && p.name.text === name) return p.name;
  }
  return undefined;
}

/** The keys of an object a sender builds: its own properties, its spreads, and what a const or a local function holds. */
function keysOf(node: ts.Expression): Filled {
  const expr = bare(node);
  if (ts.isObjectLiteralExpression(expr)) {
    const own = none();
    const spreads: Filled[] = [];
    for (const p of expr.properties) {
      if (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) own.always.add(nameOf(p.name));
      else if (ts.isSpreadAssignment(p)) spreads.push(keysOf(p.expression));
      else unread(p);
    }
    return merged(own, ...spreads);
  }
  if (ts.isConditionalExpression(expr)) return eitherOf(keysOf(expr.whenTrue), keysOf(expr.whenFalse));
  if (ts.isIdentifier(expr)) {
    const definition = definitionOf(expr.text, expr);
    return definition && !ts.isFunctionDeclaration(definition) ? keysOf(definition) : unread(expr);
  }
  if (ts.isCallExpression(expr)) return eitherOf(...returnedBy(calledFunction(expr), expr).map(keysOf));
  // One language's set of a per-language map (testMail.ts: localizedData[own]).
  if (ts.isElementAccessExpression(expr)) return keysPerLanguage(expr.expression);
  return unread(expr);
}

/** The keys of a per-language map ({ fa: {…}, en: {…} }, or built over a list of languages): what each language's set has. */
function keysPerLanguage(node: ts.Expression): Filled {
  const expr = bare(node);
  if (ts.isObjectLiteralExpression(expr)) {
    return eitherOf(...expr.properties.map((p) => (ts.isPropertyAssignment(p) ? keysOf(p.initializer) : unread(p))));
  }
  if (ts.isIdentifier(expr)) {
    const definition = definitionOf(expr.text, expr);
    return definition && !ts.isFunctionDeclaration(definition) ? keysPerLanguage(definition) : unread(expr);
  }
  if (ts.isCallExpression(expr) && expr.expression.getText() === 'Object.fromEntries') {
    // Object.fromEntries(LANGUAGES.map((lc) => [lc, value]))
    const list = bare(expr.arguments[0]);
    const each = ts.isCallExpression(list) && ts.isPropertyAccessExpression(list.expression) && list.expression.name.text === 'map' ? list.arguments[0] : undefined;
    const pair = each && ts.isArrowFunction(each) && !ts.isBlock(each.body) ? bare(each.body) : undefined;
    return pair && ts.isArrayLiteralExpression(pair) && pair.elements.length === 2 ? keysOf(pair.elements[1]) : unread(expr);
  }
  // A number in each language (email/layout.ts localNumbers({ minutes })): every set has the object's keys.
  if (ts.isCallExpression(expr) && expr.expression.getText() === 'localNumbers' && expr.arguments.length === 1) return keysOf(expr.arguments[0]);
  if (ts.isCallExpression(expr)) return eitherOf(...returnedBy(calledFunction(expr), expr).map(keysPerLanguage));
  return unread(expr);
}

/** One place that sends a template: the slugs it can send, the keys it fills, and the HTML part's own values. */
interface Sender { at: string; slugs: string[]; filled: Filled; html: Set<string> }

const SENDER_FILES = () => [...sourceFiles('server'), ...sourceFiles('worker')].filter((f) => f !== join('server/services/email/index.ts'));

/** The senders whose keys are not in the request they build: each billing mail's call, each notice's payload. */
const KEYS_ELSEWHERE: Record<string, string> = {
  'server/services/billing/account/notify.ts': 'sendBillingEmail',
  'server/services/notificationEmail/dispatcher.ts': 'enqueueNotificationEmail',
};

/** Every request literal that names its template (`templateSlug`), read where it is built. */
function requestSenders(): Sender[] {
  const out: Sender[] = [];
  for (const file of SENDER_FILES()) {
    if (!read(file).includes('templateSlug') || KEYS_ELSEWHERE[file]) continue;
    for (const request of nodesIn(sourceOf(file), ts.isObjectLiteralExpression)) {
      const slug = propertyOf(request, 'templateSlug');
      if (!slug) continue;
      const named = bare(slug);
      if (PASS_THROUGH[named.getText()] === file) continue;
      const indirection = INDIRECTIONS[named.getText()];
      const slugs = ts.isStringLiteral(named) ? [named.text] : indirection?.file === file ? indirection.slugs() : unread(named);
      const data = propertyOf(request, 'templateData');
      const localized = propertyOf(request, 'localizedData');
      const html = propertyOf(request, 'htmlData');
      out.push({
        at: placeOf(request),
        slugs,
        filled: merged(data ? keysOf(data) : none(), localized ? keysPerLanguage(localized) : none()),
        html: html ? everyKey(keysOf(html)) : new Set(),
      });
    }
  }
  return out;
}

/** The slugs a billing call can send: a literal, or a const of literals (a choice between them included). */
function billingSlugs(node: ts.Expression): string[] {
  const expr = bare(node);
  if (ts.isStringLiteral(expr)) return [expr.text];
  const definition = ts.isIdentifier(expr) ? definitionOf(expr.text, expr) : null;
  const literals = definition && !ts.isFunctionDeclaration(definition) ? nodesIn(definition, ts.isStringLiteral).map((l) => l.text) : [];
  return literals.length && literals.every((l) => l.startsWith('billing_')) ? literals : unread(expr);
}

/** What sendBillingEmail adds to every billing mail's values (notify.ts): the request's own keys around `...build(ctx)`. */
function billingBase(): string[] {
  const file = 'server/services/billing/account/notify.ts';
  const fn = nodesIn(sourceOf(file), ts.isFunctionDeclaration).find((f) => f.name?.text === 'sendBillingEmail');
  const data = fn && nodesIn(fn, ts.isVariableDeclaration).find((d) => ts.isIdentifier(d.name) && d.name.text === 'data')?.initializer;
  if (!fn || !data || !ts.isObjectLiteralExpression(data)) throw new Error(`${file}: sendBillingEmail's values are not read`);
  const spreads = data.properties.filter(ts.isSpreadAssignment).map((p) => p.expression.getText());
  expect(spreads, `${file}: the build's values go in once`).toEqual(['build(ctx)']);
  // Every value goes in the request, and into the HTML part escaped.
  expect(fn.getText()).toMatch(/templateData: data,\s*(\/\/[^\n]*\n\s*)*htmlData: Object\.fromEntries\(Object\.entries\(data\)/);
  return data.properties.filter((p) => !ts.isSpreadAssignment(p)).map((p) => (p.name ? nameOf(p.name) : unread(p)));
}

/** Every billing mail: each sendBillingEmail call, with its build's values and what notify.ts adds to them. */
function billingSenders(): Sender[] {
  const base = billingBase();
  const receipt = /if \(options\.receiptLedgerId\) \{\s*data\.receipt_url = /.test(read('server/services/billing/account/notify.ts'));
  expect(receipt, 'notify.ts adds {receipt_url} for a receipt ledger id').toBe(true);
  const out: Sender[] = [];
  for (const file of SENDER_FILES()) {
    if (!read(file).includes('sendBillingEmail(')) continue;
    for (const call of nodesIn(sourceOf(file), ts.isCallExpression)) {
      if (!ts.isIdentifier(call.expression) || call.expression.text !== 'sendBillingEmail') continue;
      const [, , slug, build, options] = call.arguments;
      const values = build ? bare(build) : unread(call);
      const extra = options && ts.isObjectLiteralExpression(bare(options)) && propertyOf(bare(options) as ts.ObjectLiteralExpression, 'receiptLedgerId')
        ? ['receipt_url'] : [];
      const filled = merged({ always: new Set([...base, ...extra]), maybe: new Set() }, eitherOf(...returnedBy(values, call).map(keysOf)));
      out.push({ at: placeOf(call), slugs: billingSlugs(slug), filled, html: everyKey(filled) });
    }
  }
  return out;
}

/**
 * Every operator notice: each enqueueNotificationEmail call's payload, filled
 * the dispatcher's own way (templateValues: {{name}} added, each value as
 * text, the transcript made from its lines).
 */
function noticeSenders(): Sender[] {
  expect(read('server/services/notificationEmail/dispatcher.ts')).toMatch(
    /const \{ templateData, htmlData \} = templateValues\(job\.payload, [^)]*\);[\s\S]*templateSlug: definition\.slug,\s*templateData,\s*htmlData,/,
  );
  const filledBy = (keys: Set<string>) => {
    const payload = Object.fromEntries([...keys].map((k) => [k, k === 'transcript_lines' ? ['← a line'] : 'x']));
    const { templateData, htmlData } = templateValues(payload, 'A name', 'en');
    return { data: Object.keys(templateData), html: Object.keys(htmlData) };
  };
  const out: Sender[] = [];
  for (const file of SENDER_FILES()) {
    if (!read(file).includes('enqueueNotificationEmail(')) continue;
    for (const call of nodesIn(sourceOf(file), ts.isCallExpression)) {
      if (!ts.isIdentifier(call.expression) || call.expression.text !== 'enqueueNotificationEmail') continue;
      const job = call.arguments[1] ? bare(call.arguments[1]) : unread(call);
      const type = ts.isObjectLiteralExpression(job) ? propertyOf(job, 'type') : undefined;
      const payload = ts.isObjectLiteralExpression(job) ? propertyOf(job, 'payload') : undefined;
      if (!type || !ts.isStringLiteral(type) || !payload) unread(job);
      const keys = keysOf(payload);
      const always = new Set(filledBy(keys.always).data);
      const every = filledBy(everyKey(keys));
      out.push({
        at: placeOf(call),
        slugs: [NOTIFICATION_EMAILS[type.text as NotificationEmailType].slug],
        filled: { always, maybe: new Set(every.data.filter((k) => !always.has(k))) },
        html: new Set(every.html),
      });
    }
  }
  return out;
}

/**
 * A catalog key some sends of its slug leave out, and why that is right.
 * Every other catalog key is filled by every send.
 */
const SOMETIMES: Record<string, string[]> = {
  // The renewal's card is spread in when the saved card paid, which is
  // also what chooses this slug (billing/account/plans.ts afterPlanChange).
  billing_card_renewed: ['card'],
};

const SENT = EMAIL_TEMPLATE_CATALOG.filter((e) => e.status === 'sent');
const LEGACY = EMAIL_TEMPLATE_CATALOG.filter((e) => e.status === 'legacy');
const LOCALES = { en, fa, tr } as const;

function resolves(locale: unknown, path: string): boolean {
  let current: unknown = locale;
  for (const part of path.split('.')) {
    if (current == null || typeof current !== 'object') return false;
    current = (current as Record<string, unknown>)[part];
  }
  return typeof current === 'string' && current.trim() !== '';
}

describe('the email template catalog', () => {
  it('names every slug once', () => {
    const slugs = EMAIL_TEMPLATE_CATALOG.map((e) => e.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('knows every way a sender names a template', () => {
    expect(sentByCode().unknown).toEqual([]);
  });

  it('has every slug the code sends as sent, and nothing sent that no sender sends', () => {
    const { slugs } = sentByCode();
    expect(slugs.size).toBeGreaterThanOrEqual(28);
    expect([...slugs].sort()).toEqual(SENT.map((e) => e.slug).sort());
    for (const slug of slugs) expect(isSentTemplate(slug), slug).toBe(true);
  });

  it('lists the slugs nothing sends as legacy: the hosted seed\'s six and billing v2\'s twelve', () => {
    expect(LEGACY.map((e) => e.slug).sort()).toEqual([
      'account_expiry', 'invoice_due', 'invoice_issued', 'invoice_past_due', 'invoice_reminder', 'magic_link', 'new_conversation',
      'payment_failed', 'payment_received', 'payment_success', 'subscription_cancelled', 'subscription_free_fallback',
      'subscription_renewed', 'subscription_restored', 'system_alert', 'task_assigned', 'wallet_autopay_insufficient', 'welcome',
    ]);
    for (const entry of LEGACY) {
      expect(isSentTemplate(entry.slug)).toBe(false);
      expect(templateVariables(entry)).toEqual(['{brand}', '{year}', '{support_email}']);
      expect(sampleTemplateData(entry.slug, { edition: 'iran', locale: 'fa', appUrl: '' })).toEqual({ data: {} });
    }
    expect(catalogEntry('no_such_template')).toBeNull();
  });

  it('sends the saved card\'s mails in the International edition only', () => {
    const card = SENT.filter((e) => e.slug.startsWith('billing_card_')).map((e) => e.slug).sort();
    expect(card).toEqual(['billing_card_payment_failed', 'billing_card_removed', 'billing_card_renewed']);
    for (const entry of SENT) {
      expect([...entry.editions], entry.slug).toEqual(card.includes(entry.slug) ? ['international'] : ['iran', 'international']);
    }
    const iran = catalogView('iran');
    expect(iran.filter((v) => v.status === 'sent' && !v.sentInEdition).map((v) => v.slug).sort()).toEqual(card);
    expect(catalogView('international').filter((v) => v.status === 'sent' && !v.sentInEdition)).toEqual([]);
  });

  it('writes the operator notices\' placeholders with double braces, every other one with single', () => {
    for (const entry of SENT) {
      const operator = entry.slug.startsWith('operator_');
      for (const v of templateVariables(entry)) expect(v, entry.slug).toMatch(operator ? /^\{\{[a-z_]+\}\}$/ : /^\{[a-z_]+\}$/);
      expect(templateVariables(entry).slice(-3), entry.slug).toEqual(CORE_TEMPLATE_KEYS.map((k) => (operator ? `{{${k}}}` : `{${k}}`)));
    }
  });

  it('gives a notification its unsubscribe line\'s type, and service mail none', () => {
    for (const entry of SENT) {
      const notice = entry.slug.startsWith('operator_') || entry.slug.startsWith('offline_');
      expect(entry.footer !== null, entry.slug).toBe(notice);
      expect(entry.kind, entry.slug).toBe(entry.slug === 'operator_product_update' ? 'marketing' : notice ? 'notification' : 'transactional');
    }
  });

  it('has a name and a description for every template in en, fa and tr', () => {
    for (const [name, locale] of Object.entries(LOCALES)) {
      for (const entry of EMAIL_TEMPLATE_CATALOG) {
        expect(resolves(locale, `admin.brandingPage.emailTemplates.slugs.${entry.slug}`), `${name} ${entry.slug}`).toBe(true);
        expect(resolves(locale, entry.descriptionKey), `${name} ${entry.descriptionKey}`).toBe(true);
      }
    }
    const persian = EMAIL_TEMPLATE_CATALOG.map((e) => e.descriptionKey.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], fa));
    expect(persian.join('\n')).not.toMatch(/[يك]/);
  });

  it('sends the Super Admin to each menu by the name the menu has', () => {
    for (const [name, locale] of Object.entries(LOCALES)) {
      const { nav } = locale.admin;
      const arrow = name === 'fa' ? '←' : '→';
      expect(locale.admin.brandingPage.emailTemplates.descriptions.email_test, name).toContain(nav.providers);
      expect(locale.admin.brandingPage.identity.errorNoStorage, name).toContain(`${nav.providers} ${arrow} ${locale.adminProviders.types.storage.label}`);
      expect(locale.admin.notifications.email.providerMissing, name).toContain(`${nav.providers} ${arrow} `);
      expect(locale.admin.verification.preview.emailTemplateNote, name).toContain(`${nav.branding} ${arrow} ${locale.admin.brandingPage.tabs.emailTemplates}`);
    }
  });
});

describe('the keys of each sent template', () => {
  const senders = () => [...requestSenders(), ...billingSenders(), ...noticeSenders()];

  it('are read from a sender of every sent slug', () => {
    const read = senders();
    expect(read.length).toBeGreaterThanOrEqual(20);
    expect([...new Set(read.flatMap((s) => s.slugs))].sort()).toEqual(SENT.map((e) => e.slug).sort());
  });

  it('are exactly the ones its senders fill: none the catalog lacks, none a sender leaves out', () => {
    for (const sender of senders()) {
      for (const slug of sender.slugs) {
        const keys = catalogEntry(slug)?.keys ?? [];
        const filled = everyKey(sender.filled);
        const at = `${sender.at} (${slug})`;
        expect([...sender.filled.always].filter((k) => !keys.includes(k)), `${at}: filled, not in the catalog`).toEqual([]);
        expect(keys.filter((k) => !filled.has(k)), `${at}: in the catalog, never filled (the mail would print it as written)`).toEqual([]);
        expect(keys.filter((k) => sender.filled.maybe.has(k)), `${at}: in the catalog, filled only sometimes`).toEqual(SOMETIMES[slug] ?? []);
        expect([...sender.html].filter((k) => !filled.has(k)), `${at}: an HTML-only value`).toEqual([]);
      }
    }
  });

  it('are read as a sender writes them, and an unknown shape fails rather than counting as none', () => {
    const snippet = (code: string) => {
      const file = ts.createSourceFile('snippet.ts', code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
      const object = nodesIn(file, ts.isObjectLiteralExpression).find((o) => propertyOf(o, 'templateSlug'));
      return keysOf(propertyOf(object!, 'templateData')!);
    };
    const filled = snippet([
      'function send(card, own) {',
      '  const values = { amount: 1 };',
      '  const words = (lc) => ({ role: lc, ...(own ? {} : { inviter: lc }) });',
      "  return sendEmail(config, { templateSlug: 'x', templateData: { name: 'a', ...values, ...words('en'), ...(card ? { card } : {}) } });",
      '}',
    ].join('\n'));
    expect([...filled.always].sort()).toEqual(['amount', 'name', 'role']);
    expect([...filled.maybe].sort()).toEqual(['card', 'inviter']);
    expect(() => snippet("function send(build) { return sendEmail(config, { templateSlug: 'x', templateData: build() }); }")).toThrow(/cannot be read/);
  });
});

describe('the sample values', () => {
  const NOW = new Date('2026-10-30T10:24:00Z');
  const cases = (['iran', 'international'] as const).flatMap((edition) => (['fa', 'en', 'tr'] as const).map((locale) => ({ edition, locale })));

  it('are exactly the catalog\'s keys (the ones each sender fills), in every language of both editions', () => {
    for (const { edition, locale } of cases) {
      for (const entry of SENT) {
        const sample = sampleTemplateData(entry.slug, { edition, locale, appUrl: 'https://app.example.com', now: NOW });
        const at = `${edition}/${locale}/${entry.slug}`;
        expect(Object.keys(sample.data).sort(), at).toEqual([...entry.keys].sort());
        for (const key of Object.keys(sample.htmlData ?? {})) expect(entry.keys, `${at} htmlData.${key}`).toContain(key);
        for (const [key, value] of Object.entries(sample.data)) {
          // The visitor's own words reach the offline notice's HTML part only (offlineNotice.ts).
          if (entry.slug === 'offline_message_received' && /^(contact_|message_body)/.test(key)) {
            expect(value, `${at} ${key}`).toBe('');
            expect(sample.htmlData?.[key], `${at} htmlData.${key}`).toBeTruthy();
            continue;
          }
          expect(value, `${at} ${key}`).toBeTruthy();
        }
      }
    }
  });

  it('name no brand: the core fills {brand}, and the links are on the platform\'s own address', () => {
    for (const { edition, locale } of cases) {
      for (const entry of SENT) {
        const sample = sampleTemplateData(entry.slug, { edition, locale, appUrl: 'https://app.example.com', now: NOW });
        const all = JSON.stringify(sample);
        expect(all, entry.slug).not.toMatch(/webyar|respok|وب.?یار|رسپاک/i);
        for (const url of all.match(/https?:\/\/[^"\s\\<]+/g) ?? []) expect(url, entry.slug).toMatch(/^https:\/\/app\.example\.com\//);
      }
    }
  });

  it('are the edition\'s own: Toman and the Persian calendar in the Iranian edition, dollars in the International one', () => {
    const iran = sampleTemplateData('billing_payment_receipt', { edition: 'iran', locale: 'fa', appUrl: '', now: NOW }).data;
    expect(iran.amount).toMatch(/تومان$/);
    const intl = sampleTemplateData('billing_payment_receipt', { edition: 'international', locale: 'en', appUrl: '', now: NOW }).data;
    expect(intl.amount).toBe('$50.00');
    expect(intl.receipt_url).toBe('/blue-store/billing/receipts/R-7001');
    const date = sampleTemplateData('billing_trial_ending', { edition: 'iran', locale: 'fa', appUrl: '', now: NOW }).data.trial_end;
    expect(date).toMatch(/آبان|آذر/);
    // A code no real one can be, as the Verification preview says.
    expect(sampleTemplateData('verification_code', { edition: 'iran', locale: 'fa', appUrl: '' }).data.code).toBe('123456');
  });

  it('build the transcripts with the senders\' own rows', () => {
    const visitor = sampleTemplateData('visitor_conversation_transcript', { edition: 'international', locale: 'en', appUrl: '', now: NOW });
    expect(visitor.htmlData?.transcript).toMatch(/^<div class="msg msg-visitor"><div class="meta">You · [^<]+<\/div><div class="bubble" dir="auto">/);
    expect(visitor.htmlData?.transcript).toContain('<div class="msg msg-agent">');
    expect(visitor.data.transcript).toContain('You · ');
    const operator = sampleTemplateData('operator_conversation_transcript', { edition: 'iran', locale: 'fa', appUrl: '', now: NOW });
    // The dispatcher's rows: a notice (no bubble), then the customer's and the team's lines.
    expect(operator.htmlData?.transcript).toMatch(/^<div class="msg msg-agent"><div class="meta">[^<]+<\/div><\/div><div class="msg msg-visitor">/);
    expect(operator.data.name).toBe('سارا محمدی');
  });

  it('escape the HTML part\'s values', () => {
    const sample = sampleTemplateData('offline_message_received', { edition: 'international', locale: 'en', appUrl: '', now: NOW });
    expect(sample.htmlData?.message_body).toContain('hasn’t arrived yet.<br>Could you');
  });
});
