import { Fragment, useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { applySeoHead } from '@/lib/seoHead';
import { LegalLayout } from './LegalLayout';
import { LEGAL_CONTACT_EMAIL, LEGAL_DOCUMENTS, type LegalDocumentId } from './legalDocuments';
import { useBrandTokens } from '@/lib/brand';

/** A paragraph, with `{email}` drawn as a link to write to. */
function Paragraph({ text, email }: { text: string; email: string }) {
  const parts = text.split('{email}');
  return (
    <p className="text-sm leading-7 text-muted-foreground">
      {parts.map((part, index) => (
        <Fragment key={index}>
          {index > 0 && (
            <a
              href={`mailto:${email}`}
              className="font-medium text-primary underline-offset-4 hover:underline"
            >
              {email}
            </a>
          )}
          {part}
        </Fragment>
      ))}
    </p>
  );
}

/**
 * The privacy policy or the terms of use, public and signed out, in English:
 * the title, the date it took effect, and numbered sections.
 */
export default function LegalPage({ doc }: { doc: LegalDocumentId }) {
  // `/privacy/en` and the like, from when there were three languages.
  const { locale } = useParams<{ locale?: string }>();
  const content = LEGAL_DOCUMENTS[doc];
  // The brand per edition (shared/brand.ts): WebYar's name and address in
  // Iran, as always; the platform's own abroad.
  const { fill, supportEmail } = useBrandTokens('en');
  const email = supportEmail || LEGAL_CONTACT_EMAIL;
  const pageTitle = fill(content.pageTitle);

  useEffect(() => {
    const url = `${window.location.origin}/${doc}`;
    applySeoHead({
      title: pageTitle,
      description: content.title,
      canonical: url,
      locale: 'en',
      dir: 'ltr',
      jsonLd: { '@context': 'https://schema.org', '@type': 'WebPage', name: content.title, url, inLanguage: 'en' },
    });
  }, [doc, content, pageTitle]);

  if (locale) return <Navigate to={`/${doc}`} replace />;

  return (
    <LegalLayout>
      <div className="duration-500 animate-in fade-in slide-in-from-bottom-4">
        <h1 className="mb-2 text-3xl font-extrabold text-foreground sm:text-4xl">{content.title}</h1>
        <p className="mb-10 text-sm text-muted-foreground">{fill(content.effective)}</p>
      </div>
      <div className="space-y-8">
        {content.sections.map((section) => (
          <section key={section.heading} className="duration-500 animate-in fade-in slide-in-from-bottom-4">
            <h2 className="mb-3 text-lg font-bold text-foreground">{fill(section.heading)}</h2>
            <div className="space-y-2">
              {section.paragraphs.map((text) => (
                <Paragraph key={text} text={fill(text)} email={email} />
              ))}
            </div>
          </section>
        ))}
      </div>
    </LegalLayout>
  );
}
