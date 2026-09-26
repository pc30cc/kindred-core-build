// ============================================
// Trusted workspace pin for the feature/limit gates.
//
// In-handler callers (widget, attachments, storage, limit helpers) that have
// ALREADY authorized a workspace pin it on the request before invoking a
// gate from featureGating.ts. The gate then evaluates that workspace only
// and ignores every request-supplied workspaceId/workspace_id field, so a
// stray `"workspaceId"` in the body can never redirect a limit check to a
// different (e.g. unlimited) workspace.
//
// Kept in its own module (not featureGating.ts) so tests that vi.mock the
// gating module keep working without having to stub this helper.
// ============================================

import type { Request } from 'express';

/** Symbol-keyed so no JSON body / query string can forge it. */
const TRUSTED_GATE_WORKSPACE_ID = Symbol('featureGating.trustedWorkspaceId');

/** A request carrying (or about to carry) the trusted pin. */
type PinnedRequest = Request & { [TRUSTED_GATE_WORKSPACE_ID]?: unknown };

export function setTrustedGateWorkspaceId(req: Request, workspaceId: string): void {
  (req as PinnedRequest)[TRUSTED_GATE_WORKSPACE_ID] = workspaceId;
}

export function getTrustedGateWorkspaceId(req: Request): string | undefined {
  const v = (req as PinnedRequest | null | undefined)?.[TRUSTED_GATE_WORKSPACE_ID];
  return typeof v === 'string' && v ? v : undefined;
}
