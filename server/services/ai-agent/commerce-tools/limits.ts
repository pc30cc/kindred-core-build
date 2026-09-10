/**
 * Hard per-turn bounds for commerce tool execution (docs/commerce/
 * CONNECTOR_PROTOCOL.md §AI tool registry). Mirrors the existing
 * MAX_ACTIONS_PER_TURN bounding philosophy in
 * server/services/ai-agent/actions/planner.ts — no unbounded agent loop.
 */
export const MAX_COMMERCE_CALLS_PER_TURN = 3;
export const MAX_RESULTS_PER_TOOL = 8;
export const MAX_SERIALIZED_BYTES_PER_TOOL = 12_000;
export const COMMERCE_TOOL_DEADLINE_MS = 6_000;
