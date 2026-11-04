/**
 * Pieces the test run page and the run inspector share: a labelled list, a
 * raw JSON block that reads left to right inside Persian, and the answer
 * strategy in words (its known fields translated, the rest kept as data).
 */
import type { ReactNode } from 'react';
import { useTranslation } from '@/i18n';
import type { TestRunLabels } from './testRunLabels';

export interface KeyValueRow {
  key: string;
  label: string;
  value: ReactNode;
}

export function KeyValueList({ rows }: { rows: KeyValueRow[] }) {
  return (
    <dl className="grid grid-cols-1 sm:grid-cols-[minmax(0,14rem)_1fr] gap-x-4 gap-y-1.5 text-sm">
      {rows.map((row) => (
        <div key={row.key} className="contents">
          <dt className="text-muted-foreground">{row.label}</dt>
          <dd className="min-w-0 break-words">{row.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Technical data as the engine recorded it: always left to right, Latin digits. */
export function RawJson({ value, className = '' }: { value: unknown; className?: string }) {
  return (
    <pre dir="ltr" data-latin-digits="" className={`text-xs bg-muted/30 p-3 rounded overflow-auto ${className}`}>
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

/** A collapsed raw view under a translated summary. */
export function RawDetails({ value }: { value: unknown }) {
  const { t } = useTranslation();
  return (
    <details className="mt-3">
      <summary className="cursor-pointer text-xs text-muted-foreground">{t('aiAgent.adv.testRun.rawData')}</summary>
      <RawJson value={value} className="mt-2" />
    </details>
  );
}

type StrategyRecord = Record<string, unknown>;

function asNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * An answer strategy (a test run's, server/services/ai-agent/testHarness.ts,
 * or a live run's metadata, engine/answerStage.ts): the fields both share in
 * words, then the whole record, collapsed.
 */
export function AnswerStrategySummary({ strategy, labels }: { strategy: unknown; labels: TestRunLabels }) {
  const { t } = useTranslation();
  if (!strategy || typeof strategy !== 'object') {
    return <p className="text-sm text-muted-foreground">{t('aiAgent.adv.testRun.strategy.empty')}</p>;
  }
  const s = strategy as StrategyRecord;
  const rows: KeyValueRow[] = [];
  if (typeof s.action === 'string') {
    rows.push({ key: 'action', label: t('aiAgent.adv.testRun.strategy.action'), value: labels.behavior(s.action) });
  }
  if (typeof s.decision_type === 'string') {
    rows.push({ key: 'decision_type', label: t('aiAgent.adv.testRun.strategy.decisionType'), value: labels.decisionType(s.decision_type) });
  }
  if (typeof s.reason === 'string') {
    rows.push({ key: 'reason', label: t('aiAgent.adv.testRun.strategy.reason'), value: labels.reason(s.reason) });
  }
  if (typeof s.retrieval_strength === 'string') {
    rows.push({ key: 'retrieval_strength', label: t('aiAgent.adv.testRun.strategy.retrievalStrength'), value: labels.strength(s.retrieval_strength) });
  }
  const topScore = asNumber(s.top_score);
  if (topScore != null) {
    rows.push({ key: 'top_score', label: t('aiAgent.adv.testRun.strategy.topScore'), value: topScore.toFixed(3) });
  }
  const confidence = asNumber(s.confidence);
  if (confidence != null) {
    rows.push({ key: 'confidence', label: t('aiAgent.adv.testRun.strategy.confidence'), value: confidence.toFixed(2) });
  }
  if (typeof s.handoff_required === 'boolean') {
    rows.push({ key: 'handoff_required', label: t('aiAgent.adv.testRun.strategy.handoffRequired'), value: labels.yesNo(s.handoff_required) });
  }
  if (Array.isArray(s.source_types_used)) {
    const types = s.source_types_used.filter((x): x is string => typeof x === 'string');
    rows.push({
      key: 'source_types_used',
      label: t('aiAgent.adv.testRun.strategy.sourceTypesUsed'),
      value: types.length ? labels.list(types.map((x) => labels.sourceType(x))) : t('aiAgent.adv.testRun.strategy.none'),
    });
  }
  return (
    <div>
      {rows.length > 0 && <KeyValueList rows={rows} />}
      <RawDetails value={strategy} />
    </div>
  );
}
