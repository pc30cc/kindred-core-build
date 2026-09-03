import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const files = [
  'src/pages/admin/AiAgentControlPage.tsx',
  'src/pages/admin/BillingPage.tsx',
  'src/pages/admin/WorkspacesPage.tsx',
  'src/pages/admin/WidgetSettingsPage.tsx',
  'src/pages/admin/widget-settings/PoweredBySection.tsx',
  'src/components/admin/widget/AdvancedRoutingSection.tsx',
  'src/components/admin/widget/DeploymentUrlsSection.tsx',
  'src/components/admin/widget/HardeningSection.tsx',
];

const technicalCopy = new Set([
  'app_runtime_config.global_advanced_routing', 'socket_closed', 'lovable-realtime', 'centrifugo',
  '10000 – 1800000 ms', 'payload.id', '• ws:{workspaceId}:inbox',
  '• ws:{workspaceId}:visitors', '• ws:{workspaceId}:conv:{conversationId}',
  'action=typing', '250 – 60000 ms', 'https://example.com',
  'USD/mo', 'IRR/mo', 'TRY/mo', 'EUR/mo', '/api/',
  'https://widget.yourdomain.com', 'https://api.yourdomain.com', 'HTTP',
  'stripe', 'Stripe', 'paddle', 'Paddle', 'lemon_squeezy', 'Lemon Squeezy',
  'paypal', 'PayPal', 'zarinpal', 'ZarinPal', 'zarinpal_test', 'ZarinPal-Test (Sandbox)',
  'iranpardakht_sandbox', 'IranPardakht-Sandbox', 'idpay', 'IDPay', 'idpay_test',
  'IDPay-Test (Sandbox)', 'nextpay', 'NextPay', 'payping', 'PayPing', 'zibal', 'Zibal',
  'sep_shaparak', 'SEP Shaparak', 'iyzico', 'paytr', 'PayTR', 'sipay', 'Sipay',
  'paratika', 'Paratika', 'craftgate', 'Craftgate',
]);

const visibleProps = new Set([
  'label', 'title', 'description', 'placeholder', 'aria-label', 'alt', 'message', 'helperText',
]);

function leaves(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function untranslated(path: string): string[] {
  const source = readFileSync(resolve(process.cwd(), path), 'utf8');
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const result: string[] = [];
  const add = (value: string) => {
    const text = value.replace(/\s+/g, ' ').replace(/&#123;/g, '{').replace(/&#125;/g, '}').trim();
    if (/[A-Za-z]{2}/.test(text) && !technicalCopy.has(text)) result.push(text);
  };
  const inspect = (node: ts.Node) => {
    if (ts.isJsxText(node)) add(node.text);
    if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)
      && visibleProps.has(node.name.getText(file))) add(node.initializer.text);
    if (ts.isPropertyAssignment(node) && ts.isStringLiteralLike(node.initializer)
      && visibleProps.has(node.name.getText(file).replace(/["']/g, ''))) add(node.initializer.text);
    ts.forEachChild(node, inspect);
  };
  file.forEachChild(inspect);
  return result;
}

describe('Super Admin phase 15 localization', () => {
  it.each(['aiAgentControl', 'billingPage', 'workspacesPage', 'widgetSettingsPage'] as const)(
    'keeps the complete %s key tree identical in all locales',
    (namespace) => {
      const expected = leaves(en.admin[namespace]).sort();
      expect(leaves(fa.admin[namespace]).sort()).toEqual(expected);
      expect(leaves(tr.admin[namespace]).sort()).toEqual(expected);
    },
  );

  it.each(files)('removes visible hardcoded copy from %s', (path) => {
    expect(untranslated(path)).toEqual([]);
  });

  it('uses the active locale for billing and workspace dates and amounts', () => {
    const billing = readFileSync(resolve(process.cwd(), files[1]), 'utf8');
    const workspaces = readFileSync(resolve(process.cwd(), files[2]), 'utf8');
    expect(billing).toContain('Intl.NumberFormat(normalizedLocale');
    expect(billing).toContain('toLocaleDateString(dateLocale)');
    expect(workspaces).toContain('Intl.DateTimeFormat(dateLocale');
  });
});
