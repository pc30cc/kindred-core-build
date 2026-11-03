/**
 * The words of the AI section's test tools (Advanced tools: Test cases, a
 * test run, the run inspector), one place for the codes the API sends back:
 * behaviours, run statuses, strategy reasons, failure reasons, safety notes,
 * seed results and errors. Every code is shown as a sentence in the panel's
 * language, never as raw snake_case (aiAgent.adv.testRun.*); a code no map
 * knows yet is shown as itself, isolated so it reads correctly inside
 * Persian.
 */
import { useMemo } from 'react';
import { useTranslation, type TranslationKey } from '@/i18n';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

/** A Latin run (a code, a URL, an error text, the visitor's words) kept in its own direction inside RTL text. */
export function isolate(value: string): string {
  return `⁨${value}⁩`;
}

function pick(map: Record<string, string>, code: string | null | undefined): string {
  if (code == null || code === '') return '—';
  return Object.prototype.hasOwnProperty.call(map, code) ? map[code] : isolate(code);
}

/** The English names server/routes/ai-agent/internalQa.ts (seed-recommended) gives the recommended test cases. */
const SEEDED_UNKNOWN_QUESTION = 'Unknown question (no answer expected)';
const SEEDED_NAME_PREFIXES: ReadonlyArray<readonly [string, TranslationKey]> = [
  ['Q&A coverage: ', 'aiAgent.adv.testCases.seededName.qna'],
  ['Learned answer: ', 'aiAgent.adv.testCases.seededName.learnedQna'],
  ['KB article: ', 'aiAgent.adv.testCases.seededName.kbArticle'],
  ['File coverage: ', 'aiAgent.adv.testCases.seededName.file'],
  ['Web page: ', 'aiAgent.adv.testCases.seededName.webPage'],
];

/** An error's code: AiAgentApiError keeps it in `code`, its message is the same code or `request_failed_<status>`. */
function errorCode(error: unknown): string {
  if (!error || typeof error !== 'object') return '';
  const record = error as { code?: unknown; message?: unknown };
  if (typeof record.code === 'string' && record.code) return record.code;
  return typeof record.message === 'string' ? record.message : '';
}

export function buildTestRunLabels(t: Translate) {
  const behaviorMap: Record<string, string> = {
    answer: t('aiAgent.adv.testRun.behavior.answer'),
    no_answer: t('aiAgent.adv.testRun.behavior.no_answer'),
    handoff: t('aiAgent.adv.testRun.behavior.handoff'),
    clarification: t('aiAgent.adv.testRun.behavior.clarification'),
  };
  const statusMap: Record<string, string> = {
    passed: t('aiAgent.adv.testRun.status.passed'),
    failed: t('aiAgent.adv.testRun.status.failed'),
    errored: t('aiAgent.adv.testRun.status.errored'),
  };
  const actualStatusMap: Record<string, string> = {
    replied: t('aiAgent.adv.testRun.actualStatus.replied'),
    no_answer: t('aiAgent.adv.testRun.actualStatus.no_answer'),
    handoff: t('aiAgent.adv.testRun.actualStatus.handoff'),
    clarification: t('aiAgent.adv.testRun.actualStatus.clarification'),
    failed: t('aiAgent.adv.testRun.actualStatus.failed'),
  };
  const reasonMap: Record<string, string> = {
    human_request: t('aiAgent.adv.testRun.reason.human_request'),
    conflicting_sources: t('aiAgent.adv.testRun.reason.conflicting_sources'),
    exact_qna_match: t('aiAgent.adv.testRun.reason.exact_qna_match'),
    strong_kb_match: t('aiAgent.adv.testRun.reason.strong_kb_match'),
    medium_kb_match: t('aiAgent.adv.testRun.reason.medium_kb_match'),
    weak_evidence_only: t('aiAgent.adv.testRun.reason.weak_evidence_only'),
    workspace_settings_match: t('aiAgent.adv.testRun.reason.workspace_settings_match'),
    no_verified_info_silent: t('aiAgent.adv.testRun.reason.no_verified_info_silent'),
    insufficient_verified_info_requires_human: t('aiAgent.adv.testRun.reason.insufficient_verified_info_requires_human'),
    owner_policy_low_confidence: t('aiAgent.adv.testRun.reason.owner_policy_low_confidence'),
    no_verified_evidence: t('aiAgent.adv.testRun.reason.no_verified_evidence'),
    retrieval_failed: t('aiAgent.adv.testRun.reason.retrieval_failed'),
    // A live run's own (engine/answerStage.ts): the page-aware override and
    // the off-topic decline, which the run inspector shows.
    page_context_match: t('aiAgent.adv.testRun.reason.page_context_match'),
    no_url: t('aiAgent.adv.testRun.reason.no_url'),
    no_indexed_page: t('aiAgent.adv.testRun.reason.no_indexed_page'),
    topic_decline: t('aiAgent.adv.testRun.reason.topic_decline'),
    topic_decline_semantic: t('aiAgent.adv.testRun.reason.topic_decline_semantic'),
  };
  const decisionTypeMap: Record<string, string> = {
    answer: t('aiAgent.adv.testRun.decisionType.answer'),
    answer_with_caveat: t('aiAgent.adv.testRun.decisionType.answer_with_caveat'),
    ask_clarifying_question: t('aiAgent.adv.testRun.decisionType.ask_clarifying_question'),
    safe_guidance: t('aiAgent.adv.testRun.decisionType.safe_guidance'),
    greeting: t('aiAgent.adv.testRun.decisionType.greeting'),
    handoff: t('aiAgent.adv.testRun.decisionType.handoff'),
    no_answer_silent: t('aiAgent.adv.testRun.decisionType.no_answer_silent'),
    no_answer: t('aiAgent.adv.testRun.decisionType.no_answer'),
    declined: t('aiAgent.adv.testRun.decisionType.declined'),
    failed: t('aiAgent.adv.testRun.decisionType.failed'),
  };
  const strengthMap: Record<string, string> = {
    none: t('aiAgent.adv.testRun.strength.none'),
    weak: t('aiAgent.adv.testRun.strength.weak'),
    medium: t('aiAgent.adv.testRun.strength.medium'),
    strong: t('aiAgent.adv.testRun.strength.strong'),
    exact_qna: t('aiAgent.adv.testRun.strength.exact_qna'),
    page_exact_match: t('aiAgent.adv.testRun.strength.page_exact_match'),
    page_path_match: t('aiAgent.adv.testRun.strength.page_path_match'),
  };
  const sourceTypeMap: Record<string, string> = {
    qna: t('aiAgent.codes.sourceType.qna'),
    learned_qna: t('aiAgent.codes.sourceType.learned_qna'),
    kb_article: t('aiAgent.codes.sourceType.kb_article'),
    web_page: t('aiAgent.codes.sourceType.web_page'),
    website: t('aiAgent.codes.sourceType.website'),
    file: t('aiAgent.codes.sourceType.file'),
    business_profile: t('aiAgent.adv.testRun.sourceTypeBusinessProfile'),
  };
  const runtimeKeyMap: Record<string, string> = {
    conversation_created: t('aiAgent.adv.testRun.runtime.conversation_created'),
    handoff_created: t('aiAgent.adv.testRun.runtime.handoff_created'),
    workflow_executed: t('aiAgent.adv.testRun.runtime.workflow_executed'),
    learning_candidate_created: t('aiAgent.adv.testRun.runtime.learning_candidate_created'),
    llm_called: t('aiAgent.adv.testRun.runtime.llm_called'),
    ai_usage_logged: t('aiAgent.adv.testRun.runtime.ai_usage_logged'),
  };
  const parityKeyMap: Record<string, string> = {
    retrieval: t('aiAgent.adv.testRun.parity.retrieval'),
    query_expansion: t('aiAgent.adv.testRun.parity.query_expansion'),
    conversation_history: t('aiAgent.adv.testRun.parity.conversation_history'),
    workflow_execution: t('aiAgent.adv.testRun.parity.workflow_execution'),
    handoff_execution: t('aiAgent.adv.testRun.parity.handoff_execution'),
    learning_generation: t('aiAgent.adv.testRun.parity.learning_generation'),
  };
  const parityValueMap: Record<string, string> = {
    real_hybrid_retrieval: t('aiAgent.adv.testRun.parity.real_hybrid_retrieval'),
    used: t('aiAgent.adv.testRun.parity.used'),
    not_used: t('aiAgent.adv.testRun.parity.not_used'),
    disabled: t('aiAgent.adv.testRun.parity.disabled'),
  };
  const excludedMap: Record<string, string> = {
    disabled_qna_excluded: t('aiAgent.adv.testRun.excluded.disabled_qna_excluded'),
    draft_kb_excluded: t('aiAgent.adv.testRun.excluded.draft_kb_excluded'),
    cross_workspace_excluded: t('aiAgent.adv.testRun.excluded.cross_workspace_excluded'),
    inactive_file_excluded: t('aiAgent.adv.testRun.excluded.inactive_file_excluded'),
    inactive_web_page_excluded: t('aiAgent.adv.testRun.excluded.inactive_web_page_excluded'),
    unapproved_learned_qna_excluded: t('aiAgent.adv.testRun.excluded.unapproved_learned_qna_excluded'),
    locked_kb_excluded: t('aiAgent.adv.testRun.excluded.locked_kb_excluded'),
    inactive_chunks_excluded: t('aiAgent.adv.testRun.excluded.inactive_chunks_excluded'),
    pending_candidates_excluded: t('aiAgent.adv.testRun.excluded.pending_candidates_excluded'),
  };
  const seedSkipMap: Record<string, string> = {
    no_active_chunks: t('aiAgent.adv.testCases.seedSkip.no_active_chunks'),
    no_eligible_row: t('aiAgent.adv.testCases.seedSkip.no_eligible_row'),
    no_approved_row: t('aiAgent.adv.testCases.seedSkip.no_approved_row'),
    no_question_text: t('aiAgent.adv.testCases.seedSkip.no_question_text'),
    no_published_row: t('aiAgent.adv.testCases.seedSkip.no_published_row'),
    no_active_source_row: t('aiAgent.adv.testCases.seedSkip.no_active_source_row'),
    no_active_parent_website: t('aiAgent.adv.testCases.seedSkip.no_active_parent_website'),
  };
  const errorMap: Record<string, string> = {
    owner_or_admin_required: t('aiAgent.adv.testCases.errors.owner_or_admin_required'),
    operator_permission_required: t('aiAgent.adv.testCases.errors.operator_permission_required'),
    not_found: t('aiAgent.adv.testCases.errors.not_found'),
    run_not_found: t('aiAgent.adv.testCases.errors.not_found'),
    invalid_id: t('aiAgent.adv.testCases.errors.invalid_params'),
    invalid_params: t('aiAgent.adv.testCases.errors.invalid_params'),
    create_failed: t('aiAgent.adv.testCases.errors.create_failed'),
    update_failed: t('aiAgent.adv.testCases.errors.update_failed'),
    delete_failed: t('aiAgent.adv.testCases.errors.delete_failed'),
    test_rate_limited: t('aiAgent.adv.testCases.errors.rate_limited'),
    bulk_test_rate_limited: t('aiAgent.adv.testCases.errors.rate_limited'),
    bulk_too_many_cases: t('aiAgent.adv.testCases.errors.bulk_too_many_cases'),
    run_failed: t('aiAgent.adv.testCases.errors.run_failed'),
    seed_failed: t('aiAgent.adv.testCases.errors.seed_failed'),
    network_error: t('aiAgent.adv.testCases.errors.network_error'),
    duplicate: t('aiAgent.adv.testRun.toast.duplicate'),
    run_not_failed: t('aiAgent.adv.testRun.toast.runNotFailed'),
    no_input_message: t('aiAgent.adv.testRun.toast.noInputMessage'),
  };

  const behavior = (code: string | null | undefined) => pick(behaviorMap, code);
  const actualStatus = (code: string | null | undefined) => pick(actualStatusMap, code);
  const sourceType = (code: string | null | undefined) => pick(sourceTypeMap, code);

  /** One failure reason of a run (server/services/ai-agent/testHarness.ts evaluateExpectations, the run's own error). */
  const failureReason = (code: string): string => {
    let m: RegExpExecArray | null;
    // 'replied' with no text: the reply came back empty.
    if (code === 'expected_answer_got_replied') return t('aiAgent.adv.testRun.failure.expectedAnswerEmpty');
    if ((m = /^expected_answer_got_(.+)$/.exec(code))) {
      return t('aiAgent.adv.testRun.failure.expectedAnswerGot', { actual: actualStatus(m[1]) });
    }
    if ((m = /^strategy_(.+)_for_expected_answer$/.exec(code))) {
      return t('aiAgent.adv.testRun.failure.strategyForExpectedAnswer', { action: behavior(m[1]) });
    }
    if ((m = /^expected_(no_answer|handoff|clarification)_got_(.+)$/.exec(code))) {
      return t('aiAgent.adv.testRun.failure.expectedBehaviorGot', { expected: behavior(m[1]), actual: behavior(m[2]) });
    }
    if ((m = /^unsupported_expected_source_type:(.*)$/.exec(code))) {
      return t('aiAgent.adv.testRun.failure.unsupportedSourceType', { type: sourceType(m[1]) });
    }
    if ((m = /^missing_expected_source_type:(.*)$/.exec(code))) {
      return t('aiAgent.adv.testRun.failure.missingSourceType', { type: sourceType(m[1]) });
    }
    if ((m = /^missing_text:(.*)$/s.exec(code))) {
      return t('aiAgent.adv.testRun.failure.missingText', { text: isolate(m[1]) });
    }
    if ((m = /^forbidden_text:(.*)$/s.exec(code))) {
      return t('aiAgent.adv.testRun.failure.forbiddenText', { text: isolate(m[1]) });
    }
    if ((m = /^low_confidence:([\d.]+)<([\d.]+)$/.exec(code))) {
      return t('aiAgent.adv.testRun.failure.lowConfidence', { actual: m[1], min: m[2] });
    }
    switch (code) {
      case 'missing_expected_source_url': return t('aiAgent.adv.testRun.failure.missingSourceUrl');
      case 'missing_expected_source_id': return t('aiAgent.adv.testRun.failure.missingSourceId');
      case 'file_url_leak': return t('aiAgent.adv.testRun.failure.fileUrlLeak');
      case 'file_url_leak_debug': return t('aiAgent.adv.testRun.failure.fileUrlLeakDebug');
      case 'sensitive_metadata_leak': return t('aiAgent.adv.testRun.failure.sensitiveMetadataLeak');
      case 'prompt_preview_leak': return t('aiAgent.adv.testRun.failure.promptPreviewLeak');
      case 'errored': return t('aiAgent.adv.testRun.failure.errored');
      case 'retrieval_failed': return t('aiAgent.adv.testRun.failure.retrievalFailed');
      case 'no_ai_provider_configured': return t('aiAgent.adv.testRun.failure.noAiProvider');
      case 'llm_call_failed': return t('aiAgent.adv.testRun.failure.llmCallFailed');
      default: return t('aiAgent.adv.testRun.failure.errorDetail', { detail: isolate(code) });
    }
  };

  /** One safety note of a test run (testHarness) or of an inspected run (`<excluded key>=<count>`). */
  const safetyNote = (note: string): string => {
    let m: RegExpExecArray | null;
    if ((m = /^([a-z_]+_excluded)=(\d+)$/.exec(note)) && excludedMap[m[1]]) {
      return t('aiAgent.adv.testRun.safety.excludedCount', { label: excludedMap[m[1]], count: m[2] });
    }
    if ((m = /^retrieval_error:(.*)$/s.exec(note))) {
      return t('aiAgent.adv.testRun.safety.retrievalError', { detail: isolate(m[1]) });
    }
    if ((m = /^llm_error:(.*)$/s.exec(note))) {
      return t('aiAgent.adv.testRun.safety.llmError', { detail: isolate(m[1]) });
    }
    if (note === 'llm_call_skipped') return t('aiAgent.adv.testRun.safety.llmCallSkipped');
    if (note === 'no_ai_provider_configured') return t('aiAgent.adv.testRun.failure.noAiProvider');
    return isolate(note);
  };

  /**
   * A test case's name. The names the server gives recommended cases
   * (internalQa.ts seed-recommended: "KB article: <title>", "Unknown question
   * (no answer expected)", …) are written in English; they read in the
   * panel's language, the title kept as written (isolated when `isolateTitle`,
   * for display; plain for an edit form, whose value is saved). Any other
   * name is the member's own and shows as written.
   */
  const seededCaseName = (name: string, isolateTitle: boolean): string | null => {
    if (name === SEEDED_UNKNOWN_QUESTION) return t('aiAgent.adv.testCases.seededName.unknownQuestion');
    for (const [prefix, key] of SEEDED_NAME_PREFIXES) {
      if (name.startsWith(prefix) && name.length > prefix.length) {
        const title = name.slice(prefix.length);
        return t(key, { title: isolateTitle ? isolate(title) : title });
      }
    }
    return null;
  };
  const caseName = (name: string | null | undefined): string => (name ? seededCaseName(name, true) ?? name : '');
  const caseNameForEdit = (name: string | null | undefined): string => (name ? seededCaseName(name, false) ?? name : '');

  /**
   * A recommended test the seed skipped: `<source type>:<why>`, or
   * `duplicate:<the case's name>` (the name may hold colons of its own).
   */
  const seedSkip = (code: string): string => {
    const at = code.indexOf(':');
    if (at < 0) return isolate(code);
    const head = code.slice(0, at);
    const rest = code.slice(at + 1);
    if (head === 'duplicate') {
      return t('aiAgent.adv.testCases.seedSkip.duplicate', { name: seededCaseName(rest, true) ?? isolate(rest) });
    }
    if (!rest) return isolate(code);
    return t('aiAgent.adv.testCases.seedSkip.item', { type: sourceType(head), reason: pick(seedSkipMap, rest) });
  };

  /** A refused request, as a sentence (never the server's code). */
  const error = (e: unknown): string => {
    const code = errorCode(e);
    return Object.prototype.hasOwnProperty.call(errorMap, code) ? errorMap[code] : t('aiAgent.adv.testCases.errors.generic');
  };

  const yesNo = (value: unknown): string => {
    if (value === true) return t('aiAgent.adv.testRun.yes');
    if (value === false) return t('aiAgent.adv.testRun.no');
    if (value === 'unknown') return t('aiAgent.adv.testRun.unknown');
    return value == null ? '—' : isolate(String(value));
  };

  return {
    behavior,
    status: (code: string | null | undefined) => pick(statusMap, code),
    actualStatus,
    reason: (code: string | null | undefined) => pick(reasonMap, code),
    decisionType: (code: string | null | undefined) => pick(decisionTypeMap, code),
    strength: (code: string | null | undefined) => pick(strengthMap, code),
    sourceType,
    runtimeKey: (code: string) => pick(runtimeKeyMap, code),
    parityKey: (code: string) => pick(parityKeyMap, code),
    parityValue: (code: string) => pick(parityValueMap, code),
    excludedKey: (code: string) => pick(excludedMap, code),
    failureReason,
    failureReasons: (codes: string[] | null | undefined) => (codes || []).map(failureReason).join(t('aiAgent.adv.testRun.listSeparator')),
    safetyNote,
    seedSkip,
    caseName,
    caseNameForEdit,
    error,
    yesNo,
    list: (items: string[]) => items.join(t('aiAgent.adv.testRun.listSeparator')),
  };
}

export type TestRunLabels = ReturnType<typeof buildTestRunLabels>;

export function useTestRunLabels(): TestRunLabels {
  const { t } = useTranslation();
  return useMemo(() => buildTestRunLabels(t), [t]);
}
