/**
 * Follow-up 9C — Routing capability truthfulness.
 *
 * Renders the real RoutingPage component and asserts on what the NEW-rule
 * trigger/action pickers actually offer, that a legacy persisted rule using
 * a since-removed trigger type still renders its label without corruption,
 * and that the client-generated default rules no longer suggest a
 * trigger_type that can never fire in the live engine (Follow-up 9B).
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => ({ id: 'ws-1' }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const listRouting = vi.fn();
const createRouting = vi.fn();
const updateRouting = vi.fn();
const deleteRouting = vi.fn();

vi.mock('@/lib/ai-agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-agent-api')>();
  return {
    ...actual,
    aiAgentApi: {
      ...(actual as any).aiAgentApi,
      listRouting: (...a: unknown[]) => listRouting(...a),
      createRouting: (...a: unknown[]) => createRouting(...a),
      updateRouting: (...a: unknown[]) => updateRouting(...a),
      deleteRouting: (...a: unknown[]) => deleteRouting(...a),
    },
  };
});

// Radix Select needs these DOM APIs, which jsdom does not implement.
beforeAll(() => {
  window.HTMLElement.prototype.hasPointerCapture = window.HTMLElement.prototype.hasPointerCapture || (() => false);
  window.HTMLElement.prototype.releasePointerCapture = window.HTMLElement.prototype.releasePointerCapture || (() => {});
  window.HTMLElement.prototype.scrollIntoView = window.HTMLElement.prototype.scrollIntoView || (() => {});
  (global as any).ResizeObserver = (global as any).ResizeObserver || class {
    observe() {} unobserve() {} disconnect() {}
  };
});

const RoutingPage = (await import('@/pages/app/ai-agent/RoutingPage')).default;

function legacyRule(overrides: Record<string, any> = {}) {
  return {
    id: 'r-legacy', workspace_id: 'ws-1', name: 'Old plan-limit rule', description: null,
    trigger_type: 'plan_limit', conditions_json: {}, action_type: 'handoff', action_json: {},
    priority: 100, enabled: true, created_at: '', updated_at: '',
    ...overrides,
  };
}

// Locates the row card for a rule by its name, then returns [pencil, trash]
// buttons (the Switch has role="switch", not "button", so index 0 is pencil).
function rowButtons(cardText: string) {
  return screen.findByText(cardText).then((el) => {
    const card = el.closest('div.p-4') as HTMLElement;
    return within(card).getAllByRole('button');
  });
}

beforeEach(() => {
  listRouting.mockReset(); createRouting.mockReset(); updateRouting.mockReset(); deleteRouting.mockReset();
  listRouting.mockResolvedValue({ items: [] });
  createRouting.mockResolvedValue({ item: {} });
});

async function openNewRuleDialog() {
  render(<RoutingPage />);
  fireEvent.click(await screen.findByRole('button', { name: /add rule/i }));
  return screen.findByRole('dialog');
}

describe('RoutingPage — NEW rule trigger picker (Follow-up 9C)', () => {
  it('does not offer plan_limit or vip_customer for a new rule', async () => {
    const dialog = await openNewRuleDialog();
    const triggerSelects = within(dialog).getAllByRole('combobox');
    fireEvent.click(triggerSelects[0]); // "When (trigger)" select
    const listbox = await screen.findByRole('listbox');
    expect(within(listbox).queryByText(/AI plan limit reached/i)).toBeNull();
    expect(within(listbox).queryByText(/VIP customer/i)).toBeNull();
  });

  // Follow-up 9E.3 — no_answer/low_confidence are now genuinely wired
  // (post-strategy Routing), so the "not live yet" label must be gone and
  // both must render as plain, enabled options, same as business_hours.
  it('shows no_answer and low_confidence as plain, enabled, truthful options — no "not live yet" label, since both are now wired', async () => {
    const dialog = await openNewRuleDialog();
    const triggerSelects = within(dialog).getAllByRole('combobox');
    fireEvent.click(triggerSelects[0]);
    const listbox = await screen.findByRole('listbox');
    const noAnswer = within(listbox).getByText('AI cannot answer');
    const lowConfidence = within(listbox).getByText('AI confidence is low');
    expect(noAnswer.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
    expect(lowConfidence.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
  });

  // TEST BHT1 (Follow-up 9C.1) — business_hours was wired into the real
  // runtime by Follow-up 9C (availability.reason === 'outside_hours' or
  // 'override_closed'), so the "not live yet" label is now false and must
  // not appear. This must FAIL against the 9C HEAD, which still marks
  // business_hours `unavailable: true`.
  it('shows business_hours as a plain, enabled, truthful option — no "not live yet" label, since it is now wired', async () => {
    const dialog = await openNewRuleDialog();
    const triggerSelects = within(dialog).getAllByRole('combobox');
    fireEvent.click(triggerSelects[0]);
    const listbox = await screen.findByRole('listbox');
    // Exact match — fails if the label carries any "— not live yet" suffix.
    const businessHours = within(listbox).getByText('Outside business hours');
    expect(businessHours.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
  });

  it('disables the planned-only actions (assign_team, assign_operator, create_ticket) and labels them coming soon', async () => {
    const dialog = await openNewRuleDialog();
    const selects = within(dialog).getAllByRole('combobox');
    fireEvent.click(selects[1]); // action select
    const listbox = await screen.findByRole('listbox');
    const assignTeam = within(listbox).getByText(/Assign to a team.*coming soon/i);
    expect(assignTeam.closest('[role="option"]')).toHaveAttribute('data-disabled');
    const assignOperator = within(listbox).getByText(/Assign to a specific operator.*coming soon/i);
    expect(assignOperator.closest('[role="option"]')).toHaveAttribute('data-disabled');
    const createTicket = within(listbox).getByText(/Create a ticket.*coming soon/i);
    expect(createTicket.closest('[role="option"]')).toHaveAttribute('data-disabled');
    // handoff/keep_ai/mark_priority remain enabled.
    const handoff = within(listbox).getByText(/Hand off to a human/i);
    expect(handoff.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
  });
});

describe('RoutingPage — legacy persisted rule rendering (Follow-up 9C)', () => {
  it('a persisted plan_limit rule still renders a readable label in the rule list', async () => {
    listRouting.mockResolvedValue({ items: [legacyRule()] });
    render(<RoutingPage />);
    expect(await screen.findByText(/When: AI plan limit reached/i)).toBeTruthy();
  });

  it('editing a persisted plan_limit rule keeps it selected/renderable in the trigger picker without corrupting it', async () => {
    listRouting.mockResolvedValue({ items: [legacyRule()] });
    render(<RoutingPage />);
    // Open the row's edit (pencil) button — locate via the card containing the
    // rule name. The Switch has role="switch", not "button", so the pencil
    // (edit) button is the first role="button" match, trash the second.
    const card = (await screen.findByText('Old plan-limit rule')).closest('div.p-4') as HTMLElement;
    const pencil = within(card!).getAllByRole('button')[0];
    fireEvent.click(pencil);
    const dialog = await screen.findByRole('dialog');
    // The trigger combobox displays the current (legacy) value's label, not the raw enum.
    expect(within(dialog).getByText(/AI plan limit reached/i)).toBeTruthy();
  });
});

describe('RoutingPage — default rule seed (Follow-up 9C.1)', () => {
  // TEST DEF1 — a starter/default rule must never use an action the picker
  // itself marks "coming soon" (planned-only), nor a trigger type hidden
  // from new-rule creation as conclusively dead. Must FAIL against the 9C
  // HEAD, which still seeds two topic_detected -> assign_team defaults.
  it('creates no defaults using planned-only actions or dead trigger types', async () => {
    render(<RoutingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add default rules/i }));
    // seed() awaits every createRouting call sequentially, then calls
    // refresh() (a second listRouting call) — waiting on that is the
    // reliable "all creates have settled" signal; waiting on createRouting
    // alone races with the in-flight loop and can observe a partial result.
    await waitFor(() => expect(listRouting).toHaveBeenCalledTimes(2));
    const actionTypes = createRouting.mock.calls.map((c) => c[0].action_type);
    const triggerTypes = createRouting.mock.calls.map((c) => c[0].trigger_type);
    expect(actionTypes).not.toContain('assign_team');
    expect(actionTypes).not.toContain('assign_operator');
    expect(actionTypes).not.toContain('create_ticket');
    expect(triggerTypes).not.toContain('plan_limit');
    expect(triggerTypes).not.toContain('vip_customer');
    expect(triggerTypes).not.toContain('no_answer');
    expect(triggerTypes).not.toContain('low_confidence');
  });

  // TEST DEF2 — pin the exact expected surviving default. The two
  // topic_detected -> assign_team rules are removed outright (not
  // replaced with a different live action, per the narrow-fix
  // instruction), leaving only the genuinely executable
  // human_request -> handoff default.
  it('seeds exactly one default: human_request -> handoff', async () => {
    render(<RoutingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add default rules/i }));
    // Same reliable completion signal as DEF1 — waiting on createRouting's
    // call count directly races the in-flight sequential loop.
    await waitFor(() => expect(listRouting).toHaveBeenCalledTimes(2));
    expect(createRouting).toHaveBeenCalledTimes(1);
    expect(createRouting.mock.calls[0][0].trigger_type).toBe('human_request');
    expect(createRouting.mock.calls[0][0].action_type).toBe('handoff');
  });
});

describe('RoutingPage — legacy persisted vip_customer rule rendering (Follow-up 9C.1)', () => {
  it('a persisted vip_customer rule still renders a readable label in the rule list', async () => {
    listRouting.mockResolvedValue({ items: [legacyRule({ id: 'r-vip', name: 'Old VIP rule', trigger_type: 'vip_customer' })] });
    render(<RoutingPage />);
    expect(await screen.findByText(/When: VIP customer/i)).toBeTruthy();
  });

  it('editing a persisted vip_customer rule keeps it selected/renderable in the trigger picker without corrupting it', async () => {
    listRouting.mockResolvedValue({ items: [legacyRule({ id: 'r-vip', name: 'Old VIP rule', trigger_type: 'vip_customer' })] });
    render(<RoutingPage />);
    const buttons = await rowButtons('Old VIP rule');
    fireEvent.click(buttons[0]);
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/VIP customer/i)).toBeTruthy();
  });
});

function legacyLowConfidenceRule(overrides: Record<string, any> = {}) {
  return {
    id: 'r-lc', workspace_id: 'ws-1', name: 'Old low-confidence rule', description: null,
    trigger_type: 'low_confidence', conditions_json: { threshold: 0.55, consecutive: 2 },
    action_type: 'handoff', action_json: { target: 'main_inbox' },
    priority: 100, enabled: true, created_at: '', updated_at: '',
    ...overrides,
  };
}

async function openEditDialog(ruleName: string) {
  const buttons = await rowButtons(ruleName);
  fireEvent.click(buttons[0]);
  return screen.findByRole('dialog');
}

async function selectTriggerOption(dialog: HTMLElement, label: string | RegExp) {
  const triggerSelects = within(dialog).getAllByRole('combobox');
  fireEvent.click(triggerSelects[0]);
  const listbox = await screen.findByRole('listbox');
  fireEvent.click(within(listbox).getByText(label));
}

async function selectActionOption(dialog: HTMLElement, label: string | RegExp) {
  const selects = within(dialog).getAllByRole('combobox');
  fireEvent.click(selects[1]);
  const listbox = await screen.findByRole('listbox');
  fireEvent.click(within(listbox).getByText(label));
}

describe('RoutingPage — low_confidence/no_answer live UI (Follow-up 9E.3)', () => {
  it('low_confidence shows a required numeric confidence_below input defaulting to 0.5 for a new rule', async () => {
    const dialog = await openNewRuleDialog();
    await selectTriggerOption(dialog, 'AI confidence is low');
    const input = within(dialog).getByLabelText(/Confidence threshold/i) as HTMLInputElement;
    expect(input.value).toBe('0.5');
    expect(input).toHaveAttribute('type', 'number');
    expect(input).toBeRequired();
  });

  it('no_answer disables keep_ai as not applicable, while handoff and mark_priority stay enabled', async () => {
    const dialog = await openNewRuleDialog();
    await selectTriggerOption(dialog, 'AI cannot answer');
    const selects = within(dialog).getAllByRole('combobox');
    fireEvent.click(selects[1]);
    const listbox = await screen.findByRole('listbox');
    const keepAi = within(listbox).getByText(/Keep the AI handling it.*not applicable/i);
    expect(keepAi.closest('[role="option"]')).toHaveAttribute('data-disabled');
    const handoff = within(listbox).getByText(/Hand off to a human/i);
    expect(handoff.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
    const markPriority = within(listbox).getByText(/Mark as priority/i);
    expect(markPriority.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
  });

  it('switching the trigger to no_answer while keep_ai is selected resets the action back to handoff', async () => {
    const dialog = await openNewRuleDialog();
    await selectActionOption(dialog, 'Keep the AI handling it');
    await selectTriggerOption(dialog, 'AI cannot answer');
    expect(within(dialog).getByText(/Hand off to a human/i)).toBeTruthy();
  });

  it('shows the keep_ai strict-KB caveat note when keep_ai is selected', async () => {
    const dialog = await openNewRuleDialog();
    await selectActionOption(dialog, 'Keep the AI handling it');
    expect(within(dialog).getByText(/no effect when "Answer only from knowledge base"/i)).toBeTruthy();
  });
});

describe('RoutingPage — legacy round-trip contract (Follow-up 9E.3)', () => {
  it('LEG4 — legacy no_answer{max_attempts:2} rule changed to low_confidence saves ONLY the canonical {confidence_below:0.5}, not the old field', async () => {
    listRouting.mockResolvedValue({
      items: [{
        id: 'r-na', workspace_id: 'ws-1', name: 'Old no-answer rule', description: null,
        trigger_type: 'no_answer', conditions_json: { max_attempts: 2 },
        action_type: 'handoff', action_json: { target: 'main_inbox' },
        priority: 100, enabled: true, created_at: '', updated_at: '',
      }],
    });
    updateRouting.mockResolvedValue({ item: {} });
    render(<RoutingPage />);
    const dialog = await openEditDialog('Old no-answer rule');
    await selectTriggerOption(dialog, 'AI confidence is low');
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateRouting).toHaveBeenCalledTimes(1));
    expect(updateRouting.mock.calls[0][1].conditions_json).toEqual({ confidence_below: 0.5 });
  });

  it('LEG5 — legacy low_confidence{threshold,consecutive} rule changed to no_answer saves an empty conditions_json', async () => {
    listRouting.mockResolvedValue({ items: [legacyLowConfidenceRule()] });
    updateRouting.mockResolvedValue({ item: {} });
    render(<RoutingPage />);
    const dialog = await openEditDialog('Old low-confidence rule');
    await selectTriggerOption(dialog, 'AI cannot answer');
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateRouting).toHaveBeenCalledTimes(1));
    expect(updateRouting.mock.calls[0][1].conditions_json).toEqual({});
  });

  it('an unrelated edit (name only) on a legacy low_confidence{threshold,consecutive} row preserves conditions_json byte-for-byte, including the dormant legacy keys', async () => {
    listRouting.mockResolvedValue({ items: [legacyLowConfidenceRule()] });
    updateRouting.mockResolvedValue({ item: {} });
    render(<RoutingPage />);
    const dialog = await openEditDialog('Old low-confidence rule');
    const nameInput = within(dialog).getByDisplayValue('Old low-confidence rule') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Renamed low-confidence rule' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateRouting).toHaveBeenCalledTimes(1));
    expect(updateRouting.mock.calls[0][1].conditions_json).toEqual({ threshold: 0.55, consecutive: 2 });
    expect(updateRouting.mock.calls[0][1].name).toBe('Renamed low-confidence rule');
  });

  it('shows an inline legacy-conversion acknowledgment for a legacy low_confidence row, and does NOT convert unless the confidence field is explicitly edited', async () => {
    listRouting.mockResolvedValue({ items: [legacyLowConfidenceRule()] });
    updateRouting.mockResolvedValue({ item: {} });
    render(<RoutingPage />);
    const dialog = await openEditDialog('Old low-confidence rule');
    expect(within(dialog).getByText(/older condition format that never took effect/i)).toBeTruthy();
    // Saving without touching the confidence field must NOT convert.
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateRouting).toHaveBeenCalledTimes(1));
    expect(updateRouting.mock.calls[0][1].conditions_json).toEqual({ threshold: 0.55, consecutive: 2 });
  });

  it('an explicit edit of the confidence_below field on a legacy low_confidence row converts it, dropping the legacy keys', async () => {
    listRouting.mockResolvedValue({ items: [legacyLowConfidenceRule()] });
    updateRouting.mockResolvedValue({ item: {} });
    render(<RoutingPage />);
    const dialog = await openEditDialog('Old low-confidence rule');
    const input = within(dialog).getByLabelText(/Confidence threshold/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: '0.3' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateRouting).toHaveBeenCalledTimes(1));
    expect(updateRouting.mock.calls[0][1].conditions_json).toEqual({ confidence_below: 0.3 });
  });

  it('changing action_type from mark_priority to handoff drops the old payload and initializes only the canonical handoff payload', async () => {
    listRouting.mockResolvedValue({
      items: [{
        id: 'r-mp', workspace_id: 'ws-1', name: 'Old mark-priority rule', description: null,
        trigger_type: 'human_request', conditions_json: {},
        action_type: 'mark_priority', action_json: { level: 'high' },
        priority: 100, enabled: true, created_at: '', updated_at: '',
      }],
    });
    updateRouting.mockResolvedValue({ item: {} });
    render(<RoutingPage />);
    const dialog = await openEditDialog('Old mark-priority rule');
    await selectActionOption(dialog, /Hand off to a human/i);
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateRouting).toHaveBeenCalledTimes(1));
    expect(updateRouting.mock.calls[0][1].action_json).toEqual({ target: 'main_inbox' });
  });
});

describe('RoutingPage — legacy persisted assign_team action rendering (Follow-up 9C.1)', () => {
  it('a persisted assign_team rule still renders a readable label in the rule list', async () => {
    listRouting.mockResolvedValue({
      items: [legacyRule({ id: 'r-team', name: 'Old team-assign rule', trigger_type: 'topic_detected', action_type: 'assign_team' })],
    });
    render(<RoutingPage />);
    expect(await screen.findByText(/Do: Assign to a team/i)).toBeTruthy();
  });

  it('editing a persisted assign_team rule keeps the action visibly selected/renderable, and saving unrelated fields does not silently change action_type', async () => {
    listRouting.mockResolvedValue({
      items: [legacyRule({ id: 'r-team', name: 'Old team-assign rule', trigger_type: 'topic_detected', action_type: 'assign_team', conditions_json: { topic: 'pricing' } })],
    });
    updateRouting.mockResolvedValue({ item: {} });
    render(<RoutingPage />);
    const buttons = await rowButtons('Old team-assign rule');
    fireEvent.click(buttons[0]);
    const dialog = await screen.findByRole('dialog');
    // Current action remains visibly selected/renderable, even though the
    // option is disabled for NEW selection.
    expect(within(dialog).getByText(/Assign to a team/i)).toBeTruthy();

    // Editing an unrelated field (name) and saving must not silently
    // change action_type away from the persisted 'assign_team' value.
    const nameInput = within(dialog).getByDisplayValue('Old team-assign rule') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Renamed team-assign rule' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateRouting).toHaveBeenCalledTimes(1));
    expect(updateRouting.mock.calls[0][1].action_type).toBe('assign_team');
    expect(updateRouting.mock.calls[0][1].name).toBe('Renamed team-assign rule');
  });
});
