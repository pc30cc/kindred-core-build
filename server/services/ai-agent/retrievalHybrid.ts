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
 *
 * NOTE: the underlying per-source-type allow/deny policy (workspace +
 * enabled/status/used_by_ai/approved) is shared with Source Health via
 * ./sourcePolicy.ts — see that file for the single source of truth. Chunk/
 * embedding health, excluded-summary counters, and cross-workspace
 * attribution below remain owned by this file only.
 * Excluded counters here mirror Source Health reasons:
 *   disabled_qna_excluded ↔ disabled_qna
 *   draft_kb_excluded ↔ draft_kb
 *   inactive_file_excluded ↔ file_not_active
 *   inactive_web_page_excluded ↔ website_not_active
 *   unapproved_learned_qna_excluded ↔ candidate_not_approved
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { resolveEmbeddingProvider, isUsableEmbeddingProvider } from './embeddings/index.js';
import { vectorToSql } from './knowledgeIndex/indexer.js';
import { detectTopics, type TopicKey } from './queryExpansion.js';
import {
  deriveWebPageParentSourceId,
  isQnaSourceAllowed,
  isKbArticleSourceAllowed,
  isLearnedQnaSourceAllowed,
  isFileSourceAllowed,
  isWebsiteSourceAllowed,
} from './sourcePolicy.js';

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
  topic_boost: number;
  url_boost: number;
  locale_bonus: number;
  source_priority: number;
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
  /** E2C — visitor's current page context for URL-aware retrieval. */
  pageContext?: {
    currentPageUrl?: string | null;
    currentPageOrigin?: string | null;
    currentPagePath?: string | null;
    currentPageTitle?: string | null;
  } | null;
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
  topics: TopicKey[];
  /** E2C — debug info about the page-aware match. */
  pageContextDebug?: {
    current_page_url: string | null;
    current_page_title: string | null;
    exact_page_match: boolean;
    same_path_match: boolean;
    same_host_match: boolean;
    page_matched_source_ids: string[];
    page_url_boost_applied: boolean;
  };
  /** E5 — counts of items dropped by defense-in-depth eligibility filters. */
  excludedSummary?: {
    disabled_qna_excluded: number;
    draft_kb_excluded: number;
    /** PHASE 2 FIX — a stale chunk whose parent row exists but belongs to a
     *  different workspace (drift/defense-in-depth catch, not a normal
     *  runtime path since the initial retrieval queries are already
     *  workspace-scoped). Previously dropped silently with no counter. */
    cross_workspace_excluded: number;
    inactive_file_excluded: number;
    inactive_web_page_excluded: number;
    /** E5-Final — chunks for learned_qna whose candidate isn't approved. */
    unapproved_learned_qna_excluded: number;
    /**
     * @deprecated Response-shape compatibility field only. Inactive chunks
     * are filtered by status='active' at SQL query time, before ever
     * reaching this JS-level eligibility re-check, so this can never be
     * incremented here — always 0. Do not read it for observability; a
     * genuinely inactive/stale chunk that reached the candidate set would
     * instead be reflected in one of the other *_excluded counters above.
     */
    inactive_chunks_excluded: number;
    /**
     * @deprecated Response-shape compatibility field only. A pending (or
     * rejected) learning candidate is fully and correctly represented by
     * unapproved_learned_qna_excluded above — this field is never
     * independently incremented and always 0.
     */
    pending_candidates_excluded: number;
  };
  /** E5 — fully-formed debug payload, safe to persist to ai_agent_runs.metadata. */
  retrievalDebug?: Record<string, unknown>;
}

const SOURCE_PRIORITY: Record<HybridSourceKind, number> = {
  qna: 1.0,
  learned_qna: 0.95,
  kb_article: 0.85,
  web_page: 0.55,
  file: 0.5,
  business_profile: 0.45,
};

/** Canonicalize a URL for page-aware match: strip hash, strip sensitive
 *  query params, drop trailing slash, lowercase host, normalize www. */
function canonicalizeUrl(raw: string | null | undefined): { full: string; host: string; path: string } | null {
  if (!raw) return null;
  try {
    const u = new URL(raw);
    u.hash = '';
    for (const k of ['token','access_token','refresh_token','code','password','session','auth','key','secret','api_key','sig','signature']) {
      u.searchParams.delete(k);
    }
    let host = u.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    let path = u.pathname || '/';
    if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);
    const search = u.search || '';
    const full = `${u.protocol}//${host}${path}${search}`;
    return { full, host, path };
  } catch { return null; }
}

// Multilingual topic-keyword boosts. Lowercased and Unicode-aware.
const TOPIC_KEYWORD_BOOSTS: Record<TopicKey, string[]> = {
  pricing:  ['pricing', 'price', 'plan', 'plans', 'package', 'subscription', 'tier',
             'fiyat', 'ücret', 'paket', 'tarife', 'abonelik',
             'قیمت', 'تعرفه', 'پلن', 'اشتراک', 'هزینه', 'بسته'],
  features: ['feature', 'features', 'integration', 'module', 'capability',
             'özellik', 'özellikler', 'modül', 'entegrasyon',
             'ویژگی', 'امکانات', 'قابلیت', 'ماژول'],
  support:  ['support', 'help', 'agent', 'operator',
             'destek', 'yardım', 'temsilci',
             'پشتیبانی', 'کمک', 'پشتیبان'],
  contact:  ['contact', 'sales', 'iletişim', 'iletisim', 'satış', 'تماس', 'ارتباط'],
  billing:  ['invoice', 'payment', 'billing', 'refund', 'fatura', 'ödeme', 'فاکتور', 'پرداخت'],
  demo:     ['demo', 'trial', 'sandbox', 'deneme', 'دمو'],
  account:  ['account', 'login', 'signup', 'register', 'hesap', 'giriş', 'kayıt', 'حساب', 'ورود'],
};

const TOPIC_URL_HINTS: Record<TopicKey, string[]> = {
  pricing:  ['pricing', 'price', 'plans', 'fiyat', 'paket', 'tarife'],
  features: ['features', 'feature', 'ozellik', 'özellik', 'entegrasyon'],
  support:  ['support', 'destek', 'help', 'yardim', 'yardım'],
  contact:  ['contact', 'iletisim', 'iletişim'],
  billing:  ['billing', 'invoice', 'fatura', 'odeme', 'ödeme'],
  demo:     ['demo', 'trial', 'deneme'],
  account:  ['account', 'login', 'signup', 'hesap', 'giris', 'giriş'],
};

function computeTopicBoost(topics: TopicKey[], a: { title: string; content: string; slug: string | null; source_url: string | null }): { topic: number; url: number } {
  if (!topics.length) return { topic: 0, url: 0 };
  const hayText = ((a.title || '') + ' ' + (a.content || '')).toLowerCase();
  const hayUrl = ((a.slug || '') + ' ' + (a.source_url || '')).toLowerCase();
  let topicBoost = 0;
  let urlBoost = 0;
  for (const t of topics) {
    const kw = TOPIC_KEYWORD_BOOSTS[t] || [];
    if (kw.some((w) => hayText.includes(w.toLowerCase()))) topicBoost = Math.max(topicBoost, 0.25);
    const uh = TOPIC_URL_HINTS[t] || [];
    if (uh.some((w) => hayUrl.includes(w.toLowerCase()))) urlBoost = Math.max(urlBoost, 0.2);
  }
  return { topic: topicBoost, url: urlBoost };
}

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
    topics: [],
  };

  const topics = detectTopics(`${input.originalMessage} ${input.expandedQuery || ''}`);
  result.topics = topics;

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

  // ── E2C — page-aware injection. Always-on, separate from keyword/vector.
  // Pulls active web_page/website chunks matching the visitor's current URL
  // and stores per-key url_boost so they outrank generic vector matches when
  // the question is about "this page".
  const pageBoosts = new Map<string, number>();
  const pageMatchedIds: string[] = [];
  const pageDebug = {
    current_page_url: null as string | null,
    current_page_title: input.pageContext?.currentPageTitle || null,
    exact_page_match: false,
    same_path_match: false,
    same_host_match: false,
    page_matched_source_ids: [] as string[],
    page_url_boost_applied: false,
  };
  const canonical = canonicalizeUrl(input.pageContext?.currentPageUrl || null);
  if (canonical) {
    pageDebug.current_page_url = canonical.full;
    try {
      const { data: pageRows } = await sb
        .from('ai_knowledge_chunks')
        .select('id, source_type, source_id, title, content, locale, source_url, metadata')
        .eq('workspace_id', input.workspaceId)
        .eq('status', 'active')
        .in('source_type', ['web_page', 'website'])
        .limit(200);
      for (const c of pageRows || []) {
        const cu = canonicalizeUrl(c.source_url as string);
        if (!cu) continue;
        let boost = 0;
        if (cu.full === canonical.full) {
          boost = 1.0;
          pageDebug.exact_page_match = true;
        } else if (cu.host === canonical.host && cu.path === canonical.path) {
          boost = 0.8;
          pageDebug.same_path_match = true;
        } else if (cu.host === canonical.host) {
          boost = 0.35;
          pageDebug.same_host_match = true;
        }
        if (boost <= 0) continue;
        const key = `${c.source_type}:${c.source_id}`;
        const prevBoost = pageBoosts.get(key) || 0;
        if (boost > prevBoost) pageBoosts.set(key, boost);
        if (!pageMatchedIds.includes(c.source_id as string)) pageMatchedIds.push(c.source_id as string);
        upsert({
          key,
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
          // Inject a synthetic keyword score so it survives merges that have
          // no other signal — final scoring still adds url boost on top.
          keywordScore: 0,
          vectorScore: 0,
        });
      }
      pageDebug.page_matched_source_ids = pageMatchedIds;
      pageDebug.page_url_boost_applied = pageBoosts.size > 0;
    } catch (err: any) {
      console.warn('[ai-agent.retrievalHybrid] page-aware lookup failed:', err?.message || err);
    }
  }

  // ── 1) Keyword retrieval ──────────────────────────────────────────────
  try {
    // Retrieval safety contract (Pass E1):
    //   Only active workspace-scoped chunks are eligible. Draft/unpublished/
    //   disabled/rejected sources must be excluded before or during indexing,
    //   and inactive chunks must not be returned here.
    //   - Q&A: enabled = true only
    //   - KB articles: status = 'published' only
    //   - ai_knowledge_chunks: status = 'active' only, current workspace_id only
    //   - Vector phase below applies the same workspace_id + status='active' filters
    //   - No cross-workspace data, no pending/rejected learning candidates,
    //     no draft/unpublished KB, no disabled Q&A, no deleted/paused/failed sources.

    // Q&A — enabled only, workspace-scoped
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

    // KB articles — published only, workspace-scoped
    const { data: arts } = await sb
      .from('knowledge_base_articles')
      .select('id, slug, locale, title, excerpt, content')
      .eq('workspace_id', input.workspaceId)
      .eq('status', 'published')
      .eq('used_by_ai', true)
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
    // Active chunks only, workspace-scoped. Inactive/deleted chunks excluded.
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

  // ── 2.5) Defense-in-depth eligibility filter (E5 / Pass 3) ───────────
  // Even if a chunk is status='active', re-verify the parent row is still
  // eligible. Protects against drift between ai_knowledge_chunks and
  // ai_data_sources / ai_agent_qna / knowledge_base_articles.
  const excludedSummary = {
    disabled_qna_excluded: 0,
    draft_kb_excluded: 0,
    cross_workspace_excluded: 0,
    inactive_file_excluded: 0,
    inactive_web_page_excluded: 0,
    unapproved_learned_qna_excluded: 0,
    // @deprecated compatibility fields — see HybridRetrievalResult['excludedSummary']
    // doc comments. Never incremented; kept at 0 for response-shape stability.
    inactive_chunks_excluded: 0,
    pending_candidates_excluded: 0,
  };
  try {
    const all = Array.from(aggregated.values());
    const idsByKind: Record<string, Set<string>> = {};
    for (const a of all) {
      if (!idsByKind[a.source_type]) idsByKind[a.source_type] = new Set();
      idsByKind[a.source_type].add(a.source_id);
    }
    const eligibleQna = new Set<string>();
    const eligibleKb = new Set<string>();
    const eligibleFiles = new Set<string>();
    const eligibleWebPages = new Set<string>();
    const eligibleLearnedQna = new Set<string>();
    // PHASE 2 FIX — track rows found under a DIFFERENT workspace separately
    // from rows found under the right workspace but genuinely ineligible, so
    // the final loop below can attribute the drop to cross_workspace_excluded
    // instead of misreporting it as disabled/draft/inactive/unapproved.
    const crossWorkspaceQna = new Set<string>();
    const crossWorkspaceKb = new Set<string>();
    const crossWorkspaceLearnedQna = new Set<string>();
    // ai_data_sources ids (shared by file + web_page parent lookups) found
    // under a different workspace.
    const crossWorkspaceParents = new Set<string>();
    // Map web_page chunk source_id -> derived parent ai_data_sources.id.
    // web_page chunks use compound source_id like "${parentId}:${urlHash}" or
    // store parent_source_id in metadata. They are NOT directly rows in
    // ai_data_sources, so we cannot look them up by source_id.
    const webPageChunkParent = new Map<string, string>();
    if (idsByKind['web_page']?.size) {
      for (const a of all) {
        if (a.source_type !== 'web_page') continue;
        const meta: any = (a as any).metadata || {};
        const parent = deriveWebPageParentSourceId(a.source_id, meta);
        if (parent) webPageChunkParent.set(a.source_id, parent);
      }
    }
    if (idsByKind['qna']?.size) {
      const { data } = await sb
        .from('ai_agent_qna')
        .select('id, workspace_id, enabled')
        .in('id', Array.from(idsByKind['qna']));
      for (const r of data || []) {
        if (r.workspace_id !== input.workspaceId) { crossWorkspaceQna.add(r.id as string); continue; }
        if (isQnaSourceAllowed(r, input.workspaceId)) eligibleQna.add(r.id as string);
      }
    }
    if (idsByKind['kb_article']?.size) {
      const { data } = await sb
        .from('knowledge_base_articles')
        .select('id, workspace_id, status, used_by_ai')
        .in('id', Array.from(idsByKind['kb_article']));
      for (const r of data || []) {
        if (r.workspace_id !== input.workspaceId) { crossWorkspaceKb.add(r.id as string); continue; }
        if (isKbArticleSourceAllowed(r as any, input.workspaceId)) eligibleKb.add(r.id as string);
      }
    }
    if (idsByKind['learned_qna']?.size) {
      const { data } = await sb
        .from('ai_agent_learning_candidates')
        .select('id, workspace_id, status')
        .in('id', Array.from(idsByKind['learned_qna']));
      for (const r of data || []) {
        if (r.workspace_id !== input.workspaceId) { crossWorkspaceLearnedQna.add(r.id as string); continue; }
        if (isLearnedQnaSourceAllowed(r, input.workspaceId)) eligibleLearnedQna.add(r.id as string);
      }
    }
    // File chunks: source_id IS ai_data_sources.id directly.
    const fileSourceIds = idsByKind['file'] ? Array.from(idsByKind['file']) : [];
    // Web page chunks: derive parent ids from compound source_id / metadata.
    const webParentIds = Array.from(new Set(Array.from(webPageChunkParent.values())));
    const lookupIds = Array.from(new Set([...fileSourceIds, ...webParentIds]));
    const activeParentBySrc = new Map<string, 'file' | 'website'>();
    if (lookupIds.length) {
      const { data } = await sb
        .from('ai_data_sources')
        .select('id, workspace_id, source_type, status')
        .in('id', lookupIds);
      for (const r of data || []) {
        if (r.workspace_id !== input.workspaceId) { crossWorkspaceParents.add(r.id as string); continue; }
        if (isFileSourceAllowed(r, input.workspaceId)) {
          eligibleFiles.add(r.id as string);
          activeParentBySrc.set(r.id as string, 'file');
        } else if (isWebsiteSourceAllowed(r, input.workspaceId)) {
          activeParentBySrc.set(r.id as string, 'website');
        }
      }
      // A web_page chunk is eligible iff its derived parent website is active.
      for (const [chunkSrcId, parent] of webPageChunkParent.entries()) {
        if (activeParentBySrc.get(parent) === 'website') eligibleWebPages.add(chunkSrcId);
      }
    }
    for (const [key, a] of Array.from(aggregated.entries())) {
      let drop = false;
      if (a.source_type === 'qna') {
        if (crossWorkspaceQna.has(a.source_id)) {
          excludedSummary.cross_workspace_excluded += 1; drop = true;
        } else if (!eligibleQna.has(a.source_id)) {
          excludedSummary.disabled_qna_excluded += 1; drop = true;
        }
      } else if (a.source_type === 'kb_article') {
        if (crossWorkspaceKb.has(a.source_id)) {
          excludedSummary.cross_workspace_excluded += 1; drop = true;
        } else if (!eligibleKb.has(a.source_id)) {
          excludedSummary.draft_kb_excluded += 1; drop = true;
        }
      } else if (a.source_type === 'file') {
        if (crossWorkspaceParents.has(a.source_id)) {
          excludedSummary.cross_workspace_excluded += 1; drop = true;
        } else if (!eligibleFiles.has(a.source_id)) {
          excludedSummary.inactive_file_excluded += 1; drop = true;
        }
      } else if (a.source_type === 'web_page') {
        const parent = webPageChunkParent.get(a.source_id);
        if (parent && crossWorkspaceParents.has(parent)) {
          excludedSummary.cross_workspace_excluded += 1; drop = true;
        } else if (!eligibleWebPages.has(a.source_id)) {
          excludedSummary.inactive_web_page_excluded += 1; drop = true;
        }
      } else if (a.source_type === 'learned_qna') {
        if (crossWorkspaceLearnedQna.has(a.source_id)) {
          excludedSummary.cross_workspace_excluded += 1; drop = true;
        } else if (!eligibleLearnedQna.has(a.source_id)) {
          excludedSummary.unapproved_learned_qna_excluded += 1; drop = true;
        }
      }
      if (drop) aggregated.delete(key);
    }
  } catch (err: any) {
    console.warn('[ai-agent.retrievalHybrid] eligibility filter failed:', err?.message);
  }
  result.excludedSummary = excludedSummary;

  // ── 3) Score & rank ───────────────────────────────────────────────────
  const merged = Array.from(aggregated.values());
  for (const m of merged) {
    const prio = SOURCE_PRIORITY[m.source_type] ?? 0.5;
    const lb = localeBonus(m.locale, input.responseLanguage, input.inputLanguage);
    const boosts = computeTopicBoost(topics, {
      title: m.title || '',
      content: m.content || '',
      slug: m.slug,
      source_url: m.source_url,
    });
    const pageBoost = pageBoosts.get(m.key) || 0;
    const final =
      (m.keywordScore * 0.32)
      + (m.vectorScore * 0.40)
      + (prio * 0.10)
      + (lb * 0.05)
      + (boosts.topic * 0.08)
      + (boosts.url * 0.05)
      // E2C — page-aware URL boost. Exact page match dominates the ranking.
      + (pageBoost * 0.55);
    (m as any).finalScore = final;
    (m as any).topicBoost = boosts.topic;
    (m as any).urlBoost = Math.max(boosts.url, pageBoost);
    (m as any).localeBonus = lb;
    (m as any).sourcePriority = prio;
  }
  merged.sort((a: any, b: any) => b.finalScore - a.finalScore);

  const top = merged.slice(0, limit).map((m: any) => {
    const isFile = m.source_type === 'file';
    return {
      id: m.id,
      kind: m.source_type as HybridSourceKind,
      source_type: m.source_type,
      source_id: m.source_id,
      title: m.title,
      content: m.content,
      excerpt: m.excerpt,
      locale: m.locale,
      // Files MUST NEVER expose any URL (storage_path/storage_url/signed_url).
      source_url: isFile ? null : (m.source_url || null),
      slug: m.slug,
      score: Number(m.finalScore.toFixed(4)),
      keyword_score: Number(m.keywordScore.toFixed(4)),
      vector_score: Number(m.vectorScore.toFixed(4)),
      final_score: Number(m.finalScore.toFixed(4)),
      topic_boost: Number((m.topicBoost || 0).toFixed(4)),
      url_boost: Number((m.urlBoost || 0).toFixed(4)),
      locale_bonus: Number((m.localeBonus || 0).toFixed(4)),
      source_priority: Number((m.sourcePriority || 0).toFixed(4)),
      metadata: sanitizeChunkMetadata(m.metadata),
    };
  });

  result.sources = top as HybridSource[];
  result.retrievalResultsCount = top.length;
  result.pageContextDebug = pageDebug;
  // ── 4) Standardized retrieval_debug payload (E5 Phase 2) ──────────────
  // Safe to persist into ai_agent_runs.metadata. Never includes storage_path,
  // signed_url, credentials, or full chunk content (preview capped at 300 chars).
  result.retrievalDebug = {
    query: {
      original_message: input.originalMessage,
      retrieval_query: input.retrievalQuery,
      expanded_query: input.expandedQuery || null,
      input_language: input.inputLanguage || null,
      response_language: input.responseLanguage,
    },
    execution: {
      hybrid_used: result.hybridUsed,
      vector_used: result.vectorUsed,
      keyword_used: result.keywordUsed,
      embedding_provider: result.embeddingProvider,
      embedding_model: result.embeddingModel,
      fallback_reason: result.fallbackReason || null,
      retrieval_results_count: result.retrievalResultsCount,
    },
    page_context: {
      current_page_url: pageDebug.current_page_url,
      current_page_path: input.pageContext?.currentPagePath || null,
      current_page_title: pageDebug.current_page_title,
      exact_page_match: pageDebug.exact_page_match,
      same_path_match: pageDebug.same_path_match,
      same_host_match: pageDebug.same_host_match,
      page_url_boost_applied: pageDebug.page_url_boost_applied,
      page_matched_source_ids: pageDebug.page_matched_source_ids,
    },
    ranking_weights: {
      keyword_weight: 0.32,
      vector_weight: 0.40,
      source_priority_weight: 0.10,
      locale_bonus_weight: 0.05,
      topic_boost_weight: 0.08,
      url_boost_weight: 0.05,
      page_boost_weight: 0.55,
    },
    selected_sources: top.map((s: any, i: number) => ({
      id: s.source_id,
      source_type: s.source_type,
      title: s.title,
      // Files MUST never expose source_url / storage path.
      source_url: s.source_type === 'file' ? null : (s.source_url || null),
      locale: s.locale,
      score: s.score,
      final_score: s.final_score,
      keyword_score: s.keyword_score,
      vector_score: s.vector_score,
      source_priority: s.source_priority,
      locale_bonus: s.locale_bonus,
      topic_boost: s.topic_boost,
      url_boost: s.url_boost,
      page_boost: pageBoosts.get(`${s.source_type}:${s.source_id}`) || 0,
      matched_reason:
        s.vector_score >= 0.5 && s.keyword_score >= 0.3 ? 'hybrid'
        : s.vector_score >= 0.5 ? 'vector'
        : s.keyword_score >= 0.3 ? 'keyword'
        : (pageBoosts.get(`${s.source_type}:${s.source_id}`) || 0) > 0 ? 'page_context'
        : 'priority',
      included_in_prompt: i < 5,
      content_preview: ((s.content || s.excerpt || '') as string).slice(0, 300),
    })),
    excluded_sources_summary: excludedSummary,
  };
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

/**
 * E5 — strip storage / credential / token leaks from chunk metadata before it
 * is shipped through retrieval results, prompts, or run metadata.
 */
const SENSITIVE_META_KEYS = [
  'storage_path','storage_url','signed_url','signedurl','public_url',
  'token','secret','password','credential','credentials','api_key','apikey',
  'access_key','accesskey','authorization','signature',
];
function sanitizeChunkMetadata(meta: any): Record<string, unknown> | undefined {
  if (!meta || typeof meta !== 'object') return meta || undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(meta)) {
    const lk = k.toLowerCase();
    if (SENSITIVE_META_KEYS.some((p) => lk.includes(p))) continue;
    out[k] = v as unknown;
  }
  return out;
}