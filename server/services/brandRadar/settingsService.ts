/**
 * BRAND RADAR — settings (brand name, tracked competitors, target site) and
 * tracked AI-visibility topics.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';

const MAX_BRAND_NAME_LEN = 100;
const MAX_COMPETITOR_NAME_LEN = 100;
const MAX_TOPIC_LABEL_LEN = 120;
const MAX_TOPIC_PROMPT_LEN = 500;

export class BrandRadarValidationError extends Error {
  reason: 'brand_name_required' | 'too_many_competitors' | 'competitor_name_too_long' | 'invalid_site' | 'topic_limit_reached' | 'invalid_topic' | 'not_found';
  constructor(reason: BrandRadarValidationError['reason']) {
    super(reason);
    this.reason = reason;
  }
}

export interface BrandRadarSettings {
  id: string;
  workspaceId: string;
  brandName: string;
  competitorNames: string[];
  siteId: string | null;
  createdAt: string;
  updatedAt: string;
}

function toSettings(row: Record<string, any>): BrandRadarSettings {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    brandName: row.brand_name,
    competitorNames: row.competitor_names || [],
    siteId: row.site_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getSettings(config: ServerConfig, workspaceId: string): Promise<BrandRadarSettings | null> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('brand_radar_settings').select('*').eq('workspace_id', workspaceId).maybeSingle();
  if (error) throw new Error(`brand_radar_settings_read_failed: ${error.message}`);
  return data ? toSettings(data) : null;
}

export async function upsertSettings(
  config: ServerConfig,
  args: { workspaceId: string; brandName: string; competitorNames: string[]; siteId: string | null; maxCompetitors: number },
): Promise<BrandRadarSettings> {
  const brandName = args.brandName.trim().slice(0, MAX_BRAND_NAME_LEN);
  if (!brandName) throw new BrandRadarValidationError('brand_name_required');

  const competitorNames = Array.from(new Set(
    args.competitorNames.map((c) => c.trim()).filter((c) => c.length > 0),
  ));
  if (competitorNames.length > args.maxCompetitors) throw new BrandRadarValidationError('too_many_competitors');
  if (competitorNames.some((c) => c.length > MAX_COMPETITOR_NAME_LEN)) throw new BrandRadarValidationError('competitor_name_too_long');

  if (args.siteId) {
    const sb = getServiceClient(config);
    const { data: site } = await sb.from('workspace_domains').select('id').eq('workspace_id', args.workspaceId).eq('id', args.siteId).maybeSingle();
    if (!site) throw new BrandRadarValidationError('invalid_site');
  }

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('brand_radar_settings')
    .upsert({
      workspace_id: args.workspaceId,
      brand_name: brandName,
      competitor_names: competitorNames,
      site_id: args.siteId,
    }, { onConflict: 'workspace_id' })
    .select('*')
    .single();
  if (error || !data) throw new Error(`brand_radar_settings_save_failed: ${error?.message}`);
  return toSettings(data);
}

export interface BrandRadarTopic {
  id: string;
  workspaceId: string;
  label: string;
  prompt: string;
  createdAt: string;
}

function toTopic(row: Record<string, any>): BrandRadarTopic {
  return { id: row.id, workspaceId: row.workspace_id, label: row.label, prompt: row.prompt, createdAt: row.created_at };
}

export async function listTopics(config: ServerConfig, workspaceId: string): Promise<BrandRadarTopic[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb.from('brand_radar_topics').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: true });
  if (error) throw new Error(`brand_radar_topics_read_failed: ${error.message}`);
  return (data || []).map(toTopic);
}

export async function createTopic(
  config: ServerConfig,
  args: { workspaceId: string; label: string; prompt: string; userId: string; maxTopics: number },
): Promise<BrandRadarTopic> {
  const label = args.label.trim().slice(0, MAX_TOPIC_LABEL_LEN);
  const prompt = args.prompt.trim().slice(0, MAX_TOPIC_PROMPT_LEN);
  if (!label || !prompt) throw new BrandRadarValidationError('invalid_topic');

  const sb = getServiceClient(config);
  const { count } = await sb.from('brand_radar_topics').select('id', { count: 'exact', head: true }).eq('workspace_id', args.workspaceId);
  if ((count || 0) >= args.maxTopics) throw new BrandRadarValidationError('topic_limit_reached');

  const { data, error } = await sb
    .from('brand_radar_topics')
    .insert({ workspace_id: args.workspaceId, label, prompt, created_by: args.userId })
    .select('*')
    .single();
  if (error || !data) throw new Error(`brand_radar_topic_create_failed: ${error?.message}`);
  return toTopic(data);
}

export async function deleteTopic(config: ServerConfig, workspaceId: string, topicId: string): Promise<void> {
  const sb = getServiceClient(config);
  await sb.from('brand_radar_topics').delete().eq('workspace_id', workspaceId).eq('id', topicId);
}
