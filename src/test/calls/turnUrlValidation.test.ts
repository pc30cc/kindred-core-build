import { describe, it, expect } from 'vitest';
import { assertUsableTurn } from '../../../server/services/calls/rtcResolver';

const creds = { username: 'u', credential: 'p' };

/**
 * The guard on the one field that can take every call down.
 *
 * `RTCPeerConnection` validates its ICE servers in the CONSTRUCTOR, so a bad
 * entry here does not degrade a call — it throws before the widget reaches
 * signalling, and every visitor gets nothing. This has happened in
 * production: a hostname pasted with no scheme produced
 * `'turn.destekly.tr' is not a valid URL` on every attempt, because the only
 * rule the field had was "not empty".
 */
describe('assertUsableTurn', () => {
  it('accepts an empty list — no relay is a valid state', () => {
    expect(() => assertUsableTurn({ urls: [] })).not.toThrow();
    expect(() => assertUsableTurn({})).not.toThrow();
  });

  it.each([
    'turn:turn.example.com:3478',
    'turns:turn.example.com:5349?transport=tcp',
    'turn:203.0.113.10:3478?transport=udp',
    'TURNS:HOST:443?TRANSPORT=TCP',
  ])('accepts %s', (url) => {
    expect(() => assertUsableTurn({ urls: [url], ...creds })).not.toThrow();
  });

  it('accepts a stun: URL without credentials — STUN has none', () => {
    expect(() => assertUsableTurn({ urls: ['stun:stun.l.google.com:19302'] })).not.toThrow();
  });

  // MARK: - The shapes that break every call

  /** The exact value that took production down. */
  it('rejects a bare hostname', () => {
    expect(() => assertUsableTurn({ urls: ['turn.destekly.tr'], ...creds })).toThrow(
      /not ice server urls/i,
    );
  });

  it.each([
    ['a scheme that is not ICE', 'https://turn.example.com'],
    ['the double slash form', 'turn://turn.example.com:3478'],
    ['a transport nobody implements', 'turn:turn.example.com:3478?transport=sctp'],
    ['a path', 'turn:turn.example.com:3478/relay'],
  ])('rejects %s', (_why, url) => {
    expect(() => assertUsableTurn({ urls: [url], ...creds })).toThrow(/not ice server urls/i);
  });

  it('names every offending value, not just the first', () => {
    expect(() =>
      assertUsableTurn({ urls: ['turn.a.example', 'turn:ok.example:3478', 'b.example'], ...creds }),
    ).toThrow(/turn\.a\.example.*b\.example/);
  });

  // MARK: - A relay you cannot authenticate to

  /**
   * Chrome throws `InvalidAccessError` for this one — same constructor, same
   * blast radius, and the shape an operator lands on after being told
   * LiveKit's TURN must not be listed here with credentials.
   */
  it('rejects a turn: URL with no credentials at all', () => {
    expect(() => assertUsableTurn({ urls: ['turn:turn.example.com:3478'] })).toThrow(
      /needs a username and credential/i,
    );
  });

  it('rejects half a credential pair', () => {
    expect(() =>
      assertUsableTurn({ urls: ['turn:turn.example.com:3478'], username: 'u', credential: '' }),
    ).toThrow(/needs a username and credential/i);
  });

  /** The coturn path: the server mints a fresh pair per call from this. */
  it('accepts a shared secret instead of a pair', () => {
    expect(() =>
      assertUsableTurn({ urls: ['turns:turn.example.com:5349?transport=tcp'], shared_secret: 's3cret' }),
    ).not.toThrow();
  });

  it('says where LiveKit-supplied TURN belongs instead', () => {
    expect(() => assertUsableTurn({ urls: ['turn:turn.example.com:3478'] })).toThrow(
      /TURN domain/,
    );
  });

  // MARK: - Shapes that are merely untidy

  it('ignores blank entries rather than failing on them', () => {
    expect(() =>
      assertUsableTurn({ urls: ['  ', 'turn:turn.example.com:3478', ''], ...creds }),
    ).not.toThrow();
  });

  it('trims before judging', () => {
    expect(() =>
      assertUsableTurn({ urls: ['  turn:turn.example.com:3478  '], ...creds }),
    ).not.toThrow();
  });
});
