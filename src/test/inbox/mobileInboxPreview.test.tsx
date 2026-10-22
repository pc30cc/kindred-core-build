/**
 * The mobile web inbox list (src/mobile/MobileInboxPage.tsx) previews the
 * last message the way the desktop list does: a system notice in the app's
 * language from its kind, an attachment-only turn as a sentence, else the
 * body. It printed `last.body`, so every system notice read in English
 * ("Your message is in the support queue.") in a Persian inbox.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fa from '@/i18n/locales/fa';

const DICT = fa as unknown as Record<string, Record<string, string>>;
function t(key: string, params?: Record<string, string | number>) {
  const dot = key.indexOf('.');
  let v = DICT[key.slice(0, dot)]?.[key.slice(dot + 1)] ?? key;
  for (const [p, val] of Object.entries(params || {})) v = v.split(`{{${p}}}`).join(String(val));
  return v;
}

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t, locale: 'fa', dir: 'rtl' }) }));
vi.mock('@/hooks/useWorkspace', () => ({ useCurrentWorkspace: () => ({ id: 'ws-1', name: 'Shop' }) }));
vi.mock('@/hooks/useInboxListRealtime', () => ({ useInboxListRealtime: () => undefined }));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));

const rows = vi.hoisted(() => ({ list: [] as unknown[] }));
vi.mock('@/hooks/useConversations', () => ({
  useConversations: () => ({ data: rows.list, isLoading: false }),
  useUpdateConversation: () => ({ mutate: () => undefined }),
}));

const { default: MobileInboxPage } = await import('@/mobile/MobileInboxPage');

function conversation(id: string, last: Record<string, unknown>) {
  return {
    id,
    status: 'open',
    updated_at: '2026-10-18T10:00:00Z',
    contacts: { name: 'Mina', email: null },
    metadata: {},
    last_message: { created_at: '2026-10-18T10:00:00Z', ...last },
  };
}

function previews(): string[] {
  const { container } = render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter initialEntries={['/shop/inbox']}>
        <MobileInboxPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return [...container.querySelectorAll('li p')].map((p) => (p.textContent || '').trim());
}

describe('the mobile inbox list preview', () => {
  it('writes system notices in the app language, not the stored English body', () => {
    rows.list = [
      conversation('c1', {
        sender_type: 'system', body: 'Your message is in the support queue.', system_kind: 'routing_in_queue', system_meta: { kind: 'routing_in_queue' },
      }),
      conversation('c2', {
        sender_type: 'system', body: 'Sara closed the conversation', system_kind: 'conversation_closed', system_meta: { kind: 'conversation_closed', agent_name: 'Sara' },
      }),
    ];
    const [queue, closed] = previews();
    expect(queue).toBe('بازدیدکننده در صف پشتیبانی منتظر است');
    expect(closed).toBe('Sara گفتگو را بست');
  });

  it('keeps the stored body for a kind it cannot write', () => {
    rows.list = [conversation('c1', { sender_type: 'system', body: 'Something new', system_kind: 'something_new', system_meta: {} })];
    expect(previews()).toEqual(['Something new']);
  });

  it('describes an attachment-only turn instead of a dash', () => {
    rows.list = [
      conversation('c1', { sender_type: 'contact', body: '', attachment_kind: 'image' }),
      conversation('c2', { sender_type: 'agent', sender_id: 'me', body: '', attachment_kind: 'file' }),
    ];
    expect(previews()).toEqual(['Mina یک تصویر ارسال کرد', 'شما یک فایل ارسال کردید']);
  });

  it('still shows a reply body with its marker', () => {
    rows.list = [conversation('c1', { sender_type: 'agent', sender_id: 'me', body: 'سلام' })];
    expect(previews()).toEqual(['↩ سلام']);
  });
});
