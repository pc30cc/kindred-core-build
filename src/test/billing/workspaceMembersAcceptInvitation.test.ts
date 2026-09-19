/**
 * The legacy seat-creation route, and what is left of it.
 *
 * `POST /api/workspace-members/accept-invitation` used to be the canonical
 * boundary where an invitation token became a workspace seat: it resolved the
 * invitation, matched the invited email, required a verified account, checked
 * `max_agents`, and called the service-role companion RPC. All of that moved
 * to `server/routes/workspaceInvitations.ts`, and this path was retired —
 * every method now answers 410 and names its replacement.
 *
 * This file used to assert the old behaviour, every case of it, and went on
 * asserting it long after the route stopped doing any of it: thirteen tests
 * that only ever proved the endpoint had changed. What is worth pinning is
 * the contract that replaced them.
 *
 * A retired endpoint is not nothing. Clients that have not been updated still
 * reach it, and what they get back is the only thing that tells them where to
 * go: 410 rather than 404, because the resource existed and is deliberately
 * gone, and a `replacement` they can follow. Quietly re-pointing this path at
 * a handler is the failure this guards against — the gates it used to run
 * were deleted with it, so anything wired here now would create seats with no
 * email verification and no seat limit at all.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const ROUTE = 'server/routes/workspaceMembers.ts';

describe('the legacy accept-invitation route stays retired', () => {
  const source = readFileSync(ROUTE, 'utf8');

  it('answers 410, not 404', () => {
    // 404 would say "there was never anything here", which is false and
    // leaves an old client guessing. 410 says it existed and is gone.
    const responder = source.slice(source.indexOf('const legacyInvitationGone'));
    expect(responder.slice(0, 200)).toMatch(/res\.status\(410\)/);
  });

  it('names its replacement in the body', () => {
    const responder = source.slice(source.indexOf('const legacyInvitationGone'));
    expect(responder.slice(0, 200)).toContain("replacement: '/api/workspace-invitations'");
    expect(responder.slice(0, 200)).toContain('LEGACY_INVITATION_API_RETIRED');
  });

  it('every legacy invitation path is retired, not just this one', () => {
    for (const path of [
      "post(\n  '/accept-invitation',",
      "get('/invitations', legacyInvitationGone)",
      "post('/invitations', legacyInvitationGone)",
      "patch('/invitations/:id', legacyInvitationGone)",
      "delete('/invitations/:id', legacyInvitationGone)",
    ]) {
      expect(source).toContain(path);
    }
  });

  it('carries no stranded seat-creation middleware', () => {
    // The gates went with the route. Middleware that no longer runs reads
    // like a live guard, and the next person to point this path at a
    // handler would inherit gates that were never wired — creating seats
    // with no verified email and no `max_agents` check.
    expect(source).not.toMatch(/resolveInvitationContext/);
    expect(source).not.toMatch(/maxAgentsLimitMw/);
    expect(source).not.toMatch(/email_verification_required/);
  });

  it('the replacement actually accepts invitations', () => {
    // A pointer to a route that cannot do the job is worse than no pointer.
    const replacement = readFileSync('server/routes/workspaceInvitations.ts', 'utf8');
    expect(replacement).toMatch(/\.post\('\/accept-new'/);
    expect(replacement).toMatch(/\.post\('\/accept-existing'/);
  });
});
