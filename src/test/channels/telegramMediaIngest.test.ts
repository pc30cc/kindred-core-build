/**
 * Behavioral tests for real inbound Telegram media persistence.
 *
 * Mocks: Supabase service client, the Telegram HTTP client (getFile /
 * downloadFile), the storage pipeline (uploadFile / resolveStorageConfig)
 * and the storage_gb entitlement gate. No network, no DB.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const state: {
  installationId: string;
  secret: string | null;
  attachmentRows: any[];
  uploadCalls: any[];
  gateAllow: boolean;
  fileInfo: Record<string, { file_path: string; file_size?: number }>;
  fileBytes: Record<string, Uint8Array>;
} = {
  installationId: 'install-1',
  secret: '123456:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK',
  attachmentRows: [],
  uploadCalls: [],
  gateAllow: true,
  fileInfo: {},
  fileBytes: {},
};

const sbMock = {
  from: (table: string) => {
    const builder: any = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => builder,
      maybeSingle: async () => {
        if (table === 'channel_integrations') {
          return { data: { id: 'integ-1', installation_id: state.installationId, provider: 'telegram' }, error: null };
        }
        if (table === 'provider_configs') return { data: null, error: null };
        if (table === 'app_runtime_config') return { data: null, error: null };
        return { data: null, error: null };
      },
      single: async () => {
        if (table === 'channel_integrations') {
          return { data: { id: 'integ-1', installation_id: state.installationId, provider: 'telegram' }, error: null };
        }
        return { data: null, error: null };
      },
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

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => sbMock,
}));

vi.mock('../../../server/services/channels/integrations.js', () => ({
  getIntegrationById: async () => ({ id: 'integ-1', installation_id: state.installationId, provider: 'telegram' }),
}));

vi.mock('../../../server/services/plugins/secrets.js', () => ({
  TELEGRAM_BOT_TOKEN_KEY: 'telegram_bot_token',
  readPluginSecret: async () => state.secret,
}));

vi.mock('../../../server/services/channels/telegram/client.js', () => ({
  redactToken: (text: string) => text.replace(/\d{6,}:[A-Za-z0-9_-]{20,}/g, '[REDACTED_BOT_TOKEN]'),
  getFile: async (_token: string, fileId: string) => {
    const info = state.fileInfo[fileId];
    if (!info) throw new Error('no such file');
    return info;
  },
  downloadFile: async (token: string, filePath: string, maxBytes: number) => {
    // Prove the token is used to build the request internally but never
    // returned/leaked to the caller — the mock intentionally does NOT
    // embed it in anything handed back.
    expect(token).toBe(state.secret);
    const bytes = state.fileBytes[filePath];
    if (!bytes) throw new Error('no bytes');
    if (bytes.byteLength > maxBytes) throw new Error('Telegram file exceeds allowed size');
    return bytes;
  },
}));

const { uploadFileMock } = vi.hoisted(() => ({
  uploadFileMock: vi.fn(async (_config: any, req: any) => {
    return { success: true, url: `https://cdn.example.com/${req.fileKey}` };
  }),
}));
vi.mock('../../../server/services/storage/index.js', () => ({
  uploadFile: uploadFileMock,
  resolveStorageConfig: async () => ({ provider: 'local', localPath: '/tmp/storage' }),
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

const { ingestTelegramMedia } = await import('../../../server/services/channels/telegram/mediaIngest.js');

const CONFIG: any = { supabaseUrl: 'http://x', supabaseServiceRoleKey: 'k' };

function makeBytes(size: number): Uint8Array {
  return new Uint8Array(size).fill(1);
}

beforeEach(() => {
  state.installationId = 'install-1';
  state.secret = '123456:AAABBBCCCDDDEEEFFFGGGHHHIIIJJJKKK';
  state.attachmentRows = [];
  state.uploadCalls = [];
  state.gateAllow = true;
  state.fileInfo = {};
  state.fileBytes = {};
  uploadFileMock.mockClear();
});

const baseInput = {
  workspaceId: '11111111-1111-1111-1111-111111111111',
  integrationId: 'integ-1',
  conversationId: '22222222-2222-2222-2222-222222222222',
  messageId: '33333333-3333-3333-3333-333333333333',
};

describe('ingestTelegramMedia', () => {
  it('persists an inbound photo through the canonical storage pipeline', async () => {
    state.fileInfo['photo-file-id'] = { file_path: 'photos/file_1.jpg', file_size: 1000 };
    state.fileBytes['photos/file_1.jpg'] = makeBytes(1000);

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'photo-file-id', kind: 'photo', size: 1000 }],
    });

    expect(outcomes).toHaveLength(1);
    expect(outcomes[0].status).toBe('stored');
    expect(outcomes[0].mimeType).toBe('image/jpeg');
    expect(uploadFileMock).toHaveBeenCalledTimes(1);
    expect(state.attachmentRows).toHaveLength(1);
    expect(state.attachmentRows[0].status).toBe('uploaded');
    expect(state.attachmentRows[0].conversation_id).toBe(baseInput.conversationId);
    expect(state.attachmentRows[0].message_id).toBe(baseInput.messageId);
    expect(state.attachmentRows[0].storage_path).toMatch(
      new RegExp(`^workspace/${baseInput.workspaceId}/attachments/`),
    );
  });

  it('persists an inbound document through the canonical storage pipeline', async () => {
    state.fileInfo['doc-file-id'] = { file_path: 'documents/report.pdf', file_size: 2000 };
    state.fileBytes['documents/report.pdf'] = makeBytes(2000);

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'doc-file-id', kind: 'document', fileName: 'report.pdf', mimeType: 'application/pdf', size: 2000 }],
    });

    expect(outcomes[0].status).toBe('stored');
    expect(outcomes[0].fileName).toBe('report.pdf');
    expect(state.attachmentRows[0].mime_type).toBe('application/pdf');
  });

  it('persists an inbound voice note through the canonical storage pipeline', async () => {
    state.fileInfo['voice-file-id'] = { file_path: 'voice/note.oga', file_size: 500 };
    state.fileBytes['voice/note.oga'] = makeBytes(500);

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'voice-file-id', kind: 'voice', mimeType: 'audio/ogg', size: 500 }],
    });

    expect(outcomes[0].status).toBe('stored');
    expect(state.attachmentRows[0].mime_type).toBe('audio/ogg');
  });

  it('persists an inbound audio file through the canonical storage pipeline', async () => {
    state.fileInfo['audio-file-id'] = { file_path: 'audio/song.mp3', file_size: 700 };
    state.fileBytes['audio/song.mp3'] = makeBytes(700);

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'audio-file-id', kind: 'audio', mimeType: 'audio/mpeg', fileName: 'song.mp3', size: 700 }],
    });

    expect(outcomes[0].status).toBe('stored');
    expect(state.attachmentRows[0].mime_type).toBe('audio/mpeg');
  });

  it('persists an inbound video through the canonical storage pipeline', async () => {
    state.fileInfo['video-file-id'] = { file_path: 'video/clip.mp4', file_size: 3000 };
    state.fileBytes['video/clip.mp4'] = makeBytes(3000);

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'video-file-id', kind: 'video', mimeType: 'video/mp4', size: 3000 }],
    });

    expect(outcomes[0].status).toBe('stored');
    expect(state.attachmentRows[0].mime_type).toBe('video/mp4');
  });

  it('rejects oversized files without ever calling the storage pipeline', async () => {
    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'huge-file-id', kind: 'document', size: 26 * 1024 * 1024 }],
    });

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error).toMatch(/file_too_large/);
    expect(uploadFileMock).not.toHaveBeenCalled();
    expect(state.attachmentRows).toHaveLength(0);
  });

  it('rejects oversized files reported only by getFile (declared size lied)', async () => {
    state.fileInfo['sneaky-file-id'] = { file_path: 'documents/big.pdf', file_size: 30 * 1024 * 1024 };

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'sneaky-file-id', kind: 'document', mimeType: 'application/pdf', size: 1000 }],
    });

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error).toMatch(/file_too_large/);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('rejects disallowed mime types', async () => {
    state.fileInfo['exe-file-id'] = { file_path: 'documents/tool.exe', file_size: 100 };
    state.fileBytes['documents/tool.exe'] = makeBytes(100);

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'exe-file-id', kind: 'document', mimeType: 'application/x-msdownload', size: 100 }],
    });

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error).toMatch(/mime_type_not_allowed/);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('does not fail the whole batch when one attachment fails and another succeeds', async () => {
    state.fileInfo['ok-file-id'] = { file_path: 'photos/ok.jpg', file_size: 100 };
    state.fileBytes['photos/ok.jpg'] = makeBytes(100);

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [
        { fileId: 'missing-file-id', kind: 'document', size: 10 },
        { fileId: 'ok-file-id', kind: 'photo', size: 100 },
      ],
    });

    expect(outcomes).toHaveLength(2);
    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[1].status).toBe('stored');
  });

  it('is blocked by the storage_gb entitlement gate exactly like the HTTP upload routes', async () => {
    state.gateAllow = false;
    state.fileInfo['gated-file-id'] = { file_path: 'photos/gated.jpg', file_size: 100 };
    state.fileBytes['photos/gated.jpg'] = makeBytes(100);

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'gated-file-id', kind: 'photo', size: 100 }],
    });

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error).toMatch(/storage_gb/);
    expect(uploadFileMock).not.toHaveBeenCalled();
  });

  it('never leaks the bot token anywhere in stored rows, outcomes, or upload payloads', async () => {
    state.fileInfo['tok-file-id'] = { file_path: 'photos/tok.jpg', file_size: 100 };
    state.fileBytes['photos/tok.jpg'] = makeBytes(100);

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'tok-file-id', kind: 'photo', size: 100 }],
    });

    const token = state.secret!;
    const haystacks = [
      JSON.stringify(outcomes),
      JSON.stringify(state.attachmentRows),
      JSON.stringify(uploadFileMock.mock.calls),
    ];
    for (const h of haystacks) {
      expect(h).not.toContain(token);
      expect(h).not.toContain('api.telegram.org');
    }
    // The resulting "URL" (upload result) must never embed the token either.
    const result = await uploadFileMock.mock.results[0]?.value;
    expect(JSON.stringify(result)).not.toContain(token);
  });

  it('fails all attachments (redacted) and never downloads when the token cannot be resolved', async () => {
    state.secret = null;

    const outcomes = await ingestTelegramMedia(CONFIG, {
      ...baseInput,
      attachments: [{ fileId: 'x', kind: 'photo', size: 100 }],
    });

    expect(outcomes[0].status).toBe('failed');
    expect(outcomes[0].error).toBe('bot_token_not_configured');
    expect(uploadFileMock).not.toHaveBeenCalled();
  });
});
