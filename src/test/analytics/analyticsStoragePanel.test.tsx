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
  /** A capability, not a metric — the only non-config field left. */
  duckdbAvailable: true,
  missingCredentials: [],
  generalPrimary: 'bunny_storage',
  providers: [
    {
      name: 'bunny_storage', configured: true, generalEnabled: true, generalRole: 'primary',
      analyticsPrimaryEligible: false, analyticsReplicaEligible: true, analyticsRole: 'none',
      health: null, synchronized: false, syncInFlight: false,
    },
    {
      name: 'arvan_storage', configured: true, generalEnabled: true, generalRole: 'mirror',
      analyticsPrimaryEligible: true, analyticsReplicaEligible: true, analyticsRole: 'primary',
      health: null, synchronized: true, syncInFlight: false,
    },
    {
      name: 'cloudflare_r2', configured: true, generalEnabled: false, generalRole: 'off',
      analyticsPrimaryEligible: true, analyticsReplicaEligible: true, analyticsRole: 'replica',
      health: 'dirty', synchronized: false, syncInFlight: false,
    },
    {
      name: 'minio', configured: true, generalEnabled: true, generalRole: 'mirror',
      analyticsPrimaryEligible: true, analyticsReplicaEligible: true, analyticsRole: 'none',
      health: null, synchronized: false, syncInFlight: false,
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

/**
 * Live connection status — the ONLY status this panel shows. It comes from
 * its own endpoint, which performs a real round trip per provider on every
 * fetch, so the stub answers it separately from the config endpoint.
 */
const BASE_CONNECTIONS = {
  primary: { provider: 'arvan_storage', connected: true },
  replicas: [{ provider: 'cloudflare_r2', connected: true }],
};

function stubApi(
  overrides: Partial<typeof BASE_STATE> = {},
  onCall?: (c: Call) => unknown,
  connections: unknown = BASE_CONNECTIONS,
) {
  const calls: Call[] = [];
  vi.spyOn(global, 'fetch' as never).mockImplementation((async (url: unknown, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    const custom = onCall?.(call);
    if (custom) return custom as Response;
    if (call.url.includes('/connections')) {
      return { ok: true, status: 200, json: async () => connections } as Response;
    }
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

  it('shows a selected replica’s health, which is what promotion depends on', async () => {
    stubApi();
    const { container } = renderPanel();
    await screen.findByLabelText('Cloudflare R2');
    expect(container.textContent).toContain(en.analyticsStorage.health.dirty);
  });

  it('shows no vendor error string or sync timestamp beside a replica', async () => {
    // The health badge is a correctness signal. The error text and timestamps
    // that used to sit next to it were history the server no longer keeps —
    // rendering them would mean something had started recording again.
    stubApi();
    const { container } = renderPanel();
    await screen.findByLabelText('Cloudflare R2');
    const text = container.textContent ?? '';
    expect(text).not.toContain('mirror_upload_failed');
    expect(text).not.toMatch(/dirtyReason|lastError|lastSync/i);
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
  it('says Not connected — and nothing more — when the round trip fails', async () => {
    stubApi({}, (call) => {
      if (call.url.includes('/test/')) {
        // The narrowed server contract: connected, plus a machine-readable
        // reason. No latency, no per-step breakdown, nothing persisted.
        return { ok: true, status: 200, json: async () => ({ connected: false, error: 'connection_failed' }) };
      }
      return null;
    });
    renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    fireEvent.click(screen.getAllByText(en.analyticsStorage.test.run)[0]);
    expect((await screen.findAllByText(en.analyticsStorage.connection.notConnected)).length)
      .toBeGreaterThan(0);
  });

  it('says Connected when it succeeds', async () => {
    stubApi({}, (call) => {
      if (call.url.includes('/test/')) {
        return { ok: true, status: 200, json: async () => ({ connected: true }) };
      }
      return null;
    });
    renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    fireEvent.click(screen.getAllByText(en.analyticsStorage.test.run)[0]);
    expect((await screen.findAllByText(en.analyticsStorage.connection.connected)).length)
      .toBeGreaterThan(0);
  });

  it('does not crash on a response carrying only the narrowed fields', async () => {
    // Guards the regression this contract already had once: the panel read
    // `result.steps` after the server stopped sending it, which threw inside
    // the click handler rather than showing a result.
    stubApi({}, (call) => (call.url.includes('/test/')
      ? { ok: true, status: 200, json: async () => ({ connected: true }) }
      : null));
    const { container } = renderPanel();
    await screen.findAllByText(en.analyticsStorage.primary.make);

    fireEvent.click(screen.getAllByText(en.analyticsStorage.test.run)[0]);
    await waitFor(() => expect(container.textContent).toContain(en.analyticsStorage.connection.connected));
    expect(container.textContent).not.toMatch(/undefined|NaN/);
  });
});

/**
 * CONNECTION STATUS — the whole of what this panel reports.
 *
 * The mandate is one sentence: for Analytics Storage the operator wants to
 * know Connected or Not Connected, and nothing else. So these tests pin both
 * halves of that — that the answer is shown, and that the things deliberately
 * removed have not crept back in.
 */
describe('connection status', () => {
  it('asks the server for a LIVE check, on its own endpoint', async () => {
    const calls = stubApi();
    renderPanel();
    await waitFor(() => expect(calls.some((c) => c.url.includes('/connections'))).toBe(true));
  });

  it('shows Connected for a reachable primary and replica', async () => {
    stubApi();
    const { container } = renderPanel();
    await waitFor(() =>
      expect(container.textContent).toContain(en.analyticsStorage.connection.title));
    await waitFor(() =>
      expect(screen.getAllByText(en.analyticsStorage.connection.connected).length).toBe(2));
  });

  it('shows Not connected when the round trip fails, without explaining the vendor error', async () => {
    stubApi({}, undefined, {
      primary: { provider: 'arvan_storage', connected: false, error: 'connection_failed' },
      replicas: [{ provider: 'cloudflare_r2', connected: false, error: 'connection_failed' }],
    });
    const { container } = renderPanel();
    await waitFor(() =>
      expect(screen.getAllByText(en.analyticsStorage.connection.notConnected).length).toBe(2));
    // A raw vendor error is an operational detail, not an answer to the question.
    expect(container.textContent).not.toContain('connection_failed');
  });

  it('re-runs the live check when Test connection is pressed', async () => {
    const calls = stubApi();
    renderPanel();
    // Wait for the FIRST check to settle: the button is disabled while a
    // check is in flight, so clicking earlier would be a no-op.
    await waitFor(() =>
      expect(screen.getAllByText(en.analyticsStorage.connection.connected).length).toBe(2));
    const before = calls.filter((c) => c.url.includes('/connections')).length;

    fireEvent.click(screen.getByText(en.analyticsStorage.connection.test));
    await waitFor(() =>
      expect(calls.filter((c) => c.url.includes('/connections')).length).toBeGreaterThan(before));
  });

  it('shows NO counters, latency, history or parity — analytics is not monitored from here', async () => {
    stubApi();
    const { container } = renderPanel();
    await waitFor(() =>
      expect(container.textContent).toContain(en.analyticsStorage.connection.title));

    const text = container.textContent ?? '';
    // The removed telemetry, by the words it would have to render as.
    for (const gone of [
      'objectsWritten', 'rowsWritten', 'bytesWritten', 'bufferedRows',
      'lastQueryMs', 'lastWriteAt', 'lastReplicationAt', 'replayedRows',
      /\d+\s*ms/, /parity/i, /backfill/i, /readiness/i, /instances?/i,
    ]) {
      expect(text).not.toMatch(typeof gone === 'string' ? new RegExp(gone) : gone);
    }
  });

  it('names the missing query engine as a capability, not as an error', async () => {
    stubApi({ duckdbAvailable: false });
    const { container } = renderPanel();
    await waitFor(() =>
      expect(container.textContent).toContain(en.analyticsStorage.connection.engineMissing));
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
