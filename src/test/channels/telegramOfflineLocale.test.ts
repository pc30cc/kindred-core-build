/**
 * Nobody available for a Telegram (or Bale) user: the offline screen the bot
 * sends, and the inbox-only notice routing stores, are in the USER's
 * language when the platform offers it, else in the platform's primary
 * language — the rule every bot reply follows
 * (channels/telegram/runtime.ts resolveTelegramReplyLocale).
 *
 * Routing called the offline screen without a locale and wrote its notice
 * in the primary language, so an English-speaking user of a Persian-first
 * platform got Persian. The user's language is on the contact
 * (`metadata.channel_language`, channels/inboundProcessing.ts).
 *
 * Routing runs for real (auto mode, nobody eligible) with the real offline
 * screen builder; the data layer, the plugin installation and the provider
 * queue are fakes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Row = Record<string, unknown>;
const state = vi.hoisted(() => ({
  conversation: {} as Row,
  contact: {} as Row,
  inserted: [] as Row[],
  queued: [] as Row[],
  tables: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    rpc: async () => ({ data: true, error: null }),
    from: (table: string) => {
      state.tables.push(table);
      let pending: Row | null = null;
      let updating: Row | null = null;
      const api: Record<string, unknown> = {
        select: () => api, eq: () => api, in: () => api, is: () => api, not: () => api, order: () => api, limit: () => api,
        contains: () => api,
        update: (patch: Row) => { updating = patch; return api; },
        insert: (row: Row) => { if (table === 'conversation_messages') state.inserted.push(row); pending = row; return api; },
        maybeSingle: async () => {
          if (table === 'conversations') {
            if (updating) {
              state.conversation = { ...state.conversation, ...updating };
              return { data: { id: state.conversation.id }, error: null };
            }
            return { data: state.conversation, error: null };
          }
          if (table === 'contacts') return { data: state.contact, error: null };
          if (table === 'widget_settings') return { data: { assignment_mode: 'auto', round_robin_cursor_user_id: null }, error: null };
          return { data: null, error: null };
        },
        single: async () => ({ data: { id: 'm1', created_at: 'now', seen_at: null, ...(pending || {}) }, error: null }),
        then: (resolve: (r: { data: Row[]; error: null }) => unknown) => Promise.resolve({ data: [], error: null }).then(resolve),
      };
      return api;
    },
  }),
}));

vi.mock('../../../server/services/platformRegion.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/platformRegion.js')>()),
  getPlatformAllowedLocales: async () => ['fa', 'en'],
}));
vi.mock('../../../server/services/plugins/state.js', () => ({
  getInstallation: async () => ({ id: 'inst-1', settings: {} }),
}));
vi.mock('../../../server/services/plugins/secrets.js', () => ({ hasPluginSecret: async () => true }));
vi.mock('../../../server/services/channels/integrations.js', () => ({ getIntegrationForInstallation: async () => ({ id: 'int-1' }) }));
vi.mock('../../../server/services/channels/providerActions.js', () => ({
  enqueueProviderActions: async (_c: unknown, job: { actions: Row[] }) => { state.queued.push(...job.actions); return true; },
}));
vi.mock('../../../server/services/calls/departments.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/calls/departments.js')>()),
  resolveChatRoutingPool: async () => ({ team: [], department: null }),
  resolveChatRoutingMember: async () => null,
  resolveWorkspaceOwnerId: async () => null,
}));
// The plan allows automatic assignment (a plan without it routes as manual).
vi.mock('../../../server/services/widget/entitlements.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/widget/entitlements.js')>()),
  resolveWidgetCapability: async () => true,
}));
vi.mock('../../../server/services/realtime/publish.js', () => ({
  publishOperatorEvent: async () => {},
  publishConversationEvent: async () => {},
  buildMessageEnvelope: (m: unknown) => m,
}));
vi.mock('../../../server/services/channels/outbound.js', () => ({ dispatchOutboundIfChannelConversation: async () => {} }));
vi.mock('../../../server/services/push/index.js', () => ({ notifyAssignment: async () => {}, notifyHandoff: async () => {} }));
vi.mock('../../../server/services/conversationMetadata.js', () => ({ patchConversationMetadata: async () => true }));
vi.mock('../../../server/services/billing/locks/state.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/locks/state.js')>()),
  resolveLockState: async () => ({}),
}));
vi.mock('../../../server/services/billing/locks/predicates.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../server/services/billing/locks/predicates.js')>()),
  isMemberLocked: () => false,
}));

const { routeConversationToOperator } = await import('../../../server/services/chatRouting.js');
const { maybeQueueTelegramOfflineScreen } = await import('../../../server/services/channels/telegram/offlineDelivery.js');
const { parseTelegramSettings, resolveLocalizedMessage } = await import('../../../server/services/channels/telegram/settings.js');

const NOTICE = (locale: string) => resolveLocalizedMessage(parseTelegramSettings({}), locale, 'offlineNotice', locale);

beforeEach(() => {
  state.conversation = { id: 'c1', assigned_to: null, contact_id: 'ct-1', metadata: { channel: 'telegram', channel_chat_id: '42' } };
  state.inserted = [];
  state.queued = [];
  state.tables = [];
});

async function routeWith(language: string | null) {
  state.contact = { id: 'ct-1', metadata: { channel: 'telegram', ...(language ? { channel_language: language } : {}) } };
  const res = await routeConversationToOperator({} as never, { workspaceId: 'ws1', conversationId: 'c1' });
  expect(res.outcome).toBe('no_eligible_agent');
  const notice = state.inserted.find((r) => (r.metadata as Row | undefined)?.kind === 'routing_no_agent_available');
  const screen = state.queued.find((a) => a.kind === 'send_message');
  return { notice, screen };
}

describe('the Telegram offline screen and routing\'s notice speak the user\'s language', () => {
  it('the texts this test tells apart differ by language', () => {
    expect(NOTICE('en')).not.toBe(NOTICE('fa'));
  });

  it('an English-speaking user of a Persian-first platform gets English', async () => {
    const { notice, screen } = await routeWith('en');
    expect(screen?.text).toBe(NOTICE('en'));
    expect(notice?.body).toBe(NOTICE('en'));
  });

  it('a region tag counts as its language', async () => {
    const { screen } = await routeWith('en-GB');
    expect(screen?.text).toBe(NOTICE('en'));
  });

  it('a language the platform does not offer gets the primary one', async () => {
    const { notice, screen } = await routeWith('de');
    expect(screen?.text).toBe(NOTICE('fa'));
    expect(notice?.body).toBe(NOTICE('fa'));
  });

  it('no language on the contact: the primary one', async () => {
    const { notice, screen } = await routeWith(null);
    expect(screen?.text).toBe(NOTICE('fa'));
    expect(notice?.body).toBe(NOTICE('fa'));
  });
});

describe('a conversation that is not a bot\'s', () => {
  it('costs one read and no language lookup (every AI hand-over asks)', async () => {
    // A widget conversation: responder.insertAiMessage calls this on every
    // hand-over, without a locale.
    state.conversation = { id: 'c1', assigned_to: null, contact_id: 'ct-1', metadata: { channel: 'widget' } };
    state.contact = { id: 'ct-1', metadata: { channel_language: 'en' } };
    expect(await maybeQueueTelegramOfflineScreen({} as never, { workspaceId: 'ws1', conversationId: 'c1' })).toBe(false);
    expect(state.tables).toEqual(['conversations']);
    expect(state.queued).toEqual([]);
  });
});
