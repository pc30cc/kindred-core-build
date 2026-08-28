/**
 * Core-side entrypoint for credential redaction.
 *
 * The implementation lives in `shared/security/redactSecrets.ts` so the AI
 * Runtime deployable (which ships no `server/` code) can use the exact same
 * rules. This file stays as the stable Core import path.
 */
export { redactSecrets } from '../../shared/security/redactSecrets.js';
