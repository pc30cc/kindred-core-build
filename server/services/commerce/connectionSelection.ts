/**
 * Which connection a turn (or a widget request) is about.
 *
 * This used to be "the workspace's newest un-revoked connection". That was
 * only ever right while a workspace could have one kind of connection: with a
 * WooCommerce store AND a WHMCS billing system in the same workspace, "newest"
 * silently pointed the shop's AI stage at the billing system (and the other
 * way round), bound shop customers against the wrong installation, and let a
 * link verifier strip every WHMCS link as an invented product URL.
 *
 * The rule now, in order — every step is PROVABLE, none is a guess:
 *
 *   1. The connection the visitor's identity is bound to (identity links are
 *      written against exactly one connection).
 *   2. The connection whose site the visitor is on. `pageOrigin` is the
 *      widget's page context, which server/routes/widget.ts only accepts when
 *      it matches the request Origin or the workspace's allowed domains. When
 *      two connections share a host (WHMCS under /billing, the shop at /), the
 *      longest matching base path wins. A page that belongs to a connection of
 *      ANOTHER family means this family is not in context for the turn.
 *   3. The only connection of the requested family. This is the legacy
 *      fallback (older widgets, non-widget channels): it is allowed only
 *      because it is unambiguous.
 *
 * Anything else is `ambiguous` and selects nothing.
 *
 * One SELECT per turn (listWorkspaceConnections) feeds every stage; the
 * selection itself is pure and unit-tested (src/test/commerce/connectionSelection.test.ts).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type { CommerceConnectionRow } from './gateway.js';
import { getProviderDescriptor, type ProviderFamily } from './connectors/registry.js';

// external_store_id / platform_version / last_error_at: a direct store
// (OpenCart) is called with its store scope, version and last error straight
// from the selected row. One literal, so the typed client can parse it.
export const CONNECTION_SELECT_FIELDS =
  'id, workspace_id, installation_id, provider_type, store_id, approved_origin, capabilities, permissions, health, catalog_ready, revoked_at, protocol_version, created_at, external_store_id, platform_version, last_error_at';

/** More than this many live connections in one workspace is not a real configuration. */
const MAX_CONNECTIONS = 10;

export type SelectionReason = 'bound' | 'page_origin' | 'only_one' | 'other_site' | 'ambiguous' | 'none';

export interface SelectionInput {
  family: ProviderFamily;
  /** Validated page origin from the widget, if any. */
  pageOrigin?: string | null;
  /** Validated page path, if any — disambiguates two connections on one host. */
  pagePath?: string | null;
  /** Connection an identity link already names. */
  boundConnectionId?: string | null;
}

export interface SelectionResult {
  connection: CommerceConnectionRow | null;
  reason: SelectionReason;
}

export async function listWorkspaceConnections(config: ServerConfig, workspaceId: string): Promise<CommerceConnectionRow[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('commerce_connections')
    .select(CONNECTION_SELECT_FIELDS)
    .eq('workspace_id', workspaceId)
    .is('revoked_at', null)
    .limit(MAX_CONNECTIONS);
  if (error) throw new Error(`commerce connection read failed: ${error.message}`);
  return (data as CommerceConnectionRow[] | null) ?? [];
}

function originOf(value: string | null | undefined): string | null {
  if (!value) return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function basePathOf(row: CommerceConnectionRow): string {
  try {
    const path = new URL(String(row.store_id || row.approved_origin)).pathname.replace(/\/+$/, '');
    return path || '';
  } catch {
    return '';
  }
}

function familyOf(row: CommerceConnectionRow): ProviderFamily | null {
  return getProviderDescriptor(row.provider_type)?.family ?? null;
}

function usable(row: CommerceConnectionRow): boolean {
  return !row.revoked_at && row.health !== 'disconnected';
}

/** The connection a page belongs to, or null when no connection claims that site. */
export function connectionForPage(
  rows: readonly CommerceConnectionRow[],
  pageOrigin: string | null | undefined,
  pagePath: string | null | undefined,
): { row: CommerceConnectionRow | null; ambiguous: boolean } {
  const origin = originOf(pageOrigin);
  if (!origin) return { row: null, ambiguous: false };
  const onHost = rows.filter((r) => usable(r) && originOf(r.approved_origin) === origin);
  if (!onHost.length) return { row: null, ambiguous: false };
  if (onHost.length === 1) return { row: onHost[0], ambiguous: false };

  if (typeof pagePath === 'string' && pagePath.startsWith('/')) {
    const matching = onHost
      .map((r) => ({ r, base: basePathOf(r) }))
      .filter(({ base }) => base === '' || pagePath === base || pagePath.startsWith(`${base}/`))
      .sort((a, z) => z.base.length - a.base.length);
    if (matching.length && (matching.length === 1 || matching[0].base.length > matching[1].base.length)) {
      return { row: matching[0].r, ambiguous: false };
    }
  }
  return { row: null, ambiguous: true };
}

export function selectConnection(rows: readonly CommerceConnectionRow[], input: SelectionInput): SelectionResult {
  const candidates = rows.filter((r) => usable(r) && familyOf(r) === input.family);

  if (input.boundConnectionId) {
    const bound = candidates.find((r) => r.id === input.boundConnectionId);
    if (bound) return { connection: bound, reason: 'bound' };
  }

  const page = connectionForPage(rows, input.pageOrigin, input.pagePath);
  if (page.row) {
    return familyOf(page.row) === input.family
      ? { connection: page.row, reason: 'page_origin' }
      : { connection: null, reason: 'other_site' };
  }
  if (page.ambiguous) {
    // Two connections on this host and the path did not settle it: only a
    // family with exactly one of them there is unambiguous.
    const origin = originOf(input.pageOrigin);
    const sameFamilyOnHost = candidates.filter((r) => originOf(r.approved_origin) === origin);
    if (sameFamilyOnHost.length === 1) return { connection: sameFamilyOnHost[0], reason: 'page_origin' };
    return { connection: null, reason: 'ambiguous' };
  }

  if (candidates.length === 1) return { connection: candidates[0], reason: 'only_one' };
  return { connection: null, reason: candidates.length ? 'ambiguous' : 'none' };
}
