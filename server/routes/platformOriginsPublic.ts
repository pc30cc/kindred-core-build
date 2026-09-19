/**
 * PUBLIC PLATFORM ORIGINS — where everything actually lives.
 *
 * `platform_domains` (Super Admin → Branding) is the one place an operator
 * names the API, the dashboard and the public site. Every server-side consumer
 * already follows it without a redeploy — see `services/platformOrigins.ts`,
 * whose header states the rule plainly: domains must not be baked into build
 * artifacts.
 *
 * The native app was the exception. A signed binary has to contain *some*
 * origin to make its first request — you cannot ask the API where the API is
 * without an API — so it shipped with one compiled in and then kept using it
 * forever, even after the platform moved. This route closes that gap: the
 * compiled value becomes a bootstrap of last resort, and the app asks here on
 * every launch what the real origin is.
 *
 * Unauthenticated on purpose. These are public hostnames — they are in DNS, in
 * the widget snippet and in every email the platform sends. Requiring a
 * session would defeat the point, since the app needs the answer *before* it
 * can sign anybody in.
 */
import { Router } from 'express';
import type { Request } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';

export const platformOriginsPublicRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

const TTL_MS = 60_000;
let cache: Record<string, string | null> | null = null;
let cachedAt = 0;

/**
 * A link, not a base. `help_center_base_url` may legitimately carry a path
 * (`https://app.example.com/help`), and stripping it to the bare origin — as
 * `toOrigin` must do for anything requests are built on — would send everyone
 * who taps "Contact support" to the site root instead of the help centre.
 */
function toLink(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.href.replace(/\/$/, '') : null;
  } catch {
    return null;
  }
}

/** Origin only, https only. A base URL with a path would break every request. */
function toOrigin(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' ? url.origin : null;
  } catch {
    return null;
  }
}

platformOriginsPublicRouter.get('/origins', async (req, res) => {
  // Cached in process: this is asked once per app launch by every device, and
  // it is one row that changes perhaps twice in a platform's life.
  if (cache && Date.now() - cachedAt < TTL_MS) {
    return res.json(cache);
  }

  try {
    const sb = getServiceClient(serverConfigOf(req));
    const { data } = await sb
      .from('platform_domains')
      .select('api_base_url, app_base_url, public_base_url, canonical_base_url, help_center_base_url')
      .limit(1)
      .maybeSingle();

    const publicBaseUrl =
      toOrigin(data?.public_base_url) ?? toOrigin(data?.canonical_base_url);
    const helpCenterUrl = toLink(data?.help_center_base_url);

    cache = {
      apiBaseUrl: toOrigin(data?.api_base_url),
      appBaseUrl: toOrigin(data?.app_base_url),
      publicBaseUrl,
      helpCenterUrl,
      // The canonical origin for <link rel="canonical">. It belongs to the
      // platform, not to a workspace: the dashboard used to build this tag
      // from `workspace_branding.canonical_base_url`, a per-tenant copy that
      // drifted and left every page pointing at a domain the platform had
      // already left.
      canonicalBaseUrl: toOrigin(data?.canonical_base_url) ?? publicBaseUrl,
      // Resolved once, here, so every client agrees on where "Contact support"
      // goes. Clients used to each append their own path and they disagreed:
      // the iOS build script appended `/contact`, which is not a route this
      // app has ever served, while the app itself opened the bare origin.
      //
      // `/help` is the real route (see src/App.tsx). It is only a fallback:
      // set `help_center_base_url` in Super Admin → Branding → Domains and
      // that wins, path and all, without a redeploy.
      supportUrl: helpCenterUrl ?? (publicBaseUrl ? `${publicBaseUrl}/help` : null),
    };
    cachedAt = Date.now();
    return res.json(cache);
  } catch {
    // A client that cannot be told where to go keeps going where it was. An
    // empty answer is the safe one: the app falls back to the origin it just
    // used to ask this question.
    return res.json({
      apiBaseUrl: null, appBaseUrl: null, publicBaseUrl: null, helpCenterUrl: null,
      supportUrl: null, canonicalBaseUrl: null,
    });
  }
});
