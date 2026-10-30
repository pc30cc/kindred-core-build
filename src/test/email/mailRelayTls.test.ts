// @vitest-environment node
/**
 * The relay's STARTTLS (deploy/mail-relay, README "TLS"): the SASL password
 * and every mail cross the shared coolify network, so the relay offers
 * STARTTLS with its own certificate, and refuses AUTH before it once the
 * rollout is done:
 *
 *   - the compose offers TLS with the certificate and key from tls/, mounted
 *     read-only and never created empty, and requires TLS before AUTH unless
 *     RELAY_TLS_AUTH_ONLY says otherwise (the rollout's step 1 only);
 *   - tls/ is never committed, and no key or certificate is in the folder;
 *   - the rollout sets the providers' encryption to none before the relay
 *     offers TLS ('auto' would take it and refuse the self-signed
 *     certificate), then starttls with mail-relay and the certificate as
 *     tls_ca, and only then turns on smtpd_tls_auth_only.
 */
import { describe, expect, it } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'yaml';

const DIR = 'deploy/mail-relay';
const compose = parse(readFileSync(join(DIR, 'docker-compose.yml'), 'utf8')) as {
  services: Record<string, { environment: Record<string, string>; volumes: Array<string | Record<string, unknown>> }>;
};
const relay = compose.services['mail-relay'];

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe('the relay offers STARTTLS with its own certificate', () => {
  it('with the certificate and key of tls/, and no AUTH before it by default', () => {
    expect(relay.environment).toMatchObject({
      POSTFIX_smtpd_tls_security_level: 'may',
      POSTFIX_smtpd_tls_cert_file: '/etc/postfix/tls/mail-relay.crt',
      POSTFIX_smtpd_tls_key_file: '/etc/postfix/tls/mail-relay.key',
      POSTFIX_smtpd_tls_auth_only: '${RELAY_TLS_AUTH_ONLY:-yes}',
    });
  });

  it('mounted read-only, and never created empty', () => {
    expect(relay.volumes).toContainEqual({
      type: 'bind',
      source: './tls',
      target: '/etc/postfix/tls',
      read_only: true,
      bind: { create_host_path: false },
    });
  });

  it('never committed', () => {
    expect(readFileSync(join(DIR, '.gitignore'), 'utf8').split('\n')).toContain('tls/');
    expect(filesUnder(DIR).filter((f) => /\.(key|crt|pem|p12)$/.test(f) || f.includes(`${DIR}/tls/`))).toEqual([]);
  });
});

describe('the rollout, without a mail outage', () => {
  const readme = readFileSync(join(DIR, 'README.md'), 'utf8');
  const step = (n: number) => {
    const at = readme.indexOf(`\n${n}. `, readme.indexOf('**Roll it out without a mail outage**'));
    expect(at, `step ${n}`).toBeGreaterThan(-1);
    return at;
  };

  it('goes none, offered, starttls with the certificate, test, then auth_only', () => {
    const [s0, s1, s2, s3, s4] = [0, 1, 2, 3, 4].map(step);
    expect(s0 < s1 && s1 < s2 && s2 < s3 && s3 < s4).toBe(true);
    expect(readme.slice(s0, s1)).toMatch(/\*\*Encryption\*\*\s+to `none`/);
    expect(readme.slice(s1, s2)).toContain('RELAY_TLS_AUTH_ONLY=no');
    expect(readme.slice(s2, s3)).toMatch(/`starttls`[\s\S]*`mail-relay`[\s\S]*\*\*TLS CA\*\*/);
    expect(readme.slice(s4)).toContain('smtpd_tls_auth_only');
  });

  it('makes a certificate for mail-relay as CN and SAN', () => {
    expect(readme).toContain('-subj "/CN=mail-relay" -addext "subjectAltName=DNS:mail-relay"');
  });
});
