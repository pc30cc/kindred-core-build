// ============================================
// EMAIL SUPPRESSIONS: addresses the platform no longer mails
// ============================================
//
// A hosted provider keeps its own list of addresses that hard-bounced or
// complained, and stops mailing them; our own relay keeps none. Mailing an
// address that bounces, again and again, is what costs a new sending IP and
// domain their reputation, and with it the password resets and codes that
// share them. So the list is ours, in `public.email_suppressions` (migration
// 289), for every provider alike: sendEmail and sendPlatformEmail check it
// before any provider is called, whatever feeds it (a provider's bounce
// webhook, the relay's bounce report, a Super Admin by hand).
//
// Addresses are kept lower-case: the domain part is case-insensitive, and
// the local part is in practice everywhere.

import type { ServerConfig } from '../../config.js';
import { serviceClientFor } from '../../lib/serviceClient.js';
import { parseEmailAddress } from '../../../shared/emailProviders.js';

export type EmailSuppressionReason = 'hard_bounce' | 'complaint' | 'manual';

export interface EmailSuppressionRow {
  address: string;
  reason: string;
  detail: string | null;
  source: string;
  bounce_count: number;
  first_seen_at: string;
  last_seen_at: string;
  expires_at: string | null;
}

const COLUMNS = 'address, reason, detail, source, bounce_count, first_seen_at, last_seen_at, expires_at';
const REASONS: readonly EmailSuppressionReason[] = ['hard_bounce', 'complaint', 'manual'];

function client(config: ServerConfig) {
  return serviceClientFor(config.supabaseUrl, config.supabaseServiceRoleKey);
}

/** The key an address is kept under, or null when it is not one plain address. */
export function suppressionKey(address: string): string | null {
  const parsed = parseEmailAddress(address);
  return parsed ? parsed.toLowerCase() : null;
}

/**
 * Adds the address, or records one more event for it (bounce_count and
 * last_seen_at move on). One statement in the database
 * (email_suppression_record, migration 289), so two bounce reports for the
 * same address at once count twice. A stronger reason is never weakened by a
 * later, weaker one (a Super Admin's `manual` stays manual when a bounce
 * arrives), and a suppression without an end is never given one; an expired
 * row starts over from the new event.
 */
export async function suppressEmailAddress(config: ServerConfig, input: {
  address: string;
  reason: EmailSuppressionReason;
  detail?: string;
  source: string;
  expiresAt?: Date | null;
}): Promise<void> {
  const address = suppressionKey(input.address);
  if (!address) throw new Error('email_suppression_invalid_address');
  if (!REASONS.includes(input.reason)) throw new Error('email_suppression_invalid_reason');
  const source = String(input.source ?? '').trim().slice(0, 64);
  if (!source) throw new Error('email_suppression_invalid_source');
  const detail = typeof input.detail === 'string' && input.detail.trim()
    ? input.detail.replace(/[\r\n]+/g, ' ').trim().slice(0, 500)
    : null;
  const { error } = await client(config).rpc('email_suppression_record', {
    p_address: address,
    p_reason: input.reason,
    p_detail: detail,
    p_source: source,
    p_expires_at: input.expiresAt ? input.expiresAt.toISOString() : null,
  });
  if (error) throw new Error(`email_suppression_write_failed: ${error.message}`);
}

/** Removes the address from the list; true when it was on it. */
export async function unsuppressEmailAddress(config: ServerConfig, address: string): Promise<boolean> {
  const key = suppressionKey(address);
  if (!key) return false;
  const { data, error } = await client(config)
    .from('email_suppressions')
    .delete()
    .eq('address', key)
    .select('address');
  if (error) throw new Error(`email_suppression_delete_failed: ${error.message}`);
  return Array.isArray(data) && data.length > 0;
}

/**
 * Whether mail to this address is held back now (a row that has not
 * expired).
 *
 * A failed lookup answers false, and the mail goes out: the list protects
 * the platform's reputation, and losing a password reset because the list
 * could not be read is the worse failure. The same holds before migration
 * 289 has been applied: no table, nothing suppressed.
 */
export async function isEmailSuppressed(config: ServerConfig, address: string): Promise<boolean> {
  const key = suppressionKey(address);
  if (!key) return false;
  try {
    const { data, error } = await client(config)
      .from('email_suppressions')
      .select('address, expires_at')
      .eq('address', key)
      .maybeSingle();
    if (error) {
      console.warn('[email] suppression lookup failed:', error.message);
      return false;
    }
    const row = data as { expires_at?: string | null } | null;
    if (!row) return false;
    return !row.expires_at || new Date(row.expires_at).getTime() > Date.now();
  } catch (err) {
    console.warn('[email] suppression lookup failed:', err instanceof Error ? err.message : String(err));
    return false;
  }
}

/**
 * The list, newest event first, for the Super Admin. `search` matches part
 * of an address; only characters an address can hold are kept from it, so
 * it can never become a pattern of its own.
 */
export async function listEmailSuppressions(
  config: ServerConfig,
  opts: { search?: string; limit?: number; offset?: number } = {},
): Promise<{ rows: EmailSuppressionRow[]; total: number }> {
  const limit = Math.min(Math.max(Math.trunc(Number(opts.limit) || 50), 1), 200);
  const offset = Math.max(Math.trunc(Number(opts.offset) || 0), 0);
  const search = String(opts.search ?? '').toLowerCase().replace(/[^a-z0-9@._+-]/g, '').replace(/[_]/g, '\\_').slice(0, 254);

  let query = client(config)
    .from('email_suppressions')
    .select(COLUMNS, { count: 'exact' });
  if (search) query = query.ilike('address', `%${search}%`);
  const { data, error, count } = await query
    .order('last_seen_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`email_suppression_list_failed: ${error.message}`);
  return { rows: (data ?? []) as unknown as EmailSuppressionRow[], total: count ?? 0 };
}
