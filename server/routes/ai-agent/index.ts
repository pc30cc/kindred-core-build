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
import { canAccessAiAgentAdvancedToolsServer } from '../../services/ai-agent/customerSafe.js';
import { aiAgentPlatformGuard } from '../../services/ai-agent/platformGuards.js';
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
// Mirrors the frontend AdvancedAiAgentGuard. Endpoints that expose internal
// QA/debug/regression data MUST go through this guard.
// Registered IMMEDIATELY after router creation so it runs before every
// matching route handler.
const ADVANCED_PATH_PATTERNS: RegExp[] = [
  /^\/runs\/[^/]+\/inspect$/,
  /^\/debug\/retrieval$/,
  /^\/debug\/run-test$/,
  /^\/source-health$/,
  /^\/test-cases(\/|$)/,
  /^\/test-runs(\/|$)/,
  /^\/suggested-test-cases(\/|$)/,
  /^\/regression(\/|$)/,
  /^\/test-summary$/,
  /^\/platform\/settings$/,
  /^\/platform\/ai-proactive-stats$/,
];
aiAgentRouter.use(async (req: Request, res: Response, next) => {
  if (!ADVANCED_PATH_PATTERNS.some((rx) => rx.test(req.path))) return next();
  const config = (req as any).serverConfig as ServerConfig;
  const { userId } = await resolveCurrentUserId(req, config);
  if (!userId) return res.status(401).json({ error: 'unauthenticated' });
  const workspaceId = String(
    req.query.workspaceId || req.query.workspace_id || (req.body && req.body.workspaceId) || '',
  );
  const ok = await canAccessAiAgentAdvancedToolsServer(config, userId, workspaceId);
  if (!ok) return res.status(403).json({ error: 'advanced_ai_tools_not_available' });
  return next();
});

// Combined platform kill-switch + per-feature platform guard. Resolves
// workspaceId from query/body OR from :id route params, then enforces:
//   - global kill switch (ai_agent_enabled / customer_ai_agent_visible)
//   - per-feature platform toggles (files/websites/qna/operator-assist/
//     learning/regression/test-harness/source-health/kb)
// Super admins bypass the advanced/regression/test/source-health gates.
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
