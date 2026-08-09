/**
 * Phase 2 — Fix 4 (mode silent downgrade) + Fix 5 (instructions.tone
 * overwrite) stabilization. Renders the real BehaviorPage component and
 * asserts on the actual save-mutation payload, proving the fix at the UI
 * boundary rather than re-testing the pure derive*() helpers in isolation.
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
// re-derives (and resets dirty flags for) aiMode/tone from data.settings.
// If the mocked hook returned a brand-new object literal on every call, that
// effect would see a "changed" dependency on every re-render (including the
// one triggered by a simulated radio click) and immediately reset the dirty
// state, silently discarding the click before Save could observe it. Each
// test reassigns dataHolder.data to a fresh object BEFORE render(), which is
// fine — it's only re-renders *within* a mounted test that must be stable.
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
  it('a custom (non-preset) tone survives an unrelated Behavior save unchanged', async () => {
    dataHolder.data = { settings: baseSettings({ instructions: { tone: 'warm and playfully sarcastic', max_answer_length: 'medium' } }) };
    render(<BehaviorPage />);

    // Change an unrelated field (the "unsure" / clarify-vs-transfer control).
    fireEvent.click(screen.getByRole('radio', { name: 'Transfer to operator' }));
    const patch = await clickSave();

    expect((patch.instructions as any).tone).toBe('warm and playfully sarcastic');
  });

  it('explicitly choosing the "professional" preset does overwrite tone', async () => {
    dataHolder.data = { settings: baseSettings({ instructions: { tone: 'warm and playfully sarcastic', max_answer_length: 'medium' } }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Professional' }));
    const patch = await clickSave();

    expect((patch.instructions as any).tone).toBe('professional');
  });

  it('max_answer_length is still always sent (unaffected by the tone dirty-check)', async () => {
    dataHolder.data = { settings: baseSettings({ instructions: { tone: 'friendly', max_answer_length: 'medium' } }) };
    render(<BehaviorPage />);

    fireEvent.click(screen.getByRole('radio', { name: 'Short' }));
    const patch = await clickSave();

    expect((patch.instructions as any).max_answer_length).toBe('short');
  });
});
