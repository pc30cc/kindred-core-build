/**
 * Identity Merge Service
 * 
 * Handles the transition from anonymous visitor → identified contact.
 * Uses the atomic SQL function `merge_visitor_into_contact` for transactional safety.
 */

import type { SupabaseClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../../config.js';
import { resolveVisitorGeo } from '../geo/index.js';
import { countryNameFromCode, flagEmojiFromCountryCode, precisionRank } from '../geo/countryNames.js';
import { insertContactWithVisitorCode, backfillVisitorCode } from './visitorCode.js';
import {
  findContactByProvenIdentifiers,
  isContactIdentityConflict,
  placeUnverifiedIdentifiers,
  unverifiedKey,
  type IdentifierColumn,
} from './claimedIdentity.js';

export interface PreChatIdentityInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface MergeOptions {
  workspaceId: string;
  visitorId: string;
  identity: PreChatIdentityInput;
  /** Only for server-verified store assertions; reuse an existing customer across devices. */
  verifiedStoreIdentity?: boolean;
  /**
   * Only after the visitor PROVED control of `identity.email` / `identity.phone`
   * (POST /identity/verify/confirm with the delivered code). Without this (or
   * `verifiedStoreIdentity`) the identifiers are treated as unverified claims:
   * they never select or link an existing contact — see claimedIdentity.ts.
   */
  verifiedIdentifiers?: boolean;
  method: 'cookie' | 'email' | 'phone' | 'token' | 'prechat' | 'manual';
  ipAddress?: string | null;
  /** Country code from Cloudflare's CF-IPCountry header on THIS request
   * (server/utils/clientIp.ts's getClientCountry) — lets location
   * resolution fall back to a country-level centroid even when no
   * geo_enrichment provider is configured and the cache is cold. */
  cfCountry?: string | null;
}

export interface MergeResult {
  contactId: string;
  visitorId: string;
  conversationsMerged: number;
  isNewContact: boolean;
}

function normalizeEmail(v?: string | null): string | null {
  if (!v) return null;
  const s = v.trim().toLowerCase();
  return s.length > 0 ? s : null;
}

function normalizePhone(v?: string | null): string | null {
  if (!v) return null;
  // Keep + and digits only
  const s = v.trim().replace(/[^\d+]/g, '');
  return s.length >= 4 ? s : null;
}

/**
 * Find a contact previously linked to this visitor_id (via metadata or visitor_sessions).
 */
async function findContactByVisitorId(
  supabase: SupabaseClient,
  workspaceId: string,
  visitorId: string
): Promise<{ id: string } | null> {
  // Path 1: visitor_sessions.contact_id
  const { data: session } = await supabase
    .from('visitor_sessions')
    .select('contact_id')
    .eq('workspace_id', workspaceId)
    .eq('visitor_id', visitorId)
    .not('contact_id', 'is', null)
    .order('last_seen_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (session?.contact_id) return { id: session.contact_id };

  // Path 2: contacts.metadata.visitor_id
  const { data: contact } = await supabase
    .from('contacts')
    .select('id')
    .eq('workspace_id', workspaceId)
    .contains('metadata', { visitor_id: visitorId })
    .limit(1)
    .maybeSingle();
  return contact || null;
}

/**
 * Best-effort location for `contacts.metadata` (city/country/country_flag —
 * the fields ContactDetailPage's getLocationFromMetadata() already reads).
 *
 * Two independent signals, both optional, either can supply a result:
 *   1. The visitor's own session ip_hash → resolveVisitorGeo's cache
 *      (visitor_geo_cache / geo_ip_cache, warmed by the widget's own
 *      /track ingest endpoint) — precise (city-level) when a real
 *      geo_enrichment provider or maxmind_local is configured.
 *   2. `cfCountry` — Cloudflare's CF-IPCountry header on THIS request —
 *      drives resolveVisitorGeo's country-centroid fallback. This is the
 *      one that actually matters on a deployment with NO geo provider
 *      configured at all (this workspace, at time of writing): without
 *      it, resolveVisitorGeo has no country to fall back to and silently
 *      resolves to source:'none', and neither the cache nor
 *      visitor_sessions.geo_* ever gets populated for anyone (centroid
 *      results, unlike provider ones, are never cached — cheap to redo).
 * Returns {} (nothing to merge) on any miss or failure; never throws,
 * since a missing location must never block identification.
 */
async function resolveContactGeoPatch(
  config: ServerConfig,
  supabase: SupabaseClient,
  workspaceId: string,
  visitorId: string,
  cfCountry: string | null,
): Promise<Record<string, unknown>> {
  try {
    const { data: session } = await supabase
      .from('visitor_sessions')
      .select('ip_hash')
      .eq('workspace_id', workspaceId)
      .eq('visitor_id', visitorId)
      .not('ip_hash', 'is', null)
      .order('last_seen_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    const ipHash = typeof session?.ip_hash === 'string' ? session.ip_hash : undefined;
    if (!ipHash && !cfCountry) return {};

    const geo = await resolveVisitorGeo(config, workspaceId, {
      country: cfCountry, city: null, ip_hash: ipHash ?? null, raw_ip: null,
    });
    const patch: Record<string, unknown> = {};
    if (geo.city) patch.city = geo.city;
    const countryName = geo.country && geo.country.length > 2
      ? geo.country
      : countryNameFromCode(geo.country_code) ?? geo.country ?? null;
    if (countryName) patch.country = countryName;
    if (geo.country_code) patch.country_code = geo.country_code;
    const flag = flagEmojiFromCountryCode(geo.country_code);
    if (flag) patch.country_flag = flag;
    // Precision marker so a later coarse pass (country centroid) can never
    // clobber a city-level result from MaxMind / a configured provider.
    patch.location_precision = geo.source === 'centroid' || geo.source === 'session'
      ? 'centroid'
      : geo.city
        ? 'city'
        : geo.region
          ? 'region'
          : geo.country_code
            ? 'country'
            : 'centroid';
    patch.location_source = geo.source;
    return patch;
  } catch {
    return {};
  }
}

/**
 * Upsert contact and merge visitor sessions/conversations atomically.
 *
 * Rules:
 * - NEVER overwrite existing verified email/phone
 * - Always preserve previously merged history
 * - All merges are audited via identity_merges
 */
export async function mergeVisitorIdentity(
  config: ServerConfig,
  supabase: SupabaseClient,
  opts: MergeOptions
): Promise<MergeResult> {
  const email = normalizeEmail(opts.identity.email);
  const phone = normalizePhone(opts.identity.phone);
  const name = opts.identity.name?.trim() || null;
  // Best-effort — resolved once regardless of new-vs-existing contact so
  // both branches below can fold it into whichever metadata write they
  // already do, instead of a second read/update pass.
  // Privacy gate (Phase 10): the raw IP may only be persisted when the
  // workspace opted in via widget_settings.store_raw_ip. Without this,
  // `contacts.metadata.first_ip` and the identity_merges audit row stored a
  // raw IP for every workspace regardless of the toggle.
  let mayStoreRawIp = false;
  try {
    const { data: wsRow } = await supabase
      .from('widget_settings')
      .select('store_raw_ip')
      .eq('workspace_id', opts.workspaceId)
      .maybeSingle();
    mayStoreRawIp = wsRow?.store_raw_ip === true;
  } catch { /* fail closed */ }
  const persistableIp = mayStoreRawIp ? (opts.ipAddress || null) : null;

  const geoPatch = await resolveContactGeoPatch(
    config, supabase, opts.workspaceId, opts.visitorId, opts.cfCountry ?? null,
  );

  // SECURITY: an email/phone is only allowed to resolve an EXISTING contact
  // when it is proven (verify/confirm code, or a signed store assertion).
  // Visitor-typed values (pre-chat, call-widget pre-call form) are claims:
  // matching them to an existing contact linked the attacker's visitor to the
  // victim's contact, which then exposed the victim's PII (/identity/me),
  // conversation history (/identity/history) and continuity cookie.
  const proven = opts.verifiedStoreIdentity === true || opts.verifiedIdentifiers === true;

  // 1. The visitor's own contact (visitor history — most accurate continuation).
  const ownContact = await findContactByVisitorId(supabase, opts.workspaceId, opts.visitorId);

  // 2. Proven identity: the contact that owns the identifier wins (the same
  //    person on another device). A contact that only CLAIMED it is released.
  let contact: { id: string } | null = proven
    ? await findContactByProvenIdentifiers(supabase, opts.workspaceId, email, phone, ownContact?.id ?? null)
    : null;
  if (!contact) contact = ownContact;
  let isNewContact = false;

  // Where unproven identifiers may be written (own/new contact only; a value
  // another contact holds is kept as a metadata claim, never linked).
  const placement = proven
    ? { email, phone, metadata: {} as Record<string, string> }
    : await placeUnverifiedIdentifiers(supabase, opts.workspaceId, email, phone, contact?.id ?? null);

  // 3. Create new contact if none exists
  if (!contact) {
    const buildPayloadWith = (cols: { email: string | null; phone: string | null }) =>
      (visitorCode: string | null) => ({
        workspace_id: opts.workspaceId,
        name: name || null,
        email: cols.email,
        phone: cols.phone,
        visitor_code: visitorCode,
        metadata: {
          visitor_id: opts.visitorId,
          source: 'widget',
          first_method: opts.method,
          first_ip: persistableIp,
          ...placement.metadata,
          ...geoPatch,
        },
      });
    let { data: created, error } = await insertContactWithVisitorCode(
      supabase, buildPayloadWith({ email: placement.email, phone: placement.phone }), 'id',
    );
    if (error && !proven && isContactIdentityConflict(error)) {
      // Another request took the address after our check — keep the claim in
      // metadata only; never fall back to that contact.
      ({ data: created, error } = await insertContactWithVisitorCode(
        supabase, buildPayloadWith({ email: null, phone: null }), 'id',
      ));
    }
    if (error || !created) {
      throw new Error(`contact_insert_failed: ${(error as { message?: string } | null)?.message || 'unknown'}`);
    }
    contact = created as { id: string };
    isNewContact = true;
  } else {
    // Update only fields that are currently empty (never overwrite verified data)
    const { data: existing } = await supabase
      .from('contacts')
      .select('name, email, phone, metadata, visitor_code')
      .eq('id', contact.id)
      .maybeSingle();

    // A contact touched before any name was known (e.g. identified by
    // email/phone alone on an earlier visit) has `name: null` — a plain
    // `!existing.name` check already treats that as unset, so a real name
    // typed into pre-chat later gets saved correctly. The `!== 'Visitor'`
    // half of this check only matters for LEGACY rows that still carry the
    // literal placeholder string from before this module wrote null.
    const hasRealName = !!existing?.name && existing.name !== 'Visitor';
    const updates: Record<string, unknown> = {};
    if (existing && !hasRealName && name) updates.name = name;
    if (existing && !existing.email && placement.email) updates.email = placement.email;
    if (existing && !existing.phone && placement.phone) updates.phone = placement.phone;

    const meta = (existing?.metadata as Record<string, unknown>) || {};
    // Claim bookkeeping: record what an unverified visitor typed, and clear
    // the claim marker once the same value is proven.
    const claimPatch: Record<string, unknown> = { ...placement.metadata };
    if (proven) {
      const provenPairs: Array<[IdentifierColumn, string | null]> = [['email', email], ['phone', phone]];
      for (const [column, value] of provenPairs) {
        const key = unverifiedKey(column);
        if (value && meta[key] === value) claimPatch[key] = null;
      }
    }
    const claimChanged = Object.entries(claimPatch).some(([k, v]) => (meta[k] ?? null) !== v);
    // Never overwrite a location the contact already has (could be
    // manually edited, or simply more precise than this pass's guess) —
    // only fill in whatever's still blank.
    const metaGeoFill: Record<string, unknown> = {};
    const hasLocation = !!(meta.city || meta.country);
    const incomingRank = precisionRank(geoPatch.location_precision as string | undefined);
    const storedRank = precisionRank(meta.location_precision as string | undefined);
    // Fill blanks always; overwrite an existing location ONLY when this pass
    // is strictly more precise (city > region > country > centroid).
    const mayUpgrade = hasLocation && incomingRank > storedRank;
    const take = (key: string) => !meta[key] || mayUpgrade;
    if (geoPatch.city && take('city')) metaGeoFill.city = geoPatch.city;
    if (geoPatch.country && take('country')) metaGeoFill.country = geoPatch.country;
    if (geoPatch.country_code && take('country_code')) metaGeoFill.country_code = geoPatch.country_code;
    if (geoPatch.country_flag && take('country_flag')) metaGeoFill.country_flag = geoPatch.country_flag;
    if (Object.keys(metaGeoFill).length && geoPatch.location_precision) {
      metaGeoFill.location_precision = geoPatch.location_precision;
      metaGeoFill.location_source = geoPatch.location_source;
    }
    // The visitor just identified themselves — the placeholder contact
    // created at conversation start is no longer anonymous.
    const identified = !!(name || email || phone);
    if (!meta.visitor_id || Object.keys(metaGeoFill).length || (identified && meta.anonymous) || claimChanged) {
      updates.metadata = {
        ...meta,
        visitor_id: opts.visitorId,
        ...metaGeoFill,
        ...claimPatch,
        ...(identified ? { anonymous: false } : {}),
      };
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      let { error: updateError } = await supabase.from('contacts').update(updates).eq('id', contact.id);
      if (updateError && !proven && isContactIdentityConflict(updateError)) {
        // Another contact took the address after our check: keep the claim
        // in metadata (already in `updates.metadata`) and drop the column.
        const { email: _droppedEmail, phone: _droppedPhone, ...rest } = updates;
        ({ error: updateError } = await supabase.from('contacts').update(rest).eq('id', contact.id));
      }
      if (updateError) throw new Error(`contact_update_failed: ${updateError.message}`);
    }

    // Legacy contact (predates the 021 migration) or one whose earlier
    // insert exhausted its collision-retry budget — backfill lazily, race-
    // safe, same as ensureVisitorContact's identifier-lookup branches. Kept
    // as its own statement (not folded into `updates` above) so its
    // `WHERE visitor_code IS NULL` guard never gates the unrelated
    // name/email/phone/metadata fields in the combined update.
    if (!existing?.visitor_code) {
      await backfillVisitorCode(supabase, contact.id);
    }
  }

  // Proven identity landed on a different contact than the visitor's own
  // placeholder: move THIS visitor's sessions and their conversations over.
  // (merge_visitor_into_contact only claims sessions/conversations whose
  // contact_id is null or already the target, so without this the visitor
  // would stay pinned to the placeholder.) Unproven input never reaches here.
  if (proven && ownContact && ownContact.id !== contact.id) {
    await repointVisitorToContact(supabase, opts.workspaceId, opts.visitorId, ownContact.id, contact.id);
  }

  // 4. Atomic merge via SQL function (links sessions + re-links conversations + audit)
  const { data: mergeResult, error: mergeError } = await supabase.rpc('merge_visitor_into_contact', {
    _workspace_id: opts.workspaceId,
    _visitor_id: opts.visitorId,
    _contact_id: contact.id,
    _method: opts.method,
    _metadata: { ip: persistableIp, is_new_contact: isNewContact },
  });

  if (mergeError) throw new Error(`merge_failed: ${mergeError.message}`);

  return {
    contactId: contact.id,
    visitorId: opts.visitorId,
    conversationsMerged: (mergeResult as { conversations_merged?: number } | null)?.conversations_merged || 0,
    isNewContact,
  };
}

/**
 * Move a visitor from `fromContactId` (their placeholder) to `toContactId`
 * (the contact a PROVEN identity resolved to): their own sessions, and the
 * conversations started from those sessions that still point at the
 * placeholder. Scoped to this visitor's sessions so no other visitor's data
 * moves.
 */
async function repointVisitorToContact(
  supabase: SupabaseClient,
  workspaceId: string,
  visitorId: string,
  fromContactId: string,
  toContactId: string,
): Promise<void> {
  const { data: sessions } = await supabase
    .from('visitor_sessions')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('visitor_id', visitorId);
  const sessionIds = ((sessions || []) as Array<{ id: string }>).map((s) => s.id);
  const { error: sessErr } = await supabase
    .from('visitor_sessions')
    .update({ contact_id: toContactId })
    .eq('workspace_id', workspaceId)
    .eq('visitor_id', visitorId)
    .eq('contact_id', fromContactId);
  if (sessErr) throw new Error(`session_repoint_failed: ${sessErr.message}`);
  if (sessionIds.length === 0) return;
  const { error: convErr } = await supabase
    .from('conversations')
    .update({ contact_id: toContactId, updated_at: new Date().toISOString() })
    .eq('workspace_id', workspaceId)
    .eq('contact_id', fromContactId)
    .in('visitor_session_id', sessionIds);
  if (convErr) throw new Error(`conversation_repoint_failed: ${convErr.message}`);
}

/**
 * Smart history continuation: returns the most recent conversation if it falls
 * within the workspace's continue window; otherwise returns null (caller starts fresh).
 */
export async function findContinuableConversation(
  supabase: SupabaseClient,
  workspaceId: string,
  visitorId: string,
  contactId: string | null,
  windowHours: number
): Promise<{ id: string; updatedAt: string } | null> {
  const cutoff = new Date(Date.now() - windowHours * 60 * 60 * 1000).toISOString();

  // Prefer contact-based lookup (more reliable across devices)
  if (contactId) {
    // For identified contacts, ALWAYS continue the most recent open/pending
    // thread regardless of the workspace continue-window. The window is a
    // privacy/UX guard for anonymous returns — once we've identified the
    // visitor (email/phone), they are the same person and should land back
    // in the same conversation. This prevents the inbox from accumulating
    // a new conversation per visit for the same contact.
    const { data: openConv } = await supabase
      .from('conversations')
      .select('id, updated_at, status')
      .eq('workspace_id', workspaceId)
      .eq('contact_id', contactId)
      .in('status', ['open', 'pending'])
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (openConv) return { id: openConv.id, updatedAt: openConv.updated_at };

    // No open thread → fall back to the most recent (any status) within window
    // so a recently resolved chat can still be resumed if the window allows.
    const { data } = await supabase
      .from('conversations')
      .select('id, updated_at, status')
      .eq('workspace_id', workspaceId)
      .eq('contact_id', contactId)
      .gte('updated_at', cutoff)
      .order('updated_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (data) return { id: data.id, updatedAt: data.updated_at };
  }

  // Fallback to visitor-session-based lookup for purely anonymous returns
  const { data: sessions } = await supabase
    .from('visitor_sessions')
    .select('id')
    .eq('workspace_id', workspaceId)
    .eq('visitor_id', visitorId);
  const sessionIds = (sessions || []).map((s: { id: string }) => s.id);
  if (sessionIds.length === 0) return null;

  const { data: conv } = await supabase
    .from('conversations')
    .select('id, updated_at')
    .eq('workspace_id', workspaceId)
    .in('visitor_session_id', sessionIds)
    .gte('updated_at', cutoff)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  return conv ? { id: conv.id, updatedAt: conv.updated_at } : null;
}
