/**
 * Phase 2 — Fix 4 (mode silent downgrade) + Fix 5 (instructions.tone
 * overwrite) stabilization, extended in Phase 2.1 to make EVERY Behavior
 * field genuinely dirty-tracked (unsure/style/language, not just mode/tone).
 * Renders the real BehaviorPage component and asserts on the actual
 * save-mutation payload, proving the fix at the UI boundary rather than
 * re-testing the pure derive*() helpers in isolation.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: { id: 'ws-1', default_locale: 'en' }, notFound: false }),
}));
vi.mock('@/i18n', () => ({ useTranslation: () => ({ t: (k: string) => k, dir: 'ltr' }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

// dataHolder.data must be a REFERENTIALLY STABLE object across re-renders
// within a single test: BehaviorPage has a useEffect keyed on [data] that
// re-derives (and resets dirty flags for) aiMode/unsure/style/tone/lang from
// data.settings. If the mocked hook returned a brand-new object literal on
// every call, that effect would see a "changed" dependency on every
// re-render (including the one triggered by a simulated radio click) and
// immediately reset the dirty state, silently discarding the click before
// Save could observe it. Each test reassigns dataHolder.data to a fresh
// object BEFORE render(), which is fine — it's only re-renders *within* a
// mounted test that must be stable.
const dataHolder: { data: { settings: any } } = { data: { settings: null } };
const mutateAsync = vi.fn(async (patch: any) => ({ settings: { ...dataHolder.data.settings, ...patch } }));

vi.mock('@/hooks/useAiAgent', () => ({
  useAiAgentSettings: () => ({ data: dataHolder.data, isLoading: false }),
  useUpdateAiAgentSettings: () => ({ mutateAsync, isPending: false }),
}));

const BehaviorPage = (await import('@/pages/app/ai-agent/BehaviorPage')).default;

function baseSettings(overrides: Record<string, any> = {}) {
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

async function clickSave() {
  fireEvent.click(screen.getByRole('button', { name: /save behavior/i }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  return mutateAsync.mock.calls[0][0];
}

describe('Fix 4 — BehaviorPage mode silent downgrade', () => {
  it('existing auto_reply_always + change answer length + save -> mode/enabled are NOT sent (preserved)', async () => {
    dataHolder.data = { settings: baseSettings({ mode: 'auto_reply_always' }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }));
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('mode');
    expect(patch).not.toHaveProperty('enabled');
  });

  it('existing auto_reply_when_offline + change tone + save -> mode/enabled are NOT sent (preserved)', async () => {
    dataHolder.data = { settings: baseSettings({ mode: 'auto_reply_when_offline' }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Formal' }));
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('mode');
    expect(patch).not.toHaveProperty('enabled');
  });

  it('an explicit mode change still writes the intended new mode', async () => {
    dataHolder.data = { settings: baseSettings({ mode: 'auto_reply_always' }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Suggest replies to operators only' }));
    const patch = await clickSave();

    expect(patch.mode).toBe('suggest_only');
    expect(patch.enabled).toBe(true);
  });

  it('an explicit mode change to "off" writes enabled=false, mode=off', async () => {
    dataHolder.data = { settings: baseSettings({ mode: 'auto_reply_until_human_joins' }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    const patch = await clickSave();

    expect(patch.mode).toBe('off');
    expect(patch.enabled).toBe(false);
  });
});

describe('Fix 5 — BehaviorPage instructions.tone overwrite', () => {
  it('a custom (non-preset) tone survives an unrelated Behavior save unchanged (instructions omitted entirely)', async () => {
    dataHolder.data = { settings: baseSettings({ instructions: { tone: 'warm and playfully sarcastic', max_answer_length: 'medium' } }) };
    render(<BehaviorPage />);

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
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Professional' }));
    const patch = await clickSave();

    expect((patch.instructions as any).tone).toBe('professional');
  });

  it('an explicit style change sends instructions.max_answer_length while preserving the existing tone', async () => {
    dataHolder.data = { settings: baseSettings({ instructions: { tone: 'warm and playfully sarcastic', max_answer_length: 'medium' } }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
    const patch = await clickSave();

    expect((patch.instructions as any).max_answer_length).toBe('short');
    expect((patch.instructions as any).tone).toBe('warm and playfully sarcastic');
  });
});

describe('Fix 2.1 — allowed_locales silent-write (PHASE 2.1 FIX)', () => {
  it('existing allowed_locales=["fa","ar"] + edit answer style + save -> allowed_locales is NOT sent', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: ['fa', 'ar'] }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Detailed' }));
    const patch = await clickSave();

    expect(patch).not.toHaveProperty('allowed_locales');
  });

  it('an explicit language change still sends the intended allowed_locales', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: [] }) };
    render(<BehaviorPage />);

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
    render(<BehaviorPage />);

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
    render(<BehaviorPage />);

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
    render(<BehaviorPage />);

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
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
    const patch = await clickSave();

    expect(Object.keys(patch).sort()).toEqual(['instructions']);
    expect((patch.instructions as any).max_answer_length).toBe('short');
  });

  it('changing only the AI mode sends nothing but mode/enabled', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: ['fa', 'ar'] }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Off' }));
    const patch = await clickSave();

    expect(Object.keys(patch).sort()).toEqual(['enabled', 'mode']);
  });

  it('changing only the language sends nothing but allowed_locales', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: [] }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Always use workspace default language' }));
    const patch = await clickSave();

    expect(Object.keys(patch).sort()).toEqual(['allowed_locales']);
  });

  it('changing only the unsure control sends nothing but its 3 derived fields', async () => {
    dataHolder.data = { settings: baseSettings({ allowed_locales: ['fa', 'ar'] }) };
    render(<BehaviorPage />);

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
    render(<BehaviorPage />);

    const patch = await clickSave();

    expect(patch).toEqual({});
  });
});
