import { supabase } from '@/lib/supabase';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import type { KnowledgeBaseArticle, KnowledgeBaseCategory } from '@/types/models';

/**
 * Phase 6-S5 — Knowledge Base is an INDEPENDENT product.
 * Article mutations MUST NOT call the AI Agent API. Re-indexing of KB
 * articles for the AI assistant is owned by the AI Agent side (Knowledge
 * Sources) and is triggered there, one-way, only for workspaces whose plan
 * includes `ai_assistant`.
 */

export function useKBCategories(workspaceId: string | undefined, locale?: string) {
  return useQuery({
    queryKey: ['kb-categories', workspaceId, locale],
    queryFn: async () => {
      let q = supabase
        .from('knowledge_base_categories')
        .select('*')
        .eq('workspace_id', workspaceId!)
        .order('sort_order', { ascending: true });
      if (locale) q = q.eq('locale', locale);
      const { data, error } = await q;
      if (error) throw error;
      return data as KnowledgeBaseCategory[];
    },
    enabled: !!workspaceId,
  });
}

export function useKBArticles(workspaceId: string | undefined, locale?: string, status?: string) {
  return useQuery({
    queryKey: ['kb-articles', workspaceId, locale, status],
    queryFn: async () => {
      let q = supabase
        .from('knowledge_base_articles')
        .select('*, knowledge_base_categories(name, slug)')
        .eq('workspace_id', workspaceId!)
        .order('updated_at', { ascending: false });
      if (locale) q = q.eq('locale', locale);
      if (status && status !== 'all') q = q.eq('status', status);
      const { data, error } = await q;
      if (error) throw error;
      return data as (KnowledgeBaseArticle & { knowledge_base_categories: { name: string; slug: string } | null })[];
    },
    enabled: !!workspaceId,
  });
}

export function useCreateKBArticle(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (article: Partial<KnowledgeBaseArticle>) => {
      const { data, error } = await supabase
        .from('knowledge_base_articles')
        .insert({ ...article, workspace_id: workspaceId! })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb-articles'] });
    },
  });
}

export function useUpdateKBArticle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, ...updates }: Partial<KnowledgeBaseArticle> & { id: string }) => {
      const { data, error } = await supabase
        .from('knowledge_base_articles')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', id)
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb-articles'] });
    },
  });
}

export function useDeleteKBArticle() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) => {
      const { data: row } = await supabase
        .from('knowledge_base_articles')
        .select('workspace_id')
        .eq('id', id)
        .maybeSingle();
      const { error } = await supabase.from('knowledge_base_articles').delete().eq('id', id);
      if (error) throw error;
      return { id, workspace_id: (row as any)?.workspace_id };
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['kb-articles'] });
    },
  });
}

export function useCreateKBCategory(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (cat: Partial<KnowledgeBaseCategory>) => {
      const { data, error } = await supabase
        .from('knowledge_base_categories')
        .insert({ ...cat, workspace_id: workspaceId! })
        .select()
        .single();
      if (error) throw error;
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['kb-categories'] }),
  });
}
