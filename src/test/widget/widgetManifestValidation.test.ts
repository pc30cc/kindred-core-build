/**
 * Negative tests for the widget manifest hashed-filename contract.
 *
 * Production must NEVER serve unhashed widget assets. These cases lock the
 * contract down: no manifest, malformed manifest, unhashed assets, a missing
 * runtime module, and an unresolved loaderVersion.
 */
import { describe, it, expect } from 'vitest';
import { manifestValidationErrors, REQUIRED_HASHED_ASSETS } from '../../../server/services/widget/manifest';

const VALID: Record<string, string> = {
  'runtime.js': 'runtime.341ce9bc.js',
  'runtime.css': 'runtime.62b620ac.css',
  'runtime-chat.js': 'runtime-chat.1a2b3c4d.js',
  'runtime-kb.js': 'runtime-kb.5e6f7a8b.js',
  'runtime-call.js': 'runtime-call.9c0d1e2f.js',
  'runtime-rt-centrifugo.js': 'runtime-rt-centrifugo.3f8408a8.js',
  'runtime-rt-supabase.js': 'runtime-rt-supabase.37ea68c4.js',
  'runtime-rt-resolver.js': 'runtime-rt-resolver.e8691bd3.js',
  'vendor/livekit-client.umd.min.js': 'vendor/livekit-client.umd.min.23449062.js',
  'loader.js': 'loader.js',
  loaderVersion: 'abc12345',
};

describe('widget manifest validation', () => {
  it('accepts a fully hashed manifest', () => {
    expect(manifestValidationErrors(VALID)).toEqual([]);
  });

  it('requires every production-consumed asset, including vendor + realtime modules', () => {
    for (const key of [
      'vendor/livekit-client.umd.min.js',
      'runtime-rt-centrifugo.js',
      'runtime-rt-supabase.js',
      'runtime-rt-resolver.js',
    ]) {
      expect(REQUIRED_HASHED_ASSETS).toContain(key as any);
    }
  });

  it('rejects an unhashed vendor asset', () => {
    const errors = manifestValidationErrors({
      ...VALID,
      'vendor/livekit-client.umd.min.js': 'vendor/livekit-client.umd.min.js',
    });
    expect(errors).toContain(
      'unhashed_asset:vendor/livekit-client.umd.min.js=vendor/livekit-client.umd.min.js',
    );
  });

  it('rejects a missing manifest', () => {
    expect(manifestValidationErrors(null)).toContain('manifest_missing_or_malformed');
    expect(manifestValidationErrors(undefined)).toContain('manifest_missing_or_malformed');
  });

  it('rejects a malformed manifest', () => {
    expect(manifestValidationErrors('{}')).toContain('manifest_missing_or_malformed');
    expect(manifestValidationErrors([VALID])).toContain('manifest_missing_or_malformed');
  });

  it('rejects unhashed assets', () => {
    const errors = manifestValidationErrors({ ...VALID, 'runtime.js': 'runtime.js' });
    expect(errors).toContain('unhashed_asset:runtime.js=runtime.js');
  });

  it('rejects short, uppercase or wrong-extension hashes', () => {
    for (const bad of ['runtime.341ce9b.js', 'runtime.341CE9BC.js', 'runtime.341ce9bc.mjs', '../runtime.341ce9bc.js']) {
      expect(manifestValidationErrors({ ...VALID, 'runtime.js': bad })).toContain(
        `unhashed_asset:runtime.js=${bad}`,
      );
    }
  });

  it('rejects a manifest missing a runtime module', () => {
    for (const key of REQUIRED_HASHED_ASSETS) {
      const partial: Record<string, unknown> = { ...VALID };
      delete partial[key];
      expect(manifestValidationErrors(partial)).toContain(`missing_asset:${key}`);
    }
  });

  it('rejects an unresolved loaderVersion', () => {
    expect(manifestValidationErrors({ ...VALID, loaderVersion: undefined })).toContain(
      'unresolved_loader_version',
    );
    expect(manifestValidationErrors({ ...VALID, loaderVersion: 'unresolved' })).toContain(
      'unresolved_loader_version',
    );
  });
});
