/**
 * CDN cache purge for a deleted owner (workspace or account).
 *
 * Deleting an owner removes its objects from every storage scope, but a CDN
 * in front of that storage keeps serving whatever it already cached — with
 * Bunny's default long max-age, a deleted file stayed downloadable from
 * cdn.<domain> for months. After the purge, every cached URL under the
 * owner's prefix (`workspace/<id>/`, `users/<id>/`) is evicted.
 *
 * Best effort by design: the storage and DB purge are the source of truth
 * and have already happened, so a CDN failure is logged and reported, never
 * thrown into the deletion worker.
 */
import type { ServerConfig } from '../../config.js';
import { resolveCDNConfig, type CDNConfig } from './index.js';

/** Stand-in workspace id for account-level files: no per-workspace CDN override applies to them, only the global one. */
const NO_WORKSPACE = '00000000-0000-0000-0000-000000000000';

export type OwnerCdnPurgeResult =
  | { ok: true; url: string }
  | { ok: false; skipped: true; reason: string }
  | { ok: false; skipped: false; error: string };

/**
 * The CDN config that serves an owner's files. Resolve it BEFORE the DB
 * purge: a workspace's own CDN override lives in provider_configs, which
 * that purge deletes. Never throws; null when nothing is configured.
 */
export async function resolveOwnerCdn(serverConfig: ServerConfig, workspaceId?: string): Promise<CDNConfig | null> {
  try {
    return await resolveCDNConfig(serverConfig, workspaceId ?? NO_WORKSPACE);
  } catch (err) {
    console.warn('[cdn purge] could not resolve CDN config:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

function hostOf(hostname: string): string {
  return hostname.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Evicts every cached URL under `prefix` (e.g. `workspace/<id>/`). Never throws. */
export async function purgeOwnerFromCdn(cdn: CDNConfig | null, prefix: string): Promise<OwnerCdnPurgeResult> {
  if (!cdn) return { ok: false, skipped: true, reason: 'no CDN provider configured' };
  if (cdn.provider !== 'bunny') {
    return { ok: false, skipped: true, reason: `prefix purge not implemented for CDN provider ${cdn.provider}` };
  }
  const host = cdn.hostname || cdn.domain;
  if (!cdn.apiKey || !host) {
    return { ok: false, skipped: true, reason: 'Bunny CDN config is missing api_key or hostname' };
  }

  // A trailing * purges every URL under the path (Bunny wildcard purge).
  const url = `https://${hostOf(host)}/${prefix.replace(/^\/+/, '')}*`;
  try {
    const res = await fetch(`https://api.bunny.net/purge?${new URLSearchParams({ url, async: 'false' })}`, {
      method: 'POST',
      headers: { AccessKey: cdn.apiKey },
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      return { ok: false, skipped: false, error: `Bunny purge failed: ${res.status} ${body.slice(0, 200)}` };
    }
    return { ok: true, url };
  } catch (err) {
    return { ok: false, skipped: false, error: `Bunny purge failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Logs the outcome in one place so both deletion workers report it the same way. */
export function logOwnerCdnPurge(label: string, result: OwnerCdnPurgeResult): void {
  if (result.ok) console.log(`[cdn purge] ${label}: purged ${result.url}`);
  else if (result.skipped) console.warn(`[cdn purge] ${label}: skipped — ${result.reason}`);
  else console.warn(`[cdn purge] ${label}: ${result.error}`);
}
