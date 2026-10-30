/**
 * The email rate limit cannot be dodged, or aimed at someone else, by naming
 * a workspace.
 *
 * emailRateLimiter guards /api/email (the test buttons) and the public
 * /api/auth-email routes (verification, password reset, one-time codes). It
 * runs before any route has authenticated anybody, so its bucket is the
 * caller's IP and nothing else: it used to be `body.workspaceId` whenever
 * one was sent, which on /api/auth-email gave a fresh 10/min bucket per
 * request to anyone sending a random value, and on /api/email let anyone
 * use up a workspace's bucket without being its member.
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

  it('ignores it on /api/email too: one bucket per IP, whatever workspace is named', () => {
    const a = emailRateLimitKey(req('/api/email', { workspaceId: '11111111-1111-4111-8111-111111111111' }));
    const b = emailRateLimitKey(req('/api/email', { workspaceId: '22222222-2222-4222-8222-222222222222' }));
    expect(a).toBe(b);
    expect(a).not.toContain('1111');
    expect(a).toBe(emailRateLimitKey(req('/api/email')));
  });

  it('two callers have two buckets', () => {
    const a = emailRateLimitKey(req('/api/email', {}, '203.0.113.7'));
    const b = emailRateLimitKey(req('/api/email', {}, '198.51.100.9'));
    expect(a).not.toBe(b);
  });

  it('no body field is read at all', () => {
    const body = new Proxy({}, { get: () => { throw new Error('the body was read'); } });
    expect(() => emailRateLimitKey(req('/api/email', body as Record<string, unknown>))).not.toThrow();
  });
});
