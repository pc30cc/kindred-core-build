/**
 * Admin Widget Templates
 *
 *   GET  /api/admin/widget/templates          → list all registered templates
 *   PATCH /api/admin/widget/templates/:id     → update enabled / sort_order / status
 *
 * Mounted under /api/admin (admin auth handled by parent router).
 */

import { Router } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { listWidgetTemplates, DEFAULT_TEMPLATE_SLUG } from '../services/widget/templates.js';

export const adminWidgetTemplatesRouter = Router();

adminWidgetTemplatesRouter.get('/', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  try {
    const templates = await listWidgetTemplates(sb);
    res.json({ templates });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'Failed to list widget templates' });
  }
});

const updateSchema = z.object({
  enabled: z.boolean().optional(),
  status: z.enum(['active', 'beta', 'deprecated', 'hidden']).optional(),
  sort_order: z.number().int().min(0).max(10_000).optional(),
  name: z.string().min(1).max(120).optional(),
  description: z.string().max(2000).nullable().optional(),
});

adminWidgetTemplatesRouter.patch('/:id', async (req, res) => {
  const config: ServerConfig = (req as any).serverConfig;
  const sb = getServiceClient(config);
  const id = String(req.params.id || '');
  if (!id) return res.status(400).json({ error: 'Template id required' });

  const parsed = updateSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid payload', issues: parsed.error.format() });
  }

  // Guard: never let an admin disable the built-in default template — the
  // runtime relies on it as the safe fallback. If they try, we silently
  // ignore the `enabled=false` for that row but still allow other edits.
  if (parsed.data.enabled === false) {
    const { data: row } = await sb
      .from('widget_templates')
      .select('slug, is_builtin')
      .eq('id', id)
      .maybeSingle();
    if (row && (row.is_builtin || row.slug === DEFAULT_TEMPLATE_SLUG)) {
      return res.status(400).json({
        error: 'The built-in default template cannot be disabled — it is the runtime fallback.',
      });
    }
  }

  const { data, error } = await sb
    .from('widget_templates')
    .update(parsed.data)
    .eq('id', id)
    .select('*')
    .single();

  if (error) return res.status(400).json({ error: error.message });
  res.json({ template: data });
});