// ============================================
// ADMIN EMAIL TEMPLATE MANAGEMENT — self-hosted backend
// CRUD for email_templates table. Single source of truth.
// ============================================

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../config.js';

export const templatesRouter = Router();

/**
 * Middleware: verify caller is authenticated admin.
 */
async function requireAdmin(req: any, res: any, next: any) {
  const config: ServerConfig = req.serverConfig;
  const supabaseAdmin = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
  const authHeader = req.headers.authorization;
  if (!authHeader) return res.status(401).json({ error: 'No authorization header' });

  const callerClient = createClient(config.supabaseUrl, config.supabaseAnonKey, {
    global: { headers: { Authorization: authHeader } },
  });
  const { data: { user: caller } } = await callerClient.auth.getUser();
  if (!caller) return res.status(401).json({ error: 'Not authenticated' });

  const { data: hasAdmin } = await supabaseAdmin.rpc('has_role', {
    _user_id: caller.id,
    _role: 'admin',
  });
  if (!hasAdmin) return res.status(403).json({ error: 'Insufficient permissions' });

  req.supabaseAdmin = supabaseAdmin;
  next();
}

templatesRouter.use(requireAdmin);

// ─── List all templates ─────────────────────────────────────────
templatesRouter.get('/list', async (req, res) => {
  try {
    const admin = (req as any).supabaseAdmin;
    const { data, error } = await admin
      .from('email_templates')
      .select('*')
      .order('slug');
    if (error) throw error;
    res.json({ templates: data });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Save/upsert a template ────────────────────────────────────
templatesRouter.post('/save', async (req, res) => {
  try {
    const { slug, locale, subject, htmlBody, textBody, workspaceId, enabled } = req.body;
    if (!slug || !locale || !subject) {
      return res.status(400).json({ error: 'slug, locale, and subject are required' });
    }

    const admin = (req as any).supabaseAdmin;
    const wsId = workspaceId || '00000000-0000-0000-0000-000000000000'; // global templates use a sentinel

    // Check if exists
    const { data: existing } = await admin
      .from('email_templates')
      .select('id')
      .eq('slug', slug)
      .eq('locale', locale)
      .eq('workspace_id', wsId)
      .maybeSingle();

    if (existing) {
      const { error } = await admin
        .from('email_templates')
        .update({
          subject,
          html_body: htmlBody || '',
          text_body: textBody || null,
        })
        .eq('id', existing.id);
      if (error) throw error;
    } else {
      const { error } = await admin
        .from('email_templates')
        .insert({
          slug,
          locale,
          subject,
          html_body: htmlBody || '',
          text_body: textBody || null,
          workspace_id: wsId,
        });
      if (error) throw error;
    }

    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Delete a template ──────────────────────────────────────────
templatesRouter.post('/delete', async (req, res) => {
  try {
    const { id } = req.body;
    if (!id) return res.status(400).json({ error: 'id is required' });
    const admin = (req as any).supabaseAdmin;
    const { error } = await admin.from('email_templates').delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// ─── Get single template by slug + locale ───────────────────────
templatesRouter.get('/get', async (req, res) => {
  try {
    const { slug, locale, workspaceId } = req.query as any;
    if (!slug) return res.status(400).json({ error: 'slug is required' });

    const admin = (req as any).supabaseAdmin;
    const wsId = workspaceId || '00000000-0000-0000-0000-000000000000';
    const loc = locale || 'en';

    const { data, error } = await admin
      .from('email_templates')
      .select('*')
      .eq('slug', slug)
      .eq('locale', loc)
      .eq('workspace_id', wsId)
      .maybeSingle();
    if (error) throw error;
    res.json({ template: data });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});
