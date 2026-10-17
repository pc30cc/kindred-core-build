/**
 * Runs scripts/call-widget-hash.js on a scratch copy of public/call-widget
 * (CALL_WIDGET_BUILD_ROOT), as `npm run build` does after `vite build` has
 * copied public/ into dist/. For the call widget's build and loader tests.
 */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

export const ROOT = process.cwd();
/** The chat widget's hashed font stylesheet and LiveKit SDK, as its manifest names them. */
export const FONTS_NAME = 'presentation-default-fonts.0a1b2c3d.css';
export const LIVEKIT_NAME = 'vendor/livekit-client.umd.min.4e5f6a7b.js';

export interface CallWidgetBuildManifest {
  files: Record<string, string>;
  livekit: string | null;
  fonts: string | null;
}
export interface CallWidgetBuild {
  /** dist/call-widget of the scratch tree. */
  dist: string;
  manifest: CallWidgetBuildManifest;
  /** The shipped l.js. */
  loader: string;
  read(name: string): Buffer;
  cleanup(): void;
}

/**
 * @param brand VITE_BRAND, or null for unset (the build then ships `both`).
 * @param withFonts whether dist/widget/widget-manifest.json names the fonts.
 */
export function buildCallWidget(brand: 'iran' | 'respok' | 'both' | null, withFonts = true): CallWidgetBuild {
  const dir = mkdtempSync(join(tmpdir(), 'call-widget-build-'));
  cpSync(resolve(ROOT, 'public/call-widget'), join(dir, 'public/call-widget'), { recursive: true });
  cpSync(resolve(ROOT, 'public/call-widget'), join(dir, 'dist/call-widget'), { recursive: true });
  if (withFonts) {
    mkdirSync(join(dir, 'dist/widget'), { recursive: true });
    writeFileSync(join(dir, 'dist/widget/widget-manifest.json'), JSON.stringify({
      'presentation-default-fonts.css': FONTS_NAME,
      'vendor/livekit-client.umd.min.js': LIVEKIT_NAME,
    }));
  }
  const env: NodeJS.ProcessEnv = { ...process.env, CALL_WIDGET_BUILD_ROOT: dir };
  delete env.VITE_BRAND;
  delete env.VITE_API_BASE_URL;
  if (brand) env.VITE_BRAND = brand;
  execFileSync(process.execPath, [resolve(ROOT, 'scripts/call-widget-hash.js')], { cwd: ROOT, env, stdio: 'pipe' });
  const dist = join(dir, 'dist/call-widget');
  const read = (name: string) => readFileSync(join(dist, name));
  return {
    dist,
    manifest: JSON.parse(read('call-widget-manifest.json').toString('utf8')),
    loader: read('l.js').toString('utf8'),
    read,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}
