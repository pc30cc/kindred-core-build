/**
 * A workspace's own privacy-export storage (provider_configs,
 * provider_type 'privacy_export_storage') is an address the SERVER talks to:
 * it uploads the export there and, on download, reads it back and hands the
 * body to the caller. An endpoint inside our network (or one that redirects
 * there) turned that into a server-side request forgery with the response
 * returned. The resolver now refuses such an override every time it is used,
 * not only when it is saved, and marks the endpoint untrusted so its S3
 * requests never follow a redirect.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

let override: { provider_name: string; config: Record<string, unknown> } | null = null;

function chain(result: () => unknown) {
  const q: Record<string, unknown> = {};
  for (const m of ['select', 'eq', 'order', 'limit']) q[m] = () => q;
  q.maybeSingle = async () => ({ data: result(), error: null });
  return q;
}

vi.mock('../../../server/supabase.js', () => ({
  getServiceClient: () => ({
    from: (table: string) => chain(() => (table === 'provider_configs' ? override : null)),
  }),
}));

const {
  resolvePrivacyStoragePolicy,
  PrivacyStorageNotConfigured,
  workspacePrivacyStorageRefusal,
} = await import('../../../server/services/privacy/storageResolver.js');

const cfg = {} as never;
const WS = '11111111-1111-4111-8111-111111111111';

beforeEach(() => { override = null; });

describe('workspace privacy-export storage override (SSRF)', () => {
  it('a local-disk override saved before the fix is refused when used', async () => {
    override = { provider_name: 'local', config: { local_path: '/app' } };
    await expect(resolvePrivacyStoragePolicy(cfg, WS)).rejects.toBeInstanceOf(PrivacyStorageNotConfigured);
  });

  it('an internal or plain-http endpoint is refused when used', async () => {
    for (const endpoint of ['http://172.17.0.1:8000', 'https://10.1.2.3', 'https://[::1]:9000', 'https://169.254.169.254']) {
      override = { provider_name: 's3', config: { endpoint, bucket: 'b' } };
      await expect(resolvePrivacyStoragePolicy(cfg, WS), endpoint).rejects.toBeInstanceOf(PrivacyStorageNotConfigured);
    }
  });

  it('a bucket or region that would rewrite the URL is refused', async () => {
    expect(await workspacePrivacyStorageRefusal('s3', { provider: 's3', bucket: 'a?b' })).toBe('invalid_bucket');
    expect(await workspacePrivacyStorageRefusal('s3', { provider: 's3', bucket: 'a/b' })).toBe('invalid_bucket');
    expect(await workspacePrivacyStorageRefusal('s3', { provider: 's3', s3Region: 'evil.example/' })).toBe('invalid_region');
    expect(await workspacePrivacyStorageRefusal('bunny_storage', { provider: 'bunny_storage', region: 'evil.example/' })).toBe('invalid_region');
  });

  it('a public https override is used, marked untrusted (no redirects)', async () => {
    override = { provider_name: 'minio', config: { endpoint: 'https://93.184.216.34', bucket: 'exports' } };
    const policy = await resolvePrivacyStoragePolicy(cfg, WS);
    expect(policy.source).toBe('workspace_override');
    expect(policy.config.endpoint).toBe('https://93.184.216.34');
    expect(policy.config.untrustedEndpoint).toBe(true);
  });

  it('the default AWS endpoint needs no address check', async () => {
    expect(await workspacePrivacyStorageRefusal('s3', { provider: 's3', bucket: 'exports', s3Region: 'eu-west-1' })).toBeNull();
  });
});
