import { Fragment, useEffect } from 'react';
import { Link, Navigate, useParams } from 'react-router-dom';
import { BrandLogo } from '@/components/brand/BrandLogo';
import { applySeoHead } from '@/lib/seoHead';
import {
  LEGAL_CHROME,
  LEGAL_CONTACT_EMAIL,
  LEGAL_DOCUMENTS,
  type LegalDocumentId,
} from './legalDocuments';

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
 * The privacy policy or the terms of use, public and signed out, in English —
 * laid out as the site's own pages are: the title, the date it took effect,
 * and numbered sections, in one readable column.
 */
export default function LegalPage({ doc }: { doc: LegalDocumentId }) {
  // `/privacy/en` and the like, from when there were three languages.
  const { locale } = useParams<{ locale?: string }>();
  const content = LEGAL_DOCUMENTS[doc];

  useEffect(() => {
    const url = `${window.location.origin}/${doc}`;
    applySeoHead({
      title: content.pageTitle,
      description: content.title,
      canonical: url,
      locale: 'en',
      dir: 'ltr',
      jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: content.title, url, inLanguage: 'en' },
    });
  }, [doc, content]);

  if (locale) return <Navigate to={`/${doc}`} replace />;

  return (
    <div
      dir="ltr"
      lang="en"
      // The app turns every digit Persian while its own language is Persian
      // (lib/persian-digits); this text keeps "September 1, 2026".
      data-latin-digits=""
      className="flex min-h-screen flex-col bg-background text-foreground"
    >
      <header className="border-b border-border/60">
        <div className="mx-auto flex w-full max-w-3xl items-center gap-2.5 px-5 py-4">
          <BrandLogo className="h-8 w-8 rounded-lg" alt={LEGAL_CHROME.brand} />
          <span className="text-base font-bold text-foreground">{LEGAL_CHROME.brand}</span>
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
          <span>{LEGAL_CHROME.copyright}</span>
          <nav className="flex items-center gap-4">
            <Link to="/terms" className="hover:text-foreground">
              {LEGAL_CHROME.terms}
            </Link>
            <Link to="/privacy" className="hover:text-foreground">
              {LEGAL_CHROME.privacy}
            </Link>
          </nav>
        </div>
      </footer>
    </div>
  );
}
