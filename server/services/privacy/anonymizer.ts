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
 */

import * as crypto from 'crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { deleteFile, deleteForOwner } from '../storage/index.js';
import { scrubPii } from './scrub.js';
import type { PrivacyJobRow, ResolvedSubject } from './types.js';
import { unsealDays } from '../analytics/sealing.js';

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
  verifications_deleted: number;
  email_logs_anonymized: number;
  audit_logs_anonymized: number;
  identity_merges_deleted: number;
  /** Analytics workspace-days marked for rebuild so the lake stops carrying this subject's old values. */
  analytics_days_unsealed?: number;
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
    verifications_deleted: 0,
    email_logs_anonymized: 0,
    audit_logs_anonymized: 0,
    identity_merges_deleted: 0,
    analytics_days_unsealed: 0,
  };

  // ─── User-subject branch ───────────────────────────────────────
  if (job.subject_type === 'user') {
    const userId = job.subject_id;
    // Anonymize audit_logs entries by this user (never delete — kept for audit trail)
    const anonHash = `anon_${crypto.createHash('sha256').update(`u:${userId}`).digest('hex').slice(0, 16)}`;
    // Soft-revoke active sessions
    await sb.from('auth_sessions').update({ revoked_at: new Date().toISOString() }).eq('user_id', userId).is('revoked_at', null);

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
    await sb
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
    const { data } = await sb
      .from('visitor_sessions')
      .select('id')
      .eq('workspace_id', wsId)
      .or(orParts.join(','));
    sessionIds = (data || []).map((r: { id: string }) => r.id);
  }

  // The analytics lake denormalizes this subject's visitor_id (and their
  // referrer) onto every event row it wrote for them. Parquet objects are
  // immutable, so an erasure cannot UPDATE them — it invalidates the seal
  // for the days the subject was active, and the sealing pass rewrites
  // those days from the rows this function is about to anonymize. Gathered
  // BEFORE the rotation, because afterwards there is nothing left to match.
  // See server/services/analytics/sealing.ts.
  let analyticsDays: string[] = [];
  if (sessionIds.length > 0) {
    const { data: activity } = await sb
      .from('visitor_page_views')
      .select('viewed_at')
      .eq('workspace_id', wsId)
      .in('visitor_session_id', sessionIds)
      .limit(10_000);
    const days = new Set<string>();
    for (const row of (activity || []) as { viewed_at: string }[]) days.add(row.viewed_at.slice(0, 10));
    const { data: sessionDays } = await sb
      .from('visitor_sessions')
      .select('started_at')
      .eq('workspace_id', wsId)
      .in('id', sessionIds);
    for (const row of (sessionDays || []) as { started_at: string }[]) {
      if (row.started_at) days.add(row.started_at.slice(0, 10));
    }
    analyticsDays = [...days].sort();
  }

  let conversationIds: string[] = [];
  if (subject.contact_ids.length > 0 || sessionIds.length > 0) {
    const orParts: string[] = [];
    if (subject.contact_ids.length > 0) orParts.push(`contact_id.in.(${subject.contact_ids.join(',')})`);
    if (sessionIds.length > 0) orParts.push(`visitor_session_id.in.(${sessionIds.join(',')})`);
    const { data } = await sb
      .from('conversations')
      .select('id')
      .eq('workspace_id', wsId)
      .or(orParts.join(','));
    conversationIds = (data || []).map((r: { id: string }) => r.id);
  }

  // ─── 1. Redact contact-authored messages (idempotent) ──────────
  if (conversationIds.length > 0) {
    const { data: contactMsgs } = await sb
      .from('conversation_messages')
      .select('id,body')
      .in('conversation_id', conversationIds)
      .in('sender_type', ['contact', 'visitor'])
      .neq('body', REDACTED_BODY);
    for (const m of contactMsgs || []) {
      await sb
        .from('conversation_messages')
        .update({ body: REDACTED_BODY, sender_id: null, metadata: { anonymized: true } })
        .eq('id', m.id);
      summary.contact_messages_redacted++;
    }

    // ─── 2. Scrub operator-written message bodies (regex PII) ────
    // Only operator messages that contain the subject's email/phone get
    // touched; placeholders make this idempotent.
    const { data: opMsgs } = await sb
      .from('conversation_messages')
      .select('id,body,metadata')
      .in('conversation_id', conversationIds)
      .not('sender_type', 'in', '(contact,visitor)');
    for (const m of opMsgs || []) {
      const r = scrubPii(m.body || '');
      if (r.changed) {
        const newMeta = { ...(m.metadata || {}), partially_redacted: true };
        await sb
          .from('conversation_messages')
          .update({ body: r.text, metadata: newMeta })
          .eq('id', m.id);
        summary.operator_messages_scrubbed++;
      }
    }

    // ─── 3. Scrub notes (operator-internal) ────────────────────────
    const { data: notes } = await sb
      .from('conversation_notes')
      .select('id,body,metadata')
      .eq('workspace_id', wsId)
      .in('conversation_id', conversationIds);
    for (const n of notes || []) {
      const r = scrubPii(n.body || '');
      if (r.changed) {
        const newMeta = { ...(n.metadata || {}), partially_redacted: true };
        await sb
          .from('conversation_notes')
          .update({ body: r.text, metadata: newMeta })
          .eq('id', n.id);
        summary.notes_scrubbed++;
      }
    }
  }

  // ─── 4. Delete subject-uploaded attachments (storage + row) ────
  if (conversationIds.length > 0) {
    const { data: subjectAttachments } = await sb
      .from('conversation_attachments')
      .select('id,storage_path')
      .eq('workspace_id', wsId)
      .in('conversation_id', conversationIds)
      .eq('uploaded_by_type', 'visitor');
    for (const a of subjectAttachments || []) {
      try {
        await deleteFile(config, wsId, a.storage_path);
      } catch {
        // best-effort — DB row removal still progresses idempotency
      }
      await sb.from('conversation_attachments').delete().eq('id', a.id);
      summary.attachments_deleted++;
    }
  }

  // ─── 5. Anonymize conversations + visitor_sessions ─────────────
  if (conversationIds.length > 0) {
    const { data: changed } = await sb
      .from('conversations')
      .update({ contact_id: null })
      .in('id', conversationIds)
      .not('contact_id', 'is', null)
      .select('id');
    summary.conversations_anonymized = changed?.length || 0;
  }

  if (sessionIds.length > 0) {
    // Rotate visitor_id + clear PII on each session row
    const { data: sessions } = await sb
      .from('visitor_sessions')
      .select('id,visitor_id')
      .in('id', sessionIds);
    for (const s of sessions || []) {
      const newVid = (s.visitor_id || '').startsWith(ANON_VISITOR_PREFIX)
        ? s.visitor_id
        : anonVisitorId(s.visitor_id || s.id);
      await sb
        .from('visitor_sessions')
        .update({
          visitor_id: newVid,
          contact_id: null,
          ip_address: null,
          user_agent: null,
          referrer: null,
        })
        .eq('id', s.id);
      if (newVid !== s.visitor_id) summary.visitor_sessions_anonymized++;
    }
  }

  // ─── 6. Delete contact verifications + identity merges ─────────
  if (subject.visitor_ids.length > 0) {
    const { data: removed } = await sb
      .from('contact_verifications')
      .delete()
      .eq('workspace_id', wsId)
      .in('visitor_id', subject.visitor_ids)
      .select('id');
    summary.verifications_deleted += removed?.length || 0;
  }
  if (subject.emails.length > 0) {
    const { data: removed } = await sb
      .from('contact_verifications')
      .delete()
      .eq('workspace_id', wsId)
      .in('identifier', subject.emails)
      .select('id');
    summary.verifications_deleted += removed?.length || 0;
  }
  if (subject.contact_ids.length > 0 || subject.visitor_ids.length > 0) {
    const orParts: string[] = [];
    if (subject.contact_ids.length > 0) orParts.push(`contact_id.in.(${subject.contact_ids.join(',')})`);
    if (subject.visitor_ids.length > 0) orParts.push(`visitor_id.in.(${subject.visitor_ids.map((v) => `"${v}"`).join(',')})`);
    const { data: removed } = await sb
      .from('identity_merges')
      .delete()
      .eq('workspace_id', wsId)
      .or(orParts.join(','))
      .select('id');
    summary.identity_merges_deleted = removed?.length || 0;
  }

  // ─── 7. Anonymize email_logs ────────────────────────────────────
  if (subject.emails.length > 0) {
    for (const email of subject.emails) {
      const hash = `anon_${crypto.createHash('sha256').update(`e:${email}`).digest('hex').slice(0, 16)}@anonymized.local`;
      const { data: changed } = await sb
        .from('email_logs')
        .update({ recipient_email: hash, metadata: {} })
        .eq('workspace_id', wsId)
        .eq('recipient_email', email)
        .select('id');
      summary.email_logs_anonymized += changed?.length || 0;
    }
  }

  // ─── 8. Anonymize / delete the contacts row(s) ─────────────────
  if (subject.contact_ids.length > 0) {
    // If there are surviving conversations, anonymize the contact row;
    // else hard-delete.
    if (conversationIds.length > 0) {
      const { data: changed } = await sb
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
      summary.contacts_anonymized = changed?.length || 0;
    } else {
      await sb.from('contacts').delete().in('id', subject.contact_ids).eq('workspace_id', wsId);
      summary.contacts_anonymized = subject.contact_ids.length;
    }
  }

  // Every affected day is now unsealed: the next sealing cycle rebuilds
  // those workspace-days from the anonymized rows, replacing the objects
  // that still carry the old visitor_id. Best-effort by design — the
  // PostgreSQL anonymization above has already committed, and failing the
  // whole job because a bookkeeping write failed would leave the subject
  // half-processed. A missed unseal is visible in the Analytics Storage
  // panel as a day that never re-seals.
  if (analyticsDays.length > 0) {
    try {
      summary.analytics_days_unsealed = await unsealDays(
        config, wsId, analyticsDays[0], analyticsDays[analyticsDays.length - 1],
      );
    } catch (err: unknown) {
      console.error('[privacy] could not unseal analytics days:', err instanceof Error ? err.message : err);
    }
  }

  return summary;
}