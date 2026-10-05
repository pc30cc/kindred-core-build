/**
 * The privacy policy and terms of use at /privacy and /terms: whole
 * documents, each numbered through and each giving the address to write to.
 */
import { describe, it, expect } from 'vitest';
import { LEGAL_DOCUMENTS } from '@/pages/public/legal/legalDocuments';

describe.each(Object.entries(LEGAL_DOCUMENTS))('%s', (_, doc) => {
  it('numbers its sections 1, 2, 3… without a gap', () => {
    expect(doc.sections.length).toBeGreaterThan(10);
    doc.sections.forEach((section, index) => {
      expect(section.heading).toMatch(new RegExp(`^${index + 1}\\. `));
      expect(section.paragraphs.length).toBeGreaterThan(0);
    });
  });

  it('gives the contact address', () => {
    const text = doc.sections.flatMap((s) => s.paragraphs).join('\n');
    expect(text).toContain('{email}');
  });

  it('is in English, with Latin digits', () => {
    const text = [doc.title, doc.effective, ...doc.sections.flatMap((s) => [s.heading, ...s.paragraphs])].join('\n');
    expect(text).not.toMatch(/[؀-ۿ]/);
  });
});
