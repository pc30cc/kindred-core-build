/**
 * AI Agent — KB retrieval. Reuses existing knowledge_base_articles + ai_agent_qna.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

export interface RetrievedSource {
  kind: 'qna' | 'kb_article';
  id: string;
  title: string;
  excerpt?: string | null;
  content?: string | null;
  slug?: string | null;
  locale?: string | null;
  score: number;
}

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/**
 * Coverage score in [0,1]: the share of DISTINCT query terms present in the
 * text. Counting every occurrence (the previous behaviour) let a document
 * inflate its score — and even exceed 1.0 — by repeating one keyword, which
 * pushed keyword-stuffed pages above genuinely relevant ones and corrupted the
 * confidence value derived from the top score.
 */
function scoreText(query: string, text: string): number {
  if (!text) return 0;
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;
  const tTokens = new Set(tokenize(text));
  let matched = 0;
  for (const t of qTokens) if (tTokens.has(t)) matched++;
  return matched / qTokens.size;
}

/** Internal seams exposed for regression tests only. */
export const __testables = { tokenize, scoreText };

export async function retrieveSources(
  config: ServerConfig,
  workspaceId: string,
  query: string,
  locale: string,
  limit = 5,
): Promise<RetrievedSource[]> {
  const sb = getServiceClient(config);
  const out: RetrievedSource[] = [];

  // 1) Q&A pairs first (locale-preferred)
  const { data: qna } = await sb
    .from('ai_agent_qna')
    .select('id,question,answer,locale')
    .eq('workspace_id', workspaceId)
    .eq('enabled', true)
    .limit(200);
  for (const row of qna || []) {
    const score = Math.max(
      scoreText(query, row.question) * 1.4,
      scoreText(query, row.answer) * 0.6,
    ) + (row.locale === locale ? 0.05 : 0);
    if (score > 0) {
      out.push({
        kind: 'qna',
        id: row.id,
        title: row.question,
        content: row.answer,
        excerpt: row.answer.slice(0, 200),
        locale: row.locale,
        score,
      });
    }
  }

  // 2) Published KB articles (locale-preferred, fallback to any)
  const tryLocaleQuery = async (loc?: string) => {
    let q = sb
      .from('knowledge_base_articles')
      .select('id,slug,locale,title,excerpt,content')
      .eq('workspace_id', workspaceId)
      .eq('status', 'published')
      .eq('used_by_ai', true);
    if (loc) q = q.eq('locale', loc);
    const { data } = await q.limit(100);
    return data || [];
  };
  let articles = await tryLocaleQuery(locale);
  if (articles.length === 0) articles = await tryLocaleQuery(undefined);

  for (const a of articles) {
    const score = Math.max(
      scoreText(query, a.title) * 1.2,
      scoreText(query, a.excerpt || '') * 0.8,
      scoreText(query, (a.content || '').slice(0, 4000)) * 0.6,
    ) + (a.locale === locale ? 0.05 : 0);
    if (score > 0) {
      out.push({
        kind: 'kb_article',
        id: a.id,
        title: a.title,
        excerpt: a.excerpt,
        content: a.content,
        slug: a.slug,
        locale: a.locale,
        score,
      });
    }
  }

  out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}

export async function getKnowledgeStatus(
  config: ServerConfig,
  workspaceId: string,
): Promise<{
  published: number;
  drafts: number;
  by_locale: Record<string, number>;
  qna_count: number;
  has_any: boolean;
}> {
  const sb = getServiceClient(config);
  const { data: rows } = await sb
    .from('knowledge_base_articles')
    .select('id,status,locale')
    .eq('workspace_id', workspaceId);
  let published = 0, drafts = 0;
  const by_locale: Record<string, number> = {};
  for (const r of rows || []) {
    if (r.status === 'published') {
      published++;
      by_locale[r.locale || 'unknown'] = (by_locale[r.locale || 'unknown'] || 0) + 1;
    } else if (r.status === 'draft') {
      drafts++;
    }
  }
  const { count: qnaCount } = await sb
    .from('ai_agent_qna')
    .select('id', { count: 'exact', head: true })
    .eq('workspace_id', workspaceId);
  return {
    published,
    drafts,
    by_locale,
    qna_count: qnaCount || 0,
    has_any: published > 0 || (qnaCount || 0) > 0,
  };
}