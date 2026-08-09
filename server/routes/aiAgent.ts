/**
 * AI Agent — Phase 3 router split compatibility re-export.
 *
 * The monolithic ~5,300-line router that used to live here has been
 * mechanically split into domain subrouters under ./ai-agent/. Same routes,
 * same paths, same middleware order, same authorization, same rate limits,
 * same response shapes, same services. See ./ai-agent/index.ts for the
 * assembled top-level router.
 */
export { aiAgentRouter } from './ai-agent/index.js';
