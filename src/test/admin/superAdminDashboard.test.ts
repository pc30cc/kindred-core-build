import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const dashboardPath = 'src/pages/admin/DashboardPage.tsx';
const source = readFileSync(resolve(process.cwd(), dashboardPath), 'utf8');

function leaves(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function visibleHardcodedCopy(): string[] {
  const file = ts.createSourceFile(dashboardPath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  const add = (value: string) => {
    const text = value.replace(/\s+/g, ' ').trim();
    if (/[A-Za-z]{2}/.test(text)) result.push(text);
  };
  const inspect = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text);
    if (
      ts.isJsxAttribute(node)
      && node.initializer
      && ts.isStringLiteral(node.initializer)
      && ['placeholder', 'title', 'aria-label', 'alt'].includes(node.name.getText(file))
    ) add(node.initializer.text);
    ts.forEachChild(node, inspect);
  };
  file.forEachChild(inspect);
  return result;
}

describe('Super Admin dashboard', () => {
  it('uses real platform reporting sources without demo data', () => {
    [
      'fetchBusinessMetrics',
      'fetchSla',
      'fetchWorkspaceHealth',
      'fetchActiveAlerts',
      'fetchPerfSummary',
      'useAdminProfiles',
      'useAdminWorkspaces',
      'useAdminAuditLogs',
      'useAdminProviderConfigs',
      'useAdminFeatureFlags',
    ].forEach((sourceName) => expect(source).toContain(sourceName));

    expect(source).toContain('useAdminAuditLogs({ limit: 8 })');
    expect(source).toContain('auditQ.data?.logs.length');
    expect(source).not.toMatch(/Math\.random|mockData|fixtureData|demoData/i);
  });

  it('provides reporting ranges, refresh, charts and operational drill-downs', () => {
    expect(source).toContain("type DashboardRange = '24h' | '7d' | '30d'");
    expect(source).toContain('const refresh = () => Promise.all');
    expect(source).toContain('<AreaChart');
    expect(source).toContain('<PieChart');
    expect(source).toContain('refetchInterval');
    ['/admin/users', '/admin/workspaces', '/admin/observability', '/admin/billing', '/admin/providers'].forEach((route) =>
      expect(source).toContain(route),
    );
  });

  it('keeps the dashboard translation tree identical in English, Persian and Turkish', () => {
    const expected = leaves(en.admin.dashboard).sort();
    expect(leaves(fa.admin.dashboard).sort()).toEqual(expected);
    expect(leaves(tr.admin.dashboard).sort()).toEqual(expected);
    expect(expected.length).toBeGreaterThan(65);
  });

  it('contains no visible hardcoded English UI copy', () => {
    expect(visibleHardcodedCopy()).toEqual([]);
  });

  it('formats dates and numbers using the active locale', () => {
    expect(source).toContain('new Intl.NumberFormat(locale)');
    expect(source).toContain('new Intl.DateTimeFormat(dateLocale');
    expect(source).toContain("locale === 'fa' ? 'fa-IR'");
  });
});
