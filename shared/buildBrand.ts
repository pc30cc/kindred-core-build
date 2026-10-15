/**
 * The brand this client build is for (scripts/build/brand.mjs): `respok`,
 * `iran` or `both`. Vite replaces the `globalThis.__…__` reads below with
 * literals (vite.config.ts `define`), so a branch on these constants is
 * removed from the bundle together with what only it imports: the Iranian
 * kit's code, logos and text in the RESPOK build.
 *
 * Use them as plain conditions (`if (SHIPS_IRAN_KIT)`, `SHIPS_IRAN_KIT && …`)
 * and keep Iran-only values behind them; a value read outside such a branch
 * stays in every build.
 *
 * Outside a Vite build (the server, scripts) nothing is replaced and
 * everything is shipped (`both`), as before.
 */
declare global {
  var __BUILD_BRAND__: 'respok' | 'iran' | 'both' | undefined;
  var __SHIPS_IRAN_KIT__: boolean | undefined;
  var __SHIPS_INTL_KIT__: boolean | undefined;
}

export type BuildBrand = 'respok' | 'iran' | 'both';

export const BUILD_BRAND: BuildBrand = globalThis.__BUILD_BRAND__ ?? 'both';

/** False in the RESPOK build: nothing Iran-only may reach its browsers. */
export const SHIPS_IRAN_KIT: boolean = globalThis.__SHIPS_IRAN_KIT__ ?? true;

/** False in the Iran build: International-only extras are left out of it. */
export const SHIPS_INTL_KIT: boolean = globalThis.__SHIPS_INTL_KIT__ ?? true;
