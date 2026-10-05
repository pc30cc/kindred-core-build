import { Fragment, useEffect } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { isRtl, SUPPORTED_LOCALES, type Locale } from '@/i18n/config';
import { applySeoHead } from '@/lib/seoHead';
import { cn } from '@/lib/utils';
import {
  LEGAL_CHROME,
  LEGAL_CONTACT_EMAIL,
  LEGAL_DEFAULT_LOCALE,
  LEGAL_DOCUMENTS,
  LEGAL_LOCALES,
  type LegalDocumentId,
} from './legalDocuments';

/** `/privacy` is the Persian, as on the site; `/privacy/en` and `/privacy/tr` the others. */
function pathFor(doc: LegalDocumentId, locale: Locale): string {
  return locale === LEGAL_DEFAULT_LOCALE ? `/${doc}` : `/${doc}/${locale}`;
}

/** A paragraph, with `{email}` drawn as a link to write to. */
function Paragraph({ text }: { text: string }) {
  const parts = text.split('{email}');
  return (
    <p className="text-sm leading-7 text-muted-foreground">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <a
              href={`mailto:${LEGAL_CONTACT_EMAIL}`}
              dir="ltr"
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {LEGAL_CONTACT_EMAIL}
            </a>
          )}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * The privacy policy or the terms of use, public and signed out — laid out as
 * the site's own pages are: the title, the date it took effect, and numbered
 * sections, in one readable column.
 */
export default function LegalPage({ doc }: { doc: LegalDocumentId }) {
  const { locale: requested } = useParams<{ locale?: string }>();
  const wanted = (requested ?? LEGAL_DEFAULT_LOCALE).toLowerCase();
  const locale = (SUPPORTED_LOCALES as readonly string[]).includes(wanted) ? (wanted as Locale) : null;

  const content = locale ? LEGAL_DOCUMENTS[doc][locale] : null;
  const chrome = locale ? LEGAL_CHROME[locale] : null;
  const dir = locale && isRtl(locale) ? 'rtl' : 'ltr';

  useEffect(() => {
    if (!locale || !content) return;
    const origin = window.location.origin;
    applySeoHead({
      title: content.pageTitle,
      description: content.title,
      canonical: `${origin}${pathFor(doc, locale)}`,
      locale,
      dir,
      hreflangs: LEGAL_LOCALES.map((l) => ({ hreflang: l.locale, href: `${origin}${pathFor(doc, l.locale)}` })),
      jsonLd: {
        '@context': 'https://schema.org',
        '@type': 'WebPage',
        name: content.title,
        url: `${origin}${pathFor(doc, locale)}`,
        inLanguage: locale,
      },
    });
  }, [doc, locale, content, dir]);

  // `/privacy` is the default language already; `/privacy/fa` and anything
  // unknown land there.
  if (!locale || (requested && locale === LEGAL_DEFAULT_LOCALE)) {
    return <Navigate to={pathFor(doc, LEGAL_DEFAULT_LOCALE)} replace />;
  }
  if (!content || !chrome) return null;

  return (
    <div
      dir={dir}
      lang={locale}
      // The app turns every digit Persian while its own language is Persian
      // (lib/persian-digits). The English and Turkish texts keep theirs:
      // "1 September 2026", not "۱ September ۲۰۲۶".
      data-latin-digits={locale === 'fa' ? undefined : ''}
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      <header className="border-b border-border/60">
        <div className="mx-auto flex w-full max-w-3xl items-center justify-between gap-4 px-5 py-4">
          <div className="flex items-center gap-2.5">
            <BrandLogo className="h-8 w-8 rounded-lg" alt={chrome.brand} />
            <span className="text-base font-bold text-foreground">{chrome.brand}</span>
          </div>
          <nav className="flex items-center gap-1 text-xs" aria-label="Language">
            {LEGAL_LOCALES.map((l) => (
              <Link
                key={l.locale}
                to={pathFor(doc, l.locale)}
                lang={l.locale}
                aria-current={l.locale === locale ? 'page' : undefined}
                className={cn(
                  'rounded-full px-2.5 py-1 transition-colors',
                  l.locale === locale
                    ? 'bg-muted font-semibold text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {l.label}
              </Link>
            ))}
          </nav>
        </div>
      </header>

      <main className="flex-1">
        <div className="mx-auto w-full max-w-3xl px-5 py-16 text-start sm:py-24">
          <div className="duration-500 animate-in fade-in slide-in-from-bottom-4">
            <h1 className="mb-2 text-3xl font-extrabold text-foreground sm:text-4xl">{content.title}</h1>
            <p className="mb-10 text-sm text-muted-foreground">{content.effective}</p>
          </div>
          <div className="space-y-8">
            {content.sections.map((section) => (
              <section key={section.heading} className="duration-500 animate-in fade-in slide-in-from-bottom-4">
                <h2 className="mb-3 text-lg font-bold text-foreground">{section.heading}</h2>
                <div className="space-y-2">
                  {section.paragraphs.map((text) => (
                    <Paragraph key={text} text={text} />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>

      <footer className="border-t border-border/60">
        <div className="mx-auto flex w-full max-w-3xl flex-col items-center gap-3 px-5 py-6 text-xs text-muted-foreground sm:flex-row sm:justify-between">
          <span>{chrome.copyright}</span>
          <nav className="flex items-center gap-4">
            <Link to={pathFor('terms', locale)} className="hover:text-foreground">
              {chrome.terms}
            </Link>
            <Link to={pathFor('privacy', locale)} className="hover:text-foreground">
              {chrome.privacy}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
