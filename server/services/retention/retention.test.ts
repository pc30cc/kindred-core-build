import { describe, expect, it } from 'vitest';
import { EDITABLE_FIELDS, PROTECTED_CATEGORIES, isProtected, type RetentionPolicy } from './types.js';
import { getArchiveAdapter, registerArchiveAdapter, resetArchiveAdapter } from './archive.js';

function policy(over: Partial<RetentionPolicy>): Pick<RetentionPolicy, 'category' | 'retention_mode'> {
  return { category: 'telemetry', retention_mode: 'rolling', ...over } as RetentionPolicy;
}

describe('retention policy guardrails', () => {
  it('protects financial and core categories regardless of mode', () => {
    expect(isProtected(policy({ category: 'financial', retention_mode: 'rolling' }))).toBe(true);
    expect(isProtected(policy({ category: 'core', retention_mode: 'rolling' }))).toBe(true);
    expect(PROTECTED_CATEGORIES.has('financial')).toBe(true);
  });

  it('protects any permanent policy even in a deletable category', () => {
    expect(isProtected(policy({ category: 'audit', retention_mode: 'permanent' }))).toBe(true);
  });

  it('allows rolling telemetry / seo / ai_debug policies to run', () => {
    expect(isProtected(policy({ category: 'telemetry' }))).toBe(false);
    expect(isProtected(policy({ category: 'ai_debug' }))).toBe(false);
    expect(isProtected(policy({ category: 'seo', retention_mode: 'latest_n_runs' }))).toBe(false);
  });

  it('never exposes table_name, category or retention_mode as editable', () => {
    for (const forbidden of ['table_name', 'category', 'retention_mode', 'timestamp_column']) {
      expect(EDITABLE_FIELDS as readonly string[]).not.toContain(forbidden);
    }
  });
});

describe('archive adapter registry', () => {
  it('defaults to an unavailable adapter so archive_then_delete never deletes silently', async () => {
    resetArchiveAdapter();
    const adapter = getArchiveAdapter();
    expect(adapter.name).toBe('unavailable');
    expect(await adapter.isAvailable()).toBe(false);
    const result = await adapter.archiveBatch({} as never);
    expect(result.supported).toBe(false);
    expect(result.reason).toBe('archive_adapter_unavailable');
  });

  it('uses a registered adapter once provided', () => {
    registerArchiveAdapter({
      name: 'test-s3',
      async isAvailable() { return true; },
      async archiveBatch() { return { rowsArchived: 1, bytesArchived: 10, supported: true }; },
    });
    expect(getArchiveAdapter().name).toBe('test-s3');
    resetArchiveAdapter();
    expect(getArchiveAdapter().name).toBe('unavailable');
  });
});
