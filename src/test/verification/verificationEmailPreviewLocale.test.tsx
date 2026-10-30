/**
 * Super Admin → Verification → Preview shows the code's email as it is sent
 * (the `verification_code` template, rendered by Branding's own preview).
 * A code is mailed in the language it was asked for only when the platform
 * offers that language; otherwise in the platform's first one (the email
 * core's resolveEmailScope: an Iranian platform mails Persian whatever was
 * asked). So the email shown for a language the platform does not offer is
 * the one that is sent instead, and the page says so; the SMS wording keeps
 * the chosen language.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({
    t: (k: string, params?: Record<string, unknown>) => (params ? `[${k}|${JSON.stringify(params)}]` : `[${k}]`),
    locale: 'en',
    dir: 'ltr',
  }),
}));
// Every tab's content at once: which tab is open is not what this is about.
vi.mock('@/components/ui/tabs', () => ({
  Tabs: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsList: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  TabsTrigger: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  TabsContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/components/ui/select', async () => {
  const { createContext, useContext } = await import('react');
  const Pick = createContext<(value: string) => void>(() => {});
  return {
    Select: ({ onValueChange, children }: { onValueChange: (value: string) => void; children: ReactNode }) => (
      <Pick.Provider value={onValueChange}>{children}</Pick.Provider>
    ),
    SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectValue: () => null,
    SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
    SelectItem: ({ value, children }: { value: string; children: ReactNode }) => {
      const pick = useContext(Pick);
      return <button type="button" data-testid={`locale-${value}`} onClick={() => pick(value)}>{children}</button>;
    },
  };
});

const AdminVerificationPage = (await import('@/pages/admin/VerificationPage')).default;
const { emailSendLocale } = await import('@/hooks/useVerificationAdmin');

let offered: string[] = [];
let emailPreviews: string[] = [];
let smsPreviews: string[] = [];

beforeEach(() => {
  emailPreviews = [];
  smsPreviews = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, string> : {};
    const reply = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json });
    if (String(url).endsWith('/email-templates/catalog')) {
      return reply(200, { edition: offered.length === 1 ? 'iran' : 'international', locales: { offered, fallback: 'en' }, templates: [] });
    }
    if (String(url).endsWith('/email-templates/preview')) {
      emailPreviews.push(body.locale);
      return reply(200, { subject: `Code mail ${body.locale}`, html: `<p>${body.locale}</p>`, text: 'T', problems: [] });
    }
    if (String(url).endsWith('/templates/preview')) {
      smsPreviews.push(body.locale);
      return reply(200, { locale: body.locale, sms: { text: `SMS ${body.locale}`, providerTemplated: true } });
    }
    // The overview and the audit: not what this is about.
    return reply(500, { error: 'not_here' });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  render(<QueryClientProvider client={client}><AdminVerificationPage /></QueryClientProvider>);
}

const sentInNote = (language: string) => `[admin.verification.preview.emailSentIn|${JSON.stringify({ language: `[admin.brandingPage.languages.${language}]` })}]`;

describe('the language a code is mailed in', () => {
  it('is the asked one when the platform offers it, else the platform\'s first', () => {
    expect(emailSendLocale('en', ['fa'])).toBe('fa');
    expect(emailSendLocale('tr', ['fa'])).toBe('fa');
    expect(emailSendLocale('fa', ['fa'])).toBe('fa');
    expect(emailSendLocale('tr', ['en', 'fa', 'tr'])).toBe('tr');
    expect(emailSendLocale('fa', ['en', 'tr'])).toBe('en');
  });
});

describe('Verification → Preview, the email', () => {
  it('on a platform that mails Persian only, is the Persian mail for a code asked for in English, and says so', async () => {
    offered = ['fa'];
    renderPage();
    await waitFor(() => expect(screen.getByText('Code mail fa')).toBeInTheDocument());
    expect(emailPreviews).toEqual(['fa']);
    expect(screen.getByText(sentInNote('fa'))).toBeInTheDocument();
    expect(screen.getByTitle('[admin.verification.preview.iframeTitle]').getAttribute('srcdoc')).toBe('<p>fa</p>');
    // The SMS wording keeps the chosen language.
    await waitFor(() => expect(smsPreviews).toEqual(['en']));

    fireEvent.click(screen.getByTestId('locale-tr'));
    await waitFor(() => expect(smsPreviews).toEqual(['en', 'tr']));
    expect(screen.getByText('Code mail fa')).toBeInTheDocument();
    expect(emailPreviews.every((l) => l === 'fa')).toBe(true);

    fireEvent.click(screen.getByTestId('locale-fa'));
    await waitFor(() => expect(screen.queryByText(sentInNote('fa'))).toBeNull());
    expect(screen.getByText('Code mail fa')).toBeInTheDocument();
  });

  it('is the chosen language\'s own mail where the platform offers it', async () => {
    offered = ['en', 'fa', 'tr'];
    renderPage();
    await waitFor(() => expect(screen.getByText('Code mail en')).toBeInTheDocument());
    fireEvent.click(screen.getByTestId('locale-tr'));
    await waitFor(() => expect(screen.getByText('Code mail tr')).toBeInTheDocument());
    expect(emailPreviews).toEqual(['en', 'tr']);
    expect(screen.queryByText(/admin\.verification\.preview\.emailSentIn/)).toBeNull();
  });
});
