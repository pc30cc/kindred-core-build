/**
 * WORKSPACE INVITATIONS v5.1 — B.1/B.6 client request-id proofs.
 *
 * The Express API refuses every retryable mutation without a stable UUID
 * requestId. These tests prove the client contract:
 *   - one UUID per logical action, reused by retries,
 *   - a genuinely new action mints a new UUID,
 *   - request IDs (and invitation secrets) never touch persistent storage,
 *   - every public invitation mutation in InvitePage sends a requestId.
 */
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { createRequestIdBook } from '../features/invitations/requestIds';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const read = (p: string) => readFileSync(p, 'utf8');
const INVITE_PAGE = read('src/pages/auth/InvitePage.tsx');
const MANAGEMENT = read('src/features/invitations/InvitationManagement.tsx');
const TEAM_PAGE = read('src/pages/app/TeamPage.tsx');
const DEPARTMENTS_PAGE = read('src/pages/app/settings/TeamDepartmentsPage.tsx');

describe('request-id book', () => {
  it('mints a UUID per logical action and reuses it across retries', () => {
    const book = createRequestIdBook();
    const first = book.get('otp_request', 'invitation-1');
    expect(first).toMatch(UUID_RE);
    expect(book.get('otp_request', 'invitation-1')).toBe(first);
    expect(book.get('otp_request', 'invitation-1')).toBe(first);
  });

  it('mints a new UUID when the intent materially changes', () => {
    const book = createRequestIdBook();
    const withCodeA = book.get('otp_verify', 'code-a');
    const withCodeB = book.get('otp_verify', 'code-b');
    expect(withCodeB).not.toBe(withCodeA);
    // …and going back to the previous intent is still a NEW logical action.
    expect(book.get('otp_verify', 'code-a')).not.toBe(withCodeA);
  });

  it('reset() marks a deliberate second action (explicit resend)', () => {
    const book = createRequestIdBook();
    const first = book.get('otp_request', 'inv');
    book.reset('otp_request');
    const second = book.get('otp_request', 'inv');
    expect(second).not.toBe(first);
    expect(second).toMatch(UUID_RE);
  });

  it('keys are independent of one another', () => {
    const book = createRequestIdBook();
    expect(book.get('accept_new', 'x')).not.toBe(book.get('accept_existing', 'x'));
  });
});

describe('InvitePage request-id wiring', () => {
  const endpoints = ['/otp/request', '/otp/verify', '/login-context', '/accept-new', '/accept-existing'];

  it('sends a requestId on every public invitation mutation', () => {
    for (const endpoint of endpoints) {
      const at = INVITE_PAGE.indexOf(endpoint);
      expect(at, `${endpoint} must be called`).toBeGreaterThan(-1);
      // The request body built right after the call site carries a requestId.
      const window = INVITE_PAGE.slice(at, at + 700);
      expect(window, `${endpoint} must send requestId`).toContain('requestId');
    }
  });

  it('never persists request IDs or invitation secrets', () => {
    // Comments may mention the rule; only real accesses are a violation.
    for (const source of [INVITE_PAGE, MANAGEMENT, DEPARTMENTS_PAGE]) {
      const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      expect(code).not.toMatch(/(?:window\.)?localStorage\s*[.[]/);
      expect(code).not.toMatch(/(?:window\.)?sessionStorage\s*[.[]/);
      expect(code).not.toMatch(/document\.cookie/);
    }
  });

  it('never logs tokens, codes, passwords, proofs or context handles', () => {
    const forbidden = /console\.(log|info|warn|error)\([^)]*\b(token|code|password|proof|handle|requestId)\b/i;
    for (const source of [INVITE_PAGE, MANAGEMENT, DEPARTMENTS_PAGE]) {
      expect(source).not.toMatch(forbidden);
    }
  });

  it('legacy /team is only a redirect to the canonical surface', () => {
    expect(TEAM_PAGE).toContain('Navigate');
    expect(TEAM_PAGE).not.toContain('workspace-invitations');
  });

  it('management surfaces take their request IDs from the shared book, not inline UUIDs', () => {
    for (const source of [MANAGEMENT, DEPARTMENTS_PAGE]) {
      expect(source).toContain('useRequestIdBook');
      expect(source).not.toMatch(/requestId:\s*crypto\.randomUUID\(\)/);
    }
  });
});
