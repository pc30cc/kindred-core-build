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

  it('keeps no_answer, low_confidence and business_hours selectable but labels them truthfully as not live yet', async () => {
    const dialog = await openNewRuleDialog();
    const triggerSelects = within(dialog).getAllByRole('combobox');
    fireEvent.click(triggerSelects[0]);
    const listbox = await screen.findByRole('listbox');
    const noAnswer = within(listbox).getByText(/AI cannot answer.*not live yet/i);
    const lowConfidence = within(listbox).getByText(/AI confidence is low.*not live yet/i);
    const businessHours = within(listbox).getByText(/Outside business hours.*not live yet/i);
    expect(noAnswer.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
    expect(lowConfidence.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
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

describe('RoutingPage — default rule seed (Follow-up 9C)', () => {
  it('no longer suggests the dead no_answer trigger; seeds exactly the remaining defaults', async () => {
    render(<RoutingPage />);
    fireEvent.click(await screen.findByRole('button', { name: /add default rules/i }));
    await waitFor(() => expect(createRouting).toHaveBeenCalledTimes(3));
    const triggerTypes = createRouting.mock.calls.map((c) => c[0].trigger_type);
    expect(triggerTypes).not.toContain('no_answer');
    expect(triggerTypes).toEqual(['human_request', 'topic_detected', 'topic_detected']);
  });
});
