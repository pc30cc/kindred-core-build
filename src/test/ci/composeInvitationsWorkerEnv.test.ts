/**
 * The invitations-worker container gets the environment it boots with.
 *
 * worker/index.ts starts WORKER_KIND=invitations through the same
 * loadConfig() as the backend, which throws on any missing required
 * variable. The compose service used to lack SUPABASE_ANON_KEY, so the
 * container exited at startup and restarted forever — and an operator who
 * followed .env.docker.example (INVITATION_WORKER_INPROC=0) got no
 * invitation delivery at all. It also lacked CORS_ORIGINS, the invitation
 * link base when Super Admin → Domains has no app URL.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

/** `- KEY=...` entries of one service's `environment:` list (no YAML dependency). */
function serviceEnv(compose: string, service: string): string[] {
  const start = compose.indexOf(`\n  ${service}:\n`);
  if (start < 0) throw new Error(`service ${service} not found`);
  const rest = compose.slice(start + service.length + 4);
  const next = rest.search(/\n {2}[a-z][a-z0-9-]*:\n/);
  const block = next < 0 ? rest : rest.slice(0, next);
  return [...block.matchAll(/^\s+- ([A-Z0-9_]+)=/gm)].map((m) => m[1]);
}

const compose = readFileSync('docker-compose.yml', 'utf8');
const requiredByLoadConfig = [...readFileSync('server/config.ts', 'utf8').matchAll(/required\('([A-Z0-9_]+)'\)/g)].map(
  (m) => m[1],
);

describe('docker-compose invitations-worker', () => {
  it('passes every variable loadConfig() requires', () => {
    expect(requiredByLoadConfig.length).toBeGreaterThan(0);
    const env = serviceEnv(compose, 'invitations-worker');
    for (const key of requiredByLoadConfig) expect(env).toContain(key);
  });

  it('passes CORS_ORIGINS, the invitation-link fallback', () => {
    expect(serviceEnv(compose, 'invitations-worker')).toContain('CORS_ORIGINS');
  });

  it('lets INVITATION_WORKER_INPROC reach the backend, as .env.docker.example expects', () => {
    expect(readFileSync('.env.docker.example', 'utf8')).toMatch(/^INVITATION_WORKER_INPROC=/m);
    expect(serviceEnv(compose, 'backend')).toContain('INVITATION_WORKER_INPROC');
  });
});
