import { Fragment, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { BookOpen, Mail, Send, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { applySeoHead } from '@/lib/seoHead';
import { LegalLayout } from './LegalLayout';
import { contactFormError, contactMailto, type ContactFields as Fields } from './contactForm';
import { CONTACT_PAGE, LEGAL_CONTACT_EMAIL } from './legalDocuments';
import { useBrandTokens } from '@/lib/brand';

const ICONS = { email: Mail, help: BookOpen, privacy: ShieldCheck } as const;

/** A sentence with `{email}` drawn as a link to write to. */
function WithEmail({ text, email }: { text: string; email: string }) {
  return (
    <>
      {text.split('{email}').map((part, index) => (
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
    </>
  );
}

/**
 * The contact page, public and signed out, in English: the site's contact
 * form and the ways to reach the team, laid out as the privacy policy and
 * terms are. The form writes nothing to a server — it opens the reader's
 * email app with the message ready to send.
 */
export default function ContactPage() {
  const [fields, setFields] = useState<Fields>({ name: '', email: '', subject: '', message: '' });
  const [error, setError] = useState<string | null>(null);
  const { form } = CONTACT_PAGE;
  // The brand per edition (shared/brand.ts): WebYar's name and address in
  // Iran, as always; the platform's own abroad.
  const { fill, supportEmail } = useBrandTokens('en');
  const email = supportEmail || LEGAL_CONTACT_EMAIL;
  const pageTitle = fill(CONTACT_PAGE.pageTitle);

  useEffect(() => {
    const url = `${window.location.origin}/contact`;
    applySeoHead({
      title: pageTitle,
      description: CONTACT_PAGE.subtitle,
      canonical: url,
      locale: 'en',
      dir: 'ltr',
      jsonLd: { '@context': 'https://schema.org', '@type': 'ContactPage', name: CONTACT_PAGE.title, url, inLanguage: 'en' },
    });
  }, [pageTitle]);

  const set = (key: keyof Fields) => (value: string) => {
    setFields((current) => ({ ...current, [key]: value }));
    setError(null);
  };

  function submit(event: FormEvent) {
    event.preventDefault();
    const problem = contactFormError(fields);
    setError(problem);
    if (!problem) window.location.href = contactMailto(fields, email);
  }

  return (
    <LegalLayout>
      <div className="duration-500 animate-in fade-in slide-in-from-bottom-4">
        <h1 className="mb-2 text-3xl font-extrabold text-foreground sm:text-4xl">{CONTACT_PAGE.title}</h1>
        <p className="mb-10 text-sm text-muted-foreground">{CONTACT_PAGE.subtitle}</p>
      </div>

      <form
        onSubmit={submit}
        noValidate
        className="space-y-5 rounded-xl border border-border bg-card p-6 shadow-sm duration-500 animate-in fade-in slide-in-from-bottom-4"
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <Label htmlFor="contact-name" className="text-xs">{form.name}</Label>
            <Input
              id="contact-name"
              className="mt-1"
              autoComplete="name"
              value={fields.name}
              onChange={(e) => set('name')(e.target.value)}
            />
          </div>
          <div>
            <Label htmlFor="contact-email" className="text-xs">{form.email}</Label>
            <Input
              id="contact-email"
              type="email"
              className="mt-1"
              autoComplete="email"
              value={fields.email}
              onChange={(e) => set('email')(e.target.value)}
            />
          </div>
        </div>
        <div>
          <Label htmlFor="contact-subject" className="text-xs">{form.subject}</Label>
          <Input
            id="contact-subject"
            className="mt-1"
            value={fields.subject}
            onChange={(e) => set('subject')(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="contact-message" className="text-xs">{form.message}</Label>
          <Textarea
            id="contact-message"
            className="mt-1"
            rows={5}
            value={fields.message}
            onChange={(e) => set('message')(e.target.value)}
          />
        </div>
        {error && (
          <p role="alert" className="text-sm font-medium text-destructive">
            {error}
          </p>
        )}
        <Button type="submit" className="h-11 w-full">
          <Send className="me-2 h-4 w-4" />
          {form.send}
        </Button>
        <p className="text-center text-xs text-muted-foreground">
          <WithEmail text={form.note} email={email} />
        </p>
      </form>

      <div className="mt-8 grid grid-cols-1 gap-4 sm:grid-cols-3">
        {CONTACT_PAGE.cards.map((card) => {
          const Icon = ICONS[card.kind];
          return (
            <section
              key={card.kind}
              className="flex flex-col gap-3 rounded-xl border border-border bg-card p-5 shadow-sm duration-500 animate-in fade-in slide-in-from-bottom-4"
            >
              <Icon className="h-5 w-5 text-primary" aria-hidden />
              <div>
                <h2 className="text-sm font-semibold text-foreground">{card.title}</h2>
                <p className="mt-1 text-xs leading-6 text-muted-foreground">
                  <WithEmail text={fill(card.text)} email={email} />
                </p>
              </div>
              {'link' in card && (
                <Link to={card.link.to} className="mt-auto text-xs font-medium text-primary underline-offset-4 hover:underline">
                  {card.link.label}
                </Link>
              )}
            </section>
          );
        })}
      </div>
    </LegalLayout>
  );
}
