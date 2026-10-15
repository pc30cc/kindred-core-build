// Types for brand.mjs (imported by vite.config.ts).
export type BuildBrand = 'respok' | 'iran' | 'both';
export const IRAN_BRAND_PATTERNS: RegExp[];
export function resolveBuildBrand(env?: Record<string, string | undefined>): BuildBrand;
