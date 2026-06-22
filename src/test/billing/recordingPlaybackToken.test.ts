/**
 * Backend test — short-lived HMAC playback tokens.
 * Verifies:
 *   • valid tokens round-trip
 *   • tampered ids / dispositions / signatures are rejected
 *   • expired tokens are rejected
 *   • tokens minted by one secret cannot be validated under another
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mintPlaybackToken,
  verifyPlaybackToken,
} from '../../../server/services/calls/recordingPlaybackToken';

const cfg = { supabaseServiceRoleKey: 'secret-A' } as any;
const otherCfg = { supabaseServiceRoleKey: 'secret-B' } as any;
const RID = '11111111-1111-1111-1111-111111111111';

afterEach(() => vi.useRealTimers());

describe('recordingPlaybackToken', () => {
  it('round-trips a valid token', () => {
    const tok = mintPlaybackToken(cfg, { recordingId: RID });
    const v = verifyPlaybackToken(cfg, RID, tok.token);
    expect(v.ok).toBe(true);
    if (v.ok) {
      expect(v.claims.recordingId).toBe(RID);
      expect(v.claims.disposition).toBe('inline');
    }
  });

  it('rejects when the recording id in the path does not match the signed id', () => {
    const tok = mintPlaybackToken(cfg, { recordingId: RID });
    const v = verifyPlaybackToken(cfg, '22222222-2222-2222-2222-222222222222', tok.token);
    expect(v.ok).toBe(false);
  });

  it('rejects a token signed with a different secret', () => {
    const tok = mintPlaybackToken(otherCfg, { recordingId: RID });
    const v = verifyPlaybackToken(cfg, RID, tok.token);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('bad_signature');
  });

  it('rejects an expired token', () => {
    const tok = mintPlaybackToken(cfg, { recordingId: RID, ttlSeconds: 30 });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.now() + 60_000));
    const v = verifyPlaybackToken(cfg, RID, tok.token);
    expect(v.ok).toBe(false);
    expect(v.ok === false && v.reason).toBe('expired');
  });

  it('rejects a tampered disposition claim', () => {
    const tok = mintPlaybackToken(cfg, { recordingId: RID, disposition: 'inline' });
    const parts = tok.token.split('.');
    parts[1] = 'attachment';
    const v = verifyPlaybackToken(cfg, RID, parts.join('.'));
    expect(v.ok).toBe(false);
  });

  it('rejects malformed tokens', () => {
    expect(verifyPlaybackToken(cfg, RID, undefined).ok).toBe(false);
    expect(verifyPlaybackToken(cfg, RID, 'garbage').ok).toBe(false);
    expect(verifyPlaybackToken(cfg, RID, 'v1.inline.notanumber.sig').ok).toBe(false);
  });
});