/**
 * Phase 9 — Operator-side Call Invitation routes.
 *
 *   POST /api/call-invitations              create invitation
 *   POST /api/call-invitations/:id/cancel   cancel pending invitation
 *   GET  /api/call-invitations/:id          read invitation status
 *   GET  /api/call-invitations?conversation_id=...  list per conversation
 *
 * Auth: first-party session cookie + workspace membership. All writes go
 * through the service-role-backed invitations service.
 */
import { Router, type Request, type Response } from 'express';
import { z } from 'zod';
import type { ServerConfig } from '../config.js';
import {
  createInvitation,
  cancelInvitation,
  getInvitationById,
  listInvitationsForConversation,
  getInvitationTtlSeconds,
  INVITE_TTL_MIN_SECONDS,
  INVITE_TTL_MAX_SECONDS,
} from '../services/calls/invitations.js';
import { loadEffectiveCallEntitlements } from '../services/calls/entitlementComposer.js';
import { checkPlanConcurrencyCeiling, planConcurrencyDenialBody } from '../services/calls/concurrencyLimit.js';
import { requireUser as requireSessionUser, authorizeWorkspaceAccess } from '../lib/workspaceAuth.js';

export const callInvitationsRouter = Router();

type ReqWithConfig = Request & { serverConfig: ServerConfig };

async function requireAuth(
  req: Request,
  res: Response,
  _config: ServerConfig,
): Promise<{ userId: string } | null> {
  const userId = await requireSessionUser(req, res);
  if (!userId) return null;
  return { userId };
}

/**
 * Membership the way every workspace route checks it (audit 2026-11-04,
 * calls-11): a suspended member, or one past the plan's seats, is refused,
 * which `is_workspace_member` alone did not do. Writes the refusal itself.
 */
async function assertWorkspaceMember(
  req: Request,
  res: Response,
  workspaceId: string,
): Promise<boolean> {
  return !!(await authorizeWorkspaceAccess(req, res, workspaceId));
}

const createSchema = z.object({
  workspace_id: z.string().uuid(),
  conversation_id: z.string().uuid(),
  channel: z.enum(['audio', 'video']),
  /** Optional operator-chosen TTL. Clamped server-side. */
  ttl_seconds: z
    .number()
    .int()
    .min(INVITE_TTL_MIN_SECONDS)
    .max(INVITE_TTL_MAX_SECONDS)
    .optional(),
});

callInvitationsRouter.post('/', async (req, res) => {
  const config = (req as unknown as ReqWithConfig).serverConfig;
  const auth = await requireAuth(req, res, config);
  if (!auth) return;
  const parsed = createSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_payload', details: parsed.error.flatten() });
  }
  const { workspace_id, conversation_id, channel, ttl_seconds } = parsed.data;
  if (!(await assertWorkspaceMember(req, res, workspace_id))) return;
  // Phase: Call Route Enforcement Rollout — strict deny-on-create only.
  // Composes plan (voice_video + voice/video channel) AND runtime
  // (loadEffectiveCallChannels) via the canonical composer. Cancel/get/list
  // routes intentionally remain ungated so in-flight invitations stay
  // visible and cancellable after a downgrade.
  const eff = await loadEffectiveCallEntitlements(config, workspace_id);
  const allowed = channel === 'audio' ? eff.voice_enabled : eff.video_enabled;
  if (!allowed) {
    return res.status(403).json({
      error: 'plan_forbidden',
      capability: channel === 'audio' ? 'voice' : 'video',
      upgrade_required: true,
    });
  }
  // The plan's max_concurrent_calls, refused up front as /api/calls/create
  // refuses it, so a visitor is not invited into a call their accept would
  // be refused (the accept checks again under the workspace's lock,
  // widgetCallInvitations.ts).
  const conc = await checkPlanConcurrencyCeiling(config, workspace_id);
  if (!conc.allowed) {
    return res.status(conc.reason === 'plan_limit_reached' ? 429 : 403).json(planConcurrencyDenialBody(conc));
  }
  const result = await createInvitation(config, {
    workspaceId: workspace_id,
    conversationId: conversation_id,
    operatorUserId: auth.userId,
    channel,
    ttlSeconds: ttl_seconds ?? null,
  });
  if (!result.ok) {
    return res.status(409).json({ error: (result as { ok: false; reason: string }).reason });
  }
  return res.json({
    invitation: result.invitation,
    ttl_seconds: ttl_seconds ?? getInvitationTtlSeconds(),
  });
});

callInvitationsRouter.post('/:id/cancel', async (req, res) => {
  const config = (req as unknown as ReqWithConfig).serverConfig;
  const auth = await requireAuth(req, res, config);
  if (!auth) return;
  const inv = await getInvitationById(config, req.params.id);
  if (!inv) return res.status(404).json({ error: 'not_found' });
  if (!(await assertWorkspaceMember(req, res, inv.workspace_id))) return;
  const result = await cancelInvitation(config, inv.id, auth.userId);
  if (!result.ok) return res.status(409).json({ error: result.reason });
  return res.json({ invitation: result.invitation });
});

callInvitationsRouter.get('/:id', async (req, res) => {
  const config = (req as unknown as ReqWithConfig).serverConfig;
  const auth = await requireAuth(req, res, config);
  if (!auth) return;
  const inv = await getInvitationById(config, req.params.id);
  if (!inv) return res.status(404).json({ error: 'not_found' });
  if (!(await assertWorkspaceMember(req, res, inv.workspace_id))) return;
  return res.json({ invitation: inv });
});

callInvitationsRouter.get('/', async (req, res) => {
  const config = (req as unknown as ReqWithConfig).serverConfig;
  const auth = await requireAuth(req, res, config);
  if (!auth) return;
  const conversationId = (req.query.conversation_id as string) || '';
  if (!conversationId) return res.status(400).json({ error: 'conversation_id required' });
  const items = await listInvitationsForConversation(config, conversationId);
  if (items.length === 0) return res.json({ invitations: [] });
  if (!(await assertWorkspaceMember(req, res, items[0].workspace_id))) return;
  return res.json({ invitations: items });
});