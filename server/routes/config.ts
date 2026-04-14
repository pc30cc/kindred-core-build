// ============================================
// CONFIG API ROUTES — self-hosted backend
// Single config resolution endpoint + admin CRUD
// ============================================

import { Router } from 'express';
import { createClient } from '@supabase/supabase-js';
import type { ServerConfig } from '../config.js';
import { resolveConfig, invalidateConfigCache } from '../services/config/resolver.js';

export const configRouter = Router();

// ─── Public: Resolve config ─────────────────────────────────

/**
 * GET /api/config/resolve
 * Returns the fully resolved runtime config.
 * Query params: workspaceId, locale
 */
configRouter.get('/resolve', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const workspaceId = req.query.workspaceId as string | undefined;
    const locale = req.query.locale as string | undefined;
    const origin = `${req.protocol}://${req.get('host')}`;

    const resolved = await resolveConfig(config, { workspaceId, locale, origin });
    return res.json(resolved);
  } catch (err: any) {
    console.error('[config] Resolve error:', err);
    return res.status(500).json({ error: 'Failed to resolve config' });
  }
});

// ─── Admin: Platform Settings ───────────────────────────────

configRouter.get('/platform/settings', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { data } = await supabase.from('platform_settings').select('*').limit(1).maybeSingle();
    return res.json({ settings: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

configRouter.put('/platform/settings', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    
    const { data: existing } = await supabase.from('platform_settings').select('id').limit(1).maybeSingle();
    if (!existing) {
      return res.status(404).json({ error: 'No platform settings found' });
    }

    const { error } = await supabase
      .from('platform_settings')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', existing.id);

    if (error) throw error;
    invalidateConfigCache();
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Platform Branding ───────────────────────────────

configRouter.get('/platform/branding', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { data } = await supabase.from('platform_branding').select('*').limit(1).maybeSingle();
    return res.json({ branding: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

configRouter.put('/platform/branding', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { data: existing } = await supabase.from('platform_branding').select('id').limit(1).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const { error } = await supabase.from('platform_branding')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) throw error;
    invalidateConfigCache();
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Platform Branding Localized ─────────────────────

configRouter.get('/platform/branding-localized', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { data } = await supabase.from('platform_branding_localized').select('*').order('locale');
    return res.json({ items: data || [] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

configRouter.put('/platform/branding-localized/:locale', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const locale = req.params.locale;

    const { data: existing } = await supabase.from('platform_branding_localized')
      .select('id').eq('locale', locale).maybeSingle();

    if (existing) {
      await supabase.from('platform_branding_localized')
        .update({ ...req.body, locale, updated_at: new Date().toISOString() })
        .eq('id', existing.id);
    } else {
      await supabase.from('platform_branding_localized')
        .insert({ ...req.body, locale });
    }

    invalidateConfigCache();
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Platform Domains ────────────────────────────────

configRouter.get('/platform/domains', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { data } = await supabase.from('platform_domains').select('*').limit(1).maybeSingle();
    return res.json({ domains: data });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

configRouter.put('/platform/domains', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { data: existing } = await supabase.from('platform_domains').select('id').limit(1).maybeSingle();
    if (!existing) return res.status(404).json({ error: 'Not found' });

    const { error } = await supabase.from('platform_domains')
      .update({ ...req.body, updated_at: new Date().toISOString() })
      .eq('id', existing.id);
    if (error) throw error;
    invalidateConfigCache();
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

// ─── Admin: Email Settings ──────────────────────────────────

configRouter.get('/platform/email-settings', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { data: settings } = await supabase.from('email_settings').select('*').is('workspace_id', null).maybeSingle();
    const { data: localized } = await supabase.from('email_settings_localized').select('*').is('workspace_id', null).order('locale');
    return res.json({ settings, localized: localized || [] });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});

configRouter.put('/platform/email-settings', async (req, res) => {
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const supabase = createClient(config.supabaseUrl, config.supabaseServiceRoleKey);
    const { settings, localized } = req.body;

    if (settings) {
      const { data: existing } = await supabase.from('email_settings').select('id').is('workspace_id', null).maybeSingle();
      if (existing) {
        await supabase.from('email_settings').update({ ...settings, updated_at: new Date().toISOString() }).eq('id', existing.id);
      }
    }

    if (localized && Array.isArray(localized)) {
      for (const loc of localized) {
        const { data: existing } = await supabase.from('email_settings_localized')
          .select('id').is('workspace_id', null).eq('locale', loc.locale).maybeSingle();
        if (existing) {
          await supabase.from('email_settings_localized')
            .update({ ...loc, updated_at: new Date().toISOString() }).eq('id', existing.id);
        } else {
          await supabase.from('email_settings_localized').insert({ ...loc, workspace_id: null });
        }
      }
    }

    invalidateConfigCache();
    return res.json({ success: true });
  } catch (err: any) {
    return res.status(500).json({ error: err.message });
  }
});
