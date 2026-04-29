/**
 * AI Agent — Hybrid retrieval (Pass 2).
 *
 * Pipeline:
 *   1. Keyword retrieval over Q&A + KB articles + ai_knowledge_chunks.
 *   2. Vector retrieval over ai_knowledge_chunks (when embeddings available).
 *   3. Merge by (source_type, source_id) keeping best chunk.
 *   4. Final score = 0.35*keyword + 0.45*vector + 0.15*priority + 0.05*locale.
 *
 * Always returns a result. Falls back to keyword-only when vector unavailable
 * or fails. Never throws to the caller — engine treats failures as "use the
 * legacy retriever".
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveEmbeddingProvider, isUsableEmbeddingProvider } from './embeddings/index.js';
import { vectorToSql } from './knowledgeIndex/indexer.js';

export type HybridSourceKind = 'qna' | 'kb_article' | 'learned_qna' | 'business_profile' | 'web_page' | 'file';

export interface HybridSource {
  /** id of the chunk row when vector hit, otherwise of the source row. */
  id: string;
  kind: HybridSourceKind;
  source_type: HybridSourceKind;
  source_id: string;
  title: string;
  content?: string | null;
  excerpt?: string | null;
  locale?: string | null;
  source_url?: string | null;
  slug?: string | null;
  score: number;
  keyword_score: number;
  vector_score: number;
  final_score: number;
  metadata?: Record<string, unknown>;
}

export interface HybridRetrievalInput {
  workspaceId: string;
  originalMessage: string;
  retrievalQuery: string;
  expandedQuery?: string;
  responseLanguage: string;
  inputLanguage?: string;
  limit?: number;
}

export interface HybridRetrievalResult {
  sources: HybridSource[];
  vectorUsed: boolean;
  keywordUsed: boolean;
  hybridUsed: boolean;
  fallbackReason?: string;
  embeddingProvider: string;
  embeddingModel: string;
  retrievalResultsCount: number;
}

const SOURCE_PRIORITY: Record<HybridSourceKind, number> = {
  qna: 1.0,
  learned_qna: 0.95,
  kb_article: 0.85,
  web_page: 0.55,
  file: 0.5,
  business_profile: 0.45,
};

function tokenize(text: string): string[] {
  return (text || '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

function keywordScore(query: string, text: string): number {
  if (!text) return 0;
  const qTokens = new Set(tokenize(query));
  if (qTokens.size === 0) return 0;
  const tTokens = tokenize(text);
  let hits = 0;
  for (const t of tTokens) if (qTokens.has(t)) hits += 1;
  return Math.min(1, hits / Math.max(qTokens.size, 1));
}

function localeBonus(sourceLocale: string | null | undefined, responseLang: string, inputLang?: string): number {
  const sl = (sourceLocale || '').toLowerCase().split(/[-_]/)[0];
  const rl = (responseLang || '').toLowerCase().split(/[-_]/)[0];
  const il = (inputLang || '').toLowerCase().split(/[-_]/)[0];
  if (!sl) return 0.3;
  if (sl === rl) return 1;
  if (il && sl === il) return 0.7;
  return 0.3;
}

interface Aggregated {
  key: string;
  source_type: HybridSourceKind;
  source_id: string;
  id: string;
  title: string;
  content: string;
  excerpt: string | null;
  locale: string | null;
  source_url: string | null;
  slug: string | null;
  metadata: Record<string, unknown>;
  keywordScore: number;
  vectorScore: number;
}

export async function retrieveHybridSources(
  config: ServerConfig,
  input: HybridRetrievalInput,
): Promise<HybridRetrievalResult> {
  const sb = getServiceClient(config);
  const limit = Math.min(20, Math.max(1, input.limit ?? 5));
  const queryForKeyword = (input.expandedQuery || input.retrievalQuery || input.originalMessage || '').trim();
  const queryForVector = (input.retrievalQuery || input.originalMessage || '').trim();

  const result: HybridRetrievalResult = {
    sources: [],
    vectorUsed: false,
    keywordUsed: false,
    hybridUsed: false,
    embeddingProvider: 'noop',
    embeddingModel: 'noop',
    retrievalResultsCount: 0,
  };

  const aggregated = new Map<string, Aggregated>();
  const upsert = (a: Aggregated) => {
    const prev = aggregated.get(a.key);
    if (!prev) {
      aggregated.set(a.key, a);
      return;
    }
    prev.keywordScore = Math.max(prev.keywordScore, a.keywordScore);
    prev.vectorScore = Math.max(prev.vectorScore, a.vectorScore);
    if (!prev.content && a.content) prev.content = a.content;
    if (!prev.excerpt && a.excerpt) prev.excerpt = a.excerpt;
    if (!prev.title && a.title) prev.title = a.title;
  };

  // ── 1) Keyword retrieval ──────────────────────────────────────────────
  try {
    // Q&A
    const { data: qna } = await sb
      .from('ai_agent_qna')
      .select('id, question, answer, locale')
      .eq('workspace_id', input.workspaceId)
      .eq('enabled', true)
      .limit(200);
    for (const q of qna || []) {
      const score = Math.max(
        keywordScore(queryForKeyword, q.question) * 1.4,
        keywordScore(queryForKeyword, q.answer) * 0.6,
      );
      if (score <= 0) continue;
      upsert({
        key: `qna:${q.id}`,
        source_type: 'qna',
        source_id: q.id as string,
        id: q.id as string,
        title: q.question as string,
        content: q.answer as string,
        excerpt: (q.answer as string)?.slice(0, 240) ?? null,
        locale: (q.locale as string) || null,
        source_url: null,
        slug: null,
        metadata: {},
        keywordScore: Math.min(1, score),
        vectorScore: 0,
      });
    }

    // KB articles
    const { data: arts } = await sb
      .from('knowledge_base_articles')
      .select('id, slug, locale, title, excerpt, content')
      .eq('workspace_id', input.workspaceId)
      .eq('status', 'published')
      .limit(150);
    for (const a of arts || []) {
      const score = Math.max(
        keywordScore(queryForKeyword, a.title) * 1.2,
        keywordScore(queryForKeyword, a.excerpt || '') * 0.8,
        keywordScore(queryForKeyword, ((a.content || '') as string).slice(0, 4000)) * 0.6,
      );
      if (score <= 0) continue;
      upsert({
        key: `kb_article:${a.id}`,
        source_type: 'kb_article',
        source_id: a.id as string,
        id: a.id as string,
        title: (a.title as string) || '',
        content: (a.content as string) || '',
        excerpt: (a.excerpt as string) || null,
        locale: (a.locale as string) || null,
        source_url: a.slug ? `/help/${a.slug}` : null,
        slug: (a.slug as string) || null,
        metadata: {},
        keywordScore: Math.min(1, score),
        vectorScore: 0,
      });
    }

    // Chunk-level keyword (covers business_profile, learned_qna, web_page, file)
    const { data: chunks } = await sb
      .from('ai_knowledge_chunks')
      .select('id, source_type, source_id, title, content, locale, source_url, metadata')
      .eq('workspace_id', input.workspaceId)
      .eq('status', 'active')
      .limit(500);
    for (const c of chunks || []) {
      const score = Math.max(
        keywordScore(queryForKeyword, c.title || '') * 1.2,
        keywordScore(queryForKeyword, ((c.content || '') as string).slice(0, 4000)) * 0.7,
      );
      if (score <= 0) continue;
      upsert({
        key: `${c.source_type}:${c.source_id}`,
        source_type: c.source_type as HybridSourceKind,
        source_id: c.source_id as string,
        id: c.id as string,
        title: (c.title as string) || '',
        content: (c.content as string) || '',
        excerpt: ((c.content as string) || '').slice(0, 240),
        locale: (c.locale as string) || null,
        source_url: (c.source_url as string) || null,
        slug: null,
        metadata: (c.metadata as any) || {},
        keywordScore: Math.min(1, score),
        vectorScore: 0,
      });
    }

    result.keywordUsed = true;
  } catch (err: any) {
    console.warn('[ai-agent.retrievalHybrid] keyword phase failed:', err?.message);
    result.fallbackReason = `keyword_failed:${err?.message || 'unknown'}`;
  }

  // ── 2) Vector retrieval ───────────────────────────────────────────────
  try {
    const embedder = await resolveEmbeddingProvider(config, input.workspaceId);
    result.embeddingProvider = embedder.name;
    result.embeddingModel = embedder.model;
    if (isUsableEmbeddingProvider(embedder) && queryForVector) {
      const vec = (await embedder.embedTexts([queryForVector]))[0];
      if (vec && vec.length) {
        const sqlVec = vectorToSql(vec);
        // Use raw RPC-style query via .select with order by embedding distance.
        // supabase-js doesn't support custom operators in order directly, so we
        // call a parameterised SQL via .rpc-free fallback: use .select and
        // .order on the computed distance via Postgres function. Easiest path:
        // use a temporary RPC if present, else fall back to a simple subset
        // with a computed expression.
        const { data: vecRows, error } = await sb
          .from('ai_knowledge_chunks')
          .select('id, source_type, source_id, title, content, locale, source_url, metadata, embedding')
          .eq('workspace_id', input.workspaceId)
          .eq('status', 'active')
          .not('embedding', 'is', null)
          // Order by cosine distance via raw expression — supported by PostgREST 11+.
          // Fallback: if the .order with 'embedding <=> ...' is unsupported,
          // we just sort client-side below.
          .limit(500);
        if (error) throw new Error(error.message);

        // Compute cosine similarity client-side (we already capped at 500).
        const scored = (vecRows || [])
          .map((r: any) => {
            const emb = parseVector(r.embedding);
            const sim = emb ? cosine(vec, emb) : 0;
            return { row: r, sim };
          })
          .filter((s) => s.sim > 0)
          .sort((a, b) => b.sim - a.sim)
          .slice(0, 20);

        for (const { row, sim } of scored) {
          upsert({
            key: `${row.source_type}:${row.source_id}`,
            source_type: row.source_type as HybridSourceKind,
            source_id: row.source_id as string,
            id: row.id as string,
            title: (row.title as string) || '',
            content: (row.content as string) || '',
            excerpt: ((row.content as string) || '').slice(0, 240),
            locale: (row.locale as string) || null,
            source_url: (row.source_url as string) || null,
            slug: null,
            metadata: (row.metadata as any) || {},
            keywordScore: 0,
            vectorScore: Math.min(1, sim),
          });
        }
        result.vectorUsed = true;
      }
    }
  } catch (err: any) {
    console.warn('[ai-agent.retrievalHybrid] vector phase failed:', err?.message);
    if (!result.fallbackReason) result.fallbackReason = `vector_failed:${err?.message || 'unknown'}`;
  }

  result.hybridUsed = result.keywordUsed && result.vectorUsed;

  // ── 3) Score & rank ───────────────────────────────────────────────────
  const merged = Array.from(aggregated.values());
  for (const m of merged) {
    const prio = SOURCE_PRIORITY[m.source_type] ?? 0.5;
    const lb = localeBonus(m.locale, input.responseLanguage, input.inputLanguage);
    const final = (m.keywordScore * 0.35) + (m.vectorScore * 0.45) + (prio * 0.15) + (lb * 0.05);
    (m as any).finalScore = final;
  }
  merged.sort((a: any, b: any) => b.finalScore - a.finalScore);

  const top = merged.slice(0, limit).map((m: any) => ({
    id: m.id,
    kind: m.source_type as HybridSourceKind,
    source_type: m.source_type,
    source_id: m.source_id,
    title: m.title,
    content: m.content,
    excerpt: m.excerpt,
    locale: m.locale,
    source_url: m.source_url,
    slug: m.slug,
    score: Number(m.finalScore.toFixed(4)),
    keyword_score: Number(m.keywordScore.toFixed(4)),
    vector_score: Number(m.vectorScore.toFixed(4)),
    final_score: Number(m.finalScore.toFixed(4)),
    metadata: m.metadata,
  }));

  result.sources = top as HybridSource[];
  result.retrievalResultsCount = top.length;
  return result;
}

/**
 * pgvector returns embeddings either as JSON array (number[]) or as text
 * "[0.1,0.2,...]". Handle both.
 */
function parseVector(v: any): number[] | null {
  if (!v) return null;
  if (Array.isArray(v)) return v.map((n) => Number(n));
  if (typeof v === 'string') {
    try {
      const arr = JSON.parse(v);
      if (Array.isArray(arr)) return arr.map((n) => Number(n));
    } catch {
      const trimmed = v.replace(/^\[|\]$/g, '');
      return trimmed.split(',').map((n) => Number(n));
    }
  }
  return null;
}

function cosine(a: number[], b: number[]): number {
  const len = Math.min(a.length, b.length);
  if (!len) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < len; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (!na || !nb) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}