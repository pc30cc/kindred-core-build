/**
 * Unguessable Supabase Realtime broadcast topics.
 *
 * WHY THIS EXISTS
 *   Supabase Broadcast channels are joined with the public anon key and this
 *   product does not use Supabase Auth (first-party cookie auth instead), so
 *   there is no RLS on `realtime.messages` to gate a `private: true` channel.
 *   On a public channel the topic name IS the access boundary. The canonical
 *   channel names (`ws:<workspace>:inbox`, `ws:<workspace>:conv:<id>`, …) are
 *   built from ids that are public or easy to learn, so broadcasting on them
 *   verbatim let anyone holding the anon key read every workspace's live
 *   traffic and inject fake broadcasts.
 *
 * WHAT THIS DOES
 *   The Supabase transport never uses a canonical name as a topic. It uses
 *
 *     <canonical>:<base64url(HMAC-SHA256(secret, "v1|<audience>|<canonical>"))[0..32]>
 *
 *   (192 bits of MAC). The secret lives only on the server, so a topic can be
 *   learned exclusively from the server, and the server hands topics out only
 *   through the already-authenticated realtime endpoints:
 *     • operators — /api/realtime/operator-*-subscribe, after the first-party
 *       session + workspace-membership check;
 *     • visitors  — /api/realtime/subscribe, after the widget-session check
 *       AND a conversation-ownership check against the signed `dvsid` cookie.
 *
 *   `audience` separates the visitor-facing copy of a conversation channel
 *   from the operator-facing copy: a visitor who knows its own conversation
 *   topic cannot inject forged broadcasts into what operators receive, and
 *   operator-only channels (inbox / visitors / operators / queues) are never
 *   derived for the visitor audience at all.
 *
 * SECRET
 *   `REALTIME_CHANNEL_SECRET` (≥ 32 chars) when set. Otherwise a key derived,
 *   with domain separation, from `SUPABASE_SERVICE_ROLE_KEY` — the Supabase
 *   publisher cannot work without that key anyway. With neither available
 *   (or a too-short dedicated secret) derivation FAILS CLOSED: nothing is
 *   published and no topic is handed out, so realtime degrades to polling
 *   rather than falling back to a guessable public channel.
 *
 *   Rotating the secret changes every topic. Connected clients keep their
 *   old topic until they re-subscribe (reload / reconnect), during which time
 *   polling keeps the UI correct.
 *
 * Centrifugo is unaffected: it authorizes every subscription with a
 * server-minted token and keeps using the canonical channel names.
 */

import crypto from 'node:crypto';

export type RealtimeTopicAudience = 'operator' | 'visitor';

/** Minimum length accepted for a dedicated REALTIME_CHANNEL_SECRET. */
export const REALTIME_CHANNEL_SECRET_MIN_LENGTH = 32;

/** Characters of base64url MAC appended to the canonical name (192 bits). */
const TOPIC_MAC_LENGTH = 32;

const CONVERSATION_CHANNEL_RE = /^ws:[^:]+:conv:[A-Za-z0-9_-]{1,128}$/;

export class RealtimeChannelSecretUnavailableError extends Error {
  constructor(reason: string) {
    super(`realtime_channel_secret_unavailable: ${reason}`);
    this.name = 'RealtimeChannelSecretUnavailableError';
  }
}

type SecretResolution =
  | { ok: true; key: Buffer; source: 'dedicated' | 'derived' }
  | { ok: false; reason: string };

let warnedReason: string | null = null;

/**
 * Resolve the topic-derivation key from the environment. Never throws;
 * returns `{ ok: false, reason }` when no acceptable secret exists.
 */
export function resolveRealtimeChannelKey(env: NodeJS.ProcessEnv = process.env): SecretResolution {
  const dedicated = env.REALTIME_CHANNEL_SECRET;
  if (typeof dedicated === 'string' && dedicated.length > 0) {
    if (dedicated.length < REALTIME_CHANNEL_SECRET_MIN_LENGTH) {
      // Misconfiguration must not silently downgrade to the fallback: the
      // operator explicitly chose a secret, and it is too weak to use.
      return { ok: false, reason: 'REALTIME_CHANNEL_SECRET shorter than 32 characters' };
    }
    return {
      ok: true,
      key: crypto.createHash('sha256').update(`realtime-channel-topic:v1:${dedicated}`).digest(),
      source: 'dedicated',
    };
  }
  const serviceRole = env.SUPABASE_SERVICE_ROLE_KEY;
  if (typeof serviceRole === 'string' && serviceRole.length > 0) {
    return {
      ok: true,
      key: crypto.createHmac('sha256', serviceRole).update('realtime-channel-topic:v1').digest(),
      source: 'derived',
    };
  }
  return { ok: false, reason: 'neither REALTIME_CHANNEL_SECRET nor SUPABASE_SERVICE_ROLE_KEY is set' };
}

function requireKey(): Buffer {
  const resolved = resolveRealtimeChannelKey();
  if (resolved.ok === true) return resolved.key;
  if (warnedReason !== resolved.reason) {
    warnedReason = resolved.reason;
    console.error(`[realtime] Supabase channel topics disabled (fail-closed): ${resolved.reason}`);
  }
  throw new RealtimeChannelSecretUnavailableError(resolved.reason);
}

/** True for a per-conversation channel (`ws:<workspace>:conv:<id>`). */
export function isConversationChannel(channel: string): boolean {
  return CONVERSATION_CHANNEL_RE.test(channel);
}

/**
 * Derive the concrete Supabase topic for a canonical channel name.
 *
 * Throws `RealtimeChannelSecretUnavailableError` when no secret is
 * configured, and refuses to derive a VISITOR topic for anything other than
 * a conversation channel — operator-only channels never have a visitor copy.
 */
export function deriveSupabaseTopic(canonicalChannel: string, audience: RealtimeTopicAudience): string {
  if (!canonicalChannel || typeof canonicalChannel !== 'string') {
    throw new Error('invalid_channel');
  }
  if (audience === 'visitor' && !isConversationChannel(canonicalChannel)) {
    throw new Error('visitor_topic_not_allowed');
  }
  const mac = crypto
    .createHmac('sha256', requireKey())
    .update(`v1|${audience}|${canonicalChannel}`)
    .digest('base64url')
    .slice(0, TOPIC_MAC_LENGTH);
  return `${canonicalChannel}:${mac}`;
}

/**
 * Every Supabase topic a server-side publish to `canonicalChannel` must
 * reach: the operator copy always, plus the visitor copy for conversation
 * channels (the only channel shape the widget subscribes to).
 */
export function supabaseTopicsForPublish(canonicalChannel: string): string[] {
  const topics = [deriveSupabaseTopic(canonicalChannel, 'operator')];
  if (isConversationChannel(canonicalChannel)) {
    topics.push(deriveSupabaseTopic(canonicalChannel, 'visitor'));
  }
  return topics;
}

/** Test-only: forget the once-per-reason warning latch. */
export function __resetRealtimeChannelTopicWarningsForTests(): void {
  warnedReason = null;
}
