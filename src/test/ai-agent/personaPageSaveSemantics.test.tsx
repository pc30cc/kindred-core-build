/**
 * «Personality & behavior» (BehaviorPage) — what a save sends.
 *
 * One page now holds what Activation, Behavior, Instructions and Name &
 * messages held, behind one Save. The invariants those pages' tests guarded
 * hold here, at the UI boundary (the real page, the payload it hands to the
 * settings mutation):
 *
 *   - a save sends only the fields the owner changed: never `enabled` or
 *     `mode` unless a mode was picked, never `allowed_locales` or the legacy
 *     `welcome_message`, never an untouched field "because Save was clicked";
 *   - `instructions` carries only the edited keys (the server merges them);
 *   - `false`, `''` and `[]` are sent as values, an untouched field not at all;
 *   - the business description is the top-level field, never the legacy
 *     nested key, and opening the page writes nothing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import {
  baseSettings, enText, resetStore, store, type Patch,
} from './helpers/personaPage';

vi.mock('@/i18n', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/i18n')>();
  const { enText: t } = await import('./helpers/personaPage');
  return { ...actual, useTranslation: () => ({ locale: 'en' as const, dir: 'ltr' as const, t }) };
});
vi.mock('@/hooks/useWorkspace', async () => {
  const { store: s } = await import('./helpers/personaPage');
  return {
    useActiveWorkspace: () => ({ workspace: s.workspace, notFound: false }),
    useCurrentWorkspace: () => s.workspace,
    useWorkspacePath: () => (path: string) => `/${s.workspace.slug}${path}`,
  };
});
vi.mock('@/hooks/usePlatformRegion', async () => {
  const { store: s } = await import('./helpers/personaPage');
  return { usePlatformRegion: () => ({ mode: 'multi', allowedLocales: s.locales, canSwitchLanguage: s.locales.length > 1, currency: 'USD' }) };
});
vi.mock('@/hooks/useAiAgent', async () => {
  const React = await import('react');
  const h = await import('./helpers/personaPage');
  return {
    useAiAgentSettings: () => ({ data: React.useSyncExternalStore(h.subscribe, () => h.store.data), isLoading: false }),
    useUpdateAiAgentSettings: () => ({ mutateAsync: h.mutate, isPending: false }),
    useAiAgentDiagnostics: () => ({ data: h.store.diag }),
  };
});
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/lib/toast', () => ({ toast }));
vi.mock('@/hooks/use-toast', () => ({ toast: vi.fn() }));
const api = vi.hoisted(() => ({
  listGuidance: vi.fn(async () => ({ items: [] })),
  createGuidance: vi.fn(async () => ({ item: {} })),
  updateGuidance: vi.fn(async () => ({ item: {} })),
  deleteGuidance: vi.fn(async () => ({ ok: true })),
  generateBusinessDescription: vi.fn(async () => ({ description: 'generated', source: 'ai' })),
  uploadAvatar: vi.fn(async () => ({ avatar_url: 'https://example.com/a.png' })),
  removeAvatar: vi.fn(async () => ({ ok: true })),
  testAi: vi.fn(),
}));
vi.mock('@/lib/ai-agent-api', () => ({ aiAgentApi: api }));

const BehaviorPage = (await import('@/pages/app/ai-agent/BehaviorPage')).default;
const ROUTER_FUTURE = { v7_startTransition: true, v7_relativeSplatPath: true };

async function renderPage() {
  const view = render(<MemoryRouter future={ROUTER_FUTURE}><BehaviorPage /></MemoryRouter>);
  // The answer rules load on their own (GET /guidance); let them settle.
  await screen.findByRole('button', { name: enText('aiAgent.guidance.addDefaults') });
  return view;
}

function saveButton() {
  return screen.getByRole('button', { name: 'Save changes' });
}

async function save(): Promise<Patch> {
  const before = store.patches.length;
  expect(saveButton()).toBeEnabled();
  fireEvent.click(saveButton());
  await waitFor(() => expect(store.patches.length).toBe(before + 1));
  return store.patches[before];
}

function byId<T extends HTMLElement = HTMLInputElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} is not on the page`);
  return el as T;
}

function openGroup(id: string) {
  const item = document.querySelector(`[data-persona-advanced="${id}"]`) as HTMLElement;
  fireEvent.click(within(item).getAllByRole('button')[0]);
}

function radio(name: string) {
  return screen.getByRole('radio', { name });
}

function switchNamed(name: string) {
  return screen.getByRole('switch', { name });
}

beforeEach(() => {
  resetStore();
  toast.success.mockClear();
  toast.error.mockClear();
  api.generateBusinessDescription.mockClear();
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('a save sends only what the owner changed', () => {
  it('opening the page sends nothing, and with nothing changed Save is disabled', async () => {
    await renderPage();
    expect(saveButton()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Discard' })).toBeDisabled();
    expect(screen.getByText(enText('aiAgent.persona.save.clean'))).toBeInTheDocument();
    expect(store.patches).toEqual([]);
  });

  it('changing only the fallback message sends only fallback_message (no allowed_locales, mode, enabled or welcome_message)', async () => {
    resetStore(baseSettings({ allowed_locales: ['fa', 'ar'], mode: 'auto_reply_always' }));
    await renderPage();
    openGroup('knowledge');
    fireEvent.change(byId('persona-fallback-message'), { target: { value: 'New fallback text' } });
    expect(screen.getByText(enText('aiAgent.persona.save.unsaved'))).toBeInTheDocument();

    expect(await save()).toEqual({ fallback_message: 'New fallback text' });
  });

  it('changing only the name sends only agent_name', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'New Bot Name' } });
    expect(await save()).toEqual({ agent_name: 'New Bot Name' });
  });

  it('an emptied name blocks Save with a plain reason, and sends nothing', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: '   ' } });
    expect(screen.getByText(enText('aiAgent.persona.identity.nameRequired'))).toBeInTheDocument();
    expect(saveButton()).toBeDisabled();
    fireEvent.click(saveButton());
    expect(store.patches).toEqual([]);
  });

  it('a switch turned off sends false, an emptied text sends "", a cleared list sends [], an untouched field nothing', async () => {
    resetStore(baseSettings({ instructions: { tone: 'friendly', do_list: ['Be concise'], brand_voice: 'Playful' } }));
    await renderPage();
    fireEvent.click(switchNamed(enText('aiAgent.persona.behavior.clarify')));
    fireEvent.change(byId('persona-do-list'), { target: { value: '' } });
    openGroup('identity');
    fireEvent.change(byId('persona-brand-voice'), { target: { value: '' } });
    openGroup('knowledge');
    fireEvent.change(byId('persona-fallback-message'), { target: { value: '' } });

    expect(await save()).toEqual({
      allow_clarifying_questions: false,
      fallback_message: '',
      instructions: { do_list: [], brand_voice: '' },
    });
  });

  it('changing a control and changing it back leaves nothing to save', async () => {
    await renderPage();
    fireEvent.click(radio('Short'));
    fireEvent.click(radio('Balanced'));
    fireEvent.click(switchNamed(enText('aiAgent.persona.behavior.clarify')));
    fireEvent.click(switchNamed(enText('aiAgent.persona.behavior.clarify')));
    expect(saveButton()).toBeDisabled();
  });

  it('Discard drops every edit and sends nothing', async () => {
    await renderPage();
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Other' } });
    fireEvent.click(radio('Formal'));
    fireEvent.click(screen.getByRole('button', { name: 'Discard' }));
    expect(screen.getByLabelText('Name')).toHaveValue('Sara');
    expect(radio('Friendly')).toHaveAttribute('data-state', 'checked');
    expect(saveButton()).toBeDisabled();
    expect(store.patches).toEqual([]);
  });
});

describe('the mode is never sent unless the owner picked one', () => {
  for (const mode of ['auto_reply_always', 'auto_reply_when_offline', 'auto_reply_until_human_joins', 'suggest_only'] as const) {
    it(`${mode}: changing tone, length and the description sends neither enabled nor mode`, async () => {
      resetStore(baseSettings({ mode }));
      await renderPage();
      fireEvent.click(radio('Formal'));
      fireEvent.click(radio('Detailed'));
      fireEvent.change(screen.getByLabelText('About your business'), { target: { value: 'Something else' } });
      const patch = await save();
      expect(patch).not.toHaveProperty('enabled');
      expect(patch).not.toHaveProperty('mode');
    });
  }

  it('a switched-off assistant shows Off whatever mode it keeps, and other edits still send neither', async () => {
    resetStore(baseSettings({ enabled: false, mode: 'auto_reply_until_human_joins' }));
    await renderPage();
    expect(radio('Off')).toHaveAttribute('data-state', 'checked');
    expect(radio(enText('aiAgent.persona.behavior.modeUntilHuman'))).toHaveAttribute('data-state', 'unchecked');

    fireEvent.click(radio('Short'));
    const patch = await save();
    expect(patch).not.toHaveProperty('enabled');
    expect(patch).not.toHaveProperty('mode');
  });
});

describe('instructions: only the edited keys travel', () => {
  it('a legacy free-text tone shows as its nearest preset and survives an unrelated save untouched', async () => {
    resetStore(baseSettings({ instructions: { tone: 'warm and playfully sarcastic', max_answer_length: 'medium' } }));
    await renderPage();
    expect(radio('Friendly')).toHaveAttribute('data-state', 'checked');

    fireEvent.click(switchNamed(enText('aiAgent.persona.behavior.clarify')));
    const patch = await save();
    expect(patch).not.toHaveProperty('instructions');
  });

  it('picking a preset writes the tone, and only the tone', async () => {
    resetStore(baseSettings({ instructions: { tone: 'warm and playfully sarcastic', max_answer_length: 'medium' } }));
    await renderPage();
    fireEvent.click(radio('Professional'));
    expect(await save()).toEqual({ instructions: { tone: 'professional' } });
  });

  it('an answer length change sends only instructions.max_answer_length', async () => {
    resetStore(baseSettings({ allowed_locales: ['fa', 'ar'] }));
    await renderPage();
    fireEvent.click(radio('Short'));
    expect(await save()).toEqual({ instructions: { max_answer_length: 'short' } });
  });

  it('"Always" writes the parsed list and nothing else of instructions', async () => {
    resetStore(baseSettings({ instructions: { tone: 'formal', do_list: ['Be concise', 'Cite sources'], dont_list: ['Never promise refunds'] } }));
    await renderPage();
    expect(byId<HTMLTextAreaElement>('persona-do-list').value).toBe('Be concise\nCite sources');
    fireEvent.change(byId('persona-do-list'), { target: { value: ' Be concise \n\nAlways link the docs\n' } });
    expect(await save()).toEqual({ instructions: { do_list: ['Be concise', 'Always link the docs'] } });
  });

  it('brand voice, pricing, support and handoff instructions each send their own key (trimmed)', async () => {
    resetStore(baseSettings({ instructions: { tone: 'formal', escalation_instructions: 'Legacy escalation text' } }));
    await renderPage();
    openGroup('identity');
    openGroup('handoff');
    // The legacy escalation text shows in the handoff instructions it feeds.
    expect(byId<HTMLTextAreaElement>('persona-handoff-instructions').value).toBe('Legacy escalation text');
    fireEvent.change(byId('persona-brand-voice'), { target: { value: '  Bold and confident. ' } });
    fireEvent.change(byId('persona-pricing'), { target: { value: 'Link the pricing page.' } });
    fireEvent.change(byId('persona-support'), { target: { value: 'Ask for the order number.' } });
    fireEvent.change(byId('persona-handoff-instructions'), { target: { value: 'Hand off after two tries.' } });
    expect(await save()).toEqual({
      instructions: {
        brand_voice: 'Bold and confident.',
        pricing_instructions: 'Link the pricing page.',
        support_instructions: 'Ask for the order number.',
        handoff_instructions: 'Hand off after two tries.',
      },
    });
  });

  it('emptying handoff instructions that show the legacy escalation text clears both, so the text really goes', async () => {
    resetStore(baseSettings({ instructions: { tone: 'formal', escalation_instructions: 'Legacy escalation text' } }));
    await renderPage();
    openGroup('handoff');
    fireEvent.change(byId('persona-handoff-instructions'), { target: { value: '  ' } });
    expect(await save()).toEqual({ instructions: { handoff_instructions: '', escalation_instructions: '' } });
    expect(byId<HTMLTextAreaElement>('persona-handoff-instructions').value).toBe('');
  });

  it('several edits at once send exactly their fields, never enabled, mode or allowed_locales', async () => {
    await renderPage();
    fireEvent.click(radio('Formal'));
    fireEvent.click(radio('Short'));
    fireEvent.click(switchNamed(enText('aiAgent.persona.behavior.clarify')));
    fireEvent.click(radio(enText('aiAgent.persona.behavior.handoffAssistFirst')));
    const patch = await save();
    expect(Object.keys(patch).sort()).toEqual(['allow_clarifying_questions', 'handoff_policy', 'instructions']);
    expect(patch.instructions).toEqual({ tone: 'formal', max_answer_length: 'short' });
  });
});

describe('the business description is the top-level field (canonical ownership)', () => {
  it('BD1: the top-level text shows, not a conflicting legacy nested one', async () => {
    resetStore(baseSettings({ business_description: 'Canonical company description', instructions: { business_description: 'Legacy conflicting description' } }));
    await renderPage();
    expect(screen.getByLabelText('About your business')).toHaveValue('Canonical company description');
  });

  it('BD2/BD3/BD7: an edit writes the top-level field only, without an instructions key', async () => {
    resetStore(baseSettings({ instructions: { tone: 'formal', business_description: 'A quirky widget shop.' } }));
    await renderPage();
    fireEvent.change(screen.getByLabelText('About your business'), { target: { value: 'New description' } });
    expect(await save()).toEqual({ business_description: 'New description' });
  });

  it('BD4: description and brand voice together: the top-level field plus instructions.brand_voice only', async () => {
    resetStore(baseSettings({ instructions: { brand_voice: 'Playful but precise.', business_description: 'A quirky widget shop.' } }));
    await renderPage();
    fireEvent.change(screen.getByLabelText('About your business'), { target: { value: 'New canonical text' } });
    openGroup('identity');
    fireEvent.change(byId('persona-brand-voice'), { target: { value: 'Bold and confident.' } });
    expect(await save()).toEqual({
      business_description: 'New canonical text',
      instructions: { brand_voice: 'Bold and confident.' },
    });
  });

  it('BD6: a legacy nested-only description shows as the text, and opening the page writes nothing', async () => {
    resetStore(baseSettings({ business_description: null, instructions: { business_description: 'Legacy only' } }));
    await renderPage();
    expect(screen.getByLabelText('About your business')).toHaveValue('Legacy only');
    expect(store.patches).toEqual([]);
  });

  it('BD8: "Generate with AI" asks before replacing text, then fills the field for Save (top-level only)', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await renderPage();
    const generate = screen.getByRole('button', { name: 'Generate with AI' });

    fireEvent.click(generate);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.generateBusinessDescription).not.toHaveBeenCalled();

    fireEvent.click(generate);
    await waitFor(() => expect(screen.getByLabelText('About your business')).toHaveValue('generated'));
    expect(store.patches).toEqual([]);
    expect(await save()).toEqual({ business_description: 'generated' });
  });

  it('an empty description is generated without asking', async () => {
    const confirm = vi.spyOn(window, 'confirm');
    resetStore(baseSettings({ business_description: null }));
    await renderPage();
    fireEvent.click(screen.getByRole('button', { name: 'Generate with AI' }));
    await waitFor(() => expect(screen.getByLabelText('About your business')).toHaveValue('generated'));
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('behavior controls of the simple view', () => {
  it('handoff policy shows the effective value and is written only when changed', async () => {
    resetStore(baseSettings({ handoff_policy: null, handoff_on_human_request: true }));
    await renderPage();
    expect(radio(enText('aiAgent.persona.behavior.handoffImmediate'))).toHaveAttribute('data-state', 'checked');
    fireEvent.click(radio(enText('aiAgent.persona.behavior.handoffAdaptive')));
    expect(await save()).toEqual({ handoff_policy: 'adaptive' });
  });

  it('a legacy workspace whose request switch is off shows the nearest policy and says what happens now', async () => {
    resetStore(baseSettings({ handoff_policy: null, handoff_on_human_request: false }));
    await renderPage();
    expect(radio(enText('aiAgent.persona.behavior.handoffAdaptive'))).toHaveAttribute('data-state', 'checked');
    expect(screen.getByText(enText('aiAgent.persona.behavior.handoffSwitchOff'))).toBeInTheDocument();
    fireEvent.click(radio(enText('aiAgent.persona.behavior.handoffImmediate')));
    expect(await save()).toEqual({ handoff_policy: 'immediate' });
    // The server turned the switch on with the policy: the note goes.
    expect(screen.queryByText(enText('aiAgent.persona.behavior.handoffSwitchOff'))).not.toBeInTheDocument();
  });

  it('the stored policy shows as it is', async () => {
    resetStore(baseSettings({ handoff_policy: 'assist_first' }));
    await renderPage();
    expect(radio(enText('aiAgent.persona.behavior.handoffAssistFirst'))).toHaveAttribute('data-state', 'checked');
  });
});

describe('advanced groups', () => {
  const GROUPS = ['identity', 'answering', 'knowledge', 'handoff', 'limits', 'languages', 'learning'];

  it('start closed, and opening or closing them changes no data and no dirty state', async () => {
    await renderPage();
    for (const id of GROUPS) {
      const item = document.querySelector(`[data-persona-advanced="${id}"]`) as HTMLElement;
      expect(item).toHaveAttribute('data-state', 'closed');
    }
    for (const id of GROUPS) {
      openGroup(id);
      expect(document.querySelector(`[data-persona-advanced="${id}"]`)).toHaveAttribute('data-state', 'open');
    }
    expect(saveButton()).toBeDisabled();
    for (const id of GROUPS) openGroup(id);
    for (const id of GROUPS) openGroup(id);
    expect(saveButton()).toBeDisabled();
    expect(store.patches).toEqual([]);
  });

  it('an edit made in a group survives closing it, and is what Save sends', async () => {
    await renderPage();
    openGroup('limits');
    fireEvent.change(byId('persona-max-per-hour'), { target: { value: '50' } });
    openGroup('limits');
    expect(document.getElementById('persona-max-per-hour')).toBeNull();
    openGroup('limits');
    expect(byId('persona-max-per-hour')).toHaveValue(50);
    expect(await save()).toEqual({ max_replies_per_hour: 50 });
  });

  it('no control of the simple view is repeated in the groups', async () => {
    await renderPage();
    for (const id of GROUPS) openGroup(id);
    expect(screen.getAllByRole('switch', { name: enText('aiAgent.persona.behavior.clarify') })).toHaveLength(1);
    expect(screen.getAllByRole('switch', { name: enText('aiAgent.persona.identity.welcomeSwitch') })).toHaveLength(1);
    expect(screen.getAllByLabelText('Name')).toHaveLength(1);
    expect(screen.getAllByLabelText('About your business')).toHaveLength(1);
    // The welcome message of the primary language (English here) is in the
    // simple view only; the group holds the other languages'.
    expect(document.getElementById('persona-welcome-en')).toBeNull();
    expect(document.getElementById('persona-welcome-fa')).not.toBeNull();
    for (const name of ['Formal', 'Short', 'Off', enText('aiAgent.persona.behavior.handoffImmediate'), enText('aiAgent.persona.behavior.replyVisitor')]) {
      expect(screen.getAllByRole('radio', { name })).toHaveLength(1);
    }
  });

  it('every specialist setting writes its own field', async () => {
    await renderPage();
    for (const id of GROUPS) openGroup(id);
    fireEvent.click(switchNamed(enText('aiAgent.persona.advanced.caveat')));
    fireEvent.click(switchNamed(enText('aiAgent.persona.advanced.onlyKb')));
    fireEvent.click(switchNamed(enText('aiAgent.persona.advanced.strictScope')));
    fireEvent.click(radio(enText('aiAgent.persona.advanced.guidanceCreative')));
    fireEvent.click(radio(enText('aiAgent.persona.advanced.fallbackSilent')));
    fireEvent.click(switchNamed(enText('aiAgent.persona.advanced.noMatchHandoff')));
    fireEvent.click(radio(enText('aiAgent.persona.advanced.escHelpful')));
    fireEvent.click(switchNamed(enText('aiAgent.persona.advanced.lowConfidence')));
    fireEvent.click(switchNamed(enText('aiAgent.persona.advanced.stopOnHandoff')));
    fireEvent.click(switchNamed(enText('aiAgent.persona.advanced.stopAfterHuman')));
    fireEvent.change(byId('persona-max-clarify'), { target: { value: '3' } });
    fireEvent.change(byId('persona-max-per-conversation'), { target: { value: '7' } });
    fireEvent.change(byId('persona-confidence'), { target: { value: '70' } });
    fireEvent.click(switchNamed(enText('aiAgent.persona.advanced.learningAuto')));
    fireEvent.click(switchNamed(enText('aiAgent.persona.advanced.learning')));

    expect(await save()).toEqual({
      allow_answer_with_caveat: false,
      answer_only_from_kb: false,
      strict_topic_scope: true,
      answer_guidance: 'creative',
      fallback_behavior: 'silent',
      handoff_when_no_kb_match: true,
      escalation_style: 'helpful_first',
      handoff_on_low_confidence: true,
      stop_on_handoff: false,
      pause_auto_reply_after_human_reply: false,
      max_clarification_attempts: 3,
      max_replies_per_conversation: 7,
      confidence_threshold: 0.7,
      auto_create_learning_candidates: false,
      learning_enabled: false,
    });
  });

  it('counts are kept in range: leaving a field clamps it, and an emptied one returns to the saved value', async () => {
    await renderPage();
    openGroup('limits');
    const perConversation = byId('persona-max-per-conversation');
    fireEvent.change(perConversation, { target: { value: '500' } });
    fireEvent.blur(perConversation);
    expect(perConversation).toHaveValue(100);
    const perHour = byId('persona-max-per-hour');
    fireEvent.change(perHour, { target: { value: '' } });
    fireEvent.blur(perHour);
    expect(perHour).toHaveValue(20);
    expect(await save()).toEqual({ max_replies_per_conversation: 100 });
  });

  it('clarifying attempts are disabled while clarifying questions are off; help attempts show only for the assist policies', async () => {
    await renderPage();
    openGroup('answering');
    openGroup('handoff');
    expect(byId('persona-max-clarify')).toBeEnabled();
    expect(document.getElementById('persona-assist-attempts')).toBeNull();

    fireEvent.click(switchNamed(enText('aiAgent.persona.behavior.clarify')));
    expect(byId('persona-max-clarify')).toBeDisabled();

    fireEvent.click(radio(enText('aiAgent.persona.behavior.handoffAssistFirst')));
    fireEvent.change(byId('persona-assist-attempts'), { target: { value: '0' } });
    expect(await save()).toEqual({ allow_clarifying_questions: false, handoff_policy: 'assist_first', max_assist_attempts: 0 });
  });

  it('handoff keywords are chips of the form: added and removed locally, sent with Save as one list', async () => {
    await renderPage();
    openGroup('handoff');
    const input = byId('persona-keyword-input');
    fireEvent.change(input, { target: { value: 'Operator' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(screen.getByText(enText('aiAgent.settings.texts.keywordExists'))).toBeInTheDocument();
    fireEvent.change(input, { target: { value: 'support' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    fireEvent.click(screen.getByRole('button', { name: enText('aiAgent.persona.advanced.keywordRemove', { word: 'human' }) }));
    expect(store.patches).toEqual([]);
    expect(await save()).toEqual({ handoff_keywords: ['operator', 'support'] });
  });
});

describe('what the page does not hold', () => {
  it('no knowledge management (sources, uploads, add-source forms) and at most one link to the Knowledge Base', async () => {
    resetStore(baseSettings());
    store.diag = { ...store.diag!, checks: { ...store.diag!.checks, has_knowledge: false } };
    await renderPage();
    for (const id of ['identity', 'answering', 'knowledge', 'handoff', 'limits', 'languages', 'learning']) openGroup(id);

    // The only file input is the assistant's picture.
    const files = [...document.querySelectorAll('input[type="file"]')];
    expect(files).toHaveLength(1);
    expect(files[0]).toHaveAttribute('data-persona-avatar-input');
    expect(files[0].getAttribute('accept')).toMatch(/^image\//);

    const links = screen.queryAllByRole('link');
    expect(links.filter((l) => /knowledge/.test(l.getAttribute('href') || ''))).toHaveLength(1);
    expect(links.every((l) => !/\/ai-agent\/(knowledge|web-pages|train|files|qna)/.test(l.getAttribute('href') || ''))).toBe(true);
    for (const name of [/add source/i, /add website/i, /upload file/i, /crawl/i, /sync now/i]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
  });

  it('no switches the runtime ignores or other pages own', async () => {
    await renderPage();
    for (const id of ['identity', 'answering', 'knowledge', 'handoff', 'limits', 'languages', 'learning']) openGroup(id);
    // show_sources_to_operator and allow_suggestions_after_takeover stay on
    // Operator assist; keep_in_automated_until_handoff,
    // require_approval_for_learning and show_sources_to_visitor change nothing.
    for (const text of [/sources to operators/i, /sources to visitors/i, /suggestions after/i, /automated inbox/i, /require approval/i]) {
      expect(screen.queryByText(text)).not.toBeInTheDocument();
      expect(screen.queryByRole('switch', { name: text })).not.toBeInTheDocument();
    }
  });
});
