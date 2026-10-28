import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * The address LiveKit puts in its ICE candidates.
 *
 * A wrong one is the worst kind of failure a call can have: signalling works,
 * the call "connects", and nobody hears anything. It used to be a setting
 * (LIVEKIT_NODE_IP) that had to be retyped on every server move; on
 * 2026-10-28 the move to a new host carried the old box's IP along in two
 * apps' settings. The wrapper now asks the outside on every start.
 *
 * These run the wrapper's own shell, taken out of the compose file the way
 * Compose hands it over (`$$` becomes `$`), with `wget`, `nslookup` and
 * `timeout` replaced by stubs, so no test touches the network.
 */
const compose = readFileSync('docker-compose.livekit.yml', 'utf8');

/** The `command:` block scalar, as written in the file. */
function commandBlock(): string {
  const lines = compose.split('\n');
  const start = lines.findIndex((l) => l.trim() === '- |') + 1;
  const out: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() !== '' && !line.startsWith('        ')) break;
    out.push(line.slice(8));
  }
  return out.join('\n');
}

/** What Compose turns an escaped dollar into before the shell sees it. */
const unescape = (s: string) => s.replace(/\$\$/g, '$');

const nodeIpBlock = () => {
  const block = commandBlock();
  const from = block.indexOf('# >>> node-ip');
  const to = block.indexOf('# <<< node-ip');
  expect(from).toBeGreaterThan(-1);
  expect(to).toBeGreaterThan(from);
  return unescape(block.slice(from, to));
};

let bin: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), 'livekit-node-ip-'));
  // wget: the URL is the last argument; STUB_CF / STUB_IPIFY hold the body,
  // or "fail" for a source that does not answer.
  writeFileSync(
    join(bin, 'wget'),
    [
      '#!/bin/sh',
      'for a in "$@"; do url=$a; done',
      'case $url in',
      '  *1.1.1.1*) body=${STUB_CF:-fail} ;;',
      '  *ipify*) body=${STUB_IPIFY:-fail} ;;',
      '  *) body=fail ;;',
      'esac',
      '[ "$body" = fail ] && exit 1',
      'printf "%s\\n" "$body"',
    ].join('\n'),
  );
  writeFileSync(
    join(bin, 'nslookup'),
    [
      '#!/bin/sh',
      '[ "${STUB_OPENDNS:-fail}" = fail ] && exit 1',
      // BusyBox's layout: the resolver's own address comes first, with a port.
      'printf "Server:\\t\\tresolver1.opendns.com\\nAddress:\\t208.67.222.222:53\\n\\nNon-authoritative answer:\\nName:\\tmyip.opendns.com\\nAddress: %s\\n" "$STUB_OPENDNS"',
    ].join('\n'),
  );
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\nshift\nexec "$@"\n');
  for (const f of ['wget', 'nslookup', 'timeout']) chmodSync(join(bin, f), 0o755);
});

afterAll(() => rmSync(bin, { recursive: true, force: true }));

type Stubs = { STUB_CF?: string; STUB_IPIFY?: string; STUB_OPENDNS?: string };

function runBlock(nodeIp: string | undefined, stubs: Stubs) {
  const script = [
    'set -eu',
    nodeIpBlock(),
    'printf "ip=%s\\nuse_external_ip=%s\\nsource=%s\\n" "$LIVEKIT_NODE_IP" "$USE_EXTERNAL_IP" "$NODE_IP_SOURCE"',
  ].join('\n');
  const env: NodeJS.ProcessEnv = { PATH: `${bin}:${process.env.PATH}`, ...stubs };
  if (nodeIp !== undefined) env.LIVEKIT_NODE_IP = nodeIp;
  const r = spawnSync('sh', ['-c', script], { env, encoding: 'utf8' });
  const out = Object.fromEntries(
    r.stdout
      .split('\n')
      .filter(Boolean)
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)]),
  );
  return { status: r.status, stderr: r.stderr, ...out } as {
    status: number | null;
    stderr: string;
    ip?: string;
    use_external_ip?: string;
    source?: string;
  };
}

describe('LiveKit finds its own public address', () => {
  it('asks Cloudflare first', () => {
    const r = runBlock('auto', { STUB_CF: 'fl=1\nh=1.1.1.1\nip=5.39.70.213\nts=1', STUB_IPIFY: '9.9.9.9' });
    expect(r).toMatchObject({ status: 0, ip: '5.39.70.213', use_external_ip: 'false', source: 'auto, cloudflare' });
  });

  it('treats an unset or empty setting as auto', () => {
    expect(runBlock(undefined, { STUB_CF: 'ip=5.39.70.213' }).ip).toBe('5.39.70.213');
    expect(runBlock('', { STUB_CF: 'ip=5.39.70.213' }).ip).toBe('5.39.70.213');
  });

  it('falls through to ipify, then OpenDNS', () => {
    expect(runBlock('auto', { STUB_IPIFY: '5.39.70.213' })).toMatchObject({ ip: '5.39.70.213', source: 'auto, ipify' });
    expect(runBlock('auto', { STUB_OPENDNS: '5.39.70.213' })).toMatchObject({ ip: '5.39.70.213', source: 'auto, opendns' });
  });

  /** A proxy or a NAT in the way can answer with an address nobody outside reaches. */
  it('skips an answer that is not a public IPv4', () => {
    const r = runBlock('auto', { STUB_CF: 'ip=10.0.1.5', STUB_IPIFY: '<html>rate limited</html>', STUB_OPENDNS: '5.39.70.213' });
    expect(r).toMatchObject({ ip: '5.39.70.213', source: 'auto, opendns' });
  });

  it("hands over to LiveKit's STUN when no source answers", () => {
    const r = runBlock('auto', {});
    expect(r).toMatchObject({ status: 0, ip: '', use_external_ip: 'true' });
    expect(r.source).toContain('STUN');
  });

  it('keeps a pinned address and warns when the host is seen elsewhere', () => {
    const same = runBlock('5.39.70.213', { STUB_CF: 'ip=5.39.70.213' });
    expect(same).toMatchObject({ status: 0, ip: '5.39.70.213', use_external_ip: 'false', source: 'pinned' });
    expect(same.stderr).not.toContain('WARNING');

    const moved = runBlock('192.99.68.134', { STUB_CF: 'ip=5.39.70.213' });
    expect(moved).toMatchObject({ status: 0, ip: '192.99.68.134', source: 'pinned' });
    expect(moved.stderr).toContain('seen as 5.39.70.213');
  });

  it.each(['10.0.0.1', '192.99.68', 'livekit.example.tld', '256.1.1.1'])(
    'refuses to start with %s pinned',
    (bad) => {
      const r = runBlock(bad, { STUB_CF: 'ip=5.39.70.213' });
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('must be a public IPv4 or auto');
    },
  );
});

describe('is_public_ipv4', () => {
  const check = (ip: string) => {
    const script = `${nodeIpBlock().split('detect_node_ip()')[0]}\nis_public_ipv4 "$1"`;
    return spawnSync('sh', ['-c', script, 'sh', ip]).status === 0;
  };

  it.each(['5.39.70.213', '192.99.68.134', '1.1.1.1', '172.15.0.1', '172.32.0.1', '100.63.255.255', '100.128.0.1'])(
    'accepts %s',
    (ip) => expect(check(ip)).toBe(true),
  );

  it.each([
    '', '10.1.2.3', '127.0.0.1', '0.0.0.0', '169.254.1.1', '192.168.1.1', '172.16.0.1', '172.31.255.255',
    '100.64.0.1', '100.127.0.1', '1.2.3', '1.2.3.4.5', '1..2.3', '.1.2.3', '1.2.3.', '300.1.1.1', '2001:db8::1', '*.*.*.*',
  ])('rejects %s', (ip) => expect(check(ip)).toBe(false));
});

describe('the rendered config', () => {
  function render(env: NodeJS.ProcessEnv): string {
    const dir = mkdtempSync(join(tmpdir(), 'livekit-render-'));
    try {
      const file = join(dir, 'livekit.yaml');
      const script = unescape(commandBlock())
        .replaceAll('/tmp/livekit.yaml', file)
        .replace(/exec \/livekit-server.*/, 'exit 0');
      execFileSync('sh', ['-c', script], {
        env: { PATH: `${bin}:${process.env.PATH}`, LIVEKIT_API_KEY: 'APItest', LIVEKIT_API_SECRET: 'secret', ...env },
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return readFileSync(file, 'utf8');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  it('advertises the address it found, with STUN off', () => {
    const yaml = render({ STUB_CF: 'ip=5.39.70.213' });
    expect(yaml).toContain('  use_external_ip: false\n  node_ip: 5.39.70.213\n');
  });

  it('turns STUN on, with no address, when it found none', () => {
    const yaml = render({});
    expect(yaml).toMatch(/ {2}use_external_ip: true\n {2}node_ip: *\n/);
  });

  /** Compose interpolates a lone `$` at deploy time, long before the shell runs. */
  it('escapes every dollar in the wrapper for Compose', () => {
    expect(commandBlock().replace(/\$\$/g, '')).not.toContain('$');
  });

  it('defaults the setting to auto', () => {
    expect(compose).toContain('LIVEKIT_NODE_IP: ${LIVEKIT_NODE_IP:-auto}');
    expect(compose).not.toContain('LIVEKIT_NODE_IP is required');
  });
});
