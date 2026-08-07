/**
 * Identity Merge Service
 * 
 * Handles the transition from anonymous visitor → identified contact.
 * Uses the atomic SQL function `merge_visitor_into_contact` for transactional safety.
 */

import type { SupabaseClient } from '@supabase/supabase-js';

export interface PreChatIdentityInput {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
}

export interface MergeOptions {
  workspaceId: string;
  visitorId: string;
  identity: PreChatIdentityInput;
  method: 'cookie' | 'email' | 'phone' | 'token' | 'prechat' | 'manual';
  ipAddress?: string | null;
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
 * Find an existing contact by email or phone (deduplication).
 * Email takes precedence over phone.
 */
async function findExistingContact(
  supabase: SupabaseClient,
  workspaceId: string,
  email: string | null,
  phone: string | null
): Promise<{ id: string } | null> {
  if (email) {
    const { data } = await supabase
      .from('contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('email', email)
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  if (phone) {
    const { data } = await supabase
      .from('contacts')
      .select('id')
      .eq('workspace_id', workspaceId)
      .eq('phone', phone)
      .limit(1)
      .maybeSingle();
    if (data) return data;
  }
  return null;
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
 * Upsert contact and merge visitor sessions/conversations atomically.
 * 
 * Rules:
 * - NEVER overwrite existing verified email/phone
 * - Always preserve previously merged history
 * - All merges are audited via identity_merges
 */
export async function mergeVisitorIdentity(
  supabase: SupabaseClient,
  opts: MergeOptions
): Promise<MergeResult> {
  const email = normalizeEmail(opts.identity.email);
  const phone = normalizePhone(opts.identity.phone);
  const name = opts.identity.name?.trim() || null;

  // 1. Try to find existing contact by visitor history first (most accurate continuation)
  let contact = await findContactByVisitorId(supabase, opts.workspaceId, opts.visitorId);
  let isNewContact = false;

  // 2. If not found by visitor, try by email/phone (deduplication)
  if (!contact) {
    contact = await findExistingContact(supabase, opts.workspaceId, email, phone);
  }

  // 3. Create new contact if none exists
  if (!contact) {
    const { data: created, error } = await supabase
      .from('contacts')
      .insert({
        workspace_id: opts.workspaceId,
        name: name || 'Visitor',
        email,
        phone,
        metadata: {
          visitor_id: opts.visitorId,
          source: 'widget',
          first_method: opts.method,
          first_ip: opts.ipAddress || null,
        },
      })
      .select('id')
      .single();
    if (error || !created) {
      throw new Error(`contact_insert_failed: ${error?.message || 'unknown'}`);
    }
    contact = created;
    isNewContact = true;
  } else {
    // Update only fields that are currently empty (never overwrite verified data)
    const { data: existing } = await supabase
      .from('contacts')
      .select('name, email, phone, metadata')
      .eq('id', contact.id)
      .maybeSingle();

    // A contact touched before any name was known (e.g. identified by
    // email/phone alone on an earlier visit) gets seeded with the literal
    // placeholder 'Visitor' below — that's a non-empty string, so a plain
    // `!existing.name` check treats it as "already has a name" and a real
    // name typed into pre-chat later would never actually get saved. Only
    // a genuinely blank name, or the placeholder itself, counts as unset.
    const hasRealName = !!existing?.name && existing.name !== 'Visitor';
    const updates: Record<string, unknown> = {};
    if (existing && !hasRealName && name) updates.name = name;
    if (existing && !existing.email && email) updates.email = email;
    if (existing && !existing.phone && phone) updates.phone = phone;

    const meta = (existing?.metadata as Record<string, unknown>) || {};
    if (!meta.visitor_id) {
      updates.metadata = { ...meta, visitor_id: opts.visitorId };
    }

    if (Object.keys(updates).length > 0) {
      updates.updated_at = new Date().toISOString();
      await supabase.from('contacts').update(updates).eq('id', contact.id);
    }
  }

  // 4. Atomic merge via SQL function (links sessions + re-links conversations + audit)
  const { data: mergeResult, error: mergeError } = await supabase.rpc('merge_visitor_into_contact', {
    _workspace_id: opts.workspaceId,
    _visitor_id: opts.visitorId,
    _contact_id: contact.id,
    _method: opts.method,
    _metadata: { ip: opts.ipAddress || null, is_new_contact: isNewContact },
  });

  if (mergeError) throw new Error(`merge_failed: ${mergeError.message}`);

  return {
    contactId: contact.id,
    visitorId: opts.visitorId,
    conversationsMerged: (mergeResult as any)?.conversations_merged || 0,
    isNewContact,
  };
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
  const sessionIds = (sessions || []).map((s: any) => s.id);
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
