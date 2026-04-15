/**
 * Widget Manifest Reader
 * 
 * Reads the widget-manifest.json produced by scripts/widget-hash.js
 * to resolve content-hashed filenames for runtime.js and runtime.css.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

interface WidgetManifest {
  'runtime.js'?: string;
  'runtime.css'?: string;
  'loader.js'?: string;
  loaderVersion?: string;
}

let cachedManifest: WidgetManifest | null = null;
let lastReadTime = 0;
const CACHE_TTL_MS = 60_000; // Re-read every 60s in case of hot deploy

const MANIFEST_PATHS = [
  resolve(process.cwd(), 'dist', 'widget', 'widget-manifest.json'),
  resolve(process.cwd(), '..', 'dist', 'widget', 'widget-manifest.json'),
  // Docker: frontend assets might be at /app/dist or /usr/share/nginx/html
  '/usr/share/nginx/html/widget/widget-manifest.json',
  '/app/dist/widget/widget-manifest.json',
];

function loadManifest(): WidgetManifest {
  const now = Date.now();
  if (cachedManifest && now - lastReadTime < CACHE_TTL_MS) {
    return cachedManifest;
  }

  for (const p of MANIFEST_PATHS) {
    if (existsSync(p)) {
      try {
        const raw = readFileSync(p, 'utf-8');
        cachedManifest = JSON.parse(raw);
        lastReadTime = now;
        console.log(`[widget-manifest] Loaded from ${p}`);
        return cachedManifest!;
      } catch (err) {
        console.warn(`[widget-manifest] Failed to parse ${p}:`, err);
      }
    }
  }

  // Fallback: no manifest found, return unhashed names
  cachedManifest = {
    'runtime.js': 'runtime.js',
    'runtime.css': 'runtime.css',
    'loader.js': 'loader.js',
  };
  lastReadTime = now;
  return cachedManifest;
}

/**
 * Get the hashed filename for a widget asset.
 * Returns e.g. "runtime.a1b2c3d4.js" or falls back to "runtime.js".
 */
export function getWidgetAssetName(logical: 'runtime.js' | 'runtime.css'): string {
  const manifest = loadManifest();
  return manifest[logical] || logical;
}

/**
 * Get the loader version hash for cache-busting the embed code.
 */
export function getLoaderVersion(): string {
  const manifest = loadManifest();
  return manifest.loaderVersion || 'unknown';
}

/**
 * Invalidate the cached manifest (e.g. after a deploy).
 */
export function invalidateManifestCache(): void {
  cachedManifest = null;
  lastReadTime = 0;
}
