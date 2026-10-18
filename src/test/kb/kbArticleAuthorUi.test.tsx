/**
 * The article editor's author select (issue #340 g5-2a): the workspace's
 * members and «no author shown»; a new article shows its creator (the
 * server's default, so nothing is sent unless it is changed); an existing
 * article shows its author, or none when they are no longer a member; a
 * change is sent as `author_user_id` (none → null). Labels in fa, en and tr.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({
  articles: [] as Array<Record<string, unknown>>,
  locale: 'en',
  params: {} as { id?: string },
  createMutate: vi.fn(async () => ({})),
  updateMutate: vi.fn(async () => ({})),
  members: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/i18n', async () => {
  const dicts: Record<string, unknown> = {
    en: (await import('@/i18n/locales/en')).default,
    fa: (await import('@/i18n/locales/fa')).default,
    tr: (await import('@/i18n/locales/tr')).default,
  };
  const t = (k: string) => {
    const v = k.split('.').reduce<unknown>((o, part) => (o as Record<string, unknown> | undefined)?.[part], dicts[h.locale]);
    return typeof v === 'string' ? v : k;
  };
  return { useTranslation: () => ({ t, locale: h.locale, dir: h.locale === 'fa' ? 'rtl' : 'ltr' }) };
});
vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => ({ id: 'ws-1' }),
  useWorkspacePath: () => (p: string) => p,
}));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ allowedLocales: ['en'], canSwitchLanguage: false }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useParams: () => h.params }));
vi.mock('@/components/app/knowledge/RichTextEditor', () => ({ default: () => <div /> }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u-me' } }) }));
vi.mock('@/hooks/useWorkspaceMembers', () => ({ useWorkspaceMembers: () => ({ data: h.members }) }));
vi.mock('@/hooks/useKnowledgeBase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useKnowledgeBase')>()),
  useKBArticles: () => ({ data: h.articles, isLoading: false }),
  useCreateKBArticle: () => ({ mutateAsync: h.createMutate, isPending: false }),
  useUpdateKBArticle: () => ({ mutateAsync: h.updateMutate, isPending: false }),
}));

import ArticleEditorPage from '@/pages/app/knowledge/ArticleEditorPage';

beforeAll(() => {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver ??= class { observe() {} unobserve() {} disconnect() {} };
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => undefined;
  proto.scrollIntoView ??= () => undefined;
});

function article(id: string, author: string | null | undefined) {
  return {
    id, title: 'Shoe returns', slug: id, content: '<p>body</p>', excerpt: '', locale: 'en', status: 'draft',
    workspace_id: 'ws-1', knowledge_base_categories: null, ...(author === undefined ? {} : { author_user_id: author }),
  };
}
const trigger = (container: HTMLElement) => container.querySelector('[data-kb-author]') as HTMLElement;
async function choose(container: HTMLElement, option: string) {
  fireEvent.keyDown(trigger(container), { key: 'Enter' });
  fireEvent.click(await screen.findByRole('option', { name: option }));
}
const save = () => fireEvent.click(screen.getByRole('button', { name: /Save|Create/ }));

beforeEach(() => {
  h.locale = 'en';
  h.params = {};
  h.createMutate.mockClear();
  h.updateMutate.mockClear();
  h.members = [
    { user_id: 'u-me', role: 'owner', full_name: 'Me Myself', email: 'me@x.test', avatar_url: null },
    { user_id: 'u-sara', role: 'agent', full_name: 'سارا', email: 'sara@x.test', avatar_url: null },
    { user_id: 'u-noname', role: 'agent', full_name: null, email: 'noname@x.test', avatar_url: null },
  ];
  h.articles = [article('a-1', 'u-sara'), article('a-2', null), article('a-3', 'u-gone'), article('a-4', undefined)];
});

describe('the author select', () => {
  it('a new article shows its creator, and sends no author unless changed', async () => {
    const { container } = render(<ArticleEditorPage />);
    expect(trigger(container).textContent).toBe('Me Myself');
    fireEvent.change(container.querySelector('input')!, { target: { value: 'New article' } });
    save();
    await vi.waitFor(() => expect(h.createMutate).toHaveBeenCalled());
    expect(h.createMutate.mock.calls[0][0]).not.toHaveProperty('author_user_id');
  });

  it('lists none and every member (name, else e-mail)', async () => {
    const { container } = render(<ArticleEditorPage />);
    fireEvent.keyDown(trigger(container), { key: 'Enter' });
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual(['No author shown', 'Me Myself', 'سارا', 'noname@x.test']);
  });

  it('choosing none on a new article sends null; choosing a member sends their id', async () => {
    const { container } = render(<ArticleEditorPage />);
    fireEvent.change(container.querySelector('input')!, { target: { value: 'New article' } });
    await choose(container, 'No author shown');
    save();
    await vi.waitFor(() => expect(h.createMutate).toHaveBeenCalled());
    expect(h.createMutate.mock.calls[0][0]).toMatchObject({ author_user_id: null });
  });

  it('an existing article shows its author; a change is sent, no change sends nothing', async () => {
    h.params = { id: 'a-1' };
    const first = render(<ArticleEditorPage />);
    expect(trigger(first.container).textContent).toBe('سارا');
    save();
    await vi.waitFor(() => expect(h.updateMutate).toHaveBeenCalledTimes(1));
    expect(h.updateMutate.mock.calls[0][0]).not.toHaveProperty('author_user_id');
    first.unmount();
    const second = render(<ArticleEditorPage />);
    await choose(second.container, 'Me Myself');
    save();
    await vi.waitFor(() => expect(h.updateMutate).toHaveBeenCalledTimes(2));
    expect(h.updateMutate.mock.calls[1][0]).toMatchObject({ id: 'a-1', author_user_id: 'u-me' });
  });

  it('no author, an author who left, or a database before the column: shown as none', () => {
    for (const id of ['a-2', 'a-3', 'a-4']) {
      h.params = { id };
      const { container, unmount } = render(<ArticleEditorPage />);
      expect(trigger(container).textContent, id).toBe('No author shown');
      unmount();
    }
  });

  it.each([
    ['fa', 'نویسنده', 'بدون نام نویسنده'],
    ['en', 'Author', 'No author shown'],
    ['tr', 'Yazar', 'Yazar gösterilmesin'],
  ])('%s labels', (locale, label, none) => {
    h.locale = locale;
    h.params = { id: 'a-2' };
    const { container } = render(<ArticleEditorPage />);
    expect(container.querySelector('label[for="kb-article-author"]')?.textContent).toBe(label);
    expect(trigger(container).textContent).toBe(none);
  });
});
