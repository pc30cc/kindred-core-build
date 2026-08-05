#!/usr/bin/env node
/**
 * Reproducible failure test — asserts that in production, with no manifest
 * reachable (no local build output, no WIDGET_MANIFEST_URL/WIDGET_ASSET_BASE_URL),
 * getWidgetAssetName() throws WidgetManifestUnavailableError instead of
 * silently falling back to unhashed asset names.
 *
 * Run: node scripts/test-widget-manifest-failure.mjs
 */
process.env.NODE_ENV = 'production';
delete process.env.WIDGET_MANIFEST_URL;
delete process.env.WIDGET_ASSET_BASE_URL;
delete process.env.PUBLIC_WIDGET_BASE_URL;
delete process.env.PUBLIC_BASE_URL;

// Run from an empty cwd so no dist/widget or public/widget manifest can be
// found on the local filesystem search paths.
process.chdir('/tmp');

const { getWidgetAssetName, getLoaderVersion, WidgetManifestUnavailableError, isManifestResolved } =
  await import('tsx/esm/api').then(async ({ tsImport }) => {
    return tsImport('/dev-server/server/services/widget/manifest.ts', import.meta.url);
  });

// Give the background remote-fetch attempt (which is a no-op here since no
// URL is configured) a moment to settle — it resolves to null synchronously
// anyway, but this keeps the test robust if that ever changes.
await new Promise((r) => setTimeout(r, 50));

let threw = false;
let caught = null;
try {
  getWidgetAssetName('runtime.js');
} catch (err) {
  threw = true;
  caught = err;
}

const resolved = isManifestResolved();

console.log('--- test-widget-manifest-failure ---');
console.log('NODE_ENV:', process.env.NODE_ENV);
console.log('isManifestResolved():', resolved);
console.log('threw:', threw);
console.log('error name:', caught?.name);
console.log('error message:', caught?.message);
console.log('is WidgetManifestUnavailableError instance:', caught instanceof WidgetManifestUnavailableError);
console.log('diagnostics:', caught?.diagnostics);

let loaderVersionThrew = false;
try {
  getLoaderVersion();
} catch (err) {
  loaderVersionThrew = err instanceof WidgetManifestUnavailableError;
}
console.log('getLoaderVersion() also throws:', loaderVersionThrew);

const pass = threw && caught instanceof WidgetManifestUnavailableError && !resolved && loaderVersionThrew;
console.log(pass ? '\nPASS' : '\nFAIL');
process.exit(pass ? 0 : 1);
