/**
 * PUBLIC DESKTOP APP CONFIG — what the Windows app should do on this launch.
 *
 * The desktop app reads its update feed and its runtime tuning from here on
 * every launch, instead of trusting whatever was compiled into the signed
 * installer. Super Admin → Desktop app writes the `desktop_app_settings` row;
 * this route is the read side, so moving the release feed, pinning a
 * minimum supported version, or turning realtime/polling/calls up or down
 * reaches every installed copy without shipping a new build.
 *
 *   GET /api/platform/desktop-app
 *   → { update:   { feedUrl, channel, latestVersion, minimumSupportedVersion,
 *                   downloadUrl, releaseNotes, autoUpdate, checkIntervalMinutes },
 *       realtime: { enabled },
 *       polling:  { intervalSeconds, withRealtimeSeconds },
 *       features: { calls } }
 *
 * Unauthenticated on purpose: the app needs the answer before anyone signs
 * in (an out-of-date build may not even be able to), and every field here is
 * already public — the feed URL is a public release page. Nothing secret is
 * ever put in this answer.
 *
 * Never 5xx. A client that cannot be told what to do keeps working with the
 * defaults, which reproduce the behaviour the app shipped with.
 */
import { Router } from 'express';
import type { Request } from 'express';
import type { ServerConfig } from '../config.js';
import {
  loadDesktopAppSettings,
  toPublicDesktopAppConfig,
  DESKTOP_APP_DEFAULTS,
  type DesktopAppPublicConfig,
} from '../services/desktopApp/settings.js';
import {
  loadMacosAppSettings,
  toPublicMacosAppConfig,
  MACOS_APP_DEFAULTS,
  type MacosAppPublicConfig,
} from '../services/desktopApp/macosSettings.js';

export const desktopAppPublicRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

const TTL_MS = 60_000;
let cache: DesktopAppPublicConfig | null = null;
let cachedAt = 0;

let macCache: MacosAppPublicConfig | null = null;
let macCachedAt = 0;

/** Called by the admin PUT so a saved change is served on the next launch. */
export function invalidateDesktopAppPublicCache(): void {
  cache = null;
  cachedAt = 0;
}

/** Called by the macOS admin PUT. */
export function invalidateMacosAppPublicCache(): void {
  macCache = null;
  macCachedAt = 0;
}

desktopAppPublicRouter.get('/desktop-app', async (req, res) => {
  // Cached in process: asked once per launch (and per update check) by every
  // installed copy, for a row that changes once per release.
  if (cache && Date.now() - cachedAt < TTL_MS) {
    return res.json(cache);
  }
  try {
    const settings = await loadDesktopAppSettings(serverConfigOf(req));
    cache = toPublicDesktopAppConfig(settings);
    cachedAt = Date.now();
    return res.json(cache);
  } catch {
    return res.json(toPublicDesktopAppConfig(DESKTOP_APP_DEFAULTS));
  }
});

/**
 *   GET /api/platform/macos-app
 *   → { update, realtime, polling, features, system, defaults, maintenance, links }
 *
 * The Mac app's counterpart of /desktop-app, from Super Admin → macOS app
 * (server/services/desktopApp/macosSettings.ts). Same rules: public, never
 * secret, never 5xx — the defaults are what the app shipped with.
 */
desktopAppPublicRouter.get('/macos-app', async (req, res) => {
  if (macCache && Date.now() - macCachedAt < TTL_MS) {
    return res.json(macCache);
  }
  try {
    const settings = await loadMacosAppSettings(serverConfigOf(req));
    macCache = toPublicMacosAppConfig(settings);
    macCachedAt = Date.now();
    return res.json(macCache);
  } catch {
    return res.json(toPublicMacosAppConfig(MACOS_APP_DEFAULTS));
  }
});
