import { afterEach, describe, expect, it, vi } from 'vitest';

describe('map and geo settings persistence', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('sends settings patches as JSON so Express can parse the edited values', async () => {
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => new Response(
      JSON.stringify({
        settings: {
          tiles: { url_template: 'https://tiles.example/{z}/{x}/{y}.png' },
        },
      }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));
    vi.stubGlobal('fetch', fetchMock);

    const { mapGeoApi } = await import('@/lib/map-geo-api');
    await mapGeoApi.updateSettings({
      tiles: { url_template: 'https://tiles.example/{z}/{x}/{y}.png' },
    } as any);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [, init] = fetchMock.mock.calls[0];
    expect(init?.method).toBe('PUT');
    expect(init?.headers).toEqual({ 'Content-Type': 'application/json' });
    expect(JSON.parse(String(init?.body))).toEqual({
      tiles: { url_template: 'https://tiles.example/{z}/{x}/{y}.png' },
    });
  });
});