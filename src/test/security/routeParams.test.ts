import { describe, it, expect } from 'vitest';
import { routeParam } from '../../../server/lib/routeParams';

describe('routeParam', () => {
  it('returns a plain string unchanged', () => {
    expect(routeParam('abc-123')).toBe('abc-123');
  });

  it('returns undefined for undefined', () => {
    expect(routeParam(undefined)).toBeUndefined();
  });

  it('rejects array values instead of collapsing them', () => {
    expect(routeParam(['a', 'b'])).toBeUndefined();
    expect(routeParam(['a'])).toBeUndefined();
    expect(routeParam([])).toBeUndefined();
  });

  it('passes the empty string through (callers treat it as falsy)', () => {
    expect(routeParam('')).toBe('');
    expect(routeParam('') || undefined).toBeUndefined();
  });
});
