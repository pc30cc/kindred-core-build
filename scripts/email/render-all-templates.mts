/**
 * Renders the platform's email templates through the real email core — the
 * same fill, layout and brand a sent mail gets (renderEmailForPreview) — into
 * HTML and text files, screenshots and contact sheets, to look at a design
 * change before it ships. A development tool: nothing here runs in
 * production, nothing is sent, and a database it is pointed at is only read.
 *
 *   # the seeds of a fresh chain (a scratch database, built and dropped):
 *   npx tsx scripts/email/render-all-templates.mts --out /tmp/mails \
 *     --fresh postgresql://postgres:postgres@localhost:5432/postgres
 *
 *   # every row of a database (a restored copy, say), in its own edition:
 *   npx tsx scripts/email/render-all-templates.mts --out /tmp/mails --database "$URL"
 *
 *   # content in the design panel's samples shape, through the layout:
 *   npx tsx scripts/email/render-all-templates.mts --out /tmp/mails --samples samples.json
 *
 * Options:
 *   --edition iran|international   only that edition's rows
 *   --slug <slug>                  only that template
 *   --locale fa|en|tr              only that language
 *   --www <dir>                    another root for the brand hosts' files,
 *                                  after public/ (repeatable; e.g. logos not
 *                                  committed yet)
 *   --no-shots                     HTML and text only
 *   --chromium <path>              the Chromium to shoot with (default:
 *                                  Playwright's own)
 *   --no-web-fonts                 also shoot with the web fonts blocked
 *                                  (Gmail and Outlook never load them)
 *   --gmail-invert                 also shoot a rough model of Gmail's forced
 *                                  dark mode (the app inverts light colours
 *                                  and ignores the mail's own dark styles)
 *
 * The two brand hosts (https://app.webyar.ai, https://app.respok.app) are
 * served from this repo's public/ (logos, fonts) and every other request is
 * refused, as a mail client that blocks remote content would. Shots are
 * desktop (680 px) and mobile (375 px), light and dark; the sheets put them
 * side by side per edition.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import pg from 'pg';

type Edition = 'iran' | 'international';
type Category = 'transactional' | 'notification' | 'marketing';

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
};

const OUT = resolve(option('--out') ?? 'email-renders');
const ROOT = resolve(import.meta.dirname, '..', '..');
const WWW = [join(ROOT, 'public'), ...args.flatMap((a, i) => (a === '--www' && args[i + 1] ? [resolve(args[i + 1])] : []))];

/** The two brands as the renders show them: their own public names and hosts. */
const BRANDS: Record<Edition, { app: string; names: Record<string, string> }> = {
  iran: { app: 'https://app.webyar.ai', names: { fa: 'وب‌یار', en: 'Webyar', tr: 'Webyar' } },
  international: { app: 'https://app.respok.app', names: { fa: 'RESPOK', en: 'RESPOK', tr: 'RESPOK' } },
};
const HOSTS: Record<string, Edition> = { 'app.webyar.ai': 'iran', 'app.respok.app': 'international' };

/** Which switch of the operator's email preferences a notification's unsubscribe line names. */
const PREFERENCE_OF: Record<string, 'unread_messages' | 'transcripts' | 'paid_invoices' | 'weekly_summary' | 'product_updates' | 'offline_messages'> = {
  operator_unread_digest: 'unread_messages',
  operator_conversation_transcript: 'transcripts',
  operator_invoice_paid: 'paid_invoices',
  operator_weekly_summary: 'weekly_summary',
  operator_product_update: 'product_updates',
};

/** The mails a person subscribed to carry the unsubscribe line; the rest are service mail. */
function categoryOf(slug: string): Category {
  if (slug === 'operator_product_update') return 'marketing';
  if (slug.startsWith('operator_') || slug.startsWith('offline_')) return 'notification';
  return 'transactional';
}

/**
 * Sample values for a row's placeholders: the common keys in each language,
 * and any other key as itself in brackets, so an unfilled one is easy to
 * spot.
 */
const SAMPLES: Record<string, Record<string, string>> = {
  en: {
    name: 'Sara', code: '482917', minutes: '10', expiry_minutes: '10', expiry_time: '24 hours', workspace: 'Blue Store',
    workspace_name: 'Blue Store', inviter: 'Maria', role: 'Operator', expiry: 'November 6, 2026, 10:00', email: 'sara@example.com',
    amount: '$29.00', balance: '$1.50', plan_name: 'Pro', new_plan_name: 'Business', old_plan_name: 'Starter', period_start: 'October 30, 2026',
    period_end: 'November 30, 2026', days_left: '3', receipt_number: 'R-7001', card: '•••• 4242', count: '3', provider: 'smtp', slot: 'the platform email provider',
    sent_at: 'October 30, 2026, 10:24 UTC', date: 'October 30, 2026', contact_name: 'Sara Miller', contact_email: 'sara@example.com', contact_phone: '+1 415 555 0100',
    message_body: "Hi, my order hasn't arrived yet.",
  },
  fa: {
    name: 'سارا', code: '482917', minutes: '۱۰', expiry_minutes: '۱۰', expiry_time: '۲۴ ساعت', workspace: 'فروشگاه آبی',
    workspace_name: 'فروشگاه آبی', inviter: 'مریم', role: 'اپراتور', expiry: '۱۵ آبان ۱۴۰۵، ۱۰:۰۰', email: 'sara@example.com',
    amount: '۱٬۲۰۰٬۰۰۰ تومان', balance: '۳۵۰٬۰۰۰ تومان', plan_name: 'حرفه‌ای', new_plan_name: 'تجاری', old_plan_name: 'پایه', period_start: '۸ آبان ۱۴۰۵',
    period_end: '۸ آذر ۱۴۰۵', days_left: '۳', receipt_number: 'R-7001', card: '•••• 4242', count: '۳', provider: 'smtp', slot: 'سرویس ایمیل پلتفرم',
    sent_at: '۸ آبان ۱۴۰۵، ۱۰:۲۴ (UTC)', date: '۸ آبان ۱۴۰۵', contact_name: 'سارا محمدی', contact_email: 'sara@example.com', contact_phone: '+98 912 000 0000',
    message_body: 'سلام، سفارشم هنوز نرسیده.',
  },
  tr: {
    name: 'Sara', code: '482917', minutes: '10', expiry_minutes: '10', expiry_time: '24 saat', workspace: 'Mavi Mağaza',
    workspace_name: 'Mavi Mağaza', inviter: 'Ayşe', role: 'Operatör', expiry: '6 Kasım 2026 10:00', email: 'sara@example.com',
    amount: '₺1.200,00', balance: '₺50,00', plan_name: 'Pro', new_plan_name: 'İşletme', old_plan_name: 'Başlangıç', period_start: '30 Ekim 2026',
    period_end: '30 Kasım 2026', days_left: '3', receipt_number: 'R-7001', card: '•••• 4242', count: '3', provider: 'smtp', slot: 'platform e-posta sağlayıcısı',
    sent_at: '30 Ekim 2026 10:24 UTC', date: '30 Ekim 2026', contact_name: 'Sara Yılmaz', contact_email: 'sara@example.com', contact_phone: '+90 532 000 00 00',
    message_body: 'Merhaba, siparişim henüz gelmedi.',
  },
};

function sampleData(edition: Edition, locale: string, row: { subject: string; html_body: string; text_body: string | null }): Record<string, string> {
  const base = SAMPLES[locale] ?? SAMPLES.en;
  const app = BRANDS[edition].app;
  const links: Record<string, string> = {
    action_url: `${app}/blue-store/inbox?c=91`, billing_url: `${app}/blue-store/billing`, receipt_url: `${app}/blue-store/billing/receipts/R-7001`,
    export_url: `${app}/blue-store/settings/export`,
  };
  const out: Record<string, string> = {};
  for (const m of `${row.subject}\n${row.html_body}\n${row.text_body ?? ''}`.matchAll(/\{\{([^{}]+)\}\}|\{([^{}]+)\}/g)) {
    const key = (m[1] ?? m[2]).trim();
    if (key in out || ['brand', 'year', 'support_email'].includes(key)) continue;
    out[key] = links[key] ?? base[key] ?? `[${key}]`;
  }
  return out;
}

interface Row { edition: Edition; slug: string; locale: string; subject: string; html_body: string; text_body: string | null }
interface Rendered { edition: Edition; name: string; html: string; text: string }

async function rowsOf(url: string, where: { edition?: string; slug?: string; locale?: string }): Promise<Row[]> {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    await db.query('SET default_transaction_read_only = on');
    const { rows } = await db.query(
      `SELECT edition, slug, locale, subject, html_body, text_body FROM public.email_templates
        WHERE workspace_id IS NULL AND is_active
          AND ($1::text IS NULL OR edition = $1) AND ($2::text IS NULL OR slug = $2) AND ($3::text IS NULL OR locale = $3)
        ORDER BY edition, slug, locale`,
      [where.edition ?? null, where.slug ?? null, where.locale ?? null],
    );
    return rows as Row[];
  } finally {
    await db.end();
  }
}

/** A scratch database built by every migration file in order (scripts/migrate-database.sh's chain). */
async function freshChain(adminUrl: string): Promise<{ url: string; drop: () => Promise<void> }> {
  const { applyMigrationSql } = await import('../../src/test/integration/pgMigrationChain.js');
  const name = `email_render_${process.pid}`;
  const admin = new pg.Client({ connectionString: adminUrl });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name}`);
  await admin.query(`CREATE DATABASE ${name}`);
  const url = new URL(adminUrl);
  url.pathname = `/${name}`;
  const db = new pg.Client({ connectionString: url.toString() });
  await db.connect();
  await db.query('SET client_min_messages = warning');
  const dir = join(ROOT, 'database/migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    await applyMigrationSql(db, readFileSync(join(dir, file), 'utf8'));
  }
  await db.end();
  return {
    url: url.toString(),
    drop: async () => {
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

/** A scratch database's brand rows set to one brand's public values, so its renders wear that brand. */
async function wearBrand(url: string, edition: Edition): Promise<void> {
  const db = new pg.Client({ connectionString: url });
  await db.connect();
  try {
    const brand = BRANDS[edition];
    const site = edition === 'iran' ? 'https://webyar.ai' : 'https://respok.app';
    await db.query('DELETE FROM public.platform_domains');
    await db.query('INSERT INTO public.platform_domains (app_base_url, canonical_base_url) VALUES ($1, $2)', [brand.app, site]);
    for (const [locale, name] of Object.entries(brand.names)) {
      const updated = await db.query('UPDATE public.platform_branding_localized SET platform_name = $2 WHERE locale = $1', [locale, name]);
      if (!updated.rowCount) await db.query('INSERT INTO public.platform_branding_localized (locale, platform_name) VALUES ($1, $2)', [locale, name]);
    }
  } finally {
    await db.end();
  }
}

async function renderRows(rows: Row[]): Promise<Rendered[]> {
  // Imported only now: the core reads DATABASE_URL when it first connects.
  const { renderEmailForPreview } = await import('../../server/services/email/index.js');
  const { notificationFooter } = await import('../../server/services/notificationEmail/unsubscribe.js');
  const config = { supabaseUrl: '', supabaseServiceRoleKey: '' } as never;
  const out: Rendered[] = [];
  for (const row of rows) {
    const category = categoryOf(row.slug);
    const app = BRANDS[row.edition].app;
    const locale = (['fa', 'en', 'tr'].includes(row.locale) ? row.locale : 'en') as 'fa' | 'en' | 'tr';
    const footer = category === 'transactional'
      ? undefined
      : notificationFooter(locale, PREFERENCE_OF[row.slug] ?? 'offline_messages', { unsubscribe: `${app}/api/notifications/email/unsubscribe/sample`, settings: null });
    const mail = await renderEmailForPreview(config, {
      slug: row.slug, locale: row.locale, subject: row.subject, html_body: row.html_body, text_body: row.text_body,
      data: sampleData(row.edition, row.locale, row), category, footer, edition: row.edition,
    });
    out.push({ edition: row.edition, name: `${row.slug}.${row.locale}`, html: mail.html, text: `Subject: ${mail.subject}\n\n${mail.text}` });
  }
  return out;
}

interface SampleBrand {
  edition: Edition; lang: string; name: string; appUrl: string; siteUrl: string; supportEmail: string;
  logo: { src: string; srcDark?: string; naturalWidth: number; naturalHeight: number };
}
interface SampleFile {
  brands: Record<string, SampleBrand>;
  samples: Record<string, { category: Category; footerNote?: Record<string, string> } & Record<string, { subject: string; content: string }>>;
}

/** The design panel's samples: content and a brand context each, through the layout itself. */
async function renderSamples(file: string): Promise<Rendered[]> {
  const { renderEmailDocument, renderEmailText, legalLine } = await import('../../server/services/email/layout.js');
  const doc = JSON.parse(readFileSync(file, 'utf8')) as SampleFile;
  const out: Rendered[] = [];
  for (const [key, b] of Object.entries(doc.brands)) {
    const brand = {
      edition: b.edition, name: b.name, appUrl: b.appUrl, siteUrl: b.siteUrl, supportEmail: b.supportEmail,
      legal: legalLine({ brand: b.name, locale: b.lang, edition: b.edition }),
      logo: { light: b.logo.src, dark: b.logo.srcDark || b.logo.src, width: b.logo.naturalWidth, height: b.logo.naturalHeight },
    };
    for (const [slug, sample] of Object.entries(doc.samples)) {
      const mail = sample[key] as { subject: string; content: string } | undefined;
      if (!mail) continue;
      const note = sample.footerNote?.[key];
      const footer = note ? { html: note, text: note.replace(/<[^>]*>/g, '') } : null;
      const layout = { brand, locale: b.lang, contentHtml: mail.content, category: sample.category, footer };
      out.push({
        edition: b.edition,
        name: `${slug}.${key}`,
        html: renderEmailDocument({ ...layout, title: mail.subject }),
        text: `Subject: ${mail.subject}\n\n${renderEmailText(layout)}`,
      });
    }
  }
  return out;
}

const CONTENT_TYPES: Record<string, string> = { png: 'image/png', woff2: 'font/woff2', svg: 'image/svg+xml', jpg: 'image/jpeg' };

/**
 * A rough Gmail-app forced dark: its own inversion of every light colour
 * (lightness flipped, hue kept; a background drawn as an image left alone),
 * the mail's own dark styles ignored. A string, run in the page as it is
 * (a compiled function would carry the compiler's helpers with it).
 */
const GMAIL_INVERT = `(() => {
  const flip = (c) => {
    const m = /rgba?\\(([^)]+)\\)/.exec(c);
    if (!m) return null;
    const [r0, g0, b0, a] = m[1].split(',').map(Number);
    if (a === 0) return null;
    const r = r0 / 255, g = g0 / 255, b = b0 / 255;
    const max = Math.max(r, g, b), min = Math.min(r, g, b);
    let h = 0, s = 0, l = (max + min) / 2;
    if (max !== min) {
      const d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      h = (max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4) / 6;
    }
    l = Math.max(0.08, Math.min(0.92, 1 - l));
    return 'hsl(' + h * 360 + ',' + s * 100 + '%,' + l * 100 + '%)';
  };
  // Every colour read first: a child must be flipped from its own original
  // colour, not from the one its parent was just given.
  const sides = ['top', 'right', 'bottom', 'left'];
  const before = Array.from(document.querySelectorAll('*')).map((el) => {
    const cs = getComputedStyle(el);
    return {
      el,
      bg: cs.backgroundImage === 'none' ? cs.backgroundColor : '',
      color: cs.color,
      borders: sides.map((side) => cs.getPropertyValue('border-' + side + '-width') !== '0px' ? cs.getPropertyValue('border-' + side + '-color') : ''),
    };
  });
  for (const { el, bg, color, borders } of before) {
    const b = bg && flip(bg);
    if (b) el.style.setProperty('background-color', b, 'important');
    const fg = flip(color);
    if (fg) el.style.setProperty('color', fg, 'important');
    borders.forEach((c, i) => {
      const bc = c && flip(c);
      if (bc) el.style.setProperty('border-' + sides[i] + '-color', bc, 'important');
    });
  }
})()`;

async function shoot(items: Rendered[]): Promise<void> {
  const { chromium } = await import('@playwright/test');
  // --chromium: a browser of its own when Playwright's own build is not installed.
  const browser = await chromium.launch(option('--chromium') ? { executablePath: option('--chromium') } : {});
  const variants: Array<{ suffix: string; width: number; scheme: 'light' | 'dark'; fonts: boolean; invert: boolean }> = [];
  for (const [width, label] of [[680, 'desktop'], [375, 'mobile']] as const) {
    for (const scheme of ['light', 'dark'] as const) variants.push({ suffix: `${label}-${scheme}`, width, scheme, fonts: true, invert: false });
    if (flag('--no-web-fonts')) variants.push({ suffix: `${label}-nofonts`, width, scheme: 'light', fonts: false, invert: false });
    if (flag('--gmail-invert')) variants.push({ suffix: `${label}-gmail-invert`, width, scheme: 'light', fonts: false, invert: true });
  }
  try {
    for (const item of items) {
      for (const v of variants) {
        const context = await browser.newContext({ viewport: { width: v.width, height: 800 }, colorScheme: v.scheme, deviceScaleFactor: 1 });
        const page = await context.newPage();
        await page.route('**/*', async (route) => {
          const url = new URL(route.request().url());
          if (!HOSTS[url.hostname] || (!v.fonts && url.pathname.endsWith('.woff2'))) return route.abort();
          const path = decodeURIComponent(url.pathname);
          // Only a file under one of the roots, whatever the path says.
          const file = WWW.map((root) => {
            const candidate = join(root, path);
            return candidate.startsWith(`${root}/`) && existsSync(candidate) ? candidate : null;
          }).find(Boolean);
          if (!file) return route.fulfill({ status: 404, body: '' });
          return route.fulfill({ status: 200, body: readFileSync(file), contentType: CONTENT_TYPES[file.split('.').pop() ?? ''] ?? 'application/octet-stream' });
        });
        await page.setContent(item.html, { waitUntil: 'networkidle' });
        await page.evaluate('document.fonts.ready.then(() => undefined)');
        if (v.invert) await page.evaluate(GMAIL_INVERT);
        const width = Number(await page.evaluate('document.documentElement.scrollWidth'));
        if (width > v.width) console.warn(`  ${item.edition}/${item.name} ${v.suffix}: ${width}px wide at ${v.width}px (sideways scroll)`);
        await page.screenshot({ path: join(OUT, item.edition, 'shots', `${item.name}-${v.suffix}.png`), fullPage: true });
        await context.close();
      }
    }
    // Contact sheets: eight shots a sheet, per edition and variant.
    for (const edition of [...new Set(items.map((i) => i.edition))]) {
      for (const v of variants) {
        const shots = items.filter((i) => i.edition === edition).map((i) => join(OUT, edition, 'shots', `${i.name}-${v.suffix}.png`));
        for (let at = 0; at < shots.length; at += 8) {
          const chunk = shots.slice(at, at + 8);
          const page = await browser.newPage({ viewport: { width: 4 * 360 + 20, height: 600 } });
          const cells = chunk.map((f) => `<figure style="margin:0;width:340px"><figcaption style="font:12px monospace;margin:4px 0">${f.split('/').pop()}</figcaption><img style="width:340px;border:1px solid #ccc" src="data:image/png;base64,${readFileSync(f).toString('base64')}"></figure>`).join('');
          await page.setContent(`<body style="margin:10px;background:#e9e9ee;font-family:sans-serif"><h3 style="margin:0 0 8px">${edition}: ${v.suffix}</h3><div style="display:flex;flex-wrap:wrap;gap:20px;align-items:flex-start">${cells}</div></body>`);
          await page.screenshot({ path: join(OUT, `sheet-${edition}-${v.suffix}-${at / 8 + 1}.png`), fullPage: true });
          await page.close();
        }
      }
    }
  } finally {
    await browser.close();
  }
}

async function main(): Promise<void> {
  const where = { edition: option('--edition'), slug: option('--slug'), locale: option('--locale') };
  let items: Rendered[];
  if (option('--samples')) {
    items = (await renderSamples(resolve(option('--samples') as string))).filter((i) => !where.edition || i.edition === where.edition);
  } else if (option('--fresh')) {
    const scratch = await freshChain(option('--fresh') as string);
    try {
      process.env.DATABASE_URL = scratch.url;
      delete process.env.DATABASE_MODE;
      items = [];
      for (const edition of (where.edition ? [where.edition] : ['iran', 'international']) as Edition[]) {
        await wearBrand(scratch.url, edition);
        items.push(...(await renderRows(await rowsOf(scratch.url, { ...where, edition }))));
      }
      const { closeDataLayer } = await import('../../server/db/index.js');
      await closeDataLayer();
    } finally {
      await scratch.drop();
    }
  } else if (option('--database')) {
    const url = option('--database') as string;
    process.env.DATABASE_URL = url;
    delete process.env.DATABASE_MODE;
    const db = new pg.Client({ connectionString: url });
    await db.connect();
    const { rows } = await db.query("SELECT CASE WHEN region_mode = 'iran' THEN 'iran' ELSE 'international' END AS edition FROM public.platform_settings LIMIT 1");
    await db.end();
    // A database holds its own brand only: the other edition's rows would wear its name.
    items = await renderRows(await rowsOf(url, { ...where, edition: where.edition ?? (rows[0]?.edition as string | undefined) ?? 'international' }));
  } else {
    console.error('Name a source: --fresh <admin database url>, --database <url> or --samples <file>.');
    process.exit(2);
  }

  for (const item of items) {
    mkdirSync(join(OUT, item.edition, 'shots'), { recursive: true });
    writeFileSync(join(OUT, item.edition, `${item.name}.html`), item.html);
    writeFileSync(join(OUT, item.edition, `${item.name}.txt`), item.text);
    console.log(`${String(Buffer.byteLength(item.html)).padStart(7)}  ${item.edition}/${item.name}.html`);
  }
  if (!flag('--no-shots')) await shoot(items);
  console.log(`${items.length} mails in ${OUT}`);
  process.exit(0);
}

await main();
