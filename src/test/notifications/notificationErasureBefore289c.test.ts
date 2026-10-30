// @vitest-environment node
/**
 * A privacy erasure's part in the notification emails
 * (server/services/notificationEmail/erasure.ts) on a database before
 * migration 289c: the queue has no conversation_ids, so no job can be found
 * by them, and the anonymizer's step must find nothing to delete rather than
 * fail the erasure halfway (RESPOK's backend can start before its migrator).
 * Any other error still comes back, and fails the step.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  error: null as { code?: string; message: string } | null,
  rows: [] as Array<{ id: string }>,
  filters: [] as string[],
}));

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: () => {
      const builder: Record<string, unknown> = {
        delete: () => builder,
        eq: (column: string) => { state.filters.push(column); return builder; },
        overlaps: (column: string) => { state.filters.push(column); return builder; },
        select: async () => (state.error ? { data: null, error: state.error } : { data: state.rows, error: null }),
      };
      return builder;
    },
  }),
}));

const { deleteNotificationJobsAboutConversations } = await import('../../../server/services/notificationEmail/erasure.js');

const CONFIG = {} as never;
const WS = '11111111-1111-4111-8111-111111111111';
const CONVERSATION = '22222222-2222-4222-8222-222222222222';

beforeEach(() => {
  state.error = null;
  state.rows = [];
  state.filters.length = 0;
});

describe('the jobs about erased conversations', () => {
  it('are deleted by conversation_ids, and counted', async () => {
    state.rows = [{ id: 'j1' }, { id: 'j2' }];
    expect(await deleteNotificationJobsAboutConversations(CONFIG, WS, [CONVERSATION])).toEqual({ count: 2, error: null });
    expect(state.filters).toEqual(['workspace_id', 'conversation_ids']);
  });

  it('before 289c (no such column, from PostgreSQL or the data layer): nothing to delete, no error', async () => {
    for (const code of ['42703', 'PGRST204']) {
      state.error = { code, message: 'column notification_email_jobs.conversation_ids does not exist' };
      expect(await deleteNotificationJobsAboutConversations(CONFIG, WS, [CONVERSATION])).toEqual({ count: 0, error: null });
    }
  });

  it('any other error comes back, so the erasure step fails and is retried', async () => {
    state.error = { code: '57014', message: 'canceling statement due to statement timeout' };
    const result = await deleteNotificationJobsAboutConversations(CONFIG, WS, [CONVERSATION]);
    expect(result.count).toBe(0);
    expect(result.error).toMatchObject({ code: '57014' });
  });
});
