/**
 * Canonical subject identity resolver.
 *
 * Every export/delete query in the worker MUST use the resolved set
 * returned here (contact_ids + visitor_ids + emails) as the filter.
 * Never trust the raw subject_id alone — it would miss merged identities.
 */

import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import type {
  PrivacySubjectType,
  ResolvedSubject,
} from './types.js';

export async function resolveSubject(
  config: ServerConfig,
  workspaceId: string | null,
  subjectType: PrivacySubjectType,
  subjectId: string,
): Promise<ResolvedSubject> {
  const sb = getServiceClient(config);

  // The SQL function accepts a workspace_id (uuid). For user-subject jobs
  // we still call it with NULL — the function handles that branch.
  const { data, error } = await sb.rpc('resolve_privacy_subject', {
    _workspace_id: workspaceId as any,
    _subject_type: subjectType,
    _subject_id: subjectId,
  });

  if (error) {
    throw new Error(`resolve_privacy_subject failed: ${error.message}`);
  }

  const raw = (data as any) || {};
  return {
    contact_ids: Array.isArray(raw.contact_ids) ? raw.contact_ids : [],
    visitor_ids: Array.isArray(raw.visitor_ids) ? raw.visitor_ids : [],
    emails: Array.isArray(raw.emails) ? raw.emails : [],
  };
}

export function isSubjectEmpty(s: ResolvedSubject): boolean {
  return (
    s.contact_ids.length === 0 &&
    s.visitor_ids.length === 0 &&
    s.emails.length === 0
  );
}