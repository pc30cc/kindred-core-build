import { describe, it, expect } from 'vitest';
import { mergeStatus } from './intelligence';
import {
  VISITOR_LIVENESS_ONLINE_MS,
  VISITOR_LIVENESS_OFFLINE_MS,
} from '../widget/visitorLiveness';

const ago = (ms: number) => new Date(Date.now() - ms).toISOString();

describe('mergeStatus — liveness boundaries', () => {
  it('239s old with stored status online => online', () => {
    expect(mergeStatus('online', ago(239_000), ago(239_000))).toBe('online');
  });

  it('just under the idle threshold => online', () => {
    expect(mergeStatus('online', ago(VISITOR_LIVENESS_ONLINE_MS - 1_000), ago(0))).toBe('online');
  });

  it('past the idle threshold but under offline => idle', () => {
    expect(mergeStatus('online', ago(VISITOR_LIVENESS_ONLINE_MS + 1_000), ago(0))).toBe('idle');
    expect(mergeStatus('online', ago(5 * 60_000), ago(0))).toBe('idle');
  });

  it('past the offline threshold => offline even if the DB still says online', () => {
    expect(mergeStatus('online', ago(VISITOR_LIVENESS_OFFLINE_MS + 1_000), ago(0))).toBe('offline');
    expect(mergeStatus('online', ago(60 * 60_000), ago(0))).toBe('offline');
  });

  it('falls back to session last_seen_at when presence has no timestamp', () => {
    expect(mergeStatus('online', null, ago(VISITOR_LIVENESS_OFFLINE_MS + 1_000))).toBe('offline');
    expect(mergeStatus('online', null, ago(1_000))).toBe('online');
  });

  it('keeps the stored status when fresh, and unknown when absent', () => {
    expect(mergeStatus('idle', ago(1_000), ago(1_000))).toBe('idle');
    expect(mergeStatus(null, ago(1_000), ago(1_000))).toBe('unknown');
  });
});
