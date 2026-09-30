import { describe, expect, it } from 'vitest';
import { checkAbusePattern } from '../../../server/middleware/security';

/**
 * Abuse detection counts per IP, in two buckets: anonymous traffic keeps the
 * tight 500-per-5-minutes budget; requests carrying a session credential get
 * a larger one (a signed-in dashboard polls on timers), still keyed by IP so
 * rotating unverified tokens cannot open unlimited buckets.
 */
function req(ip: string, token?: string) {
  return { ip, headers: token ? { authorization: `Bearer ${token}` } : {}, cookies: {} } as never;
}

function hitsUntilFlag(make: (i: number) => never, max: number): number | null {
  for (let i = 1; i <= max; i++) {
    if (checkAbusePattern(make(i)).suspicious) return i;
  }
  return null;
}

describe('checkAbusePattern buckets', () => {
  it('flags anonymous traffic from one IP after 500 requests', () => {
    expect(hitsUntilFlag(() => req('198.51.100.1'), 600)).toBe(501);
  });

  it('gives signed-in traffic from one IP (an office NAT) a larger budget', () => {
    expect(hitsUntilFlag(() => req('198.51.100.2', 'tok'), 4000)).toBeNull();
  });

  it('does not let rotating fake tokens escape the per-IP credentialed bucket', () => {
    expect(hitsUntilFlag((i) => req('198.51.100.3', `fake-${i}`), 6000)).toBe(5001);
  });

  it('reports each bucket once per window', () => {
    const ip = '198.51.100.4';
    for (let i = 0; i < 500; i++) checkAbusePattern(req(ip));
    expect(checkAbusePattern(req(ip)).report).toBe(true);
    expect(checkAbusePattern(req(ip)).report).toBe(false);
  });
});
