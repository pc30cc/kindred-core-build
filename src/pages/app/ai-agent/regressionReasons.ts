/**
 * Failure reasons as Regression runs and Suggested tests show them, over the
 * test tools' shared words (testRunLabels.ts failureReason). Two kinds the
 * shared map does not know:
 *  - the overview's "top failure reasons" count a reason by its code before
 *    ':' (server/services/ai-agent/regressionRunner.ts), so `missing_text`,
 *    `forbidden_text`, `low_confidence`, `missing_expected_source_type` and
 *    `unsupported_expected_source_type` arrive without their detail;
 *  - a case the regression runner could not run is
 *    `runner_unhandled:<message>` (the same file).
 * Both are shown as sentences (aiAgent.adv.regression.failureGroup.*), never
 * as the code.
 */
import type { TranslationKey } from '@/i18n';
import { isolate, type TestRunLabels } from './testRunLabels';

type Translate = (key: TranslationKey, params?: Record<string, string | number>) => string;

export function regressionFailureReason(t: Translate, labels: TestRunLabels) {
  const groupMap: Record<string, string> = {
    missing_text: t('aiAgent.adv.regression.failureGroup.missing_text'),
    forbidden_text: t('aiAgent.adv.regression.failureGroup.forbidden_text'),
    low_confidence: t('aiAgent.adv.regression.failureGroup.low_confidence'),
    missing_expected_source_type: t('aiAgent.adv.regression.failureGroup.missing_expected_source_type'),
    unsupported_expected_source_type: t('aiAgent.adv.regression.failureGroup.unsupported_expected_source_type'),
    runner_unhandled: t('aiAgent.adv.regression.failureGroup.runner_unhandled'),
  };
  return (code: string): string => {
    if (Object.prototype.hasOwnProperty.call(groupMap, code)) return groupMap[code];
    const m = /^runner_unhandled:(.*)$/s.exec(code);
    if (m) {
      return m[1]
        ? t('aiAgent.adv.regression.failureGroup.runnerUnhandledDetail', { detail: isolate(m[1]) })
        : groupMap.runner_unhandled;
    }
    return labels.failureReason(code);
  };
}

/** A code at the start of a failure reason (`missing_text:…`, `file_url_leak`, `errored`). */
const REASON_CODE_RE = /^(?:errored|[a-z]+(?:_[a-z0-9]+)+)(?::|$)/;

/**
 * A suggestion's reason from a failed run: its failure reasons joined by
 * '; ' (server/services/ai-agent/regressionSuggestions.ts). An expected text
 * or an error message may hold '; ' of its own, so a piece that does not
 * start with a code belongs to the reason before it.
 */
export function splitFailureReasons(reason: string): string[] {
  const out: string[] = [];
  for (const piece of reason.split('; ')) {
    if (out.length && !REASON_CODE_RE.test(piece.trim())) out[out.length - 1] += `; ${piece}`;
    else out.push(piece);
  }
  return out.map((r) => r.trim()).filter(Boolean);
}
