import { useEffect, useState, useMemo } from 'react';
import { Link, useParams, Navigate } from 'react-router-dom';
import { applySeoHead } from '@/lib/seoHead';
import { fetchKbArticle, type KbArticle } from '@/lib/kb-api';
import { SUPPORTED_LOCALES, type Locale, isRtl } from '@/i18n/config';
import { sanitizeKbHtml } from '@/lib/sanitizeKbHtml';

const HELP_LABEL: Record<Locale, string> = {
  en: 'Help center',
  fa: 'مرکز راهنما',
  tr: 'Yardım merkezi',
};

export default function HelpArticlePage() {
  const { locale, slug } = useParams<{ locale: string; slug: string }>();
  const norm = (locale || '').toLowerCase();
  const valid = (SUPPORTED_LOCALES as readonly string[]).includes(norm) ? (norm as Locale) : null;
  const [article, setArticle] = useState<KbArticle | null | undefined>(undefined);

  useEffect(() => {
    if (!valid || !slug) return;
    let alive = true;
    fetchKbArticle(valid, slug).then((a) => { if (alive) setArticle(a); });
    return () => { alive = false; };
  }, [valid, slug]);

  const description = useMemo(() => {
    if (!article) return '';
    return (article.excerpt || article.title || '').slice(0, 160);
  }, [article]);

  useEffect(() => {
    if (!valid || !slug || !article) return;
    const origin = window.location.origin;
    const canonical = `${origin}/help/${valid}/a/${slug}`;
    applySeoHead({
      title: article.title,
      description,
      canonical,
      locale: valid,
      dir: isRtl(valid) ? 'rtl' : 'ltr',
      hreflangs: SUPPORTED_LOCALES.map((l) => ({ hreflang: l, href: `${origin}/help/${l}/a/${slug}` })),
      jsonLd: [
        {
          '@context': 'https://schema.org',
          '@type': 'Article',
          headline: article.title,
          description,
          inLanguage: valid,
          dateModified: article.updated_at,
          mainEntityOfPage: canonical,
        },
        {
          '@context': 'https://schema.org',
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: HELP_LABEL[valid], item: `${origin}/help/${valid}` },
            { '@type': 'ListItem', position: 2, name: article.title, item: canonical },
          ],
        },
      ],
    });
  }, [valid, slug, article, description]);

  if (!valid) return <Navigate to="/help/en" replace />;
  if (article === null) return <Navigate to={`/help/${valid}`} replace />;

  return (
    <div className="container max-w-3xl py-10" dir={isRtl(valid) ? 'rtl' : 'ltr'}>
      <nav className="text-sm text-muted-foreground mb-4">
        <Link to={`/help/${valid}`} className="hover:text-foreground">{HELP_LABEL[valid]}</Link>
      </nav>
      <h1 className="text-3xl md:text-4xl font-bold tracking-tight text-foreground mb-3">
        {article?.title || ''}
      </h1>
      {article?.updated_at ? (
        <div className="text-sm text-muted-foreground mb-6">
          {new Date(article.updated_at).toLocaleDateString(
            valid === 'fa' ? 'fa-IR' : valid === 'tr' ? 'tr-TR' : 'en-US',
          )}
        </div>
      ) : null}
      {article ? (
        <article
          className="prose prose-neutral max-w-none [&_a]:text-primary [&_img]:rounded-md [&_h2]:mt-8 [&_h3]:mt-6"
          // eslint-disable-next-line react/no-danger
          dangerouslySetInnerHTML={{ __html: sanitizeKbHtml(article.content) }}
        />
      ) : null}
    </div>
  );
}