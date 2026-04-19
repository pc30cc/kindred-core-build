import { useEffect, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { applySeoHead } from '@/lib/seoHead';
import { fetchKbCategories, type KbCategory } from '@/lib/kb-api';
import { API_BASE } from '@/lib/api';
import { SUPPORTED_LOCALES, type Locale, isRtl } from '@/i18n/config';
import { KbSearchBox } from './KbSearchBox';

const HELP_LABEL: Record<Locale, string> = {
  en: 'Help center',
  fa: 'مرکز راهنما',
  tr: 'Yardım merkezi',
};

interface ArticleSummary { title: string; slug: string; excerpt?: string | null }

export default function HelpCategoryPage() {
  const { locale, slug } = useParams<{ locale: string; slug: string }>();
  const norm = (locale || '').toLowerCase();
  const valid = (SUPPORTED_LOCALES as readonly string[]).includes(norm) ? (norm as Locale) : null;
  const [cat, setCat] = useState<KbCategory | null | undefined>(undefined);
  const [arts, setArts] = useState<ArticleSummary[]>([]);

  useEffect(() => {
    if (!valid || !slug) return;
    let alive = true;
    (async () => {
      const cats = await fetchKbCategories(valid);
      const found = cats.find((c) => c.slug === slug) || null;
      if (!alive) return;
      setCat(found);
      if (!found) return;
      // Articles for this category — fetched from the public probe endpoint.
      try {
        const res = await fetch(
          `${API_BASE}/api/widget/kb/category-articles?locale=${encodeURIComponent(valid)}&slug=${encodeURIComponent(slug)}`,
          { credentials: 'include' },
        );
        if (res.ok) {
          const data = await res.json();
          if (alive) setArts(data.articles || []);
        }
      } catch { /* noop */ }
    })();
    return () => { alive = false; };
  }, [valid, slug]);

  useEffect(() => {
    if (!valid || !slug || !cat) return;
    const origin = window.location.origin;
    const canonical = `${origin}/help/${valid}/c/${slug}`;
    applySeoHead({
      title: cat.name,
      description: cat.description || cat.name,
      canonical,
      locale: valid,
      dir: isRtl(valid) ? 'rtl' : 'ltr',
      hreflangs: SUPPORTED_LOCALES.map((l) => ({ hreflang: l, href: `${origin}/help/${l}/c/${slug}` })),
      jsonLd: [
        { '@context': 'https://schema.org', '@type': 'CollectionPage', name: cat.name, url: canonical, inLanguage: valid },
        {
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: HELP_LABEL[valid], item: `${origin}/help/${valid}` },
            { '@type': 'ListItem', position: 2, name: cat.name, item: canonical },
          ],
        },
      ],
    });
  }, [valid, slug, cat]);

  if (!valid) return <Navigate to="/help/en" replace />;
  if (cat === null) return <Navigate to={`/help/${valid}`} replace />;

  return (
    <div className="container max-w-3xl py-10" dir={isRtl(valid) ? 'rtl' : 'ltr'}>
      <nav className="text-sm text-muted-foreground mb-4">
        <Link to={`/help/${valid}`} className="hover:text-foreground">{HELP_LABEL[valid]}</Link>
        <span className="mx-2">/</span>
        <span>{cat?.name || ''}</span>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-3">{cat?.name}</h1>
      {cat?.description ? <p className="text-muted-foreground mb-6">{cat.description}</p> : null}
      <KbSearchBox locale={valid} />
      <div className="mt-6 grid gap-3">
        {arts.map((a) => (
          <Link
            key={a.slug}
            to={`/help/${valid}/a/${a.slug}`}
            className="block rounded-lg border border-border bg-card p-4 hover:bg-muted transition-colors"
          >
            <div className="font-semibold text-foreground">{a.title}</div>
            {a.excerpt ? <div className="text-sm text-muted-foreground mt-1">{a.excerpt}</div> : null}
          </Link>
        ))}
      </div>
    </div>
  );
}