/**
 * Shared credential redaction for anything that may embed provider or network
 * error detail: ai_agent_runs.error_message, ai_usage_logs.error_message,
 * provider connection-test results and console diagnostics.
 *
 * DEPLOYMENT NOTE: this module lives in `shared/` on purpose. The AI Runtime
 * image (Dockerfile.ai) ships `ai-runtime/`, `runtime/` and `shared/` ONLY —
 * it contains no `server/` code — so anything the runtime needs must live
 * here. An import of `server/**` from the runtime is a boot failure
 * (ERR_MODULE_NOT_FOUND), enforced by the runtime boundary architecture test.
 *
 * Deliberately narrow: it targets credential-shaped material only so ordinary
 * diagnostics ("model not found", "429 rate limit") stay readable.
 */

const RULES: [RegExp, string][] = [
  // OpenAI-style keys (sk-/rk-/pk-), incl. project keys.
  [/\b(?:sk|rk|pk)-[A-Za-z0-9_\-]{8,}/g, '[redacted]'],
  // Google API keys.
  [/\bAIza[0-9A-Za-z_\-]{10,}/g, '[redacted]'],
  // Bearer / Authorization values.
  [/\b(bearer)\s+[A-Za-z0-9._\-~+/=]{6,}/gi, '$1 [redacted]'],
  [/\b(authorization)\b\s*[:=]\s*[^\s,;"']+/gi, '$1: [redacted]'],
  // Header/field style credentials.
  [/\b(x-api-key|api[_-]?key|apikey|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|secret)\b\s*[:=]\s*["']?[^\s,;"']+["']?/gi, '$1: [redacted]'],
  // Query-string credentials.
  [/([?&](?:key|api_key|apikey|access_token|token|password|client_secret)=)[^&\s"']+/gi, '$1[redacted]'],
];

export function redactSecrets(raw: string | null | undefined): string | null {
  if (raw === null || raw === undefined) return null;
  let out = String(raw);
  for (const [re, replacement] of RULES) out = out.replace(re, replacement);
  return out.slice(0, 1000);
}
