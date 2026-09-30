import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

vi.mock('@/i18n', () => ({
  // The card's own English fallbacks, in an English locale.
  useTranslation: () => ({ t: (key: string) => key, locale: 'en', dir: 'ltr' }),
}));

import { SupportRequesterCard } from '@/components/inbox/SupportRequesterCard';
import type { RequesterCardMeta } from '@/components/inbox/requesterMeta';

/**
 * A site user writing to platform support: before their first message the
 * team reads who they are — account, workspaces, plan, operators and this
 * month's usage (docs/PLATFORM_SUPPORT.md, "Who is asking").
 */
const meta: RequesterCardMeta = {
  kind: 'platform_support_requester',
  user: {
    name: 'Sara Ahmadi',
    email: 'sara@shop.example',
    phone: '+989121234567',
    company: 'Sara Shop',
    member_since: '2026-08-01T09:00:00.000Z',
    client_platform: 'android',
    source_workspace: 'Sara Shop',
  },
  workspace_count: 3,
  workspaces: [
    {
      id: 'ws-1',
      name: 'Sara Shop',
      role: 'owner',
      plan: {
        name: 'Startup',
        names: { fa: 'شروع' },
        status: 'active',
        period_end: '2026-10-15T00:00:00.000Z',
        cancel_at_period_end: false,
      },
      operators: { used: 2, limit: 3 },
      contacts: { used: 1, limit: 500 },
      usage: {
        conversations: { used: 42, limit: 1000 },
        visitors: { used: 900, limit: -1 },
        ai_credits: { used: 0, limit: 0 },
        messages: 310,
        storage_bytes: 1536,
        storage_limit_gb: 1,
      },
    },
    { id: 'ws-2', name: 'Other', role: 'agent', plan: null },
  ],
  captured_at: '2026-09-30T19:00:00.000Z',
};

describe('SupportRequesterCard', () => {
  it('shows the person, then each workspace with its plan, operators and usage against its limits', () => {
    render(<SupportRequesterCard meta={meta} />);
    const card = screen.getByTestId('support-requester-card');
    const text = card.textContent ?? '';

    expect(text).toContain('Who is asking');
    expect(text).toContain('Only your team sees this');
    expect(text).toContain('Sara Ahmadi');
    expect(screen.getByText('sara@shop.example').closest('a')?.getAttribute('href')).toBe('mailto:sara@shop.example');
    expect(screen.getByText('+989121234567').closest('a')?.getAttribute('href')).toBe('tel:+989121234567');
    expect(text).toContain('Wrote from Android');
    expect(text).toContain('3 workspaces');
    expect(text).toContain('Startup · active');
    expect(text).toContain('2 / 3');
    expect(text).toContain('42 / 1,000');
    expect(text).toContain('900 / ∞');
    expect(text).toContain('1.5 KB / 1 GB');
    // A workspace the person only works in, without a plan of its own.
    expect(text).toContain('No plan');
    // Two of three shown: the card says there is more.
    expect(text).toContain('and 1 more');
  });

  it('draws nothing it was not given', () => {
    render(<SupportRequesterCard meta={{ kind: 'platform_support_requester', user: { name: 'Ali' } }} />);
    const text = screen.getByTestId('support-requester-card').textContent ?? '';
    expect(text).toContain('Ali');
    expect(text).not.toContain('workspaces');
    expect(text).not.toContain('As of');
  });

  it('is written in all three languages', () => {
    const keysOf = (bundle: Record<string, unknown>) =>
      Object.keys((bundle.inbox ?? {}) as Record<string, unknown>).filter((k) => k.startsWith('requester.')).sort();
    const english = keysOf(en as Record<string, unknown>);
    expect(english.length).toBeGreaterThan(20);
    expect(keysOf(fa as Record<string, unknown>)).toEqual(english);
    expect(keysOf(tr as Record<string, unknown>)).toEqual(english);
  });
});
