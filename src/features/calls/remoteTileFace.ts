/**
 * The operator console's remote tile (OperatorMediaConsole): who is on the
 * other side of the call, as a face.
 *
 * The visitor wears their initial, taken from their details (the call's name,
 * e-mail or phone) or from their own identity in the room. A team member who
 * joins during a transfer or a supervision is in the room too, as
 * `operator:`, `admin:` or `internal:` and an opaque reference
 * (server/services/calls/operatorIdentity.ts): never a letter from that, and
 * when only team members are left on the other side, the person silhouette
 * (owner, 2026-10-24).
 */

/** A team member's identity in a call room. */
const TEAM_IDENTITY = /^(?:operator|admin|internal):/i;

export function isTeamIdentity(identity: string): boolean {
  return TEAM_IDENTITY.test(identity);
}

export type RemoteTileFace = { letter: string } | { glyph: 'person' };

export function remoteTileFace(visitorName: string | null | undefined, remoteIdentities: readonly string[]): RemoteTileFace {
  const visitorIdentity = remoteIdentities.find((id) => !isTeamIdentity(id));
  if (!visitorName && !visitorIdentity && remoteIdentities.length > 0) return { glyph: 'person' };
  return { letter: (visitorName || visitorIdentity || 'V').slice(0, 1).toUpperCase() };
}
