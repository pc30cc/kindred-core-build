/**
 * Widget Manifest Reader
 *
 * Reads widget-manifest.json to resolve content-hashed filenames.
 */
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';

interface WidgetManifest {
  'runtime.js'?: string;
  'runtime.css'?: string;
  'runtime-chat.js'?: string;
  'runtime-kb.js'?: string;
  'loader.js'?: string;
  loaderVersion?: string;
}

type WidgetAssetKey = 'runtime.js' | 'runtime.css' | 'runtime-chat.js' | 'runtime-kb.js';

let cachedManifest: WidgetManifest | null = null;
let lastReadTime = 0;
const CACHE_TTL_MS = 60_000;

const MANIFEST_PATHS = [
  resolve(process.cwd(), 'dist', 'widget', 'widget-manifest.json'),
  resolve(process.cwd(), '..', 'dist', 'widget', 'widget-manifest.json'),
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

  cachedManifest = {
    'runtime.js': 'runtime.js',
    'runtime.css': 'runtime.css',
    'runtime-chat.js': 'runtime-chat.js',
    'runtime-kb.js': 'runtime-kb.js',
    'loader.js': 'loader.js',
  };
  lastReadTime = now;
  return cachedManifest;
}

export function getWidgetAssetName(logical: WidgetAssetKey): string {
  const manifest = loadManifest();
  return manifest[logical] || logical;
}

export function getLoaderVersion(): string {
  const manifest = loadManifest();
  return manifest.loaderVersion || 'unknown';
}

export function invalidateManifestCache(): void {
  cachedManifest = null;
  lastReadTime = 0;
}
