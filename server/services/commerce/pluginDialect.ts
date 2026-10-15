/**
 * The two dialects the commerce plugins speak (docs/commerce/CONNECTOR_PROTOCOL.md).
 *
 * The same plugin sources are packaged twice (scripts/build/pluginEdition.mjs):
 *
 *   - `legacy`  — the Iran region's packages, exactly as every store that has
 *                 one installed today runs them: `X-WebYar-*` headers,
 *                 protocol `webyar-commerce/1`, module code `webyar`
 *                 (WordPress REST namespace `webyar/v1`, WHMCS addon folder
 *                 `modules/addons/webyar`, OpenCart extension code `webyar`).
 *   - `neutral` — the International (RESPOK) packages: brand-neutral wire
 *                 names (`X-Platform-*`, `platform-commerce/1`,
 *                 `platform-widget`) and the module code `respok`.
 *
 * Both deployments accept both: what a plugin sends is read in whichever
 * dialect it carries, and what Web Yar sends a store is in the dialect that
 * store's connection recorded (`commerce_connections.protocol_version`, set at
 * pairing from the plugin's callback URL and then from its own handshake
 * answer). An unknown or missing value is the legacy dialect, which is what
 * every connection made before this file existed speaks.
 *
 * Only the string-to-sign's first line differs (the protocol); the HMAC, the
 * canonical paths' shape and every payload are the same in both.
 */

export type PluginDialectId = 'legacy' | 'neutral';

export interface PluginDialect {
  id: PluginDialectId;
  /** Protocol version: first line of the string-to-sign, the `*-Protocol` header and `protocol_version` fields. */
  protocol: string;
  /** Prefix of every machine header, e.g. `X-WebYar-Signature`. */
  headerPrefix: string;
  /**
   * The plugin's module code: WordPress REST namespace (`/wp-json/<code>/v1`),
   * WHMCS addon folder (`modules/addons/<code>`), OpenCart extension code.
   */
  moduleCode: string;
  /** Audience of the customer identity assertions the store signs for the widget. */
  identityAudience: string;
  /** Logical path the WHMCS request signature covers. */
  whmcsCanonicalPath: string;
}

export const LEGACY_DIALECT: Readonly<PluginDialect> = Object.freeze({
  id: 'legacy',
  protocol: 'webyar-commerce/1',
  headerPrefix: 'X-WebYar-',
  moduleCode: 'webyar',
  identityAudience: 'webyar-widget',
  whmcsCanonicalPath: '/webyar/whmcs/v1',
});

export const NEUTRAL_DIALECT: Readonly<PluginDialect> = Object.freeze({
  id: 'neutral',
  protocol: 'platform-commerce/1',
  headerPrefix: 'X-Platform-',
  moduleCode: 'respok',
  identityAudience: 'platform-widget',
  whmcsCanonicalPath: '/platform/whmcs/v1',
});

export const PLUGIN_DIALECTS: ReadonlyArray<Readonly<PluginDialect>> = [LEGACY_DIALECT, NEUTRAL_DIALECT];

/** Every protocol version Web Yar speaks. */
export const KNOWN_PROTOCOL_VERSIONS: ReadonlyArray<string> = PLUGIN_DIALECTS.map((d) => d.protocol);

export function isKnownProtocolVersion(value: unknown): value is string {
  return typeof value === 'string' && KNOWN_PROTOCOL_VERSIONS.includes(value);
}

/** The dialect of a protocol version; legacy for an unknown or missing one. */
export function dialectForProtocol(protocolVersion: string | null | undefined): Readonly<PluginDialect> {
  return protocolVersion === NEUTRAL_DIALECT.protocol ? NEUTRAL_DIALECT : LEGACY_DIALECT;
}

/** The dialect whose protocol is exactly `protocolVersion`, or null. */
export function dialectOfKnownProtocol(protocolVersion: string | null | undefined): Readonly<PluginDialect> | null {
  return PLUGIN_DIALECTS.find((d) => d.protocol === protocolVersion) ?? null;
}

/**
 * Which plugin build is pairing, from the callback URL it registered: every
 * package's callback carries its module code in the path or query
 * (`admin-post.php?action=<code>_wc_pairing_callback`,
 * `addonmodules.php?module=<code>`, `route=extension/<code>/module/<code>.callback`).
 * The host is ignored, so a shop whose domain happens to contain either name
 * is not misread. Legacy unless the neutral build's code is there and the
 * legacy one is not.
 */
export function dialectFromRedirectUri(redirectUri: string | null | undefined): Readonly<PluginDialect> {
  let tail = '';
  try {
    const u = new URL(String(redirectUri ?? ''));
    tail = `${u.pathname}${u.search}`.toLowerCase();
  } catch {
    return LEGACY_DIALECT;
  }
  if (tail.includes(LEGACY_DIALECT.moduleCode)) return LEGACY_DIALECT;
  return tail.includes(NEUTRAL_DIALECT.moduleCode) ? NEUTRAL_DIALECT : LEGACY_DIALECT;
}

export type MachineHeader = 'Installation' | 'Timestamp' | 'Nonce' | 'Signature' | 'Protocol' | 'Correlation';

export function headerName(dialect: Readonly<PluginDialect>, header: MachineHeader): string {
  return `${dialect.headerPrefix}${header}`;
}

export interface SignedRequestHeaders {
  dialect: Readonly<PluginDialect>;
  installationId?: string;
  timestamp?: string;
  nonce?: string;
  signature?: string;
  protocolVersion?: string;
}

/**
 * Reads the signed-request headers of an inbound plugin call in either
 * dialect. The dialect is the one whose `*-Protocol` header is present (the
 * neutral one wins only when the legacy one is absent), and every other
 * header is read in that same dialect only, never mixed.
 */
export function readSignedRequestHeaders(getHeader: (name: string) => string | undefined): SignedRequestHeaders {
  const hasNeutral = !!getHeader(headerName(NEUTRAL_DIALECT, 'Protocol')) || !!getHeader(headerName(NEUTRAL_DIALECT, 'Installation'));
  const hasLegacy = !!getHeader(headerName(LEGACY_DIALECT, 'Protocol')) || !!getHeader(headerName(LEGACY_DIALECT, 'Installation'));
  const dialect = hasNeutral && !hasLegacy ? NEUTRAL_DIALECT : LEGACY_DIALECT;
  return {
    dialect,
    installationId: getHeader(headerName(dialect, 'Installation')),
    timestamp: getHeader(headerName(dialect, 'Timestamp')),
    nonce: getHeader(headerName(dialect, 'Nonce')),
    signature: getHeader(headerName(dialect, 'Signature')),
    protocolVersion: getHeader(headerName(dialect, 'Protocol')),
  };
}

/** The installation header of either dialect (rate-limit keys). */
export function installationHeader(getHeader: (name: string) => string | undefined): string | undefined {
  return getHeader(headerName(LEGACY_DIALECT, 'Installation')) || getHeader(headerName(NEUTRAL_DIALECT, 'Installation'));
}
