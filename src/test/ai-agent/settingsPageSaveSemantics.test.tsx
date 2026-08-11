/**
 * Follow-up to Phase 2.1 (BehaviorPage field-dirty PATCH) — SettingsPage had
 * the same stale/full-form write risk BehaviorPage used to have: onSave()
 * unconditionally resent a fixed set of fields on every click, including
 * `allowed_locales` and `welcome_message`, neither of which has an editable
 * control anywhere on this page. Renders the real SettingsPage component and
 * asserts on the actual save-mutation payload, proving the fix at the UI
 * boundary (same convention as behaviorPageSaveSemantics.test.tsx).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', default_locale: 'en' }, notFound: false }),
}));
vi.mock('@/hooks/usePlatformRegion', () => ({
  usePlatformRegion: () => ({ mode: 'single', allowedLocales: ['en'], canSwitchLanguage: false, currency: 'USD' }),
}));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, dir: 'ltr' }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('@/lib/ai-agent-api', () => ({
  aiAgentApi: {
    generateBusinessDescription: vi.fn(async () => ({ description: 'generated', source: 'ai' })),
    uploadAvatar: vi.fn(async () => ({ avatar_url: 'https://example.com/a.png' })),
    removeAvatar: vi.fn(async () => ({})),
  },
}));

// Same referential-stability requirement as behaviorPageSaveSemantics.test.tsx:
// SettingsPage has a useEffect keyed on [data] that resyncs `form` (and
// resets `dirty`) from data.settings. Reassign dataHolder.data to a fresh
// object BEFORE render() only.
const dataHolder: { data: { settings: any } } = { data: { settings: null } };
const mutateAsync = vi.fn(async (patch: any) => ({ settings: { ...dataHolder.data.settings, ...patch } }));

vi.mock('@/hooks/useAiAgent', () => ({
  useAiAgentSettings: () => ({ data: dataHolder.data, isLoading: false }),
  useUpdateAiAgentSettings: () => ({ mutateAsync, isPending: false }),
}));

const SettingsPage = (await import('@/pages/app/ai-agent/SettingsPage')).default;

function baseSettings(overrides: Record<string, any> = {}) {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    enabled: true,
    mode: 'auto_reply_always',
    agent_name: 'AI Assistant',
    agent_logo_url: null,
    business_description: 'We sell widgets.',
    answer_guidance: 'balanced',
    answer_only_from_kb: false,
    welcome_message: 'legacy welcome text',
    fallback_message: 'Not sure, let me get a human.',
    handoff_keywords: [],
    allowed_locales: ['fa', 'ar'],
    show_sources_to_operator: true,
    ai_intro_enabled: true,
    intro_message_localized: {},
    handoff_message_localized: {},
    handoff_prechat_message_localized: {},
    ...overrides,
  };
}

beforeEach(() => {
  mutateAsync.mockClear();
});

async function clickSave() {
  fireEvent.click(screen.getByRole('button', { name: /save changes/i }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  return mutateAsync.mock.calls[0][0];
}

describe('SettingsPage S1 — changing one field does not resend allowed_locales/mode/enabled', () => {
  it('existing allowed_locales=["fa","ar"] + mode=auto_reply_always + change only fallback_message -> PATCH contains fallback_message only, no allowed_locales/mode/enabled', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: ['fa', 'ar'], mode: 'auto_reply_always' }) };
    render(<SettingsPage />);

    // <Label> and <Input> are siblings without htmlFor/id association in the
    // current markup, so target by current value rather than label text.
    fireEvent.change(screen.getByDisplayValue('Not sure, let me get a human.'), { target: { value: 'New fallback text' } });
    const patch = await clickSave();

    expect(patch).toHaveProperty('fallback_message', 'New fallback text');
    expect(patch).not.toHaveProperty('allowed_locales');
    expect(patch).not.toHaveProperty('mode');
    expect(patch).not.toHaveProperty('enabled');
    expect(patch).not.toHaveProperty('welcome_message');
    expect(Object.keys(patch)).toEqual(['fallback_message']);
  });
});

describe('SettingsPage S2 — unrelated save does not resend other already-set fields', () => {
  it('existing handoff_keywords + fallback_message set, change only agent_name -> fallback_message absent from PATCH', async () => {
    dataHolder.data = { settings: baseSettings({
      handoff_keywords: ['operator', 'human'],
      fallback_message: 'Custom fallback that must survive',
    }) };
    render(<SettingsPage />);

    fireEvent.change(screen.getByDisplayValue('AI Assistant'), { target: { value: 'New Bot Name' } });
    const patch = await clickSave();

    expect(patch).toHaveProperty('agent_name', 'New Bot Name');
    expect(patch).not.toHaveProperty('fallback_message');
    expect(patch).not.toHaveProperty('handoff_keywords');
    expect(patch).not.toHaveProperty('business_description');
    expect(patch).not.toHaveProperty('answer_only_from_kb');
    expect(patch).not.toHaveProperty('show_sources_to_operator');
  });
});

describe('SettingsPage S3 — an explicitly edited field IS included with the intended value', () => {
  it('toggling "Answer only from Knowledge Base" writes the intended value', async () => {
    dataHolder.data = { settings: baseSettings({ answer_only_from_kb: false }) };
    render(<SettingsPage />);

    // DOM order of the 4 switches on this page: [enabled (header),
    // answer_only_from_kb, ai_intro_enabled, show_sources_to_operator].
    // None of them are associated with a <Label htmlFor> in the current
    // markup, so index into the ordered list rather than query by label.
    fireEvent.click(screen.getAllByRole('switch')[1]);
    const patch = await clickSave();

    expect(patch.answer_only_from_kb).toBe(true);
    expect(Object.keys(patch)).toEqual(['answer_only_from_kb']);
  });

  it('editing the business description textarea writes the intended value', async () => {
    dataHolder.data = { settings: baseSettings({ business_description: 'old description' }) };
    render(<SettingsPage />);

    fireEvent.change(screen.getByPlaceholderText(/describe what your business does/i), { target: { value: 'brand new description' } });
    const patch = await clickSave();

    expect(patch.business_description).toBe('brand new description');
    expect(Object.keys(patch)).toEqual(['business_description']);
  });

  it('saving with no changes at all sends an empty patch', async () => {
    dataHolder.data = { settings: baseSettings() };
    render(<SettingsPage />);

    const patch = await clickSave();

    expect(patch).toEqual({});
  });
});

describe('BD7 — SettingsPage canonical ownership: manual edit always writes top-level, never nested', () => {
  it('a manual Business Description edit + save contains top-level business_description and no instructions key', async () => {
    dataHolder.data = { settings: baseSettings({ business_description: 'old description' }) };
    render(<SettingsPage />);

    fireEvent.change(screen.getByPlaceholderText(/describe what your business does/i), { target: { value: 'manually edited description' } });
    const patch = await clickSave();

    expect(patch.business_description).toBe('manually edited description');
    expect(patch).not.toHaveProperty('instructions');
  });
});

describe('BD8 — SettingsPage canonical ownership: "Generate with AI" also writes top-level only', () => {
  it('generate -> dirty top-level business_description -> save -> top-level write, no instructions key', async () => {
    dataHolder.data = { settings: baseSettings({ business_description: 'old description' }) };
    render(<SettingsPage />);

    fireEvent.click(screen.getByRole('button', { name: /generate with ai/i }));
    await waitFor(() => expect(screen.getByDisplayValue('generated')).toBeInTheDocument());

    const patch = await clickSave();

    expect(patch.business_description).toBe('generated');
    expect(patch).not.toHaveProperty('instructions');
    expect(Object.keys(patch)).toEqual(['business_description']);
  });
});
