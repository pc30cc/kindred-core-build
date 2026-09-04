import { describe, it, expect } from 'vitest';
import { parseHtml } from '../../../server/services/seo/crawler/htmlParse.js';

const SAMPLE_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>  Example  Page Title  </title>
  <meta name="description" content="A concise description of this page.">
  <link rel="canonical" href="https://example.com/page">
  <meta name="robots" content="noindex, nofollow">
  <meta property="og:title" content="Example">
  <meta name="twitter:card" content="summary">
  <script type="application/ld+json">{"@type": "Article", "headline": "hi"}</script>
</head>
<body>
  <h1>Main Heading</h1>
  <h2>Sub A</h2>
  <h2>Sub B</h2>
  <p>Some visible body text with a handful of words in it for counting purposes.</p>
  <a href="/relative">Relative link</a>
  <a href="https://external.example/page" rel="nofollow">External</a>
  <img src="/a.png" alt="described">
  <img src="/b.png">
</body>
</html>`;

describe('parseHtml — SEO metadata extraction', () => {
  const parsed = parseHtml(SAMPLE_HTML, 'https://example.com/page');

  it('extracts and trims the title', () => {
    expect(parsed.title).toBe('Example Page Title');
  });

  it('extracts meta description', () => {
    expect(parsed.metaDescription).toBe('A concise description of this page.');
  });

  it('resolves canonical to an absolute URL', () => {
    expect(parsed.canonicalUrl).toBe('https://example.com/page');
  });

  it('extracts meta robots directives', () => {
    expect(parsed.metaRobots).toBe('noindex, nofollow');
  });

  it('counts headings correctly', () => {
    expect(parsed.h1).toBe('Main Heading');
    expect(parsed.h1Count).toBe(1);
    expect(parsed.h2Count).toBe(2);
  });

  it('resolves relative links to absolute URLs and captures rel', () => {
    const relative = parsed.links.find((l) => l.href === 'https://example.com/relative');
    const external = parsed.links.find((l) => l.href === 'https://external.example/page');
    expect(relative).toBeTruthy();
    expect(external?.rel).toBe('nofollow');
  });

  it('detects images missing alt text', () => {
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images.filter((i) => !i.hasAlt)).toHaveLength(1);
  });

  it('detects Open Graph and Twitter Card presence', () => {
    expect(parsed.hasOpenGraph).toBe(true);
    expect(parsed.hasTwitterCard).toBe(true);
  });

  it('parses valid JSON-LD structured data and collects @type', () => {
    expect(parsed.structuredData.has).toBe(true);
    expect(parsed.structuredData.types).toContain('Article');
    expect(parsed.structuredData.errors).toHaveLength(0);
  });

  it('detects the html lang attribute', () => {
    expect(parsed.lang).toBe('en');
  });

  it('produces a non-zero word count from visible text', () => {
    expect(parsed.wordCount).toBeGreaterThan(5);
  });

  it('flags invalid JSON-LD as a structured-data error instead of throwing', () => {
    const broken = parseHtml('<script type="application/ld+json">{not valid json}</script>', 'https://example.com/');
    expect(broken.structuredData.has).toBe(true);
    expect(broken.structuredData.errors).toContain('invalid_json_ld');
  });
});
