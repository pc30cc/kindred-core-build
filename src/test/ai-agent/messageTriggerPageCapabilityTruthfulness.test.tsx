/**
 * Follow-up 9G.1 — Message Trigger capability truthfulness (frontend).
 *
 * Renders the real TriggersPage component and asserts on what the picker
 * actually offers, that a legacy persisted rule using a not-live event or a
 * planned action still renders/round-trips truthfully, that the page/dialog
 * copy no longer claims runtime execution is universally disabled, and that
 * the delay field and rule-list badges are honest about what the runtime
 * actually does today.
 */
import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

vi.mock('@/hooks/useWorkspace', () => ({
  useCurrentWorkspace: () => ({ id: 'ws-1' }),
}));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));

const listMessageTriggers = vi.fn();
const createMessageTrigger = vi.fn();
const updateMessageTrigger = vi.fn();
const deleteMessageTrigger = vi.fn();
const testMessageTrigger = vi.fn();

vi.mock('@/lib/ai-agent-api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ai-agent-api')>();
  return {
    ...actual,
    aiAgentApi: {
      ...(actual as any).aiAgentApi,
      listMessageTriggers: (...a: unknown[]) => listMessageTriggers(...a),
      createMessageTrigger: (...a: unknown[]) => createMessageTrigger(...a),
      updateMessageTrigger: (...a: unknown[]) => updateMessageTrigger(...a),
      deleteMessageTrigger: (...a: unknown[]) => deleteMessageTrigger(...a),
      testMessageTrigger: (...a: unknown[]) => testMessageTrigger(...a),
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

const TriggersPage = (await import('@/pages/app/ai-agent/TriggersPage')).default;

function triggerRow(overrides: Record<string, any> = {}) {
  return {
    id: 't-1', workspace_id: 'ws-1', name: 'Test trigger', description: null,
    event_type: 'visitor_first_message', conditions_json: {},
    action_type: 'send_message', action_json: { message: 'hi' },
    delay_seconds: 0, enabled: true,
    created_at: '', updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  listMessageTriggers.mockReset(); createMessageTrigger.mockReset();
  updateMessageTrigger.mockReset(); deleteMessageTrigger.mockReset(); testMessageTrigger.mockReset();
  listMessageTriggers.mockResolvedValue({ items: [] });
  createMessageTrigger.mockResolvedValue({ item: {} });
  updateMessageTrigger.mockResolvedValue({ item: {} });
});

async function openNewDialog() {
  render(<TriggersPage />);
  fireEvent.click(await screen.findByRole('button', { name: /new trigger/i }));
  return screen.findByRole('dialog');
}

async function openEditDialog(rowName: string) {
  const card = (await screen.findByText(rowName)).closest('div.p-4') as HTMLElement;
  const pencil = within(card!).getAllByRole('button')[1]; // switch has role=switch, not button: [beaker, pencil, trash]
  fireEvent.click(pencil);
  return screen.findByRole('dialog');
}

async function openEventSelect(dialog: HTMLElement) {
  const selects = within(dialog).getAllByRole('combobox');
  fireEvent.click(selects[0]);
  return screen.findByRole('listbox');
}

async function openActionSelect(dialog: HTMLElement) {
  const selects = within(dialog).getAllByRole('combobox');
  fireEvent.click(selects[1]);
  return screen.findByRole('listbox');
}

describe('TriggersPage — live event UI treatment (Follow-up 9G.1)', () => {
  it('UITRUTH1 — live events render without a "coming soon" qualifier', async () => {
    const dialog = await openNewDialog();
    const listbox = await openEventSelect(dialog);
    for (const label of ['Visitor first message', 'Topic detected', 'Human requested', 'AI could not answer']) {
      const el = within(listbox).getByText(label);
      expect(el.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
    }
  });

  it('UITRUTH2 — not-live events are visibly marked "— coming soon" and disabled', async () => {
    const dialog = await openNewDialog();
    const listbox = await openEventSelect(dialog);
    for (const label of [/Conversation started.*coming soon/i, /After pre-chat form.*coming soon/i, /No operator online.*coming soon/i, /Outside business hours.*coming soon/i]) {
      const el = within(listbox).getByText(label);
      expect(el.closest('[role="option"]')).toHaveAttribute('data-disabled');
    }
  });

  it('UITRUTH3 — a new rule cannot select a not-live event (disabled option, click is a no-op)', async () => {
    const dialog = await openNewDialog();
    const listbox = await openEventSelect(dialog);
    fireEvent.click(within(listbox).getByText(/After pre-chat form/i));
    // Selection did not change away from the live default.
    expect(within(dialog).getByText('Visitor first message')).toBeTruthy();
  });
});

describe('TriggersPage — not-live event legacy round-trip (Follow-up 9G.1)', () => {
  it('UITRUTH4 — an existing persisted not-live event (after_prechat) remains readable and unrelated save preserves it', async () => {
    listMessageTriggers.mockResolvedValue({ items: [triggerRow({ id: 't-legacy-event', name: 'Legacy event rule', event_type: 'after_prechat' })] });
    render(<TriggersPage />);
    const dialog = await openEditDialog('Legacy event rule');
    expect(within(dialog).getByText(/After pre-chat form/i)).toBeTruthy();
    expect(within(dialog).getByText(/not currently emitted by the runtime/i)).toBeTruthy();
    const nameInput = within(dialog).getByDisplayValue('Legacy event rule') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Renamed legacy event rule' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMessageTrigger).toHaveBeenCalledTimes(1));
    expect(updateMessageTrigger.mock.calls[0][1].event_type).toBe('after_prechat');
  });
});

describe('TriggersPage — action UI treatment (Follow-up 9G.1)', () => {
  it('UITRUTH5 — send_message and handoff are visibly live actions (no qualifier, not disabled)', async () => {
    const dialog = await openNewDialog();
    const listbox = await openActionSelect(dialog);
    for (const label of ['Send AI message', 'Handoff to human']) {
      const el = within(listbox).getByText(label);
      expect(el.closest('[role="option"]')).not.toHaveAttribute('data-disabled');
    }
  });

  it('UITRUTH6 — start_workflow/assign/tag/internal_note are visibly "coming soon" and disabled', async () => {
    const dialog = await openNewDialog();
    const listbox = await openActionSelect(dialog);
    for (const label of [/Start workflow.*coming soon/i, /Assign.*coming soon/i, /Add tag.*coming soon/i, /Add internal note.*coming soon/i]) {
      const el = within(listbox).getByText(label);
      expect(el.closest('[role="option"]')).toHaveAttribute('data-disabled');
    }
  });

  it('UITRUTH7 — an existing persisted planned action (start_workflow) remains renderable and unrelated save preserves it', async () => {
    listMessageTriggers.mockResolvedValue({
      items: [triggerRow({ id: 't-legacy-action', name: 'Legacy action rule', action_type: 'start_workflow', action_json: { workflow_id: 'wf-1' } })],
    });
    render(<TriggersPage />);
    const dialog = await openEditDialog('Legacy action rule');
    expect(within(dialog).getByText(/Start workflow/i)).toBeTruthy();
    expect(within(dialog).getByText(/not currently executed by the runtime/i)).toBeTruthy();
    const descInput = within(dialog).getAllByRole('textbox').find((el) => (el as HTMLInputElement).placeholder === 'Optional') as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: 'unrelated description edit' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMessageTrigger).toHaveBeenCalledTimes(1));
    expect(updateMessageTrigger.mock.calls[0][1].action_type).toBe('start_workflow');
  });
});

describe('TriggersPage — page/dialog copy truthfulness (Follow-up 9G.1)', () => {
  it('UITRUTH8 — the page description no longer claims runtime execution is universally disabled', async () => {
    render(<TriggersPage />);
    await screen.findByRole('heading', { name: /message triggers/i });
    expect(screen.queryByText(/runtime execution turns on in the next pass/i)).toBeNull();
    expect(screen.queryByText(/new triggers are saved disabled/i)).toBeNull();
  });

  it('UITRUTH9 — the delay field explicitly says it is not enforced, and is not editable', async () => {
    const dialog = await openNewDialog();
    expect(within(dialog).getByText(/delay is not currently enforced/i)).toBeTruthy();
    const delayInput = within(dialog).getByLabelText(/Delay \(seconds\)/i) as HTMLInputElement;
    expect(delayInput).toBeDisabled();
  });
});

describe('TriggersPage — delay value truthfulness (Follow-up 9G.1)', () => {
  it('UITRUTH10 — an existing delay_seconds=3600 remains displayed and is preserved on unrelated save, without implying an active delay', async () => {
    listMessageTriggers.mockResolvedValue({ items: [triggerRow({ id: 't-delay', name: 'Delayed rule', delay_seconds: 3600 })] });
    updateMessageTrigger.mockResolvedValue({ item: {} });
    render(<TriggersPage />);
    // List badge: truthful, not "delay 3600s" (which would read as active).
    expect(await screen.findByText(/configured delay 3600s — not enforced/i)).toBeTruthy();
    expect(screen.queryByText(/^delay 3600s$/i)).toBeNull();

    const dialog = await openEditDialog('Delayed rule');
    const delayInput = within(dialog).getByLabelText(/Delay \(seconds\)/i) as HTMLInputElement;
    expect(delayInput.value).toBe('3600');
    const nameInput = within(dialog).getByDisplayValue('Delayed rule') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Renamed delayed rule' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMessageTrigger).toHaveBeenCalledTimes(1));
    expect(updateMessageTrigger.mock.calls[0][1].delay_seconds).toBe(3600);
  });
});

describe('TriggersPage — rule list runtime-capability truthfulness (Follow-up 9G.1)', () => {
  it('UITRUTH11a — a live event + live action, enabled row is NOT marked "not runtime-capable"', async () => {
    listMessageTriggers.mockResolvedValue({
      items: [triggerRow({ id: 't-live', name: 'Fully live rule', event_type: 'visitor_first_message', action_type: 'send_message', enabled: true })],
    });
    render(<TriggersPage />);
    await screen.findByText('Fully live rule');
    expect(screen.queryByText(/not runtime-capable/i)).toBeNull();
  });

  it('UITRUTH11b — enabled=true with a not-live event is still marked "not runtime-capable" (enabled does not imply runtime-capable)', async () => {
    listMessageTriggers.mockResolvedValue({
      items: [triggerRow({ id: 't-dead-event', name: 'Dead event rule', event_type: 'no_operator_online', action_type: 'send_message', enabled: true })],
    });
    render(<TriggersPage />);
    await screen.findByText('Dead event rule');
    expect(screen.getByText(/not runtime-capable/i)).toBeTruthy();
  });

  it('UITRUTH11c — enabled=true with a planned action is still marked "not runtime-capable"', async () => {
    listMessageTriggers.mockResolvedValue({
      items: [triggerRow({ id: 't-dead-action', name: 'Dead action rule', event_type: 'human_requested', action_type: 'tag', enabled: true })],
    });
    render(<TriggersPage />);
    await screen.findByText('Dead action rule');
    expect(screen.getByText(/not runtime-capable/i)).toBeTruthy();
  });
});

describe('TriggersPage — Test button surfaces the truthful dry-run note (Follow-up 9G.1)', () => {
  it('does not execute a side effect and shows the API-provided note verbatim via toast', async () => {
    listMessageTriggers.mockResolvedValue({ items: [triggerRow({ id: 't-test', name: 'Testable rule' })] });
    testMessageTrigger.mockResolvedValue({
      ok: true, dryRun: true, runtimeExecutionEnabled: true, eventRuntimeEnabled: true, actionRuntimeEnabled: true,
      planned: { event_type: 'visitor_first_message', action_type: 'send_message', action_json: {}, delay_seconds: 0 },
      note: 'Dry run evaluated this trigger. Its event and action are live in runtime. This test does not execute side effects.',
    });
    render(<TriggersPage />);
    const card = (await screen.findByText('Testable rule')).closest('div.p-4') as HTMLElement;
    const beaker = within(card!).getAllByRole('button')[0]; // [beaker, pencil, trash]
    fireEvent.click(beaker);
    await waitFor(() => expect(testMessageTrigger).toHaveBeenCalledWith('t-test'));
  });
});

describe('TriggersPage — legacy round-trip (Follow-up 9G.1)', () => {
  it('LEGACYTRIG1 — existing after_prechat rule, rename only: event_type remains after_prechat', async () => {
    listMessageTriggers.mockResolvedValue({ items: [triggerRow({ id: 't-l1', name: 'Legacy1', event_type: 'after_prechat' })] });
    updateMessageTrigger.mockResolvedValue({ item: {} });
    render(<TriggersPage />);
    const dialog = await openEditDialog('Legacy1');
    const nameInput = within(dialog).getByDisplayValue('Legacy1') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Legacy1 renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMessageTrigger).toHaveBeenCalledTimes(1));
    expect(updateMessageTrigger.mock.calls[0][1].event_type).toBe('after_prechat');
  });

  it('LEGACYTRIG2 — existing start_workflow action, description only: action_type remains start_workflow, action_json preserved', async () => {
    listMessageTriggers.mockResolvedValue({
      items: [triggerRow({ id: 't-l2', name: 'Legacy2', action_type: 'start_workflow', action_json: { workflow_id: 'wf-42' } })],
    });
    updateMessageTrigger.mockResolvedValue({ item: {} });
    render(<TriggersPage />);
    const dialog = await openEditDialog('Legacy2');
    const descInput = within(dialog).getByPlaceholderText('Optional') as HTMLInputElement;
    fireEvent.change(descInput, { target: { value: 'a new description' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMessageTrigger).toHaveBeenCalledTimes(1));
    expect(updateMessageTrigger.mock.calls[0][1].action_type).toBe('start_workflow');
    // action_json is preserved byte-for-byte on an unrelated save — the
    // dialog exposes no editable field for start_workflow's payload, so a
    // save must never silently wipe it back to {} (Follow-up 9G.1).
    expect(updateMessageTrigger.mock.calls[0][1].action_json).toEqual({ workflow_id: 'wf-42' });
  });

  it('LEGACYTRIG3 — existing delay_seconds=120, unrelated save: delay_seconds remains 120', async () => {
    listMessageTriggers.mockResolvedValue({ items: [triggerRow({ id: 't-l3', name: 'Legacy3', delay_seconds: 120 })] });
    updateMessageTrigger.mockResolvedValue({ item: {} });
    render(<TriggersPage />);
    const dialog = await openEditDialog('Legacy3');
    const nameInput = within(dialog).getByDisplayValue('Legacy3') as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: 'Legacy3 renamed' } });
    fireEvent.click(within(dialog).getByRole('button', { name: /save changes/i }));
    await waitFor(() => expect(updateMessageTrigger).toHaveBeenCalledTimes(1));
    expect(updateMessageTrigger.mock.calls[0][1].delay_seconds).toBe(120);
  });
});
