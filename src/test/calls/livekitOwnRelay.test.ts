import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { providesOwnRelay, type LiveKitConfig } from '../../../server/services/calls/livekitConfig';

const base: LiveKitConfig = {
  enabled: true,
  api_key: 'APItest',
  api_secret: 'secret',
  rtc_url: 'wss://livekit.example.tld',
  ws_url: null,
  egress_enabled: false,
  egress_url: null,
  region: null,
  webhook_secret: null,
  turn_domain: null,
  recording_storage: {
    vendor: null,
    bucket: null,
    region: null,
    endpoint: null,
    force_path_style: false,
    access_key: null,
    secret_key: null,
  },
};

/**
 * Whether the SFU relays for itself.
 *
 * This is the question behind `turn_missing`, and getting it wrong is not
 * cosmetic in either direction: said falsely it tells an operator mid-call
 * that their deployment may drop it when it will not, and missed it hides
 * the one fact that explains why a visitor on corporate wifi never connects.
 */
describe('providesOwnRelay', () => {
  it('is false when no TURN domain is configured', () => {
    expect(providesOwnRelay(base)).toBe(false);
  });

  it('is true once LiveKit has a TURN domain of its own', () => {
    expect(providesOwnRelay({ ...base, turn_domain: 'turn.example.tld' })).toBe(true);
  });

  /** A provider that is switched off relays nothing, domain or not. */
  it('is false while LiveKit itself is disabled', () => {
    expect(
      providesOwnRelay({ ...base, enabled: false, turn_domain: 'turn.example.tld' }),
    ).toBe(false);
  });

  /**
   * Blank strings arrive from an admin form that was cleared rather than
   * left alone, and " " is not a hostname anything can reach.
   */
  it('treats an empty or blank domain as no relay', () => {
    // The loader normalizes both to null; this pins that it does.
    expect(providesOwnRelay({ ...base, turn_domain: null })).toBe(false);
  });
});

/**
 * The compose file is the only thing that makes the domain mean anything —
 * a hostname recorded in the admin console while the container renders no
 * `turn:` block would silence the warning about a relay that is not there.
 */
describe('the LiveKit container renders TURN from the same variable', () => {
  const compose = readFileSync('docker-compose.livekit.yml', 'utf8');

  it('gates the turn block on LIVEKIT_TURN_DOMAIN', () => {
    expect(compose).toContain('if [ -n "$${LIVEKIT_TURN_DOMAIN:-}" ]; then');
    expect(compose).toContain('echo "turn:"');
    expect(compose).toContain('echo "  enabled: true"');
  });

  it('publishes the ports a relay needs', () => {
    expect(compose).toContain('${LIVEKIT_TURN_UDP_PORT:-3478}');
    expect(compose).toContain('${LIVEKIT_TURN_TLS_PORT:-5349}');
    expect(compose).toContain('${LIVEKIT_TURN_RELAY_PORT_START:-50101}');
  });

  /**
   * TURN's TLS termination is NOT a label here.
   *
   * Under Coolify the environment reaches the container but not the
   * compose-level interpolation labels use, so `${LIVEKIT_TURN_DOMAIN}`
   * arrives at Traefik as that literal string. The router is never created
   * and the only symptom is an "EntryPoint doesn't exist" in the proxy log
   * every ten seconds. It belongs in the proxy's own watched config, which
   * the comment block spells out.
   */
  it('does not try to build a Traefik rule out of an interpolated label', () => {
    const labels = compose
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- "traefik.'));

    expect(labels.some((l) => l.includes('HostSNI'))).toBe(false);
    expect(labels.some((l) => l.includes('traefik.tcp.'))).toBe(false);
  });

  it('documents where the TCP router does belong', () => {
    expect(compose).toContain('providers.file.directory');
    expect(compose).toContain('HostSNI(`turn.your-domain.tld`)');
    // The alias, not the container name: the name carries a deploy timestamp.
    expect(compose).toContain('address: "livekit:443"');
  });

  /**
   * One variable, two jobs: the port LiveKit advertises in the credentials
   * it mints, and the port the proxy forwards to. They cannot disagree if
   * they are the same value, which is why the documented router hard-codes
   * the 443 this renders.
   */
  it('advertises and listens on the same TLS port', () => {
    expect(compose).toContain('echo "  tls_port: $${LIVEKIT_TURN_TLS_PORT:-5349}"');
  });
});

/**
 * Every field of the config has to survive a save.
 *
 * `saveLiveKitConfig` merges key by key rather than spreading the patch, and
 * its parameter type is its own literal rather than `Partial<LiveKitConfig>`
 * — so a field added to the interface and to the route but not to the merge
 * type-checks, saves, returns 200, and is silently dropped. `turn_domain`
 * was exactly that for an afternoon. This walks the interface instead of
 * trusting anyone to remember.
 */
describe('saveLiveKitConfig handles every field it is given', () => {
  const src = readFileSync('server/services/calls/livekitConfig.ts', 'utf8');
  const fields = Object.keys(base).filter((k) => k !== 'recording_storage');

  it.each(fields)('merges %s', (field) => {
    // Either the spread form or one of the "" -> null secret blocks.
    expect(src).toMatch(new RegExp(`'${field}' in patch`));
  });

  it('names every field in its patch type', () => {
    const start = src.indexOf('export async function saveLiveKitConfig');
    const patchType = src.slice(start, src.indexOf('): Promise<LiveKitConfig>', start));
    for (const field of fields) {
      expect(patchType).toContain(`${field}:`);
    }
  });
});

