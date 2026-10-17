#!/usr/bin/env node
/**
 * Are the Cloudflare ranges built into server/utils/clientIp.ts still the ones
 * Cloudflare publishes? The backend believes cf-connecting-ip only from those
 * ranges, so a range Cloudflare adds and we do not know yet makes its edges
 * plain clients (shared per-edge buckets, no country) until the list or
 * CLOUDFLARE_IPS is updated. Run weekly by .github/workflows/cloudflare-ips.yml;
 * exits 1 with the difference when the lists drift.
 *
 *   node scripts/security/check-cloudflare-ips.mjs
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve, dirname } from 'node:path';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SOURCE = resolve(ROOT, 'server/utils/clientIp.ts');

/** The two lists as written in clientIp.ts. */
export function builtInRanges(source = readFileSync(SOURCE, 'utf8')) {
  const read = (name) => {
    const m = source.match(new RegExp(`${name}[^=]*=\\s*\\[([^\\]]*)\\]`));
    if (!m) throw new Error(`${name} not found in server/utils/clientIp.ts`);
    return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1]);
  };
  return { ipv4: read('CLOUDFLARE_IPV4_RANGES'), ipv6: read('CLOUDFLARE_IPV6_RANGES') };
}

/** What `published` has that `ours` lacks, and the other way round. */
export function rangeDiff(ours, published) {
  const a = new Set(ours.map((s) => s.toLowerCase()));
  const b = new Set(published.map((s) => s.toLowerCase()));
  return { missing: [...b].filter((x) => !a.has(x)), stale: [...a].filter((x) => !b.has(x)) };
}

async function main() {
  const res = await fetch('https://api.cloudflare.com/client/v4/ips', { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error(`api.cloudflare.com/client/v4/ips answered ${res.status}`);
  const body = await res.json();
  const published = { ipv4: body?.result?.ipv4_cidrs ?? [], ipv6: body?.result?.ipv6_cidrs ?? [] };
  if (!published.ipv4.length || !published.ipv6.length) throw new Error('Cloudflare returned no ranges');
  const ours = builtInRanges();
  let drift = false;
  for (const family of ['ipv4', 'ipv6']) {
    const { missing, stale } = rangeDiff(ours[family], published[family]);
    if (missing.length || stale.length) {
      drift = true;
      console.error(`${family}: published but not built in: ${missing.join(', ') || '-'}; built in but no longer published: ${stale.join(', ') || '-'}`);
    }
  }
  if (drift) {
    console.error('Update CLOUDFLARE_IPV4_RANGES / CLOUDFLARE_IPV6_RANGES in server/utils/clientIp.ts (or set CLOUDFLARE_IPS on the backends until a deploy).');
    process.exit(1);
  }
  console.log(`Cloudflare ranges match (etag ${body?.result?.etag ?? '?'}): ${ours.ipv4.length} IPv4, ${ours.ipv6.length} IPv6.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
}
