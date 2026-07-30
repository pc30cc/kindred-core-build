/**
 * Helpers for interpreting the AI knowledge file delete response.
 * Kept in a module of its own so page components stay component-only.
 */
import { AiAgentApiError } from '@/lib/ai-agent-api';

/** Reads a backend error code from a structured API error, safely. */
export function readApiErrorCode(err: unknown, fallback: string): string {
  if (err instanceof AiAgentApiError) {
    const body = err.body;
    if (body && typeof body === 'object') {
      const value = (body as Record<string, unknown>).error;
      if (typeof value === 'string' && value) return value;
    }
    return err.code || err.message || fallback;
  }
  if (err instanceof Error && err.message) return err.message;
  return fallback;
}

/**
 * The record delete always succeeded when the endpoint returned 2xx.
 * Storage cleanup is best-effort: it only counts as incomplete when the
 * backend reports a real storage error (a source with no stored object
 * returns storage_deleted:false without an error and is fully deleted).
 */
export function isStorageCleanupIncomplete(
  result: { storage_deleted?: boolean; storage_error?: string } | null | undefined,
): boolean {
  if (!result) return false;
  if (result.storage_deleted) return false;
  return !!result.storage_error && result.storage_error !== 'already_deleted';
}
