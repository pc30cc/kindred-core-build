// @vitest-environment node
/**
 * The SMTP adapter (server/services/email/providers/smtp.ts) through the
 * real nodemailer 10.2.1, against a small SMTP server in this process that
 * speaks just enough of the protocol (EHLO, AUTH PLAIN, MAIL, RCPT, DATA)
 * and records what it was sent. Nothing else in the suite exercises the
 * relay's path, which every platform mail takes since 2026-10-29.
 *
 *   - the envelope has one recipient; From is a name and an address, quoted
 *     and encoded by the library (a comma, Persian text);
 *   - Auto-Submitted, List-Unsubscribe, Reply-To and the text part arrive;
 *   - the relay's queue id ("queued as …") comes back as serverMessageId;
 *   - every step has a timeout, and a stalled greeting ends as `timeout`;
 *   - `starttls` refuses a server without STARTTLS before any password is
 *     sent; `auto` still talks to it (today's relay);
 *   - a refused sign-in is `auth` and permanent, a 550 recipient permanent,
 *     a 451 transient, a closed port `connection`; the server's own text and
 *     the password never reach the SendResult;
 *   - verify() signs in without sending.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import net from 'node:net';
import nodemailer from 'nodemailer';
import { simpleParser } from 'mailparser';
import { SMTP_TIMEOUTS, classifySmtpError, smtpAdapter } from '../../../server/services/email/providers/smtp';
import type { OutboundMessage } from '../../../server/services/email/providers/types';

interface Session {
  auth?: string;
  mailFrom?: string;
  rcpt: string[];
  data?: string;
  startTls?: boolean;
}

interface Behaviour {
  greeting?: boolean;
  authReply?: string;
  rcptReply?: string;
  dataReply?: string;
  offerAuth?: boolean;
}

const sessions: Session[] = [];
let behaviour: Behaviour = {};
let server: net.Server;
let port = 0;

beforeAll(async () => {
  server = net.createServer((socket) => {
    const session: Session = { rcpt: [] };
    sessions.push(session);
    socket.on('error', () => {});
    if (behaviour.greeting !== false) socket.write('220 fake.relay ESMTP\r\n');
    let buffer = '';
    let inData = false;
    let data = '';
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let at: number;
      while ((at = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, at);
        buffer = buffer.slice(at + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            session.data = data;
            socket.write(behaviour.dataReply ?? '250 2.0.0 Ok: queued as 4ABC123\r\n');
          } else {
            data += `${line.startsWith('..') ? line.slice(1) : line}\r\n`;
          }
          continue;
        }
        const verb = line.toUpperCase();
        if (verb.startsWith('EHLO')) {
          socket.write(`250-fake.relay\r\n${behaviour.offerAuth === false ? '' : '250-AUTH PLAIN\r\n'}250 8BITMIME\r\n`);
        } else if (verb.startsWith('HELO')) socket.write('250 fake.relay\r\n');
        else if (verb.startsWith('STARTTLS')) {
          session.startTls = true;
          socket.write('502 5.5.1 STARTTLS not offered\r\n');
        } else if (verb.startsWith('AUTH')) {
          session.auth = line;
          socket.write(behaviour.authReply ?? '235 2.7.0 Authentication successful\r\n');
        } else if (verb.startsWith('MAIL FROM')) {
          session.mailFrom = line;
          socket.write('250 2.1.0 Ok\r\n');
        } else if (verb.startsWith('RCPT TO')) {
          session.rcpt.push(line);
          socket.write(behaviour.rcptReply ?? '250 2.1.5 Ok\r\n');
        } else if (verb === 'DATA') {
          inData = true;
          socket.write('354 End data with <CR><LF>.<CR><LF>\r\n');
        } else if (verb === 'QUIT') socket.end('221 2.0.0 Bye\r\n');
        else if (verb === 'RSET' || verb === 'NOOP') socket.write('250 2.0.0 Ok\r\n');
        else socket.write('502 5.5.2 Error: command not recognized\r\n');
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  port = (server.address() as net.AddressInfo).port;
});

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

afterEach(() => {
  sessions.length = 0;
  behaviour = {};
  vi.restoreAllMocks();
});

const PASSWORD = 'relay-pass-0123';
const relay = (over: Record<string, unknown> = {}) => ({
  provider_name: 'smtp',
  config: {
    smtp_host: '127.0.0.1', smtp_port: String(port), smtp_user: 'noreply@webyar.ai', smtp_pass: PASSWORD,
    from_email: 'noreply@webyar.ai', from_name: 'Webyar', ...over,
  },
});
const message = (over: Partial<OutboundMessage> = {}): OutboundMessage => ({
  from: { name: 'Webyar', address: 'noreply@webyar.ai' },
  to: 'person@example.com',
  subject: 'Hello',
  html: '<p>Hi <a href="https://x.example/r?t=1">there</a></p>',
  text: 'Hi there (https://x.example/r?t=1)',
  headers: { 'Auto-Submitted': 'auto-generated' },
  ...over,
});

describe('a send through the relay', () => {
  it('one recipient, the From as name and address, every header and both parts', async () => {
    const result = await smtpAdapter.send(relay(), message({
      from: { name: 'Acme, Inc.', address: 'noreply@webyar.ai' },
      replyTo: 'support@webyar.ai',
      headers: {
        'Auto-Submitted': 'auto-generated',
        'List-Unsubscribe': '<https://app.webyar.ai/u/1>',
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      },
    }));
    expect(result).toMatchObject({ success: true, provider: 'smtp', serverMessageId: '4ABC123' });
    const s = sessions[0];
    expect(s.auth).toMatch(/^AUTH PLAIN /);
    expect(s.mailFrom).toBe('MAIL FROM:<noreply@webyar.ai>');
    expect(s.rcpt).toEqual(['RCPT TO:<person@example.com>']);
    const raw = s.data!;
    expect(raw).toMatch(/^From: "Acme, Inc." <noreply@webyar\.ai>$/m);
    expect(raw).toMatch(/^Auto-Submitted: auto-generated$/m);
    expect(raw).toMatch(/^List-Unsubscribe: <https:\/\/app\.webyar\.ai\/u\/1>$/m);
    expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click$/m);
    const mail = await simpleParser(raw);
    expect(mail.from?.value).toEqual([{ name: 'Acme, Inc.', address: 'noreply@webyar.ai' }]);
    expect(mail.replyTo?.value).toEqual([{ name: '', address: 'support@webyar.ai' }]);
    expect(mail.text?.trim()).toBe('Hi there (https://x.example/r?t=1)');
    expect(mail.html).toContain('<a href="https://x.example/r?t=1">');
  });

  it('a Persian sender name is encoded, not mangled', async () => {
    await smtpAdapter.send(relay(), message({ from: { name: 'وب‌یار', address: 'noreply@webyar.ai' } }));
    const raw = sessions[0].data!;
    expect(raw).toMatch(/^From: =\?UTF-8\?/m);
    expect((await simpleParser(raw)).from?.value[0]).toEqual({ name: 'وب‌یار', address: 'noreply@webyar.ai' });
  });

  it('a text-only message has no HTML part', async () => {
    await smtpAdapter.send(relay(), message({ html: '', text: 'plain' }));
    const mail = await simpleParser(sessions[0].data!);
    expect(mail.html).toBe(false);
    expect(mail.text?.trim()).toBe('plain');
  });
});

describe('transport options', () => {
  it('every step has a timeout, and the library may read no file or URL', async () => {
    const spy = vi.spyOn(nodemailer, 'createTransport');
    await smtpAdapter.send(relay(), message());
    const options = spy.mock.calls[0][0] as Record<string, unknown>;
    expect(options).toMatchObject({
      connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 30_000, dnsTimeout: 10_000,
      disableFileAccess: true, disableUrlAccess: true,
    });
  });

  it.each([
    [{}, { secure: false, requireTLS: false, ignoreTLS: false }],
    [{ encryption: 'starttls' }, { secure: false, requireTLS: true, ignoreTLS: false }],
    [{ encryption: 'none' }, { secure: false, requireTLS: false, ignoreTLS: true }],
    [{ encryption: 'ssl' }, { secure: true }],
    [{ smtp_port: '465' }, { secure: true }],
    [{ smtp_secure: 'true' }, { requireTLS: true }],
    [{ encryption: 'starttls', tls_servername: 'relay.webyar.ai' }, { tls: { rejectUnauthorized: true, servername: 'relay.webyar.ai' } }],
  ])('%j → %j', async (over, expected) => {
    const spy = vi.spyOn(nodemailer, 'createTransport').mockReturnValue({
      sendMail: async () => ({ messageId: 'm' }),
      close: () => {},
    } as never);
    await smtpAdapter.send(relay(over), message());
    expect(spy.mock.calls[0][0]).toMatchObject(expected);
  });

  it('a stalled greeting ends as a transient timeout', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    behaviour.greeting = false;
    const saved = { ...SMTP_TIMEOUTS };
    Object.assign(SMTP_TIMEOUTS as Record<string, number>, { connectionTimeout: 400, greetingTimeout: 300 });
    try {
      const started = Date.now();
      const result = await smtpAdapter.send(relay(), message());
      expect(result).toMatchObject({ success: false, errorCode: 'timeout', permanent: false });
      expect(Date.now() - started).toBeLessThan(5_000);
    } finally {
      Object.assign(SMTP_TIMEOUTS as Record<string, number>, saved);
    }
  });
});

describe('TLS', () => {
  it('starttls refuses a relay without STARTTLS before any password crosses the wire', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const result = await smtpAdapter.send(relay({ encryption: 'starttls' }), message());
    expect(result).toMatchObject({ success: false, errorCode: 'connection' });
    expect(sessions[0].startTls).toBe(true);
    expect(sessions[0].auth).toBeUndefined();
    expect(sessions[0].data).toBeUndefined();
  });

  it('auto still talks to today\'s relay, which offers no STARTTLS', async () => {
    expect((await smtpAdapter.send(relay(), message())).success).toBe(true);
    expect(sessions[0].startTls).toBeUndefined();
  });
});

describe('failures', () => {
  it('a refused sign-in is auth and permanent, without the server\'s text or the password', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    behaviour.authReply = '535 5.7.8 Error: authentication failed: internal-host 172.18.0.5\r\n';
    const result = await smtpAdapter.send(relay(), message());
    expect(result).toMatchObject({ success: false, errorCode: 'auth', permanent: true });
    expect(result.error).toBe('auth: the SMTP server refused the sign-in (535)');
    expect(result.error).not.toContain('172.18');
    const printed = warn.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('172.18.0.5');
    expect(printed).not.toContain(PASSWORD);
  });

  it('a 550 recipient is permanent, a 451 transient', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    behaviour.rcptReply = '550 5.1.1 <person@example.com>: Recipient address rejected\r\n';
    expect(await smtpAdapter.send(relay(), message())).toMatchObject({ errorCode: 'rejected', permanent: true });
    behaviour.rcptReply = '451 4.3.0 Try again later\r\n';
    expect(await smtpAdapter.send(relay(), message())).toMatchObject({ errorCode: 'rejected', permanent: false });
  });

  it('a closed port is a transient connection failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const closed = net.createServer();
    await new Promise<void>((resolve) => closed.listen(0, '127.0.0.1', resolve));
    const free = (closed.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => closed.close(() => resolve()));
    expect(await smtpAdapter.send(relay({ smtp_port: String(free) }), message())).toMatchObject({ errorCode: 'connection', permanent: false });
  });

  it('no host is unconfigured', async () => {
    expect(await smtpAdapter.send(relay({ smtp_host: '' }), message())).toMatchObject({ errorCode: 'unconfigured', permanent: true });
  });

  it('nodemailer\'s own permanent flag wins over the reply code', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(classifySmtpError({ code: 'EENVELOPE', responseCode: 554, permanent: false })).toMatchObject({ errorCode: 'rejected', permanent: false });
    expect(classifySmtpError({ code: 'EMESSAGE', responseCode: 503 })).toMatchObject({ permanent: false });
    expect(classifySmtpError({ code: 'ETIMEDOUT' })).toMatchObject({ errorCode: 'timeout', permanent: false });
    expect(classifySmtpError({ responseCode: 421 })).toMatchObject({ errorCode: 'connection', permanent: false });
  });
});

describe('verify', () => {
  it('connects and signs in without sending', async () => {
    const result = await smtpAdapter.verify!(relay());
    expect(result.ok).toBe(true);
    expect(result.detail).toContain('signed in');
    expect(sessions[0].auth).toMatch(/^AUTH PLAIN /);
    expect(sessions[0].mailFrom).toBeUndefined();
  });

  it('reports a refused sign-in as auth', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    behaviour.authReply = '535 5.7.8 Error: authentication failed\r\n';
    const result = await smtpAdapter.verify!(relay());
    expect(result).toEqual({ ok: false, detail: 'auth: the SMTP server refused the sign-in (535)' });
  });
});
