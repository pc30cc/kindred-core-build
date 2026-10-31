/**
 * What a visitor or customer reads, made from the dashboard (an AI draft, a
 * playground answer, a KB article, a widget preview), is in a VISITORS'
 * language (src/lib/region.ts contentLocaleFor): the dashboard's own when
 * visitors have it, else their first. A WebYar dashboard may be English or
 * Turkish (shared/panelLanguages.ts) while its visitors stay Persian.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { contentLocaleFor, allowedLocalesFor } from '@/lib/region';

const root = path.resolve(__dirname, '../../..');
const read = (file: string) => readFileSync(path.join(root, file), 'utf8');

describe('contentLocaleFor', () => {
  it('WebYar (visitors: Persian only): an English or Turkish dashboard still writes Persian', () => {
    const visitors = allowedLocalesFor('iran', ['fa', 'tr', 'ar', 'en']);
    expect(visitors).toEqual(['fa']);
    expect(contentLocaleFor('en', visitors)).toBe('fa');
    expect(contentLocaleFor('tr', visitors)).toBe('fa');
    expect(contentLocaleFor('fa', visitors)).toBe('fa');
  });

  it("RESPOK (visitors: English and Turkish): the dashboard's own language, as before", () => {
    const visitors = allowedLocalesFor('multi', ['en', 'tr']);
    expect(contentLocaleFor('en', visitors)).toBe('en');
    expect(contentLocaleFor('tr', visitors)).toBe('tr');
    expect(contentLocaleFor('fa', visitors)).toBe('en');
  });

  it("no visitor languages known: the dashboard's language", () => {
    expect(contentLocaleFor('tr', [])).toBe('tr');
  });
});

describe('the screens that write for visitors use it, never the bare UI locale', () => {
  const SCREENS: Array<[string, RegExp]> = [
    // The AI draft an operator sends to a visitor.
    ['src/components/inbox/OperatorAssistPanel.tsx', /locale:\s*draftLocale/],
    // The AI playground's answer and its dry run play a visitor's question.
    ['src/pages/app/ai-agent/PlaygroundPage.tsx', /locale:\s*replyLocale/],
    // KB articles written by the AI builder.
    ['src/components/app/knowledge/AiKbBuilderTab.tsx', /createJob\([^)]*locale:\s*contentLocale/],
    // The Super Admin's widget template previews.
    ['src/components/admin/widget/WidgetCatalogSection.tsx', /locale:\s*previewLocale/],
  ];

  for (const [file, use] of SCREENS) {
    it(file, () => {
      const src = read(file);
      expect(src).toContain('contentLocaleFor(');
      expect(src).toMatch(use);
    });
  }

  it("the playground's dry run plays the same visitor language", () => {
    expect(read('src/pages/app/ai-agent/PlaygroundPage.tsx')).toMatch(/visitorLocale:\s*replyLocale/);
  });
});
