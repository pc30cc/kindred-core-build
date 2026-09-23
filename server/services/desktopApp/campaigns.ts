/**
 * DESKTOP APP CAMPAIGNS — ads and announcements for the Windows app.
 *
 * Rows live in `desktop_app_campaigns` (database/migrations/208). This module
 * owns the vocabulary (placements, severities), normalises rows, and
 * resolves what one workspace should see: active, inside its schedule,
 * targeted at the workspace's plan (or at every plan), in one locale.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

/** Where the Windows app can draw a campaign. */
export const DESKTOP_PLACEMENTS = [
  'banner',          // announcements: the strip at the top of the app
  'inbox_list',      // under the conversation list in every inbox
  'colleagues_list', // under the colleague list
  'contacts_list',   // under the contact list
  'chat_empty',      // the empty conversation pane
  'settings',        // top of Settings
] as const;
export type DesktopPlacement = (typeof DESKTOP_PLACEMENTS)[number];

export const CAMPAIGN_SEVERITIES = ['info', 'success', 'warning', 'critical'] as const;
export const CAMPAIGN_LOCALES = ['en', 'fa', 'tr'] as const;
type Locale = (typeof CAMPAIGN_LOCALES)[number];

export interface CampaignRow {
  id: string;
  kind: 'ad' | 'announcement';
  name: string;
  placements: string[];
  target_plans: string[];
  text: Record<string, { title?: string; body?: string; cta_label?: string }>;
  image_url: string | null;
  cta_url: string | null;
  severity: (typeof CAMPAIGN_SEVERITIES)[number];
  dismissible: boolean;
  priority: number;
  active: boolean;
  starts_at: string | null;
  ends_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface ClientCampaign {
  id: string;
  kind: 'ad' | 'announcement';
  placements: string[];
  title: string;
  body: string;
  ctaLabel: string | null;
  ctaUrl: string | null;
  imageUrl: string | null;
  severity: string;
  dismissible: boolean;
  priority: number;
  endsAt: string | null;
}

export function pickLocale(raw: unknown): Locale {
  const v = String(raw || '').slice(0, 2).toLowerCase();
  return (CAMPAIGN_LOCALES as readonly string[]).includes(v) ? (v as Locale) : 'fa';
}

const https = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return /^https:\/\//i.test(s) ? s : null;
};

/** True while `now` is inside the row's schedule and the row is switched on. */
export function isLive(row: Pick<CampaignRow, 'active' | 'starts_at' | 'ends_at'>, now = Date.now()): boolean {
  if (!row.active) return false;
  if (row.starts_at && Date.parse(row.starts_at) > now) return false;
  if (row.ends_at && Date.parse(row.ends_at) <= now) return false;
  return true;
}

/** Empty `target_plans` means every plan; otherwise the workspace's plan slug must be listed. */
export function targetsPlan(row: Pick<CampaignRow, 'target_plans'>, planSlug: string | null): boolean {
  const plans = (row.target_plans ?? []).filter(Boolean);
  if (plans.length === 0) return true;
  return planSlug != null && plans.includes(planSlug);
}

/** One locale of a row, falling back to Persian then English; null when there is nothing to say. */
export function toClient(row: CampaignRow, locale: Locale): ClientCampaign | null {
  const text = (row.text ?? {}) as CampaignRow['text'];
  const chosen = text[locale]?.title || text[locale]?.body ? text[locale] : text.fa?.title || text.fa?.body ? text.fa : text.en ?? {};
  const title = String(chosen?.title ?? '').trim();
  const body = String(chosen?.body ?? '').trim();
  if (!title && !body) return null;
  const ctaUrl = https(row.cta_url);
  return {
    id: row.id,
    kind: row.kind,
    placements: row.placements ?? [],
    title,
    body,
    ctaLabel: ctaUrl ? String(chosen?.cta_label ?? '').trim() || null : null,
    ctaUrl,
    imageUrl: https(row.image_url),
    severity: row.severity,
    dismissible: row.dismissible !== false,
    priority: row.priority ?? 0,
    endsAt: row.ends_at,
  };
}

const TTL_MS = 60_000;
let cache: { rows: CampaignRow[]; at: number } | null = null;

export function invalidateCampaignCache(): void {
  cache = null;
}

/** Every live row, cached briefly: asked by every running copy every few minutes. */
export async function loadLiveCampaigns(config: ServerConfig): Promise<CampaignRow[]> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.rows.filter((r) => isLive(r));
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('desktop_app_campaigns')
    .select('*')
    .eq('active', true)
    .order('priority', { ascending: false })
    .order('created_at', { ascending: false });
  if (error) throw new Error(error.message);
  cache = { rows: (data ?? []) as CampaignRow[], at: Date.now() };
  return cache.rows.filter((r) => isLive(r));
}
