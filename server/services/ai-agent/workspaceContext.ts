/**
 * AI Agent — workspace navigation context (Pass 3).
 *
 * Produces SAFE links the AI may mention (pricing/contact/help) and a list
 * of indexed source URLs for retrieval scoring. Never invents URLs — every
 * link returned is either:
 *   - an indexed `ai_knowledge_chunks.source_url` for this workspace, or
 *   - a published `knowledge_base_articles.slug` under /help/<slug>.
 *
 * The domain is the workspace's VERIFIED domain from `workspace_domains`
 * (the primary one first), otherwise omitted: an unverified domain is never
 * offered as a fallback. `workspaces` has no domain column; reading
 * `workspaces.verified_domain` failed on every call, so no domain was ever set.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface WorkspaceContext {
  workspaceId: string;
  domain: string | null;
  pricingUrl: string | null;
  contactUrl: string | null;
  helpUrl: string | null;
  knownPaths: string[];
}

const COMMON_PATH_HINTS: Record<string, string[]> = {
  pricing: ['/pricing', '/plans', '/fiyat', '/paket', '/prices'],
  contact: ['/contact', '/contact-us', '/iletisim', '/iletişim', '/تماس'],
  help: ['/help', '/docs', '/kb', '/yardım', '/yardim', '/راهنما'],
};

function pickPath(urls: string[], hints: string[]): string | null {
  for (const u of urls) {
    const lower = u.toLowerCase();
    if (hints.some((h) => lower.includes(h))) return u;
  }
  return null;
}

export async function loadWorkspaceContext(
  config: ServerConfig,
  workspaceId: string,
): Promise<WorkspaceContext> {
  const sb = getServiceClient(config);
  let domain: string | null = null;
  try {
    const { data: domains } = await sb
      .from('workspace_domains')
      .select('domain')
      .eq('workspace_id', workspaceId)
      .eq('verified', true)
      .order('is_primary', { ascending: false })
      .order('created_at', { ascending: true })
      .limit(1);
    const first = (domains as Array<{ domain: string | null }> | null)?.[0];
    domain = first?.domain?.trim() || null;
  } catch { /* best-effort */ }

  const urls = new Set<string>();
  try {
    const { data: chunks } = await sb
      .from('ai_knowledge_chunks')
      .select('source_url')
      .eq('workspace_id', workspaceId)
      .eq('status', 'active')
      .not('source_url', 'is', null)
      .limit(500);
    for (const r of (chunks || []) as Array<{ source_url: string | null }>) {
      if (r.source_url) urls.add(r.source_url);
    }
  } catch { /* best-effort */ }

  try {
    const { data: arts } = await sb
      .from('knowledge_base_articles')
      .select('slug')
      .eq('workspace_id', workspaceId)
      .eq('status', 'published')
      .not('slug', 'is', null)
      .limit(200);
    for (const r of (arts || []) as Array<{ slug: string | null }>) {
      if (r.slug) urls.add(`/help/${r.slug}`);
    }
  } catch { /* best-effort */ }

  const urlList = Array.from(urls);
  return {
    workspaceId,
    domain,
    pricingUrl: pickPath(urlList, COMMON_PATH_HINTS.pricing),
    contactUrl: pickPath(urlList, COMMON_PATH_HINTS.contact),
    helpUrl: pickPath(urlList, COMMON_PATH_HINTS.help),
    knownPaths: urlList.slice(0, 50),
  };
}