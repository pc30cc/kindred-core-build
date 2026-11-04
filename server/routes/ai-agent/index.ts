/**
 * AI Agent — top-level router (Phase 3 mechanical split).
 *
 * Mounts the two security-sensitive global middleware layers exactly as the
 * original monolithic server/routes/aiAgent.ts did — BEFORE any domain
 * subrouter — followed by each domain subrouter mounted with NO path
 * prefix, so every existing external route path is unchanged.
 *
 *   request
 *     -> ADVANCED_PATH_PATTERNS guard
 *     -> aiAgentPlatformGuard()
 *     -> domain subrouter (route-specific auth / module / rate-limit / handler)
 *
 * Same routes, same paths, same middleware order, same authorization, same
 * rate limits, same response shapes. No behavior change.
 */
import express, { type Request, type Response, type Router } from 'express';
import type { ServerConfig } from '../../config.js';
import {
  canAccessAiAgentAdvancedToolsServer,
  canAccessAiAgentPlatformPagesServer,
} from '../../services/ai-agent/customerSafe.js';
import {
  aiAgentPlatformGuard,
  normalizeAiAgentGuardPath,
  resolveAiAgentRequestWorkspace,
} from '../../services/ai-agent/platformGuards.js';
import { resolveCurrentUserId } from './shared.js';
import { platformRouter } from './platform.js';
import { assistantRouter } from './assistant.js';
import { activityRouter } from './activity.js';
import { operatorAssistRouter } from './operatorAssist.js';
import { knowledgeRouter } from './knowledge.js';
import { automationRouter } from './automation.js';
import { internalQaRouter } from './internalQa.js';
import { humanGuidanceRouter } from './humanGuidance.js';

export const aiAgentRouter: Router = express.Router();

// ─── Backend advanced-tools guard ───
// The rule of the frontend AdvancedAiAgentGuard (shared/aiAdvancedTools.ts).
// Endpoints that expose internal QA/debug/regression data MUST go through
// this guard. Registered IMMEDIATELY after router creation so it runs before
// every matching route handler.
//   - `/platform/*` (the Super Admin's AI Control Center settings and
//     counters): the Super Admin only, never a plan's.
//   - everything else here (the Advanced tools): the Super Admin, or the
//     workspace's plan has `ai_advanced_tools` and the caller is its owner or
//     an admin (owner, 2026-11-03). The workspace judged is the one the
//     handler acts on (resolveAiAgentRequestWorkspace: the resource named by
//     id, or the one workspace id the request names), so a member of a
//     workspace with the key never reaches another workspace's QA data.
const ADVANCED_PATH_PATTERNS: RegExp[] = [
  /^\/runs\/[^/]+\/inspect$/i,
  /^\/debug\/retrieval$/i,
  /^\/debug\/run-test$/i,
  /^\/source-health$/i,
  /^\/test-cases(\/|$)/i,
  /^\/test-runs(\/|$)/i,
  /^\/suggested-test-cases(\/|$)/i,
  /^\/regression(\/|$)/i,
  /^\/test-summary$/i,
  /^\/platform\/settings$/i,
  /^\/platform\/ai-proactive-stats$/i,
];
aiAgentRouter.use(async (req: Request, res: Response, next) => {
  // Match on the normalized path: Express routes are case-insensitive and
  // non-strict, so `/Platform/settings` or `/platform/settings/` reach the
  // same handlers and must not slip past these `$`-anchored patterns.
  const guardPath = normalizeAiAgentGuardPath(req.path);
  if (!ADVANCED_PATH_PATTERNS.some((rx) => rx.test(guardPath))) return next();
  const config = (req as Request & { serverConfig?: ServerConfig }).serverConfig as ServerConfig;
  const { userId } = await resolveCurrentUserId(req, config);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  // The Super Admin (and the non-production override) pass everything here,
  // whatever workspace the request names, as before.
  if (await canAccessAiAgentPlatformPagesServer(config, userId)) return next();
  // Platform pages are never a plan's.
  if (guardPath.startsWith('/platform/')) {
    return res.status(403).json({ error: 'advanced_ai_tools_not_available' });
  }
  const target = await resolveAiAgentRequestWorkspace(config, req);
  if (target.ok === false) {
    // Two different workspace ids named: said so. An unreadable resource: a
    // retryable 503. Anything else (no workspace named, a missing resource,
    // another workspace's resource): no, as for a plan without the key.
    if (target.error === 'workspace_id_mismatch' && target.status === 400) {
      return res.status(400).json({ error: target.error });
    }
    if (target.status === 503) return res.status(503).json({ error: target.error });
    return res.status(403).json({ error: 'advanced_ai_tools_not_available' });
  }
  const ok = await canAccessAiAgentAdvancedToolsServer(config, userId, target.workspaceId);
  if (!ok) return res.status(403).json({ error: 'advanced_ai_tools_not_available' });
  return next();
});

// Combined platform kill-switch + per-feature platform guard. Resolves
// workspaceId from query/body OR from :id route params, then enforces:
//   - global kill switch (ai_agent_enabled / customer_ai_agent_visible)
//   - per-feature platform toggles (files/websites/qna/operator-assist/
//     learning/kb)
// The Advanced tools (regression/test-harness/source-health) are not
// platform-switched any more: the guard above (the plan rule) opens them.
// Super admins bypass the plan gate and the customer-visibility switch.
aiAgentRouter.use(aiAgentPlatformGuard());

aiAgentRouter.use(platformRouter);
aiAgentRouter.use(assistantRouter);
aiAgentRouter.use(activityRouter);
aiAgentRouter.use(operatorAssistRouter);
aiAgentRouter.use(knowledgeRouter);
aiAgentRouter.use(automationRouter);
aiAgentRouter.use(internalQaRouter);
// vNext — private operator → AI guidance for a single conversation.
aiAgentRouter.use(humanGuidanceRouter);
