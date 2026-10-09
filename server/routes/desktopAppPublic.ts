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
import type { Edition } from '../../shared/edition.js';
import { getPlatformEditionOrNull } from '../services/platformRegion.js';
import {
  loadDesktopAppSettings,
  toPublicDesktopAppConfig,
  desktopAppDefaults,
  type DesktopAppPublicConfig,
} from '../services/desktopApp/settings.js';
import {
  loadMacosAppSettings,
  toPublicMacosAppConfig,
  macosAppDefaults,
  type MacosAppPublicConfig,
} from '../services/desktopApp/macosSettings.js';

export const desktopAppPublicRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

const TTL_MS = 60_000;
/**
 * Each answer is the running edition's (migration 257), so each cache
 * remembers whose it is: after a switch of edition the apps are told the
 * other edition's settings on their next ask, not a minute later.
 */
let cache: { edition: Edition | null; value: DesktopAppPublicConfig; at: number } | null = null;
let macCache: { edition: Edition | null; value: MacosAppPublicConfig; at: number } | null = null;

/** Called by the admin PUT so a saved change is served on the next launch. */
export function invalidateDesktopAppPublicCache(): void {
  cache = null;
}

/** Called by the macOS admin PUT. */
export function invalidateMacosAppPublicCache(): void {
  macCache = null;
}

desktopAppPublicRouter.get('/desktop-app', async (req, res) => {
  const config = serverConfigOf(req);
  const edition = await getPlatformEditionOrNull(config);
  // Cached in process: asked once per launch (and per update check) by every
  // installed copy, for a row that changes once per release.
  if (cache && cache.edition === edition && Date.now() - cache.at < TTL_MS) {
    return res.json(cache.value);
  }
  try {
    const settings = await loadDesktopAppSettings(config);
    cache = { edition, value: toPublicDesktopAppConfig(settings), at: Date.now() };
    return res.json(cache.value);
  } catch {
    return res.json(toPublicDesktopAppConfig(desktopAppDefaults(edition)));
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
  const config = serverConfigOf(req);
  const edition = await getPlatformEditionOrNull(config);
  if (macCache && macCache.edition === edition && Date.now() - macCache.at < TTL_MS) {
    return res.json(macCache.value);
  }
  try {
    const settings = await loadMacosAppSettings(config);
    macCache = { edition, value: toPublicMacosAppConfig(settings), at: Date.now() };
    return res.json(macCache.value);
  } catch {
    return res.json(toPublicMacosAppConfig(macosAppDefaults(edition)));
  }
});
