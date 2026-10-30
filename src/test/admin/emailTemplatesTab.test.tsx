/**
 * Super Admin → Branding → Email templates (src/components/admin/EmailTemplatesTab.tsx):
 *
 *   - every template the catalog names is listed, the ones nothing sends
 *     under their own group, and so is a row whose slug the catalog does not
 *     know: every row the edition keeps is viewable;
 *   - a language the edition does not offer is read, not edited, and says
 *     why (the English row of an Iranian platform is its last resort; its
 *     Turkish one is never sent);
 *   - the preview is the server's render of the text as it stands (light or
 *     dark), drawn in an iframe with an empty sandbox, at a desktop or phone
 *     width, with its plain-text part and its content problems in words;
 *   - "Send me a test" sends the text as it stands;
 *   - a mail the platform sends can be neither deleted nor switched off, and
 *     a save switches a switched-off row back on;
 *   - unsaved edits are not dropped by choosing another template or
 *     language, nor by closing the page, without asking.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { catalogView } from '../../../server/services/email/templateCatalog.js';

vi.mock('@/i18n', () => ({
  useTranslation: () => ({ t: (k: string) => `[${k}]`, locale: 'en', dir: 'ltr' }),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn(), info: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));
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
      return <button type="button" onClick={() => pick(value)}>{children}</button>;
    },
  };
});

const EmailTemplatesTab = (await import('@/components/admin/EmailTemplatesTab')).default;

interface Call { url: string; method: string; body: Record<string, unknown> | null }
let calls: Call[] = [];
let testSendStatus = 200;
let rows: Array<Record<string, unknown>> = [];

const row = (slug: string, locale: string, extra: Record<string, unknown> = {}) => ({
  id: `${slug}-${locale}`, workspace_id: null, slug, locale,
  subject: `${slug} ${locale}`, html_body: `<h1>${slug} ${locale}</h1>`, text_body: null, is_active: true, ...extra,
});

function previewCalls(): Array<Record<string, unknown>> {
  return calls.filter((c) => c.url.endsWith('/preview')).map((c) => c.body ?? {});
}

beforeEach(() => {
  calls = [];
  testSendStatus = 200;
  rows = [
    row('email_verify', 'fa'), row('email_verify', 'en'), row('email_verify', 'tr'),
    row('password_reset', 'fa'),
    row('billing_trial_ended', 'fa', { is_active: false }),
    row('operator_unread_digest', 'fa'),
    row('welcome', 'fa'),
    row('old_custom_mail', 'fa'),
  ];
  toast.success.mockClear();
  toast.error.mockClear();
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : null;
    calls.push({ url: String(url), method, body });
    const reply = (status: number, json: unknown) => ({ ok: status < 400, status, json: async () => json });
    if (String(url).endsWith('/catalog')) {
      return reply(200, { edition: 'iran', locales: { offered: ['fa'], fallback: 'en' }, templates: catalogView('iran') });
    }
    if (String(url).endsWith('/preview')) {
      return reply(200, {
        subject: `Rendered: ${String(body?.subject)}`,
        html: `<!doctype html><html><body><p>${String(body?.scheme)}</p></body></html>`,
        text: 'The plain part',
        problems: ['foreign_link', 'forbidden_element:script'],
      });
    }
    if (String(url).endsWith('/test-send')) {
      return testSendStatus === 200
        ? reply(200, { success: true, sent_to: 'admin@example.com' })
        : reply(testSendStatus, { error: 'test_limit_reached', retry_after_seconds: 60 });
    }
    if (method === 'GET') return reply(200, { templates: rows, edition: 'iran' });
    return reply(200, { template: rows[0] });
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function renderTab(props: { onDirtyChange?: (dirty: boolean) => void } = {}) {
  render(<EmailTemplatesTab {...props} />);
  await waitFor(() => expect(screen.getByTestId('email-templates-edition')).toBeInTheDocument());
  await waitFor(() => expect(screen.getByDisplayValue('email_verify fa')).toBeInTheDocument());
}

const listed = (group: 'sent' | 'legacy') => within(screen.getByTestId(`email-templates-${group}`)).getAllByRole('button')
  .map((b) => (b.getAttribute('data-testid') ?? '').replace(/^email-template-/, ''));
const subjectInput = () => screen.getByPlaceholderText('[admin.brandingPage.emailTemplates.subjectPlaceholder]') as HTMLInputElement;

describe('the list', () => {
  it('names every template the catalog keeps, the ones nothing sends apart, and any other row of the table', async () => {
    await renderTab();
    const view = catalogView('iran');
    expect(listed('sent')).toEqual(view.filter((v) => v.status === 'sent').map((v) => v.slug));
    expect(listed('legacy')).toEqual([...view.filter((v) => v.status === 'legacy').map((v) => v.slug), 'old_custom_mail']);
    expect(screen.getByTestId('email-templates-legacy')).toHaveTextContent('[admin.brandingPage.emailTemplates.groups.legacy]');
    // The languages each one has a row in.
    expect(screen.getByTestId('email-template-email_verify-locales')).toHaveTextContent('faentr');
    expect(screen.getByTestId('email-template-password_reset-locales')).toHaveTextContent(/^fa$/);
  });

  it('describes a legacy template, and one the catalog does not know', async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId('email-template-welcome'));
    expect(screen.getByTestId('email-template-notices')).toHaveTextContent('[admin.brandingPage.emailTemplates.notices.legacy]');
    expect(screen.getByText('[admin.brandingPage.emailTemplates.descriptions.welcome]')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('email-template-old_custom_mail'));
    expect(screen.getByTestId('email-template-notices')).toHaveTextContent('[admin.brandingPage.emailTemplates.notices.unknown]');
  });

  it('shows the catalog\'s variables, the operator notices\' with double braces', async () => {
    await renderTab();
    expect(within(screen.getByTestId('email-template-variables')).getByText('{action_url}')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('email-template-operator_unread_digest'));
    const chips = within(screen.getByTestId('email-template-variables')).getAllByText(/^\{\{[a-z_]+\}\}$/).map((e) => e.textContent);
    expect(chips).toEqual(['{{name}}', '{{count}}', '{{minutes}}', '{{workspace}}', '{{list}}', '{{action_url}}', '{{brand}}', '{{year}}', '{{support_email}}']);
  });
});

describe('the languages', () => {
  it('edits the ones the platform offers and shows the others read-only, saying why', async () => {
    await renderTab();
    expect(screen.getByTestId('email-template-save')).toBeInTheDocument();
    expect(screen.queryByTestId('email-template-notices')).toBeNull();

    fireEvent.click(screen.getByTestId('email-template-locale-en'));
    await waitFor(() => expect(screen.getByDisplayValue('email_verify en')).toBeInTheDocument());
    const notices = screen.getByTestId('email-template-notices');
    expect(notices).toHaveTextContent('[admin.brandingPage.emailTemplates.notices.fallback]');
    expect(notices).toHaveTextContent('[admin.brandingPage.emailTemplates.notices.readOnly]');
    expect(subjectInput().readOnly).toBe(true);
    expect((screen.getByTestId('email-template-html') as HTMLTextAreaElement).readOnly).toBe(true);
    expect(screen.queryByTestId('email-template-save')).toBeNull();

    fireEvent.click(screen.getByTestId('email-template-locale-tr'));
    await waitFor(() => expect(screen.getByDisplayValue('email_verify tr')).toBeInTheDocument());
    expect(screen.getByTestId('email-template-notices')).toHaveTextContent('[admin.brandingPage.emailTemplates.notices.neverSent]');
  });

  it('says when a language has no row yet', async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId('email-template-password_reset'));
    fireEvent.click(screen.getByTestId('email-template-locale-tr'));
    expect(screen.getByTestId('email-template-notices')).toHaveTextContent('[admin.brandingPage.emailTemplates.notices.missing]');
  });
});

describe('the preview', () => {
  it('is the server\'s render of the text as it stands, in an iframe with an empty sandbox', async () => {
    await renderTab();
    await waitFor(() => expect(previewCalls()).toHaveLength(1));
    expect(previewCalls()[0]).toEqual({
      slug: 'email_verify', locale: 'fa', subject: 'email_verify fa', html_body: '<h1>email_verify fa</h1>', text_body: null, scheme: 'light',
    });
    const frame = await screen.findByTitle('[admin.brandingPage.emailTemplates.previewTitle]');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.getAttribute('srcdoc')).toContain('<p>light</p>');
    expect(screen.getByTestId('email-template-preview-subject')).toHaveTextContent('Rendered: email_verify fa');

    fireEvent.change(subjectInput(), { target: { value: 'Edited subject' } });
    await waitFor(() => expect(previewCalls().at(-1)).toMatchObject({ subject: 'Edited subject' }));
  });

  it('switches to dark, to a phone\'s width and to the plain-text part', async () => {
    await renderTab();
    await screen.findByTitle('[admin.brandingPage.emailTemplates.previewTitle]');
    expect(screen.getByTestId('email-template-preview-frame').style.width).toBe('600px');
    fireEvent.click(screen.getByTestId('email-template-preview-mobile'));
    expect(screen.getByTestId('email-template-preview-frame').style.width).toBe('375px');

    fireEvent.click(screen.getByTestId('email-template-preview-dark'));
    await waitFor(() => expect(previewCalls().at(-1)).toMatchObject({ scheme: 'dark' }));
    await waitFor(() => expect(screen.getByTitle('[admin.brandingPage.emailTemplates.previewTitle]').getAttribute('srcdoc')).toContain('<p>dark</p>'));

    fireEvent.click(screen.getByTestId('email-template-preview-text'));
    expect(screen.getByTestId('email-template-preview-plain')).toHaveTextContent('The plain part');
  });

  it('says what the content holds that a mail must not send', async () => {
    await renderTab();
    const problems = await screen.findByTestId('email-template-problems');
    expect(problems).toHaveTextContent('[admin.brandingPage.emailTemplates.problems.foreign_link]');
    expect(problems).toHaveTextContent('[admin.brandingPage.emailTemplates.problems.forbidden_element]');
  });
});

describe('a test', () => {
  it('sends the text as it stands, and says where', async () => {
    await renderTab();
    fireEvent.change(subjectInput(), { target: { value: 'Not saved yet' } });
    fireEvent.click(screen.getByTestId('email-template-test'));
    await waitFor(() => expect(toast.success).toHaveBeenCalledWith('[admin.brandingPage.emailTemplates.test.sent]'));
    const test = calls.find((c) => c.url.endsWith('/test-send'));
    expect(test).toMatchObject({ method: 'POST', body: { slug: 'email_verify', locale: 'fa', subject: 'Not saved yet', html_body: '<h1>email_verify fa</h1>', text_body: null } });
  });

  it('says when too many tests were sent', async () => {
    testSendStatus = 429;
    await renderTab();
    fireEvent.click(screen.getByTestId('email-template-test'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('[admin.brandingPage.emailTemplates.test.limit]'));
  });
});

describe('a mail the platform sends', () => {
  it('can be neither deleted nor switched off; a template nothing sends can be', async () => {
    await renderTab();
    expect(screen.queryByText('[admin.brandingPage.emailTemplates.delete]')).toBeNull();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(screen.getByText('[admin.brandingPage.emailTemplates.notices.alwaysOn]')).toBeInTheDocument();
    fireEvent.click(screen.getByTestId('email-template-welcome'));
    expect(screen.getByText('[admin.brandingPage.emailTemplates.delete]')).toBeInTheDocument();
    expect(screen.getByRole('switch')).toBeInTheDocument();
  });

  it('is switched back on by a save', async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId('email-template-billing_trial_ended'));
    expect(screen.getByTestId('email-template-notices')).toHaveTextContent('[admin.brandingPage.emailTemplates.notices.inactive]');
    fireEvent.click(screen.getByTestId('email-template-save'));
    await waitFor(() => expect(calls.some((c) => c.method === 'PUT')).toBe(true));
    expect(calls.find((c) => c.method === 'PUT')).toMatchObject({
      url: expect.stringMatching(/\/email-templates\/billing_trial_ended-fa$/),
      body: { is_active: true },
    });
  });
});

describe('unsaved edits', () => {
  it('ask before another template or language replaces them, and stay when the answer is no', async () => {
    const onDirtyChange = vi.fn();
    await renderTab({ onDirtyChange });
    fireEvent.change(subjectInput(), { target: { value: 'Half written' } });
    expect(screen.getByTestId('email-template-dirty')).toBeInTheDocument();
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);

    vi.mocked(window.confirm).mockReturnValue(false);
    fireEvent.click(screen.getByTestId('email-template-password_reset'));
    expect(window.confirm).toHaveBeenCalledWith('[admin.brandingPage.emailTemplates.unsaved.confirm]');
    expect(subjectInput().value).toBe('Half written');
    fireEvent.click(screen.getByTestId('email-template-locale-en'));
    expect(subjectInput().value).toBe('Half written');

    vi.mocked(window.confirm).mockReturnValue(true);
    fireEvent.click(screen.getByTestId('email-template-password_reset'));
    await waitFor(() => expect(subjectInput().value).toBe('password_reset fa'));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it('do not ask when there are none', async () => {
    await renderTab();
    fireEvent.click(screen.getByTestId('email-template-password_reset'));
    await waitFor(() => expect(subjectInput().value).toBe('password_reset fa'));
    expect(window.confirm).not.toHaveBeenCalled();
  });

  it('make the browser ask before the page is closed', async () => {
    await renderTab();
    const quiet = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(quiet);
    expect(quiet.defaultPrevented).toBe(false);
    fireEvent.change(subjectInput(), { target: { value: 'Half written' } });
    const leaving = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(leaving);
    expect(leaving.defaultPrevented).toBe(true);
  });
});
