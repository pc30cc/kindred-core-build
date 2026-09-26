/**
 * Provider endpoint (base URL) policy shared by Core and the AI Runtime.
 *
 * PURE LOGIC ONLY — no provider hostnames, no sockets (DNS resolution happens
 * inside `checkOutboundUrl`). Core uses it to reject a bad workspace base URL
 * on write; the AI Runtime uses the same allow-list at connect time.
 *
 * Who may point the AI at what:
 *   - A WORKSPACE-supplied base URL must be https to a public host (every DNS
 *     answer public). It is re-validated and DNS-pinned by the AI Runtime on
 *     every request (runtime/ai/providers/safeTransport.ts).
 *   - The OPERATOR can explicitly allow specific private/self-hosted LLM hosts
 *     (e.g. an in-cluster Ollama) with AI_PROVIDER_PRIVATE_HOSTS — a comma
 *     separated list of exact hostnames or IP literals. Allow-listed hosts may
 *     resolve to private addresses and may use plain http. Set it on BOTH Core
 *     (write validation) and the AI Runtime (connect-time enforcement).
 *   - The PLATFORM default provider (app_runtime_config.default_ai_provider,
 *     writable only by platform admins) is operator configuration and is not
 *     subject to this policy.
 */
import { checkOutboundUrl, normalizeHostname } from '../net/hostGuard.js';

export const AI_PROVIDER_PRIVATE_HOSTS_ENV = 'AI_PROVIDER_PRIVATE_HOSTS';

/** Parses the operator allow-list (exact hostnames / IP literals, case-insensitive). */
export function parsePrivateHostAllowList(raw: string | undefined | null): Set<string> {
  const out = new Set<string>();
  for (const part of String(raw || '').split(/[\s,]+/)) {
    const host = normalizeHostname(part.trim());
    if (host) out.add(host);
  }
  return out;
}

/** True when the operator explicitly allowed this (possibly private) provider host. */
export function isOperatorAllowedPrivateHost(
  hostname: string,
  env: Record<string, string | undefined> = process.env,
): boolean {
  const host = normalizeHostname(hostname || '');
  if (!host) return false;
  return parsePrivateHostAllowList(env[AI_PROVIDER_PRIVATE_HOSTS_ENV]).has(host);
}

export type ProviderBaseUrlCheck = { ok: true } | { ok: false; reason: string };

/**
 * Validates a workspace-supplied provider base URL. https + public host, or an
 * operator allow-listed host (http permitted there). Fail-closed on DNS error.
 */
export async function checkWorkspaceProviderBaseUrl(
  raw: string,
  env: Record<string, string | undefined> = process.env,
): Promise<ProviderBaseUrlCheck> {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  if (u.username || u.password) return { ok: false, reason: 'credentials_not_allowed' };
  if (isOperatorAllowedPrivateHost(u.hostname, env)) {
    return u.protocol === 'https:' || u.protocol === 'http:'
      ? { ok: true }
      : { ok: false, reason: 'unsafe_url' };
  }
  return checkOutboundUrl(raw);
}
