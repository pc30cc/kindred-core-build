/**
 * Knowledge Base routes — public-facing.
 *
 * Two surfaces:
 *
 * 1. Widget JSON endpoints (mounted under /api/widget/kb):
 *    - GET  /api/widget/kb/categories?workspace_id&locale
 *    - GET  /api/widget/kb/article?workspace_id&locale&slug
 *    - GET  /api/widget/kb/search?workspace_id&locale&q&limit
 *    These reuse the existing widget CORS + rate-limit stack at the mount
 *    point in server/index.ts. Workspace scoping is enforced inside the
 *    `kb_search_articles` RPC and via WHERE clauses for the others.
 *
 * 2. Public SSR endpoints (mounted at root, no /api prefix):
 *    - GET  /help                     → redirects to /help/:defaultLocale
 *    - GET  /help/:locale             → SSR'd category index
 *    - GET  /help/:locale/c/:slug     → SSR'd category page
 *    - GET  /help/:locale/a/:slug     → SSR'd article page
 *    - GET  /help/:locale/search?q    → SSR'd search results
 *    - GET  /help/sitemap.xml         → workspace sitemap
 *    - GET  /help/robots.txt          → robots policy
 *    Workspace is resolved from the request host (Host header) via the
 *    existing platform_domains/widget origin mapping. If no workspace is
 *    bound to the host, the routes 404 — they never fall through to the
 *    SPA. This guarantees Google indexes server-rendered HTML.
 *
 * IMPORTANT — self-host friendly:
 *  - No edge functions. All logic runs in this Express server.
 *  - No external search service; relies only on Postgres + pg_trgm.
 *  - SSR HTML is intentionally minimal so the SPA can hydrate after.
 */

import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { resolveWorkspaceIdFromOrigin } from '../services/widget/public.js';

const SUPPORTED_LOCALES = ['en', 'fa', 'tr'] as const;
type Locale = (typeof SUPPORTED_LOCALES)[number];

function isLocale(v: string | undefined): v is Locale {
  return !!v && (SUPPORTED_LOCALES as readonly string[]).includes(v);
}

function normalizeLocale(v: string | undefined, fallback: Locale = 'en'): Locale {
  if (!v) return fallback;
  const short = v.toLowerCase().split('-')[0];
  return isLocale(short) ? short : fallback;
}

/** Coerce a possibly-array Express path param to a single string. */
function paramStr(v: string | string[] | undefined): string | undefined {
  if (Array.isArray(v)) return v[0];
  return v;
}

function escapeHtml(input: string): string {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function escapeAttr(input: string): string {
  return escapeHtml(input);
}

/**
 * Article body sanitizer. The KB authoring UI accepts markdown/HTML which is
 * already trusted (operator-authored, workspace-scoped). For SSR we still
 * strip script/style/iframe/on* handlers as a defence-in-depth pass so a
 * compromised author cannot inject XSS into a public page that other
 * customers' visitors might encounter.
 */
function sanitizeArticleHtml(input: string): string {
  if (!input) return '';
  return String(input)
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<iframe\b[^>]*>[\s\S]*?<\/iframe>/gi, '')
    .replace(/\son[a-z]+\s*=\s*"[^"]*"/gi, '')
    .replace(/\son[a-z]+\s*=\s*'[^']*'/gi, '')
    .replace(/\son[a-z]+\s*=\s*[^\s>]+/gi, '')
    .replace(/javascript:/gi, '');
}

function dirForLocale(locale: Locale): 'rtl' | 'ltr' {
  return locale === 'fa' ? 'rtl' : 'ltr';
}

function getRequestHostUrl(req: Request): string {
  const proto = (req.headers['x-forwarded-proto'] as string) || req.protocol || 'https';
  const host = req.get('host') || '';
  return `${proto}://${host}`;
}

/**
 * Resolve the workspace bound to the current request host. We pass an
 * Origin-style URL into the existing helper so the same domain rules used
 * for widget CORS apply here.
 */
async function resolveWorkspaceForHost(config: ServerConfig, req: Request): Promise<string | null> {
  const origin = getRequestHostUrl(req);
  return resolveWorkspaceIdFromOrigin(config, origin);
}

// ──────────────────────────────────────────────────────────────────────
//  WIDGET JSON ROUTES
// ──────────────────────────────────────────────────────────────────────

export const widgetKbRouter: Router = express.Router();

/**
 * Host→workspace probe used by the SPA-side public KB pages to discover
 * the workspace bound to the current Host without exposing service-role
 * data. Returns { workspace_id } or 404. Read-only and safe to expose:
 * the resolution is the same one already used by the public SSR routes.
 */
widgetKbRouter.get('/help-host', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = await resolveWorkspaceForHost(config, req);
  if (!workspaceId) return res.status(404).json({ error: 'no_workspace' });
  return res.json({ workspace_id: workspaceId });
});

const categoriesSchema = z.object({
  workspace_id: z.string().uuid(),
  locale: z.string().min(2).max(10).optional(),
});

widgetKbRouter.get('/categories', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = categoriesSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });

  const { workspace_id } = parsed.data;
  const locale = normalizeLocale(parsed.data.locale);

  const supabase = getServiceClient(config);
  let [{ data: cats }, { data: articles }] = await Promise.all([
    supabase
      .from('knowledge_base_categories')
      .select('id, name, slug, description, icon, sort_order')
      .eq('workspace_id', workspace_id)
      .eq('locale', locale)
      .order('sort_order', { ascending: true }),
    supabase
      .from('knowledge_base_articles')
      .select('id, title, slug, excerpt, category_id, sort_order')
      .eq('workspace_id', workspace_id)
      .eq('locale', locale)
      .eq('status', 'published')
      .order('sort_order', { ascending: true })
      .order('updated_at', { ascending: false })
      .limit(20),
  ]);

  // Fallback: if there are no published articles in the requested locale,
  // return the most recent published articles in ANY locale so the widget
  // is not blank when content was authored in a different language.
  if (!articles || articles.length === 0) {
    const { data: anyArticles } = await supabase
      .from('knowledge_base_articles')
      .select('id, title, slug, excerpt, category_id, sort_order, locale')
      .eq('workspace_id', workspace_id)
      .eq('status', 'published')
      .order('updated_at', { ascending: false })
      .limit(20);
    articles = anyArticles || [];
  }
  if (!cats || cats.length === 0) {
    const { data: anyCats } = await supabase
      .from('knowledge_base_categories')
      .select('id, name, slug, description, icon, sort_order')
      .eq('workspace_id', workspace_id)
      .order('sort_order', { ascending: true });
    cats = anyCats || [];
  }

  return res.json({ locale, categories: cats || [], articles: articles || [] });
});

const categoryArticlesSchema = z.object({
  locale: z.string().min(2).max(10).optional(),
  slug: z.string().min(1).max(200),
});

/**
 * Public-helper used by the SPA-side category page to list articles in a
 * category without requiring the SPA to know workspace_id. Workspace is
 * resolved from Host (same rules as the SSR routes).
 */
widgetKbRouter.get('/category-articles', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = categoryArticlesSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });
  const workspaceId = await resolveWorkspaceForHost(config, req);
  if (!workspaceId) return res.status(404).json({ error: 'no_workspace' });
  const locale = normalizeLocale(parsed.data.locale);
  const supabase = getServiceClient(config);
  const { data: cat } = await supabase
    .from('knowledge_base_categories')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('locale', locale)
    .eq('slug', parsed.data.slug)
    .maybeSingle();
  if (!cat) return res.json({ articles: [] });
  const { data: arts } = await supabase
    .from('knowledge_base_articles')
    .select('title, slug, excerpt')
    .eq('workspace_id', workspaceId)
    .eq('category_id', (cat as any).id)
    .eq('locale', locale)
    .eq('status', 'published')
    .order('sort_order', { ascending: true });
  return res.json({ articles: arts || [] });
});

const articleSchema = z.object({
  workspace_id: z.string().uuid(),
  locale: z.string().min(2).max(10).optional(),
  slug: z.string().min(1).max(200),
});

widgetKbRouter.get('/article', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = articleSchema.safeParse(req.query);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_params' });

  const { workspace_id, slug } = parsed.data;
  const locale = normalizeLocale(parsed.data.locale);

  const supabase = getServiceClient(config);
  let { data: article } = await supabase
    .from('knowledge_base_articles')
    .select('id, title, slug, excerpt, content, locale, updated_at, category_id')
    .eq('workspace_id', workspace_id)
    .eq('locale', locale)
    .eq('slug', slug)
    .eq('status', 'published')
    .maybeSingle();

  if (!article) {
    // Fallback: same slug in any other locale (cross-language content).
    // The unique constraint is (workspace_id, slug, locale) — the SAME slug
    // legitimately exists once per locale (e.g. an 'en' and a 'tr' article
    // sharing one slug), so this can match more than one row. .maybeSingle()
    // errors out on >1 row and silently swallows the error (only `data` was
    // destructured), which turned a perfectly normal multi-locale slug into
    // a 404. Ordered + limited to one row instead, so a match always wins
    // deterministically rather than erroring on the exact case this
    // fallback exists to handle.
    const { data: anyArticles } = await supabase
      .from('knowledge_base_articles')
      .select('id, title, slug, excerpt, content, locale, updated_at, category_id')
      .eq('workspace_id', workspace_id)
      .eq('slug', slug)
      .eq('status', 'published')
      .order('locale', { ascending: true })
      .limit(1);
    article = (anyArticles && anyArticles[0]) || null;
  }

  if (!article) return res.status(404).json({ error: 'not_found' });

  return res.json({ article });
});

const searchSchema = z.object({
  workspace_id: z.string().uuid(),
  locale: z.string().min(2).max(10).optional(),
  q: z.string().min(1).max(200),
  limit: z.coerce.number().int().min(1).max(20).optional().default(8),
});

widgetKbRouter.get('/search', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const parsed = searchSchema.safeParse(req.query);
  if (!parsed.success) return res.json({ results: [] });

  const { workspace_id, q, limit } = parsed.data;
  const locale = normalizeLocale(parsed.data.locale);

  const supabase = getServiceClient(config);
  const { data: rows, error } = await supabase.rpc('kb_search_articles', {
    p_workspace_id: workspace_id,
    p_locale: locale,
    p_query: q,
    p_limit: limit,
  });

  if (error) {
    console.error('[kb-search] rpc failed:', error.message);
    return res.json({ results: [] });
  }

  // Cross-locale fallback: if no results in requested locale, search across
  // all locales for this workspace using a simple ilike match. This keeps the
  // widget useful when content was authored in a different language than the
  // visitor's UI locale.
  let results = rows || [];
  if (!results.length) {
    const like = `%${q.replace(/[%_]/g, ' ')}%`;
    const { data: anyRows } = await supabase
      .from('knowledge_base_articles')
      .select('id, title, slug, excerpt, locale')
      .eq('workspace_id', workspace_id)
      .eq('status', 'published')
      .or(`title.ilike.${like},excerpt.ilike.${like},content.ilike.${like}`)
      .limit(limit);
    results = anyRows || [];
  }

  return res.json({ locale, q, results });
});

// ──────────────────────────────────────────────────────────────────────
//  PUBLIC SSR ROUTES (mounted at /help)
// ──────────────────────────────────────────────────────────────────────

export const publicKbRouter: Router = express.Router();

interface SsrShellOpts {
  title: string;
  description: string;
  canonical: string;
  locale: Locale;
  hreflangs: Array<{ hreflang: string; href: string }>;
  jsonLd?: Record<string, any> | Array<Record<string, any>>;
  bodyHtml: string;
  status?: number;
}

function renderShell(opts: SsrShellOpts): string {
  const dir = dirForLocale(opts.locale);
  const jsonLdScript = opts.jsonLd
    ? `<script type="application/ld+json">${JSON.stringify(opts.jsonLd).replace(/</g, '\\u003c')}</script>`
    : '';
  const hreflangTags = opts.hreflangs
    .map((h) => `<link rel="alternate" hreflang="${escapeAttr(h.hreflang)}" href="${escapeAttr(h.href)}" />`)
    .join('');
  return `<!doctype html>
<html lang="${escapeAttr(opts.locale)}" dir="${dir}">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(opts.title)}</title>
  <meta name="description" content="${escapeAttr(opts.description)}" />
  <link rel="canonical" href="${escapeAttr(opts.canonical)}" />
  ${hreflangTags}
  <meta property="og:title" content="${escapeAttr(opts.title)}" />
  <meta property="og:description" content="${escapeAttr(opts.description)}" />
  <meta property="og:type" content="article" />
  <meta property="og:url" content="${escapeAttr(opts.canonical)}" />
  <meta name="twitter:card" content="summary" />
  <meta name="twitter:title" content="${escapeAttr(opts.title)}" />
  <meta name="twitter:description" content="${escapeAttr(opts.description)}" />
  <meta name="robots" content="index,follow" />
  ${jsonLdScript}
  <style>
    body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;margin:0;padding:0;color:#111;background:#fff;}
    .kb-wrap{max-width:760px;margin:0 auto;padding:32px 20px;}
    .kb-breadcrumb{font-size:13px;color:#666;margin-bottom:16px;}
    .kb-breadcrumb a{color:#666;text-decoration:none;}
    .kb-breadcrumb a:hover{text-decoration:underline;}
    h1{font-size:32px;line-height:1.2;margin:0 0 12px;}
    .kb-meta{color:#888;font-size:13px;margin-bottom:24px;}
    article{font-size:16px;line-height:1.65;}
    article p{margin:0 0 1em;}
    article h2{font-size:22px;margin:32px 0 12px;}
    article h3{font-size:18px;margin:24px 0 8px;}
    article a{color:#2563eb;}
    article ul,article ol{padding-inline-start:24px;}
    article img{max-width:100%;height:auto;}
    .kb-card{display:block;padding:16px;border:1px solid #e5e5e5;border-radius:8px;margin-bottom:12px;text-decoration:none;color:inherit;}
    .kb-card:hover{border-color:#bbb;background:#fafafa;}
    .kb-card-title{font-weight:600;margin-bottom:4px;}
    .kb-card-excerpt{font-size:14px;color:#666;}
    .kb-search-form{margin-bottom:24px;}
    .kb-search-form input{width:100%;padding:10px 12px;border:1px solid #ddd;border-radius:8px;font-size:15px;box-sizing:border-box;}
    .kb-empty{color:#666;padding:24px 0;}
  </style>
</head>
<body>
  <div class="kb-wrap">
    ${opts.bodyHtml}
  </div>
</body>
</html>`;
}

function buildHreflangs(req: Request, pathBuilder: (l: Locale) => string): Array<{ hreflang: string; href: string }> {
  const base = getRequestHostUrl(req);
  return SUPPORTED_LOCALES.map((l) => ({ hreflang: l, href: `${base}${pathBuilder(l)}` }));
}

async function loadDefaultLocale(config: ServerConfig): Promise<Locale> {
  const supabase = getServiceClient(config);
  const { data } = await supabase
    .from('platform_settings')
    .select('default_locale')
    .limit(1)
    .maybeSingle();
  return normalizeLocale((data as any)?.default_locale, 'en');
}

publicKbRouter.get('/help', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const def = await loadDefaultLocale(config);
  return res.redirect(302, `/help/${def}`);
});

// Serve robots.txt + sitemap before the parameterized :locale route.
publicKbRouter.get('/help/robots.txt', (_req: Request, res: Response) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.send(
    [
      'User-agent: *',
      'Allow: /help/',
      'Disallow: /help/*/search',
      `Sitemap: /help/sitemap.xml`,
      '',
    ].join('\n'),
  );
});

publicKbRouter.get('/help/sitemap.xml', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const workspaceId = await resolveWorkspaceForHost(config, req);
  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  if (!workspaceId) {
    return res.status(404).send(
      '<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>',
    );
  }

  const supabase = getServiceClient(config);
  const { data: cats } = await supabase
    .from('knowledge_base_categories')
    .select('locale, slug')
    .eq('workspace_id', workspaceId);
  const { data: arts } = await supabase
    .from('knowledge_base_articles')
    .select('locale, slug, updated_at')
    .eq('workspace_id', workspaceId)
    .eq('status', 'published');

  const base = getRequestHostUrl(req);
  const urls: string[] = [];
  for (const l of SUPPORTED_LOCALES) {
    urls.push(`<url><loc>${escapeHtml(`${base}/help/${l}`)}</loc></url>`);
  }
  for (const c of cats || []) {
    const loc = `${base}/help/${(c as any).locale}/c/${(c as any).slug}`;
    urls.push(`<url><loc>${escapeHtml(loc)}</loc></url>`);
  }
  for (const a of arts || []) {
    const loc = `${base}/help/${(a as any).locale}/a/${(a as any).slug}`;
    const lastmod = (a as any).updated_at ? `<lastmod>${escapeHtml(String((a as any).updated_at))}</lastmod>` : '';
    urls.push(`<url><loc>${escapeHtml(loc)}</loc>${lastmod}</url>`);
  }

  return res.send(
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.join('')}</urlset>`,
  );
});

publicKbRouter.get('/help/:locale', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const rawLocale = paramStr(req.params.locale as any);
  const locale = normalizeLocale(rawLocale);
  if (rawLocale !== locale) {
    return res.redirect(302, `/help/${locale}`);
  }
  const workspaceId = await resolveWorkspaceForHost(config, req);
  if (!workspaceId) {
    return res.status(404).send(renderShell({
      title: 'Help center not found',
      description: '',
      canonical: `${getRequestHostUrl(req)}/help/${locale}`,
      locale,
      hreflangs: [],
      bodyHtml: '<h1>Help center not found</h1><p>This domain is not connected to a workspace.</p>',
      status: 404,
    }));
  }

  const supabase = getServiceClient(config);
  const { data: cats } = await supabase
    .from('knowledge_base_categories')
    .select('id, name, slug, description, icon, sort_order')
    .eq('workspace_id', workspaceId)
    .eq('locale', locale)
    .order('sort_order', { ascending: true });

  const { data: featured } = await supabase
    .from('knowledge_base_articles')
    .select('title, slug, excerpt')
    .eq('workspace_id', workspaceId)
    .eq('locale', locale)
    .eq('status', 'published')
    .order('sort_order', { ascending: true })
    .limit(8);

  const base = getRequestHostUrl(req);
  const canonical = `${base}/help/${locale}`;
  const catCards = (cats || [])
    .map((c: any) =>
      `<a class="kb-card" href="/help/${locale}/c/${escapeAttr(c.slug)}">
         <div class="kb-card-title">${escapeHtml(c.name)}</div>
         ${c.description ? `<div class="kb-card-excerpt">${escapeHtml(c.description)}</div>` : ''}
       </a>`,
    )
    .join('');
  const featuredCards = (featured || [])
    .map((a: any) =>
      `<a class="kb-card" href="/help/${locale}/a/${escapeAttr(a.slug)}">
         <div class="kb-card-title">${escapeHtml(a.title)}</div>
         ${a.excerpt ? `<div class="kb-card-excerpt">${escapeHtml(a.excerpt)}</div>` : ''}
       </a>`,
    )
    .join('');

  const titles: Record<Locale, string> = {
    en: 'Help center',
    fa: 'مرکز راهنما',
    tr: 'Yardım merkezi',
  };
  const searchPlaceholders: Record<Locale, string> = {
    en: 'Search articles…',
    fa: 'جست‌وجو در مقالات…',
    tr: 'Makalelerde ara…',
  };
  const noContent: Record<Locale, string> = {
    en: 'No articles published yet.',
    fa: 'هنوز مقاله‌ای منتشر نشده است.',
    tr: 'Henüz yayımlanmış makale yok.',
  };

  const body = `
    <h1>${escapeHtml(titles[locale])}</h1>
    <form class="kb-search-form" method="get" action="/help/${locale}/search">
      <input type="search" name="q" placeholder="${escapeAttr(searchPlaceholders[locale])}" />
    </form>
    ${catCards || featuredCards ? '' : `<p class="kb-empty">${escapeHtml(noContent[locale])}</p>`}
    ${catCards}
    ${featuredCards}
  `;

  return res.status(200).send(renderShell({
    title: titles[locale],
    description: titles[locale],
    canonical,
    locale,
    hreflangs: buildHreflangs(req, (l) => `/help/${l}`),
    jsonLd: {
      '@context': 'https://schema.org',
      '@type': 'CollectionPage',
      name: titles[locale],
      url: canonical,
      inLanguage: locale,
    },
    bodyHtml: body,
  }));
});

publicKbRouter.get('/help/:locale/c/:slug', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const rawLocale = paramStr(req.params.locale as any);
  const locale = normalizeLocale(rawLocale);
  if (rawLocale !== locale) return res.redirect(302, `/help/${locale}/c/${req.params.slug}`);

  const workspaceId = await resolveWorkspaceForHost(config, req);
  if (!workspaceId) return res.status(404).send('Not found');

  const supabase = getServiceClient(config);
  const { data: cat } = await supabase
    .from('knowledge_base_categories')
    .select('id, name, slug, description')
    .eq('workspace_id', workspaceId)
    .eq('locale', locale)
    .eq('slug', req.params.slug)
    .maybeSingle();

  if (!cat) return res.status(404).send('Not found');

  const { data: arts } = await supabase
    .from('knowledge_base_articles')
    .select('title, slug, excerpt')
    .eq('workspace_id', workspaceId)
    .eq('category_id', (cat as any).id)
    .eq('locale', locale)
    .eq('status', 'published')
    .order('sort_order', { ascending: true });

  const base = getRequestHostUrl(req);
  const canonical = `${base}/help/${locale}/c/${(cat as any).slug}`;
  const cards = (arts || [])
    .map((a: any) =>
      `<a class="kb-card" href="/help/${locale}/a/${escapeAttr(a.slug)}">
         <div class="kb-card-title">${escapeHtml(a.title)}</div>
         ${a.excerpt ? `<div class="kb-card-excerpt">${escapeHtml(a.excerpt)}</div>` : ''}
       </a>`,
    )
    .join('');

  const body = `
    <nav class="kb-breadcrumb" aria-label="Breadcrumb">
      <a href="/help/${locale}">${escapeHtml(locale === 'fa' ? 'مرکز راهنما' : locale === 'tr' ? 'Yardım merkezi' : 'Help center')}</a>
      &nbsp;/&nbsp;${escapeHtml((cat as any).name)}
    </nav>
    <h1>${escapeHtml((cat as any).name)}</h1>
    ${(cat as any).description ? `<p>${escapeHtml((cat as any).description)}</p>` : ''}
    ${cards || '<p class="kb-empty">—</p>'}
  `;

  return res.status(200).send(renderShell({
    title: (cat as any).name,
    description: (cat as any).description || (cat as any).name,
    canonical,
    locale,
    hreflangs: buildHreflangs(req, (l) => `/help/${l}/c/${(cat as any).slug}`),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: (cat as any).name,
        url: canonical,
        inLanguage: locale,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Help', item: `${base}/help/${locale}` },
          { '@type': 'ListItem', position: 2, name: (cat as any).name, item: canonical },
        ],
      },
    ],
    bodyHtml: body,
  }));
});

publicKbRouter.get('/help/:locale/a/:slug', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const rawLocale = paramStr(req.params.locale as any);
  const locale = normalizeLocale(rawLocale);
  if (rawLocale !== locale) return res.redirect(302, `/help/${locale}/a/${req.params.slug}`);

  const workspaceId = await resolveWorkspaceForHost(config, req);
  if (!workspaceId) return res.status(404).send('Not found');

  const supabase = getServiceClient(config);
  const { data: article } = await supabase
    .from('knowledge_base_articles')
    .select('id, title, slug, excerpt, content, locale, updated_at, category_id')
    .eq('workspace_id', workspaceId)
    .eq('locale', locale)
    .eq('slug', req.params.slug)
    .eq('status', 'published')
    .maybeSingle();

  if (!article) return res.status(404).send(renderShell({
    title: 'Article not found',
    description: '',
    canonical: `${getRequestHostUrl(req)}/help/${locale}/a/${req.params.slug}`,
    locale,
    hreflangs: [],
    bodyHtml: '<h1>Article not found</h1>',
    status: 404,
  }));

  let category: any = null;
  if ((article as any).category_id) {
    const { data: c } = await supabase
      .from('knowledge_base_categories')
      .select('name, slug')
      .eq('id', (article as any).category_id)
      .maybeSingle();
    category = c;
  }

  const base = getRequestHostUrl(req);
  const canonical = `${base}/help/${locale}/a/${(article as any).slug}`;
  const description = ((article as any).excerpt || (article as any).title || '').slice(0, 160);

  const body = `
    <nav class="kb-breadcrumb" aria-label="Breadcrumb">
      <a href="/help/${locale}">${escapeHtml(locale === 'fa' ? 'مرکز راهنما' : locale === 'tr' ? 'Yardım merkezi' : 'Help center')}</a>
      ${category ? `&nbsp;/&nbsp;<a href="/help/${locale}/c/${escapeAttr(category.slug)}">${escapeHtml(category.name)}</a>` : ''}
    </nav>
    <h1>${escapeHtml((article as any).title)}</h1>
    <div class="kb-meta">${(article as any).updated_at ? escapeHtml(new Date((article as any).updated_at).toLocaleDateString(locale === 'fa' ? 'fa-IR' : locale === 'tr' ? 'tr-TR' : 'en-US')) : ''}</div>
    <article>${sanitizeArticleHtml((article as any).content || '')}</article>
  `;

  return res.status(200).send(renderShell({
    title: (article as any).title,
    description,
    canonical,
    locale,
    hreflangs: buildHreflangs(req, (l) => `/help/${l}/a/${(article as any).slug}`),
    jsonLd: [
      {
        '@context': 'https://schema.org',
        '@type': 'Article',
        headline: (article as any).title,
        description,
        inLanguage: locale,
        dateModified: (article as any).updated_at,
        mainEntityOfPage: canonical,
      },
      {
        '@context': 'https://schema.org',
        '@type': 'BreadcrumbList',
        itemListElement: [
          { '@type': 'ListItem', position: 1, name: 'Help', item: `${base}/help/${locale}` },
          ...(category ? [{ '@type': 'ListItem', position: 2, name: category.name, item: `${base}/help/${locale}/c/${category.slug}` }] : []),
          { '@type': 'ListItem', position: category ? 3 : 2, name: (article as any).title, item: canonical },
        ],
      },
    ],
    bodyHtml: body,
  }));
});

publicKbRouter.get('/help/:locale/search', async (req: Request, res: Response) => {
  const config = (req as any).serverConfig as ServerConfig;
  const rawLocale = paramStr(req.params.locale as any);
  const locale = normalizeLocale(rawLocale);
  if (rawLocale !== locale) {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    return res.redirect(302, `/help/${locale}/search${q ? `?q=${encodeURIComponent(q)}` : ''}`);
  }

  const workspaceId = await resolveWorkspaceForHost(config, req);
  if (!workspaceId) return res.status(404).send('Not found');

  const q = typeof req.query.q === 'string' ? req.query.q.trim().slice(0, 200) : '';
  let results: any[] = [];
  if (q.length >= 2) {
    const supabase = getServiceClient(config);
    const { data } = await supabase.rpc('kb_search_articles', {
      p_workspace_id: workspaceId,
      p_locale: locale,
      p_query: q,
      p_limit: 20,
    });
    results = (data as any[]) || [];
  }

  const base = getRequestHostUrl(req);
  const canonical = `${base}/help/${locale}/search${q ? `?q=${encodeURIComponent(q)}` : ''}`;
  const placeholder = locale === 'fa' ? 'جست‌وجو در مقالات…' : locale === 'tr' ? 'Makalelerde ara…' : 'Search articles…';
  const heading = locale === 'fa' ? 'نتایج جست‌وجو' : locale === 'tr' ? 'Arama sonuçları' : 'Search results';
  const empty = locale === 'fa' ? 'نتیجه‌ای یافت نشد.' : locale === 'tr' ? 'Sonuç bulunamadı.' : 'No results.';
  const cards = results
    .map((r) =>
      `<a class="kb-card" href="/help/${locale}/a/${escapeAttr(r.slug)}">
         <div class="kb-card-title">${escapeHtml(r.title)}</div>
         ${r.excerpt ? `<div class="kb-card-excerpt">${escapeHtml(r.excerpt)}</div>` : ''}
       </a>`,
    )
    .join('');

  const body = `
    <nav class="kb-breadcrumb" aria-label="Breadcrumb">
      <a href="/help/${locale}">${escapeHtml(locale === 'fa' ? 'مرکز راهنما' : locale === 'tr' ? 'Yardım merkezi' : 'Help center')}</a>
    </nav>
    <h1>${escapeHtml(heading)}</h1>
    <form class="kb-search-form" method="get" action="/help/${locale}/search">
      <input type="search" name="q" value="${escapeAttr(q)}" placeholder="${escapeAttr(placeholder)}" />
    </form>
    ${cards || `<p class="kb-empty">${escapeHtml(empty)}</p>`}
  `;

  return res.status(200).send(renderShell({
    title: q ? `${heading}: ${q}` : heading,
    description: heading,
    canonical,
    locale,
    hreflangs: buildHreflangs(req, (l) => `/help/${l}/search${q ? `?q=${encodeURIComponent(q)}` : ''}`),
    bodyHtml: body,
  }));
});