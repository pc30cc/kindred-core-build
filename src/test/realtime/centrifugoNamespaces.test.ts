/**
 * Centrifugo namespaces: no client-side history or presence (audit 2026-11-04).
 *
 * In Centrifugo v5 (centrifugo/centrifugo:v5.4.5, internal/client/handler.go,
 * hasAccessToHistory / hasAccessToPresence) `allow_history_for_client` and
 * `allow_presence_for_client` let ANY connection with a user id call history
 * and presence on ANY channel of the namespace, subscribed or not. Every
 * widget visitor gets such a connection from /api/realtime/connect, so with
 * those options on, one tenant's visitor could read another tenant's
 * ws:<ws>:inbox history (the last 50 message envelopes) and the presence of
 * ws:<ws>:operators, around the subscription tokens the backend checks.
 *
 * `_for_subscriber` is off too: a subscriber of ws:<ws>:operators would see
 * every operator's user id, a member's hidden peer included (CLAUDE.md,
 * "Members hidden from each other"). No client calls history or presence;
 * the backend reads presence with the API key, and resubscribe recovery comes
 * from `force_recovery`, which needs neither option.
 *
 * The namespaces are written out four times (the three compose files, which
 * are what Coolify runs, and the reference config.json) plus the cross-node
 * integration script: they must stay identical.
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

type Namespace = Record<string, unknown> & { name: string };

const COMPOSE_FILES = [
  'docker-compose.centrifugo.yml',
  'docker-compose.centrifugo-redis.yml',
  'docker-compose.realtime-cluster.yml',
] as const;

/** The folded (`>-`) CENTRIFUGO_NAMESPACES scalar of a compose file, parsed. */
function composeNamespaces(file: string): Namespace[] {
  const lines = readFileSync(file, 'utf8').split('\n');
  const at = lines.findIndex((l) => /^\s*CENTRIFUGO_NAMESPACES:\s*>-\s*$/.test(l));
  expect(at, `${file} declares CENTRIFUGO_NAMESPACES as a >- block`).toBeGreaterThan(-1);
  const indent = lines[at].search(/\S/);
  const body: string[] = [];
  for (const line of lines.slice(at + 1)) {
    if (line.trim() === '' || line.search(/\S/) <= indent) break;
    body.push(line.trim());
  }
  return JSON.parse(body.join(' '));
}

function configJsonNamespaces(): Namespace[] {
  return JSON.parse(readFileSync('deploy/centrifugo/config.json', 'utf8')).namespaces;
}

/** The NAMESPACES literal of the cross-node integration script. */
function integrationScriptNamespaces(): Namespace[] {
  const src = readFileSync('scripts/realtime/cross-node-integration.ts', 'utf8');
  const m = src.match(/const NAMESPACES = JSON\.stringify\((\[[\s\S]*?\n\])\);/);
  expect(m, 'cross-node-integration.ts declares NAMESPACES').toBeTruthy();
  return new Function(`return ${m![1]};`)() as Namespace[];
}

const withoutComments = (ns: Namespace[]) =>
  ns.map((n) => Object.fromEntries(Object.entries(n).filter(([k]) => !k.startsWith('_'))));

const SOURCES: Array<[string, () => Namespace[]]> = [
  ...COMPOSE_FILES.map((f) => [f, () => composeNamespaces(f)] as [string, () => Namespace[]]),
  ['deploy/centrifugo/config.json', configJsonNamespaces],
  ['scripts/realtime/cross-node-integration.ts', integrationScriptNamespaces],
];

describe('Centrifugo namespaces', () => {
  it.each(SOURCES)('%s: no namespace lets a client call history or presence', (_file, read) => {
    for (const ns of read()) {
      for (const [key, value] of Object.entries(ns)) {
        if (/^allow_(history|presence)_for_(client|subscriber|anonymous)$/.test(key)) {
          expect({ ns: ns.name, key, value }).toEqual({ ns: ns.name, key, value: false });
        }
      }
      // Stated, not left to defaults, so the next reader sees the decision.
      expect(ns.allow_history_for_client, `${ns.name}.allow_history_for_client`).toBe(false);
      expect(ns.allow_presence_for_client, `${ns.name}.allow_presence_for_client`).toBe(false);
    }
  });

  it.each(SOURCES)('%s: subscribe and publish stay token/backend only', (_file, read) => {
    for (const ns of read()) {
      for (const [key, value] of Object.entries(ns)) {
        if (/_for_(client|subscriber|anonymous)$/.test(key)) {
          expect({ ns: ns.name, key, value }).toEqual({ ns: ns.name, key, value: false });
        }
      }
      for (const key of ['allow_user_limited_channels', 'proxy_subscribe', 'proxy_publish', 'proxy_history', 'proxy_presence']) {
        expect(ns[key], `${ns.name}.${key}`).not.toBe(true);
      }
    }
  });

  it('ws keeps the history that force_recovery needs on resubscribe', () => {
    for (const [file, read] of SOURCES) {
      const ws = read().find((n) => n.name === 'ws');
      expect(ws, `${file} has the ws namespace`).toBeTruthy();
      expect(ws!.force_recovery, file).toBe(true);
      expect(Number(ws!.history_size), file).toBeGreaterThan(0);
      expect(ws!.history_ttl, file).toBeTruthy();
    }
  });

  it('every copy declares the same namespaces', () => {
    const [first, ...rest] = SOURCES.map(([file, read]) => [file, withoutComments(read())] as const);
    for (const [file, ns] of rest) {
      expect(ns, `${file} matches ${first[0]}`).toEqual(first[1]);
    }
  });

  it('no compose file turns on insecure or anonymous client access', () => {
    for (const file of COMPOSE_FILES) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).toMatch(/CENTRIFUGO_CLIENT_ANONYMOUS:\s*"false"/);
      expect(text, file).not.toMatch(/CENTRIFUGO_CLIENT_INSECURE|CENTRIFUGO_ANONYMOUS_CONNECT_WITHOUT_TOKEN|CENTRIFUGO_CLIENT_ANONYMOUS:\s*"?true/);
      expect(text, file).not.toMatch(/CENTRIFUGO_(PROXY_|RPC_PING|USER_SUBSCRIBE_TO_PERSONAL)/);
    }
    const cfg = JSON.parse(readFileSync('deploy/centrifugo/config.json', 'utf8'));
    expect(cfg.client_insecure).not.toBe(true);
    expect(cfg.client_anonymous).toBe(false);
  });
});

/** Every non-test source of a realtime client that talks Centrifugo's protocol. */
function realtimeClientFiles(): string[] {
  const roots = ['src', 'public', 'android', 'ios', 'macos', 'windows-native', 'windows'];
  const exts = /\.(ts|tsx|js|kt|swift|cs)$/;
  const skip = /(^|\/)(node_modules|dist|build|bin|obj|test|tests|Tests|i18n)(\/|$)/;
  const out: string[] = [];
  const walk = (dir: string) => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const e of entries) {
      const p = join(dir, e);
      if (skip.test(p)) continue;
      const st = statSync(p);
      if (st.isDirectory()) walk(p);
      else if (exts.test(e) && /centrifug/i.test(readFileSync(p, 'utf8'))) out.push(p);
    }
  };
  roots.forEach(walk);
  return out;
}

describe('realtime clients', () => {
  it('none calls Centrifugo history or presence (the namespaces refuse them)', () => {
    const files = realtimeClientFiles();
    // The panel, the widget and the native apps must all have been scanned.
    expect(files.some((f) => f.startsWith('src/realtime'))).toBe(true);
    expect(files.some((f) => f.startsWith('public/widget'))).toBe(true);
    expect(files.some((f) => f.startsWith('android'))).toBe(true);
    expect(files.some((f) => f.startsWith('ios'))).toBe(true);
    const frame =
      /["']?(history|presence|presence_stats)["']?\s*[:=]\s*[[{(]?\s*["']?channel|\.(history|presenceStats)\(|\bpresence\(\s*(channel|['"`])|"(history|presence_stats)"\s*(to|,|:)/;
    const offenders = files.filter((f) => frame.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
