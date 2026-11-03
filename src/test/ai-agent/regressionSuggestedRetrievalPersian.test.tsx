/**
 * AI → Advanced tools: Regression runs, Suggested tests and the retrieval
 * debugger speak the panel's language. In Persian no English word of the UI
 * is left on screen: headings, filters, column heads, batch statuses,
 * triggers, frequencies, the schedule's warning, failure reasons, behaviours,
 * source types, where a suggestion came from, the server's default name
 * prefix, the debugger's recommendation, page match and excluded sources,
 * toasts, confirmations and aria-labels. What stays Latin is data: the
 * visitor's words, ids, timezones, URLs, language codes and the raw JSON the
 * search recorded (shown left to right).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { I18nProvider } from '@/i18n';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const toastSpy = vi.hoisted(() => vi.fn());
vi.mock('@/hooks/use-toast', () => ({ toast: toastSpy }));

const WS = { id: 'ws-1', slug: 'acme', name: 'فروشگاه' };
vi.mock('@/hooks/useWorkspace', () => ({
  useActiveWorkspace: () => ({ workspace: WS }),
  useCurrentWorkspace: () => WS,
  useWorkspacePath: () => (path: string) => `/acme${path}`,
}));
vi.mock('@/hooks/useWorkspaceRole', () => ({
  useWorkspaceRole: () => ({ data: 'owner' }),
  isWorkspaceAdmin: () => true,
}));

const SCHEDULE = {
  id: 'sch-1', workspace_id: 'ws-1', enabled: true, name: 'Default regression schedule', frequency: 'daily',
  time_of_day: '03:00', timezone: 'Asia/Tehrn', include_enabled_cases_only: true, max_cases_per_run: 50, call_llm: false,
  last_run_at: '2026-11-02T03:00:00Z', next_run_at: '2026-11-03T03:00:00Z', created_by: null, updated_by: null,
  metadata: { resolved_timezone: 'UTC', warning: 'timezone_invalid_fallback_utc' },
  created_at: '2026-10-01T00:00:00Z', updated_at: '2026-11-02T03:00:00Z',
};
const BATCH = {
  id: 'batch-1', workspace_id: 'ws-1', schedule_id: 'sch-1', status: 'completed', trigger_type: 'scheduled',
  total_cases: 4, passed: 2, failed: 1, errored: 1, pass_rate: 0.5,
  started_at: '2026-11-02T03:00:00Z', finished_at: '2026-11-02T03:02:05Z', last_error: null,
  metadata: { duration_ms: 125_000, avg_case_duration_ms: 4_100, retry_of_batch_id: 'abcdef12-0000-0000-0000-000000000000' },
  created_by: null, created_at: '2026-11-02T03:00:00Z', updated_at: '2026-11-02T03:02:05Z',
};
const RUNNING = {
  ...BATCH, id: 'batch-2', status: 'running', trigger_type: 'manual', passed: 0, failed: 0, errored: 0, pass_rate: null,
  finished_at: null, metadata: { current_case_index: 1, current_test_case_name: 'ساعت کاری' },
};
const OVERVIEW = {
  total_schedules: 1, enabled_schedules: 1, last_batch: BATCH, last_24h_batches: 2, last_24h_pass_rate: 0.5,
  last_7d_pass_rate: 0.6, failed_batches_count: 1, errored_runs_count: 2,
  top_failure_reasons: [
    { reason: 'expected_answer_got_no_answer', count: 3 },
    { reason: 'missing_expected_source_type:kb_article', count: 1 },
  ],
  coverage_by_source_type: [{ source_type: 'kb_article', runs: 4 }, { source_type: 'learned_qna', runs: 2 }],
  next_due_schedule: { id: 'sch-1', name: 'Default regression schedule', next_run_at: '2026-11-03T03:00:00Z', timezone: 'UTC' },
};
const FAILED_RUN = {
  id: 'run-1', workspace_id: 'ws-1', test_case_id: 'case-1', ai_agent_run_id: 'ai-run-1', status: 'failed',
  input_message: 'هزینه ارسال به شیراز چقدر است؟', actual_output: null, actual_status: 'no_answer', confidence: 0.31,
  selected_sources: [{ source_type: 'kb_article', title: 'راهنمای ارسال' }, { source_type: 'qna', title: 'ارسال' }],
  retrieval_debug: null, answer_strategy: null,
  failure_reasons: ['expected_answer_got_no_answer', 'missing_text:تومان', 'low_confidence:0.31<0.6', 'file_url_leak'],
  metadata: {}, created_at: '2026-11-02T03:01:00Z',
  test_case: { name: 'هزینه ارسال', expected_behavior: 'answer', locale: 'fa' },
};
const PASSED_RUN = {
  ...FAILED_RUN, id: 'run-2', status: 'passed', actual_status: 'handoff', failure_reasons: [], selected_sources: [],
  ai_agent_run_id: null, test_case: { name: 'درخواست اپراتور', expected_behavior: 'handoff', locale: 'fa' },
};
const DETAIL = {
  batch: BATCH,
  runs: [FAILED_RUN, PASSED_RUN],
  retryChildren: [{ id: 'batch-3', status: 'queued', passed: 0, failed: 0, errored: 0, pass_rate: null, created_at: '2026-11-02T04:00:00Z', trigger_type: 'manual' }],
  summary: { total: 4, passed: 2, failed: 1, errored: 1, pass_rate: 0.5 },
};

const suggestion = (over: Record<string, unknown>) => ({
  id: 'sug-1', workspace_id: 'ws-1', source_type: 'test_run', source_id: 'run-1', status: 'pending',
  name: 'Failed run: هزینه ارسال به شیراز چقدر است؟', input_message: 'هزینه ارسال به شیراز چقدر است؟', locale: 'fa',
  page_context: null, expected_behavior: 'answer', expected_source_type: 'kb_article', expected_source_url: null,
  expected_source_id: null, expected_contains: ['تومان'], expected_not_contains: [], min_confidence: 0.6,
  reason: 'expected_answer_got_no_answer; missing_text:تومان', metadata: {}, created_by: null, reviewed_by: null,
  reviewed_at: null, created_at: '2026-11-02T03:05:00Z', updated_at: '2026-11-02T03:05:00Z', ...over,
});
const SUGGESTIONS = [
  suggestion({}),
  suggestion({
    id: 'sug-2', source_type: 'operator_assist_feedback', name: 'Assist negative: ساعت کاری شما چیست؟',
    input_message: 'ساعت کاری شما چیست؟', expected_source_type: null, reason: 'wrong_answer — ساعت جمعه اشتباه بود',
  }),
  suggestion({
    id: 'sug-3', status: 'converted', name: 'Errored run: آدرس فروشگاه', input_message: 'آدرس فروشگاه کجاست؟',
    expected_behavior: 'clarification', expected_source_type: 'business_profile', reason: null,
    metadata: { converted_test_case_id: '1234abcd-0000-0000-0000-000000000000' },
  }),
];

const DEBUG = {
  recommendation: 'needs_clarification',
  page_context_debug: {
    current_page_url: 'https://shop.example/shipping', current_page_title: 'ارسال', exact_page_match: true,
    same_path_match: true, same_host_match: true, page_matched_source_ids: ['s1'], page_url_boost_applied: false,
  },
  excluded_summary: { disabled_qna_excluded: 0, draft_kb_excluded: 2, locked_kb_excluded: 1 },
  sources: [
    { id: 's1', source_type: 'kb_article', title: 'راهنمای ارسال', source_url: 'https://shop.example/shipping', locale: 'fa', final_score: 0.41, keyword_score: 0.3, vector_score: 0.5, topic_boost: 0, url_boost: 0.2 },
    { id: 's2', source_type: 'business_profile', title: 'نمایه کسب‌وکار', source_url: null, locale: null, final_score: 0.2, keyword_score: 0.1, vector_score: 0.2, topic_boost: 0, url_boost: 0 },
  ],
  retrieval_debug: { query: { original_message: 'shipping cost' }, execution: { hybrid_used: true } },
};

const api = vi.hoisted(() => ({
  listRegressionSchedules: vi.fn(),
  listRegressionBatches: vi.fn(),
  getRegressionOverview: vi.fn(),
  getOrCreateRegressionSchedule: vi.fn(),
  updateRegressionSchedule: vi.fn(),
  runRegressionNow: vi.fn(),
  getRegressionBatch: vi.fn(),
  cancelRegressionBatch: vi.fn(),
  retryFailedRegressionBatch: vi.fn(),
  suggestTestCaseFromTestRun: vi.fn(),
  regressionBatchCsvUrl: vi.fn((id: string) => `/api/ai-agent/regression/batches/${id}/export.csv`),
  listSuggestedTestCases: vi.fn(),
  acceptSuggestedTestCase: vi.fn(),
  rejectSuggestedTestCase: vi.fn(),
  deleteSuggestedTestCase: vi.fn(),
  debugRetrieval: vi.fn(),
}));
vi.mock('@/lib/ai-agent-api', () => ({ aiAgentApi: api }));

const { default: RegressionRunsPage } = await import('@/pages/app/ai-agent/RegressionRunsPage');
const { default: SuggestedTestsPage } = await import('@/pages/app/ai-agent/SuggestedTestsPage');
const { default: RetrievalDebuggerPage } = await import('@/pages/app/ai-agent/RetrievalDebuggerPage');

class ApiError extends Error {
  code: string;
  constructor(code: string) { super(code); this.code = code; }
}

function resetApi() {
  api.listRegressionSchedules.mockResolvedValue({ items: [SCHEDULE] });
  api.listRegressionBatches.mockResolvedValue({ items: [BATCH, RUNNING], total: 2, limit: 50, offset: 0 });
  api.getRegressionOverview.mockResolvedValue(OVERVIEW);
  api.getRegressionBatch.mockResolvedValue(DETAIL);
  api.updateRegressionSchedule.mockRejectedValue(new ApiError('update_failed'));
  api.runRegressionNow.mockResolvedValue({ batch: RUNNING });
  api.retryFailedRegressionBatch.mockRejectedValue(new ApiError('no_failed_cases'));
  api.suggestTestCaseFromTestRun.mockRejectedValue(new ApiError('duplicate'));
  api.listSuggestedTestCases.mockResolvedValue({ items: SUGGESTIONS });
  api.acceptSuggestedTestCase.mockResolvedValue({ ok: true, test_case_id: '9f8e7d6c-0000-0000-0000-000000000000' });
  api.rejectSuggestedTestCase.mockResolvedValue({ ok: true });
  api.deleteSuggestedTestCase.mockResolvedValue({ ok: true });
  api.debugRetrieval.mockResolvedValue(DEBUG);
}

afterEach(() => { cleanup(); vi.clearAllMocks(); vi.restoreAllMocks(); });

function mount(ui: React.ReactElement, path: string, locale: 'fa' | 'en' | 'tr' = 'fa', setup?: () => void) {
  resetApi();
  setup?.();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const messages = locale === 'fa' ? fa : locale === 'tr' ? tr : en;
  return render(
    <QueryClientProvider client={client}>
      <I18nProvider initialLocale={locale} initialTranslations={messages}>
        <MemoryRouter initialEntries={[path]}>
          <Routes><Route path="/acme/ai-agent/*" element={ui} /></Routes>
        </MemoryRouter>
      </I18nProvider>
    </QueryClientProvider>,
  );
}

/** Latin words a person reads: text outside data (pre, code, LTR runs, isolates) and every label attribute. */
function englishWords(root: HTMLElement, allowed: string[] = []): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('pre, code, [dir="ltr"], script, style').forEach((el) => el.remove());
  // The shared dialog's screen-reader "Close" (src/components/ui/dialog.tsx) is every dialog's, not these pages'.
  clone.querySelectorAll('[data-slot="dialog-close"]').forEach((el) => el.remove());
  const texts = [clone.textContent || ''];
  root.querySelectorAll('*').forEach((el) => {
    for (const attr of ['aria-label', 'title', 'placeholder']) {
      const value = el.getAttribute(attr);
      if (value) texts.push(value);
    }
  });
  const words = texts.join(' \n ').replace(/⁨[^⁩]*⁩/g, ' ').match(/[A-Za-z]{2,}/g) || [];
  return words.filter((w) => !allowed.includes(w));
}

/** Persian digits read back as Latin ones: the panel shows numbers in Persian digits (src/lib/persian-digits.ts). */
function latin(value: string): string {
  return value.replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)));
}

function pageText(root: HTMLElement = document.body): string {
  return latin(root.textContent || '');
}

function toastWords(allowed: string[] = []): string[] {
  const text = toastSpy.mock.calls
    .map(([arg]) => `${(arg as { title?: string }).title ?? ''} ${(arg as { description?: string }).description ?? ''}`)
    .join(' ')
    .replace(/⁨[^⁩]*⁩/g, ' ');
  return (text.match(/[A-Za-z]{2,}/g) || []).filter((w) => !allowed.includes(w));
}

describe('Regression runs in Persian', () => {
  it('no English word on the page; statuses, triggers, failure reasons, source types and the warning in words', async () => {
    mount(<RegressionRunsPage />, '/acme/ai-agent/regression-runs');
    const R = fa.aiAgent.adv.regression;
    await screen.findByText(R.title);
    await waitFor(() => expect(document.body.textContent).toContain(R.status.running));
    const text = pageText();
    for (const expected of [
      R.title, R.subtitle, R.schedule.title, R.schedule.enabled, R.schedule.callLlmHint, R.frequency.daily,
      R.schedule.warnings.timezone_invalid_fallback_utc, R.summary.enabledSchedules, R.summary.passRate24h,
      R.status.completed, R.status.running, R.trigger.scheduled, R.trigger.manual, R.history.title,
      R.history.cols.passRate, R.history.filters.onlyFailed, R.topFailures.title,
      fa.aiAgent.codes.sourceType.kb_article, fa.aiAgent.codes.sourceType.learned_qna,
      '1 از 1', '1 از 4',
    ]) {
      expect(text, expected).toContain(latin(expected));
    }
    expect(text).toContain(fa.aiAgent.adv.testRun.failure.expectedAnswerGot.replace('{{actual}}', fa.aiAgent.adv.testRun.actualStatus.no_answer));
    for (const raw of ['Regression', 'Schedule', 'expected_answer_got', 'kb_article', 'scheduled', 'completed', 'timezone_invalid', 'Batch history']) {
      expect(text, raw).not.toContain(raw);
    }
    expect(screen.getByRole('combobox', { name: R.history.filters.status })).toBeTruthy();
    expect(screen.getByRole('switch', { name: R.schedule.callLlm })).toBeTruthy();
    expect(englishWords(document.body)).toEqual([]);
  });

  it('the batch dialog: runs, expected and actual, failure reasons and links in Persian', async () => {
    mount(<RegressionRunsPage />, '/acme/ai-agent/regression-runs');
    const R = fa.aiAgent.adv.regression;
    const T = fa.aiAgent.adv.testRun;
    await screen.findByText(R.history.title);
    const openButtons = await screen.findAllByRole('button', { name: R.history.open });
    await act(async () => { fireEvent.click(openButtons[0]); });
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('هزینه ارسال');
    const text = pageText(dialog);
    for (const expected of [
      R.batch.title, R.batch.cols.compare, R.batch.cols.failureReasons, R.batch.links.detail, R.batch.links.retrieval,
      R.batch.links.inspector, R.batch.suggest, R.batch.exportCsv, R.batch.retry, R.batch.retryChildren,
      R.status.queued, T.status.failed, T.status.passed, T.behavior.answer, T.behavior.handoff, T.actualStatus.no_answer,
      T.failure.fileUrlLeak, T.failure.lowConfidence.replace('{{actual}}', '0.31').replace('{{min}}', '0.6'),
      fa.aiAgent.codes.sourceType.qna,
      '2 دقیقه و 5 ثانیه', '4 ثانیه',
    ]) {
      expect(text, expected).toContain(latin(expected));
    }
    for (const raw of ['Exp:', 'Act:', 'no_answer', 'file_url_leak', 'Retrieval', 'Inspector', 'Detail', 'Suggest']) {
      expect(text, raw).not.toContain(raw);
    }
    const detail = within(dialog).getAllByRole('link', { name: R.batch.links.retrieval })[0];
    expect(detail.getAttribute('href')).toContain('/acme/ai-agent/debug/retrieval?message=');
    expect(englishWords(dialog, ['CSV'])).toEqual([]);

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: R.batch.retry })); });
    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: R.batch.suggest })); });
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ title: R.toast.retryFailed, description: R.toast.noFailedCases });
    expect(toastSpy.mock.calls[1][0]).toMatchObject({ title: R.toast.suggestFailed, description: R.toast.duplicate });
    expect(toastWords()).toEqual([]);
  });

  it('saving and running the schedule toast in Persian', async () => {
    mount(<RegressionRunsPage />, '/acme/ai-agent/regression-runs');
    const R = fa.aiAgent.adv.regression;
    await screen.findByRole('button', { name: R.schedule.save });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: R.schedule.save })); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: R.schedule.runNow })); });
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));
    expect(toastSpy.mock.calls[0][0]).toMatchObject({ title: R.toast.saveFailed, description: R.errors.update_failed });
    expect(toastSpy.mock.calls[1][0]).toMatchObject({ title: R.toast.batchQueued, description: R.toast.batchQueuedDesc });
    expect(toastWords()).toEqual([]);
  });

  it('in Turkish the statuses and the page are Turkish', async () => {
    mount(<RegressionRunsPage />, '/acme/ai-agent/regression-runs', 'tr');
    await screen.findByText(tr.aiAgent.adv.regression.title);
    await waitFor(() => expect(document.body.textContent).toContain(tr.aiAgent.adv.regression.status.running));
    expect(document.body.textContent).toContain(tr.aiAgent.adv.regression.schedule.warnings.timezone_invalid_fallback_utc);
  });
});

describe('Suggested tests in Persian', () => {
  it('no English word on the page; status, origin, name prefix and reasons in words', async () => {
    mount(<SuggestedTestsPage />, '/acme/ai-agent/suggested-tests');
    const S = fa.aiAgent.adv.suggested;
    const T = fa.aiAgent.adv.testRun;
    await screen.findByText(`${S.namePrefix.failedRun}: هزینه ارسال به شیراز چقدر است؟`);
    const text = pageText();
    for (const expected of [
      S.title, S.subtitle, S.tabs.pending, S.tabs.converted, S.tabs.rejected, S.tabs.all,
      `${S.namePrefix.assistNegative}: ساعت کاری شما چیست؟`, `${S.namePrefix.erroredRun}: آدرس فروشگاه`,
      S.status.pending, S.status.converted, S.origin.test_run, S.origin.operator_assist_feedback,
      T.behavior.answer, T.behavior.clarification, T.sourceTypeBusinessProfile, fa.aiAgent.codes.sourceType.kb_article,
      fa.aiAgent.codes.feedbackReason.wrong_answer, 'ساعت جمعه اشتباه بود', S.convertedTo,
      T.failure.expectedAnswerGot.replace('{{actual}}', T.actualStatus.no_answer),
      S.listTitle.replace('{{tab}}', S.tabs.pending).replace('{{count}}', '3'),
    ]) {
      expect(text, expected).toContain(latin(expected));
    }
    for (const raw of ['Failed run', 'Assist negative', 'Errored run', 'wrong_answer', 'test_run', 'operator_assist', 'pending', 'Reason:']) {
      expect(text, raw).not.toContain(raw);
    }
    expect(screen.getAllByRole('button', { name: S.actions.delete }).length).toBe(3);
    expect(screen.getAllByRole('button', { name: S.actions.reject }).length).toBe(2);
    expect(englishWords(document.body)).toEqual([]);
  });

  it('the review dialog: labels and options in Persian, the name in the panel language; the toast too', async () => {
    mount(<SuggestedTestsPage />, '/acme/ai-agent/suggested-tests');
    const S = fa.aiAgent.adv.suggested;
    const T = fa.aiAgent.adv.testRun;
    await screen.findByText(`${S.namePrefix.failedRun}: هزینه ارسال به شیراز چقدر است؟`);
    fireEvent.click(screen.getAllByRole('button', { name: new RegExp(S.actions.accept) })[0]);
    const dialog = await screen.findByRole('dialog');
    expect(dialog.textContent).toContain(S.dialog.title);
    expect(within(dialog).getByRole('option', { name: T.behavior.no_answer })).toBeTruthy();
    expect(within(dialog).getByRole('option', { name: S.dialog.anySource })).toBeTruthy();
    expect(within(dialog).getByRole('option', { name: T.sourceTypeBusinessProfile })).toBeTruthy();
    expect((within(dialog).getByLabelText(S.dialog.name) as HTMLInputElement).value)
      .toBe(`${S.namePrefix.failedRun}: هزینه ارسال به شیراز چقدر است؟`);
    expect(englishWords(dialog)).toEqual([]);

    await act(async () => { fireEvent.click(within(dialog).getByRole('button', { name: S.dialog.save })); });
    await waitFor(() => expect(toastSpy).toHaveBeenCalled());
    expect(api.acceptSuggestedTestCase).toHaveBeenCalledWith('sug-1', expect.objectContaining({ expected_behavior: 'answer', expected_source_type: 'kb_article' }));
    expect(toastSpy.mock.calls[0][0].title).toBe(S.toast.created);
    expect(toastWords()).toEqual([]);
  });

  it('reject and delete ask in Persian', async () => {
    const promptSpy = vi.spyOn(window, 'prompt').mockReturnValue('');
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    mount(<SuggestedTestsPage />, '/acme/ai-agent/suggested-tests');
    const S = fa.aiAgent.adv.suggested;
    await screen.findByText(`${S.namePrefix.failedRun}: هزینه ارسال به شیراز چقدر است؟`);
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: S.actions.reject })[0]); });
    await act(async () => { fireEvent.click(screen.getAllByRole('button', { name: S.actions.delete })[0]); });
    expect(promptSpy).toHaveBeenCalledWith(S.rejectPrompt);
    expect(confirmSpy).toHaveBeenCalledWith(S.confirmDelete);
    await waitFor(() => expect(toastSpy).toHaveBeenCalledTimes(2));
    expect(toastSpy.mock.calls.map(([arg]) => arg.title)).toEqual([S.toast.rejected, S.toast.deleted]);
  });
});

describe('The retrieval debugger in Persian', () => {
  it('no English word on the page; recommendation, page match, excluded sources and columns in words', async () => {
    mount(<RetrievalDebuggerPage />, '/acme/ai-agent/debug/retrieval?message=%D9%87%D8%B2%DB%8C%D9%86%D9%87&locale=fa');
    const D = fa.aiAgent.adv.retrievalDebug;
    const T = fa.aiAgent.adv.testRun;
    expect(englishWords(document.body)).toEqual([]);
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: D.form.run })); });
    await screen.findByText(D.sources.title);
    expect(api.debugRetrieval).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: 'ws-1', message: 'هزینه', locale: 'fa', pageContext: null }));
    const text = pageText();
    for (const expected of [
      D.title, D.subtitle, D.recommendation.title, D.recommendation.needs_clarification, D.pageMatch.title,
      `${D.pageMatch.exact}: ${T.yes}`, `${D.pageMatch.boost}: ${T.no}`, D.excluded.title, T.excluded.draft_kb_excluded,
      T.excluded.locked_kb_excluded, D.sources.cols.final, D.sources.cols.keyword, D.sources.cols.urlBoost,
      fa.aiAgent.codes.sourceType.kb_article, T.sourceTypeBusinessProfile, D.why.title,
    ]) {
      expect(text, expected).toContain(latin(expected));
    }
    expect(text).not.toContain(T.excluded.disabled_qna_excluded);
    for (const raw of ['needs_clarification', 'draft_kb_excluded', 'Ranked sources', 'Why this won', 'Page match', 'kw', 'vec']) {
      expect(text, raw).not.toContain(raw);
    }
    document.querySelectorAll('pre').forEach((pre) => {
      expect(pre).toHaveAttribute('dir', 'ltr');
      expect(pre).toHaveAttribute('data-latin-digits');
    });
    expect(screen.getByRole('textbox', { name: D.form.pageUrl })).toBeTruthy();
    expect(englishWords(document.body)).toEqual([]);
  });

  it('a refused run reads as a Persian sentence', async () => {
    mount(<RetrievalDebuggerPage />, '/acme/ai-agent/debug/retrieval?message=x');
    api.debugRetrieval.mockRejectedValue(new ApiError('debug_rate_limited'));
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: fa.aiAgent.adv.retrievalDebug.form.run })); });
    await screen.findByText(fa.aiAgent.adv.retrievalDebug.errors.debug_rate_limited);
    expect(document.body.textContent).not.toContain('debug_rate_limited');
  });

  it('in Turkish the recommendation is Turkish', async () => {
    mount(<RetrievalDebuggerPage />, '/acme/ai-agent/debug/retrieval?message=kargo', 'tr');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: tr.aiAgent.adv.retrievalDebug.form.run })); });
    await screen.findByText(tr.aiAgent.adv.retrievalDebug.recommendation.needs_clarification);
  });
});

/** snake_case codes anywhere in the text, isolated runs included: a code no map knew would show as one. */
function rawCodes(root: HTMLElement, allowed: string[] = []): string[] {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('pre').forEach((el) => el.remove());
  return ((clone.textContent || '').match(/[a-z0-9]+(?:_[a-z0-9]+)+/g) || []).filter((w) => !allowed.includes(w));
}

describe('failure reasons the regression runner and the overview send', () => {
  it('the overview counts a reason by its code before ":" and the runner\'s own error: each one in words', async () => {
    const R = fa.aiAgent.adv.regression;
    mount(<RegressionRunsPage />, '/acme/ai-agent/regression-runs', 'fa', () => {
      api.getRegressionOverview.mockResolvedValue({
        ...OVERVIEW,
        // server/services/ai-agent/regressionRunner.ts: String(reason).split(':')[0]
        top_failure_reasons: [
          'missing_text', 'forbidden_text', 'low_confidence', 'missing_expected_source_type',
          'unsupported_expected_source_type', 'runner_unhandled', 'expected_handoff_got_answer',
        ].map((reason, i) => ({ reason, count: 7 - i })),
      });
    });
    await screen.findByText(R.topFailures.title);
    const text = pageText();
    for (const expected of [
      R.failureGroup.missing_text, R.failureGroup.forbidden_text, R.failureGroup.low_confidence,
      R.failureGroup.missing_expected_source_type, R.failureGroup.unsupported_expected_source_type,
      R.failureGroup.runner_unhandled,
    ]) {
      expect(text, expected).toContain(expected);
    }
    expect(text).not.toContain(fa.aiAgent.adv.testRun.failure.errorDetail.replace('{{detail}}', ''));
    expect(rawCodes(document.body)).toEqual([]);
  });

  it('a case the runner could not run reads as a sentence in the batch dialog', async () => {
    const R = fa.aiAgent.adv.regression;
    mount(<RegressionRunsPage />, '/acme/ai-agent/regression-runs', 'fa', () => {
      api.getRegressionBatch.mockResolvedValue({
        ...DETAIL,
        runs: [{ ...FAILED_RUN, status: 'errored', actual_status: 'failed', failure_reasons: ['runner_unhandled:boom'] }],
      });
    });
    const openButtons = await screen.findAllByRole('button', { name: R.history.open });
    await act(async () => { fireEvent.click(openButtons[0]); });
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByText('هزینه ارسال');
    expect(dialog.textContent).toContain(R.failureGroup.runnerUnhandledDetail.replace('{{detail}}', '\u2068boom\u2069'));
    expect(rawCodes(dialog)).toEqual([]);
  });

  it('a suggestion\'s reasons keep an expected text holding "; " whole', async () => {
    const T = fa.aiAgent.adv.testRun;
    mount(<SuggestedTestsPage />, '/acme/ai-agent/suggested-tests', 'fa', () => {
      api.listSuggestedTestCases.mockResolvedValue({
        items: [suggestion({ reason: 'missing_text:price; shipping; low_confidence:0.20<0.6; runner_unhandled:x' })],
      });
    });
    await screen.findByText(`${fa.aiAgent.adv.suggested.namePrefix.failedRun}: هزینه ارسال به شیراز چقدر است؟`);
    const text = pageText();
    expect(text).toContain(T.failure.missingText.replace('{{text}}', '\u2068price; shipping\u2069'));
    expect(text).toContain(T.failure.lowConfidence.replace('{{actual}}', '0.20').replace('{{min}}', '0.6'));
    expect(text).toContain(fa.aiAgent.adv.regression.failureGroup.runnerUnhandledDetail.replace('{{detail}}', '\u2068x\u2069'));
    expect(text).not.toContain(T.failure.errorDetail.replace('{{detail}}', ''));
    expect(rawCodes(document.body)).toEqual([]);
  });
});

describe('the words of these pages in the three languages', () => {
  const NAMESPACES = ['regression', 'suggested', 'retrievalDebug'] as const;
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
    expect(keys.length).toBeGreaterThan(200);
    expect(Object.keys(words(fa)).sort()).toEqual(keys);
    expect(Object.keys(words(tr)).sort()).toEqual(keys);
    for (const messages of [en, fa, tr]) {
      for (const [key, value] of Object.entries(words(messages))) expect(value.trim(), key).not.toBe('');
    }
  });

  it('every Persian text is Persian (placeholders and the CSV format aside), with the same placeholders as English', () => {
    const enWords = words(en);
    const params = (s: string) => (s.match(/\{\{\w+\}\}/g) || []).sort();
    for (const [key, value] of Object.entries(words(fa))) {
      expect(value.replace(/\{\{\w+\}\}/g, '').replace(/\bCSV\b/g, ''), key).not.toMatch(/[A-Za-z]{2,}/);
      expect(params(value), key).toEqual(params(enWords[key]));
    }
    for (const [key, value] of Object.entries(words(tr))) {
      expect(params(value), key).toEqual(params(enWords[key]));
    }
  });
});
