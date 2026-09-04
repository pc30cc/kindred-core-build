import { describe, it, expect } from 'vitest';
import { computeSeoScore, SCORE_VERSION } from '../../../server/services/seo/scoring/score.js';

describe('computeSeoScore', () => {
  it('returns 100 with no issues', () => {
    const result = computeSeoScore([], 50);
    expect(result.score).toBe(100);
    expect(result.totalPenalty).toBe(0);
    expect(result.scoreVersion).toBe(SCORE_VERSION);
  });

  it('never scores below 0 or above 100', () => {
    const manyIssues = Array.from({ length: 30 }, (_, i) => ({
      issueType: `t${i}`, category: 'http' as const, severity: 'critical' as const, title: `issue ${i}`, affectedCount: 500,
    }));
    const result = computeSeoScore(manyIssues, 500);
    expect(result.score).toBeGreaterThanOrEqual(0);
    expect(result.score).toBeLessThanOrEqual(100);
  });

  it('info-severity issues never cost points', () => {
    const result = computeSeoScore([
      { issueType: 'noindex_pages', category: 'indexability', severity: 'info', title: 'noindex pages', affectedCount: 40 },
    ], 100);
    expect(result.score).toBe(100);
    expect(result.breakdown).toHaveLength(0);
  });

  it('a critical issue costs strictly more than a low-severity issue with the same footprint', () => {
    const critical = computeSeoScore([
      { issueType: 'http_5xx', category: 'http', severity: 'critical', title: 'server errors', affectedCount: 5 },
    ], 100);
    const low = computeSeoScore([
      { issueType: 'title_length', category: 'metadata', severity: 'low', title: 'title length', affectedCount: 5 },
    ], 100);
    expect(critical.totalPenalty).toBeGreaterThan(low.totalPenalty);
    expect(critical.score).toBeLessThan(low.score);
  });

  it('the same issue costs more when it affects a larger percentage of the site', () => {
    const smallSite = computeSeoScore([
      { issueType: 'missing_title', category: 'metadata', severity: 'high', title: 'missing title', affectedCount: 10 },
    ], 20); // 50% of site
    const largeSite = computeSeoScore([
      { issueType: 'missing_title', category: 'metadata', severity: 'high', title: 'missing title', affectedCount: 10 },
    ], 2000); // 0.5% of site
    expect(smallSite.totalPenalty).toBeGreaterThan(largeSite.totalPenalty);
  });

  it('penalty is log-dampened so 200 affected pages does not cost ~20x a 10-page issue', () => {
    const ten = computeSeoScore([
      { issueType: 'missing_h1', category: 'content', severity: 'medium', title: 'missing h1', affectedCount: 10 },
    ], 1000);
    const twoHundred = computeSeoScore([
      { issueType: 'missing_h1', category: 'content', severity: 'medium', title: 'missing h1', affectedCount: 200 },
    ], 1000);
    expect(twoHundred.totalPenalty).toBeLessThan(ten.totalPenalty * 20);
    expect(twoHundred.totalPenalty).toBeGreaterThan(ten.totalPenalty);
  });

  it('produces an explainable, sorted breakdown ("why 82?")', () => {
    const result = computeSeoScore([
      { issueType: 'http_5xx', category: 'http', severity: 'critical', title: '3 server errors', affectedCount: 3 },
      { issueType: 'images_missing_alt', category: 'images', severity: 'low', title: 'images without alt', affectedCount: 18 },
    ], 100);
    expect(result.breakdown[0].issueType).toBe('http_5xx'); // highest penalty first
    expect(result.breakdown[0].label).toMatch(/^-\d/);
    expect(result.score).toBe(Math.round(100 - result.totalPenalty));
  });

  it('is deterministic for identical input', () => {
    const input = [{ issueType: 'missing_canonical', category: 'canonical' as const, severity: 'low' as const, title: 'missing canonical', affectedCount: 7 }];
    const a = computeSeoScore(input, 40);
    const b = computeSeoScore(input, 40);
    expect(a).toEqual(b);
  });
});
