/**
 * Every literal key the app asks for — t('section.key') — exists in English,
 * Persian and Turkish. A missing key is not caught by `t(k) || 'Fallback'`:
 * the translator returns the key itself, so the operator sees
 * "visitors.country" instead of "Country".
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

function flatten(obj: Record<string, unknown>, prefix = '', out = new Set<string>()): Set<string> {
  for (const [k, v] of Object.entries(obj)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (v && typeof v === 'object') flatten(v as Record<string, unknown>, key, out);
    else out.add(key);
  }
  return out;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name !== 'test' && name !== '__tests__') sourceFiles(path, out);
    } else if (/\.(tsx?|jsx?)$/.test(name) && !/\.test\./.test(name)) {
      out.push(path);
    }
  }
  return out;
}

const LOCALES = { en: flatten(en), fa: flatten(fa), tr: flatten(tr) };
const SECTIONS = new Set<string>();
for (const key of LOCALES.en) {
  const parts = key.split('.');
  for (let i = 1; i < parts.length; i += 1) SECTIONS.add(parts.slice(0, i).join('.'));
}

describe('translation keys', () => {
  it('every t(\'literal.key\') in src exists in en, fa and tr', () => {
    const missing: string[] = [];
    for (const file of sourceFiles(join(process.cwd(), 'src'))) {
      const text = readFileSync(file, 'utf8');
      if (!text.includes('t(')) continue;
      for (const match of text.matchAll(/\bt\(\s*(['"])([A-Za-z][\w-]*(?:\.[\w-]+)+)\1/g)) {
        const key = match[2];
        for (const [locale, keys] of Object.entries(LOCALES)) {
          // A whole section asked for as a key (rare, but valid for en's object lookups) counts as present.
          if (!keys.has(key) && !(locale === 'en' && SECTIONS.has(key))) {
            missing.push(`${locale}: ${key} (${relative(process.cwd(), file)})`);
          }
        }
      }
    }
    expect(missing).toEqual([]);
  });
});
