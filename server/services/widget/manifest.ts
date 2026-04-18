/**
 * Widget Manifest Reader
 *
 * Reads widget-manifest.json to resolve content-hashed filenames.
 * Falls back to a composite widget asset hash when the manifest is unavailable,
 * so stable asset URLs can still be cache-busted safely.
 */
import { createHash } from 'crypto';
import { readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';

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

const WIDGET_DIR_PATHS = [
  resolve(process.cwd(), 'public', 'widget'),
  resolve(process.cwd(), '..', 'public', 'widget'),
  resolve(process.cwd(), 'dist', 'widget'),
  resolve(process.cwd(), '..', 'dist', 'widget'),
  '/usr/share/nginx/html/widget',
  '/app/public/widget',
  '/app/dist/widget',
];

const VERSION_FILES = ['loader.js', 'runtime.js', 'runtime.css', 'runtime-chat.js', 'runtime-kb.js'] as const;

function computeFallbackVersion(): string {
  for (const dir of WIDGET_DIR_PATHS) {
    try {
      const availableFiles = VERSION_FILES.filter((file) => existsSync(join(dir, file)));
      if (!availableFiles.length) continue;

      const hash = createHash('md5');
      for (const file of availableFiles) {
        hash.update(file);
        hash.update(readFileSync(join(dir, file)));
      }

      return hash.digest('hex').slice(0, 12);
    } catch {
    }
  }

  return 'dev';
}

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
        cachedManifest.loaderVersion ||= computeFallbackVersion();
        lastReadTime = now;
        console.log(`[widget-manifest] Loaded from ${p}`);
        return cachedManifest;
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
    loaderVersion: computeFallbackVersion(),
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
  return manifest.loaderVersion || computeFallbackVersion();
}

export function invalidateManifestCache(): void {
  cachedManifest = null;
  lastReadTime = 0;
}
