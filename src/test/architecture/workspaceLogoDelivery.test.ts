/**
 * `GET /api/workspaces` has to carry each workspace's logo.
 *
 * The picture is not on `workspaces`. It lives on `workspace_branding`, as
 * either a link somebody pasted or a key into our own storage, so a route that
 * only selects from `workspaces` returns a name and nothing else — which is
 * exactly what the iOS Settings screen showed: a list of workspaces with
 * generated initials where the company logos should be, on an account whose
 * branding row has a perfectly good `logo_url` in it.
 *
 * Nothing about that failure is loud. The client's `logo_url` is optional (most
 * workspaces have never set one), so an absent field decodes cleanly and the
 * avatar quietly falls back. This test is the noise: it reads the route and
 * fails if the join, the resolver or the field stop being there.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const ROUTE = 'server/routes/workspaces.ts';

/** The body of `workspacesRouter.get('/', …)`, up to the next route. */
function listHandler(source: string): string {
  const start = source.indexOf("workspacesRouter.get('/',");
  expect(start).toBeGreaterThan(-1);
  const rest = source.slice(start + 1);
  const end = rest.indexOf('workspacesRouter.');
  return rest.slice(0, end === -1 ? undefined : end);
}

describe('GET /api/workspaces carries the workspace logo', () => {
  const handler = listHandler(readFileSync(ROUTE, 'utf8'));

  it('reads the branding table, which is where the logo lives', () => {
    expect(handler).toMatch(/from\(\s*'workspace_branding'\s*\)/);
    expect(handler).toMatch(/logo_storage_key/);
  });

  it('resolves a storage key into a URL rather than returning the key', () => {
    // A key is not something a client can fetch. Whichever storage provider is
    // primary right now turns it into a link, and that has to happen here.
    expect(handler).toMatch(/createStorageUrlResolver/);
  });

  it('puts `logo_url` on every workspace it returns', () => {
    expect(handler).toMatch(/logo_url:/);
  });

  it('prefers a pasted link over a derived one', () => {
    // An operator who typed their own URL means it. `row.logo_url ||` — the
    // pasted value first, the derived key second.
    expect(handler).toMatch(/row\.logo_url\s*\|\|/);
  });

  it('the iOS client decodes the field the route sends', () => {
    // Two independent spellings of the same name are how this breaks next: the
    // route could return `logoUrl` and the app would decode nothing, silently.
    const model = readFileSync(
      'ios/WebyarNative/Sources/Core/Models/Models.swift',
      'utf8',
    );
    expect(model).toMatch(/case logoURL = "logo_url"/);
  });
});
