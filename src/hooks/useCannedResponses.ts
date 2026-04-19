/**
 * Phase 6 — React Query hooks for canned responses.
 *
 * Cache key shape:
 *   ['canned-responses', workspaceId, locale, q?]
 *
 * Why include locale in the key:
 *   The server returns operator-locale rows first, then fallback locales.
 *   Re-ranking is locale-dependent, so different operator locales must
 *   produce different cache entries.
 *
 * Why include `q` in the key:
 *   Search/rank tiers depend on the query. We keep results cached per query
 *   so a quick re-open of the picker doesn't refetch.
 *
 * Invalidation rules:
 *   - create / update / delete → invalidate every list for the workspace
 *     (all locales + all queries), since a row may newly match other queries
 *     or change its locale.
 *   - track-use → patch usage_count + last_used_at into every cached list
 *     for this workspace where the row appears, but DO NOT refetch. Counter
 *     is advisory; we avoid network churn during heavy operator use.
 *
 * Consumption guidance:
 *   - Settings page → useCannedResponses({ workspaceId, locale }) with no q.
 *     Items are pre-sorted: operator-locale first, then fallback locales.
 *     Each item carries its own `locale` field — render a badge when it
 *     differs from the operator locale.
 *   - Composer picker → useCannedResponses({ workspaceId, locale, q })
 *     debounced on input. Insert flow MUST call trackUse only after the
 *     reply is actually sent, never on hover/open/preview.
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  cannedResponsesApi,
  type CannedCreateInput,
  type CannedLocale,
  type CannedResponse,
  type CannedUpdateInput,
} from '@/lib/canned-responses-api';

type ListKey = ['canned-responses', string, CannedLocale, string];

/** Stable cache key — empty q normalizes to ''. */
function listKey(workspaceId: string, locale: CannedLocale, q = ''): ListKey {
  return ['canned-responses', workspaceId, locale, q];
}

/** Match any cached list for a workspace, regardless of locale or q. */
function workspaceListPredicate(workspaceId: string) {
  return (query: { queryKey: readonly unknown[] }) =>
    query.queryKey[0] === 'canned-responses' && query.queryKey[1] === workspaceId;
}

export interface UseCannedResponsesArgs {
  workspaceId: string | undefined;
  locale: CannedLocale | undefined;
  /** Slash-trigger / settings search. Empty string = list mode. */
  q?: string;
  /** Max items to return; server clamps to 1..50. */
  limit?: number;
  /** Disable the query (e.g. picker not open). */
  enabled?: boolean;
}

/**
 * List + search. Server returns items pre-sorted with operator-locale
 * first, then fallback locales. Each item retains its own `locale` so the
 * UI can render a fallback-language badge.
 */
export function useCannedResponses({
  workspaceId,
  locale,
  q = '',
  limit,
  enabled = true,
}: UseCannedResponsesArgs) {
  return useQuery({
    queryKey: workspaceId && locale ? listKey(workspaceId, locale, q) : ['canned-responses', 'idle'],
    queryFn: async () => {
      const data = await cannedResponsesApi.list({
        workspace_id: workspaceId!,
        locale: locale!,
        q: q || undefined,
        limit,
      });
      return data;
    },
    enabled: enabled && !!workspaceId && !!locale,
    staleTime: 30_000,
  });
}

export function useCreateCannedResponse(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<CannedCreateInput, 'workspace_id'>) => {
      if (!workspaceId) throw new Error('Missing workspace');
      return cannedResponsesApi.create({ ...input, workspace_id: workspaceId });
    },
    onSuccess: () => {
      if (!workspaceId) return;
      qc.invalidateQueries({ predicate: workspaceListPredicate(workspaceId) });
    },
  });
}

export function useUpdateCannedResponse(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({
      id,
      patch,
    }: {
      id: string;
      patch: Omit<CannedUpdateInput, 'workspace_id'>;
    }) => {
      if (!workspaceId) throw new Error('Missing workspace');
      return cannedResponsesApi.update(id, { ...patch, workspace_id: workspaceId });
    },
    onSuccess: () => {
      if (!workspaceId) return;
      qc.invalidateQueries({ predicate: workspaceListPredicate(workspaceId) });
    },
  });
}

export function useDeleteCannedResponse(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      if (!workspaceId) throw new Error('Missing workspace');
      return cannedResponsesApi.remove(id, workspaceId);
    },
    onSuccess: () => {
      if (!workspaceId) return;
      qc.invalidateQueries({ predicate: workspaceListPredicate(workspaceId) });
    },
  });
}

/**
 * Track a successful insertion. Patches cached lists in place rather than
 * invalidating, so the picker doesn't blink while the operator is typing.
 *
 * IMPORTANT: only call on actual send, not on preview / hover / open.
 */
export function useTrackCannedResponseUse(workspaceId: string | undefined) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => {
      if (!workspaceId) throw new Error('Missing workspace');
      return cannedResponsesApi.trackUse(id, workspaceId);
    },
    onSuccess: (data, id) => {
      if (!workspaceId) return;
      qc.setQueriesData<{ ok: true; items: CannedResponse[]; locale: CannedLocale } | undefined>(
        { predicate: workspaceListPredicate(workspaceId) },
        (prev) => {
          if (!prev) return prev;
          let mutated = false;
          const items = prev.items.map((row) => {
            if (row.id !== id) return row;
            mutated = true;
            return { ...row, usage_count: data.usage_count, last_used_at: data.last_used_at };
          });
          return mutated ? { ...prev, items } : prev;
        },
      );
    },
  });
}

export type { CannedResponse, CannedLocale } from '@/lib/canned-responses-api';
