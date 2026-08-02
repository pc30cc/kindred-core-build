/**
 * Phase 6-S5-R1 — Private Knowledge Base CRUD.
 *
 * Knowledge Base is an independent product. These routes are the ONLY
 * supported write path for the dashboard; they enforce authentication,
 * workspace membership, the `knowledge_base` module entitlement and
 * resource ownership before touching the database.
 *
 * NO AI dependency: nothing here calls an AI provider, the AI Agent API,
 * or the indexing pipeline. Indexing happens asynchronously from a neutral
 * database event (see the knowledge_base_change_events outbox).
 */
import express, { type Request, type Response, type Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess, serverConfigOf } from '../lib/workspaceAuth.js';
import { checkKnowledgeBaseModule } from '../services/knowledge-base/access.js';

export const knowledgeBaseRouter: Router = express.Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const articleInputSchema = z.object({
  title: z.string().trim().min(1).max(300),
  slug: z.string().trim().min(1).max(300),
  content: z.string().max(500_000).default(''),
  excerpt: z.string().max(2_000).default(''),
  locale: z.string().trim().min(2).max(10),
  status: z.enum(['draft', 'published', 'archived']).default('draft'),
  category_id: z.string().uuid().nullable().optional().default(null),
  visible_in_widget: z.boolean().optional().default(true),
});
const articlePatchSchema = articleInputSchema.partial();

const categoryInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  slug: z.string().trim().min(1).max(200),
  description: z.string().max(2_000).nullable().optional(),
  icon: z.string().max(64).nullable().optional(),
  locale: z.string().trim().min(2).max(10),
  sort_order: z.number().int().min(0).max(10_000).optional(),
});
const categoryPatchSchema = categoryInputSchema.partial();

/** Auth + membership + `knowledge_base` module. Writes the response on failure. */
async function guard(
  req: Request,
  res: Response,
  workspaceId: unknown,
): Promise<{ config: ServerConfig; workspaceId: string } | null> {
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId);
  if (!auth) return null;
  const config = serverConfigOf(req);
  const denial = await checkKnowledgeBaseModule(config, workspaceId as string);
  if (denial) {
    res.status(403).json(denial);
    return null;
  }
  return { config, workspaceId: workspaceId as string };
}

function workspaceIdOf(req: Request): unknown {
  return (
    (req.query.workspaceId as string | undefined) ??
    (req.query.workspace_id as string | undefined) ??
    (req.body as { workspaceId?: string } | undefined)?.workspaceId
  );
}

/** Confirms a resource belongs to the caller's workspace before mutating it. */
async function assertOwnership(
  config: ServerConfig,
  table: 'knowledge_base_articles' | 'knowledge_base_categories',
  id: string,
  workspaceId: string,
  res: Response,
): Promise<boolean> {
  if (!UUID_RE.test(id)) {
    res.status(400).json({ error: 'invalid_id' });
    return false;
  }
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from(table)
    .select('workspace_id')
    .eq('id', id)
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: 'lookup_failed' });
    return false;
  }
  if (!data || (data as { workspace_id: string }).workspace_id !== workspaceId) {
    res.status(404).json({ error: 'not_found' });
    return false;
  }
  return true;
}

// ─── Articles ───

knowledgeBaseRouter.get('/articles', async (req: Request, res: Response) => {
  const g = await guard(req, res, workspaceIdOf(req));
  if (!g) return;
  const locale = typeof req.query.locale === 'string' ? req.query.locale : undefined;
  const status = typeof req.query.status === 'string' ? req.query.status : undefined;
  const search = typeof req.query.search === 'string' ? req.query.search.slice(0, 200) : undefined;

  let q = getServiceClient(g.config)
    .from('knowledge_base_articles')
    .select('*, knowledge_base_categories(name, slug)')
    .eq('workspace_id', g.workspaceId)
    .order('updated_at', { ascending: false })
    .limit(500);
  if (locale) q = q.eq('locale', locale);
  if (status && status !== 'all') q = q.eq('status', status);
  if (search) q = q.ilike('title', `%${search}%`);

  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'query_failed' });
  return res.json({ articles: data ?? [] });
});

knowledgeBaseRouter.post('/articles', async (req: Request, res: Response) => {
  const g = await guard(req, res, workspaceIdOf(req));
  if (!g) return;
  const parsed = articleInputSchema.safeParse((req.body as { article?: unknown })?.article ?? req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_article' });

  if (parsed.data.category_id) {
    const ok = await assertOwnership(
      g.config, 'knowledge_base_categories', parsed.data.category_id, g.workspaceId, res,
    );
    if (!ok) return;
  }
  const { data, error } = await getServiceClient(g.config)
    .from('knowledge_base_articles')
    .insert({ ...parsed.data, workspace_id: g.workspaceId })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'insert_failed' });
  return res.status(201).json({ article: data });
});

knowledgeBaseRouter.patch('/articles/:articleId', async (req: Request, res: Response) => {
  const g = await guard(req, res, workspaceIdOf(req));
  if (!g) return;
  const articleId = String(req.params.articleId);
  if (!(await assertOwnership(g.config, 'knowledge_base_articles', articleId, g.workspaceId, res))) return;

  const parsed = articlePatchSchema.safeParse((req.body as { article?: unknown })?.article ?? req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_article' });
  if (parsed.data.category_id) {
    const ok = await assertOwnership(
      g.config, 'knowledge_base_categories', parsed.data.category_id, g.workspaceId, res,
    );
    if (!ok) return;
  }
  const { data, error } = await getServiceClient(g.config)
    .from('knowledge_base_articles')
    .update({ ...parsed.data, updated_at: new Date().toISOString() })
    .eq('id', articleId)
    .eq('workspace_id', g.workspaceId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'update_failed' });
  return res.json({ article: data });
});

knowledgeBaseRouter.delete('/articles/:articleId', async (req: Request, res: Response) => {
  const g = await guard(req, res, workspaceIdOf(req));
  if (!g) return;
  const articleId = String(req.params.articleId);
  if (!(await assertOwnership(g.config, 'knowledge_base_articles', articleId, g.workspaceId, res))) return;
  const { error } = await getServiceClient(g.config)
    .from('knowledge_base_articles')
    .delete()
    .eq('id', articleId)
    .eq('workspace_id', g.workspaceId);
  if (error) return res.status(500).json({ error: 'delete_failed' });
  return res.json({ deleted: true, id: articleId });
});

// ─── Categories ───

knowledgeBaseRouter.get('/categories', async (req: Request, res: Response) => {
  const g = await guard(req, res, workspaceIdOf(req));
  if (!g) return;
  const locale = typeof req.query.locale === 'string' ? req.query.locale : undefined;
  let q = getServiceClient(g.config)
    .from('knowledge_base_categories')
    .select('*')
    .eq('workspace_id', g.workspaceId)
    .order('sort_order', { ascending: true })
    .limit(500);
  if (locale) q = q.eq('locale', locale);
  const { data, error } = await q;
  if (error) return res.status(500).json({ error: 'query_failed' });
  return res.json({ categories: data ?? [] });
});

knowledgeBaseRouter.post('/categories', async (req: Request, res: Response) => {
  const g = await guard(req, res, workspaceIdOf(req));
  if (!g) return;
  const parsed = categoryInputSchema.safeParse((req.body as { category?: unknown })?.category ?? req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_category' });
  const { data, error } = await getServiceClient(g.config)
    .from('knowledge_base_categories')
    .insert({ ...parsed.data, workspace_id: g.workspaceId })
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'insert_failed' });
  return res.status(201).json({ category: data });
});

knowledgeBaseRouter.patch('/categories/:categoryId', async (req: Request, res: Response) => {
  const g = await guard(req, res, workspaceIdOf(req));
  if (!g) return;
  const categoryId = String(req.params.categoryId);
  if (!(await assertOwnership(g.config, 'knowledge_base_categories', categoryId, g.workspaceId, res))) return;
  const parsed = categoryPatchSchema.safeParse((req.body as { category?: unknown })?.category ?? req.body);
  if (!parsed.success) return res.status(400).json({ error: 'invalid_category' });
  const { data, error } = await getServiceClient(g.config)
    .from('knowledge_base_categories')
    .update(parsed.data)
    .eq('id', categoryId)
    .eq('workspace_id', g.workspaceId)
    .select()
    .single();
  if (error) return res.status(500).json({ error: 'update_failed' });
  return res.json({ category: data });
});

knowledgeBaseRouter.delete('/categories/:categoryId', async (req: Request, res: Response) => {
  const g = await guard(req, res, workspaceIdOf(req));
  if (!g) return;
  const categoryId = String(req.params.categoryId);
  if (!(await assertOwnership(g.config, 'knowledge_base_categories', categoryId, g.workspaceId, res))) return;
  const { error } = await getServiceClient(g.config)
    .from('knowledge_base_categories')
    .delete()
    .eq('id', categoryId)
    .eq('workspace_id', g.workspaceId);
  if (error) return res.status(500).json({ error: 'delete_failed' });
  return res.json({ deleted: true, id: categoryId });
});

export default knowledgeBaseRouter;
