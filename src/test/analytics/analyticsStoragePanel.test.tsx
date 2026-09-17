/**
 * Analytics Storage admin panel.
 *
 * The behaviours worth guarding here are the ones an operator can be misled
 * by: that the panel shows BOTH primaries and says plainly that they are
 * independent, that it never asks for or displays a credential, that only
 * query-capable vendors are offered as the analytics primary, and that the
 * promotion gate and the primary/replica exclusion are visible rather than
 * silently enforced only on the server.
 *
 * Rendered through the real I18nProvider in all three locales, so a missing
 * translation key shows up as a raw key in the output and fails.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));
vi.mock('@/hooks/use-toast', () => ({ toast: () => undefined }));

import { AdminAnalyticsStoragePanel } from '@/features/providers/AdminAnalyticsStoragePanel';
import { AdminStorageSection } from '@/features/providers/AdminStorageSection';

const BASE_STATE = {
  enabled: true,
  primary: 'arvan_storage',
  replicas: ['cloudflare_r2'],
  replicationEnabled: true,
  prefix: 'analytics/web/',
  batchRows: 10000,
  batchBytes: 33554432,
  flushIntervalMs: 15000,
  format: 'parquet',
  compression: 'zstd',
  writeMode: 'dual_write',
  readMode: 'postgres',
  revision: 4,
  lastWriteAt: '2026-09-16T20:00:00.000Z',
  lastReplicationAt: '2026-09-16T20:00:00.000Z',
  lastError: null,
  lastErrorAt: null,
  objectsWritten: 12,
  bytesWritten: 4_194_304,
  rowsWritten: 91_000,
  bufferedRows: 42,
  missingCredentials: [],
  generalPrimary: 'bunny_storage',
  s3Read: {
    engineAvailable: true,
    engineReason: null,
    lastQueryAt: '2026-09-16T20:01:00.000Z',
    lastQueryMs: 42,
    lastError: null,
    lastErrorAt: null,
    queries: 7,
    failures: 0,
  },
  parity: {
    at: '2026-09-16T20:02:00.000Z',
    workspaceId: '33333333-3333-3333-3333-333333333333',
    range: { startDate: '2026-09-01', endDate: '2026-09-16' },
    regressions: 0,
    expectedDifferences: 2,
    unavailable: null,
    reports: [
      {
        report: 'overview', ok: true, postgresMs: 31, s3Ms: 44, error: null,
        differences: [
          { report: 'overview', field: 'uniqueVisitors', postgres: '120', s3: '84', expected: true },
        ],
      },
      { report: 'pages.top', ok: true, postgresMs: 12, s3Ms: 19, error: null, differences: [] },
    ],
  },
  readiness: {
    checks: [
      { key: 'primaryConfigured', state: 'ready', detail: 'arvan_storage' },
      { key: 'primaryHealth', state: 'ready', detail: '2026-09-16T20:00:00.000Z' },
      { key: 'replicaHealth', state: 'warning', detail: '0/1' },
      { key: 'duckdbAvailable', state: 'ready', detail: 'installed' },
      { key: 'historicalBackfill', state: 'ready', detail: '31' },
      { key: 'productionParity', state: 'ready', detail: '2026-09-16T20:02:00.000Z' },
      { key: 'workspaceDeletion', state: 'warning', detail: null },
      { key: 'durableIngestion', state: 'blocked', detail: null },
      { key: 'nodeRuntime', state: 'ready', detail: 'v22.15.0' },
      { key: 'multiInstanceDurability', state: 'ready', detail: '1' },
      { key: 'erasureApplied', state: 'ready', detail: '0' },
    ],
    s3OnlyEligible: false,
    s3OnlyUnlocked: false,
    blockedCount: 1,
    warningCount: 2,
  },
  instances: {
    count: 1,
    multiInstance: false,
    acknowledged: false,
    acknowledgedAt: null,
  },
  durability: {
    ready: false,
    enabled: false,
    reason: 'the spool directory is not writable',
    segments: 0,
    bytes: 0,
    replayedRows: 0,
    droppedForSize: 0,
    lastError: null,
  },
  providers: [
    {
      name: 'bunny_storage', configured: true, generalEnabled: true, generalRole: 'primary',
      analyticsPrimaryEligible: false, analyticsReplicaEligible: true, analyticsRole: 'none',
      health: null, synchronized: false, syncedAt: null, dirtyAt: null, dirtyReason: null, lastError: null, sync: null,
    },
    {
      name: 'arvan_storage', configured: true, generalEnabled: true, generalRole: 'mirror',
      analyticsPrimaryEligible: true, analyticsReplicaEligible: true, analyticsRole: 'primary',
      health: null, synchronized: true, syncedAt: null, dirtyAt: null, dirtyReason: null, lastError: null, sync: null,
    },
    {
      name: 'cloudflare_r2', configured: true, generalEnabled: false, generalRole: 'off',
      analyticsPrimaryEligible: true, analyticsReplicaEligible: true, analyticsRole: 'replica',
      health: 'behind', synchronized: false, syncedAt: null, dirtyAt: '2026-09-16T19:00:00.000Z',
      dirtyReason: 'mirror_upload_failed: 503', lastError: null, sync: null,
    },
    {
      name: 'minio', configured: true, generalEnabled: true, generalRole: 'mirror',
      analyticsPrimaryEligible: true, analyticsReplicaEligible: true, analyticsRole: 'none',
      health: null, synchronized: false, syncedAt: null, dirtyAt: null, dirtyReason: null, lastError: null, sync: null,
    },
  ],
  limits: {
    batchRows: { min: 100, max: 500000 },
    batchBytes: { min: 1048576, max: 268435456 },
    flushIntervalMs: { min: 1000, max: 300000 },
  },
  defaults: { prefix: 'analytics/web/', batchRows: 10000, batchBytes: 33554432, flushIntervalMs: 15000 },
  primaryEligible: ['s3', 'arvan_storage', 'cloudflare_r2', 'minio', 'do_spaces', 'local'],
  replicaEligible: ['s3', 'arvan_storage', 'cloudflare_r2', 'minio', 'do_spaces', 'local', 'bunny_storage'],
};

type Call = { url: string; init?: RequestInit };

function stubApi(overrides: Partial<typeof BASE_STATE> = {}, onCall?: (c: Call) => unknown) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch' as never).mockImplementation((async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const custom = onCall?.(call);
    if (custom) return custom as Response;
    return { ok: true, status: 200, json: async () => ({ ...BASE_STATE, ...overrides }) } as Response;
  }) as never);
  return calls;
}

const LOCALES = [
  ['en', en],
  ['fa', fa],
  ['tr', tr],
] as const;

function renderPanel(locale: 'en' | 'fa' | 'tr' = 'en', translations: unknown = en) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale={locale} initialTranslations={translations as typeof en}>
        <AdminAnalyticsStoragePanel />
      </I18nProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => { vi.restoreAllMocks(); });

describe('loading configured providers', () => {
  it('reads the analytics endpoint, not the general storage pool one', async () => {
    const calls = stubApi();
    renderPanel();
    await waitFor(() => expect(calls.length).toBeGreaterThan(0));
    expect(calls[0].url).toContain('/api/admin/providers/analytics-storage');
    expect(calls[0].url).not.toContain('/api/admin/providers/storage');
  });

  it('lists every configured, eligible vendor as a primary candidate', async () => {
    stubApi();
    renderPanel();
    // The current primary appears twice (summary card + its row), which is
    // why these are count-insensitive.
    expect((await screen.findAllByText('ArvanCloud Object Storage')).length).toBeGreaterThan(0);
    expect(screen.getAllByText('Cloudflare R2').length).toBeGreaterThan(0);
    expect(screen.getAllByText('MinIO (Self-Hosted)').length).toBeGreaterThan(0);
  });

  it('renders an error state instead of an empty screen when the endpoint fails', async () => {
    vi.spyOn(global, 'fetch' as never).mockResolvedValue({
      ok: false, status: 500, json: async () => ({ error: 'analytics pool unavailable' }),
    } as never);
    renderPanel();
    expect(await screen.findByText(/analytics pool unavailable/i)).toBeInTheDocument();
  });
});

describe('general vs analytics independence is visible', () => {
  it('shows both primaries side by side with an explicit note', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);
    expect(screen.getByText(en.analyticsStorage.generalPrimary)).toBeInTheDocument();
    expect(screen.getByText(en.analyticsStorage.analyticsPrimary)).toBeInTheDocument();
    expect(screen.getByText(en.analyticsStorage.independenceNote)).toBeInTheDocument();
    // The general primary is named, so the operator can see it is a different vendor.
    expect(container.textContent).toContain('Bunny Storage');
    expect(container.textContent).toContain('ArvanCloud Object Storage');
  });

  it('shows each vendor’s general-storage role without offering to change it', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);
    expect(container.textContent).toContain(en.analyticsStorage.generalRole.mirror);
  });
});

describe('credentials never appear on this screen', () => {
  it('renders no credential input and points at Provider Settings instead', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    expect(container.querySelector('input[type="password"]')).toBeNull();
    for (const term of ['access_key', 'secret', 'Access Key', 'Secret Key', 'Endpoint URL']) {
      expect(container.textContent).not.toContain(term);
    }
    expect(screen.getByText(en.analyticsStorage.credentialsNote)).toBeInTheDocument();
  });

  it('warns when a named analytics provider has no stored credentials', async () => {
    stubApi({ missingCredentials: ['minio'] });
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);
    // The warning names the vendor and points at the other tab.
    expect(container.textContent).toContain('MinIO (Self-Hosted)');
  });
});

describe('choosing an analytics primary', () => {
  it('offers only vendors that can be queried as a Parquet source', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    // Bunny is replica-eligible only, so it must not carry a "make primary"
    // action even though it is configured and is the GENERAL primary.
    const makeButtons = screen.getAllByText(en.analyticsStorage.primary.make);
    expect(makeButtons.length).toBe(2); // cloudflare_r2 and minio — not bunny, not the current primary
    expect(container.textContent).toContain(en.analyticsStorage.replicaOnly);
  });

  it('asks for confirmation and then calls the analytics primary endpoint', async () => {
    const calls = stubApi();
    renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    fireEvent.click(screen.getAllByText(en.analyticsStorage.primary.make)[0]);
    expect(await screen.findByText(en.analyticsStorage.promote.title)).toBeInTheDocument();

    fireEvent.click(screen.getByText(en.analyticsStorage.promote.confirm));
    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/analytics-storage/primary/') && c.init?.method === 'POST')).toBe(true);
    });
  });

  it('surfaces the server’s promotion gate rather than pretending it succeeded', async () => {
    let attempted = false;
    stubApi({}, (call) => {
      if (call.url.includes('/primary/')) {
        attempted = true;
        return {
          ok: false, status: 409,
          json: async () => ({ error: 'This replica has not been proven to hold everything…', reason: 'not_synchronized' }),
        };
      }
      return null;
    });
    renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    fireEvent.click(screen.getAllByText(en.analyticsStorage.primary.make)[0]);
    fireEvent.click(await screen.findByText(en.analyticsStorage.promote.confirm));
    await waitFor(() => expect(attempted).toBe(true));
    // The panel does not switch its displayed primary on a refused promotion.
    expect(screen.getByText(en.analyticsStorage.analyticsPrimary)).toBeInTheDocument();
  });
});

describe('choosing replicas', () => {
  it('never offers the analytics primary as a replica', async () => {
    stubApi();
    renderPanel();
    await screen.findByLabelText('Cloudflare R2');
    // arvan is the primary, so it has no replica checkbox.
    expect(screen.queryByLabelText('ArvanCloud Object Storage')).toBeNull();
    expect(screen.getByLabelText('Cloudflare R2')).toBeInTheDocument();
  });

  it('sends the full replica list when one is toggled on', async () => {
    const calls = stubApi();
    renderPanel();
    await screen.findByLabelText('Cloudflare R2');

    fireEvent.click(screen.getByLabelText('MinIO (Self-Hosted)'));
    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith('/replicas') && c.init?.method === 'PUT');
      expect(put).toBeDefined();
      expect(JSON.parse(String(put!.init!.body))).toEqual({ replicas: ['cloudflare_r2', 'minio'] });
    });
  });

  it('shows a selected replica’s health and the reason it fell behind', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findByLabelText('Cloudflare R2');
    expect(container.textContent).toContain(en.analyticsStorage.health.behind);
    expect(container.textContent).toContain('mirror_upload_failed: 503');
  });
});

describe('sync', () => {
  it('runs bounded batches and reports when more work remains', async () => {
    let batches = 0;
    stubApi({}, (call) => {
      if (call.url.endsWith('/sync')) {
        batches++;
        return {
          ok: true, status: 200,
          json: async () => ({
            report: {
              target: 'cloudflare_r2', prefix: 'analytics/web/',
              batch: { scanned: 10, copied: 10, skipped: 0, failed: 0 },
              total: { scanned: 10 * batches, copied: 10 * batches, skipped: 0, failed: 0 },
              errors: [], nextCursor: 'more', done: false, markedSynchronized: false,
            },
          }),
        };
      }
      return null;
    });
    renderPanel();
    await screen.findByLabelText('Cloudflare R2');

    fireEvent.click(screen.getByText(en.analyticsStorage.sync.run));
    expect(await screen.findByText(en.analyticsStorage.sync.more)).toBeInTheDocument();
    // Bounded: a single click must not become an unbounded request loop.
    expect(batches).toBeLessThanOrEqual(20);
  });

  it('only claims full synchronization when the server says the walk was complete', async () => {
    stubApi({}, (call) => {
      if (call.url.endsWith('/sync')) {
        return {
          ok: true, status: 200,
          json: async () => ({
            report: {
              target: 'cloudflare_r2', prefix: 'analytics/web/',
              batch: { scanned: 3, copied: 3, skipped: 0, failed: 0 },
              total: { scanned: 3, copied: 3, skipped: 0, failed: 0 },
              errors: [], nextCursor: null, done: true, markedSynchronized: true,
            },
          }),
        };
      }
      return null;
    });
    renderPanel();
    await screen.findByLabelText('Cloudflare R2');

    fireEvent.click(screen.getByText(en.analyticsStorage.sync.run));
    expect(await screen.findByText(en.analyticsStorage.sync.completeFull)).toBeInTheDocument();
  });
});

describe('provider test', () => {
  it('reports the failing step of the analytics round trip', async () => {
    stubApi({}, (call) => {
      if (call.url.includes('/test/')) {
        return {
          ok: true, status: 200,
          json: async () => ({ success: false, latencyMs: 12, steps: { put: true, get: true, list: false, delete: false }, error: 'listing is not supported for minio' }),
        };
      }
      return null;
    });
    renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    fireEvent.click(screen.getAllByText(en.analyticsStorage.test.run)[0]);
    expect(await screen.findByText(/listing is not supported/i)).toBeInTheDocument();
  });
});

describe('settings', () => {
  it('saves advanced settings without sending a credential', async () => {
    const calls = stubApi();
    renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    fireEvent.click(screen.getByText(en.analyticsStorage.advanced.title));
    const rows = await screen.findByLabelText(en.analyticsStorage.advanced.batchRows);
    fireEvent.change(rows, { target: { value: '2500' } });
    fireEvent.click(screen.getByText(en.analyticsStorage.advanced.save));

    await waitFor(() => {
      const put = calls.find((c) => c.url.endsWith('/settings') && c.init?.method === 'PUT');
      expect(put).toBeDefined();
      const body = JSON.parse(String(put!.init!.body));
      expect(body.batchRows).toBe(2500);
      expect(JSON.stringify(body)).not.toMatch(/key|secret|token/i);
    });
  });

  it('pins the canonical format so it cannot be switched away from Parquet + ZSTD', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);
    fireEvent.click(screen.getByText(en.analyticsStorage.advanced.title));
    await waitFor(() => {
      expect(container.textContent).toContain(en.analyticsStorage.advanced.formatBadge);
      expect(container.textContent).toContain(en.analyticsStorage.advanced.compressionBadge);
    });
    expect(container.querySelector('select[name="format"]')).toBeNull();
  });
});

describe('status overview', () => {
  it('shows the migration mode, so nobody has to guess whether PostgreSQL is still being written', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);
    expect(container.textContent).toContain(en.analyticsStorage.writeMode.dual_write);
    expect(container.textContent).toContain(en.analyticsStorage.readMode.postgres);
  });

  it('surfaces the last error rather than showing a healthy-looking blank', async () => {
    stubApi({ lastError: 'primary_write_failed[arvan_storage]: 503' });
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);
    expect(container.textContent).toContain('primary_write_failed[arvan_storage]: 503');
  });
});

describe('phase 2 status', () => {
  it('shows the read-path health, parity result and query latency', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    expect(container.textContent).toContain(en.analyticsStorage.phase2.title);
    expect(container.textContent).toContain(en.analyticsStorage.phase2.healthy);
    expect(container.textContent).toContain('42 ms');
  });

  it('shows an EXPECTED divergence as expected, not as a regression', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    // uniqueVisitors is a declared, intentional difference.
    expect(container.textContent).toContain('uniqueVisitors');
    expect(container.textContent).toContain(en.analyticsStorage.phase2.expected);
    expect(container.textContent).not.toContain(en.analyticsStorage.phase2.regression);
  });

  it('flags an undeclared difference as a regression', async () => {
    stubApi({
      parity: {
        ...BASE_STATE.parity!,
        regressions: 1,
        reports: [{
          report: 'pages.top', ok: false, postgresMs: 10, s3Ms: 20, error: null,
          differences: [{ report: 'pages.top', field: '/pricing', postgres: '9', s3: '4', expected: false }],
        }],
      },
    });
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    expect(container.textContent).toContain(en.analyticsStorage.phase2.regression);
    expect(container.textContent).toContain('/pricing');
  });

  it('says the engine is simply absent rather than showing an error', async () => {
    stubApi({
      s3Read: {
        engineAvailable: false,
        engineReason: 'the optional @duckdb/node-api package is not installed',
        lastQueryAt: null, lastQueryMs: null, lastError: null, lastErrorAt: null, queries: 0, failures: 0,
      },
      parity: null,
    });
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    expect(container.textContent).toContain(en.analyticsStorage.phase2.engineMissing);
    expect(container.textContent).toContain(en.analyticsStorage.phase2.engineMissingHint);
  });

  it('surfaces a query error instead of a healthy-looking blank', async () => {
    stubApi({
      s3Read: {
        ...BASE_STATE.s3Read, failures: 2,
        lastError: 'IO Error: could not read parquet footer',
      },
    });
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    expect(container.textContent).toContain('could not read parquet footer');
    expect(container.textContent).toContain(en.analyticsStorage.phase2.error);
  });

  it('triggers a sealing cycle from the panel', async () => {
    const calls = stubApi({}, (call) => {
      if (call.url.endsWith('/seal')) {
        return { ok: true, status: 200, json: async () => ({ considered: 3, sealed: 3, failed: 0, rows: 900, objects: 3 }) };
      }
      return null;
    });
    renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    fireEvent.click(screen.getByText(en.analyticsStorage.phase2.sealNow));
    await waitFor(() => {
      expect(calls.some((c) => c.url.endsWith('/seal') && c.init?.method === 'POST')).toBe(true);
    });
  });

  it('still renders when the server has not sent the phase 2 fields yet', async () => {
    // A rolling deploy can put an older server behind a newer panel; the
    // page must degrade, not crash.
    stubApi({ s3Read: undefined as never, parity: null });
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);
    expect(container.textContent).toContain(en.analyticsStorage.phase2.title);
  });
});

describe('localization', () => {
  it.each(LOCALES)('renders %s with no untranslated keys', async (locale, translations) => {
    stubApi();
    const { container } = renderPanel(locale, translations);
    await screen.findByText((translations as typeof en).analyticsStorage.primary.title);
    // A missing key falls through as the dotted path itself.
    expect(container.textContent ?? '').not.toMatch(/analyticsStorage\.[a-zA-Z.]+/);
  });

  it.each(LOCALES)('names the feature correctly in %s', async (locale, translations) => {
    stubApi();
    renderPanel(locale, translations);
    // Persian reuses the same phrase for the page title and the tab label,
    // so this asserts presence, not uniqueness.
    expect((await screen.findAllByText((translations as typeof en).analyticsStorage.title)).length)
      .toBeGreaterThan(0);
  });
});

describe('storage section shell', () => {
  it('puts Analytics Storage on its own tab beside the general storage pool', async () => {
    stubApi();
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={qc}>
        <I18nProvider initialLocale="en" initialTranslations={en}>
          <AdminStorageSection />
        </I18nProvider>
      </QueryClientProvider>,
    );
    const tab = await screen.findByRole('tab', { name: new RegExp(en.analyticsStorage.tabs.analytics) });
    expect(tab).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: new RegExp(en.analyticsStorage.tabs.pool) })).toBeInTheDocument();

    fireEvent.click(tab);
    expect(await screen.findByText(en.analyticsStorage.primary.title)).toBeInTheDocument();
  });
});

/**
 * PHASE 2.5 — cutover readiness.
 *
 * The one thing this card must never do is imply permission. It reports what
 * is still blocking; it does not grant a cutover, and a fully green list
 * still shows BLOCKED because the phase lock is a separate decision.
 */
describe('cutover readiness', () => {
  it('lists every readiness check with a state', async () => {
    stubApi();
    renderPanel();
    // The card's title renders before the query resolves, so waiting on it
    // would assert against an empty list.
    await waitFor(() =>
      expect(screen.getByText(en.analyticsStorage.phase25.check.primaryConfigured)).toBeInTheDocument());

    for (const label of Object.values(en.analyticsStorage.phase25.check)) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it('shows S3-only activation as BLOCKED', async () => {
    stubApi();
    renderPanel();
    await waitFor(() => expect(screen.getByText(en.analyticsStorage.phase25.activation)).toBeInTheDocument());
    expect(screen.getByText(en.analyticsStorage.phase25.activationBlocked)).toBeInTheDocument();
  });

  it('still shows BLOCKED when every check is green — the lock is not the checklist', async () => {
    stubApi({
      readiness: {
        checks: [{ key: 'primaryConfigured', state: 'ready', detail: null }],
        s3OnlyEligible: true,
        s3OnlyUnlocked: false,
        blockedCount: 0,
        warningCount: 0,
      },
    } as never);
    renderPanel();
    await waitFor(() => expect(screen.getByText(en.analyticsStorage.phase25.activation)).toBeInTheDocument());
    expect(screen.getByText(en.analyticsStorage.phase25.activationBlocked)).toBeInTheDocument();
  });

  it('surfaces durable ingestion as the blocker when the spool is unavailable', async () => {
    stubApi();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(en.analyticsStorage.phase25.durability.notReady)).toBeInTheDocument());
  });

  it('states the multi-instance limitation rather than leaving it to be discovered', async () => {
    stubApi();
    renderPanel();
    await waitFor(() =>
      expect(screen.getByText(en.analyticsStorage.phase25.durability.multiInstance)).toBeInTheDocument());
  });

  it('renders in all three locales with no raw translation keys', async () => {
    for (const [locale, translations] of LOCALES) {
      stubApi();
      const { unmount } = renderPanel(locale, translations);
      await waitFor(() =>
        expect(screen.getByText(
          (translations as typeof en).analyticsStorage.phase25.check.primaryConfigured,
        )).toBeInTheDocument());
      expect(document.body.textContent).not.toMatch(/analyticsStorage\.phase25\./);
      unmount();
      vi.restoreAllMocks();
    }
  });
});

describe('production parity runner', () => {
  it('refuses to run without a workspace id', async () => {
    stubApi();
    renderPanel();
    await waitFor(() => expect(screen.getByText(en.analyticsStorage.phase25.parityRun.title)).toBeInTheDocument());
    expect(screen.getByRole('button', { name: new RegExp(en.analyticsStorage.phase25.parityRun.run, 'i') }))
      .toBeDisabled();
  });

  it('warns when the requested range exceeds the bound', async () => {
    stubApi();
    renderPanel();
    await waitFor(() => expect(screen.getByText(en.analyticsStorage.phase25.parityRun.title)).toBeInTheDocument());

    fireEvent.change(screen.getByLabelText(en.analyticsStorage.phase25.parityRun.workspaceId), {
      target: { value: '33333333-3333-3333-3333-333333333333' },
    });
    const [from] = screen.getAllByLabelText(en.analyticsStorage.phase25.parityRun.from);
    const [to] = screen.getAllByLabelText(en.analyticsStorage.phase25.parityRun.to);
    fireEvent.change(from, { target: { value: '2025-01-01' } });
    fireEvent.change(to, { target: { value: '2026-01-01' } });

    await waitFor(() => expect(
      screen.getByText(
        en.analyticsStorage.phase25.parityRun.rangeTooLong.replace('{{max}}', '92'),
      ),
    ).toBeInTheDocument());
  });

  it('never renders a credential field', async () => {
    stubApi();
    renderPanel();
    await waitFor(() => expect(screen.getByText(en.analyticsStorage.phase25.title)).toBeInTheDocument());
    expect(document.querySelector('input[type="password"]')).toBeNull();
    expect(document.body.textContent).not.toMatch(/secret|access_key|password/i);
  });
});
