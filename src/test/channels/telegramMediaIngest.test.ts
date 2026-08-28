/**
 * Inbound Telegram media — CORE SIDE behaviour after provider isolation.
 *
 * Core no longer downloads anything: the worker fetches the bytes and hands
 * them over. These tests pin the two halves Core still owns:
 *
 *  1. `requestTelegramMediaFetch` only ENQUEUES — it must never open a socket
 *     and must never place a credential in the job/operation payload;
 *  2. `persistInboundAttachment` keeps every guarantee the old in-Core
 *     download had: size cap, mime allow-list, the shared storage_gb
 *     entitlement gate, canonical row lifecycle, and redacted failures.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: {
  attachmentRows: any[];
  operations: any[];
  gateAllow: boolean;
  uploadOk: boolean;
} = { attachmentRows: [], operations: [], gateAllow: true, uploadOk: true };

const sbMock = {
  from: (table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => ({ data: null, error: null }),
      insert: (payload: any) => ({
        select: () => ({
          single: async () => {
            if (table === 'conversation_attachments') {
              const row = { id: `att-${state.attachmentRows.length + 1}`, ...payload };
              state.attachmentRows.push(row);
              return { data: row, error: null };
            }
            return { data: null, error: null };
          },
        }),
      }),
      update: (patch: any) => ({
        eq: async () => {
          if (table === 'conversation_attachments') {
            const row = state.attachmentRows[state.attachmentRows.length - 1];
            if (row) Object.assign(row, patch);
          }
          return { data: null, error: null };
        },
      }),
    };
    return builder;
  },
};

vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => sbMock }));

vi.mock('../../../server/services/channels/operations.js', () => ({
  requestProviderOperation: async (_config: any, input: any) => {
    const operation = { id: `op-${state.operations.length + 1}`, ...input };
    state.operations.push(operation);
    return operation;
  },
}));

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(async (_config: any, req: any): Promise<any> => ({
    success: true,
    url: `https://cdn.example.com/${req.fileKey}`,
  })),
}));
vi.mock('../../../server/services/storage/index.js', () => ({
  uploadFile: uploadFileMock,
  resolveStorageConfig: async () => ({ provider: 'local', localPath: '/tmp/storage' }),
  getFileUrlWithConfig: (_c: any, key: string) => `https://cdn.example.com/${key}`,
}));

vi.mock('../../../server/middleware/featureGating.js', () => ({
  requireLimit: () => async (_req: any, res: any, next: any) => {
    if (state.gateAllow) return next();
    res.status(403).json({ error: 'storage_gb limit reached' });
  },
}));
vi.mock('../../../server/services/billing/usageResolvers.js', () => ({
  usageFnForLimit: () => () => 0,
}));

const { requestTelegramMediaFetch, persistInboundAttachment, HARD_MAX_BYTES } = await import(
  '../../../server/services/channels/telegram/mediaIngest.js'
);

const CONFIG: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };
const TOKEN = '123456:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK';

const baseInput = {
  workspaceId: 'ws-1',
  integrationId: 'integ-1',
  conversationId: 'conv-1',
  messageId: 'msg-1',
};

function bytes(size: number): Buffer {
  return Buffer.alloc(size, 1);
}

beforeEach(() => {
  state.attachmentRows = [];
  state.operations = [];
  state.gateAllow = true;
  state.uploadOk = true;
  uploadFileMock.mockClear();
  uploadFileMock.mockImplementation(async (_config: any, req: any): Promise<any> =>
    state.uploadOk
      ? { success: true, url: `https://cdn.example.com/${req.fileKey}` }
      : { success: false, error: 'disk full' },
  );
});

describe('requestTelegramMediaFetch (no provider I/O in Core)', () => {
  it('queues one operation and reports the attachments as pending', async () => {
    const { outcomes, operation } = await requestTelegramMediaFetch(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'f1', kind: 'photo', size: 100 }],
    });

    expect(operation?.operation).toBe('media_fetch');
    expect(outcomes).toEqual([{ fileId: 'f1', kind: 'photo', status: 'pending' }]);
    expect(state.attachmentRows).toHaveLength(0); // nothing persisted yet
  });

  it('never puts a credential in the operation payload', async () => {
    await requestTelegramMediaFetch(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'f1', kind: 'document', fileName: 'a.pdf', mimeType: 'application/pdf' }],
    });
    expect(JSON.stringify(state.operations)).not.toContain(TOKEN);
    expect(JSON.stringify(state.operations)).not.toContain('bot');
  });

  it('does nothing at all when there are no attachments', async () => {
    const { operation, outcomes } = await requestTelegramMediaFetch(CONFIG, { ...baseInput, attachments: [] });
    expect(operation).toBeNull();
    expect(outcomes).toEqual([]);
  });
});

describe('persistInboundAttachment (Core owns validation + storage)', () => {
  it('stores an allowed file and finalizes the canonical row', async () => {
    const outcome = await persistInboundAttachment(CONFIG, {
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      fileId: 'f1',
      kind: 'photo',
      filePath: 'photos/a.jpg',
      mimeType: 'image/jpeg',
      bytes: bytes(1024),
    });

    expect(outcome.status).toBe('stored');
    expect(outcome.mimeType).toBe('image/jpeg');
    expect(outcome.sizeBytes).toBe(1024);
    const row = state.attachmentRows[0];
    expect(row.status).toBe('uploaded');
    expect(row.uploaded_by_type).toBe('contact');
    expect(row.storage_path).toContain('workspace/ws-1/attachments/');
  });

  it('rejects a disallowed mime type without touching storage', async () => {
    const outcome = await persistInboundAttachment(CONFIG, {
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      fileId: 'f1',
      kind: 'document',
      fileName: 'evil.exe',
      mimeType: 'application/x-msdownload',
      bytes: bytes(10),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('mime_type_not_allowed');
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(state.attachmentRows).toHaveLength(0);
  });

  it('rejects a file above the hard size cap', async () => {
    const outcome = await persistInboundAttachment(CONFIG, {
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      fileId: 'f1',
      kind: 'document',
      mimeType: 'application/pdf',
      bytes: bytes(HARD_MAX_BYTES + 1),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('file_too_large');
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('honours the SHARED storage_gb entitlement gate', async () => {
    state.gateAllow = false;
    const outcome = await persistInboundAttachment(CONFIG, {
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      fileId: 'f1',
      kind: 'photo',
      mimeType: 'image/png',
      bytes: bytes(10),
    });

    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('storage_gb');
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('marks the row failed when the upload itself fails', async () => {
    state.uploadOk = false;
    const outcome = await persistInboundAttachment(CONFIG, {
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      fileId: 'f1',
      kind: 'photo',
      mimeType: 'image/png',
      bytes: bytes(10),
    });

    expect(outcome.status).toBe('failed');
    expect(state.attachmentRows[0].status).toBe('failed');
  });

  it('never leaks a bot token into a row or an outcome', async () => {
    const outcome = await persistInboundAttachment(CONFIG, {
      workspaceId: 'ws-1',
      conversationId: 'conv-1',
      messageId: 'msg-1',
      fileId: 'f1',
      kind: 'photo',
      fileName: `${TOKEN}.jpg`,
      mimeType: 'image/jpeg',
      bytes: bytes(10),
    });

    const dump = JSON.stringify({ outcome, rows: state.attachmentRows });
    expect(dump).not.toContain(TOKEN);
  });
});
