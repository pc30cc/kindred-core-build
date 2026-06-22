/**
 * Strict correctness test for call-recording write-path storage_provider.
 *
 * Asserts the LiveKit egress_started handler stamps storage_provider using
 * the canonical resolveStorageConfig(workspaceId) resolver instead of the
 * historical hardcoded 's3' value. Also asserts the matching i18n nav keys
 * (operator + super-admin) for the Call Center label are populated in all
 * three shipped locales so the raw "nav.callCenter" token can no longer
 * leak into the UI.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import en from '../../i18n/locales/en';
import fa from '../../i18n/locales/fa';
import tr from '../../i18n/locales/tr';

describe('call recording storage_provider stamping', () => {
  it('uses resolveStorageConfig instead of hardcoded "s3"', () => {
    const src = readFileSync(
      resolve(__dirname, '../../../server/routes/livekitWebhook.ts'),
      'utf8',
    );
    // The hardcoded literal must be gone.
    expect(src).not.toMatch(/storage_provider:\s*['"]s3['"]/);
    // The canonical resolver must be imported and invoked at the write site.
    expect(src).toMatch(/resolveStorageConfig\s*\(/);
    expect(src).toMatch(/storage_provider:\s*resolvedProvider/);
  });
});

describe('Call Center nav label i18n', () => {
  for (const [name, dict] of [['en', en], ['fa', fa], ['tr', tr]] as const) {
    it(`${name} has nav.callCenter and admin.nav.callCenter`, () => {
      const d = dict as any;
      expect(typeof d.nav?.callCenter).toBe('string');
      expect(d.nav.callCenter.length).toBeGreaterThan(0);
      expect(typeof d.admin?.nav?.callCenter).toBe('string');
      expect(d.admin.nav.callCenter.length).toBeGreaterThan(0);
    });
  }
});
