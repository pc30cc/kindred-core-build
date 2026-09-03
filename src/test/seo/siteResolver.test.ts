/**
 * server/services/seo/siteResolver.ts — the single authorization-relevant
 * lookup in the SEO feature. Proves: (1) a site belonging to a DIFFERENT
 * workspace cannot be resolved even with a fully valid siteId — the
 * cross-workspace-`site_id` attack the spec explicitly requires be
 * impossible; (2) the canonical URL is derived server-side from the DB
 * row, never from anything the caller supplies; (3) www is normalized away
 * so the host used for crawl-scope checks is canonical.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const WORKSPACE_A = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const WORKSPACE_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const SITE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';

const domainsTable = [
  { id: SITE_ID, workspace_id: WORKSPACE_A, domain: 'www.Example.com', verified: false, is_primary: true, created_at: '2026-01-01T00:00:00Z' },
];

function makeSb() {
  return {
    from: (name: string) => {
      const filters: Record<string, unknown> = {};
      const chain: any = {
        select: () => chain,
        eq: (col: string, val: unknown) => { filters[col] = val; return chain; },
        order: () => chain,
        maybeSingle: async () => {
          if (name !== 'workspace_domains') return { data: null, error: null };
          const row = domainsTable.find((r) => r.id === filters.id && r.workspace_id === filters.workspace_id);
          return { data: row || null, error: null };
        },
      };
      return chain;
    },
  };
}

let fakeSb: any = makeSb();
vi.mock('../../../server/supabase.js', () => ({ getServiceClient: () => fakeSb }));

const { resolveWorkspaceSite, SiteResolutionError } = await import('../../../server/services/seo/siteResolver.js');

describe('resolveWorkspaceSite — tenant isolation', () => {
  beforeEach(() => { fakeSb = makeSb(); });

  it('resolves a site that belongs to the requesting workspace', async () => {
    const site = await resolveWorkspaceSite({} as any, WORKSPACE_A, SITE_ID);
    expect(site.id).toBe(SITE_ID);
    expect(site.workspaceId).toBe(WORKSPACE_A);
  });

  it('derives the canonical URL from the DB (https + www-stripped host), never from caller input', async () => {
    const site = await resolveWorkspaceSite({} as any, WORKSPACE_A, SITE_ID);
    expect(site.canonicalHost).toBe('example.com');
    expect(site.canonicalUrl).toBe('https://example.com');
  });

  it('REFUSES to resolve a real site id when requested under a different workspace', async () => {
    await expect(resolveWorkspaceSite({} as any, WORKSPACE_B, SITE_ID))
      .rejects.toBeInstanceOf(SiteResolutionError);
  });

  it('the cross-workspace failure looks identical to a nonexistent site (no existence leak)', async () => {
    let crossWorkspaceCode: string | undefined;
    let nonexistentCode: string | undefined;
    try { await resolveWorkspaceSite({} as any, WORKSPACE_B, SITE_ID); } catch (e: any) { crossWorkspaceCode = e.code; }
    try { await resolveWorkspaceSite({} as any, WORKSPACE_A, 'dddddddd-dddd-dddd-dddd-dddddddddddd'); } catch (e: any) { nonexistentCode = e.code; }
    expect(crossWorkspaceCode).toBe('site_not_found');
    expect(nonexistentCode).toBe('site_not_found');
  });
});
