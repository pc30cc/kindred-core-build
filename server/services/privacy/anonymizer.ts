/**
 * Privacy delete / anonymize executor.
 *
 * Idempotency strategy:
 *   - Every UPDATE uses a "guard" predicate so re-running on already-
 *     anonymized rows is a no-op (e.g. body NOT LIKE '[deleted by%' OR
 *     metadata->>'anonymized' IS NULL).
 *   - Hard DELETEs use IN (ids) and tolerate empty result sets.
 *   - The job runs without a database transaction across phases on
 *     purpose: a partial run can be safely retried, each phase converges.
 *   - Each phase logs counts so the job's final summary is deterministic
 *     across re-runs (steady-state == 0 changes).
 *   - Every step's error fails the job (`check`): a summary never counts
 *     what was not done. A visitor session is updated with real columns
 *     only (it once named two that do not exist, so the whole update
 *     failed unnoticed and the job still said "anonymized").
 *   - The visitor's tracking data goes too (anonymizeVisitorTracking): page
 *     history, analytics events, AI nudges, presence, read markers, store
 *     links; Smart Engagement events stay for the counts, without them.
 */

import * as crypto from 'crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { deleteFile, deleteForOwner } from '../storage/index.js';
import { scrubPii } from './scrub.js';
import type { PrivacyJobRow, ResolvedSubject } from './types.js';
import { publishCacheInvalidation } from '../../lib/cacheBus.js';

// public.sender_type enum = { agent, contact, system, bot, ai }. 'visitor' is
// NOT a member; including it made both message queries below fail with 22P02,
// and because their errors were dropped, anonymize redacted nothing while the
// worker still marked the job 'completed'.
const CONTACT_SENDER_TYPES = ['contact'];
const CONTACT_SENDER_TYPES_SQL = `(${CONTACT_SENDER_TYPES.join(',')})`;

const REDACTED_BODY = '[deleted by user request]';
const ANON_VISITOR_PREFIX = 'anon_';

function anonVisitorId(original: string): string {
  const h = crypto.createHash('sha256').update(`v:${original}`).digest('hex');
  return `${ANON_VISITOR_PREFIX}${h.slice(0, 24)}`;
}

export interface AnonymizeSummary {
  contacts_anonymized: number;
  visitor_sessions_anonymized: number;
  conversations_anonymized: number;
  contact_messages_redacted: number;
  operator_messages_scrubbed: number;
  notes_scrubbed: number;
  attachments_deleted: number;
  /** Visitor comments cleared: chat ratings (276), their timeline copies, call ratings. */
  rating_comments_cleared: number;
  verifications_deleted: number;
  email_logs_anonymized: number;
  audit_logs_anonymized: number;
  identity_merges_deleted: number;
  /** The visitor's page history (visitor_page_views) of their sessions. */
  page_views_deleted: number;
  /** Web analytics custom events of their sessions. */
  analytics_events_deleted: number;
  /** Smart Engagement events kept for the rules' counts, with no visitor or page left. */
  smart_events_anonymized: number;
  /** AI proactive nudges written for the visitor (their page and message). */
  ai_nudges_deleted: number;
  /** The rest keyed by the visitor: live presence, read markers, store links, AI intro log. */
  visitor_links_deleted: number;
}

/** conversation_ratings is missing (before migration 276): nothing to clear. */
function relationMissing(error: { code?: string } | null | undefined): boolean {
  return error?.code === '42P01' || error?.code === 'PGRST205';
}

/**
 * A step's error fails the job (worker.ts then marks it failed, and a re-run
 * converges), never a summary that says it was done; a table this database
 * does not have is nothing to anonymize.
 */
function check(step: string, error: { code?: string; message?: string } | null | undefined): void {
  if (error && !relationMissing(error)) throw new Error(`anonymize: ${step} failed: ${error.message}`);
}

/** Id lists in bounded slices (a long `in.(…)` filter stays a short request). */
function slices<T>(ids: T[], size = 100): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * What a visitor session keeps once anonymized: a new visitor id (the old
 * one is what the visitor's cookie still carries), no contact, and none of
 * what could single them out or say where they went: the address (raw and
 * hashed), the place finer than the country (city, region, coordinates,
 * time zone and how it was found), the pages and the referrer, the
 * campaign's term and content (newsletters put addresses there), and the
 * metadata. What is left (browser, device, OS, country, language, campaign
 * source, medium and name, the times) counts visits without naming anyone.
 * Only columns every chain has (003, 145, 239).
 */
function anonymizedSessionPatch(visitorId: string): Record<string, unknown> {
  return {
    visitor_id: visitorId,
    contact_id: null,
    identity_state: 'anonymous',
    current_page: null,
    referrer: null,
    ip_hash: null,
    ip_raw: null,
    city: null,
    geo_city: null,
    geo_region: null,
    geo_latitude: null,
    geo_longitude: null,
    geo_timezone: null,
    geo_accuracy_level: null,
    geo_source_provider: null,
    geo_resolved_at: null,
    utm_term: null,
    utm_content: null,
    metadata: {},
  };
}

/**
 * Step 5b: the visitor's tracking data. Page history and analytics events of
 * their sessions are deleted (a page address can name them: ?email=…); the
 * AI nudges written for them (their page, a message about their visit) are
 * deleted; Smart Engagement events stay for the rules' counts, without
 * their visitor, session or page; presence rows, read markers, store links
 * and the AI intro log keyed by them are deleted. Idempotent.
 */
async function anonymizeVisitorTracking(
  sb: ReturnType<typeof getServiceClient>,
  wsId: string,
  sessionIds: string[],
  visitorIds: string[],
  summary: AnonymizeSummary,
): Promise<void> {
  for (const ids of slices(sessionIds)) {
    const pv = await sb.from('visitor_page_views').delete().eq('workspace_id', wsId).in('visitor_session_id', ids).select('id');
    check('deleting page views', pv.error);
    summary.page_views_deleted += pv.data?.length || 0;

    const ev = await sb.from('web_analytics_events').delete().eq('workspace_id', wsId).in('visitor_session_id', ids).select('id');
    check('deleting analytics events', ev.error);
    summary.analytics_events_deleted += ev.data?.length || 0;

    const pr = await sb.from('visitor_presence').delete().eq('workspace_id', wsId).in('visitor_session_id', ids).select('id');
    check('deleting presence', pr.error);
    summary.visitor_links_deleted += pr.data?.length || 0;

    const intro = await sb.from('ai_agent_intro_log').delete().eq('workspace_id', wsId).in('visitor_session_id', ids).select('id');
    check('deleting the AI intro log', intro.error);
    summary.visitor_links_deleted += intro.data?.length || 0;
  }

  for (const ids of slices(visitorIds)) {
    // Their nudges' own events go with them (ON DELETE CASCADE).
    const nudges = await sb.from('widget_ai_nudges').delete().eq('workspace_id', wsId).in('visitor_id', ids).select('id');
    check('deleting AI nudges', nudges.error);
    summary.ai_nudges_deleted += nudges.data?.length || 0;

    const smart = await sb
      .from('widget_smart_events')
      .update({ visitor_id: null, session_id: null, page_path: null })
      .eq('workspace_id', wsId)
      .in('visitor_id', ids)
      .select('id');
    check('anonymizing Smart Engagement events', smart.error);
    summary.smart_events_anonymized += smart.data?.length || 0;

    const reads = await sb.from('widget_conversation_reads').delete().eq('workspace_id', wsId).in('visitor_id', ids).select('id');
    check('deleting read markers', reads.error);
    summary.visitor_links_deleted += reads.data?.length || 0;

    const introByVisitor = await sb.from('ai_agent_intro_log').delete().eq('workspace_id', wsId).in('visitor_id', ids).select('id');
    check('deleting the AI intro log', introByVisitor.error);
    summary.visitor_links_deleted += introByVisitor.data?.length || 0;

    // A store customer link is keyed by the visitor's uuid.
    const uuids = ids.filter((id) => UUID_RE.test(id));
    if (uuids.length) {
      const links = await sb.from('commerce_customer_links').delete().eq('workspace_id', wsId).in('visitor_id', uuids).select('id');
      check('deleting store customer links', links.error);
      summary.visitor_links_deleted += links.data?.length || 0;
    }
  }
}

async function clearRatingComments(
  sb: ReturnType<typeof getServiceClient>,
  wsId: string,
  conversationIds: string[],
  sessionIds: string[],
): Promise<number> {
  let cleared = 0;
  if (conversationIds.length > 0) {
    const { data: rated, error: ratedErr } = await sb
      .from('conversation_ratings')
      .update({ comment: null })
      .eq('workspace_id', wsId)
      .in('conversation_id', conversationIds)
      .not('comment', 'is', null)
      .select('id');
    if (ratedErr && !relationMissing(ratedErr)) {
      throw new Error(`anonymize: clearing rating comments failed: ${ratedErr.message}`);
    }
    cleared += rated?.length || 0;

    const { data: events, error: eventsErr } = await sb
      .from('conversation_events')
      .select('id, payload')
      .eq('workspace_id', wsId)
      .in('conversation_id', conversationIds)
      .eq('event_type', 'rated');
    if (eventsErr) throw new Error(`anonymize: reading rating events failed: ${eventsErr.message}`);
    for (const e of events || []) {
      const payload = (e.payload && typeof e.payload === 'object' ? e.payload : {}) as Record<string, unknown>;
      if (payload.comment == null) continue;
      const { error } = await sb.from('conversation_events').update({ payload: { ...payload, comment: null } }).eq('id', e.id);
      if (error) throw new Error(`anonymize: clearing a rating event's comment failed: ${error.message}`);
      cleared++;
    }
  }

  const callIds = new Set<string>();
  if (conversationIds.length > 0) {
    const { data, error } = await sb
      .from('call_sessions')
      .select('id')
      .eq('workspace_id', wsId)
      .eq('context_type', 'conversation')
      .in('context_id', conversationIds);
    if (error && !relationMissing(error)) throw new Error(`anonymize: reading calls failed: ${error.message}`);
    for (const c of data || []) callIds.add(c.id as string);
  }
  if (sessionIds.length > 0) {
    const { data, error } = await sb
      .from('call_sessions')
      .select('id')
      .eq('workspace_id', wsId)
      .in('visitor_session_id', sessionIds);
    if (error && !relationMissing(error)) throw new Error(`anonymize: reading calls failed: ${error.message}`);
    for (const c of data || []) callIds.add(c.id as string);
  }
  if (callIds.size > 0) {
    const { data: calls, error: callsErr } = await sb
      .from('call_ratings')
      .update({ comment: null })
      .eq('workspace_id', wsId)
      .in('call_session_id', [...callIds])
      .not('comment', 'is', null)
      .select('id');
    if (callsErr) throw new Error(`anonymize: clearing call rating comments failed: ${callsErr.message}`);
    cleared += calls?.length || 0;
  }
  return cleared;
}

export async function runAnonymize(
  config: ServerConfig,
  job: PrivacyJobRow,
): Promise<AnonymizeSummary> {
  const sb = getServiceClient(config);
  const subject: ResolvedSubject = job.resolved_identity || { contact_ids: [], visitor_ids: [], emails: [] };

  const summary: AnonymizeSummary = {
    contacts_anonymized: 0,
    visitor_sessions_anonymized: 0,
    conversations_anonymized: 0,
    contact_messages_redacted: 0,
    operator_messages_scrubbed: 0,
    notes_scrubbed: 0,
    attachments_deleted: 0,
    rating_comments_cleared: 0,
    verifications_deleted: 0,
    email_logs_anonymized: 0,
    audit_logs_anonymized: 0,
    identity_merges_deleted: 0,
    page_views_deleted: 0,
    analytics_events_deleted: 0,
    smart_events_anonymized: 0,
    ai_nudges_deleted: 0,
    visitor_links_deleted: 0,
  };

  // ─── User-subject branch ───────────────────────────────────────
  if (job.subject_type === 'user') {
    const userId = job.subject_id;
    // Anonymize audit_logs entries by this user (never delete — kept for audit trail)
    const anonHash = `anon_${crypto.createHash('sha256').update(`u:${userId}`).digest('hex').slice(0, 16)}`;
    // Soft-revoke active sessions
    const revoked = await sb.from('auth_sessions').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId).is('revoked_at', null);
    check('revoking sessions', revoked.error);

    // Avatar is a user-owned storage object (docs/STORAGE_ARCHITECTURE_AUDIT.md
    // §4/§9) — anonymizing PII means actually deleting the image, not just
    // clearing the DB pointer. avatar_storage_key covers rows written by the
    // canonical uploader; legacy pre-migration rows (no avatar_storage_key,
    // only the old avatars/<userId>/... URL) are left as a known orphan here
    // — same acceptance as the rest of this migration's legacy window.
    const { data: priorProfile } = await sb
      .from('profiles')
      .select('avatar_storage_key')
      .eq('id', userId)
      .maybeSingle();
    const avatarKey = (priorProfile as { avatar_storage_key?: string | null } | null)?.avatar_storage_key;
    if (avatarKey) {
      await deleteForOwner(config, { kind: 'user', userId }, avatarKey).catch(() => undefined);
    }

    // Clear PII from profile
    const cleared = await sb
      .from('profiles')
      .update({
        full_name: null,
        company_name: null,
        avatar_url: null,
        avatar_storage_key: null,
        website_domain: null,
        signup_ip: null,
        // email kept hashed for FK integrity if referenced; replace with synthetic
        email: `${anonHash}@anonymized.local`,
      })
      .eq('id', userId);
    check('clearing the profile', cleared.error);
    // The erased name and avatar leave every widget team stack now.
    publishCacheInvalidation([`user:${userId}`]);
    return summary;
  }

  if (!job.workspace_id) throw new Error('contact/visitor jobs require workspace_id');
  const wsId = job.workspace_id;

  // ─── Resolve session + conversation IDs once ────────────────────
  let sessionIds: string[] = [];
  if (subject.visitor_ids.length > 0 || subject.contact_ids.length > 0) {
    const orParts: string[] = [];
    if (subject.visitor_ids.length > 0) orParts.push(`visitor_id.in.(${subject.visitor_ids.map((v) => `"${v}"`).join(',')})`);
    if (subject.contact_ids.length > 0) orParts.push(`contact_id.in.(${subject.contact_ids.join(',')})`);
    const { data, error } = await sb
      .from('visitor_sessions')
      .select('id')
      .eq('workspace_id', wsId)
      .or(orParts.join(','));
    check('reading visitor sessions', error);
    sessionIds = (data || []).map((r: { id: string }) => r.id);
  }

  let conversationIds: string[] = [];
  if (subject.contact_ids.length > 0 || sessionIds.length > 0) {
    const orParts: string[] = [];
    if (subject.contact_ids.length > 0) orParts.push(`contact_id.in.(${subject.contact_ids.join(',')})`);
    if (sessionIds.length > 0) orParts.push(`visitor_session_id.in.(${sessionIds.join(',')})`);
    const { data, error } = await sb
      .from('conversations')
      .select('id')
      .eq('workspace_id', wsId)
      .or(orParts.join(','));
    check('reading conversations', error);
    conversationIds = (data || []).map((r: { id: string }) => r.id);
  }

  // ─── 1. Redact contact-authored messages (idempotent) ──────────
  if (conversationIds.length > 0) {
    const { data: contactMsgs, error: contactMsgsErr } = await sb
      .from('conversation_messages')
      .select('id,body')
      .in('conversation_id', conversationIds)
      .in('sender_type', CONTACT_SENDER_TYPES)
      .neq('body', REDACTED_BODY);
    // Throw, never continue: a swallowed error here produced a zeroed summary
    // and let worker.ts mark the deletion job 'completed' having redacted
    // nothing. Failing the job loudly is the only safe outcome.
    if (contactMsgsErr) {
      throw new Error(`anonymize: reading contact messages failed: ${contactMsgsErr.message}`);
    }
    for (const m of contactMsgs || []) {
      const { error } = await sb
        .from('conversation_messages')
        .update({ body: REDACTED_BODY, sender_id: null, metadata: { anonymized: true } })
        .eq('id', m.id);
      check('redacting a contact message', error);
      summary.contact_messages_redacted++;
    }

    // ─── 2. Scrub operator-written message bodies (regex PII) ────
    // Only operator messages that contain the subject's email/phone get
    // touched; placeholders make this idempotent.
    const { data: opMsgs, error: opMsgsErr } = await sb
      .from('conversation_messages')
      .select('id,body,metadata')
      .in('conversation_id', conversationIds)
      .not('sender_type', 'in', CONTACT_SENDER_TYPES_SQL);
    if (opMsgsErr) {
      throw new Error(`anonymize: reading operator messages failed: ${opMsgsErr.message}`);
    }
    for (const m of opMsgs || []) {
      const r = scrubPii(m.body || '');
      if (r.changed) {
        const newMeta = { ...(m.metadata || {}), partially_redacted: true };
        const { error } = await sb
          .from('conversation_messages')
          .update({ body: r.text, metadata: newMeta })
          .eq('id', m.id);
        check('scrubbing an operator message', error);
        summary.operator_messages_scrubbed++;
      }
    }

    // ─── 3. Scrub notes (operator-internal) ────────────────────────
    const { data: notes, error: notesErr } = await sb
      .from('conversation_notes')
      .select('id,body,metadata')
      .eq('workspace_id', wsId)
      .in('conversation_id', conversationIds);
    check('reading notes', notesErr);
    for (const n of notes || []) {
      const r = scrubPii(n.body || '');
      if (r.changed) {
        const newMeta = { ...(n.metadata || {}), partially_redacted: true };
        const { error } = await sb
          .from('conversation_notes')
          .update({ body: r.text, metadata: newMeta })
          .eq('id', n.id);
        check('scrubbing a note', error);
        summary.notes_scrubbed++;
      }
    }
  }

  // ─── 4. Delete subject-uploaded attachments (storage + row) ────
  if (conversationIds.length > 0) {
    const { data: subjectAttachments, error: attErr } = await sb
      .from('conversation_attachments')
      .select('id,storage_path')
      .eq('workspace_id', wsId)
      .in('conversation_id', conversationIds)
      .eq('uploaded_by_type', 'visitor');
    check('reading attachments', attErr);
    for (const a of subjectAttachments || []) {
      try {
        await deleteFile(config, wsId, a.storage_path);
      } catch {
        // best-effort — DB row removal still progresses idempotency
      }
      const { error } = await sb.from('conversation_attachments').delete().eq('id', a.id);
      check('deleting an attachment row', error);
      summary.attachments_deleted++;
    }
  }

  // ─── 4b. Clear the subject's rating comments ────────────────────
  // What the visitor wrote under a rating is their text like a message: the
  // chat rating (conversation_ratings, migration 276) and the copy of it in
  // the timeline's `rated` event, and a call's rating (call_ratings) of a
  // call in one of their conversations or sessions. The scores stay (they
  // name nobody). Idempotent: only rows that still hold a comment.
  summary.rating_comments_cleared += await clearRatingComments(sb, wsId, conversationIds, sessionIds);

  // ─── 5. Anonymize conversations + visitor_sessions ─────────────
  if (conversationIds.length > 0) {
    const { data: changed, error } = await sb
      .from('conversations')
      .update({ contact_id: null })
      .in('id', conversationIds)
      .not('contact_id', 'is', null)
      .select('id');
    check('unlinking conversations', error);
    summary.conversations_anonymized = changed?.length || 0;
  }

  // ─── 5b. The visitor's tracking data (before their ids change) ──
  // Every visitor id the subject had: resolved, and each session's own.
  const visitorIds = new Set<string>(subject.visitor_ids);
  if (sessionIds.length > 0) {
    const { data: rows, error } = await sb.from('visitor_sessions').select('visitor_id').in('id', sessionIds);
    check('reading session visitor ids', error);
    for (const r of rows || []) if (r.visitor_id && !String(r.visitor_id).startsWith(ANON_VISITOR_PREFIX)) visitorIds.add(String(r.visitor_id));
  }
  await anonymizeVisitorTracking(sb, wsId, sessionIds, [...visitorIds], summary);

  if (sessionIds.length > 0) {
    // A new visitor id and nothing that singles the visitor out
    // (anonymizedSessionPatch), on each session row.
    const { data: sessions, error: sessionsErr } = await sb
      .from('visitor_sessions')
      .select('id,visitor_id,ip_raw,current_page')
      .in('id', sessionIds);
    check('reading visitor sessions', sessionsErr);
    for (const s of sessions || []) {
      const rotated = (s.visitor_id || '').startsWith(ANON_VISITOR_PREFIX);
      // Done before (a re-run): nothing left to clear.
      if (rotated && s.ip_raw == null && s.current_page == null) continue;
      const newVid = rotated ? s.visitor_id : anonVisitorId(s.visitor_id || s.id);
      const { error } = await sb
        .from('visitor_sessions')
        .update(anonymizedSessionPatch(newVid))
        .eq('id', s.id);
      check('anonymizing a visitor session', error);
      summary.visitor_sessions_anonymized++;
    }
  }

  // ─── 6. Delete contact verifications + identity merges ─────────
  if (subject.visitor_ids.length > 0) {
    const { data: removed, error } = await sb
      .from('contact_verifications')
      .delete()
      .eq('workspace_id', wsId)
      .in('visitor_id', subject.visitor_ids)
      .select('id');
    check('deleting verifications', error);
    summary.verifications_deleted += removed?.length || 0;
  }
  if (subject.emails.length > 0) {
    const { data: removed, error } = await sb
      .from('contact_verifications')
      .delete()
      .eq('workspace_id', wsId)
      .in('identifier', subject.emails)
      .select('id');
    check('deleting verifications', error);
    summary.verifications_deleted += removed?.length || 0;
  }
  if (subject.contact_ids.length > 0 || subject.visitor_ids.length > 0) {
    const orParts: string[] = [];
    if (subject.contact_ids.length > 0) orParts.push(`contact_id.in.(${subject.contact_ids.join(',')})`);
    if (subject.visitor_ids.length > 0) orParts.push(`visitor_id.in.(${subject.visitor_ids.map((v) => `"${v}"`).join(',')})`);
    const { data: removed, error } = await sb
      .from('identity_merges')
      .delete()
      .eq('workspace_id', wsId)
      .or(orParts.join(','))
      .select('id');
    check('deleting identity merges', error);
    summary.identity_merges_deleted = removed?.length || 0;
  }

  // ─── 7. Anonymize email_logs ────────────────────────────────────
  if (subject.emails.length > 0) {
    for (const email of subject.emails) {
      const hash = `anon_${crypto.createHash('sha256').update(`e:${email}`).digest('hex').slice(0, 16)}@anonymized.local`;
      const { data: changed, error } = await sb
        .from('email_logs')
        .update({ recipient_email: hash, metadata: {} })
        .eq('workspace_id', wsId)
        .eq('recipient_email', email)
        .select('id');
      check('anonymizing email logs', error);
      summary.email_logs_anonymized += changed?.length || 0;
    }
  }

  // ─── 8. Anonymize / delete the contacts row(s) ─────────────────
  if (subject.contact_ids.length > 0) {
    // If there are surviving conversations, anonymize the contact row;
    // else hard-delete.
    if (conversationIds.length > 0) {
      const { data: changed, error } = await sb
        .from('contacts')
        .update({
          email: null,
          phone: null,
          name: null,
          notes: null,
          avatar_url: null,
          // The key is the record of a WebYar-owned avatar; clearing only the
          // URL column would leave the object still addressable from the row.
          avatar_storage_key: null,
          tags: [],
          metadata: { anonymized: true, anonymized_at: new Date().toISOString() },
        })
        .in('id', subject.contact_ids)
        .eq('workspace_id', wsId)
        .select('id');
      check('anonymizing contacts', error);
      summary.contacts_anonymized = changed?.length || 0;
    } else {
      const { data: removed, error } = await sb.from('contacts').delete().in('id', subject.contact_ids).eq('workspace_id', wsId).select('id');
      check('deleting contacts', error);
      summary.contacts_anonymized = removed?.length || 0;
    }
  }

  return summary;
}