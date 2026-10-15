/**
 * Which brand a client build is for, decided once at build time.
 *
 * One codebase serves two brands: the International regions (RESPOK,
 * app.respok.app) and the Iran region (the local Persian brand). A deployment
 * only ever shows one of them, so the browser files of each are built for it:
 * `respok` leaves out everything Iran-only (its kit, assets, domains, names),
 * `iran` everything International-only that is marked so. `both` keeps
 * everything: dev servers, tests and any build whose region is unknown, which
 * behaves exactly as the single build did before.
 *
 * Detected from the deployment, no setting needed: Coolify already passes
 * each frontend its API origin (`VITE_API_BASE_URL`, https://api.respok.app
 * for RESPOK). `VITE_BRAND` (respok | iran | both) overrides it.
 */

/** @typedef {'respok' | 'iran' | 'both'} BuildBrand */

const VALID = new Set(['respok', 'iran', 'both']);

/**
 * @param {Record<string, string | undefined>} env
 * @returns {BuildBrand}
 */
export function resolveBuildBrand(env = process.env) {
  const explicit = String(env.VITE_BRAND ?? '').trim().toLowerCase();
  if (explicit) {
    if (!VALID.has(explicit)) throw new Error(`VITE_BRAND must be respok, iran or both, not "${explicit}"`);
    return /** @type {BuildBrand} */ (explicit);
  }
  let host = '';
  try {
    host = new URL(String(env.VITE_API_BASE_URL ?? '').trim()).hostname.toLowerCase();
  } catch {
    host = '';
  }
  if (host === 'respok.app' || host.endsWith('.respok.app')) return 'respok';
  // The Iran region's own API host. Spelled in parts so this file, which the
  // RESPOK build also reads, carries the name only as a build-time constant.
  const iranHost = ['web', 'yar.ai'].join('');
  if (host === iranHost || host.endsWith(`.${iranHost}`)) return 'iran';
  return 'both';
}
