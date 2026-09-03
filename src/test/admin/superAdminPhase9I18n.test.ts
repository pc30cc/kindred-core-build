import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const paths = [
  'src/components/admin/calls/CallControlPlanePanel.tsx',
  'src/components/admin/calls/RolePermissionsPanel.tsx',
];
const technicalCopy = new Set([
  'wss://your-livekit.example',
  'https://egress.example',
  'turn:turn.example:3478?transport=udp, turns:turn.example:5349?transport=tcp',
]);

function leaves(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object') return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) =>
    leaves(child, prefix ? `${prefix}.${key}` : key),
  );
}

function untranslated(): string[] {
  return paths.flatMap((path) => {
    const source = readFileSync(resolve(process.cwd(), path), 'utf8');
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const result: string[] = [];
    const visit = (node: ts.Node) => {
      if (ts.isJsxText(node)) {
        const text = node.text.replace(/\s+/g, ' ').trim();
        if (/[A-Za-z]{2}/.test(text)) result.push(text);
      }
      if (ts.isJsxAttribute(node) && node.initializer && ts.isStringLiteral(node.initializer)) {
        const visibleAttributes = ['placeholder', 'title', 'aria-label', 'label', 'description'];
        if (visibleAttributes.includes(node.name.getText(file)) && /[A-Za-z]{2}/.test(node.initializer.text)) {
          result.push(node.initializer.text);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    return result.filter((text) => !technicalCopy.has(text));
  });
}

describe('Super Admin phase 9 localization', () => {
  it('keeps call-control and permission keys identical in all locales', () => {
    const expected = leaves({
      control: en.admin.voiceVideo.control,
      permissions: en.admin.voiceVideo.permissions,
    }).sort();
    expect(
      leaves({ control: fa.admin.voiceVideo.control, permissions: fa.admin.voiceVideo.permissions }).sort(),
    ).toEqual(expected);
    expect(
      leaves({ control: tr.admin.voiceVideo.control, permissions: tr.admin.voiceVideo.permissions }).sort(),
    ).toEqual(expected);
  });

  it('contains no untranslated visible English copy', () => {
    expect(untranslated()).toEqual([]);
  });
});
