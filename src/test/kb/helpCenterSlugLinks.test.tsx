/**
 * The SPA help center's article and category links (HelpCategoryPage,
 * HelpSearchPage, HelpIndexPage). A slug is its workspace's free text, and
 * react-router 6 resolves `/help/en/a/../../../\evil.example` to
 * `/\evil.example`, which it hands to pushState as it is: the browser reads
 * `//evil.example` and the visitor lands there (GHSA-wrjc-x8rr-h8h6, fixed
 * only in react-router 7.18). Each slug is now one encoded path segment: the
 * link stays under /help on this site, and the article route gets the slug
 * back as it was.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';

const state = vi.hoisted(() => ({ slugs: [] as string[] }));

vi.mock('@/lib/seoHead', () => ({ applySeoHead: () => {} }));
vi.mock('@/lib/kb-api', () => ({
  fetchKbCategories: async () => [
    { id: 'cat-0', name: 'Category', slug: 'cat' },
    ...state.slugs.map((slug, i) => ({ id: `cat-${i + 1}`, name: `Category ${i + 1}`, slug })),
  ],
  searchKbArticles: async () => state.slugs.map((slug, i) => ({ title: `Result ${i}`, slug })),
}));

const HelpCategoryPage = (await import('@/pages/public/kb/HelpCategoryPage')).default;
const HelpSearchPage = (await import('@/pages/public/kb/HelpSearchPage')).default;
const HelpIndexPage = (await import('@/pages/public/kb/HelpIndexPage')).default;

const SITE = 'https://app.webyar.ai';

/** Slugs that reach another site when written into the path as they are. */
const ESCAPES = ['../../../\\evil.example', '../../../\\t/evil.example', '../../../\t/evil.example'];
const PAYLOADS = [
  '/\\evil.example',
  '/\\t/evil.example',
  '/\t/evil.example',
  '//evil.example',
  'https://evil.example',
  'javascript:alert(1)',
  '../../..//evil.example',
  ...ESCAPES,
];
const LEGIT = ['getting-started', 'راهنمای‌شروع'];

/** Where the route a link opened leads, and the slug it read. */
function Opened({ kind }: { kind: 'a' | 'c' }) {
  const { slug } = useParams();
  return <div data-testid="opened">{`${kind}:${slug}`}</div>;
}
/** The category page for the fixture's own category, else the category a link opened. */
function Category() {
  return useParams().slug === 'cat' ? <HelpCategoryPage /> : <Opened kind="c" />;
}
function Elsewhere() {
  return <div data-testid="opened">{`elsewhere:${useLocation().pathname}`}</div>;
}

function mount(entry: string) {
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/help/:locale" element={<HelpIndexPage />} />
        <Route path="/help/:locale/search" element={<HelpSearchPage />} />
        <Route path="/help/:locale/c/:slug" element={<Category />} />
        <Route path="/help/:locale/a/:slug" element={<Opened kind="a" />} />
        <Route path="*" element={<Elsewhere />} />
      </Routes>
    </MemoryRouter>,
  );
}

/** The links drawn for the given slugs, in their order. */
async function linksFor(page: 'category' | 'search' | 'index', slugs: string[]): Promise<HTMLAnchorElement[]> {
  state.slugs = slugs;
  vi.stubGlobal('fetch', async () => ({
    ok: true,
    json: async () => ({ articles: slugs.map((slug, i) => ({ title: `Article ${i}`, slug })) }),
  }));
  const entry = page === 'category' ? '/help/en/c/cat' : page === 'search' ? '/help/en/search?q=help' : '/help/en';
  mount(entry);
  const name = page === 'category' ? /^Article \d+$/ : page === 'search' ? /^Result \d+$/ : /^Category \d+$/;
  const texts = await screen.findAllByText(name);
  expect(texts).toHaveLength(slugs.length);
  return texts.map((t) => t.closest('a') as HTMLAnchorElement);
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe.each([
  ['category', 'a', '/help/en/a/'],
  ['search', 'a', '/help/en/a/'],
  ['index', 'c', '/help/en/c/'],
] as const)('the help center %s page', (page, kind, prefix) => {
  it('written in as they are, the escapes would leave the site (the check sees it)', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/help/en/c/cat']}>
        {ESCAPES.map((slug) => <Link key={slug} to={`${prefix}${slug}`}>{slug}</Link>)}
      </MemoryRouter>,
    );
    container.querySelectorAll('a').forEach((a, i) => {
      const href = a.getAttribute('href') || '';
      expect(new URL(href, `${SITE}/help/en/c/cat`).host, JSON.stringify(ESCAPES[i])).not.toBe('app.webyar.ai');
    });
    expect(container.querySelectorAll('a')).toHaveLength(ESCAPES.length);
  });

  it('never links off the help center, whatever the slug', async () => {
    const links = await linksFor(page, PAYLOADS);
    links.forEach((a, i) => {
      const href = a.getAttribute('href') || '';
      const url = new URL(href, `${SITE}/help/en/c/cat`);
      expect(url.host, JSON.stringify(PAYLOADS[i])).toBe('app.webyar.ai');
      expect(href.startsWith(prefix), href).toBe(true);
      expect(href.slice(prefix.length), href).not.toMatch(/[/\\\t]/);
    });
  });

  it('a click opens that slug, even a hostile one, inside the help center', async () => {
    const links = await linksFor(page, PAYLOADS);
    fireEvent.click(links[PAYLOADS.indexOf('../../../\\evil.example')]);
    expect(screen.getByTestId('opened').textContent).toBe(`${kind}:../../../\\evil.example`);
  });

  it.each(LEGIT)('a real slug (%s) still opens its page', async (slug) => {
    const [link] = await linksFor(page, [slug]);
    expect(decodeURIComponent(link.getAttribute('href') || '')).toBe(`${prefix}${slug}`);
    fireEvent.click(link);
    expect(screen.getByTestId('opened').textContent).toBe(`${kind}:${slug}`);
  });
});
