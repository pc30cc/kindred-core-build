/**
 * PROVIDER NETWORK ISOLATION GUARD (AI).
 *
 * Deployment topology this protects:
 *
 *   IRAN / restricted network                 EXTERNAL / unrestricted
 *   Core + DB + Frontend        ──────▶       AI Runtime → AI providers
 *
 * Core must NEVER open a socket to an AI provider. These tests fail the build
 * the moment that boundary is crossed again — by a provider hostname landing
 * in `server/**`, or by Core importing the runtime provider modules.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

const PROVIDER_HOSTS = [
  'api.openai.com',
  'api.anthropic.com',
  'generativelanguage.googleapis.com',
  'api.groq.com',
  'api.together.xyz',
  'api.mistral.ai',
  'api.deepseek.com',
  'api.perplexity.ai',
  'openrouter.ai',
];

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

const coreFiles = walk(join(ROOT, 'server'));

describe('AI provider network isolation', () => {
  it('no Core file names an AI provider host', () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      const src = readFileSync(file, 'utf8');
      for (const host of PROVIDER_HOSTS) {
        if (src.includes(host)) offenders.push(`${file.replace(ROOT + '/', '')} → ${host}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('no Core file imports the runtime provider modules', () => {
    const offenders: string[] = [];
    for (const file of coreFiles) {
      const src = readFileSync(file, 'utf8');
      if (/from\s+['"][^'"]*runtime\/ai\/providers/.test(src)) {
        offenders.push(file.replace(ROOT + '/', ''));
      }
    }
    expect(offenders).toEqual([]);
  });

  it('Core reaches AI only through the AI Runtime client', () => {
    const client = readFileSync(join(ROOT, 'server/services/ai/runtimeClient.ts'), 'utf8');
    // The client itself is the single Core→AI egress point.
    expect(client).toContain('AI_RUNTIME_ROUTES');
    const service = readFileSync(join(ROOT, 'server/services/ai/index.ts'), 'utf8');
    expect(service).toContain('runtimeComplete');
    expect(service).not.toMatch(/\bfetch\(/);
  });

  it('the AI Runtime deployable refuses database and platform credentials', () => {
    const server = readFileSync(join(ROOT, 'ai-runtime/server.ts'), 'utf8');
    for (const forbidden of ['SUPABASE_SERVICE_ROLE_KEY', 'PLUGIN_SECRETS_MASTER_KEY', 'SESSION_SECRET']) {
      expect(server).toContain(forbidden);
    }
    expect(server).toContain('process.exit(1)');
  });
});
