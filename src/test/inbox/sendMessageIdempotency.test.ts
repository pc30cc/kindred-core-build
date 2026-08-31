import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Split Send hardening — contract tests over the real send path.
 *
 * The route itself needs a live Express + Supabase stack, so these assert the
 * structural guarantees that the audit fixed, at the exact places they must
 * hold. Behavioural coverage of the transition lives in postSendAction.test.ts.
 */

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

const route = read('server/routes/conversations.ts');
const outbound = read('server/services/channels/outbound.ts');
const migration = read('database/migrations/070_post_send_action_guards.sql');

describe('POST /send-message — duplicate protection', () => {
  it('accepts a client_message_id idempotency key', () => {
    expect(route).toContain('client_message_id: z.string()');
  });

  it('looks up an existing message with the same key before inserting', () => {
    expect(route).toMatch(/filter\('metadata->>client_message_id', 'eq', clientMessageId\)/);
  });

  it('recovers from a lost insert race via the unique index (23505)', () => {
    expect(route).toMatch(/duplicate key\|23505/);
  });

  it('a replay does not re-publish realtime, re-dispatch or re-attach', () => {
    expect(route).toContain("? { ok: false, reason: 'duplicate_request' as string | null }");
    expect(route).toContain("const dispatch = duplicate");
    expect(route).toContain('if (!duplicate && parsed.data.attachment_id && inserted?.id)');
  });

  it('migration 070 enforces one message per client_message_id in the DB', () => {
    expect(migration).toContain('CREATE UNIQUE INDEX IF NOT EXISTS idx_conversation_messages_client_message_id');
    expect(migration).toContain("(metadata->>'client_message_id')");
  });
});

describe('POST /send-message — delivery success boundary', () => {
  it('awaits the outbound dispatch instead of firing and forgetting', () => {
    expect(route).toContain('await dispatchOutboundIfChannelConversation(config, {');
    expect(route).not.toContain('void dispatchOutboundIfChannelConversation');
  });

  it('reports acceptance so the post-send action can be gated on it', () => {
    expect(outbound).toContain('Promise<{ accepted: boolean; result: OutboundIntentResult | \'failed\' }>');
    expect(outbound).toContain("return { accepted: false, result: 'failed' }");
  });

  it('passes deliveryAccepted into the post-send action', () => {
    expect(route).toContain('deliveryAccepted: dispatch.accepted');
  });
});

describe('migration 070 — race-safe transition', () => {
  it('locks the conversation row', () => {
    expect(migration).toContain('FOR UPDATE');
  });

  it('refuses when a newer inbound customer message exists', () => {
    expect(migration).toContain("m.sender_type = 'contact'");
    expect(migration).toContain("(m.created_at, m.id) > (v_after_created, p_after_message_id)");
    expect(migration).toContain("'customer_replied'");
  });

  it('is service-role only', () => {
    expect(migration).toContain('GRANT EXECUTE ON FUNCTION public.conversation_apply_post_send_action(uuid, uuid, text, text[], uuid) TO service_role');
    expect(migration).toMatch(/REVOKE ALL ON FUNCTION[\s\S]*FROM anon, authenticated/);
  });
});
