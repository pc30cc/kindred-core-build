/**
 * Workspace Smart Engagement — server-side publish boundary.
 *
 * Publishing (draft -> live visitor payload) must happen here, not from the
 * browser: the server re-validates the full rule with the shared Zod schema,
 * rejects unsafe URLs / incomplete config / unknown schema versions, and is
 * the only writer of `published_version` and the `published_*` snapshot
 * columns that `loadPublicSmartRules` serves to visitors.
 */
import { Router } from 'express';
import type { ServerConfig } from '../config.js';
import { getServiceClient } from '../supabase.js';
import { authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';
import {
  validateSmartRuleForPublish,
  SMART_SNAPSHOT_CONFIG_KEYS,
} from '../../src/lib/widget/smartRules.js';

export const workspaceSmartRulesRouter = Router();

const SELECT = 'id, workspace_id, name, description, status, priority, schema_version, published_version, '
  + 'trigger_config, audience_config, content_config, presentation_config, schedule_config, '
  + 'frequency_config, behavior_config, created_at, updated_at, published_at';

async function loadRule(sb: any, workspaceId: string, ruleId: string) {
  const { data, error } = await sb
    .from('widget_smart_rules')
    .select(SELECT)
    .eq('id', ruleId)
    .eq('workspace_id', workspaceId)
    .maybeSingle();
  if (error) throw error;
  return data;
}

// POST /api/workspaces/:workspaceId/smart-rules/:ruleId/publish
workspaceSmartRulesRouter.post('/:workspaceId/smart-rules/:ruleId/publish', async (req, res) => {
  const { workspaceId, ruleId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const rule = await loadRule(sb, workspaceId, ruleId);
    if (!rule) return res.status(404).json({ error: 'not_found' });

    const issues = validateSmartRuleForPublish({ ...rule, status: 'active' });
    if (issues.length) return res.status(400).json({ error: 'validation_failed', issues });

    const patch: Record<string, unknown> = {
      status: 'active',
      published_version: (Number(rule.published_version) || 0) + 1,
      published_at: new Date().toISOString(),
      published_priority: rule.priority,
      published_schema_version: rule.schema_version,
    };
    for (const key of SMART_SNAPSHOT_CONFIG_KEYS) {
      patch[`published_${key}`] = (rule as any)[key];
    }

    const { data, error } = await sb
      .from('widget_smart_rules')
      .update(patch)
      .eq('id', ruleId)
      .eq('workspace_id', workspaceId)
      .select(SELECT)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rule: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});

// POST /api/workspaces/:workspaceId/smart-rules/:ruleId/unpublish
workspaceSmartRulesRouter.post('/:workspaceId/smart-rules/:ruleId/unpublish', async (req, res) => {
  const { workspaceId, ruleId } = req.params;
  const auth = await authorizeWorkspaceAccess(req, res, workspaceId, { manage: true });
  if (!auth) return;
  try {
    const config: ServerConfig = (req as any).serverConfig;
    const sb = getServiceClient(config);
    const rule = await loadRule(sb, workspaceId, ruleId);
    if (!rule) return res.status(404).json({ error: 'not_found' });

    // Snapshot stays intact — unpublishing only stops new visitor delivery.
    const { data, error } = await sb
      .from('widget_smart_rules')
      .update({ status: 'paused' })
      .eq('id', ruleId)
      .eq('workspace_id', workspaceId)
      .select(SELECT)
      .single();
    if (error) return res.status(500).json({ error: error.message });
    res.json({ rule: data });
  } catch (err: any) {
    res.status(500).json({ error: err?.message || 'internal_error' });
  }
});
