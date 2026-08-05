#!/usr/bin/env node
/**
 * Deployment smoke test — runs against the ACTUAL configured asset base,
 * not local dist output.
 *
 *   node scripts/widget-deploy-smoke.mjs --asset-base https://app.example.com \
 *        [--api-base https://api.example.com]
 *
 * Env fallbacks: WIDGET_ASSET_BASE_URL / VITE_WIDGET_ASSET_BASE_URL,
 *                WIDGET_API_BASE_URL   / VITE_API_BASE_URL
 *
 * Contract enforced for every manifest asset:
 *   • HTTP 200
 *   • correct Content-Type for the extension
 *   • never an HTML document (index.html SPA fallback = missing asset)
 *
 * Exit code 1 on the first violation, with the exact URL, status and
 * Content-Type printed — the same facts the loader now records in
 * window.__gs_last_error.
 */
function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 ? process.argv[i + 1] : undefined;
}

const assetBase = (arg('asset-base') || process.env.WIDGET_ASSET_BASE_URL || process.env.VITE_WIDGET_ASSET_BASE_URL || '').replace(/\/+$/, '');
const apiBase = (arg('api-base') || process.env.WIDGET_API_BASE_URL || process.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');

if (!assetBase) {
  console.error('[smoke] FATAL: no asset base configured. Pass --asset-base https://... or set WIDGET_ASSET_BASE_URL.');
  process.exit(1);
}

const EXPECTED_TYPE = {
  js: ['application/javascript', 'text/javascript'],
  css: ['text/css'],
  json: ['application/json'],
};

const failures = [];

async function check(url, kind) {
  let res;
  try {
    res = await fetch(url, { redirect: 'follow' });
  } catch (err) {
    failures.push({ url, error: err.message });
    console.error(`✗ ${url}\n    network error: ${err.message}`);
    return null;
  }
  const ct = (res.headers.get('content-type') || '').toLowerCase();
  const body = await res.text();
  const allowed = EXPECTED_TYPE[kind] || [];
  const isHtml = ct.includes('text/html') || /^\s*<!doctype html/i.test(body);
  const typeOk = allowed.some((t) => ct.includes(t));

  if (res.status !== 200 || isHtml || !typeOk) {
    failures.push({ url, status: res.status, contentType: ct, servedHtml: isHtml });
    console.error(`✗ ${url}\n    status=${res.status} content-type=${ct || '(none)'}${isHtml ? ' — SERVED HTML (asset not deployed)' : ''}${!typeOk ? ` — expected ${allowed.join(' | ')}` : ''}`);
    return null;
  }
  console.log(`✓ ${res.status} ${ct.split(';')[0].padEnd(24)} ${url}  (${body.length} bytes)`);
  return body;
}

function kindOf(path) {
  if (path.endsWith('.css')) return 'css';
  if (path.endsWith('.json')) return 'json';
  return 'js';
}

console.log(`[smoke] asset base: ${assetBase}`);
const manifestUrl = `${assetBase}/widget/widget-manifest.json`;
const manifestBody = await check(manifestUrl, 'json');
if (!manifestBody) {
  console.error('[smoke] FAILED: production manifest is not reachable.');
  process.exit(1);
}

let manifest;
try {
  manifest = JSON.parse(manifestBody);
} catch (err) {
  console.error(`[smoke] FAILED: manifest is not valid JSON: ${err.message}`);
  process.exit(1);
}

for (const [key, value] of Object.entries(manifest)) {
  if (key === 'loaderVersion') continue;
  const url = `${assetBase}/widget/${value}`;
  await check(url, kindOf(value));
}

// The loader itself is a stable entry point and must also be reachable at
// the version the manifest advertises.
if (manifest.loaderVersion) {
  await check(`${assetBase}/widget/loader.js?v=${manifest.loaderVersion}`, 'js');
}

if (apiBase) {
  const url = `${apiBase}/api/health`;
  try {
    const res = await fetch(url);
    console.log(`${res.ok ? '✓' : '✗'} ${res.status} api health ${url}`);
    if (!res.ok) failures.push({ url, status: res.status });
  } catch (err) {
    failures.push({ url, error: err.message });
    console.error(`✗ ${url}\n    network error: ${err.message}`);
  }
}

if (failures.length) {
  console.error(`\n[smoke] FAILED — ${failures.length} asset(s) not deployable:`);
  for (const f of failures) console.error('  ' + JSON.stringify(f));
  process.exit(1);
}
console.log('\n[smoke] PASS — every manifest asset returns 200 with a correct, non-HTML content type.');
