/**
 * Writes a gzip copy (`<file>.gz`, level 9) next to each compressible build
 * file, for nginx's `gzip_static on` (nginx.conf.template, /assets/).
 *
 * Why: nginx otherwise gzips every response on the fly at its default level
 * (1), on every request that misses the cache. A level-9 file made once at
 * build time is ~10-15% smaller and costs the server nothing to send.
 * Brotli is left to Cloudflare, which compresses to visitors on its own;
 * nginx:alpine has no brotli module to serve `.br` files with.
 *
 * Only files that come out smaller are written. No dependencies: Node's zlib.
 *
 * Used by the `precompress` plugin in vite.config.ts after `vite build`
 * writes dist/; also runnable by hand: `node scripts/build/precompress.mjs dist/assets`.
 */
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import zlib from 'node:zlib';

const gzip = promisify(zlib.gzip);

export const COMPRESSIBLE = /\.(?:js|mjs|css|svg|json|html|txt|xml|wasm)$/i;
export const MIN_BYTES = 1024;

/**
 * Gzips `files` (absolute paths). Returns { written, rawBytes, gzipBytes }.
 */
export async function precompressFiles(files, { minBytes = MIN_BYTES } = {}) {
  let written = 0;
  let rawBytes = 0;
  let gzipBytes = 0;
  await Promise.all(
    files
      .filter((file) => COMPRESSIBLE.test(file))
      .map(async (file) => {
        const source = await fs.readFile(file);
        if (source.length < minBytes) return;
        const compressed = await gzip(source, { level: zlib.constants.Z_BEST_COMPRESSION });
        if (compressed.length >= source.length) return;
        await fs.writeFile(`${file}.gz`, compressed);
        written += 1;
        rawBytes += source.length;
        gzipBytes += compressed.length;
      }),
  );
  return { written, rawBytes, gzipBytes };
}

/** Gzips every compressible file directly inside `dir` (not recursive). */
export async function precompressDir(dir, options) {
  const entries = await fs.readdir(dir, { withFileTypes: true });
  const files = entries.filter((e) => e.isFile()).map((e) => path.join(dir, e.name));
  return precompressFiles(files, options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dir = process.argv[2] || 'dist/assets';
  const { written, rawBytes, gzipBytes } = await precompressDir(dir);
  console.log(
    `[precompress] ${written} files in ${dir}: ${(rawBytes / 1024).toFixed(0)} KB -> ${(gzipBytes / 1024).toFixed(0)} KB gzip`,
  );
}
