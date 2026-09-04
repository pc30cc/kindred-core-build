/**
 * Live Monitoring UI smoke test — SystemPage's Realtime and Performance
 * cards (server/routes/adminMetrics.ts, adminPerf.ts now read the bounded
 * in-memory collector instead of Postgres).
 *
 * Proves the loading/error/empty distinction added in Step 7 of the Live
 * Monitoring migration: before that fix these cards silently rendered `0`
 * on any failure, indistinguishable from "no traffic yet" after a fresh
 * restart. Both states must now be visibly different.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

vi.mock('@/components/admin/observability/SystemDegradedBanner', () => ({
  default: () => null,
}));
vi.mock('@/components/admin/observability/EffectivePolicyPanel', () => ({
  default: () => null,
}));

import AdminSystemPage from '@/pages/admin/SystemPage';

function jsonOk(body: unknown) {
  return { ok: true, status: 200, json: async () => body } as any;
}
function jsonFail(status = 500) {
  return { ok: false, status, json: async () => ({ error: 'boom' }) } as any;
}

/** Baseline: every non-metrics/perf endpoint SystemPage queries, all empty/healthy. */
function baselineRoute(url: string) {
  if (url.includes('/api/admin/alerts/active')) return jsonOk({ active: [] });
  if (url.includes('/api/admin/auto-actions/active')) return jsonOk({ active: [] });
  if (url.includes('/api/admin/reliability/sla')) {
    return jsonOk({
      range: '24h',
      summary: { uptime_pct: 100, degraded_minutes: 0, failover_count: 0, critical_alert_count: 0 },
      rows: [],
    });
  }
  if (url.includes('/api/admin/reliability/workspace-health')) {
    return jsonOk({ counts: { healthy: 0, warning: 0, at_risk: 0 }, total: 0, latest: [], at_risk: [] });
  }
  if (url.includes('/api/admin/management/runtime-config')) return jsonOk({ config: [] });
  return null;
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale="en" initialTranslations={en}>
        <MemoryRouter>
          <AdminSystemPage />
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

describe('SystemPage — Realtime and Performance cards distinguish error from empty-after-restart', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders live counts on the happy path (no error text anywhere)', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url);
      const base = baselineRoute(u);
      if (base) return base;
      if (u.includes('/api/admin/metrics/summary')) {
        return jsonOk({
          range: '1h',
          since: new Date().toISOString(),
          counts: { 'realtime.token_minted': { total: 42, by_driver: {}, by_source: {} } },
        });
      }
      if (u.includes('/api/admin/perf/summary')) {
        return jsonOk({
          range: '1h',
          since: new Date().toISOString(),
          rows: [{ route_group: 'widget.bootstrap', method: 'POST', count: 10, error_count: 0, sum_ms: 100, max_ms: 20, p50: 5, p95: 12, p99: 15, error_rate: 0, status_groups: {} }],
        });
      }
      if (u.includes('/api/admin/perf/process')) {
        return jsonOk({ range: '1h', since: new Date().toISOString(), samples: [], latest: null });
      }
      throw new Error(`unmocked fetch: ${u}`);
    });

    renderPage();

    expect(await screen.findByText('42')).toBeInTheDocument();
    expect(screen.queryByText(en.admin.system.metricsUnavailable)).toBeNull();
    expect(screen.queryByText(en.admin.system.performanceUnavailable)).toBeNull();
  });

  it('shows metricsUnavailable (not a silent 0) when the realtime summary fetch fails', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url);
      const base = baselineRoute(u);
      if (base) return base;
      if (u.includes('/api/admin/metrics/summary')) return jsonFail();
      if (u.includes('/api/admin/perf/summary')) {
        return jsonOk({ range: '1h', since: new Date().toISOString(), rows: [] });
      }
      if (u.includes('/api/admin/perf/process')) {
        return jsonOk({ range: '1h', since: new Date().toISOString(), samples: [], latest: null });
      }
      throw new Error(`unmocked fetch: ${u}`);
    });

    renderPage();

    expect(await screen.findByText(en.admin.system.metricsUnavailable)).toBeInTheDocument();
  });

  it('shows performanceUnavailable when the perf summary/process fetch fails', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url);
      const base = baselineRoute(u);
      if (base) return base;
      if (u.includes('/api/admin/metrics/summary')) {
        return jsonOk({ range: '1h', since: new Date().toISOString(), counts: {} });
      }
      if (u.includes('/api/admin/perf/summary')) return jsonFail();
      if (u.includes('/api/admin/perf/process')) return jsonFail();
      throw new Error(`unmocked fetch: ${u}`);
    });

    renderPage();

    expect(await screen.findByText(en.admin.system.performanceUnavailable)).toBeInTheDocument();
  });

  it('shows noPerformance — NOT performanceUnavailable — when perf summary genuinely has zero rows (fresh restart, not a failure)', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url);
      const base = baselineRoute(u);
      if (base) return base;
      if (u.includes('/api/admin/metrics/summary')) {
        return jsonOk({ range: '1h', since: new Date().toISOString(), counts: {} });
      }
      if (u.includes('/api/admin/perf/summary')) {
        return jsonOk({ range: '1h', since: new Date().toISOString(), rows: [] });
      }
      if (u.includes('/api/admin/perf/process')) {
        return jsonOk({ range: '1h', since: new Date().toISOString(), samples: [], latest: null });
      }
      throw new Error(`unmocked fetch: ${u}`);
    });

    renderPage();

    expect(await screen.findByText(en.admin.system.noPerformance)).toBeInTheDocument();
    expect(screen.queryByText(en.admin.system.performanceUnavailable)).toBeNull();
  });

  it('never renders a bare "0" fallback for the realtime card while its fetch is still failing', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url);
      const base = baselineRoute(u);
      if (base) return base;
      if (u.includes('/api/admin/metrics/summary')) return jsonFail();
      if (u.includes('/api/admin/perf/summary')) {
        return jsonOk({ range: '1h', since: new Date().toISOString(), rows: [] });
      }
      if (u.includes('/api/admin/perf/process')) {
        return jsonOk({ range: '1h', since: new Date().toISOString(), samples: [], latest: null });
      }
      throw new Error(`unmocked fetch: ${u}`);
    });

    renderPage();
    await screen.findByText(en.admin.system.metricsUnavailable);

    // The pre-Step-7 regression: on error, every summaryRows badge rendered
    // `counts[metric]?.total ?? 0`. Confirm none of those rows render at all
    // once the error branch is active.
    expect(screen.queryByText(en.admin.system.metrics.tokens)).toBeNull();
  });
});
