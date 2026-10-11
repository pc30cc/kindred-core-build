/**
 * Simple billing phase 4 — how the dashboard shows an article over the plan's
 * max_kb_articles (the server marks it `locked: true`):
 *   - the list: a lock badge with the "upgrade or delete older articles"
 *     tooltip, the row opens read-only, delete stays available;
 *   - the editor: a notice, every field disabled, Save disabled;
 *   - an unlocked article is unchanged (no badge, Save enabled).
 * Texts come from the `kb.locked.*` keys of the real locale files.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

const h = vi.hoisted(() => ({
  articles: [] as Array<Record<string, unknown>>,
  locale: 'en',
  navigate: vi.fn(),
  deleteMutate: vi.fn(),
  updateMutate: vi.fn(),
  params: {} as { id?: string },
}));

vi.mock('@/i18n', async () => {
  const dicts: Record<string, unknown> = {
    en: (await import('@/i18n/locales/en')).default,
    fa: (await import('@/i18n/locales/fa')).default,
  };
  // `kb.locked.*` from the locale files; every other key comes back as is.
  const t = (k: string) => {
    if (!k.startsWith('kb.locked.')) return k;
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
vi.mock('react-router-dom', () => ({
  useNavigate: () => h.navigate,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useParams: () => h.params,
}));
vi.mock('@/components/app/knowledge/KnowledgeQnaTab', () => ({ default: () => null }));
vi.mock('@/components/app/knowledge/KnowledgeFilesTab', () => ({ default: () => null }));
vi.mock('@/components/app/knowledge/RichTextEditor', () => ({
  default: ({ value }: { value: string }) => <div data-testid="rte">{value}</div>,
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/hooks/useKnowledgeBase', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useKnowledgeBase')>()),
  useKBArticles: () => ({ data: h.articles, isLoading: false }),
  useDeleteKBArticle: () => ({ mutate: h.deleteMutate }),
  useCreateKBArticle: () => ({ mutateAsync: vi.fn(), isPending: false }),
  useUpdateKBArticle: () => ({ mutateAsync: h.updateMutate, isPending: false }),
}));

import KnowledgeBasePage from '@/pages/app/KnowledgeBasePage';
import ArticleEditorPage from '@/pages/app/knowledge/ArticleEditorPage';

function article(id: string, title: string, locked?: boolean) {
  return {
    id, title, slug: id, content: '<p>body</p>', excerpt: '', locale: 'en', status: 'published',
    workspace_id: 'ws-1', knowledge_base_categories: null, ...(locked === undefined ? {} : { locked }),
  };
}

beforeEach(() => {
  h.locale = 'en';
  h.params = {};
  h.navigate.mockReset();
  h.deleteMutate.mockReset();
  h.updateMutate.mockReset();
  h.articles = [article('a-1', 'Open article', false), article('a-2', 'Locked article', true)];
});

describe('KnowledgeBasePage — locked articles', () => {
  it('marks only the locked row, with the plan tooltip', () => {
    const { container } = render(<KnowledgeBasePage />);
    const badges = container.querySelectorAll('[data-kb-lock-badge]');
    expect(badges).toHaveLength(1);
    expect(badges[0].textContent).toContain('Locked');
    expect(badges[0].getAttribute('title')).toBe('Locked by your plan limit: upgrade, or delete older articles.');
    const rows = container.querySelectorAll('[data-kb-locked="true"]');
    expect(rows).toHaveLength(1);
    expect(rows[0].textContent).toContain('Locked article');
  });

  it('a locked row still opens (read-only) and can still be deleted', () => {
    const { container } = render(<KnowledgeBasePage />);
    const row = container.querySelector('[data-kb-locked="true"]')!;
    const buttons = row.querySelectorAll('button');
    fireEvent.click(buttons[0]);
    expect(h.navigate).toHaveBeenCalledWith('/knowledge-base/articles/a-2');
    fireEvent.click(buttons[1]);
    expect(h.deleteMutate).toHaveBeenCalledWith('a-2');
  });

  it('Persian text uses Persian letters', () => {
    h.locale = 'fa';
    const { container } = render(<KnowledgeBasePage />);
    const badge = container.querySelector('[data-kb-lock-badge]')!;
    expect(badge.textContent).toContain('قفل‌شده');
    expect(badge.getAttribute('title')).not.toMatch(/[يك]/);
  });
});

describe('ArticleEditorPage — locked article', () => {
  it('shows the notice and disables every field and Save', () => {
    h.params = { id: 'a-2' };
    const { container } = render(<ArticleEditorPage />);
    expect(container.querySelector('[data-kb-locked-notice]')?.textContent).toMatch(/over your plan's article limit/);
    expect(container.querySelector('fieldset')?.disabled).toBe(true);
    const save = screen.getByText('knowledgeBase.editor.publishAction').closest('button')!;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(h.updateMutate).not.toHaveBeenCalled();
  });

  it('an unlocked article is editable as before', () => {
    h.params = { id: 'a-1' };
    const { container } = render(<ArticleEditorPage />);
    expect(container.querySelector('[data-kb-locked-notice]')).toBeNull();
    expect(container.querySelector('fieldset')?.disabled).toBe(false);
    expect(screen.getByText('knowledgeBase.editor.publishAction').closest('button')!.disabled).toBe(false);
  });
});
