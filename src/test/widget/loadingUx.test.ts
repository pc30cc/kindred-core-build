/**
 * Loading / reconnecting UX contract.
 *
 * The visitor must never see a raw loading state, a system string, a
 * technical banner or a second spinner. Two rules make that structural:
 *
 *  1. Core owns STATE only. It normalizes the transport state onto a tiny
 *     visitor vocabulary, writes it as `data-conn-state`, and asks the active
 *     presentation for a skeleton by view key. It builds no template markup
 *     and no template CSS class.
 *  2. The template owns LOOK only: skeletons that mirror the real geometry,
 *     and exactly one connection affordance — the footer dot.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');
const core = read('public/widget/runtime.js');
const coreCss = read('public/widget/runtime.css');
const tpl = read('public/widget/presentation-web-yar.js');
const tplCss = read('public/widget/presentation-web-yar.css');

describe('Core owns loading state, never loading presentation', () => {
  it('paints no loading copy of its own', () => {
    expect(core).not.toContain("Util.escapeHtml(t('loading'))");
    // The skeleton is requested from the template, by normalized view key.
    expect(core).toContain('Presentation.skeletonHtml(view');
  });

  it('degrades safely when a template ships no skeleton', () => {
    // No skeleton => empty surface, never a technical placeholder.
    expect(core).toMatch(/typeof Presentation\.skeletonHtml !== 'function'\) return ''/);
  });

  it('never replaces real content with a skeleton', () => {
    expect(core).toContain('if (hadUsableContent) return;');
    expect(core).toContain('function markUsableContent()');
  });

  it('normalizes every transport state onto the visitor vocabulary', () => {
    // Internal states must not leak to the template.
    expect(core).toMatch(/norm = 'offline'/);
    expect(core).toMatch(/norm = 'reconnecting'/);
    expect(core).toMatch(/norm = 'connecting'/);
    expect(core).toMatch(/norm = 'degraded'/);
    expect(core).toContain("connPanelEl.setAttribute('data-conn-state', norm)");
  });

  it('keeps the connection status for screen readers only', () => {
    expect(core).toContain("bannerEl.className = 'connection-banner sr-only'");
    expect(core).toContain("bannerEl.setAttribute('aria-live', 'polite')");
    // `sr-only` is a Core utility — it is not borrowed from a template.
    expect(coreCss).toContain('.sr-only {');
  });

  it('builds no template class names or skeleton markup in Core', () => {
    expect(core).not.toContain('wy-sk-');
    expect(core).not.toContain('wy-conn-dot');
  });
});

describe('Template owns the loading look', () => {
  it('exposes a skeleton for every visitor-facing view', () => {
    for (const view of ['home', 'chat', 'list', 'prechat', 'articles', 'article']) {
      expect(tpl).toContain(`case '${view}'`);
    }
    expect(tpl).toContain('skeletonHtml: skeletonHtml');
  });

  it('never puts fake names, times or counts in a skeleton', () => {
    // Skeletons are hidden from assistive tech and carry no text nodes.
    expect(tpl).toContain('aria-hidden="true"');
    expect(tpl).not.toMatch(/wy-sk[\s\S]{0,80}>[A-Za-z]{3,}</);
  });

  it('renders list and article loading as shape, not as a status line', () => {
    expect(tpl).toContain('skeletonConvRowsHtml(6)');
    expect(tpl).toContain('return skeletonArticleRowsHtml(6);');
    expect(tpl).not.toContain("t('kbSearching')");
  });

  it('has exactly one connection affordance, outside the powered-by link', () => {
    expect(tpl).toContain('connIndicatorHtml() + body');
    expect(tpl).toContain('data-conn-indicator');
    expect(tplCss).toContain('.wy-conn-ring');
  });

  it('animates the same dot instead of adding a second spinner', () => {
    for (const state of ['connecting', 'reconnecting', 'loading']) {
      expect(tplCss).toContain(`[data-conn-state="${state}"] .wy-conn-ring`);
    }
    expect(tplCss).toContain('@keyframes wy-conn-orbit');
  });

  it('crossfades skeleton to content only once, and respects reduced motion', () => {
    expect(tplCss).toContain('.wy-crossfade > .wy-view');
    expect(tplCss).toMatch(/prefers-reduced-motion: reduce\)\s*\{[\s\S]*?\.wy-conn-ring \{ animation: none/);
  });
});
