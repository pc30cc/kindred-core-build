/**
 * Settings → Privacy requests → Visitor privacy
 * (src/components/privacy/VisitorPrivacyCard.tsx, P-01):
 *
 *   - "Wait for visitor consent before tracking" and "Keep query strings in
 *     page history" save their own field (PATCH /api/widget-settings/:id);
 *   - the retention period shows the platform's default (13 months), or the
 *     workspace's own period, and says so when the platform's retention is
 *     paused;
 *   - a refused save says why in the panel's language, never the server's
 *     code;
 *   - a database before 281 (no such columns) shows a note, no switches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastMock, useToast: () => ({ toasts: [], toast: () => {} }) }));

import { VisitorPrivacyCard } from '@/components/privacy/VisitorPrivacyCard';

const WS = '66666666-6666-4666-8666-666666666666';
let stored: Record<string, unknown>;
let retention: Record<string, unknown> | null;
let refuse: { status: number; body: unknown } | 'network' | null;
const patches: unknown[] = [];

beforeEach(() => {
  patches.length = 0;
  refuse = null;
  toastMock.mockReset();
  stored = { workspace_id: WS, tracking_requires_consent: false, tracking_keep_query: false, visitor_data_retention_days: null };
  retention = { default_days: 395, enabled: true };
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
    if (String(url).endsWith(`/api/widget-settings/${WS}`)) {
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body));
        patches.push(body);
        if (refuse === 'network') throw new TypeError('Failed to fetch');
        if (refuse) return json(refuse.body, refuse.status);
        stored = { ...stored, ...body };
        return json({ settings: stored });
      }
      return json({ settings: stored, visitor_retention: retention });
    }
    return json({}, 404);
  }));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

async function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale="en">
        <VisitorPrivacyCard workspaceId={WS} />
      </I18nProvider>
    </QueryClientProvider>,
  );
  await waitFor(() => expect(document.body.textContent).toContain('Visitor privacy'));
}

describe('VisitorPrivacyCard', () => {
  it('each switch saves its own field', async () => {
    await mount();
    fireEvent.click(document.getElementById('visitor-consent')!);
    await waitFor(() => expect(patches).toEqual([{ tracking_requires_consent: true }]));
    await waitFor(() => expect(document.getElementById('visitor-consent')!.getAttribute('aria-checked')).toBe('true'));
    fireEvent.click(document.getElementById('visitor-keep-query')!);
    await waitFor(() => expect(patches).toEqual([{ tracking_requires_consent: true }, { tracking_keep_query: true }]));
  });

  it('the retention period: the platform\'s default, or the workspace\'s own', async () => {
    await mount();
    await waitFor(() => expect(document.getElementById('visitor-retention')!.textContent).toBe('Platform default (13 months)'));
    cleanup();
    stored = { ...stored, visitor_data_retention_days: 90 };
    await mount();
    await waitFor(() => expect(document.getElementById('visitor-retention')!.textContent).toBe('3 months'));
    expect(document.body.textContent).not.toContain('not turned on for the platform');
  });

  it('says so while the platform\'s visitor retention is off (as 281 seeds it)', async () => {
    retention = { default_days: 395, enabled: false };
    await mount();
    await waitFor(() => expect(document.body.textContent).toContain('Deleting old visitor data is not turned on for the platform yet'));
  });

  it('a refused save says why in the panel\'s language, never the server\'s code', async () => {
    await mount();
    const S = en.widgetPage.save;
    const cases: Array<[typeof refuse, string]> = [
      [{ status: 403, body: { error: 'phone_verification_required' } }, S.errorForbidden],
      [{ status: 403, body: { error: 'plan_upgrade_required' } }, S.errorPlan],
      [{ status: 401, body: { error: 'unauthorized' } }, S.errorSession],
      [{ status: 400, body: { error: 'invalid_body', issues: [{ path: 'visitor_data_retention_days', message: 'too small' }] } },
        S.errorInvalidField.replace('{{field}}', en.privacy.visitor.retentionTitle)],
      [{ status: 500, body: { error: 'update or delete on table violates foreign key constraint' } }, S.errorGeneric],
      ['network', S.errorNetwork],
    ];
    for (const [answer, sentence] of cases) {
      refuse = answer;
      toastMock.mockClear();
      fireEvent.click(document.getElementById('visitor-keep-query')!);
      await waitFor(() => expect(toastMock).toHaveBeenCalled());
      expect(toastMock.mock.calls.at(-1)![0]).toEqual({ title: en.privacy.visitor.saveError, description: sentence, variant: 'destructive' });
    }
  });

  it('a database before 281: a note, no switches', async () => {
    stored = { workspace_id: WS };
    await mount();
    expect(document.body.textContent).toContain('These settings become available after the next platform update.');
    expect(document.getElementById('visitor-consent')).toBeNull();
  });
});
