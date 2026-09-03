/**
 * SEO Health Score — versioned, deterministic, explainable. NEVER touched by
 * an LLM. `SCORE_VERSION` must be bumped whenever the formula changes so
 * historical scores stay comparable within their own version and the UI can
 * label old scores honestly if the model changes later.
 *
 * Penalty per issue = severity weight × affected-count factor (log-dampened,
 * so 200 affected pages doesn't count 10x harder than 20) × percent-of-site
 * factor (a problem hitting the whole site is worse than the same count on
 * a huge site). `info`-severity issues never cost points — they are
 * observational only.
 */
import type { IssueCategory, IssueSeverity } from '../rules/policy.js';

export const SCORE_VERSION = 'v1';

const SEVERITY_WEIGHT: Record<IssueSeverity, number> = {
  critical: 8,
  high: 4,
  medium: 2,
  low: 1,
  info: 0,
};

// log2(21) so the count factor saturates at 1.0 once ~20 pages are affected.
const COUNT_SATURATION = Math.log2(21);

export interface ScoreInputIssue {
  issueType: string;
  category: IssueCategory;
  severity: IssueSeverity;
  title: string;
  affectedCount: number;
}

export interface ScoreBreakdownEntry {
  issueType: string;
  category: IssueCategory;
  severity: IssueSeverity;
  affectedCount: number;
  percentOfSite: number;
  penalty: number;
  label: string;
}

export interface ScoreResult {
  score: number;
  scoreVersion: string;
  totalPenalty: number;
  breakdown: ScoreBreakdownEntry[];
}

export function computeSeoScore(issues: ScoreInputIssue[], totalPages: number): ScoreResult {
  const entries: ScoreBreakdownEntry[] = [];
  let totalPenalty = 0;

  for (const issue of issues) {
    const weight = SEVERITY_WEIGHT[issue.severity];
    if (weight <= 0 || issue.affectedCount <= 0) continue;

    const percentOfSite = totalPages > 0 ? issue.affectedCount / totalPages : 0;
    const countFactor = Math.min(1, Math.log2(issue.affectedCount + 1) / COUNT_SATURATION);
    const pctFactor = 1 + Math.min(1, percentOfSite);
    const penalty = Math.round(weight * countFactor * pctFactor * 10) / 10;
    if (penalty <= 0) continue;

    totalPenalty += penalty;
    entries.push({
      issueType: issue.issueType,
      category: issue.category,
      severity: issue.severity,
      affectedCount: issue.affectedCount,
      percentOfSite: Math.round(percentOfSite * 1000) / 10,
      penalty,
      label: `-${penalty} → ${issue.affectedCount} ${issue.title.toLowerCase()}`,
    });
  }

  entries.sort((a, b) => b.penalty - a.penalty);
  const roundedTotalPenalty = Math.round(totalPenalty * 10) / 10;
  const score = Math.max(0, Math.min(100, Math.round(100 - roundedTotalPenalty)));

  return { score, scoreVersion: SCORE_VERSION, totalPenalty: roundedTotalPenalty, breakdown: entries };
}
