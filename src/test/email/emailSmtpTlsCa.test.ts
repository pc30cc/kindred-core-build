// @vitest-environment node
/**
 * An SMTP relay with a private CA (the SMTP config's `tls_ca`, beside
 * `tls_servername`), through the real nodemailer and a real TLS handshake,
 * against a small SMTP server in this process that offers STARTTLS with a
 * certificate for `mail-relay` that a CA made here signed:
 *
 *   - with that CA and that name, `starttls` connects, upgrades, and only
 *     then signs in: the password crosses the wire encrypted;
 *   - with another CA, with none (the public CAs), or with another name, the
 *     handshake fails before any password is sent, so a container that
 *     answers as the relay learns nothing;
 *   - the CA works pasted with its line breaks gone (the form's one-line
 *     input), as the adapter re-wraps it.
 *
 * The certificates are made with the openssl command; without it, skipped.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { smtpAdapter } from '../../../server/services/email/providers/smtp';

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe' });
    return true;
  } catch {
    return false;
  }
})();
const suite = hasOpenssl ? describe : describe.skip;

interface Session {
  startTls: boolean;
  authOverTls: boolean | null;
  data: boolean;
}

suite('an SMTP relay with a private CA (tls_ca)', () => {
  let dir = '';
  let ca = '';
  let otherCa = '';
  let server: net.Server;
  let port = 0;
  const sessions: Session[] = [];

  const PASSWORD = 'relay-pass-tls-0123';
  const relay = (over: Record<string, unknown> = {}) => ({
    provider_name: 'smtp',
    config: {
      smtp_host: '127.0.0.1', smtp_port: String(port), smtp_user: 'noreply@webyar.ai', smtp_pass: PASSWORD,
      from_email: 'noreply@webyar.ai', encryption: 'starttls', tls_servername: 'mail-relay', tls_ca: ca, ...over,
    },
  });

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'smtp-tls-ca-'));
    const openssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'pipe' });
    const makeCa = (name: string, cn: string) => openssl(
      'req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', `${name}.key`, '-out', `${name}.pem`, '-days', '2', '-subj', `/CN=${cn}`,
      '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign',
    );
    makeCa('ca', 'Test Relay CA');
    makeCa('other', 'Some Other CA');
    openssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes',
      '-keyout', 'relay.key', '-out', 'relay.csr', '-subj', '/CN=mail-relay');
    writeFileSync(join(dir, 'relay.ext'), 'subjectAltName=DNS:mail-relay\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n');
    openssl('x509', '-req', '-in', 'relay.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial',
      '-out', 'relay.pem', '-days', '2', '-extfile', 'relay.ext');
    ca = readFileSync(join(dir, 'ca.pem'), 'utf8');
    otherCa = readFileSync(join(dir, 'other.pem'), 'utf8');
    const key = readFileSync(join(dir, 'relay.key'));
    const cert = readFileSync(join(dir, 'relay.pem'));

    server = net.createServer((plain) => {
      const session: Session = { startTls: false, authOverTls: null, data: false };
      sessions.push(session);
      plain.on('error', () => {});
      const speak = (socket: net.Socket | tls.TLSSocket, secure: boolean) => {
        let buffer = '';
        let inData = false;
        const onData = (chunk: Buffer) => {
          buffer += chunk.toString('utf8');
          let at: number;
          while ((at = buffer.indexOf('\r\n')) >= 0) {
            const line = buffer.slice(0, at);
            buffer = buffer.slice(at + 2);
            if (inData) {
              if (line === '.') {
                inData = false;
                session.data = true;
                socket.write('250 2.0.0 Ok: queued as 4TLS123\r\n');
              }
              continue;
            }
            const verb = line.toUpperCase();
            if (verb.startsWith('EHLO')) {
              socket.write(secure ? '250-fake.relay\r\n250 AUTH PLAIN\r\n' : '250-fake.relay\r\n250-STARTTLS\r\n250 AUTH PLAIN\r\n');
            } else if (verb === 'STARTTLS' && !secure) {
              session.startTls = true;
              socket.removeListener('data', onData);
              socket.write('220 2.0.0 Ready to start TLS\r\n', () => {
                const upgraded = new tls.TLSSocket(socket as net.Socket, { isServer: true, key, cert });
                upgraded.on('error', () => {});
                speak(upgraded, true);
              });
              return;
            } else if (verb.startsWith('AUTH')) {
              session.authOverTls = secure;
              socket.write('235 2.7.0 Authentication successful\r\n');
            } else if (verb.startsWith('MAIL FROM') || verb.startsWith('RCPT TO')) socket.write('250 2.1.0 Ok\r\n');
            else if (verb === 'DATA') {
              inData = true;
              socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
            } else if (verb === 'QUIT') socket.end('221 2.0.0 Bye\r\n');
            else socket.write('502 5.5.2 Error: command not recognized\r\n');
          }
        };
        socket.on('data', onData);
      };
      plain.write('220 fake.relay ESMTP\r\n');
      speak(plain, false);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as net.AddressInfo).port;
  }, 60_000);

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(dir, { recursive: true, force: true });
  });

  afterEach(() => {
    sessions.length = 0;
    vi.restoreAllMocks();
  });

  it('with the relay\'s CA and name: upgraded first, then signed in, then sent', async () => {
    expect(process.env.SMTP_TLS_REJECT_UNAUTHORIZED).toBeUndefined();
    const check = await smtpAdapter.verify!(relay());
    expect(check).toEqual({ ok: true, detail: `signed in to 127.0.0.1:${port}; encryption: starttls` });
    expect(sessions[0]).toMatchObject({ startTls: true, authOverTls: true });

    const sent = await smtpAdapter.send(relay(), {
      from: { name: 'Webyar', address: 'noreply@webyar.ai' }, to: 'person@example.com', subject: 'Hi',
      html: '<p>Hi</p>', text: 'Hi', headers: { 'Auto-Submitted': 'auto-generated' },
    });
    expect(sent).toMatchObject({ success: true, serverMessageId: '4TLS123' });
    expect(sessions[1]).toMatchObject({ startTls: true, authOverTls: true, data: true });
  });

  it('the CA pasted without its line breaks works the same', async () => {
    expect((await smtpAdapter.verify!(relay({ tls_ca: ca.replace(/\r?\n/g, '') }))).ok).toBe(true);
    expect(sessions[0].authOverTls).toBe(true);
  });

  it.each([
    ['another CA', () => ({ tls_ca: otherCa })],
    ['no CA (the public ones)', () => ({ tls_ca: '' })],
    ['another name', () => ({ tls_servername: 'other-relay' })],
  ])('with %s, the handshake fails before any password is sent', async (_what, over) => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const check = await smtpAdapter.verify!(relay(over()));
    expect(check.ok).toBe(false);
    expect(check.detail).toMatch(/^connection: /);
    expect(sessions[0].startTls).toBe(true);
    expect(sessions[0].authOverTls).toBeNull();
    expect(warn.mock.calls.join(' ')).not.toContain(PASSWORD);
  });
});
