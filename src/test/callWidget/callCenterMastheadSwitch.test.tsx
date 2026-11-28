/**
 * The workspace's call center switch (owner, 2026-11-28): in the call
 * center's masthead, beside the live numbers, for the workspace owner only,
 * off by default. Switching off is always allowed; switching on needs the
 * call center in the plan and on the platform. The Settings page no longer
 * carries it, and its save no longer sends `enabled`.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import fa from '@/i18n/locales/fa';

const state = vi.hoisted(() => ({
  role: 'owner' as string,
  caps: { platform_enabled: true, workspace_enabled: false, workspace_call_center_visible: true } as Record<string, unknown>,
  planModules: { call_center: true } as Record<string, boolean>,
  planReady: true,
  patches: [] as Array<Record<string, unknown>>,
}));

vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme' } }),
}));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'me' } }) }));
vi.mock('@/hooks/useWorkspaceRole', () => ({ useWorkspaceRole: () => ({ data: state.role }) }));
vi.mock('@/hooks/useCallCenter', () => ({
  useCallCenterCapabilities: () => ({ data: state.caps }),
  useCallCenterOverview: () => ({ data: { waiting_calls: 0, active_calls: 0, provider: { ready: true } } }),
  // The Overview page's other reads: nothing yet.
  useCallCenterSettings: () => ({ data: { platform: { call_center_enabled: true }, settings: { enabled: state.caps.workspace_enabled } } }),
  useCallCenterQueue: () => ({ data: undefined }),
  useCallCenterCalls: () => ({ data: undefined }),
  useCallCenterCallbacks: () => ({ data: undefined }),
  useCallCenterAgentPresence: () => ({ data: undefined }),
  useUpdateCallCenterSettings: () => ({
    isPending: false,
    mutateAsync: async (patch: Record<string, unknown>) => { state.patches.push(patch); return {}; },
  }),
}));
vi.mock('@/hooks/useEntitlements', () => ({
  usePlanAccess: () => ({
    status: state.planReady ? 'ready' : 'loading',
    module: (k: string) => !!state.planModules[k],
    feature: () => true,
    channel: () => true,
    limit: () => null,
  }),
}));
vi.mock('@/lib/call-center-api', () => ({
  callCenterApi: { getAgentStatus: async () => ({ agents: [] }), updateAgentStatus: async () => ({}) },
}));
vi.mock('@/hooks/use-toast', () => ({ toast: () => {} }));
// The plan gate around the module is tested with the gate; here the plan allows it.
vi.mock('@/components/plan/PlanLockedOverlay', () => ({ PlanLockedOverlay: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

const { CallCenterLayout } = await import('@/components/layout/CallCenterLayout');
const { I18nProvider } = await import('@/i18n');

function mount() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={qc}>
      <I18nProvider initialLocale="fa" initialTranslations={fa}>
        <MemoryRouter initialEntries={['/acme/call-center']}>
          <Routes>
            <Route path="/:slug/call-center" element={<CallCenterLayout />} />
          </Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

const master = () => document.querySelector('[data-cc-master]');
const masterSwitch = () => screen.getByRole('switch', { name: fa.teamDept.ccMasterTitle });

afterEach(() => {
  cleanup();
  state.role = 'owner';
  state.caps = { platform_enabled: true, workspace_enabled: false, workspace_call_center_visible: true };
  state.planModules = { call_center: true };
  state.planReady = true;
  state.patches = [];
});

describe('the call center switch in the masthead', () => {
  it('the owner sees it beside the live numbers, off by default, and switches it on', async () => {
    mount();
    await waitFor(() => expect(master()).not.toBeNull());
    expect(master()!.textContent).toContain(fa.teamDept.ccMasterTitle);
    expect(masterSwitch().getAttribute('aria-checked')).toBe('false');
    fireEvent.click(masterSwitch());
    await waitFor(() => expect(state.patches).toEqual([{ enabled: true }]));
  });

  it.each(['admin', 'agent', 'staff'])('%s does not see it', (role) => {
    state.role = role;
    mount();
    expect(master()).toBeNull();
  });

  it('is on when the workspace is on, and switching off is always allowed', async () => {
    state.caps = { ...state.caps, workspace_enabled: true };
    state.planModules = {};
    mount();
    await waitFor(() => expect(master()).not.toBeNull());
    expect(masterSwitch().getAttribute('aria-checked')).toBe('true');
    expect(masterSwitch()).not.toBeDisabled();
    fireEvent.click(masterSwitch());
    await waitFor(() => expect(state.patches).toEqual([{ enabled: false }]));
  });

  it('cannot be switched on without the plan, while the plan loads, or with the platform off', () => {
    state.planModules = {};
    mount();
    expect(masterSwitch()).toBeDisabled();
    expect(master()!.getAttribute('title')).toBe(fa.callCenter.settingsPage.masterPlanLocked);
    cleanup();
    state.planModules = { call_center: true };
    state.planReady = false;
    mount();
    expect(masterSwitch()).toBeDisabled();
    cleanup();
    state.planReady = true;
    state.caps = { ...state.caps, platform_enabled: false };
    mount();
    expect(masterSwitch()).toBeDisabled();
  });
});

describe('the Overview\'s "Turn on"', () => {
  async function mountOverview() {
    const { default: OverviewPage } = await import('@/pages/app/call-center/OverviewPage');
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    return render(
      <QueryClientProvider client={qc}>
        <I18nProvider initialLocale="fa" initialTranslations={fa}>
          <MemoryRouter><OverviewPage /></MemoryRouter>
        </I18nProvider>
      </QueryClientProvider>,
    );
  }

  it('the owner turns the call center on from it', async () => {
    await mountOverview();
    const button = await waitFor(() => {
      const b = document.querySelector('[data-cc-turn-on]');
      expect(b).not.toBeNull();
      return b as HTMLButtonElement;
    });
    expect(button.textContent).toBe(fa.callCenter.overview.turnOn);
    fireEvent.click(button);
    await waitFor(() => expect(state.patches).toEqual([{ enabled: true }]));
  });

  it.each(['admin', 'agent'])('%s is not offered it', async (role) => {
    state.role = role;
    await mountOverview();
    expect(document.querySelector('[data-cc-turn-on]')).toBeNull();
  });

  it('operators who find it off are told the owner turns it on at the top of the call center', () => {
    expect(fa.callCenter.layout.unavailableWorkspace).toContain('مالک فضای کاری');
    expect(fa.callCenter.layout.unavailableWorkspace).not.toContain('مدیر');
  });
});

describe('the Settings page', () => {
  const page = readFileSync(join(process.cwd(), 'src/pages/app/call-center/SettingsPage.tsx'), 'utf8');
  it('no longer carries the switch, and its save does not send enabled', () => {
    expect(page).not.toContain('data-cc-master');
    expect(page).not.toMatch(/\benabled: s\.enabled\b/);
  });
});
