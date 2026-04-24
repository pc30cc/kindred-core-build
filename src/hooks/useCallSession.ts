/**
 * Phase — Inbox Call Unification
 *
 * Thin re-export — the engine instance now lives in CallSessionProvider
 * so a single engine is shared between OperatorCallPanel (per conversation)
 * and IncomingCallSurface (workspace-level). This file is kept for
 * backwards compatibility with any consumer importing useCallSession.
 */
import { useCallSessionContext, type CallSessionContextValue } from '@/features/calls/CallSessionProvider';

export type UseCallSessionApi = CallSessionContextValue;

export function useCallSession(): UseCallSessionApi {
  return useCallSessionContext();
}