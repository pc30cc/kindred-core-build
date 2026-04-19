import { useEffect, useState } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { applySeoHead } from '@/lib/seoHead';
import { fetchKbCategories, type KbCategory } from '@/lib/kb-api';
import { SUPPORTED_LOCALES, type Locale, isRtl } from '@/i18n/config';
import { KbSearchBox } from './KbSearchBox';

const TITLES: Record<Locale, string> = {
  en: 'Help center',
  fa: 'مرکز راهنما',
  tr: 'Yardım merkezi',
};

const NO_CONTENT: Record<Locale, string> = {
  en: 'No articles published yet.',
  fa: 'هنوز مقاله‌ای منتشر نشده است.',
  tr: 'Henüz yayımlanmış makale yok.',
};

export default function HelpIndexPage() {
  const { locale } = useParams<{ locale: string }>();
  const norm = (locale || '').toLowerCase();
  const valid = (SUPPORTED_LOCALES as readonly string[]).includes(norm) ? (norm as Locale) : null;
  const [cats, setCats] = useState<KbCategory[] | null>(null);

  useEffect(() => {
    if (!valid) return;
    let alive = true;
    fetchKbCategories(valid).then((c) => { if (alive) setCats(c); });
    return () => { alive = false; };
  }, [valid]);

  useEffect(() => {
    if (!valid) return;
    const origin = window.location.origin;
    const canonical = `${origin}/help/${valid}`;
    applySeoHead({
      title: TITLES[valid],
      description: TITLES[valid],
      canonical,
      locale: valid,
      dir: isRtl(valid) ? 'rtl' : 'ltr',
      hreflangs: SUPPORTED_LOCALES.map((l) => ({ hreflang: l, href: `${origin}/help/${l}` })),
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'CollectionPage',
        name: TITLES[valid],
        url: canonical,
        inLanguage: valid,
      },
    });
  }, [valid]);

  if (!valid) return <Navigate to="/help/en" replace />;

  return (
    <div className="container max-w-3xl py-10" dir={isRtl(valid) ? 'rtl' : 'ltr'}>
      <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-6">
        {TITLES[valid]}
      </h1>
      <KbSearchBox locale={valid} />
      {cats === null ? null : cats.length === 0 ? (
        <p className="text-muted-foreground mt-8">{NO_CONTENT[valid]}</p>
      ) : (
        <div className="mt-8 grid gap-3">
          {cats.map((c) => (
            <Link
              key={c.id}
              to={`/help/${valid}/c/${c.slug}`}
              className="block rounded-lg border border-border bg-card p-4 hover:bg-muted transition-colors"
            >
              <div className="font-semibold text-foreground">{c.name}</div>
              {c.description ? (
                <div className="text-sm text-muted-foreground mt-1">{c.description}</div>
              ) : null}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}