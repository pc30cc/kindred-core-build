// @vitest-environment node
/**
 * The Yahoo Mail adapter (channels/mail/yahoo/client.ts), against a small
 * SMTP server of our own instead of Yahoo's:
 *
 *   - the mail carries the Message-ID Core stored and the From name;
 *   - the transport has the platform relay's timeouts;
 *   - a failure says whether the mail may have gone out anyway: only once
 *     the whole message was written and no refusal came back;
 *   - the spam folder is found by its `\Junk` mark, else by Yahoo's name.
 */
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import nodemailer from 'nodemailer';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findYahooSpamFolder, sendViaYahooSmtp, YahooSmtpSendError } from '../../../channels/mail/yahoo/client.js';
import { SMTP_TIMEOUTS } from '../../../server/services/email/providers/smtp.js';

type Ending = 'accept' | 'reject' | 'drop' | 'refuse-recipient';

/** Speaks just enough SMTP for nodemailer, and ends the message as told. */
async function smtpServer(ending: Ending): Promise<{ port: number; messages: string[]; close: () => Promise<void> }> {
  const messages: string[] = [];
  const server = net.createServer((socket) => {
    let data: string | null = null;
    let buffer = '';
    socket.write('220 test ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      if (data !== null) {
        data += buffer;
        buffer = '';
        if (!data.includes('\r\n.\r\n')) return;
        messages.push(data.slice(0, data.indexOf('\r\n.\r\n')));
        data = null;
        if (ending === 'drop') return void socket.destroy();
        socket.write(ending === 'reject' ? '550 5.7.1 message refused\r\n' : '250 2.0.0 queued\r\n');
        return;
      }
      let index: number;
      while ((index = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') socket.write('250-test\r\n250 AUTH XOAUTH2\r\n');
        else if (verb === 'AUTH') socket.write('235 2.7.0 ok\r\n');
        else if (verb === 'MAIL') socket.write('250 ok\r\n');
        else if (verb === 'RCPT') socket.write(ending === 'refuse-recipient' ? '550 5.1.1 no such user\r\n' : '250 ok\r\n');
        else if (verb === 'DATA') {
          socket.write('354 go ahead\r\n');
          data = buffer;
          buffer = '';
          if (data.includes('\r\n.\r\n')) socket.emit('data', Buffer.alloc(0));
          return;
        } else if (verb === 'QUIT') { socket.write('221 bye\r\n'); socket.end(); }
        else if (verb === 'RSET') socket.write('250 ok\r\n');
        else socket.write('250 ok\r\n');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  return {
    port: (server.address() as AddressInfo).port,
    messages,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const message = {
  fromEmail: 'support@acme.test',
  fromName: 'Acme Shop',
  to: ['customer@example.test'],
  subject: 'Your order',
  text: 'It ships today.',
  messageId: '<abc123.1700000000000@acme.test>',
};

describe('sendViaYahooSmtp', () => {
  let stop: (() => Promise<void>) | null = null;
  afterEach(async () => {
    vi.restoreAllMocks();
    await stop?.();
    stop = null;
  });

  it('sends the stored Message-ID and the From name', async () => {
    const server = await smtpServer('accept');
    stop = server.close;
    const result = await sendViaYahooSmtp('token', message, { host: '127.0.0.1', port: server.port, secure: false });
    expect(result.messageId).toBe(message.messageId);
    expect(server.messages[0]).toMatch(/^Message-ID: <abc123\.1700000000000@acme\.test>$/m);
    expect(server.messages[0]).toMatch(/^From: Acme Shop <support@acme\.test>$/m);
  });

  it('uses the platform relay\'s SMTP timeouts and reads no file or URL', async () => {
    const created = vi.spyOn(nodemailer, 'createTransport');
    const server = await smtpServer('accept');
    stop = server.close;
    await sendViaYahooSmtp('token', message, { host: '127.0.0.1', port: server.port, secure: false });
    expect(created.mock.calls[0][0]).toMatchObject({ ...SMTP_TIMEOUTS, disableFileAccess: true, disableUrlAccess: true });
  });

  it('a connection lost after the whole message was written may have delivered it', async () => {
    const server = await smtpServer('drop');
    stop = server.close;
    const err = await sendViaYahooSmtp('token', message, { host: '127.0.0.1', port: server.port, secure: false }).catch((e) => e);
    expect(err).toBeInstanceOf(YahooSmtpSendError);
    expect(err.maybeDelivered).toBe(true);
  });

  it('a refusal, after the message or before it, is definite', async () => {
    for (const ending of ['reject', 'refuse-recipient'] as const) {
      const server = await smtpServer(ending);
      const err = await sendViaYahooSmtp('token', message, { host: '127.0.0.1', port: server.port, secure: false }).catch((e) => e);
      await server.close();
      expect(err).toBeInstanceOf(YahooSmtpSendError);
      expect(err.maybeDelivered).toBe(false);
    }
  });

  it('a server that cannot be reached is definite', async () => {
    const probe = net.createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', () => resolve()));
    const { port } = probe.address() as AddressInfo;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const err = await sendViaYahooSmtp('token', message, { host: '127.0.0.1', port, secure: false }).catch((e) => e);
    expect(err).toBeInstanceOf(YahooSmtpSendError);
    expect(err.maybeDelivered).toBe(false);
  });
});

describe('findYahooSpamFolder', () => {
  it('prefers the folder marked \\Junk', () => {
    expect(findYahooSpamFolder([
      { path: 'INBOX', name: 'INBOX' },
      { path: 'Bulk', name: 'Bulk' },
      { path: 'Spam Box', name: 'Spam Box', specialUse: '\\Junk' },
    ])).toBe('Spam Box');
  });

  it('falls back to Yahoo\'s own name for it, and to nothing', () => {
    expect(findYahooSpamFolder([{ path: 'INBOX' }, { path: 'Bulk Mail', name: 'Bulk Mail' }])).toBe('Bulk Mail');
    expect(findYahooSpamFolder([{ path: 'INBOX' }, { path: 'Sent' }])).toBeNull();
  });
});
