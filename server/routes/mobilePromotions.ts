/**
 * IN-APP PROMOTIONS — what the native app is allowed to show.
 *
 * The creative lives on the `mobile_app_settings` singleton (Super Admin →
 * Mobile App → Promotions). WHO sees it is a plan question the app already
 * has an answer to, from `/api/plans/workspace/:id/effective` —
 * `mobile_promo_banner` and `mobile_promo_fullscreen`. This route only ships
 * the words, the picture and the pacing, already resolved for one locale.
 *
 * There is no ad network behind it. Nothing is fetched from a third party, no
 * identifier leaves the device and no impression is reported back, which is
 * what keeps the feature clear of App Tracking Transparency (guideline 5.1.2)
 * rather than depending on a prompt.
 *
 * Two rules are enforced here rather than trusted to the client:
 *
 *   • The platform master switch. Off means nothing is served, whatever a
 *     plan says.
 *   • An external link needs a human's acknowledgement. A promotion whose
 *     button leaves the app for somewhere a subscription can be bought falls
 *     under guidelines 3.1.1 and 3.1.3 and needs Apple's External Purchase
 *     Link Entitlement. Until `ads_external_link_acknowledged` is set, the
 *     creative is served with its link stripped — the words still show, the
 *     button does not.
 */
import { Router } from 'express';
import type { Request } from 'express';
import type { ServerConfig } from '../config.js';
import { authorizeWorkspaceAccess, requireUser } from '../lib/workspaceAuth.js';
import {
  loadMobileAppSettings,
  toAndroidAppConfig,
  toAndroidPublicConfig,
  toIosPublicConfig,
  toIosAppConfig,
  MOBILE_APP_DEFAULTS,
} from '../services/mobileApp/settings.js';

export const mobilePromotionsRouter = Router();

function serverConfigOf(req: Request): ServerConfig {
  return (req as unknown as Request & { serverConfig: ServerConfig }).serverConfig;
}

const LOCALES = ['en', 'fa', 'tr'] as const;
type Locale = (typeof LOCALES)[number];

interface Creative {
  title: string;
  body: string;
  ctaLabel: string | null;
  ctaURL: string | null;
  imageURL: string | null;
}

function pickLocale(raw: unknown): Locale {
  const value = String(raw || '').slice(0, 2).toLowerCase();
  return (LOCALES as readonly string[]).includes(value) ? (value as Locale) : 'en';
}

/**
 * Pulls one locale out of a creative blob.
 *
 * Falls back to English when a locale was never written, because a promotion
 * in the wrong language is still better than a card with nothing in it — but
 * a creative with neither a title nor a body is nothing at all, and comes
 * back null so the app draws no space for it.
 */
function creativeFor(
  raw: Record<string, unknown> | null | undefined,
  locale: Locale,
  allowLink: boolean,
): Creative | null {
  if (!raw || typeof raw !== 'object') return null;
  const text = (raw.text ?? {}) as Record<string, Record<string, unknown>>;
  const chosen = (text[locale] ?? text.en ?? {}) as Record<string, unknown>;

  const title = String(chosen.title ?? '').trim();
  const body = String(chosen.body ?? '').trim();
  if (!title && !body) return null;

  const ctaLabel = String(chosen.cta_label ?? '').trim() || null;
  const rawURL = String(raw.cta_url ?? '').trim();
  const isHTTPS = /^https:\/\//i.test(rawURL);
  const ctaURL = isHTTPS && allowLink ? rawURL : null;
  const imageURL = /^https:\/\//i.test(String(raw.image_url ?? '').trim())
    ? String(raw.image_url).trim()
    : null;

  return {
    title,
    body,
    // A button with nowhere to go is not a button.
    ctaLabel: ctaURL ? ctaLabel : null,
    ctaURL,
    imageURL,
  };
}

mobilePromotionsRouter.get('/promotions', async (req, res) => {
  const workspaceId = String(req.query.workspace_id || '');
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return;

  try {
    const settings = await loadMobileAppSettings(serverConfigOf(req));
    if (!settings.ads_enabled) {
      return res.json({ enabled: false, banner: null, fullscreen: null });
    }

    const locale = pickLocale(req.query.locale);
    const allowLink = settings.ads_external_link_acknowledged === true;

    return res.json({
      enabled: true,
      banner: creativeFor(settings.ads_banner, locale, allowLink),
      fullscreen: creativeFor(settings.ads_fullscreen, locale, allowLink),
      minIntervalMinutes: settings.ads_min_interval_minutes,
      maxPerDay: settings.ads_max_per_day,
      startAfterLaunches: settings.ads_start_after_launches,
      // Said out loud so the app never has to guess why a button is missing.
      externalLinksAllowed: allowLink,
    });
  } catch (err) {
    // A promotion is never worth an error state. Silence is the right failure.
    return res.json({ enabled: false, banner: null, fullscreen: null });
  }
});

/**
 * GET /api/mobile-app/config?platform=android|ios — how the installed app should
 * behave: which Settings sections it shows and which profile fields an
 * operator may change. Written in Super Admin → Mobile App → Android. The
 * Android shape also carries `defaultLanguage` and `maintenance`, the same
 * values /public-config below serves before sign-in.
 *
 * Signed-in users only — it is not a secret, but it is not a public page
 * either. Like the promotions above it never fails the app: an error answers
 * with the defaults, which are how the app behaved before the switches
 * existed.
 */
mobilePromotionsRouter.get('/config', async (req, res) => {
  const userId = await requireUser(req, res);
  if (!userId) return;
  const platform = String(req.query.platform || 'android');
  if (platform !== 'android' && platform !== 'ios') {
    return res.status(400).json({ error: 'Unknown platform' });
  }
  const shape = platform === 'ios' ? toIosAppConfig : toAndroidAppConfig;
  try {
    const settings = await loadMobileAppSettings(serverConfigOf(req));
    return res.json(shape(settings));
  } catch {
    return res.json(shape(MOBILE_APP_DEFAULTS));
  }
});

/**
 * GET /api/mobile-app/public-config?platform=android|ios — what the app must
 * know BEFORE anyone signs in: the language to open in until the operator
 * picks one, and on Android whether a maintenance notice is up (while it is,
 * nobody can sign in, and the sign-in screen shows the notice instead).
 *
 *   → { platform: 'android',
 *       defaultLanguage: 'fa' | 'en' | 'tr',
 *       maintenance: { enabled, message: { fa?, en?, tr? }, until } }
 *   → { platform: 'ios', defaultLanguage: 'fa' | 'en' | 'tr' }
 *
 * Unauthenticated on purpose, like GET /api/platform/desktop-app: the answer
 * is needed on the sign-in screen, and nothing in it is secret. Auth in this
 * server is per route, so no allow-list needs to know about it; the global
 * IP block and abuse detection in server/index.ts still apply.
 *
 * Never fails the app: an error answers with the defaults (Persian, no
 * notice), which is how the app behaved before these settings existed.
 * `no-store`, so no proxy holds on to a notice after it is switched off; the
 * row itself comes from loadMobileAppSettings' short in-process cache, which
 * every Super Admin save drops, and the end time is judged per request.
 */
mobilePromotionsRouter.get('/public-config', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  const platform = String(req.query.platform || 'android');
  if (platform !== 'android' && platform !== 'ios') {
    return res.status(400).json({ error: 'Unknown platform' });
  }
  const shape = (settings: typeof MOBILE_APP_DEFAULTS) =>
    platform === 'ios' ? toIosPublicConfig(settings) : toAndroidPublicConfig(settings);
  try {
    const settings = await loadMobileAppSettings(serverConfigOf(req));
    return res.json(shape(settings));
  } catch {
    return res.json(shape(MOBILE_APP_DEFAULTS));
  }
});
