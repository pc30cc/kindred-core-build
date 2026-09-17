import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const files = [
  'src/pages/admin/MobileAppPage.tsx',
  'src/pages/admin/NotificationsPage.tsx',
  'src/components/admin/mobile/MobileOverviewTab.tsx',
  'src/components/admin/mobile/MobileIdentityTab.tsx',
  'src/components/admin/mobile/MobileBuildTab.tsx',
  'src/components/admin/mobile/MobileCapabilitiesTab.tsx',
  'src/components/admin/mobile/MobilePrivacyTab.tsx',
  'src/components/admin/mobile/MobileAppStoreTab.tsx',
  'src/components/admin/mobile/MobileReviewTab.tsx',
  'src/components/admin/mobile/MobileReleaseTab.tsx',
  'src/components/admin/mobile/MobileBuildGuideTab.tsx',
  'src/components/admin/notifications/NotificationStatusTab.tsx',
  'src/components/admin/notifications/NotificationPolicyTab.tsx',
  'src/components/admin/notifications/NotificationDeliveryTab.tsx',
  'src/components/admin/notifications/NotificationCategoriesTab.tsx',
  'src/components/admin/notifications/NotificationTemplatesTab.tsx',
  'src/components/admin/notifications/NotificationDiagnosticsTab.tsx',
];

/**
 * Apple identifiers and file names that are the same word in every language.
 * Translating `Info.plist` or `NSCameraUsageDescription` would make the screen
 * WORSE, so they stay literal — but the list is explicit so nothing else can
 * slip through as "technical".
 */
const technicalCopy = new Set([
  'Info.plist', 'PrivacyInfo.xcprivacy', 'App.entitlements', 'GoogleService-Info.plist',
  'ios/generated.xcconfig', 'config/ios-app.json', 'npm run ios:sync',
]);

const visibleProps = new Set([
  'label', 'title', 'description', 'placeholder', 'aria-label', 'alt', 'message', 'helperText',
  'heading', 'caption', 'hint', 'addLabel', 'removeLabel', 'appName',
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

describe('Super Admin phase 17 localization', () => {
  it.each(['mobileApp', 'notifications'] as const)(
    'keeps the complete %s key tree identical in all locales',
    (namespace) => {
      const branch = (locale: typeof en) =>
        (locale.admin as unknown as Record<string, unknown>)[namespace];
      const expected = leaves(branch(en)).sort();
      expect(leaves(branch(fa)).sort()).toEqual(expected);
      expect(leaves(branch(tr)).sort()).toEqual(expected);
    },
  );

  it('adds both navigation entries in every locale', () => {
    for (const locale of [en, fa, tr]) {
      const nav = (locale.admin as unknown as { nav: Record<string, string> }).nav;
      expect(nav.mobileApp).toBeTruthy();
      expect(nav.notifications).toBeTruthy();
    }
  });

  it.each(files)('removes visible hardcoded copy from %s', (path) => {
    expect(untranslated(path)).toEqual([]);
  });
});
