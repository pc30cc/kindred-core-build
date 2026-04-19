import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams, Navigate } from 'react-router-dom';
import { applySeoHead } from '@/lib/seoHead';
import { searchKbArticles, type KbSearchResult } from '@/lib/kb-api';
import { SUPPORTED_LOCALES, type Locale, isRtl } from '@/i18n/config';
import { KbSearchBox } from './KbSearchBox';

const COPY: Record<Locale, { help: string; results: string; empty: string; searching: string }> = {
  en: { help: 'Help center', results: 'Search results', empty: 'No results.', searching: 'Searching…' },
  fa: { help: 'مرکز راهنما', results: 'نتایج جست‌وجو', empty: 'نتیجه‌ای یافت نشد.', searching: 'در حال جست‌وجو…' },
  tr: { help: 'Yardım merkezi', results: 'Arama sonuçları', empty: 'Sonuç bulunamadı.', searching: 'Aranıyor…' },
};

export default function HelpSearchPage() {
  const { locale } = useParams<{ locale: string }>();
  const [sp] = useSearchParams();
  const q = (sp.get('q') || '').trim();
  const norm = (locale || '').toLowerCase();
  const valid = (SUPPORTED_LOCALES as readonly string[]).includes(norm) ? (norm as Locale) : null;
  const [loading, setLoading] = useState(false);
  const [results, setResults] = useState<KbSearchResult[]>([]);

  useEffect(() => {
    if (!valid) return;
    if (!q) { setResults([]); return; }
    const ctrl = new AbortController();
    setLoading(true);
    searchKbArticles(valid, q, 20, ctrl.signal)
      .then((r) => setResults(r))
      .finally(() => setLoading(false));
    return () => ctrl.abort();
  }, [valid, q]);

  useEffect(() => {
    if (!valid) return;
    const origin = window.location.origin;
    const qStr = q ? `?q=${encodeURIComponent(q)}` : '';
    applySeoHead({
      title: q ? `${COPY[valid].results}: ${q}` : COPY[valid].results,
      description: COPY[valid].results,
      canonical: `${origin}/help/${valid}/search${qStr}`,
      locale: valid,
      dir: isRtl(valid) ? 'rtl' : 'ltr',
      hreflangs: SUPPORTED_LOCALES.map((l) => ({ hreflang: l, href: `${origin}/help/${l}/search${qStr}` })),
      // Search pages should not be indexed (matches /help/robots.txt rule).
      robots: 'noindex,follow',
    });
  }, [valid, q]);

  if (!valid) return <Navigate to="/help/en" replace />;

  return (
    <div className="container max-w-3xl py-10" dir={isRtl(valid) ? 'rtl' : 'ltr'}>
      <nav className="text-sm text-muted-foreground mb-4">
        <Link to={`/help/${valid}`} className="hover:text-foreground">{COPY[valid].help}</Link>
      </nav>
      <h1 className="text-2xl md:text-3xl font-bold tracking-tight text-foreground mb-4">
        {COPY[valid].results}
      </h1>
      <KbSearchBox locale={valid} initial={q} />
      <div className="mt-6">
        {loading ? (
          <p className="text-muted-foreground">{COPY[valid].searching}</p>
        ) : results.length === 0 ? (
          q ? <p className="text-muted-foreground">{COPY[valid].empty}</p> : null
        ) : (
          <div className="grid gap-3">
            {results.map((r) => (
              <Link
                key={r.slug}
                to={`/help/${valid}/a/${r.slug}`}
                className="block rounded-lg border border-border bg-card p-4 hover:bg-muted transition-colors"
              >
                <div className="font-semibold text-foreground">{r.title}</div>
                {r.excerpt ? <div className="text-sm text-muted-foreground mt-1">{r.excerpt}</div> : null}
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}