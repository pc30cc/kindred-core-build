/**
 * The published articles of a workspace the public may read (moved, as it
 * was, out of server/routes/kb.ts so the widget's instant answers,
 * widgetSuggest.ts, read through the same query).
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { applyKbUnlockedFilter, type KbLock } from './locks.js';

/**
 * The published articles of a workspace the public may read: an article the
 * plan has locked (over max_kb_articles, simple billing phase 4) is left out
 * of every list and its own page answers 404. While locks are off, or
 * unreadable, `lock` is inactive and this is the plain published query.
 *
 * Synchronous on purpose: the query builder is a thenable, so an async
 * helper returning it would run it instead of handing it back for chaining.
 */
export function publicArticles<Cols extends string>(config: ServerConfig, workspaceId: string, columns: Cols, lock: KbLock) {
  return applyKbUnlockedFilter(
    getServiceClient(config)
      .from('knowledge_base_articles')
      .select(columns)
      .eq('workspace_id', workspaceId)
      .eq('status', 'published'),
    lock,
  );
}
