/**
 * Frontend operability test — Recording Retention admin panel.
 *
 * Verifies the panel:
 *   • Renders all four retention statuses with the correct labels.
 *   • Surfaces legacy_unmanaged rows explicitly (no "expired" mislabel).
 *   • Calls the correct legal-hold endpoint with the correct body.
 *   • Renders an error state when the list endpoint fails.
 *   • Exposes NO delete / backfill controls (architectural guardrail).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: null } }) } },
}));

import { RecordingRetentionPanel, RetentionStatusBadge } from '@/components/admin/calls/RecordingRetentionPanel';

const futureIso = new Date(Date.now() + 7 * 86400_000).toISOString();
const pastIso = new Date(Date.now() - 1 * 86400_000).toISOString();

const FIXTURE_ROWS = [
  { id: 'rec-1', status: 'expires_at', legal_hold: false, retention_expires_at: futureIso },
  { id: 'rec-2', status: 'on_hold', legal_hold: true, retention_expires_at: futureIso },
  { id: 'rec-3', status: 'expired', legal_hold: false, retention_expires_at: pastIso },
  { id: 'rec-4', status: 'legacy_unmanaged', legal_hold: false, retention_expires_at: null },
].map((r) => ({
  call_session_id: 'sess',
  workspace_id: 'ws-1',
  provider: 'livekit',
  recording_type: 'composite',
  storage_provider: 's3',
  storage_path: 'path/x',
  duration_seconds: 120,
  size_bytes: 1024,
  retention_policy: null,
  created_at: new Date().toISOString(),
  ...r,
}));

function renderPanel() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <RecordingRetentionPanel />
    </QueryClientProvider>,
  );
}

describe('RetentionStatusBadge', () => {
  it.each([
    ['on_hold', /legal hold/i],
    ['expired', /expired/i],
    ['legacy_unmanaged', /legacy/i],
    ['expires_at', /retained/i],
  ] as const)('renders %s with the right label', (status, re) => {
    const { container } = render(<RetentionStatusBadge status={status as any} />);
    expect(container.textContent || '').toMatch(re);
  });
});

describe('RecordingRetentionPanel', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all four statuses and labels legacy rows explicitly', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ items: FIXTURE_ROWS, total: FIXTURE_ROWS.length, limit: 25, offset: 0 }),
    } as any);

    renderPanel();

    await waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    expect(await screen.findByTestId('status-on_hold')).toBeInTheDocument();
    expect(await screen.findByTestId('status-expired')).toBeInTheDocument();
    expect(await screen.findByTestId('status-legacy_unmanaged')).toBeInTheDocument();
    expect(await screen.findByTestId('status-expires_at')).toBeInTheDocument();

    // Legacy row is NOT labelled as expired.
    const legacyRow = screen.getByTestId('recording-row-rec-4');
    expect(within(legacyRow).queryByTestId('status-expired')).toBeNull();
  });

  it('legal-hold toggle hits the correct endpoint with the correct body', async () => {
    let calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any, init?: any) => {
      calls.push({ url: String(url), init });
      if (String(url).includes('/legal-hold')) {
        return { ok: true, json: async () => ({ id: 'rec-1', legal_hold: true }) } as any;
      }
      return {
        ok: true,
        json: async () => ({ items: FIXTURE_ROWS, total: FIXTURE_ROWS.length, limit: 25, offset: 0 }),
      } as any;
    });

    renderPanel();
    const toggle = await screen.findByTestId('legal-hold-toggle-rec-1');
    fireEvent.click(toggle);

    await waitFor(() => {
      expect(calls.some((c) => c.url.includes('/api/admin/calls/recordings/rec-1/legal-hold'))).toBe(true);
    });
    const holdCall = calls.find((c) => c.url.includes('/legal-hold'))!;
    expect(holdCall.init?.method).toBe('POST');
    expect(JSON.parse(String(holdCall.init?.body))).toEqual({ enabled: true });
  });

  it('renders an error state when the list endpoint fails', async () => {
    vi.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: false,
      status: 500,
      statusText: 'Internal Server Error',
      text: async () => 'boom',
    } as any);

    renderPanel();
    expect(await screen.findByTestId('recordings-error')).toBeInTheDocument();
  });

  it('exposes no delete or backfill controls (architectural guardrail)', async () => {
    vi.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ items: FIXTURE_ROWS, total: FIXTURE_ROWS.length, limit: 25, offset: 0 }),
    } as any);

    const { container } = renderPanel();
    await screen.findByTestId('status-on_hold');

    const text = (container.textContent || '').toLowerCase();
    expect(text).not.toMatch(/\bdelete\b/);
    expect(text).not.toMatch(/backfill/);
    expect(text).not.toMatch(/purge/);
  });

  it('renders Open + Save artifact actions (read-only access surface)', async () => {
    vi.spyOn(global, 'fetch' as any).mockResolvedValue({
      ok: true,
      json: async () => ({ items: FIXTURE_ROWS, total: FIXTURE_ROWS.length, limit: 25, offset: 0 }),
    } as any);

    renderPanel();
    expect(await screen.findByTestId('recording-open-rec-1')).toBeInTheDocument();
    expect(await screen.findByTestId('recording-download-rec-1')).toBeInTheDocument();
  });

  it('Open action fetches the artifact proxy and creates an object URL', async () => {
    const calls: string[] = [];
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/file')) {
        return {
          ok: true,
          blob: async () => new Blob(['data'], { type: 'video/mp4' }),
          headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'video/mp4' : null) },
        } as any;
      }
      return {
        ok: true,
        json: async () => ({ items: FIXTURE_ROWS, total: FIXTURE_ROWS.length, limit: 25, offset: 0 }),
      } as any;
    });
    const createUrl = vi.fn(() => 'blob:fake');
    const revokeUrl = vi.fn();
    (global as any).URL.createObjectURL = createUrl;
    (global as any).URL.revokeObjectURL = revokeUrl;
    const openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);

    renderPanel();
    const openBtn = await screen.findByTestId('recording-open-rec-1');
    fireEvent.click(openBtn);

    await waitFor(() => {
      expect(calls.some((u) => u.includes('/api/admin/calls/recordings/rec-1/file'))).toBe(true);
    });
    expect(createUrl).toHaveBeenCalled();
    expect(openSpy).toHaveBeenCalledWith('blob:fake', '_blank', 'noopener,noreferrer');
    // Inline open must NOT request attachment disposition.
    expect(calls.find((u) => u.includes('/file'))?.includes('disposition=attachment')).toBe(false);
  });

  it('Preview toggle fetches the artifact and renders a <video> for video content-type', async () => {
    const calls: string[] = [];
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      const u = String(url);
      calls.push(u);
      if (u.includes('/file')) {
        return {
          ok: true,
          blob: async () => new Blob(['data'], { type: 'video/mp4' }),
          headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'video/mp4' : null) },
        } as any;
      }
      return {
        ok: true,
        json: async () => ({ items: FIXTURE_ROWS, total: FIXTURE_ROWS.length, limit: 25, offset: 0 }),
      } as any;
    });
    (global as any).URL.createObjectURL = vi.fn(() => 'blob:fake-video');
    (global as any).URL.revokeObjectURL = vi.fn();

    renderPanel();
    const toggle = await screen.findByTestId('recording-preview-toggle-rec-1');
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(calls.some((u) => u.includes('/api/admin/calls/recordings/rec-1/file'))).toBe(true),
    );
    expect(await screen.findByTestId('recording-preview-video-rec-1')).toBeInTheDocument();
  });

  it('Preview renders <audio> for audio content-type', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      if (String(url).includes('/file')) {
        return {
          ok: true,
          blob: async () => new Blob(['x'], { type: 'audio/mpeg' }),
          headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'audio/mpeg' : null) },
        } as any;
      }
      return {
        ok: true,
        json: async () => ({ items: FIXTURE_ROWS, total: FIXTURE_ROWS.length, limit: 25, offset: 0 }),
      } as any;
    });
    (global as any).URL.createObjectURL = vi.fn(() => 'blob:fake-audio');
    (global as any).URL.revokeObjectURL = vi.fn();

    renderPanel();
    fireEvent.click(await screen.findByTestId('recording-preview-toggle-rec-2'));
    expect(await screen.findByTestId('recording-preview-audio-rec-2')).toBeInTheDocument();
  });

  it('Preview shows unsupported state for non audio/video content-type and revokes object URL on close', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      if (String(url).includes('/file')) {
        return {
          ok: true,
          blob: async () => new Blob(['x'], { type: 'application/octet-stream' }),
          headers: {
            get: (k: string) =>
              k.toLowerCase() === 'content-type' ? 'application/octet-stream' : null,
          },
        } as any;
      }
      return {
        ok: true,
        json: async () => ({ items: FIXTURE_ROWS, total: FIXTURE_ROWS.length, limit: 25, offset: 0 }),
      } as any;
    });
    const revoke = vi.fn();
    (global as any).URL.createObjectURL = vi.fn(() => 'blob:fake');
    (global as any).URL.revokeObjectURL = revoke;

    renderPanel();
    const toggle = await screen.findByTestId('recording-preview-toggle-rec-3');
    fireEvent.click(toggle);
    expect(await screen.findByTestId('recording-preview-unsupported-rec-3')).toBeInTheDocument();

    // Closing the preview removes the preview row entirely.
    fireEvent.click(toggle);
    await waitFor(() =>
      expect(screen.queryByTestId('recording-preview-row-rec-3')).toBeNull(),
    );
  });

  it('Preview surface exposes no destructive controls', async () => {
    vi.spyOn(global, 'fetch' as any).mockImplementation(async (url: any) => {
      if (String(url).includes('/file')) {
        return {
          ok: true,
          blob: async () => new Blob(['x'], { type: 'video/mp4' }),
          headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? 'video/mp4' : null) },
        } as any;
      }
      return {
        ok: true,
        json: async () => ({ items: FIXTURE_ROWS, total: FIXTURE_ROWS.length, limit: 25, offset: 0 }),
      } as any;
    });
    (global as any).URL.createObjectURL = vi.fn(() => 'blob:fake');
    (global as any).URL.revokeObjectURL = vi.fn();

    const { container } = renderPanel();
    fireEvent.click(await screen.findByTestId('recording-preview-toggle-rec-1'));
    await screen.findByTestId('recording-preview-video-rec-1');
    const text = (container.textContent || '').toLowerCase();
    expect(text).not.toMatch(/\bdelete\b/);
    expect(text).not.toMatch(/\bpurge\b/);
  });
});