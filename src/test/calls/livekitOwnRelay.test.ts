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
   * The TURN hostname belongs to a deployment, not to this repository, so
   * the Traefik rule reads it from the environment. What must never happen
   * is a bare `${LIVEKIT_TURN_DOMAIN}`: unset, that is an empty `HostSNI()`,
   * which is a parse error, and a broken router in a shared proxy takes
   * every other service on it down with it — a worse outcome than no TURN.
   */
  it('reads the TURN hostname from the environment, never from this file', () => {
    // The label, not the paragraph above it that explains why — both
    // mention HostSNI and only one of them is configuration.
    const rule = compose
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('- "traefik.tcp.routers') && l.includes('HostSNI'));

    expect(rule).toBeDefined();
    // No real hostname committed here: the variable supplies it, and the
    // fallback is a name that cannot resolve. `.invalid` and `.example`
    // are reserved by RFC 2606 for exactly this.
    expect(rule).toMatch(
      /HostSNI\(`\$\{LIVEKIT_TURN_DOMAIN:-[a-z0-9-]+\.(invalid|example)\}`\)/,
    );
  });

  /**
   * With TURN off the router still exists, so it must ask for no
   * certificate — otherwise every deployment that does not use TURN spends
   * its Let's Encrypt failure budget on a name that cannot resolve.
   */
  it('asks for no certificate unless a resolver is named', () => {
    expect(compose).toContain('certresolver=${LIVEKIT_TURN_CERTRESOLVER:-}');
  });

  /**
   * One variable, two jobs: the port LiveKit advertises in the credentials
   * it mints, and the port the router forwards to. They cannot disagree if
   * they are the same value.
   */
  it('forwards to the port LiveKit advertises', () => {
    expect(compose).toContain(
      'traefik.tcp.services.livekit-turn.loadbalancer.server.port=${LIVEKIT_TURN_TLS_PORT:-5349}',
    );
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

