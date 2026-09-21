/**
 * How the WooCommerce plugin reaches a store.
 *
 * Two files at fixed paths are read as a pair: `webyar-woocommerce.json`
 * announces a version, and the installed plugin then downloads the `.zip`
 * beside it. Whatever a CDN holds for those paths is what every store gets
 * until it expires — and Cloudflare caches a `.zip` by default while leaving
 * a `.json` alone, so the pair can disagree: the manifest advertises a
 * release the archive does not contain yet. WordPress installs the old
 * build, still reads the old version afterwards, and with auto-updates on
 * retries on every cron run.
 *
 * That is not hypothetical — it is what `app.webyar.ai` was serving when the
 * updater first went live (a 70-minute-old archive behind a fresh manifest).
 * So the delivery rule is held here rather than left to a deploy-time
 * detail nobody re-reads.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const TEMPLATE = readFileSync(resolve(process.cwd(), 'nginx.conf.template'), 'utf8');

/** The body of a `location` block, by the prefix it matches, comments stripped. */
function locationBlock(match: string): string {
  const start = TEMPLATE.indexOf(`location ${match} {`);
  expect(start, `no "location ${match}" block in nginx.conf.template`).toBeGreaterThan(-1);

  let depth = 0;
  for (let i = TEMPLATE.indexOf('{', start); i < TEMPLATE.length; i++) {
    if (TEMPLATE[i] === '{') depth++;
    else if (TEMPLATE[i] === '}' && --depth === 0) {
      // Comments explain the directives; they are not the directives, and a
      // sentence naming index.html must not read as a fallback to it.
      return TEMPLATE.slice(start, i + 1).replace(/^\s*#.*$/gm, '');
    }
  }
  throw new Error(`unterminated "location ${match}" block`);
}

describe('the plugin download and its update manifest', () => {
  const downloads = locationBlock('^~ /downloads/');

  it('tells Cloudflare not to hold either file', () => {
    // Cache-Control alone is not enough: CF applies its own Cache Rules and
    // a default edge TTL by extension, which is how a .zip gets cached for
    // four hours while the .json beside it is not cached at all.
    expect(downloads).toMatch(/add_header\s+Cloudflare-CDN-Cache-Control\s+"no-store"/);
    expect(downloads).toMatch(/add_header\s+CDN-Cache-Control\s+"no-store"/);
    expect(downloads).toMatch(/add_header\s+Cache-Control\s+"[^"]*no-store[^"]*"/);
  });

  it('wins over the SPA fallback rather than depending on where it sits in the file', () => {
    // `^~` makes nginx stop at this prefix; a plain `location /downloads/`
    // would lose to any regex location added later.
    expect(TEMPLATE).toContain('location ^~ /downloads/ {');
  });

  it('404s a missing file instead of handing a store the SPA to unzip', () => {
    expect(downloads).toMatch(/try_files\s+\$uri\s+=404;/);
    expect(downloads).not.toContain('index.html');
  });

  it('serves the same directory the build writes into', () => {
    // scripts/build-woocommerce-plugin-zip.mjs writes public/downloads/,
    // which the image copies to the nginx root.
    expect(downloads).toMatch(/root\s+\/usr\/share\/nginx\/html;/);
  });
});
