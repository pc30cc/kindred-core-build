/**
 * TELEGRAM CONTACT AVATAR INGEST — ownership and key-only persistence.
 *
 * The bytes arrive from the Channels Worker, a separate process, over the
 * internal boundary. It names the contact AND the workspace, and a contact id
 * is guessable, so neither the lookup nor the write may trust the id alone:
 * both are scoped by `id` AND `workspace_id`, and a delivery quoting the
 * wrong workspace must write nothing at all rather than "the right row for
 * the wrong tenant".
 *
 * A failed lookup is a refusal, not a green light: if the SELECT errors we
 * cannot prove ownership, so nothing is persisted and the next inbound
 * message retries.
 *
 * What is written is the KEY. `avatar_url` is cleared, because a URL written
 * under a previous primary must not survive next to the key that replaces it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

interface Update { values: Record<string, unknown>; filters: Array<[string, unknown]> }

const state: {
  contact: Record<string, unknown> | null;
  lookupError: { message: string } | null;
  lookupFilters: Array<[string, unknown]>;
  updates: Update[];
  uploads: string[];
  uploadOk: boolean;
} = {
  contact: null, lookupError: null, lookupFilters: [], updates: [], uploads: [], uploadOk: true,
};

/** The fluent PostgREST surface the ingest touches. */
type FakeBuilder = {
  select: () => FakeBuilder;
  eq: (col: string, value: unknown) => FakeBuilder;
  maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
  update: (values: Record<string, unknown>) => FakeBuilder;
  then: (onOk: (v: unknown) => unknown) => Promise<unknown>;
};

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => {
      const filters: Array<[string, unknown]> = [];
      let pendingUpdate: Record<string, unknown> | null = null;
      const builder: FakeBuilder = {
        select: () => builder,
        eq: (col: string, value: unknown) => {
          filters.push([col, value]);
          if (pendingUpdate) {
            const existing = state.updates[state.updates.length - 1];
            if (existing && existing.values === pendingUpdate) existing.filters = [...filters];
          }
          return builder;
        },
        maybeSingle: async () => {
          if (table !== 'contacts') return { data: null, error: null };
          state.lookupFilters = [...filters];
          if (state.lookupError) return { data: null, error: state.lookupError };
          const match = state.contact
            && filters.every(([col, value]) => state.contact?.[col] === value);
          return { data: match ? state.contact : null, error: null };
        },
        update: (values: Record<string, unknown>) => {
          pendingUpdate = values;
          state.updates.push({ values, filters: [] });
          return builder;
        },
        then: (onOk: (v: unknown) => unknown) =>
          Promise.resolve({ data: null, error: null }).then(onOk),
      };
      return builder;
    },
  }),
}));

vi.mock('../../../server/services/storage/index.js', () => ({
  uploadFile: async (_config: unknown, req: { fileKey: string }) => {
    state.uploads.push(req.fileKey);
    return state.uploadOk
      ? { success: true, fileKey: req.fileKey, url: 'https://whichever-vendor.test/' + req.fileKey }
      : { success: false, error: 'upload_failed' };
  },
  resolveStorageConfig: async () => ({ provider: 'local', publicUrl: 'https://whichever-vendor.test' }),
}));

const { persistContactAvatar } = await import('../../../server/services/channels/telegram/mediaIngest.js');

const WS = '6ee40d07-32a3-4594-8a5f-d439f81afa5b';
const OTHER_WS = '11111111-2222-3333-4444-555555555555';
const CONTACT = 'cccccccc-dddd-eeee-ffff-000000000000';

const config = {} as never;
const bytes = Buffer.from('jpeg-bytes');

beforeEach(() => {
  state.contact = { id: CONTACT, workspace_id: WS, metadata: { existing: true } };
  state.lookupError = null;
  state.lookupFilters = [];
  state.updates = [];
  state.uploads = [];
  state.uploadOk = true;
});

describe('persistContactAvatar', () => {
  it('scopes the lookup by contact id AND workspace id', async () => {
    await persistContactAvatar(config, { workspaceId: WS, contactId: CONTACT, fileKeyHint: 'hint', bytes });

    expect(state.lookupFilters).toEqual([['id', CONTACT], ['workspace_id', WS]]);
  });

  it('scopes the write by contact id AND workspace id too', async () => {
    await persistContactAvatar(config, { workspaceId: WS, contactId: CONTACT, fileKeyHint: 'hint', bytes });

    expect(state.updates).toHaveLength(1);
    expect(state.updates[0].filters).toEqual([['id', CONTACT], ['workspace_id', WS]]);
  });

  it('persists the storage key and clears any URL left from a previous provider', async () => {
    await persistContactAvatar(config, { workspaceId: WS, contactId: CONTACT, fileKeyHint: 'hint', bytes });

    const values = state.updates[0].values;
    expect(values.avatar_storage_key).toBe(`workspace/${WS}/avatars/telegram/hint.jpg`);
    expect(values.avatar_url).toBeNull();
    // No provider URL anywhere in what is written.
    expect(JSON.stringify(values)).not.toContain('https://');
  });

  it('keeps existing metadata and records the sync marker', async () => {
    await persistContactAvatar(config, { workspaceId: WS, contactId: CONTACT, fileKeyHint: 'hint', bytes });

    const meta = state.updates[0].values.metadata as Record<string, unknown>;
    expect(meta.existing).toBe(true);
    expect(meta.avatar_source).toBe('telegram');
    expect(typeof meta.avatar_synced_at).toBe('string');
  });

  it('writes nothing when the delivery names a workspace that does not own the contact', async () => {
    await persistContactAvatar(config, { workspaceId: OTHER_WS, contactId: CONTACT, fileKeyHint: 'hint', bytes });

    expect(state.updates).toEqual([]);
  });

  it('fails closed on a lookup error — an unprovable owner is never written to', async () => {
    state.lookupError = { message: 'connection reset' };

    await persistContactAvatar(config, { workspaceId: WS, contactId: CONTACT, fileKeyHint: 'hint', bytes });

    expect(state.updates).toEqual([]);
    expect(state.uploads).toEqual([]);
  });

  it('writes nothing when the upload itself failed', async () => {
    state.uploadOk = false;

    await persistContactAvatar(config, { workspaceId: WS, contactId: CONTACT, fileKeyHint: 'hint', bytes });

    expect(state.updates).toEqual([]);
  });

  it('rejects an oversized image before touching storage or the row', async () => {
    await persistContactAvatar(config, {
      workspaceId: WS, contactId: CONTACT, fileKeyHint: 'hint',
      bytes: Buffer.alloc(3 * 1024 * 1024),
    });

    expect(state.uploads).toEqual([]);
    expect(state.updates).toEqual([]);
  });
});
