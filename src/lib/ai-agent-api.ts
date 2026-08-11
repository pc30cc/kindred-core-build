/**
 * AI Agent — operator-side API client (Phase 4 compatibility facade).
 *
 * The monolithic ~1,450-line client that used to live here has been
 * mechanically split into domain modules under ./ai-agent/. Same HTTP
 * requests, same URLs, same methods, same bodies, same response types,
 * same error behavior, same auth. See ./ai-agent/index.ts for the
 * assembled aiAgentApi aggregate and all re-exported types.
 */
export * from './ai-agent/index.js';
