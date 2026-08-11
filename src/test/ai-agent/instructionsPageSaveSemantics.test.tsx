/**
 * Follow-up to Phase 2.1 (BehaviorPage field-dirty PATCH) — InstructionsPage
 * had the same stale/full-form write risk: save() unconditionally rewrote
 * all 9 nested `instructions` keys on every click, using whatever `form.X`
 * happened to be at that moment (captured once at mount, keyed on
 * data.settings.id). Since the backend replaces the ENTIRE `instructions`
 * JSON column on write (no per-key server merge -- see
 * server/services/ai-agent/settings.ts::updateSettings), an edit made
 * elsewhere to a key this page also displays (e.g. `tone` or
 * `max_answer_length`, both owned by BehaviorPage) could be silently
 * reverted by an unrelated InstructionsPage save. Renders the real
 * InstructionsPage component and asserts on the actual save-mutation
 * payload, same convention as behaviorPageSaveSemantics.test.tsx.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => ({ id: 'ws-1' }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const dataHolder: { data: { settings: any } } = { data: { settings: null } };
const mutateAsync = vi.fn(async (patch: any) => ({ settings: { ...dataHolder.data.settings, ...patch } }));

vi.mock('@/hooks/useAiAgent', () => ({
  useAiAgentSettings: () => ({ data: dataHolder.data, isLoading: false }),
  useUpdateAiAgentSettings: () => ({ mutateAsync, isPending: false }),
}));

const InstructionsPage = (await import('@/pages/app/ai-agent/InstructionsPage')).default;

function baseInstructions(overrides: Record<string, any> = {}) {
  return {
    tone: 'warm and playfully sarcastic',
    max_answer_length: 'short', // owned exclusively by BehaviorPage -- InstructionsPage has no control for it
    business_description: 'A quirky widget shop.',
    brand_voice: 'Playful but precise.',
    do_list: ['Be concise', 'Cite sources'],
    dont_list: ['Never promise refunds'],
    pricing_instructions: 'Always link to the pricing page.',
    handoff_instructions: 'Hand off after 2 failed clarifications.',
    support_instructions: 'Ask for the account email first.',
    custom_system_instruction: 'Always sign off with "cheers".',
    ...overrides,
  };
}

function baseSettings(instructionsOverrides: Record<string, any> = {}) {
  return {
    id: 's1',
    workspace_id: 'ws-1',
    business_description: 'Top-level business description (Settings page).',
    instructions: baseInstructions(instructionsOverrides),
  };
}

beforeEach(() => {
  mutateAsync.mockClear();
});

async function clickSave() {
  fireEvent.click(screen.getByRole('button', { name: /save instructions/i }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  return mutateAsync.mock.calls[0][0].instructions;
}

async function clickSaveFullPatch() {
  fireEvent.click(screen.getByRole('button', { name: /save instructions/i }));
  await waitFor(() => expect(mutateAsync).toHaveBeenCalledTimes(1));
  return mutateAsync.mock.calls[0][0];
}

describe('InstructionsPage I1 — editing one field does not rewrite unrelated nested keys', () => {
  it('editing only custom_system_instruction preserves a concurrently-changed tone (fresh, not the stale value this page loaded)', async () => {
    // This is the actual stale-write scenario: `tone` is also owned by
    // BehaviorPage. Simulate that page saving a new tone WHILE this page
    // stays mounted with the operator mid-edit -- same settings row id, so
    // InstructionsPage's mount-effect (keyed on data.settings.id) does NOT
    // re-run and does NOT resync `form.tone`. A minimal-PATCH fix must still
    // preserve the fresh tone by reading `data.settings.instructions` (not
    // `form`) as the merge base at save time.
    dataHolder.data = { settings: baseSettings({ tone: 'warm and playfully sarcastic' }) };
    const { rerender } = render(<InstructionsPage />);

    dataHolder.data = { settings: baseSettings({ tone: 'CONCURRENTLY CHANGED BY BEHAVIOR PAGE' }) };
    rerender(<InstructionsPage />);

    fireEvent.change(
      screen.getByPlaceholderText(/free-form additional system instruction/i),
      { target: { value: 'New closing line: stay curious.' } },
    );
    const instructions = await clickSave();

    expect(instructions.custom_system_instruction).toBe('New closing line: stay curious.');
    // The concurrently-changed value must survive -- NOT the stale
    // 'warm and playfully sarcastic' this page's `form.tone` still holds.
    expect(instructions.tone).toBe('CONCURRENTLY CHANGED BY BEHAVIOR PAGE');
    expect(instructions.max_answer_length).toBe('short');
    expect(instructions.business_description).toBe('A quirky widget shop.');
    expect(instructions.brand_voice).toBe('Playful but precise.');
    expect(instructions.do_list).toEqual(['Be concise', 'Cite sources']);
    expect(instructions.dont_list).toEqual(['Never promise refunds']);
    expect(instructions.pricing_instructions).toBe('Always link to the pricing page.');
    expect(instructions.handoff_instructions).toBe('Hand off after 2 failed clarifications.');
    expect(instructions.support_instructions).toBe('Ask for the account email first.');
  });
});

describe('InstructionsPage I2 — an explicit tone edit writes the intended value', () => {
  it('editing tone writes the new value and preserves every other nested key', async () => {
    dataHolder.data = { settings: baseSettings({ tone: 'formal' }) };
    render(<InstructionsPage />);

    fireEvent.change(
      screen.getByPlaceholderText(/friendly, professional, concise/i),
      { target: { value: 'deadpan and dry' } },
    );
    const instructions = await clickSave();

    expect(instructions.tone).toBe('deadpan and dry');
    expect(instructions.max_answer_length).toBe('short');
    expect(instructions.business_description).toBe('A quirky widget shop.');
    expect(instructions.custom_system_instruction).toBe('Always sign off with "cheers".');
  });
});

describe('InstructionsPage I3 — an explicit do_list edit changes only that nested key', () => {
  it('editing "Always do" writes the parsed list and preserves a concurrently-changed tone', async () => {
    dataHolder.data = { settings: baseSettings({ tone: 'warm and playfully sarcastic' }) };
    const { rerender } = render(<InstructionsPage />);

    dataHolder.data = { settings: baseSettings({ tone: 'CONCURRENTLY CHANGED BY BEHAVIOR PAGE' }) };
    rerender(<InstructionsPage />);

    fireEvent.change(
      screen.getByPlaceholderText(/link to relevant help articles/i),
      { target: { value: 'Be concise\nAlways link the docs' } },
    );
    const instructions = await clickSave();

    expect(instructions.do_list).toEqual(['Be concise', 'Always link the docs']);
    expect(instructions.tone).toBe('CONCURRENTLY CHANGED BY BEHAVIOR PAGE');
    expect(instructions.max_answer_length).toBe('short');
    expect(instructions.dont_list).toEqual(['Never promise refunds']);
    expect(instructions.custom_system_instruction).toBe('Always sign off with "cheers".');
  });

  it('saving with no changes at all sends the fresh instructions object unchanged', async () => {
    dataHolder.data = { settings: baseSettings() };
    render(<InstructionsPage />);

    const instructions = await clickSave();

    expect(instructions).toEqual(baseInstructions());
  });
});

// ─────────────────────────────────────────────────────────────
// Follow-up 3 — business-description ownership consolidation.
// Canonical field: ai_agent_settings.business_description (top-level).
// Legacy field: ai_agent_settings.instructions.business_description
// (display-fallback only, never a write target from this page anymore).
// ─────────────────────────────────────────────────────────────

function businessDescriptionField() {
  return screen.getByPlaceholderText(/what does the company do\?/i) as HTMLTextAreaElement;
}

describe('BD1 — conflicting values: canonical top-level display wins', () => {
  it('shows the top-level business_description, not the conflicting nested legacy value', async () => {
    dataHolder.data = {
      settings: baseSettings({ business_description: 'Legacy conflicting description' }),
    };
    dataHolder.data.settings.business_description = 'Canonical company description';
    render(<InstructionsPage />);

    expect(businessDescriptionField().value).toBe('Canonical company description');
  });
});

describe('BD2 — an explicit InstructionsPage edit writes the canonical top-level field', () => {
  it('editing Business Description writes top-level business_description, not instructions.business_description', async () => {
    dataHolder.data = { settings: baseSettings() };
    render(<InstructionsPage />);

    fireEvent.change(businessDescriptionField(), { target: { value: 'New description' } });
    const patch = await clickSaveFullPatch();

    expect(patch.business_description).toBe('New description');
    expect(patch.instructions?.business_description).not.toBe('New description');
  });
});

describe('BD3 — a Business-Description-only save does not rewrite the nested instructions object', () => {
  it('editing only Business Description omits `instructions` from the PATCH entirely', async () => {
    dataHolder.data = { settings: baseSettings() };
    render(<InstructionsPage />);

    fireEvent.change(businessDescriptionField(), { target: { value: 'Only this changed' } });
    const patch = await clickSaveFullPatch();

    expect(patch).toHaveProperty('business_description', 'Only this changed');
    expect(patch).not.toHaveProperty('instructions');
  });
});

describe('BD4 — simultaneous Business Description + nested instruction edit', () => {
  it('writes top-level business_description AND a freshest instructions object with brand_voice updated, preserving the untouched nested legacy value', async () => {
    dataHolder.data = { settings: baseSettings({ brand_voice: 'Playful but precise.' }) };
    render(<InstructionsPage />);

    fireEvent.change(businessDescriptionField(), { target: { value: 'New canonical text' } });
    fireEvent.change(
      screen.getByPlaceholderText(/how should the assistant sound/i),
      { target: { value: 'Bold and confident.' } },
    );
    const patch = await clickSaveFullPatch();

    expect(patch.business_description).toBe('New canonical text');
    expect(patch.instructions.brand_voice).toBe('Bold and confident.');
    // The nested legacy key is preserved as-is (whatever was already
    // persisted) -- it must NOT be overwritten with the new canonical text.
    expect(patch.instructions.business_description).toBe('A quirky widget shop.');
  });
});

describe('BD5 — concurrent top-level change + unrelated InstructionsPage edit', () => {
  it('business_description is absent from the PATCH when only brand_voice was edited, even if fresh top-level data changed underneath', async () => {
    dataHolder.data = { settings: baseSettings({ brand_voice: 'Playful but precise.' }) };
    dataHolder.data.settings.business_description = 'Business Description A';
    const { rerender } = render(<InstructionsPage />);

    dataHolder.data = { settings: baseSettings({ brand_voice: 'Playful but precise.' }) };
    dataHolder.data.settings.business_description = 'Business Description B';
    rerender(<InstructionsPage />);

    fireEvent.change(
      screen.getByPlaceholderText(/how should the assistant sound/i),
      { target: { value: 'Deadpan and dry.' } },
    );
    const patch = await clickSaveFullPatch();

    expect(patch).not.toHaveProperty('business_description');
    expect(patch.instructions.brand_voice).toBe('Deadpan and dry.');
  });
});

describe('BD6 — legacy nested-only workspace: display fallback without automatic mutation', () => {
  it('displays the nested legacy value when top-level is null, but opening the page alone triggers no save', async () => {
    dataHolder.data = {
      settings: baseSettings({ business_description: 'Legacy only' }),
    };
    dataHolder.data.settings.business_description = null;
    render(<InstructionsPage />);

    expect(businessDescriptionField().value).toBe('Legacy only');
    expect(mutateAsync).not.toHaveBeenCalled();
  });
});
