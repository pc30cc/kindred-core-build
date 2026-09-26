import { describe, it, expect } from 'vitest';
import { shouldRetryQuery, httpStatusOf } from '@/lib/queryRetry';

const withStatus = (status: number) => Object.assign(new Error(`API error: ${status}`), { status });

describe('shouldRetryQuery', () => {
  it.each([400, 401, 403, 404, 409, 422])('never retries a %i — the answer will not change', (status) => {
    expect(shouldRetryQuery(0, withStatus(status))).toBe(false);
  });

  it.each([408, 429, 500, 502, 503])('retries a %i up to three times', (status) => {
    expect(shouldRetryQuery(0, withStatus(status))).toBe(true);
    expect(shouldRetryQuery(2, withStatus(status))).toBe(true);
    expect(shouldRetryQuery(3, withStatus(status))).toBe(false);
  });

  it('keeps the default for errors without a status (network failures, PostgREST errors)', () => {
    expect(shouldRetryQuery(0, new TypeError('Failed to fetch'))).toBe(true);
    expect(shouldRetryQuery(0, { message: 'x', code: 'PGRST116' })).toBe(true);
    expect(shouldRetryQuery(3, new Error('boom'))).toBe(false);
  });

  it('reads statusCode too, and ignores values that are not HTTP statuses', () => {
    expect(httpStatusOf({ statusCode: 404 })).toBe(404);
    expect(httpStatusOf({ status: 'forbidden' })).toBeNull();
    expect(httpStatusOf({ status: 42 })).toBeNull();
    expect(httpStatusOf(null)).toBeNull();
  });
});
