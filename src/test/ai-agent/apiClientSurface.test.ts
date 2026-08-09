/**
 * Phase 4 — frontend AI API client split.
 *
 * Static parity test for the compatibility aggregate `aiAgentApi` composed
 * in src/lib/ai-agent/index.ts from the 7 domain API modules. Protects
 * against silently dropping, renaming, or duplicating a method key during
 * this or any future domain-module reorganization. The expected key list
 * is the exact inventory of the pre-split src/lib/ai-agent-api.ts (138
 * methods), captured before the split.
 */
import { describe, it, expect } from 'vitest';
import { aiAgentApi } from '@/lib/ai-agent-api';
import { platformApi } from '@/lib/ai-agent/platform';
import { assistantApi } from '@/lib/ai-agent/assistant';
import { activityApi } from '@/lib/ai-agent/activity';
import { operatorAssistApi } from '@/lib/ai-agent/operatorAssist';
import { knowledgeApi } from '@/lib/ai-agent/knowledge';
import { automationApi } from '@/lib/ai-agent/automation';
import { internalQaApi } from '@/lib/ai-agent/internalQa';

const EXPECTED_METHOD_KEYS = [
  "acceptSuggestedTestCase", "approveLearningCandidateAsLearned", "approveLearningCandidateAsQna",
  "bulkCreateQna", "cancelRegressionBatch", "cancelSourceJob", "convertLearningCandidateToKb",
  "convertLearningCandidateToKbV2", "convertLearningCandidateToQna", "createGuidance",
  "createMessageTrigger", "createQna", "createRouting", "createTestCase", "createTool",
  "createToolServer", "createTopic", "createWebsiteSource", "createWorkflow", "debugRetrieval",
  "debugRunTest", "deleteAiFile", "deleteDataSource", "deleteGuidance", "deleteMessageTrigger",
  "deleteQna", "deleteRouting", "deleteSuggestedTestCase", "deleteTestCase", "deleteTool",
  "deleteToolServer", "deleteTopic", "deleteWorkflow", "dismissSuggestion", "duplicateWorkflow",
  "e10_cancelBatch", "e10_retryFailed", "generateBusinessDescription", "generateLearningCandidates",
  "getAiFileLimits", "getAiFileLogs", "getAiFilePreview", "getAnalytics", "getAssistAnalytics",
  "getCapabilities", "getDataSourceJobs", "getDataSourceLimits", "getDataSourceLogs",
  "getDataSourcePages", "getDiagnostics", "getKnowledgeIndexStatus", "getKnowledgeStatus",
  "getLearningCandidateStats", "getOrCreateRegressionSchedule", "getOverview", "getPlatformSettings",
  "getRegressionBatch", "getRegressionOverview", "getRuns", "getRunsPaged", "getSettings",
  "getSourceHealth", "getTestRun", "getTestSummary", "getTrainOverview", "getWorkflowMeta",
  "getWorkspaceDomains", "inspectRun", "knowledgeCustomerSummary", "listAiFiles",
  "listConversationSuggestions", "listDataSources", "listGuidance", "listKnowledgeChunks",
  "listLearningCandidates", "listMessageTriggers", "listQna", "listRegressionBatches",
  "listRegressionSchedules", "listRouting", "listSuggestedTestCases", "listTestCases",
  "listTestRuns", "listToolServers", "listTools", "listTopics", "listWorkflows",
  "patchLearningCandidate", "pauseAiFile", "playground", "previewWorkflow", "rebuildKnowledgeIndex",
  "rebuildKnowledgeSource", "regressionBatchCsvUrl", "reindexAiFile", "reindexQna",
  "rejectLearningCandidate", "rejectLearningCandidateWithReason", "rejectSuggestedTestCase",
  "removeAvatar", "resumeAiFile", "retryFailedRegressionBatch", "retryFailedSourceJob",
  "runBulkTests", "runRegressionBatch", "runRegressionNow", "runTestCase", "seedDefaultTopics",
  "seedRecommendedTests", "submitAssistFeedback", "suggestReply", "suggestTestCaseFromFeedback",
  "suggestTestCaseFromTestRun", "syncDataSource", "syncKnowledgeSource", "takeOverConversation",
  "testAi", "testMessageTrigger", "testRun", "testToolServer", "testTopics", "updateDataSource",
  "updateGuidance", "updateMessageTrigger", "updatePlatformSettings", "updateQna",
  "updateRegressionSchedule", "updateRouting", "updateSettings", "updateTestCase", "updateTool",
  "updateToolServer", "updateTopic", "updateWorkflow", "uploadAiFile", "uploadAvatar",
  "useSuggestion", "validateWorkflow",
].sort();

describe('Phase 4 — aiAgentApi compatibility aggregate surface parity', () => {
  it('has exactly the same 138 method keys as the pre-split monolith', () => {
    expect(Object.keys(aiAgentApi).sort()).toEqual(EXPECTED_METHOD_KEYS);
  });

  it('has no missing or extra keys', () => {
    const actual = new Set(Object.keys(aiAgentApi));
    const expected = new Set(EXPECTED_METHOD_KEYS);
    const missing = EXPECTED_METHOD_KEYS.filter((k) => !actual.has(k));
    const extra = Object.keys(aiAgentApi).filter((k) => !expected.has(k));
    expect(missing).toEqual([]);
    expect(extra).toEqual([]);
  });

  it('no two domain modules export the same method key (no silent overwrite in the spread)', () => {
    const domains: Record<string, Record<string, unknown>> = {
      platform: platformApi,
      assistant: assistantApi,
      activity: activityApi,
      operatorAssist: operatorAssistApi,
      knowledge: knowledgeApi,
      automation: automationApi,
      internalQa: internalQaApi,
    };
    const seen = new Map<string, string>();
    const duplicates: Array<{ key: string; domains: string[] }> = [];
    for (const [domain, api] of Object.entries(domains)) {
      for (const key of Object.keys(api)) {
        if (seen.has(key)) {
          duplicates.push({ key, domains: [seen.get(key)!, domain] });
        } else {
          seen.set(key, domain);
        }
      }
    }
    expect(duplicates).toEqual([]);
  });

  it('every domain module method count sums to the total aggregate size', () => {
    const domainApis = [platformApi, assistantApi, activityApi, operatorAssistApi, knowledgeApi, automationApi, internalQaApi];
    const sum = domainApis.reduce((n, api) => n + Object.keys(api).length, 0);
    expect(sum).toBe(EXPECTED_METHOD_KEYS.length);
    expect(Object.keys(aiAgentApi).length).toBe(EXPECTED_METHOD_KEYS.length);
  });
});
