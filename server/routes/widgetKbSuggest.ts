/**
 * GET /api/widget/kb-suggest — instant answers for the draft a visitor is
 * writing (t1/t2 Core only; runtime-kb.js `suggestArticles`). Registered in
 * server/routes/widget.ts below enforceWidgetToken / enforceOrigin, after its
 * own per-visitor bucket (`kb_suggest`) and process ceiling
 * (kbSuggestGlobalCeiling): it shares neither with the help center's
 * /api/widget/kb routes.
 *
 *   ?workspace_id=<uuid, optional: the token's>&q=<1..200>&locale=fa&limit=2
 *   200 { results: [{ slug, title, snippet, matches: [words], readingMinutes }] }
 *
 * Bad input, a draft with nothing to search, no match and a database error
 * all answer `{ results: [] }`: the tray just stays hidden. 401/403 come from
 * the token middleware (and a workspace_id that is not the token's), 429
 * `{ code, retry_after }` from the limiters.
 */
import type { Request, Response } from 'express';
import { z } from 'zod';
import { serverConfigOf } from '../lib/workspaceAuth.js';
import { resolveWorkspaceId } from '../services/widget/security.js';
import { KB_SUGGEST_MAX_LIMIT, kbSuggestWords, suggestKbArticles } from '../services/knowledge-base/widgetSuggest.js';

const suggestSchema = z.object({
  workspace_id: z.string().uuid().optional(),
  q: z.string().min(1).max(200),
  locale: z.string().min(2).max(10).optional(),
  // Clamped, not refused: a limit outside 1..3 (or no number) still gets answers.
  limit: z.preprocess(
    (v) => (typeof v === 'string' && Number.isFinite(Number(v)) && v.trim() !== '' ? Math.trunc(Number(v)) : undefined),
    z.number().int().optional(),
  ).transform((n) => Math.min(KB_SUGGEST_MAX_LIMIT, Math.max(1, n ?? 2))),
});

export async function handleKbSuggest(req: Request, res: Response) {
  res.set('Cache-Control', 'no-store');
  const parsed = suggestSchema.safeParse(req.query);
  // A malformed workspace_id is still checked against the token (403).
  const workspaceId = resolveWorkspaceId(req, res, parsed.success ? parsed.data.workspace_id : (req.query.workspace_id as string | undefined));
  if (res.headersSent) return;
  if (!parsed.success || !workspaceId) return res.json({ results: [] });

  const words = kbSuggestWords(parsed.data.q);
  if (!words.length) return res.json({ results: [] });
  try {
    const results = await suggestKbArticles(serverConfigOf(req), workspaceId, words, parsed.data.limit, parsed.data.locale ?? null);
    return res.json({ results });
  } catch (err) {
    console.warn('[kb-suggest] failed:', err instanceof Error ? err.message : err);
    return res.json({ results: [] });
  }
}
