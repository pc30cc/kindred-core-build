/**
 * AI Agent — workspace navigation context (Pass 3).
 *
 * Produces SAFE links the AI may mention (pricing/contact/help) and a list
 * of indexed source URLs for retrieval scoring. Never invents URLs — every
 * link returned is either:
 *   - an indexed `ai_knowledge_chunks.source_url` for this workspace, or
 *   - a published `knowledge_base_articles.slug` under /help/<slug>.
 *
 * The verified workspace domain is read from `workspaces.verified_domain`
 * when available, otherwise omitted (no fallback domain).
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
    const { data: ws } = await sb
      .from('workspaces')
      .select('verified_domain, domain')
      .eq('id', workspaceId)
      .maybeSingle();
    domain = ((ws as any)?.verified_domain || (ws as any)?.domain || null) || null;
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
    for (const r of chunks || []) {
      const u = (r as any).source_url as string | null;
      if (u) urls.add(u);
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
    for (const r of arts || []) {
      const s = (r as any).slug as string | null;
      if (s) urls.add(`/help/${s}`);
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