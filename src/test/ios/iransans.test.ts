/**
 * IRANSans, as the iPhone app bundles it: the very file the Windows (and
 * Mac) app ships, so Persian reads the same in every Webyar app. The iPhone
 * project keeps its own copy, inside its own folder, and this keeps the two
 * from drifting apart.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

const digest = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex');

describe('IRANSans in the iPhone app', () => {
  it('is the same file the Windows app bundles', () => {
    expect(digest('ios/Webyar/Resources/IRANSans.ttc')).toBe(
      digest('windows-native/src/Webyar.App/Assets/Fonts/IRANSans.ttc'),
    );
  });
});
