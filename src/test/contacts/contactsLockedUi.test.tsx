/**
 * Simple billing phase 4 — how the dashboard shows contacts over the plan's
 * max_contacts (the server sends them redacted with `locked: true`):
 *   - the list: the row is a blurred placeholder with a lock badge and the
 *     plan tooltip, cannot be opened, has no checkbox, its network profile
 *     is never asked for, and a summary offers the upgrade;
 *   - the contact page: a 403 contact_locked shows the locked view (limit,
 *     upgrade, back, delete) and reads nothing else about the contact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, fireEvent } from '@testing-library/react';
import { PlanLockedError } from '@/lib/contacts-api';

const h = vi.hoisted(() => ({
  contacts: [] as Array<Record<string, unknown>>,
  navigate: vi.fn(),
  networkIds: [] as string[],
  contactError: null as unknown,
  readIds: [] as Array<string | undefined>,
  deleteMutate: vi.fn(async () => undefined),
}));

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, p?: Record<string, string>) => (p ? `${k}:${JSON.stringify(p)}` : k),
    locale: 'en',
    dir: 'ltr',
  }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => h.navigate,
  useParams: () => ({ slug: 'acme', id: 'c-locked' }),
  Link: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/hooks/useWorkspace', () => ({ useCurrentWorkspace: () => ({ id: 'ws-1' }) }));
vi.mock('@/hooks/useEntitlements', () => ({ usePlanAccess: () => ({ feature: () => true }) }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
vi.mock('@/hooks/useContactChannels', () => ({
  useContactChannels: () => ({ data: {} }),
  useContactCalls: (_ws: string | undefined, id: string | undefined) => { h.readIds.push(id); return { data: [] }; },
}));
vi.mock('@/hooks/useVisitorNetwork', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/hooks/useVisitorNetwork')>()),
  useVisitorNetworkBatchByContact: (_ws: string | undefined, ids: string[]) => { h.networkIds = ids; return { data: {}, isPending: false }; },
  useVisitorNetwork: () => ({ data: null }),
}));
vi.mock('@/hooks/useContactIp', () => ({ useContactIp: () => ({ data: undefined }) }));
vi.mock('@/features/contacts/ContactImportWizard', () => ({ ContactImportWizard: () => null }));
vi.mock('@/hooks/useContacts', () => ({
  useContacts: () => ({ data: h.contacts, isLoading: false }),
  useCreateContact: () => ({ mutateAsync: vi.fn() }),
  useBulkDeleteContacts: () => ({ mutateAsync: vi.fn() }),
  useContact: () => ({ data: undefined, isLoading: false, error: h.contactError }),
  useContactConversations: (id: string | undefined) => { h.readIds.push(id); return { data: undefined }; },
  useUpdateContact: () => ({ mutateAsync: vi.fn() }),
  useDeleteContact: () => ({ mutateAsync: h.deleteMutate }),
}));

import ContactsPage from '@/pages/app/ContactsPage';
import ContactDetailPage from '@/pages/app/ContactDetailPage';

beforeEach(() => {
  h.navigate.mockReset();
  h.deleteMutate.mockClear();
  h.readIds = [];
  h.contactError = null;
  h.contacts = [
    { id: 'c-open', workspace_id: 'ws-1', name: 'Ada', email: 'ada@example.com', tags: [], metadata: {}, created_at: '2026-01-01T00:00:00Z', locked: false },
    { id: 'c-locked', workspace_id: 'ws-1', name: null, email: null, phone: null, tags: [], metadata: {}, created_at: '2026-02-01T00:00:00Z', locked: true },
  ];
});

describe('ContactsPage — contacts over the plan limit', () => {
  it('renders a locked row as a placeholder with the badge and tooltip, and a summary', () => {
    const { container } = render(<ContactsPage />);
    const row = container.querySelector('[data-contact-locked="c-locked"]')!;
    expect(row).toBeTruthy();
    expect(row.getAttribute('title')).toBe('contacts.locked.tooltip');
    expect(row.textContent).toContain('contacts.locked.name');
    expect(row.textContent).toContain('contacts.locked.badge');
    expect(row.querySelector('[role="checkbox"]')).toBeNull();
    expect(container.querySelector('[data-page-locked-summary]')?.textContent).toContain('contacts.locked.summary:{"count":"1"}');
  });

  it('a locked row does not open; an unlocked one does', () => {
    const { container } = render(<ContactsPage />);
    fireEvent.click(container.querySelector('[data-contact-locked="c-locked"]')!);
    expect(h.navigate).not.toHaveBeenCalled();
    const open = Array.from(container.querySelectorAll('tbody tr')).find((r) => r.textContent?.includes('Ada'))!;
    fireEvent.click(open);
    expect(h.navigate).toHaveBeenCalledWith('/acme/contacts/c-open');
  });

  it('never asks for the network profile of a locked contact', () => {
    render(<ContactsPage />);
    expect(h.networkIds).toEqual(['c-open']);
  });

  it('without locked contacts nothing changes: no summary, no placeholder', () => {
    h.contacts = [h.contacts[0]];
    const { container } = render(<ContactsPage />);
    expect(container.querySelector('[data-page-locked-summary]')).toBeNull();
    expect(container.querySelector('[data-contact-locked]')).toBeNull();
  });
});

describe('ContactDetailPage — a locked contact', () => {
  it('shows the locked view with the plan limit and reads nothing else about it', () => {
    h.contactError = new PlanLockedError({ error: 'contact_locked', upgrade_required: true, limit: 100 });
    const { container, getByText } = render(<ContactDetailPage />);
    const view = container.querySelector('[data-page-locked="contact"]')!;
    expect(view).toBeTruthy();
    expect(view.textContent).toContain('contacts.locked.title');
    expect(view.textContent).toContain('contacts.locked.desc:{"limit":"100"}');
    expect(h.readIds.every((id) => id === undefined)).toBe(true);
    fireEvent.click(getByText('contacts.locked.upgrade'));
    expect(h.navigate).toHaveBeenCalledWith('/acme/billing');
  });

  it('a 404 still shows "not found", not the locked view', () => {
    const { container } = render(<ContactDetailPage />);
    expect(container.querySelector('[data-page-locked="contact"]')).toBeNull();
    expect(container.querySelector('[data-page-empty="contact"]')).toBeTruthy();
  });
});
