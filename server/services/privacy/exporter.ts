/**
 * Privacy export executor.
 *
 * Builds a single ZIP per job containing:
 *   manifest.json          — job metadata, schema version, scope, sha256 placeholder
 *   contact.json           — subject contact row (if any)
 *   visitor_sessions.json  — session rows linked to subject
 *   conversations.json     — conversation rows
 *   messages.json          — messages with sender_type + visibility
 *   events.json            — conversation_events for the conversations
 *   contact_verifications.json
 *   identity_merges.json
 *   email_logs.json
 *   notes.json             — only if scope.include_notes === true
 *   profile.json           — for user-subject only
 *   memberships.json       — for user-subject only
 *   audit_logs.json        — for user-subject only (self-scoped)
 *   attachments/<id>__<safe-name>  — files uploaded by the subject
 *   README.txt             — explanation
 *
 * Workspace scoping is enforced on every query: WHERE workspace_id = $job.workspace_id
 * AND <subject filter from resolved identity>.
 */

import * as crypto from 'crypto';
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { downloadFile } from '../storage/index.js';
import { ZipBuilder } from './zip.js';
import type {
  PrivacyJobRow,
  PrivacyJobScope,
  ResolvedSubject,
} from './types.js';

const SCHEMA_VERSION = '1.0.0';

function safeFileName(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '_').slice(0, 80) || 'file';
}

function pseudonymizeOperatorId(id: string | null | undefined): string | null {
  if (!id) return null;
  const h = crypto.createHash('sha256').update(`operator:${id}`).digest('hex');
  return `operator_${h.slice(0, 12)}`;
}

function stripOperatorMetadata(meta: any): any {
  if (!meta || typeof meta !== 'object') return {};
  // Operator messages must not leak internal-only metadata to a subject export.
  // Whitelist the only fields a contact would reasonably see in chat.
  const out: Record<string, unknown> = {};
  if (meta.kind) out.kind = meta.kind; // e.g. 'reply', 'system'
  if (meta.attachments && Array.isArray(meta.attachments)) {
    out.attachments = meta.attachments.map((a: any) =>
      a && typeof a === 'object'
        ? { id: a.id, file_name: a.file_name, mime_type: a.mime_type, size_bytes: a.size_bytes }
        : a,
    );
  }
  return out;
}

/**
 * Run an export job. Returns { buffer, sha256 } — caller writes to storage.
 * Idempotent: relies on service-role reads only; does not mutate domain data.
 */
export async function buildExportZip(
  config: ServerConfig,
  job: PrivacyJobRow,
): Promise<{ buffer: Buffer; sha256: string; manifestSummary: Record<string, unknown> }> {
  const sb = getServiceClient(config);
  const subject: ResolvedSubject = job.resolved_identity || { contact_ids: [], visitor_ids: [], emails: [] };
  const scope: PrivacyJobScope = (job.scope as PrivacyJobScope) || {};
  const zip = new ZipBuilder();

  const summary: Record<string, number> = {};

  // ─── Helpers ────────────────────────────────────────────────────
  const writeJson = (name: string, value: unknown) => {
    zip.add(name, JSON.stringify(value, null, 2));
  };

  // ─── User-subject branch ────────────────────────────────────────
  if (job.subject_type === 'user') {
    const userId = job.subject_id;
    const { data: profile } = await sb.from('profiles').select('*').eq('id', userId).maybeSingle();
    writeJson('profile.json', profile || null);
    summary.profile = profile ? 1 : 0;

    const { data: members } = await sb.from('workspace_members').select('*').eq('user_id', userId);
    writeJson('memberships.json', members || []);
    summary.memberships = (members || []).length;

    const { data: accountMembers } = await sb.from('account_members').select('*').eq('user_id', userId);
    writeJson('account_members.json', accountMembers || []);
    summary.account_members = (accountMembers || []).length;

    const { data: audit } = await sb
      .from('audit_logs')
      .select('id,workspace_id,entity_type,entity_id,action,old_value,new_value,created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(5000);
    writeJson('audit_logs.json', audit || []);
    summary.audit_logs = (audit || []).length;
  } else {
    // ─── Contact / visitor branch (workspace-scoped) ──────────────
    if (!job.workspace_id) {
      throw new Error('contact/visitor jobs require workspace_id');
    }
    const wsId = job.workspace_id;

    // contact rows
    if (subject.contact_ids.length > 0) {
      const { data: contacts } = await sb
        .from('contacts')
        .select('*')
        .eq('workspace_id', wsId)
        .in('id', subject.contact_ids);
      writeJson('contacts.json', contacts || []);
      summary.contacts = (contacts || []).length;
    } else {
      writeJson('contacts.json', []);
      summary.contacts = 0;
    }

    // visitor sessions
    let visitorSessions: any[] = [];
    if (subject.visitor_ids.length > 0 || subject.contact_ids.length > 0) {
      const orParts: string[] = [];
      if (subject.visitor_ids.length > 0) {
        orParts.push(`visitor_id.in.(${subject.visitor_ids.map((v) => `"${v}"`).join(',')})`);
      }
      if (subject.contact_ids.length > 0) {
        orParts.push(`contact_id.in.(${subject.contact_ids.join(',')})`);
      }
      const { data } = await sb
        .from('visitor_sessions')
        .select('*')
        .eq('workspace_id', wsId)
        .or(orParts.join(','));
      visitorSessions = data || [];
    }
    writeJson('visitor_sessions.json', visitorSessions);
    summary.visitor_sessions = visitorSessions.length;

    // conversations
    const sessionIds = visitorSessions.map((s) => s.id).filter(Boolean);
    const conversationIds: string[] = [];
    let conversations: any[] = [];
    if (subject.contact_ids.length > 0 || sessionIds.length > 0) {
      const orParts: string[] = [];
      if (subject.contact_ids.length > 0) orParts.push(`contact_id.in.(${subject.contact_ids.join(',')})`);
      if (sessionIds.length > 0) orParts.push(`visitor_session_id.in.(${sessionIds.join(',')})`);
      const { data } = await sb
        .from('conversations')
        .select('*')
        .eq('workspace_id', wsId)
        .or(orParts.join(','));
      conversations = data || [];
      conversationIds.push(...conversations.map((c) => c.id));
    }
    writeJson('conversations.json', conversations);
    summary.conversations = conversations.length;

    // messages — annotated with sender_type + visibility, operator IDs pseudonymized
    let messages: any[] = [];
    if (conversationIds.length > 0) {
      const { data } = await sb
        .from('conversation_messages')
        .select('*')
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: true });
      messages = (data || []).map((m: any) => {
        const isSubject = m.sender_type === 'contact' || m.sender_type === 'visitor';
        return {
          id: m.id,
          conversation_id: m.conversation_id,
          created_at: m.created_at,
          sender_type: m.sender_type,
          visibility: isSubject ? 'subject' : 'operator',
          sender_id: isSubject ? m.sender_id : pseudonymizeOperatorId(m.sender_id),
          body: m.body,
          metadata: isSubject ? (m.metadata || {}) : stripOperatorMetadata(m.metadata),
          seen_at: m.seen_at,
        };
      });
    }
    writeJson('messages.json', messages);
    summary.messages = messages.length;

    // conversation events (timeline) — operator IDs pseudonymized
    let events: any[] = [];
    if (conversationIds.length > 0) {
      const { data } = await sb
        .from('conversation_events')
        .select('*')
        .eq('workspace_id', wsId)
        .in('conversation_id', conversationIds)
        .order('created_at', { ascending: true });
      events = (data || []).map((e: any) => ({
        ...e,
        actor_id: e.actor_type === 'operator' ? pseudonymizeOperatorId(e.actor_id) : e.actor_id,
      }));
    }
    writeJson('events.json', events);
    summary.events = events.length;

    // notes — excluded by default
    if (scope.include_notes && conversationIds.length > 0) {
      const { data: notes } = await sb
        .from('conversation_notes')
        .select('*')
        .eq('workspace_id', wsId)
        .in('conversation_id', conversationIds);
      writeJson('notes.json', notes || []);
      summary.notes = (notes || []).length;
    } else {
      writeJson('notes.json', []);
      summary.notes = 0;
    }

    // contact verifications
    let verifications: any[] = [];
    if (subject.visitor_ids.length > 0 || subject.emails.length > 0) {
      const orParts: string[] = [];
      if (subject.visitor_ids.length > 0) orParts.push(`visitor_id.in.(${subject.visitor_ids.map((v) => `"${v}"`).join(',')})`);
      if (subject.emails.length > 0) orParts.push(`identifier.in.(${subject.emails.map((e) => `"${e}"`).join(',')})`);
      const { data } = await sb
        .from('contact_verifications')
        .select('id,workspace_id,identifier,channel,visitor_id,created_at,used_at,attempts')
        .eq('workspace_id', wsId)
        .or(orParts.join(','));
      verifications = data || [];
    }
    writeJson('contact_verifications.json', verifications);
    summary.verifications = verifications.length;

    // identity merges
    let merges: any[] = [];
    if (subject.contact_ids.length > 0 || subject.visitor_ids.length > 0) {
      const orParts: string[] = [];
      if (subject.contact_ids.length > 0) orParts.push(`contact_id.in.(${subject.contact_ids.join(',')})`);
      if (subject.visitor_ids.length > 0) orParts.push(`visitor_id.in.(${subject.visitor_ids.map((v) => `"${v}"`).join(',')})`);
      const { data } = await sb
        .from('identity_merges')
        .select('*')
        .eq('workspace_id', wsId)
        .or(orParts.join(','));
      merges = data || [];
    }
    writeJson('identity_merges.json', merges);
    summary.identity_merges = merges.length;

    // email logs
    let emailLogs: any[] = [];
    if (subject.emails.length > 0) {
      const { data } = await sb
        .from('email_logs')
        .select('id,workspace_id,recipient_email,template_slug,subject,status,sent_at,created_at')
        .eq('workspace_id', wsId)
        .in('recipient_email', subject.emails);
      emailLogs = data || [];
    }
    writeJson('email_logs.json', emailLogs);
    summary.email_logs = emailLogs.length;

    // attachments uploaded BY the subject (visitor)
    if (conversationIds.length > 0) {
      const { data: attachments } = await sb
        .from('conversation_attachments')
        .select('*')
        .eq('workspace_id', wsId)
        .in('conversation_id', conversationIds)
        .eq('uploaded_by_type', 'visitor');
      writeJson('attachments_index.json', attachments || []);
      summary.attachments_metadata = (attachments || []).length;

      let downloaded = 0;
      let skipped = 0;
      for (const a of attachments || []) {
        try {
          const dl = await downloadFile(config, wsId, a.storage_path);
          if (dl.success && dl.data) {
            zip.add(`attachments/${a.id}__${safeFileName(a.file_name)}`, dl.data);
            downloaded++;
          } else {
            skipped++;
          }
        } catch {
          skipped++;
        }
      }
      summary.attachments_downloaded = downloaded;
      summary.attachments_skipped = skipped;
    } else {
      writeJson('attachments_index.json', []);
    }
  }

  // ─── README + manifest ──────────────────────────────────────────
  const readme =
    `Privacy export — job ${job.id}\n` +
    `Generated: ${new Date().toISOString()}\n` +
    `Subject: ${job.subject_type} (${job.subject_id})\n` +
    `Workspace: ${job.workspace_id || '(cross-workspace user export)'}\n\n` +
    `Files in this archive contain machine-readable JSON. Messages include\n` +
    `a 'visibility' field: 'subject' for messages from the data subject and\n` +
    `'operator' for replies from staff. Operator IDs are pseudonymized.\n` +
    `Internal-only notes are not included unless explicitly requested.\n`;
  zip.add('README.txt', readme);

  const manifest = {
    schema_version: SCHEMA_VERSION,
    job_id: job.id,
    workspace_id: job.workspace_id,
    actor_user_id: job.actor_user_id,
    subject: { type: job.subject_type, id: job.subject_id },
    resolved_identity: subject,
    scope,
    generated_at: new Date().toISOString(),
    counts: summary,
  };
  zip.add('manifest.json', JSON.stringify(manifest, null, 2));

  const buffer = zip.build();
  const sha256 = crypto.createHash('sha256').update(buffer).digest('hex');
  return { buffer, sha256, manifestSummary: summary };
}