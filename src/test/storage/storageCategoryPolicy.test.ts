/**
 * StorageCategoryPolicy registry invariants.
 *
 * This registry is documentation made checkable (docs/STORAGE_ARCHITECTURE_AUDIT.md
 * §5's per-category countsTowardQuota/retention/visibility/ownerKind ask) —
 * these tests only guard its internal consistency, not runtime wiring.
 */
import { describe, it, expect } from 'vitest';
import { STORAGE_CATEGORY_POLICY, storageCategoryPolicy, type StorageCategory } from '../../../server/services/storage/categoryPolicy';

const CATEGORIES = Object.keys(STORAGE_CATEGORY_POLICY) as StorageCategory[];

describe('StorageCategoryPolicy registry', () => {
  it('every category has a fully-populated policy entry', () => {
    for (const category of CATEGORIES) {
      const entry = STORAGE_CATEGORY_POLICY[category];
      expect(typeof entry.countsTowardQuota).toBe('boolean');
      expect(['indefinite', 'workspace_lifecycle', 'ttl_short', 'policy_driven']).toContain(entry.retention);
      expect(['private', 'public']).toContain(entry.visibility);
      expect(['workspace', 'user', 'platform', 'workspace_or_user']).toContain(entry.ownerKind);
      expect(typeof entry.wired).toBe('boolean');
      expect(entry.notes.length).toBeGreaterThan(0);
    }
  });

  it('a purely user- or platform-owned category never counts toward workspace quota', () => {
    // workspace_usage_counters.storage_bytes is keyed by workspace_id — an
    // object with no workspace owner has nothing to attribute bytes to.
    // 'workspace_or_user' categories are allowed to count (per-job, only
    // when that job's owner actually resolves to a workspace).
    for (const category of CATEGORIES) {
      const entry = STORAGE_CATEGORY_POLICY[category];
      if (entry.ownerKind === 'user' || entry.ownerKind === 'platform') {
        expect(entry.countsTowardQuota).toBe(false);
      }
    }
  });

  it('storageCategoryPolicy() returns the exact registry entry', () => {
    expect(storageCategoryPolicy('conversation_attachment')).toBe(STORAGE_CATEGORY_POLICY.conversation_attachment);
  });

  it('every already-wired, quota-counting workspace category is accounted for in the audit (no silent drift)', () => {
    const wiredCounting = CATEGORIES.filter(
      (c) => STORAGE_CATEGORY_POLICY[c].wired && STORAGE_CATEGORY_POLICY[c].countsTowardQuota,
    );
    expect(wiredCounting.sort()).toEqual(
      [
        'conversation_attachment',
        'widget_attachment',
        'channel_attachment',
        'email_attachment',
        'ai_agent_file',
        'workspace_branding',
        'operator_upload',
        'call_center_avatar',
        'privacy_export',
      ].sort(),
    );
  });
});
