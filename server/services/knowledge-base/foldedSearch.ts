/**
 * The help search, folded on both sides (V-30, migration 280a): the visitor's
 * words are folded here (widgetSuggest.ts kbFold) and the articles' title,
 * summary and text by the database (public.kb_search_fold), so «پيگيري سفارش»
 * typed on an Arabic keyboard finds «پیگیری سفارش», «كد تخفيف» finds «کد
 * تخفیف», «میخواهم» finds «می‌خواهم» and «۲۰۲۶» finds «2026», and the other
 * way round. One reader for the widget's search (word by word and as one
 * phrase), its instant answers and the help center's search page.
 *
 * public.kb_search_folded returns whole article rows, so the caller's
 * columns, the plan's KB lock (the same `or` filter publicArticles applies)
 * and its limit are added as they are on the table. Before migration 280a
 * the function does not exist: `null` tells the caller to run its plain
 * ILIKE, as before.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { applyKbUnlockedFilter, type KbLock } from './locks.js';

export interface KbFoldedSearchOptions {
  /** Also match the article's text (the help search); instant answers match title and summary only. */
  content: boolean;
  /** Only articles shown in the widget (`visible_in_widget`, instant answers). */
  widgetOnly?: boolean;
}

/** The database has no kb_search_folded yet (before migration 280a). */
export function isFoldedSearchMissing(error: { code?: string; message?: string } | null | undefined): boolean {
  if (!error) return false;
  return error.code === '42883' || error.code === 'PGRST202'
    || (typeof error.message === 'string' && /kb_search_folded/.test(error.message) && /does not exist|could not find/i.test(error.message));
}

/**
 * The published articles of `workspaceId` that any of `terms` (each one
 * substring: a word, or a whole phrase) matches, folded, newest first, at
 * most `limit`; locked articles are left out. Null when the database cannot
 * fold (before migration 280a).
 */
export async function kbFoldedSearch<Row = Record<string, unknown>>(
  config: ServerConfig,
  workspaceId: string,
  columns: string,
  lock: KbLock,
  terms: string[],
  opts: KbFoldedSearchOptions,
  limit: number,
): Promise<{ data: Row[] | null; error: { message: string; code?: string } | null } | null> {
  let result: { data: unknown; error: { message: string; code?: string } | null };
  try {
    const query = getServiceClient(config)
      .rpc('kb_search_folded', {
        p_workspace_id: workspaceId,
        p_terms: terms,
        p_with_content: opts.content,
        p_widget_only: !!opts.widgetOnly,
      })
      .select(columns);
    result = await applyKbUnlockedFilter(query, lock)
      .order('updated_at', { ascending: false })
      .order('id', { ascending: true })
      .limit(limit);
  } catch {
    // A data layer that cannot call it at all: the plain ILIKE.
    return null;
  }
  const { data, error } = result;
  if (isFoldedSearchMissing(error)) return null;
  return { data: (data as Row[] | null) ?? null, error: error ? { message: error.message, code: error.code } : null };
}
