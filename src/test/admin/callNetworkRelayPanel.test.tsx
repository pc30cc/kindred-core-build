/**
 * Super Admin → Voice & Video → Channels → RTC and TURN endpoints
 * (src/components/admin/calls/CallControlPlanePanel.tsx), in the browser:
 *
 *   - the TURN shared secret is write-only: never in the page, shown as set
 *     with its fingerprint (or as unreadable when the server cannot decrypt
 *     it), sent only when typed, removed with Remove (sends '');
 *   - the relay countries and the credential lifetime are sent as the server
 *     keeps them (codes upper case, the Persian comma a separator, hours as
 *     seconds, Persian digits read), and refused before sending when wrong;
 *   - the TURN URLs keep their raw text while typing and are parsed on Save;
 *   - a save sends only what changed, so it never blanks the signalling URL:
 *     an emptied WebSocket URL blocks the save with a warning and a way back;
 *   - a refusal shows the server's own text, not "Failed: 400";
 *   - the Voice & Video page's overview says who gets the relay, and its
 *     "Open RTC, TURN and network settings" button opens the Channels tab
 *     (it used to do nothing).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import type { CallNetworkBundle } from '@/lib/admin-calls-api';

const toastMock = vi.fn();
vi.mock('@/lib/apiBase', () => ({ API_BASE: '' }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn(), useToast: () => ({ toast: toastMock }) }));
// Their own fetches are not what this file is about.
vi.mock('@/components/admin/calls/AgoraExternalProviderPanel', () => ({ AgoraExternalProviderPanel: () => null }));
vi.mock('@/components/admin/calls/RolePermissionsPanel', () => ({ RolePermissionsPanel: () => null }));
vi.mock('@/components/admin/calls/LiveKitSelfHostedProviderPanel', () => ({ LiveKitSelfHostedProviderPanel: () => null }));
vi.mock('@/components/admin/calls/RecordingRetentionPanel', () => ({ RecordingRetentionPanel: () => null }));
vi.mock('@/hooks/useAdmin', () => ({ useAdminWorkspaces: () => ({ data: [], isLoading: false }) }));

import { CallControlPlanePanel } from '@/components/admin/calls/CallControlPlanePanel';
import VoiceVideoPage from '@/pages/admin/VoiceVideoPage';

const c = en.admin.voiceVideo.control;
const fill = (text: string, params: Record<string, string>) =>
  Object.entries(params).reduce((s, [k, v]) => s.split(`{{${k}}}`).join(v), text);

const CONTROL_PLANE = {
  enabled: true,
  primary_provider: 'livekit',
  secondary_provider: 'disabled',
  fallback_policy: 'lenient',
  max_participants: 10,
  default_audio_bitrate_kbps: 32,
  default_video_bitrate_kbps: 800,
  default_video_profile: 'h720',
  recording_default_enabled: false,
  recording_default_type: 'composite',
  retention_default_days: 30,
  verification_required_for_visitor_calls: false,
  voice_calls_enabled_global: true,
  video_calls_enabled_global: true,
  call_recording_enabled_global: false,
  call_queue_enabled_global: true,
  visitor_initiated_audio_enabled_global: true,
  visitor_initiated_video_enabled_global: true,
};

function network(turn: Partial<CallNetworkBundle['turn']> = {}, top: Partial<CallNetworkBundle> = {}): CallNetworkBundle {
  return {
    rtc_url: 'wss://sfu.example.test',
    ws_url: 'wss://signal.example.test',
    recording_url: null,
    ice_policy: 'all',
    region: null,
    provider: null,
    turn: {
      urls: ['turn:203.0.113.7:3478?transport=udp'],
      username: null,
      credential: null,
      credential_type: 'password',
      static_secret_present: true,
      countries: ['IR'],
      credential_ttl_seconds: 21600,
      shared_secret_present: true,
      shared_secret_fingerprint: 'a1b2c3d4e5f6',
      ...turn,
    },
    ...top,
  };
}

type Reply = { status: number; body: unknown };
let replies: Array<(url: string, init?: RequestInit) => Reply | null>;
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  for (const [i, reply] of replies.entries()) {
    const r = reply(url, init);
    if (r) {
      replies.splice(i, 1);
      return { ok: r.status < 400, status: r.status, json: async () => r.body };
    }
  }
  return { ok: false, status: 500, json: async () => ({ error: 'no_reply' }) };
});
const on = (method: string, path: string, body: unknown, status = 200) =>
  (url: string, init?: RequestInit) => ((init?.method ?? 'GET') === method && url === path ? { status, body } : null);
const controlPlane = (net: CallNetworkBundle) =>
  on('GET', '/api/admin/calls/control-plane', { control_plane: CONTROL_PLANE, network: net, readiness: { livekit: true } });
const puts = () => fetchMock.mock.calls
  .filter(([, init]) => init?.method === 'PUT')
  .map(([url, init]) => ({ url, body: JSON.parse(String(init?.body)) }));

async function renderPanel(net: CallNetworkBundle = network()) {
  replies.push(controlPlane(net));
  render(
    <I18nProvider initialLocale="en" initialTranslations={en}>
      <CallControlPlanePanel />
    </I18nProvider>,
  );
  await screen.findByLabelText(c.turnSecret);
}

const field = (label: string) => screen.getByLabelText(label) as HTMLInputElement;
const saveButton = () => screen.getByRole('button', { name: c.saveEndpoints }) as HTMLButtonElement;

async function save(after: CallNetworkBundle = network()) {
  replies.push(on('PUT', '/api/admin/calls/rtc-endpoints', { ok: true }));
  replies.push(controlPlane(after));
  const before = puts().length;
  fireEvent.click(saveButton());
  await waitFor(() => expect(puts()).toHaveLength(before + 1));
  return puts()[before].body;
}

beforeEach(() => {
  replies = [];
  fetchMock.mockClear();
  toastMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('the TURN shared secret', () => {
  it('is never in the page: an empty password field, shown as set with its fingerprint', async () => {
    await renderPanel();
    const secret = field(c.turnSecret);
    expect(secret.type).toBe('password');
    expect(secret.value).toBe('');
    expect(screen.getByTestId('turn-secret-state').textContent).toBe(fill(c.turnSecretSet, { fingerprint: 'a1b2c3d4e5f6' }));
    expect(secret.placeholder).toBe(c.turnSecretPlaceholderReplace);
    expect(screen.getByTestId('relay-state').textContent).toBe(fill(c.relayStateCountries, { countries: 'IR' }));
  });

  it('a save that types nothing sends nothing: the secret, the URLs and ws_url are left to the stored row', async () => {
    await renderPanel();
    expect(await save()).toEqual({});
  });

  it('a typed secret is sent trimmed (a pasted newline would break every credential)', async () => {
    await renderPanel();
    fireEvent.change(field(c.turnSecret), { target: { value: '  s3cret-from-the-relay\n' } });
    expect(await save()).toEqual({ turn: { shared_secret: 's3cret-from-the-relay' } });
    // Reloaded after the save: the field is empty again.
    await waitFor(() => expect(field(c.turnSecret).value).toBe(''));
  });

  it('Remove sends an empty secret; Keep it takes that back', async () => {
    await renderPanel();
    fireEvent.click(screen.getByRole('button', { name: c.turnSecretClear }));
    expect(screen.getByText(c.turnSecretClearPending)).toBeTruthy();
    expect(field(c.turnSecret).disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: c.turnSecretKeep }));
    expect(screen.queryByText(c.turnSecretClearPending)).toBeNull();
    expect(screen.getByRole('button', { name: c.turnSecretClear })).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: c.turnSecretClear }));
    expect(await save(network({ static_secret_present: false, shared_secret_present: false, shared_secret_fingerprint: null })))
      .toEqual({ turn: { shared_secret: '' } });
  });

  it('shows "not set" with no Remove when none is stored, and "unreadable" when the server cannot decrypt it', async () => {
    await renderPanel(network({ static_secret_present: false, shared_secret_present: false, shared_secret_fingerprint: null, urls: [] }));
    expect(screen.getByTestId('turn-secret-state').textContent).toBe(c.turnSecretNotSet);
    expect(screen.queryByRole('button', { name: c.turnSecretClear })).toBeNull();
    expect(field(c.turnSecret).placeholder).toBe(c.turnSecretPlaceholderNew);
    expect(screen.getByTestId('relay-state').textContent).toBe(c.relayStateOff);
    cleanup();

    await renderPanel(network({ shared_secret_fingerprint: null }));
    expect(screen.getByTestId('turn-secret-state').textContent).toBe(c.turnSecretUnreadable);
    expect(screen.getByText(c.turnSecretUnreadableHint)).toBeTruthy();
  });
});

describe('who gets the relay, and for how long', () => {
  it('sends the countries upper case, each once, split on the Persian comma too, and hours as seconds', async () => {
    await renderPanel();
    fireEvent.change(field(c.turnCountries), { target: { value: 'ir، tr ir,de' } });
    fireEvent.change(field(c.turnTtl), { target: { value: '۳' } });
    expect(await save()).toEqual({ turn: { countries: ['IR', 'TR', 'DE'], credential_ttl_seconds: 10800 } });
  });

  it('an empty list is everyone: sent as [] when it held codes', async () => {
    await renderPanel();
    fireEvent.change(field(c.turnCountries), { target: { value: '' } });
    expect(await save(network({ countries: [] }))).toEqual({ turn: { countries: [] } });
    await waitFor(() => expect(screen.getByTestId('relay-state').textContent).toBe(c.relayStateEveryone));
  });

  it('refuses a code that is not one, and a lifetime outside 10 minutes..24 hours, before sending', async () => {
    await renderPanel();
    fireEvent.change(field(c.turnCountries), { target: { value: 'IR, IRN' } });
    fireEvent.click(saveButton());
    expect(screen.getByTestId('network-problem').textContent).toBe(fill(c.turnCountriesInvalid, { codes: 'IRN' }));

    fireEvent.change(field(c.turnCountries), { target: { value: 'IR' } });
    fireEvent.change(field(c.turnTtl), { target: { value: '25' } });
    fireEvent.click(saveButton());
    expect(screen.getByTestId('network-problem').textContent).toBe(c.turnTtlInvalid);
    expect(puts()).toHaveLength(0);
  });

  it('a stored lifetime the field shows rounded is not rewritten by a save that never touched it', async () => {
    await renderPanel(network({ credential_ttl_seconds: 1000 }));
    expect(field(c.turnTtl).value).toBe('0.28');
    expect(await save(network({ credential_ttl_seconds: 1000 }))).toEqual({});
  });
});

describe('the rest of the network form', () => {
  it('keeps the TURN URLs as typed (Enter works) and parses them on Save', async () => {
    await renderPanel();
    const urls = screen.getByLabelText(c.turnUrls) as HTMLTextAreaElement;
    fireEvent.change(urls, { target: { value: 'turn:203.0.113.7:3478?transport=udp\n' } });
    expect(urls.value).toBe('turn:203.0.113.7:3478?transport=udp\n');
    fireEvent.change(urls, {
      target: { value: 'turn:203.0.113.7:3478?transport=udp\n\nturn:203.0.113.7:3478?transport=tcp, turn:203.0.113.7:3478?transport=udp\n' },
    });
    expect(await save()).toEqual({
      turn: { urls: ['turn:203.0.113.7:3478?transport=udp', 'turn:203.0.113.7:3478?transport=tcp'] },
    });
  });

  it('an emptied WebSocket URL blocks the save with a warning, and Put it back restores it', async () => {
    await renderPanel();
    fireEvent.change(field(c.websocketUrl), { target: { value: '  ' } });
    expect(screen.getByTestId('ws-url-missing').textContent).toContain('wss://signal.example.test');
    expect(saveButton().disabled).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: c.wsUrlRestore }));
    expect(field(c.websocketUrl).value).toBe('wss://signal.example.test');
    expect(screen.queryByTestId('ws-url-missing')).toBeNull();
    expect(puts()).toHaveLength(0);
  });

  it('the static pair still saves, an emptied one as null', async () => {
    await renderPanel(network({ username: 'fixed-user', credential: 'fixed-pass' }));
    fireEvent.change(field(c.turnUsername), { target: { value: '' } });
    fireEvent.change(field(c.turnCredential), { target: { value: '' } });
    expect(await save()).toEqual({ turn: { username: null, credential: null } });
  });

  it('a refusal shows the server\'s own text', async () => {
    await renderPanel();
    fireEvent.change(field(c.turnSecret), { target: { value: 'new-secret' } });
    replies.push(on('PUT', '/api/admin/calls/rtc-endpoints', { error: 'TURN shared secret needs PLUGIN_SECRETS_MASTER_KEY' }, 400));
    fireEvent.click(saveButton());
    await waitFor(() =>
      expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({
        title: c.saveFailed,
        description: 'TURN shared secret needs PLUGIN_SECRETS_MASTER_KEY',
        variant: 'destructive',
      })),
    );
  });
});

describe('the Voice & Video page', () => {
  const o = en.admin.voiceVideo.overview;
  function renderPage() {
    render(
      <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
        <MemoryRouter>
          <I18nProvider initialLocale="en" initialTranslations={en}>
            <VoiceVideoPage />
          </I18nProvider>
        </MemoryRouter>
      </QueryClientProvider>,
    );
  }
  // Radix tabs switch on mouse down (and on keyboard), not on click.
  const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0 });

  it('the overview names who gets the relay and how its credentials are made', async () => {
    replies.push(controlPlane(network()));
    renderPage();
    expect((await screen.findByTestId('overview-relay-countries')).textContent).toBe('IR');
    expect(screen.getByText(o.staticSecret)).toBeTruthy();
  });

  it('the overview says everyone when the list is empty', async () => {
    replies.push(controlPlane(network({ countries: [] })));
    renderPage();
    expect((await screen.findByTestId('overview-relay-countries')).textContent).toBe(o.relayEveryone);
  });

  it('"Open RTC, TURN and network settings" opens the Channels tab', async () => {
    replies.push(controlPlane(network()));
    renderPage();
    await screen.findByTestId('overview-relay-countries');
    openTab(en.admin.voiceVideo.tabs.providers);
    replies.push(controlPlane(network()));
    fireEvent.click(await screen.findByRole('button', { name: en.admin.voiceVideo.providers.openNetwork }));
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: en.admin.voiceVideo.tabs.channels }).getAttribute('data-state')).toBe('active'),
    );
    expect(await screen.findByLabelText(c.turnSecret)).toBeTruthy();
  });
});
