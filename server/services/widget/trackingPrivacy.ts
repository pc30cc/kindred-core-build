/**
 * What the widget may track of a visitor, and how (P-01).
 *
 *   - Consent. A workspace may ask the widget to wait for the visitor's
 *     consent before tracking (`widget_settings.tracking_requires_consent`,
 *     migration 281, "Wait for visitor consent before tracking"), and a
 *     browser sending Global Privacy Control (the `Sec-GPC: 1` request
 *     header; `navigator.globalPrivacyControl` in the loader) is treated the
 *     same way. The page gives consent with `__gs.push(['consent', true])`
 *     (docs/WIDGET_PUBLIC_API.md); the loader then sends `consent: true` on
 *     POST /api/widget/track. Without it, /track records nothing: no visitor
 *     session, no page view, no presence. `consent: false` is never tracked.
 *   - Query strings. A tracked page is its path; its query string is kept
 *     only when the workspace keeps it (`tracking_keep_query`, default off),
 *     so `?email=…` or `?token=…` never reaches page history. A referrer is
 *     stored without its query or fragment, always. The UTM parameters are
 *     read by the loader before and stored in their own columns.
 *
 * Read from the workspace's cached widget snapshot (configSnapshot.ts). A
 * database before migration 281 is the defaults: no consent asked (GPC
 * still applies), query strings not kept. Settings that cannot be read are
 * the cautious side: consent asked, query strings not kept (a custom event
 * is then dropped, never stored against the workspace's choice).
 */
import type { Request } from 'express';
import type { ServerConfig } from '../../config.js';
import { getWorkspaceWidgetSnapshot } from './configSnapshot.js';

export interface TrackingPrivacy {
  /** Wait for the visitor's consent before tracking. */
  requiresConsent: boolean;
  /** Keep a tracked page's query string. */
  keepQuery: boolean;
}

export const DEFAULT_TRACKING_PRIVACY: TrackingPrivacy = Object.freeze({ requiresConsent: false, keepQuery: false });
/** What unreadable settings stand for. */
const UNREADABLE_TRACKING_PRIVACY: TrackingPrivacy = Object.freeze({ requiresConsent: true, keepQuery: false });

/** The workspace's tracking privacy settings (never throws). */
export async function trackingPrivacyOf(config: ServerConfig, workspaceId: string): Promise<TrackingPrivacy> {
  try {
    const snap = await getWorkspaceWidgetSnapshot(config, workspaceId);
    if (snap.widgetRowUnreadable) return UNREADABLE_TRACKING_PRIVACY;
    const s = (snap.settings ?? {}) as Record<string, unknown>;
    return { requiresConsent: s.tracking_requires_consent === true, keepQuery: s.tracking_keep_query === true };
  } catch {
    return UNREADABLE_TRACKING_PRIVACY;
  }
}

/** The browser sends Global Privacy Control. */
export function gpcRequested(req: Pick<Request, 'get'>): boolean {
  return String(req.get('sec-gpc') ?? '').trim() === '1';
}

/**
 * Whether this request may be tracked: the visitor consented (`consent`
 * true), or nothing asks for consent (the workspace does not, the browser
 * sends no GPC) and the visitor did not refuse it.
 */
export function trackingAllowed(req: Pick<Request, 'get'>, privacy: TrackingPrivacy, consent: unknown): boolean {
  if (consent === true) return true;
  if (consent === false) return false;
  return !privacy.requiresConsent && !gpcRequested(req);
}

/** A page address as it is stored: without its query string (unless kept) and fragment. */
export function trackedPage(url: unknown, keepQuery: boolean): string | null {
  if (typeof url !== 'string' || !url) return null;
  const noHash = url.split('#')[0];
  return (keepQuery ? noHash : noHash.split('?')[0]) || null;
}

/** A referrer as it is stored: never its query string or fragment. */
export function trackedReferrer(url: unknown): string | null {
  return trackedPage(url, false);
}
