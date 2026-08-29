/**
 * AI Agent API client — compatibility aggregate (Phase 4 split).
 *
 * Composes the 7 domain API objects into the same `aiAgentApi` surface
 * every existing caller already imports from '@/lib/ai-agent-api'. Method
 * keys, URLs, request bodies, and response types are identical to the
 * pre-split monolith -- this is a physical reorganization only.
 */
import { platformApi } from './platform.js';
import { assistantApi } from './assistant.js';
import { activityApi } from './activity.js';
import { operatorAssistApi } from './operatorAssist.js';
import { knowledgeApi } from './knowledge.js';
import { automationApi } from './automation.js';
import { internalQaApi } from './internalQa.js';
import { humanGuidanceApi } from './humanGuidance.js';

export const aiAgentApi = {
  ...platformApi,
  ...assistantApi,
  ...activityApi,
  ...operatorAssistApi,
  ...knowledgeApi,
  ...automationApi,
  ...internalQaApi,
  ...humanGuidanceApi,
};

export { AiAgentApiError } from './client.js';

export * from './platform.js';
export * from './assistant.js';
export * from './activity.js';
export * from './operatorAssist.js';
export * from './knowledge.js';
export * from './automation.js';
export * from './internalQa.js';
export * from './humanGuidance.js';
