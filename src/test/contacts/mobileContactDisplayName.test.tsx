/**
 * The mobile contact profile (src/mobile/MobileContactDetailPage.tsx) names
 * an anonymous contact as the desktop page and drawer do: getDisplayName's
 * third argument is the live network geo (or a city), the fourth the UI
 * locale. The page passed the locale third, behind `as any` casts, so a
 * contact without a name read "Visitor from en · …" whatever its city.
 *
 * @vitest-environment jsdom
 */
import { describe, expect, it, vi } from 'vitest';
import { render } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import en from '@/i18n/locales/en';

const DICT = en as unknown as Record<string, Record<string, string>>;
function t(key: string, params?: Record<string, string | number>) {
  const dot = key.indexOf('.');
  let v = DICT[key.slice(0, dot)]?.[key.slice(dot + 1)] ?? key;
  for (const [p, val] of Object.entries(params || {})) v = v.split(`{{${p}}}`).join(String(val));
  return v;
}

vi.mock('@/i18n', () => ({ useTranslation: () => ({ t, locale: 'en', dir: 'ltr' }) }));

const contact = vi.hoisted(() => ({
  id: 'c-1',
  workspace_id: 'ws-1',
  email: null,
  name: null,
  phone: null,
  avatar_url: null,
  notes: null,
  tags: [],
  metadata: { city: 'Berlin', anon_code: 'K7Q2' },
  visitor_code: 'K7Q2',
  created_at: '2026-10-18T10:00:00Z',
  updated_at: '2026-10-18T10:00:00Z',
}));
vi.mock('@/hooks/useContacts', () => ({
  useContact: () => ({ data: contact, isLoading: false }),
  useContactConversations: () => ({ data: [] }),
}));

const { default: MobileContactDetailPage } = await import('@/mobile/MobileContactDetailPage');

describe('the mobile contact profile', () => {
  it('names an anonymous contact by its city, never by the UI locale', () => {
    const { container } = render(
      <MemoryRouter initialEntries={['/shop/contacts/c-1']}>
        <Routes>
          <Route path="/:slug/contacts/:id" element={<MobileContactDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
    const title = (container.querySelector('p.text-\\[19px\\]')?.textContent || '').trim();
    expect(title).toContain('Berlin');
    expect(title).not.toMatch(/\ben\b/);
  });
});
