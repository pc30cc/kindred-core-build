/**
 * Phase 6-S5-R1 — private Knowledge Base API client.
 *
 * All dashboard KB reads/writes go through the Express backend so that the
 * `knowledge_base` module entitlement is enforced server-side. The client
 * never talks to Supabase directly for private KB data.
 */
import { API_BASE } from './api';
import type { KnowledgeBaseArticle, KnowledgeBaseCategory } from '@/types/models';

export type ArticleStatus = 'draft' | 'published' | 'archived';

export interface KnowledgeBaseArticleInput {
  title: string;
  slug: string;
  content: string;
  excerpt: string;
  locale: string;
  status: ArticleStatus;
  category_id: string | null;
  visible_in_widget: boolean;
}

export type KnowledgeBaseArticleWithCategory = KnowledgeBaseArticle & {
  knowledge_base_categories: { name: string; slug: string } | null;
};

export class KnowledgeBaseApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly upgradeRequired: boolean;
  readonly plan: string | null;

  constructor(status: number, body: Record<string, unknown>) {
    const code = typeof body.error === 'string' ? body.error : 'knowledge_base_request_failed';
    super(code);
    this.name = 'KnowledgeBaseApiError';
    this.status = status;
    this.code = code;
    this.upgradeRequired = body.upgrade_required === true;
    this.plan = typeof body.plan === 'string' ? body.plan : null;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${API_BASE}/api/knowledge-base${path}`, {credentials: 'include', 
    ...init,
    headers: { ...({}), ...(init?.headers || {}) },
  });
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new KnowledgeBaseApiError(res.status, body);
  return body as T;
}

function qs(params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) sp.set(k, v);
  const s = sp.toString();
  return s ? `?${s}` : '';
}

export const knowledgeBaseApi = {
  async listArticles(workspaceId: string, locale?: string, status?: string) {
    const { articles } = await request<{ articles: KnowledgeBaseArticleWithCategory[] }>(
      `/articles${qs({ workspaceId, locale, status })}`,
    );
    return articles;
  },
  async createArticle(workspaceId: string, article: Partial<KnowledgeBaseArticleInput>) {
    const { article: created } = await request<{ article: KnowledgeBaseArticle }>('/articles', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, article }),
    });
    return created;
  },
  async updateArticle(workspaceId: string, id: string, article: Partial<KnowledgeBaseArticleInput>) {
    const { article: updated } = await request<{ article: KnowledgeBaseArticle }>(
      `/articles/${id}${qs({ workspaceId })}`,
      { method: 'PATCH', body: JSON.stringify({ workspaceId, article }) },
    );
    return updated;
  },
  async deleteArticle(workspaceId: string, id: string) {
    return request<{ deleted: boolean; id: string }>(`/articles/${id}${qs({ workspaceId })}`, {
      method: 'DELETE',
    });
  },
  async listCategories(workspaceId: string, locale?: string) {
    const { categories } = await request<{ categories: KnowledgeBaseCategory[] }>(
      `/categories${qs({ workspaceId, locale })}`,
    );
    return categories;
  },
  async createCategory(workspaceId: string, category: Partial<KnowledgeBaseCategory>) {
    const { category: created } = await request<{ category: KnowledgeBaseCategory }>('/categories', {
      method: 'POST',
      body: JSON.stringify({ workspaceId, category }),
    });
    return created;
  },
  async updateCategory(workspaceId: string, id: string, category: Partial<KnowledgeBaseCategory>) {
    const { category: updated } = await request<{ category: KnowledgeBaseCategory }>(
      `/categories/${id}${qs({ workspaceId })}`,
      { method: 'PATCH', body: JSON.stringify({ workspaceId, category }) },
    );
    return updated;
  },
  async deleteCategory(workspaceId: string, id: string) {
    return request<{ deleted: boolean; id: string }>(`/categories/${id}${qs({ workspaceId })}`, {
      method: 'DELETE',
    });
  },
};
