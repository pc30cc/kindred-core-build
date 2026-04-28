/**
 * Shared types for the AI KB Builder subsystem (server + worker).
 */

export type AiKbJobStatus =
  | 'queued' | 'running' | 'crawling' | 'extracting' | 'generating'
  | 'completed' | 'partial' | 'failed' | 'canceled';

export type AiKbPageStatus = 'pending' | 'fetched' | 'extracted' | 'skipped' | 'failed';

export type AiKbGeneratedStatus = 'pending' | 'accepted' | 'rejected' | 'published';

export interface AiKbJobRow {
  id: string;
  workspace_id: string;
  requested_by: string | null;
  source_kind: 'workspace_domain' | 'profile_domain';
  source_domain: string;
  source_workspace_domain_id: string | null;
  source_verified: boolean;
  locale: string;
  status: AiKbJobStatus;
  progress: number;
  plan_snapshot: any;
  pages_discovered: number;
  pages_crawled: number;
  pages_failed: number;
  articles_generated: number;
  credits_used: number;
  error_message: string | null;
  worker_id: string | null;
  claimed_at: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface PlanSnapshot {
  planSlug: string | null;
  maxPages: number;
  maxDepth: number;
  jobsPerMonth: number;
  maxArticles: number;
  maxChars: number;
  monthlyCredits: number;
  source: {
    kind: 'workspace_domain' | 'profile_domain';
    domain: string;
    verified: boolean;
    workspace_domain_id: string | null;
  };
}

export function slugifyTitle(title: string): string {
  return (title || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || `article-${Date.now()}`;
}
