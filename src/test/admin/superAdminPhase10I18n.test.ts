import { describe, expect, it } from 'vitest';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import ts from 'typescript';
import en from '@/i18n/locales/en';
import fa from '@/i18n/locales/fa';
import tr from '@/i18n/locales/tr';

const paths = [
  'src/components/admin/calls/LiveKitSelfHostedProviderPanel.tsx',
  'src/components/admin/calls/AgoraExternalProviderPanel.tsx',
];
const technicalCopy = new Set([
  'LiveKit',
  'Agora',
  'AWS S3',
  'wss://livekit.example.com',
  'https://egress.example.com',
  'bucket-name',
  'https://s3.example.com',
  'https://your-host/api/calls/agora/webhook',
  'e.g. eu-west, us-east',
  'e.g. us-east-1',
  'agora_cloud',
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

describe('Super Admin phase 10 localization', () => {
  it('keeps LiveKit and Agora keys identical in all locales', () => {
    const expected = leaves({ livekit: en.admin.voiceVideo.livekit, agora: en.admin.voiceVideo.agora }).sort();
    expect(leaves({ livekit: fa.admin.voiceVideo.livekit, agora: fa.admin.voiceVideo.agora }).sort()).toEqual(expected);
    expect(leaves({ livekit: tr.admin.voiceVideo.livekit, agora: tr.admin.voiceVideo.agora }).sort()).toEqual(expected);
  });

  it('contains no untranslated visible English copy', () => {
    expect(untranslated()).toEqual([]);
  });
});
