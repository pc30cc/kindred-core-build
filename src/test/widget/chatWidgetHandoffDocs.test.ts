/**
 * docs/chat-widget-handoff: the links in the committed handoff.
 *
 *  - Only the handoff's specs were committed (READMEs, tokens.json, the design
 *    stylesheets, brand SVGs). Its board sources (`source/`), static reference
 *    pages (`reference/*.html`), font files (`reference/fonts/`,
 *    `reference/css/fonts.css`) and screenshots (`screens/`) were left out of
 *    the repository. Every relative link resolves, or points into one of those
 *    left-out folders and the README says so before its first section.
 *  - IMPLEMENTATION_NOTES.md: every "`<file>` (search `<text>`)" pointer names
 *    a file that exists and holds that text.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative, resolve } from 'node:path';

const ROOT = resolve(process.cwd(), 'docs/chat-widget-handoff');
const LEFT_OUT = /^(?:source\/|screens\/|reference\/[^/]+\.html$|reference\/fonts\/|reference\/css\/fonts\.css$)/;
const NOTE = /left out of the repository/;

function markdownFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return markdownFiles(p);
    return e.name.endsWith('.md') ? [p] : [];
  });
}

function relativeLinks(text: string): string[] {
  const prose = text.replace(/```[\s\S]*?```/g, '');
  const out: string[] = [];
  for (const m of prose.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const target = m[1].split('#')[0];
    if (target && !/^[a-z][a-z0-9+.-]*:/i.test(target)) out.push(target);
  }
  return out;
}

describe('chat widget handoff docs', () => {
  const files = markdownFiles(ROOT);

  it('finds the handoff', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('every relative link resolves, or points into a folder the README says was left out', () => {
    const problems: string[] = [];
    for (const file of files) {
      const text = readFileSync(file, 'utf8');
      const intro = text.split(/\n## /)[0];
      for (const target of relativeLinks(text)) {
        if (existsSync(normalize(join(dirname(file), target)))) continue;
        const where = `${relative(ROOT, file)} -> ${target}`;
        if (!LEFT_OUT.test(target)) problems.push(`${where}: missing`);
        else if (!NOTE.test(intro)) problems.push(`${where}: left out, but the README does not say so before its first section`);
      }
    }
    expect([...new Set(problems)]).toEqual([]);
  });

  it('IMPLEMENTATION_NOTES: each "(search `…`)" pointer names a file that holds the text', () => {
    const notes = readFileSync(join(ROOT, 'IMPLEMENTATION_NOTES.md'), 'utf8');
    // "`a.js` (search `x`)" and "`a.js`, search `x`".
    const pointers = [...notes.matchAll(/`([\w./-]+\.[a-z]+)`(?: \(|, )search `([^`]+)`/g)];
    expect(pointers.length).toBeGreaterThan(0);
    for (const [, path, needle] of pointers) {
      const abs = resolve(process.cwd(), path);
      expect(existsSync(abs), path).toBe(true);
      expect(readFileSync(abs, 'utf8').includes(needle), `${path} holds ${needle}`).toBe(true);
    }
  });
});
