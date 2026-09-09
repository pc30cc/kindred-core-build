/**
 * BRAND RADAR — AI Visibility.
 *
 * Asks the workspace's already-configured AI provider (executeAICompletion
 * — the exact same billed path AI Assistant/KB Builder/Operator Assist use)
 * a neutral question for each tracked topic, then checks whether the real
 * response text mentions the brand and/or any tracked competitor. Nothing
 * is simulated: brand_mentioned / competitors_mentioned / the stored
 * response are read straight off the model's actual answer.
 *
 * Deliberately does NOT tell the model it is being brand-monitored, and
 * does not mention the tracked brand in the prompt — that would bias the
 * very thing being measured.
 */
import type { ServerConfig } from '../../config.js';
import { getServiceClient } from '../../supabase.js';
import { executeAICompletion } from '../ai/index.js';
import { textMentionsName, computeMentionPosition, mentionedCompetitors } from './mentionDetection.js';
import type { BrandRadarSettings, BrandRadarTopic } from './settingsService.js';

const SYSTEM_PROMPT =
  'You are a helpful, knowledgeable assistant answering a user\'s question. ' +
  'Give a natural, informative answer as you normally would. When relevant, ' +
  'recommend specific real products, tools, brands, or companies by name ' +
  'rather than only generic advice.';

export interface AiVisibilityCheckResult {
  id: string;
  topicId: string | null;
  topicLabel: string;
  prompt: string;
  provider: string;
  model: string;
  responseText: string;
  brandMentioned: boolean;
  brandMentionPosition: number | null;
  competitorsMentioned: string[];
  createdAt: string;
}

export async function runAiVisibilityCheck(
  config: ServerConfig,
  args: { workspaceId: string; topic: BrandRadarTopic; settings: BrandRadarSettings; userId: string },
): Promise<AiVisibilityCheckResult> {
  const response = await executeAICompletion(config, {
    workspaceId: args.workspaceId,
    prompt: args.topic.prompt,
    systemPrompt: SYSTEM_PROMPT,
    maxTokens: 600,
    temperature: 0.4,
    billing: { entryPoint: 'brand_radar_ai_visibility', operationKey: `brand_radar_ai_visibility:${args.topic.id}:${Date.now()}` },
  });

  const brandMentioned = textMentionsName(response.text, args.settings.brandName);
  const brandMentionPosition = computeMentionPosition(response.text, args.settings.brandName, args.settings.competitorNames);
  const competitorsMentioned = mentionedCompetitors(response.text, args.settings.competitorNames);

  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('brand_radar_ai_checks')
    .insert({
      workspace_id: args.workspaceId,
      topic_id: args.topic.id,
      topic_label: args.topic.label,
      prompt: args.topic.prompt,
      provider: response.provider,
      model: response.model,
      response_text: response.text,
      brand_mentioned: brandMentioned,
      brand_mention_position: brandMentionPosition,
      competitors_mentioned: competitorsMentioned,
      checked_by: args.userId,
    })
    .select('*')
    .single();
  if (error || !data) throw new Error(`brand_radar_ai_check_save_failed: ${error?.message}`);

  return {
    id: data.id,
    topicId: data.topic_id,
    topicLabel: data.topic_label,
    prompt: data.prompt,
    provider: data.provider,
    model: data.model,
    responseText: data.response_text,
    brandMentioned: data.brand_mentioned,
    brandMentionPosition: data.brand_mention_position,
    competitorsMentioned: data.competitors_mentioned || [],
    createdAt: data.created_at,
  };
}

export async function runAllTopicsAiVisibility(
  config: ServerConfig,
  args: { workspaceId: string; topics: BrandRadarTopic[]; settings: BrandRadarSettings; userId: string },
): Promise<{ results: AiVisibilityCheckResult[]; errors: Array<{ topicId: string; message: string }> }> {
  const results: AiVisibilityCheckResult[] = [];
  const errors: Array<{ topicId: string; message: string }> = [];
  // Sequential, not parallel — these are billed provider calls; running them
  // one at a time keeps a single slow/failing topic from fanning out into a
  // burst of concurrent charges.
  for (const topic of args.topics) {
    try {
      results.push(await runAiVisibilityCheck(config, { workspaceId: args.workspaceId, topic, settings: args.settings, userId: args.userId }));
    } catch (err: any) {
      errors.push({ topicId: topic.id, message: err?.message || 'unknown_error' });
    }
  }
  return { results, errors };
}

function toResult(row: Record<string, any>): AiVisibilityCheckResult {
  return {
    id: row.id,
    topicId: row.topic_id,
    topicLabel: row.topic_label,
    prompt: row.prompt,
    provider: row.provider,
    model: row.model,
    responseText: row.response_text,
    brandMentioned: row.brand_mentioned,
    brandMentionPosition: row.brand_mention_position,
    competitorsMentioned: row.competitors_mentioned || [],
    createdAt: row.created_at,
  };
}

/** Most recent check per currently-defined topic (the "current AI visibility state"). */
export async function getLatestAiChecksByTopic(config: ServerConfig, workspaceId: string): Promise<AiVisibilityCheckResult[]> {
  const sb = getServiceClient(config);
  const { data, error } = await sb
    .from('brand_radar_ai_checks')
    .select('*')
    .eq('workspace_id', workspaceId)
    .order('created_at', { ascending: false })
    .limit(500);
  if (error) throw new Error(`brand_radar_ai_checks_read_failed: ${error.message}`);
  const rows = (data || []) as Record<string, any>[];
  const latestByTopic = new Map<string, Record<string, any>>();
  for (const row of rows) {
    const key = row.topic_id || row.id;
    if (!latestByTopic.has(key)) latestByTopic.set(key, row);
  }
  return Array.from(latestByTopic.values()).map(toResult);
}

export async function getAiCheckHistory(config: ServerConfig, workspaceId: string, topicId?: string): Promise<AiVisibilityCheckResult[]> {
  const sb = getServiceClient(config);
  let query = sb.from('brand_radar_ai_checks').select('*').eq('workspace_id', workspaceId).order('created_at', { ascending: false }).limit(100);
  if (topicId) query = query.eq('topic_id', topicId);
  const { data, error } = await query;
  if (error) throw new Error(`brand_radar_ai_checks_read_failed: ${error.message}`);
  return (data || []).map(toResult);
}
