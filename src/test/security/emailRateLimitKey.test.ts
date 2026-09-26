/**
 * The email rate limit cannot be dodged by naming a workspace.
 *
 * emailRateLimiter guards both /api/email (authenticated, per workspace) and
 * the unauthenticated /api/auth-email routes (verification, password reset,
 * one-time codes). Its bucket used to be `body.workspaceId` whenever one was
 * sent, so on /api/auth-email a caller got a fresh 10/min bucket per request
 * by sending any random value.
 */
import { describe, it, expect } from 'vitest';
import { emailRateLimitKey } from '../../../server/middleware/security';

type EmailRequest = Parameters<typeof emailRateLimitKey>[0];
const req = (baseUrl: string, body: Record<string, unknown> = {}, ip = '203.0.113.7') =>
  ({ baseUrl, body, ip }) as unknown as EmailRequest;

describe('emailRateLimitKey', () => {
  it('ignores a client-sent workspaceId on the unauthenticated auth-email routes', () => {
    const a = emailRateLimitKey(req('/api/auth-email', { workspaceId: 'ws-random-1' }));
    const b = emailRateLimitKey(req('/api/auth-email', { workspaceId: 'ws-random-2' }));
    expect(a).toBe(b);
    expect(a).toBe(emailRateLimitKey(req('/api/auth-email')));
    expect(a).not.toContain('ws-random');
  });

  it('keeps one bucket per workspace on /api/email, where the route checks access', () => {
    expect(emailRateLimitKey(req('/api/email', { workspaceId: 'ws-1' }))).toBe('email:ws-1');
  });

  it('falls back to the caller’s IP when no workspace is named', () => {
    const a = emailRateLimitKey(req('/api/email', {}, '203.0.113.7'));
    const b = emailRateLimitKey(req('/api/email', {}, '198.51.100.9'));
    expect(a).not.toBe(b);
  });
});
