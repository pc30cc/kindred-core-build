/**
 * A conversation subject the server wrote because nobody typed one ('New
 * conversation', 'Offline message': ai-agent/intro.ts, routes/widget.ts)
 * is English, so the contact surfaces show the dashboard's localized
 * "untitled" instead, as the inbox and the overview do: one list,
 * shared/conversationSubject.ts. The contact page and drawer kept their own
 * lists without 'offline message'; the mobile contact page checked nothing.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { isPlaceholderSubject } from '../../../shared/conversationSubject';

const SURFACES = [
  'src/pages/app/ContactDetailPage.tsx',
  'src/features/contacts/ContactDrawer.tsx',
  'src/mobile/MobileContactDetailPage.tsx',
];

describe('placeholder subjects on the contact surfaces', () => {
  it('the subjects the server writes are placeholders', () => {
    for (const s of ['Offline message', 'New conversation', '  new chat ', '', null]) expect(isPlaceholderSubject(s), String(s)).toBe(true);
    expect(isPlaceholderSubject('Where is my parcel?')).toBe(false);
  });

  for (const file of SURFACES) {
    it(`${file} titles a conversation through the shared list`, () => {
      const src = readFileSync(file, 'utf8');
      expect(src).toMatch(/from '(\.\.\/)+shared\/conversationSubject'/);
      expect(src).toMatch(/isPlaceholderSubject\([^)]*subject/);
      // No list of its own to fall behind again.
      expect(src).not.toContain('DEFAULT_SUBJECTS');
      expect(src).not.toMatch(/\(c\.subject \|\| ''\)\.trim\(\) \|\| t\('contacts\.conversationUntitled'\)/);
    });
  }
});
