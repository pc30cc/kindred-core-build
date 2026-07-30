import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('@/integrations/supabase/client', () => ({
  supabase: { auth: { getSession: async () => ({ data: { session: { access_token: 'test-token' } } }) } },
}));

import { aiAgentApi, AiAgentApiError } from '@/lib/ai-agent-api';
import { isStorageCleanupIncomplete, readApiErrorCode } from '@/lib/ai-knowledge-delete';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

function jsonResponse(body: unknown, status = 200) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(body) } as unknown as Response;
}

describe('ai-agent-api jsonFetch error shape', () => {
  it('preserves status and body on a failed JSON response', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'owner_or_admin_required' }, 403));
    const err = await aiAgentApi.deleteAiFile('src-1').catch((e) => e);
    expect(err).toBeInstanceOf(AiAgentApiError);
    expect(err.status).toBe(403);
    expect(err.body).toEqual({ error: 'owner_or_admin_required' });
    expect(err.message).toBe('owner_or_admin_required');
    expect(err.method).toBe('DELETE');
  });

  it('preserves an explicit code field from the body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ code: 'storage_not_ready', error: 'nope' }, 400));
    const err = await aiAgentApi.deleteAiFile('src-1').catch((e) => e);
    expect(err.code).toBe('storage_not_ready');
  });

  it('handles a non-JSON error response', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 502, text: async () => '<html>bad gateway</html>' } as unknown as Response);
    const err = await aiAgentApi.deleteAiFile('src-1').catch((e) => e);
    expect(err).toBeInstanceOf(AiAgentApiError);
    expect(err.status).toBe(502);
    expect(err.code).toBeNull();
    expect(err.message).toBe('request_failed_502');
  });

  it('handles a network error', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    const err = await aiAgentApi.deleteAiFile('src-1').catch((e) => e);
    expect(err).toBeInstanceOf(AiAgentApiError);
    expect(err.status).toBe(0);
    expect(err.code).toBe('network_error');
    expect(err.reason).toBeInstanceOf(TypeError);
  });

  it('leaves successful responses unchanged', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, chunks_deleted: 3, storage_deleted: true }));
    await expect(aiAgentApi.deleteAiFile('src-1')).resolves.toEqual({ ok: true, chunks_deleted: 3, storage_deleted: true });
  });

  it('never exposes request headers on the error', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ error: 'nope' }, 401));
    const err = await aiAgentApi.deleteAiFile('src-1').catch((e) => e);
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain('test-token');
  });
});

describe('knowledge file delete outcome', () => {
  it('treats a full delete as success', () => {
    expect(isStorageCleanupIncomplete({ storage_deleted: true })).toBe(false);
  });
  it('treats storage_deleted:false with an error as incomplete', () => {
    expect(isStorageCleanupIncomplete({ storage_deleted: false, storage_error: 'storage_delete_failed' })).toBe(true);
  });
  it('does not warn when there was nothing stored to delete', () => {
    expect(isStorageCleanupIncomplete({ storage_deleted: false })).toBe(false);
    expect(isStorageCleanupIncomplete({ storage_deleted: false, storage_error: 'already_deleted' })).toBe(false);
  });
  it('reads the backend error code from the structured error', () => {
    const err = new AiAgentApiError({
      message: 'x', status: 403, code: 'x', body: { error: 'owner_or_admin_required' }, url: '/u', method: 'DELETE',
    });
    expect(readApiErrorCode(err, 'delete_failed')).toBe('owner_or_admin_required');
    expect(readApiErrorCode(new Error(''), 'delete_failed')).toBe('delete_failed');
  });
});
