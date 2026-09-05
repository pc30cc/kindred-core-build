import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

async function source(name: string) {
  return readFile(join(here, name), 'utf8');
}

describe('superadmin telegram no-persistence boundary', () => {
  it('never imports the billable/logging AI orchestration path', async () => {
    const text = await source('assistant.ts');
    expect(text).not.toContain('executeAICompletion');
    expect(text).toContain('runtimeComplete');
  });

  it('does not contain database mutation calls in bot-owned modules', async () => {
    const texts = await Promise.all([
      source('assistant.ts'),
      source('opsSnapshot.ts'),
      source('index.ts'),
    ]);
    const combined = texts.join('\n');
    for (const forbidden of ['.insert(', '.update(', '.upsert(', '.delete(', '.rpc(']) {
      expect(combined).not.toContain(forbidden);
    }
    expect(combined).not.toContain('ai_usage_logs');
    expect(combined).not.toContain('audit_logs');
  });

  it('never logs Telegram message text or AI answers', async () => {
    const text = await source('index.ts');
    expect(text).not.toMatch(/console\.(log|info|warn|error)\([^\n]*(text|answer|question)/i);
  });
});
