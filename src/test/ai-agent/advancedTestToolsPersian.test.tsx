/**
 * AI → Advanced tools: Test cases, a test run and the run inspector speak the
 * panel's language. In Persian no English word of the UI is left on screen
 * (headings, buttons, table heads, statuses, behaviours, strategy reasons,
 * failure reasons, safety notes, side effects, aria-labels, toasts); what
 * stays Latin is data: the visitor's words, URLs, codes, the provider's
 * model name and the raw JSON the engine recorded (shown left to right).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';
import { buildTestRunLabels } from '@/pages/app/ai-agent/testRunLabels';

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastSpy }));

const WS = { id: 'ws-1', slug: 'acme', name: 'فروشگاه' };
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: WS }),
  useCurrentWorkspace: () => WS,
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));

const CASE = {
  id: 'case-1',
  workspace_id: 'ws-1',
  name: 'هزینه ارسال',
  input_message: 'هزینه ارسال به شیراز چقدر است؟',
  locale: 'fa',
  page_context: { currentPageUrl: 'https://shop.example/shipping' },
  expected_behavior: 'answer',
  expected_source_type: 'kb_article',
  expected_source_url: 'https://shop.example/shipping',
  expected_source_id: 'src-9',
  expected_contains: ['تومان'],
  expected_not_contains: ['رایگان'],
  min_confidence: 0.6,
  enabled: true,
  metadata: {},
  created_at: '2026-11-01T10:00:00Z',
  updated_at: '2026-11-01T10:00:00Z',
};
const DISABLED_CASE = { ...CASE, id: 'case-2', name: 'پرسش ناشناخته', expected_behavior: 'no_answer', expected_source_type: null, enabled: false };

const RUN = {
  id: 'run-1',
  workspace_id: 'ws-1',
  test_case_id: 'case-1',
  ai_agent_run_id: 'ai-run-1',
  status: 'failed',
  input_message: CASE.input_message,
  actual_output: null,
  actual_status: 'no_answer',
  confidence: 0.31,
  selected_sources: [{ source_type: 'kb_article', title: 'راهنمای ارسال', source_url: 'https://shop.example/shipping', final_score: 0.42 }],
  retrieval_debug: { selected_sources: [], query: 'shipping' },
  answer_strategy: {
    action: 'no_answer', decision_type: 'no_answer_silent', reason: 'no_verified_info_silent',
    retrieval_strength: 'weak', top_score: 0.42, handoff_required: false, source_types_used: ['kb_article'],
  },
  failure_reasons: [
    'expected_answer_got_no_answer',
    'strategy_no_answer_for_expected_answer',
    'missing_expected_source_url',
    'missing_text:تومان',
    'low_confidence:0.31<0.6',
    'sensitive_metadata_leak',
  ],
  metadata: {
    provider: null,
    model: null,
    safety_notes: ['llm_call_skipped', 'retrieval_error:timeout'],
    runtime: {
      conversation_created: false, handoff_created: false, workflow_executed: false,
      learning_candidate_created: false, llm_called: false, ai_usage_logged: 'unknown',
    },
    runtime_parity: {
      retrieval: 'real_hybrid_retrieval', query_expansion: 'not_used', conversation_history: 'not_used',
      workflow_execution: 'disabled', handoff_execution: 'disabled', learning_generation: 'disabled',
    },
    excluded_summary: { draft_kb_excluded: 2, inactive_file_excluded: 1 },
  },
  created_at: '2026-11-02T10:00:00Z',
};

const INSPECTED = {
  run: {
    id: 'ai-run-1', workspace_id: 'ws-1', conversation_id: 'conv-1', run_type: 'auto_reply', mode: 'auto',
    status: 'handoff', input_text: 'سلام', output_text: null, confidence: 0.4,
    provider: 'openai', model: 'gpt-4o-mini', created_at: '2026-11-02T10:00:00Z',
  },
  conversation: null,
  visitor_message: { id: 'm1', body: 'می‌خواهم با اپراتور صحبت کنم', sender_type: 'visitor', created_at: '2026-11-02T10:00:00Z' },
  ai_message: null,
  retrieval_debug: null,
  answer_strategy: {
    decision_type: 'handoff', reason: 'human_request', retrieval_strength: 'none', top_score: 0,
    handoff_required: true, source_types_used: [], confidence: 0.4, escalation_style: 'balanced',
  },
  page_context: { current_page_url: 'https://shop.example/' },
  selected_sources: [{ source_type: 'qna', title: 'ساعت کاری', source_url: null, final_score: 0.5, keyword_score: 0.4, vector_score: 0.3, included_in_prompt: true }],
  prompt_preview: null,
  decision_timeline: ['routing_evaluated', 'answer_strategy_selected'],
  safety_notes: ['draft_kb_excluded=2'],
};

const api = vi.hoisted(() => ({
  listTestCases: vi.fn(),
  listTestRuns: vi.fn(),
  getTestSummary: vi.fn(),
  getTestRun: vi.fn(),
  runTestCase: vi.fn(),
  runBulkTests: vi.fn(),
  seedRecommendedTests: vi.fn(),
  updateTestCase: vi.fn(),
  createTestCase: vi.fn(),
  deleteTestCase: vi.fn(),
  suggestTestCaseFromTestRun: vi.fn(),
  inspectRun: vi.fn(),
}));
vi.mock('@/lib/ai-agent-api', () => ({ aiAgentApi: api }));

const { default: TestCasesPage } = await import('@/pages/app/ai-agent/TestCasesPage');
const { default: TestRunDetailPage } = await import('@/pages/app/ai-agent/TestRunDetailPage');
const { default: RunInspectorPage } = await import('@/pages/app/ai-agent/RunInspectorPage');

function resetApi() {
  api.listTestCases.mockResolvedValue({ items: [CASE, DISABLED_CASE] });
  api.listTestRuns.mockResolvedValue({ items: [RUN] });
  api.getTestSummary.mockResolvedValue({
    total_cases: 2, enabled_cases: 1, last_24h_runs: 3, last_24h_passed: 1, last_24h_failed: 2,
    last_24h_errored: 0, pass_rate: 0.33, failures_by_reason: {}, coverage_by_source_type: {},
  });
  api.getTestRun.mockResolvedValue({ item: RUN, test_case: CASE });
  api.inspectRun.mockResolvedValue(INSPECTED);
  api.runTestCase.mockResolvedValue({ run: RUN, result: {}, evaluation: { passed: false, failure_reasons: RUN.failure_reasons } });
  api.runBulkTests.mockResolvedValue({ total: 30, passed: 20, failed: 8, errored: 2, capped: true, max: 30, total_enabled: 45, runs: [] });
  api.seedRecommendedTests.mockResolvedValue({ inserted: 2, skipped: 2, created: [], skipped_reasons: ['qna:no_active_chunks', 'web_page:no_active_parent_website'] });
  api.suggestTestCaseFromTestRun.mockRejectedValue(Object.assign(new Error('duplicate'), { code: 'duplicate' }));
}

afterEach(() => { cleanup(); toastSpy.mockReset(); vi.clearAllMocks(); });

function mount(ui: React.ReactElement, path: string, route: string, locale: 'fa' | 'en' | 'tr' = 'fa') {
  resetApi();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const messages = locale === 'fa' ? fa : locale === 'tr' ? tr : en;
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale} initialTranslations={messages}>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path={route} element={ui} /></Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Words in Latin letters a person reads on the page: text outside data (pre, code, LTR runs, isolates) and every label attribute. */
function englishWords(root: HTMLElement, allowedPlaceholders: string[] = []): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('pre, code, [dir="ltr"], script, style').forEach((el) => el.remove());
  // The shared dialog's screen-reader "Close" (src/components/ui/dialog.tsx) is every dialog's, not these pages'.
  clone.querySelectorAll('[data-slot="dialog-close"]').forEach((el) => el.remove());
  const texts = [clone.textContent || ''];
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value && !(attr === 'placeholder' && allowedPlaceholders.includes(value))) texts.push(value);
    }
  });
  const joined = texts.join(' \n ').replace(/⁨[^⁩]*⁩/g, ' ');
  return joined.match(/[A-Za-z]{2,}/g) || [];
}

/** A toast's title and description, isolates (data) removed. */
function toastWords(): string[] {
  const text = toastSpy.mock.calls
    .map(([arg]) => `${(arg as { title?: string }).title ?? ''} ${(arg as { description?: string }).description ?? ''}`)
    .join(' ')
    .replace(/⁨[^⁩]*⁩/g, ' ');
  return text.match(/[A-Za-z]{2,}/g) || [];
}

describe('Test cases in Persian', () => {
  it('no English word on the page; statuses, behaviours, sources and failure reasons in words', async () => {
    mount(<TestCasesPage />, '/acme/ai-agent/test-cases', '/acme/ai-agent/test-cases');
    await screen.findByText(CASE.name);
    const A = fa.aiAgent.adv;
    const text = document.body.textContent || '';
    expect(text).toContain(A.testCases.title);
    expect(text).toContain(A.testCases.stats.passRate);
    expect(text).toContain(A.testRun.behavior.answer);
    expect(text).toContain(A.testRun.behavior.no_answer);
    expect(text).toContain(A.testCases.disabled);
    expect(text).toContain(A.testRun.status.failed);
    expect(text).toContain(fa.aiAgent.codes.sourceType.kb_article);
    expect(text).toContain(A.testRun.failure.missingSourceUrl);
    for (const raw of ['expected_answer_got', 'no_answer', 'kb_article', 'missing_expected_source_url', 'Seed recommended', 'Run all enabled', 'conf ']) {
      expect(text, raw).not.toContain(raw);
    }

    fireEvent.click(screen.getAllByRole('button', { name: A.testCases.actions.expand })[0]);
    const after = document.body.textContent || '';
    expect(after).toContain(A.testCases.latest.openInspector);
    expect(after).toContain(A.testRun.reason.no_verified_info_silent);
    expect(englishWords(document.body)).toEqual([]);
  });

  it('the form: every label, option and placeholder in Persian (codes kept as examples)', async () => {
    mount(<TestCasesPage />, '/acme/ai-agent/test-cases', '/acme/ai-agent/test-cases');
    await screen.findByText(CASE.name);
    fireEvent.click(screen.getByRole('button', { name: new RegExp(fa.aiAgent.adv.testCases.newTest) }));
    const dialog = await screen.findByRole('dialog');
    const F = fa.aiAgent.adv.testCases.form;
    expect(dialog.textContent).toContain(F.newTitle);
    expect(screen.getByLabelText(F.expectedBehavior)).toBeTruthy();
    expect(screen.getByRole('option', { name: fa.aiAgent.adv.testRun.behavior.clarification })).toBeTruthy();
    expect(screen.getByRole('option', { name: F.anySource })).toBeTruthy();
    expect(screen.getByRole('option', { name: fa.aiAgent.adv.testRun.sourceTypeBusinessProfile })).toBeTruthy();
    expect(screen.getByRole('textbox', { name: F.pageUrl })).toBeTruthy();
    expect(englishWords(document.body, ['en, fa, tr', '0.6', 'https://…'])).toEqual([]);
  });

  it('the toasts of a run, a bulk run and the seed are Persian sentences', async () => {
    mount(<TestCasesPage />, '/acme/ai-agent/test-cases', '/acme/ai-agent/test-cases');
    await screen.findByText(CASE.name);
    const T = fa.aiAgent.adv.testCases;

    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: T.actions.run })[0]); });
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ title: T.toast.failed, variant: 'destructive' });
    expect(String(toastSpy.mock.calls[0][0].description)).toContain(fa.aiAgent.adv.testRun.failure.missingSourceUrl);

    await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(T.runAll) })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: new RegExp(T.seed) })); });
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(3));
    expect(toastSpy.mock.calls[1][0].title).toBe('20 از 30 آزمون موفق بود');
    expect(toastSpy.mock.calls[2][0].description).toContain(fa.aiAgent.adv.testCases.seedSkip.no_active_parent_website);
    expect(toastWords()).toEqual([]);
  });
});

describe('A test run in Persian', () => {
  it('no English word on the page; side effects, parity, strategy and safety notes in words', async () => {
    mount(<TestRunDetailPage />, '/acme/ai-agent/test-runs/run-1', '/acme/ai-agent/test-runs/:id');
    const R = fa.aiAgent.adv.testRun;
    await screen.findByText(R.title);
    const text = document.body.textContent || '';
    for (const expected of [
      R.compare.title, R.status.failed, R.actualStatus.no_answer, R.runtime.title, R.runtime.llm_called,
      R.parity.real_hybrid_retrieval, R.excluded.draft_kb_excluded, R.strategy.title,
      R.reason.no_verified_info_silent, R.decisionType.no_answer_silent, R.strength.weak,
      R.safety.llmCallSkipped, R.failure.sensitiveMetadataLeak, R.links.inspector, R.no, R.unknown,
    ]) {
      expect(text, expected).toContain(expected);
    }
    for (const raw of ['Expected vs Actual', 'Runtime side effects', 'conversation_created', 'real_hybrid_retrieval', 'llm_call_skipped', 'Back to Test Cases']) {
      expect(text, raw).not.toContain(raw);
    }
    expect(englishWords(document.body)).toEqual([]);
  });

  it('a refused suggestion says why in Persian (the page no longer breaks once its run arrives)', async () => {
    mount(<TestRunDetailPage />, '/acme/ai-agent/test-runs/run-1', '/acme/ai-agent/test-runs/:id');
    const R = fa.aiAgent.adv.testRun;
    const suggest = await screen.findByRole('button', { name: R.suggest });
    await act(async () => { fireEvent.click(suggest); });
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ title: R.toast.suggestFailed, description: R.toast.duplicate });
  });

  it('in English the page still reads in English', async () => {
    mount(<TestRunDetailPage />, '/acme/ai-agent/test-runs/run-1', '/acme/ai-agent/test-runs/:id', 'en');
    await screen.findByText(en.aiAgent.adv.testRun.title);
    expect(document.body.textContent).toContain(en.aiAgent.adv.testRun.compare.title);
    expect(document.body.textContent).toContain('Confidence 0.31 is below the minimum of 0.6');
  });
});

describe('The run inspector in Persian', () => {
  it('no English word on the page; data (model, JSON, URLs) stays as recorded, left to right', async () => {
    mount(<RunInspectorPage />, '/acme/ai-agent/runs/ai-run-1', '/acme/ai-agent/runs/:id');
    const I = fa.aiAgent.adv.runInspector;
    await screen.findByText(I.title);
    const text = document.body.textContent || '';
    for (const expected of [
      I.status.handoff, I.runType.auto_reply, I.sources.final, I.sources.yes, I.timeline.title,
      I.prompt.notStored, fa.aiAgent.adv.testRun.reason.human_request, fa.aiAgent.codes.sourceType.qna,
      fa.aiAgent.adv.testRun.excluded.draft_kb_excluded,
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).toContain('gpt-4o-mini');
    expect(screen.getByRole('link', { name: new RegExp(I.back) })).toHaveAttribute('href', '/acme/ai-agent/analytics');
    document.querySelectorAll('pre[data-latin-digits]').forEach((pre) => expect(pre).toHaveAttribute('dir', 'ltr'));
    expect(englishWords(document.body)).toEqual([]);
  });
});

describe('the words of these pages in the three languages', () => {
  const NAMESPACES = ['testCases', 'testRun', 'runInspector', 'sourceHealth', 'billing'] as const;
  const flatten = (obj: unknown, prefix = '', out: Record<string, string> = {}): Record<string, string> => {
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      const key = prefix ? `${prefix}.${k}` : k;
      if (v && typeof v === 'object') flatten(v, key, out);
      else out[key] = String(v);
    }
    return out;
  };
  const words = (messages: typeof en) => flatten(Object.fromEntries(NAMESPACES.map((n) => [n, messages.aiAgent.adv[n]])));

  it('en, fa and tr hold the same keys, none empty', () => {
    const keys = Object.keys(words(en)).sort();
    expect(keys.length).toBeGreaterThan(300);
    expect(Object.keys(words(fa)).sort()).toEqual(keys);
    expect(Object.keys(words(tr)).sort()).toEqual(keys);
    for (const messages of [en, fa, tr]) {
      for (const [key, value] of Object.entries(words(messages))) expect(value.trim(), key).not.toBe('');
    }
  });

  it('every Persian text is Persian (placeholders aside), with the same placeholders as English', () => {
    const enWords = words(en);
    for (const [key, value] of Object.entries(words(fa))) {
      expect(value.replace(/\{\{\w+\}\}/g, ''), key).not.toMatch(/[A-Za-z]{2,}/);
      const params = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();
      expect(params(value), key).toEqual(params(enWords[key]));
    }
  });
});

describe('the labels of the test tools', () => {
  const at = (messages: Record<string, unknown>) => (key: string, params?: Record<string, string | number>) => {
    const raw = key.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)?.[k], messages);
    let value = typeof raw === 'string' ? raw : key;
    for (const [k, v] of Object.entries(params || {})) value = value.split(`{{${k}}}`).join(String(v));
    return value;
  };

  it('every failure reason the evaluator writes is a sentence in each language', () => {
    const codes = [
      'expected_answer_got_failed', 'strategy_handoff_for_expected_answer', 'expected_no_answer_got_answer',
      'expected_handoff_got_clarification', 'expected_clarification_got_no_answer',
      'unsupported_expected_source_type:pdf', 'missing_expected_source_type:file', 'missing_expected_source_url',
      'missing_expected_source_id', 'missing_text:price', 'forbidden_text:free', 'low_confidence:0.20<0.5',
      'file_url_leak', 'file_url_leak_debug', 'sensitive_metadata_leak', 'prompt_preview_leak', 'errored',
      'retrieval_failed', 'no_ai_provider_configured', 'llm_call_failed', 'Request failed with status code 401',
    ];
    for (const messages of [fa, tr]) {
      const L = buildTestRunLabels(at(messages as unknown as Record<string, unknown>) as never);
      for (const code of codes) {
        const sentence = L.failureReason(code).replace(/⁨[^⁩]*⁩/g, '');
        expect(sentence, code).not.toMatch(/[a-z]+_[a-z_]+/);
        expect(sentence, code).not.toContain('aiAgent.');
      }
    }
    const L = buildTestRunLabels(at(fa as unknown as Record<string, unknown>) as never);
    expect(L.failureReason('expected_no_answer_got_answer')).toBe('«بدون پاسخ» مورد انتظار بود، اما نتیجه «پاسخ» شد');
    expect(L.failureReason('low_confidence:0.20<0.5')).toBe('اطمینان 0.20 کمتر از حداقل 0.5 است');
    expect(L.seedSkip('kb_article:no_published_row')).toBe('مقاله پایگاه دانش: مقاله منتشرشده‌ای نیست');
    expect(L.seedSkip('duplicate:Q&A coverage: price')).toBe('«پوشش پرسش و پاسخ: ⁨price⁩» از قبل وجود دارد');
    expect(L.seedSkip('duplicate:My case: price')).toBe('«⁨My case: price⁩» از قبل وجود دارد');
    expect(L.safetyNote('inactive_web_page_excluded=4')).toBe('صفحه‌های وب غیرفعال: 4');
    expect(L.error(Object.assign(new Error('owner_or_admin_required'), { code: 'owner_or_admin_required' })))
      .toBe(fa.aiAgent.adv.testCases.errors.owner_or_admin_required);
    expect(L.error(new Error('request_failed_502'))).toBe(fa.aiAgent.adv.testCases.errors.generic);
  });

  it('a seed skip for a case already there names it whole, never the word "duplicate"', () => {
    for (const messages of [fa, tr]) {
      const L = buildTestRunLabels(at(messages as unknown as Record<string, unknown>) as never);
      // internalQa.ts seed-recommended: `duplicate:<name>`, and names carry colons ("KB article: …").
      const sentence = L.seedSkip('duplicate:KB article: Shipping: fast');
      expect(sentence).toContain('⁨Shipping: fast⁩');
      expect(sentence.replace(/⁨[^⁩]*⁩/g, '')).not.toContain('duplicate');
      // A name of the member's own is kept whole, colons and all.
      expect(L.seedSkip('duplicate:Pricing: fast: now')).toContain('⁨Pricing: fast: now⁩');
    }
    const fa1 = buildTestRunLabels(at(fa as unknown as Record<string, unknown>) as never);
    expect(fa1.seedSkip('duplicate:KB article: Shipping: fast').replace(/⁨[^⁩]*⁩/g, '')).not.toMatch(/[A-Za-z]{2,}/);
  });

  it("the recommended cases' names (seed-recommended writes them in English) read in the panel's language", () => {
    // server/routes/ai-agent/internalQa.ts seed-recommended.
    const seeded = [
      'Q&A coverage: Shipping price',
      'Learned answer: Opening hours',
      'KB article: Returns: 30 days',
      'File coverage: catalog.pdf',
      'Web page: https://shop.example/about',
      'Unknown question (no answer expected)',
    ];
    for (const messages of [fa, tr]) {
      const L = buildTestRunLabels(at(messages as unknown as Record<string, unknown>) as never);
      for (const name of seeded) {
        const shown = L.caseName(name);
        expect(shown, name).not.toBe(name);
        expect(shown.replace(/⁨[^⁩]*⁩/g, ''), name).not.toMatch(/coverage|answer|article|page|question|expected/i);
        // The edit form's value is saved: never a direction mark in it.
        expect(L.caseNameForEdit(name), name).not.toMatch(/[⁨⁩]/);
      }
      // The title stays as written.
      expect(L.caseName('KB article: Returns: 30 days')).toContain('⁨Returns: 30 days⁩');
      expect(L.caseNameForEdit('KB article: Returns: 30 days')).toContain('Returns: 30 days');
      // A name of the member's own shows as written.
      expect(L.caseName('Shipping to Tabriz')).toBe('Shipping to Tabriz');
      expect(L.caseName('KB article: ')).toBe('KB article: ');
    }
    const faL = buildTestRunLabels(at(fa as unknown as Record<string, unknown>) as never);
    expect(faL.caseName('Unknown question (no answer expected)')).toBe('پرسش ناشناخته (پاسخی انتظار نمی‌رود)');
    expect(faL.caseNameForEdit('KB article: Returns')).toBe('مقاله پایگاه دانش: Returns');
    const enL = buildTestRunLabels(at(en as unknown as Record<string, unknown>) as never);
    for (const name of seeded) expect(enL.caseNameForEdit(name)).toBe(name);
  });

  it("a live run's own reasons (page match, off-topic decline) and an empty reply read as sentences", () => {
    for (const messages of [fa, tr]) {
      const L = buildTestRunLabels(at(messages as unknown as Record<string, unknown>) as never);
      for (const code of ['page_context_match', 'no_url', 'no_indexed_page', 'topic_decline', 'topic_decline_semantic']) {
        expect(L.reason(code), code).not.toContain('⁨');
        expect(L.reason(code), code).not.toMatch(/[a-z]+_[a-z_]+/);
      }
    }
    const L = buildTestRunLabels(at(fa as unknown as Record<string, unknown>) as never);
    expect(L.failureReason('expected_answer_got_replied')).toBe(fa.aiAgent.adv.testRun.failure.expectedAnswerEmpty);
  });

  it('a code no map knows yet is shown as itself, isolated, never as a missing key', () => {
    const L = buildTestRunLabels(at(fa as unknown as Record<string, unknown>) as never);
    expect(L.reason('brand_new_reason')).toBe('⁨brand_new_reason⁩');
    expect(L.sourceType(null)).toBe('—');
  });
});
