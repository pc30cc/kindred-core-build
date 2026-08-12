/**
 * src/lib/bidi.ts — Unicode bidi isolation (FSI/PDI) for short foreign-
 * direction runs (a Latin visitor code, or a Latin city-name fallback)
 * embedded inside an RTL (or LTR) sentence. Works identically for JSX text
 * nodes and plain-string contexts (title/alt attributes, native dialogs,
 * search text) since it's the string content itself that carries the
 * isolation, not markup.
 */
import { describe, it, expect } from 'vitest';
import { isolateBidi } from '../../lib/bidi';

const FSI = '⁨';
const PDI = '⁩';

describe('isolateBidi', () => {
  it('wraps text in First Strong Isolate / Pop Directional Isolate', () => {
    expect(isolateBidi('PTXJ')).toBe(`${FSI}PTXJ${PDI}`);
  });

  it('does not alter the wrapped text itself — no reversal, no character reordering', () => {
    const wrapped = isolateBidi('PTXJ');
    const inner = wrapped.slice(1, -1);
    expect(inner).toBe('PTXJ');
    expect(inner).not.toBe('JXTP');
  });

  it('returns empty string for null/undefined/empty input — never throws', () => {
    expect(isolateBidi(null)).toBe('');
    expect(isolateBidi(undefined)).toBe('');
    expect(isolateBidi('')).toBe('');
  });

  it('works on RTL text the same way (auto-detects direction from content, does not force LTR)', () => {
    const wrapped = isolateBidi('استانبول');
    expect(wrapped).toBe(`${FSI}استانبول${PDI}`);
  });

  it('composes safely when interpolated into a larger sentence — the isolate markers are invisible characters, not visible markup', () => {
    const sentence = `بازدیدکننده از ${isolateBidi('Reykjavik')} · ${isolateBidi('PTXJ')}`;
    // Stripping the isolate markers recovers exactly the plain concatenation.
    const stripped = sentence.replace(new RegExp(FSI, 'g'), '').replace(new RegExp(PDI, 'g'), '');
    expect(stripped).toBe('بازدیدکننده از Reykjavik · PTXJ');
  });
});
