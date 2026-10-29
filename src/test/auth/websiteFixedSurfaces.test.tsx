/**
 * The owner's rule (2026-10-28) on the panel's surfaces: once registered, the
 * website (the row the server marks `fixed`) offers no control that would
 * change it, with no explanation added, and a website missing or taken
 * meanwhile reads as the existing sentence (server/services/ownerWebsite.ts).
 *
 *   first run (WorkspaceRedirect)  DOMAIN_TAKEN → settings.errors.domainTaken; a website
 *                                  refusal asks for one with the existing label
 *   CreateWorkspaceDialog          no website field (it was never sent)
 *   Settings → Domains             no remove on the website's row, no "set primary" while it
 *                                  is the primary; other rows as before
 *   Super Admin → Domains          no edit on the website's row, no "set primary" in its
 *                                  workspace while it is the primary; other rows as before
 *   Super Admin → Users            the website input is disabled once it is registered
 */
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';

type DomainRow = { id: string; domain: string; workspace_id?: string; verified: boolean; is_primary: boolean; fixed?: boolean };
const state = vi.hoisted(() => ({
  domains: [] as DomainRow[],
  adminDomains: [] as Array<DomainRow & { workspaces: { name: string } }>,
  createWorkspace: vi.fn(),
}));
const libToast = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));

vi.mock('@/lib/toast', () => ({ toast: libToast }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/components/brand/BrandLoader', () => ({ BrandLoaderScreen: () => null }));
vi.mock('@/features/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'u1', email: 'owner@example.test' }, signOut: vi.fn() }) }));
vi.mock('@/hooks/useWorkspace', () => ({
  useWorkspaces: () => ({ data: [], isLoading: false, refetch: vi.fn() }),
  useAccount: () => ({ data: { id: 'acc-1' } }),
  useCreateWorkspace: () => ({ mutateAsync: state.createWorkspace, isPending: false }),
  useCurrentWorkspace: () => ({ id: 'ws-1', name: 'Acme', slug: 'acme' }),
}));
vi.mock('@/features/workspace/useWorkspaceCapacity', () => ({
  useWorkspaceCapacity: () => ({ data: { used: 1, limit: 3, canCreate: true, plan: 'pro' }, isLoading: false }),
}));
vi.mock('@/hooks/useWorkspaceDomains', () => ({ useWorkspaceDomains: () => ({ data: state.domains, isLoading: false }) }));
vi.mock('@/hooks/useAdmin', () => ({ adminFetch: async () => ({ domains: state.adminDomains }) }));

const { WorkspaceRedirect } = await import('@/features/workspace/WorkspaceRedirect');
const { CreateWorkspaceDialog } = await import('@/features/workspace/CreateWorkspaceDialog');
const { default: SettingsDomainsPage } = await import('@/pages/app/settings/DomainsPage');
const { default: AdminDomainsPage } = await import('@/pages/admin/DomainsPage');

afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

function mount(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <MemoryRouter future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <QueryClientProvider client={client}>
        <I18nProvider initialLocale="en" initialTranslations={en}>{node}</I18nProvider>
      </QueryClientProvider>
    </MemoryRouter>,
  );
}
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

describe('a website taken meanwhile', () => {
  it('first-run provisioning shows the existing sentence, not the code', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 409, statusText: 'Conflict', json: async () => ({ error: 'DOMAIN_TAKEN', code: 'DOMAIN_TAKEN' }) })));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = mount(<WorkspaceRedirect />);
    await settle();
    await settle();
    logged.mockRestore();
    expect(view.container.textContent).toContain(en.workspaceRedirect.errorPrefix.replace('{{message}}', en.settings.errors.domainTaken));
    expect(view.container.textContent).not.toContain('DOMAIN_TAKEN');
  });

  it('a website refusal asks for one with the existing label, no hint, and "Try again" sends it', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 400, statusText: 'Bad Request', json: async () => ({ error: 'EMPTY', code: 'EMPTY' }) })
      .mockResolvedValue({ ok: true, status: 200, json: async () => ({ ok: true }) });
    vi.stubGlobal('fetch', fetchMock);
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const view = mount(<WorkspaceRedirect />);
    const field = await screen.findByLabelText(en.auth.websiteDomainLabel);
    logged.mockRestore();
    expect(view.container.textContent).not.toContain('EMPTY');
    expect(view.container.textContent).not.toContain(en.auth.websiteDomainHint);
    const retry = screen.getByRole('button', { name: en.workspaceRedirect.tryAgain });
    expect((retry as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(field, { target: { value: ' shop.example ' } });
    await act(async () => { fireEvent.click(retry); });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(JSON.parse(String(fetchMock.mock.calls[1][1].body))).toEqual({ website: 'shop.example' });
    expect(JSON.parse(String(fetchMock.mock.calls[0][1].body))).toEqual({});
  });

  it('a new workspace: no website field, and the refusal reads as the sentence', async () => {
    state.createWorkspace.mockRejectedValue(new Error('DOMAIN_TAKEN'));
    const view = mount(<CreateWorkspaceDialog open onOpenChange={() => undefined} />);
    expect(document.getElementById('ws-domain')).toBeNull();
    expect(document.body.textContent).not.toMatch(/Website \(optional\)/);
    fireEvent.change(screen.getByLabelText(en.workspaceCreate.nameLabel), { target: { value: 'Second' } });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: en.workspaceCreate.submit })); });
    await settle();
    expect(libToast.error).toHaveBeenCalledWith(en.settings.errors.domainTaken);
    view.unmount();
  });
});

describe('Settings → Domains', () => {
  const removeName = (domain: string) => en.settings.domainsPage.remove.replace('{{domain}}', domain);

  it('the registered website has no remove, and no row offers "set primary" while it is the primary', () => {
    state.domains = [
      { id: 'd1', domain: 'shop.example', verified: true, is_primary: true, fixed: true },
      { id: 'd2', domain: 'second.example', verified: false, is_primary: false, fixed: false },
    ];
    mount(<SettingsDomainsPage />);
    expect(screen.queryByRole('button', { name: removeName('shop.example') })).toBeNull();
    expect(screen.getByRole('button', { name: removeName('second.example') })).toBeTruthy();
    expect(screen.queryByRole('button', { name: en.settings.domainsPage.setPrimary })).toBeNull();
  });

  it('a primary that is not the registered website is managed as before', () => {
    state.domains = [
      { id: 'd1', domain: 'chosen.example', verified: true, is_primary: true, fixed: false },
      { id: 'd2', domain: 'second.example', verified: false, is_primary: false, fixed: false },
    ];
    mount(<SettingsDomainsPage />);
    expect(screen.getByRole('button', { name: removeName('chosen.example') })).toBeTruthy();
    expect(screen.getByRole('button', { name: removeName('second.example') })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: en.settings.domainsPage.setPrimary })).toHaveLength(1);
  });

  it('a workspace without a primary domain may still choose one, as before', () => {
    state.domains = [{ id: 'd2', domain: 'second.example', verified: false, is_primary: false }];
    mount(<SettingsDomainsPage />);
    expect(screen.getByRole('button', { name: en.settings.domainsPage.setPrimary })).toBeTruthy();
    expect(screen.getByRole('button', { name: removeName('second.example') })).toBeTruthy();
  });
});

describe('Super Admin → Domains', () => {
  it('the website\'s row has no control; its workspace\'s other rows only edit; other workspaces as before', async () => {
    state.adminDomains = [
      { id: 'p', domain: 'shop.example', workspace_id: 'ws-a', verified: true, is_primary: true, fixed: true, workspaces: { name: 'A' } },
      { id: 'x', domain: 'extra.example', workspace_id: 'ws-a', verified: false, is_primary: false, workspaces: { name: 'A' } },
      { id: 'y', domain: 'bare.example', workspace_id: 'ws-b', verified: false, is_primary: false, workspaces: { name: 'B' } },
      { id: 'c', domain: 'chosen.example', workspace_id: 'ws-c', verified: true, is_primary: true, fixed: false, workspaces: { name: 'C' } },
      { id: 'o', domain: 'other.example', workspace_id: 'ws-c', verified: false, is_primary: false, workspaces: { name: 'C' } },
    ];
    mount(<AdminDomainsPage />);
    await screen.findByText('shop.example');
    const row = (domain: string) => screen.getByText(domain).closest('tr') as HTMLElement;
    expect(within(row('shop.example')).queryAllByRole('button')).toHaveLength(0);
    expect(within(row('extra.example')).queryByRole('button', { name: en.admin.domains.setPrimary })).toBeNull();
    expect(within(row('extra.example')).queryAllByRole('button')).toHaveLength(1);
    expect(within(row('bare.example')).getByRole('button', { name: en.admin.domains.setPrimary })).toBeTruthy();
    expect(within(row('bare.example')).queryAllByRole('button')).toHaveLength(2);
    // A primary that is not the website: edited, and the flag moves, as before.
    expect(within(row('chosen.example')).queryByRole('button', { name: en.admin.domains.setPrimary })).toBeNull();
    expect(within(row('chosen.example')).queryAllByRole('button')).toHaveLength(1);
    expect(within(row('other.example')).getByRole('button', { name: en.admin.domains.setPrimary })).toBeTruthy();
  });
});

describe('Super Admin → Users', () => {
  it('the website input is disabled once the website is registered', () => {
    const source = readFileSync('src/pages/admin/UsersPage.tsx', 'utf8');
    const field = source.slice(source.indexOf("{t('admin.users.website')}</label>"));
    expect(field.slice(0, 400)).toMatch(/disabled=\{websiteFixed\}/);
    expect(source).toMatch(/const websiteFixed = !!\(detail as \{ website_fixed\?: boolean \} \| undefined\)\?\.website_fixed;/);
  });
});
