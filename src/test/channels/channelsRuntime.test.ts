/**
 * Channels runtime guardrails.
 *
 * These assertions encode the delivery contract we must not regress:
 *  - the Gateway acknowledges only PERMANENT failures (everything else must
 *    be retried by the provider, otherwise messages are silently lost);
 *  - the Channels Worker never writes canonical business tables.
 */

import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { classifyCoreResponse } from '../../../channels/delivery.js';

describe('gateway delivery classification', () => {
  it('acknowledges successful ingest', () => {
    expect(classifyCoreResponse(202, null)).toBe('ack');
    expect(classifyCoreResponse(200, null)).toBe('ack');
  });

  it('retries every server-side failure', () => {
    for (const status of [500, 502, 503, 504]) {
      expect(classifyCoreResponse(status, null)).toBe('retry');
    }
  });

  it('retries our own auth/config breakage instead of dropping the update', () => {
    expect(classifyCoreResponse(401, null)).toBe('retry');
    expect(classifyCoreResponse(403, null)).toBe('retry');
    expect(classifyCoreResponse(404, null)).toBe('retry');
    expect(classifyCoreResponse(400, 'some_new_unclassified_error')).toBe('retry');
  });

  it('acknowledges only explicitly permanent conditions', () => {
    expect(classifyCoreResponse(404, 'unknown_integration')).toBe('ack');
    expect(classifyCoreResponse(410, 'integration_disconnected')).toBe('ack');
    expect(classifyCoreResponse(400, 'invalid_payload')).toBe('ack');
  });
});

describe('worker boundary', () => {
  const workerSource = readFileSync(resolve(process.cwd(), 'worker/channels/index.ts'), 'utf8');
  const inboundSource = readFileSync(
    resolve(process.cwd(), 'server/services/channels/inboundProcessing.ts'),
    'utf8',
  );
  const outboundSource = readFileSync(
    resolve(process.cwd(), 'server/services/channels/outbound.ts'),
    'utf8',
  );
  const aiResponderSource = readFileSync(
    resolve(process.cwd(), 'server/services/ai-agent/responder.ts'),
    'utf8',
  );
  const outboundMigrationSource = readFileSync(
    resolve(process.cwd(), 'database/migrations/051_fix_channel_ai_outbox.sql'),
    'utf8',
  );
  const telegramRuntimeSource = readFileSync(
    resolve(process.cwd(), 'server/services/channels/telegram/runtime.ts'),
    'utf8',
  );
  const chatRoutingSource = readFileSync(
    resolve(process.cwd(), 'server/services/chatRouting.ts'),
    'utf8',
  );
  const providerOperationsSource = readFileSync(
    resolve(process.cwd(), 'worker/channels/providerOperations.ts'),
    'utf8',
  );
  const telegramOfflineDeliverySource = readFileSync(
    resolve(process.cwd(), 'server/services/channels/telegram/offlineDelivery.ts'),
    'utf8',
  );
  const aiResponderSourceForOffline = readFileSync(
    resolve(process.cwd(), 'server/services/ai-agent/responder.ts'),
    'utf8',
  );

  it('never writes canonical business tables', () => {
    const canonicalTables = ['contacts', 'conversations', 'conversation_messages', 'contact_channels'];
    for (const table of canonicalTables) {
      expect(workerSource).not.toContain(`.from('${table}')`);
    }
  });

  it('only touches channel runtime tables directly', () => {
    const allowed = new Set(['channel_integrations', 'plugin_secrets', 'channel_worker_heartbeats']);
    const used = [...workerSource.matchAll(/\.from\('([a-z_]+)'\)/g)].map((m) => m[1]);
    for (const table of used) expect(allowed).toContain(table);
  });

  it('reports delivery outcomes through Core, not by direct message updates', () => {
    expect(workerSource).toContain('/internal/channels/outbound-result');
  });

  it('keeps the conversation insert aligned with the deployed schema', () => {
    const conversationInsert = inboundSource.match(
      /\.from\('conversations'\)\s*\.insert\(\{([\s\S]*?)\}\)\s*\.select/,
    )?.[1] ?? '';
    expect(conversationInsert).not.toContain('\n      channel: input.provider,');
    expect(conversationInsert).toContain('metadata:');
  });

  it('does not acknowledge conversation creation failures as ignored', () => {
    expect(inboundSource).not.toContain("last_error: 'conversation_creation_failed'");
    expect(inboundSource).toContain('throw new Error(`conversation creation failed:');
  });

  it('does not query the removed conversations.channel column', () => {
    expect(outboundSource).not.toContain(".select('metadata, channel')");
    expect(outboundSource).toContain(".select('metadata')");
  });

  it('reconciles AI replies with the channel outbox', () => {
    expect(aiResponderSource).toContain('await ensureOutboundIntent(config, {');
    expect(aiResponderSource).toContain('messageId: row.id');
  });

  it('enqueues agent, bot, and AI replies from conversation metadata', () => {
    expect(outboundMigrationSource).toContain("NOT IN ('agent', 'bot', 'ai')");
    expect(outboundMigrationSource).toContain("COALESCE(c_metadata->>'channel', '') <> 'telegram'");
    expect(outboundMigrationSource).not.toMatch(/SELECT\s+workspace_id,\s*channel,/);
  });

  it('delivers routing system notices to channel visitors explicitly', () => {
    expect(chatRoutingSource).toContain('await dispatchOutboundIfChannelConversation(config, {');
    expect(chatRoutingSource).toContain("{ kind: 'routing_no_agent_available' }");
    expect(chatRoutingSource).toContain('!alreadyShownInChannel,');
  });

  it('never sends the offline notice twice to a Telegram visitor', () => {
    expect(chatRoutingSource).toContain('telegramOfflineScreenJustSent');
    expect(chatRoutingSource).toContain('telegram_offline_notice_at');
    expect(chatRoutingSource).toContain('maybeQueueTelegramOfflineScreen');
    expect(telegramOfflineDeliverySource).toContain('if (Date.now() - lastAt < cooldown) return true;');
  });

  it('does not erase an offline-screen claim with stale routing metadata', () => {
    expect(chatRoutingSource).toContain(".select('metadata')");
    expect(chatRoutingSource).toContain('...latestMetadata');
  });

  it('claims the Telegram offline screen before enqueueing it', () => {
    expect(telegramOfflineDeliverySource).toContain(".eq('metadata', metadata)");
    expect(telegramOfflineDeliverySource).toContain('telegram_offline_notice_claim: claimId');
    expect(telegramOfflineDeliverySource.indexOf(".update({ metadata: nextMetadata })"))
      .toBeLessThan(telegramOfflineDeliverySource.indexOf('await enqueueProviderActions'));
  });

  it('applies the offline keyboard immediately without a typing delay', () => {
    expect(telegramOfflineDeliverySource).toContain('replyMarkup: screen.replyMarkup');
    expect(telegramOfflineDeliverySource).toContain('typing: false');
  });

  it('suppresses the plain AI handoff delivery after the Telegram screen wins', () => {
    expect(aiResponderSourceForOffline).toContain('offlineScreenQueued');
    expect(aiResponderSourceForOffline).toContain("channel_delivery_skip: 'true'");
    expect(aiResponderSourceForOffline).toContain('if (!offlineScreenQueued)');
    expect(aiResponderSourceForOffline).toContain('resolvedVisitorBody: input.body');
    expect(telegramOfflineDeliverySource).toContain('bodyConfirmsOffline');
  });

  it('treats a handed-off Telegram conversation as having no AI responder', () => {
    expect(telegramRuntimeSource).toContain("aiState === 'needs_human'");
    expect(telegramRuntimeSource).toContain("const aiAllowed = mode === 'ai_first' && !waitingForHuman;");
  });

  it('retries failed Telegram screen delivery instead of acknowledging it', () => {
    expect(providerOperationsSource).toContain("if (kind === 'answer_callback')");
    expect(providerOperationsSource).toContain('throw err;');
  });
});
