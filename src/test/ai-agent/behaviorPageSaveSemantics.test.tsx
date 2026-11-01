/**
 * Phase 2 — Fix 4 (mode silent downgrade) + Fix 5 (instructions.tone
 * overwrite) stabilization, extended in Phase 2.1 to make EVERY Behavior
 * field genuinely dirty-tracked (unsure/style/language, not just mode/tone).
 * Since then the AI mode is set on the Activation page only: Behavior shows
 * it read-only and never writes `enabled` or `mode`.
 * Renders the real BehaviorPage component and asserts on the actual
 * save-mutation payload, proving the fix at the UI boundary rather than
 * re-testing the pure derive*() helpers in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', slug: 'acme', default_locale: 'en' }, notFound: false }),
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, dir: 'ltr' }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// dataHolder.data must be a REFERENTIALLY STABLE object across re-renders
// within a single test: BehaviorPage has a useEffect keyed on [data] that
// re-derives (and resets dirty flags for) unsure/style/tone/lang from
// data.settings. If the mocked hook returned a brand-new object literal on
// every call, that effect would see a "changed" dependency on every
// re-render (including the one triggered by a simulated radio click) and
// immediately reset the dirty state, silently discarding the click before
// Save could observe it. Each test reassigns dataHolder.data to a fresh
// object BEFORE render(), which is fine — it's only re-renders *within* a
// mounted test that must be stable.
type Patch = Record<string, unknown> & { instructions?: Record<string, unknown> };
const dataHolder: { data: { settings: Record<string, unknown> | null } } = { data: { settings: null } };
const mutateAsync = vi.fn(async (patch: Patch) => ({ settings: { ...dataHolder.data.settings, ...patch } }));

vi.mock('@/hooks/useAiAgent', () => ({
  useAiAgentSettings: () => ({ data: dataHolder.data, isLoading: false }),
  useUpdateAiAgentSettings: () => ({ mutateAsync, isPending: false }),
}));

const BehaviorPage = (await import('@/pages/app/ai-agent/BehaviorPage')).default;

/** The page links to Activation, so it renders inside a router, as in the app. */
function renderPage() {
  return render(<BehaviorPage />, { wrapper: MemoryRouter });
}

function baseSettings(overrides: Record<string, unknown> = {}) {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    enabled: true,
    mode: 'auto_reply_always',
    instructions: { tone: 'friendly', max_answer_length: 'medium' },
    allow_clarifying_questions: true,
    handoff_on_low_confidence: false,
    fallback_behavior: 'handoff',
    allowed_locales: [],
    ...overrides,
  };
}

beforeEach(() => {
  mutateAsync.mockClear();
});

async function clickSave(): Promise<Patch> {
  fireEvent.click(screen.getByRole('button', { name: /save behavior/i }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  return mutateAsync.mock.calls[0][0];
}

/** Every control Behavior still has, each moved off its loaded value. */
function changeEveryControl() {
  fireEvent.click(screen.getByRole('radio', { name: 'Transfer to operator' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Formal' }));
  fireEvent.click(screen.getByRole('radio', { name: 'Always use workspace default language' }));
}

describe('Fix 4 — BehaviorPage mode silent downgrade', () => {
  it('existing auto_reply_always + change answer length + save -> mode/enabled are NOT sent (preserved)', async () => {
    dataHolder.data = { settings: baseSettings({ mode: 'auto_reply_always' }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }));
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('mode');
    expect(patch).not.toHaveProperty('enabled');
  });

  it('existing auto_reply_when_offline + change tone + save -> mode/enabled are NOT sent (preserved)', async () => {
    dataHolder.data = { settings: baseSettings({ mode: 'auto_reply_when_offline' }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Formal' }));
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('mode');
    expect(patch).not.toHaveProperty('enabled');
  });

  // The AI mode radio (auto / suggest / off) is gone: it could not express
  // the five modes, rewrote e.g. auto_reply_always as
  // auto_reply_until_human_joins, and skipped Activation's readiness
  // checklist. Activation owns `enabled` and `mode`; Behavior shows the mode
  // and links there.
  it('has no AI mode control: it shows the current mode, links to Activation, and a save sends neither enabled nor mode', async () => {
    dataHolder.data = { settings: baseSettings({ mode: 'auto_reply_always' }) };
    renderPage();

    for (const name of ['Answer visitors automatically', 'Suggest replies to operators only', 'Off']) {
      expect(screen.queryByRole('radio', { name })).not.toBeInTheDocument();
    }
    // Activation's own name for the mode (aiAgent.activation.mode*).
    expect(screen.getByText('aiAgent.activation.modeAutoAlways')).toBeInTheDocument();
    const link = screen.getByRole('link', { name: /aiAgent\.menu\.tabActivation/ });
    expect(link).toHaveAttribute('href', '/acme/ai-agent/activation');

    changeEveryControl();
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('enabled');
    expect(patch).not.toHaveProperty('mode');
  });

  it('a switched-off AI reads as disabled whatever its mode, and a save still sends neither enabled nor mode', async () => {
    dataHolder.data = { settings: baseSettings({ enabled: false, mode: 'auto_reply_until_human_joins' }) };
    renderPage();

    expect(screen.getByText('aiAgent.activation.disabled')).toBeInTheDocument();
    expect(screen.queryByText('aiAgent.activation.modeAutoUntilHuman')).not.toBeInTheDocument();

    changeEveryControl();
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('enabled');
    expect(patch).not.toHaveProperty('mode');
  });
});

describe('Fix 5 — BehaviorPage instructions.tone overwrite', () => {
  it('a custom (non-preset) tone survives an unrelated Behavior save unchanged (instructions omitted entirely)', async () => {
    dataHolder.data = { settings: baseSettings({ instructions: { tone: 'warm and playfully sarcastic', max_answer_length: 'medium' } }) };
    renderPage();

    // Change an unrelated field (the "unsure" / clarify-vs-transfer control).
    fireEvent.click(screen.getByRole('radio', { name: 'Transfer to operator' }));
    const patch = await clickSave();

    // PHASE 2.1 FIX: neither style nor tone was touched, so instructions is
    // not sent at all -- the backend leaves the whole existing instructions
    // object (including the custom tone) untouched rather than relying on a
    // client-side spread to "preserve" it.
    expect(patch).not.toHaveProperty('instructions');
  });

  it('explicitly choosing the "professional" preset does overwrite tone', async () => {
    dataHolder.data = { settings: baseSettings({ instructions: { tone: 'warm and playfully sarcastic', max_answer_length: 'medium' } }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Professional' }));
    const patch = await clickSave();

    expect(patch.instructions?.tone).toBe('professional');
  });

  it('an explicit style change sends instructions.max_answer_length while preserving the existing tone', async () => {
    dataHolder.data = { settings: baseSettings({ instructions: { tone: 'warm and playfully sarcastic', max_answer_length: 'medium' } }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
    const patch = await clickSave();

    expect(patch.instructions?.max_answer_length).toBe('short');
    expect(patch.instructions?.tone).toBe('warm and playfully sarcastic');
  });
});

describe('Fix 2.1 — allowed_locales silent-write (PHASE 2.1 FIX)', () => {
  it('existing allowed_locales=["fa","ar"] + edit answer style + save -> allowed_locales is NOT sent', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: ['fa', 'ar'] }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }));
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('allowed_locales');
  });

  it('an explicit language change still sends the intended allowed_locales', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: [] }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Always use workspace default language' }));
    const patch = await clickSave();

    expect(patch.allowed_locales).toEqual(['en']);
  });
});

describe('Fix 2.1 — "when AI is unsure" silent-write (PHASE 2.1 FIX)', () => {
  it('existing non-default unsure state + edit language + save -> the 3 unsure-derived fields are NOT sent', async () => {
    dataHolder.data = { settings: baseSettings({
      allow_clarifying_questions: false,
      handoff_on_low_confidence: true,
      fallback_behavior: 'handoff',
    }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Always use workspace default language' }));
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('allow_clarifying_questions');
    expect(patch).not.toHaveProperty('handoff_on_low_confidence');
    expect(patch).not.toHaveProperty('fallback_behavior');
  });

  it('existing non-default unsure state + edit answer style + save -> the 3 unsure-derived fields are NOT sent', async () => {
    dataHolder.data = { settings: baseSettings({
      allow_clarifying_questions: false,
      handoff_on_low_confidence: false,
      fallback_behavior: 'silent',
    }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('allow_clarifying_questions');
    expect(patch).not.toHaveProperty('handoff_on_low_confidence');
    expect(patch).not.toHaveProperty('fallback_behavior');
  });

  it('an explicit unsure change still sends the intended 3 fields', async () => {
    dataHolder.data = { settings: baseSettings({
      allow_clarifying_questions: true,
      handoff_on_low_confidence: false,
      fallback_behavior: 'handoff',
    }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Do not answer' }));
    const patch = await clickSave();

    expect(patch.allow_clarifying_questions).toBe(false);
    expect(patch.handoff_on_low_confidence).toBe(false);
    expect(patch.fallback_behavior).toBe('silent');
  });
});

describe('Fix 2.1 — minimal PATCH producer (saving one field does not resend unrelated fields)', () => {
  it('changing only answer style sends nothing but instructions', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: ['fa', 'ar'] }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
    const patch = await clickSave();

    expect(Object.keys(patch).sort()).toEqual(['instructions']);
    expect(patch.instructions?.max_answer_length).toBe('short');
  });

  it('changing every control sends exactly their fields, never enabled or mode', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: [] }) };
    renderPage();

    changeEveryControl();
    const patch = await clickSave();

    expect(Object.keys(patch).sort()).toEqual([
      'allow_clarifying_questions',
      'allowed_locales',
      'fallback_behavior',
      'handoff_on_low_confidence',
      'instructions',
    ]);
    expect(patch).not.toHaveProperty('enabled');
    expect(patch).not.toHaveProperty('mode');
  });

  it('changing only the language sends nothing but allowed_locales', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: [] }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Always use workspace default language' }));
    const patch = await clickSave();

    expect(Object.keys(patch).sort()).toEqual(['allowed_locales']);
  });

  it('changing only the unsure control sends nothing but its 3 derived fields', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: ['fa', 'ar'] }) };
    renderPage();

    fireEvent.click(screen.getByRole('radio', { name: 'Transfer to operator' }));
    const patch = await clickSave();

    expect(Object.keys(patch).sort()).toEqual([
      'allow_clarifying_questions',
      'fallback_behavior',
      'handoff_on_low_confidence',
    ]);
  });

  it('saving with no changes at all sends an empty patch', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: ['fa', 'ar'] }) };
    renderPage();

    const patch = await clickSave();

    expect(patch).toEqual({});
  });
});
