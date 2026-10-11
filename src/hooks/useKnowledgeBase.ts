import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import {
  knowledgeBaseApi,
  type KnowledgeBaseArticleInput,
  type KnowledgeBaseArticleWithCategory,
} from '@/lib/knowledge-base-api';
import type { KnowledgeBaseCategory } from '@/types/models';
import { useTranslation, type TranslationKey } from '@/i18n';

/**
 * Phase 6-S5-R1 — Knowledge Base is an INDEPENDENT product.
 *
 * All private CRUD goes through the Express backend, which enforces
 * authentication, workspace membership and the `knowledge_base` module.
 * These hooks never call the AI Agent API: AI indexing is driven
 * asynchronously from a neutral database event, so an AI outage or a
 * missing AI plan can never block article CRUD.
 */

export function useKBCategories(workspaceId: string | undefined, locale?: string) {
  return useQuery({
    queryKey: ['kb-categories', workspaceId, locale],
    queryFn: () => knowledgeBaseApi.listCategories(workspaceId!, locale),
    enabled: !!workspaceId,
  });
}

/**
 * Simple billing phase 4: the server marks each article over the plan's
 * `max_kb_articles` with `locked: true`. A locked article stays listed (the
 * owner can still read and delete it) but is hidden from the help center,
 * the widget and the AI, and cannot be edited.
 */
export type KnowledgeBaseListArticle = KnowledgeBaseArticleWithCategory & { locked?: boolean };

export function isKBArticleLocked(article: { locked?: unknown } | null | undefined): boolean {
  return article?.locked === true;
}

export function useKBArticles(workspaceId: string | undefined, locale?: string, status?: string) {
  return useQuery<KnowledgeBaseListArticle[]>({
    queryKey: ['kb-articles', workspaceId, locale, status],
    queryFn: () => knowledgeBaseApi.listArticles(workspaceId!, locale, status),
    enabled: !!workspaceId,
  });
}

/** Texts of a locked article, from the `kb.locked.*` keys (fa/en/tr). */
const KB_LOCKED_TEXT_KEYS = {
  badge: 'kb.locked.badge',
  tooltip: 'kb.locked.tooltip',
  editorNotice: 'kb.locked.descNoLimit',
  saveBlocked: 'kb.locked.error',
} as const satisfies Record<string, TranslationKey>;

export type KBLockedTextKey = keyof typeof KB_LOCKED_TEXT_KEYS;

export function useKBLockedText(): (key: KBLockedTextKey) => string {
  const { t } = useTranslation();
  return (key) => t(KB_LOCKED_TEXT_KEYS[key]);
}

export function useCreateKBArticle(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (article: Partial<KnowledgeBaseArticleInput>) =>
      knowledgeBaseApi.createArticle(workspaceId!, article),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb-articles'] });
      qc.invalidateQueries({ queryKey: ['public-help'] });
    },
  });
}

export function useUpdateKBArticle(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      workspace_id,
      ...updates
    }: Partial<KnowledgeBaseArticleInput> & { id: string; workspace_id?: string }) =>
      knowledgeBaseApi.updateArticle((workspace_id || workspaceId)!, id, updates),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb-articles'] });
      qc.invalidateQueries({ queryKey: ['public-help'] });
    },
  });
}

export function useDeleteKBArticle(workspaceId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: string | { id: string; workspace_id?: string }) => {
      const id = typeof input === 'string' ? input : input.id;
      const ws = (typeof input === 'string' ? workspaceId : input.workspace_id || workspaceId)!;
      await knowledgeBaseApi.deleteArticle(ws, id);
      return { id, workspace_id: ws };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb-articles'] });
      qc.invalidateQueries({ queryKey: ['public-help'] });
    },
  });
}

export function useCreateKBCategory(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (cat: Partial<KnowledgeBaseCategory>) =>
      knowledgeBaseApi.createCategory(workspaceId!, cat),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kb-categories'] }),
  });
}
