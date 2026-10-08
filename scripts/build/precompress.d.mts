// Types for precompress.mjs (imported by vite.config.ts).
export const COMPRESSIBLE: RegExp;
export const MIN_BYTES: number;

export interface PrecompressResult {
  written: number;
  rawBytes: number;
  gzipBytes: number;
}

export function precompressFiles(files: string[], options?: { minBytes?: number }): Promise<PrecompressResult>;
export function precompressDir(dir: string, options?: { minBytes?: number }): Promise<PrecompressResult>;
