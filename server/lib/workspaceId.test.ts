// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { canonicalWorkspaceId } from './workspaceId.js';

const ID = '7b0e9d8c-1f2a-4b3c-9d4e-5f6a7b8c9d0e';

describe('canonicalWorkspaceId', () => {
  it('maps every spelling PostgreSQL accepts for one uuid to one string', () => {
    for (const spelling of [
      ID,
      ID.toUpperCase(),
      `{${ID}}`,
      ID.replace(/-/g, ''),
      '7b0e-9d8c-1f2a-4b3c-9d4e-5f6a-7b8c-9d0e',
      `  ${ID}  `,
    ]) {
      expect(canonicalWorkspaceId(spelling)).toBe(ID);
    }
  });

  it('is null for anything that is not a uuid', () => {
    for (const bad of ['', 'ws-1', `${ID}0`, ID.slice(1), `{${ID}`, 'g'.repeat(32), `${ID}${'-'.repeat(40)}`, 42, null, undefined, {}]) {
      expect(canonicalWorkspaceId(bad)).toBeNull();
    }
  });
});
