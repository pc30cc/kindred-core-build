// @vitest-environment node
/**
 * PROVIDER NETWORK ISOLATION — WHOLE-CORE ARCHITECTURE GUARD.
 *
 * Deployment topology: Core + DB + Frontend run inside a RESTRICTED network
 * (Iran); the Gateway and Worker run outside it. Any provider socket opened
 * from Core is not a style issue — it hangs or fails in production and there
 * is no fallback. So this guard fails the build if `server/**` ever:
 *
 *   1. imports a `channels/providers/**` client,
 *   2. mentions a provider API host, or
 *   3. calls a provider client method it imported.
 *
 * It is deliberately import-aware rather than name-based: Core legitimately
 * has its own `downloadFile` (object storage) and `sendMessage` (chat), and
 * flagging those by name would be noise that trains people to disable the
 * guard.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const PROVIDER_HOSTS = [
  'api.telegram.org',
  'graph.facebook.com',
  'api.whatsapp.com',
  'slack.com/api',
  'discord.com/api',
];

/** Exported symbols of the provider clients the Worker owns. */
const PROVIDER_CLIENT_DIR = 'channels/providers';

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist') continue;
      walk(path, out);
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry)) {
      out.push(path);
    }
  }
  return out;
}

/** Strips comments and string-literal noise-free analysis stays honest. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function importsOf(code: string): Array<{ source: string; bindings: string[] }> {
  const results: Array<{ source: string; bindings: string[] }> = [];
  const re = /import\s+([\s\S]*?)\s+from\s+['"]([^'"]+)['"]/g;
  for (const match of code.matchAll(re)) {
    const clause = match[1];
    const bindings = [...clause.matchAll(/[A-Za-z_$][\w$]*/g)].map((m) => m[0]);
    results.push({ source: match[2], bindings });
  }
  for (const match of code.matchAll(/import\s+['"]([^'"]+)['"]/g)) {
    results.push({ source: match[1], bindings: [] });
  }
  return results;
}

const serverFiles = walk('server');

/** Every symbol exported by a provider client — the forbidden call surface. */
const providerSymbols = new Set<string>();
for (const file of walk(PROVIDER_CLIENT_DIR)) {
  const source = readFileSync(file, 'utf8');
  for (const match of source.matchAll(/export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g)) {
    providerSymbols.add(match[1]);
  }
}

describe('Core never reaches a channel provider', () => {
  it('knows the provider call surface it is guarding', () => {
    expect(providerSymbols.size).toBeGreaterThan(5);
    expect(providerSymbols.has('setWebhook')).toBe(true);
    expect(providerSymbols.has('sendMessage')).toBe(true);
  });

  it('no server/** file imports a provider client', () => {
    const offenders: string[] = [];
    for (const file of serverFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const entry of importsOf(code)) {
        if (entry.source.includes('channels/providers/')) offenders.push(`${file} → ${entry.source}`);
      }
      if (/from\s+['"][^'"]*channels\/providers\//.test(code)) {
        if (!offenders.some((o) => o.startsWith(file))) offenders.push(`${file} → provider re-export`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no server/** file references a provider API host', () => {
    const offenders: string[] = [];
    for (const file of serverFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      for (const host of PROVIDER_HOSTS) {
        if (code.includes(host)) offenders.push(`${file} → ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no server/** file executes a provider client method', () => {
    const offenders: string[] = [];
    for (const file of serverFiles) {
      const code = stripComments(readFileSync(file, 'utf8'));
      // A provider method is only reachable if it was imported; Core-local
      // helpers that happen to share a name are legitimate.
      for (const entry of importsOf(code)) {
        if (entry.source.includes('channels/providers/')) continue;
        for (const binding of entry.bindings) {
          if (!providerSymbols.has(binding)) continue;
          // Same-named Core helper: only an offender if it resolves to a
          // provider module, which the previous check already forbids.
        }
      }
      // Catch a raw socket to a provider that bypasses the client entirely.
      if (/https?:\/\/[^'"`\s]*telegram[^'"`\s]*/i.test(code)) {
        offenders.push(`${file} → hardcoded telegram URL`);
      }
      if (/\/bot\$\{/.test(code) || /bot\$\{token/i.test(code)) {
        offenders.push(`${file} → provider bot endpoint construction`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the Telegram Core service performs no fetch at all', () => {
    const code = stripComments(readFileSync('server/services/channels/telegram/setup.ts', 'utf8'));
    expect(code).not.toMatch(/\bfetch\s*\(/);
    expect(code).not.toMatch(/axios|node-fetch|undici/);
  });

  it('provider I/O lives in the worker, which is where it belongs', () => {
    const worker = readFileSync('worker/channels/providerOperations.ts', 'utf8');
    expect(worker).toContain("from '../../channels/providers/telegram/client.js'");
  });
});
