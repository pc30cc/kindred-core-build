/**
 * The contact page at /contact: English, with the address to write to, and a
 * form that becomes a ready-to-send email in the reader's own mail app.
 */
import { describe, it, expect } from 'vitest';
import { contactFormError, contactMailto } from '@/pages/public/legal/contactForm';
import { CONTACT_PAGE, LEGAL_CONTACT_EMAIL } from '@/pages/public/legal/legalDocuments';

const filled = { name: 'Emma Collins', email: 'emma@example.com', subject: 'App question', message: 'How do I add a colleague?' };

describe('contact page', () => {
  it('is in English and gives the address to write to', () => {
    const text = JSON.stringify(CONTACT_PAGE);
    expect(text).not.toMatch(/[؀-ۿ]/);
    expect(CONTACT_PAGE.cards.find((card) => card.kind === 'email')?.text).toContain('{email}');
    expect(LEGAL_CONTACT_EMAIL).toBe('info@webyar.ai');
  });

  it('asks for each field the site asks for, in order', () => {
    const { errors } = CONTACT_PAGE.form;
    expect(contactFormError({ ...filled, name: 'E' })).toBe(errors.name);
    expect(contactFormError({ ...filled, email: 'emma@' })).toBe(errors.email);
    expect(contactFormError({ ...filled, subject: ' ' })).toBe(errors.subject);
    expect(contactFormError({ ...filled, message: 'Hi' })).toBe(errors.message);
    expect(contactFormError(filled)).toBeNull();
  });

  it('hands the message to the mail app, signed with who wrote it', () => {
    const url = new URL(contactMailto(filled));
    expect(url.protocol).toBe('mailto:');
    expect(url.pathname).toBe('info@webyar.ai');
    expect(url.searchParams.get('subject')).toBe('App question');
    expect(url.searchParams.get('body')).toBe('How do I add a colleague?\n\nFrom: Emma Collins <emma@example.com>');
  });
});
