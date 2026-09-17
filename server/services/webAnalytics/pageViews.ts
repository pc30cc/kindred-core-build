/**
 * WEB ANALYTICS — the single choke point for `visitor_page_views` writes.
 *
 * Five request handlers append page-view rows (the widget /track page_view
 * and first-page-of-a-new-session paths, the widget /action page change, and
 * the operator-side /track and /heartbeat routes). They used to each carry
 * their own insert + slice + best-effort catch, which meant there was no one
 * place to answer "is this table still being written?".
 *
 * Nothing in the product reads these rows back to make a decision — they feed
 * the visitor-journey / page-path reports, the funnel computation and the
 * per-visitor page history in the Inbox, and nothing else. That is why they
 * sit behind PRODUCT_ANALYTICS_LOGGING; see server/config.ts.
 */
import type { ServerConfig } from '../../config.js';
import type { ServiceClient } from '../../supabase.js';

const MAX_URL_LEN = 2048;
const MAX_TITLE_LEN = 300;

export interface VisitorPageViewInput {
  workspaceId: string;
  sessionId: string;
  url: string;
  title?: unknown;
  /** Short label for the best-effort warning, e.g. 'widget-track'. */
  context: string;
}

/**
 * Best-effort: never throws, never blocks the response it was called from.
 * A no-op when PRODUCT_ANALYTICS_LOGGING=off — read as `!== false` so an
 * omitted field (the hand-built worker ServerConfig literals) keeps writing.
 */
export async function recordVisitorPageView(
  config: ServerConfig,
  sb: ServiceClient,
  input: VisitorPageViewInput,
): Promise<void> {
  if (config.productAnalyticsLoggingEnabled === false) return;
  try {
    await sb.from('visitor_page_views').insert({
      workspace_id: input.workspaceId,
      visitor_session_id: input.sessionId,
      url: String(input.url).slice(0, MAX_URL_LEN),
      title: input.title ? String(input.title).slice(0, MAX_TITLE_LEN) : null,
    });
  } catch (e: any) {
    console.warn(`[${input.context}] page-view insert failed:`, e?.message);
  }
}
