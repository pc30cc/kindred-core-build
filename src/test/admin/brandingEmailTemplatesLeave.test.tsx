/**
 * Super Admin → Branding: another tab unmounts the email templates' editor,
 * so leaving it with unsaved edits asks first (EmailTemplatesTab tells the
 * page through onDirtyChange), and leaving it with none does not.
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useAdmin', () => ({ adminFetch: vi.fn(async () => ({})) }));
vi.mock('@/lib/platformPublicConfig', async (orig) => ({
  ...(await orig<typeof import('@/lib/platformPublicConfig')>()),
  usePlatformPublicConfig: () => ({ data: { region: { region_mode: 'international' }, brand_assets: null } }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: () => undefined }));
vi.mock('@/i18n', () => ({
  useI18n: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
  useTranslation: () => ({ locale: 'en', dir: 'ltr', t: (key: string) => key }),
}));
vi.mock('@/lib/native', () => ({ isNativePlatform: () => false, getNativePlatform: () => 'web' }));
// The editor itself is tested on its own (emailTemplatesTab.test.tsx): here, a
// stand-in that has edits or not.
vi.mock('@/components/admin/EmailTemplatesTab', () => ({
  default: ({ onDirtyChange }: { onDirtyChange?: (dirty: boolean) => void }) => (
    <div data-testid="templates-editor">
      <button type="button" onClick={() => onDirtyChange?.(true)}>edit</button>
      <button type="button" onClick={() => onDirtyChange?.(false)}>save</button>
    </div>
  ),
}));

const AdminBrandingPage = (await import('@/pages/admin/BrandingPage')).default;

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminBrandingPage /></QueryClientProvider>);
}

/** Radix's tab trigger changes tab on a primary mouse down. */
const openTab = (name: string) => fireEvent.mouseDown(screen.getByRole('tab', { name }), { button: 0, ctrlKey: false });

beforeEach(() => {
  vi.spyOn(window, 'confirm').mockReturnValue(false);
});
afterEach(() => {
  vi.restoreAllMocks();
});

describe('Branding → leaving the email templates', () => {
  it('asks when there are unsaved edits, and stays when the answer is no', () => {
    renderPage();
    openTab('admin.brandingPage.tabs.emailTemplates');
    fireEvent.click(screen.getByText('edit'));
    openTab('admin.brandingPage.tabs.domains');
    expect(window.confirm).toHaveBeenCalledWith('admin.brandingPage.emailTemplates.unsaved.leave');
    expect(screen.getByTestId('templates-editor')).toBeInTheDocument();

    vi.mocked(window.confirm).mockReturnValue(true);
    openTab('admin.brandingPage.tabs.domains');
    expect(screen.queryByTestId('templates-editor')).toBeNull();
  });

  it('does not ask when everything is saved', () => {
    renderPage();
    openTab('admin.brandingPage.tabs.emailTemplates');
    fireEvent.click(screen.getByText('edit'));
    fireEvent.click(screen.getByText('save'));
    openTab('admin.brandingPage.tabs.domains');
    expect(window.confirm).not.toHaveBeenCalled();
    expect(screen.queryByTestId('templates-editor')).toBeNull();
  });
});
