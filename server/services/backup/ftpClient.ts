/**
 * Minimal FTP / explicit-FTPS client (RFC 959, RFC 4217) for sending database
 * backups to an operator's own FTP server. Built on node:net and node:tls only,
 * with just what the backup needs: passive mode (EPSV, falling back to PASV),
 * binary transfers, CWD/MKD, STOR, RETR and DELE.
 *
 * With `secure`, the control channel is upgraded with AUTH TLS before the
 * credentials are sent, and every data channel is protected (PBSZ 0 / PROT P)
 * and resumes the control channel's TLS session, as vsftpd and others require.
 *
 * The password is never part of an error message. Every argument is checked
 * for CR/LF so a crafted name cannot smuggle a second command.
 */
import net from 'node:net';
import tls from 'node:tls';
import { once } from 'node:events';
import { finished } from 'node:stream/promises';
import type { Readable } from 'node:stream';

export interface FtpConnectOptions {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Explicit FTPS (AUTH TLS) for the control and data channels. */
  secure: boolean;
  /** Verify the server certificate. Off only for a self-signed server the operator trusts. */
  verifyTls: boolean;
  /** Per-reply and data-idle timeout. */
  timeoutMs?: number;
}

export class FtpError extends Error {
  constructor(public code: string, message: string, public reply?: number) {
    super(message);
    this.name = 'FtpError';
  }
}

interface Reply {
  code: number;
  text: string;
}

type Sock = net.Socket | tls.TLSSocket;

function assertArg(value: string): string {
  if (/[\r\n\0]/.test(value)) throw new FtpError('ftp_invalid_argument', 'FTP argument contains a line break');
  return value;
}

/** Parses one complete reply off the front of `buffer`; null until one has fully arrived. */
export function takeReply(buffer: string): { reply: Reply; rest: string } | null {
  let start = 0;
  for (;;) {
    const firstEnd = buffer.indexOf('\n', start);
    if (firstEnd < 0) return null;
    const first = buffer.slice(start, firstEnd).replace(/\r$/, '');
    const head = /^(\d{3})([ -])/.exec(first);
    if (!head) {
      start = firstEnd + 1; // stray line outside a reply: skip it
      continue;
    }
    if (head[2] === ' ') {
      return { reply: { code: Number(head[1]), text: first.slice(4) }, rest: buffer.slice(firstEnd + 1) };
    }
    const lines = [first.slice(4)];
    let pos = firstEnd + 1;
    for (;;) {
      const end = buffer.indexOf('\n', pos);
      if (end < 0) return null;
      const line = buffer.slice(pos, end).replace(/\r$/, '');
      pos = end + 1;
      if (line.startsWith(`${head[1]} `)) {
        lines.push(line.slice(4));
        return { reply: { code: Number(head[1]), text: lines.join('\n') }, rest: buffer.slice(pos) };
      }
      lines.push(line.startsWith(`${head[1]}-`) ? line.slice(4) : line);
    }
  }
}

function tcpConnect(host: string, port: number, timeoutMs: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new FtpError('ftp_connect_failed', `No answer from ${host}:${port}`));
    }, timeoutMs);
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(new FtpError('ftp_connect_failed', `${host}:${port}: ${err.message}`));
    });
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.removeAllListeners('error');
      resolve(socket);
    });
  });
}

export class FtpClient {
  private socket!: Sock;
  private buffer = '';
  private queued: Reply[] = [];
  private waiters: { resolve: (r: Reply) => void; reject: (e: Error) => void }[] = [];
  private broken: Error | null = null;
  private readonly timeoutMs: number;
  /** The login directory (PWD right after login), so relative paths always start from it. */
  private home: string | null = null;

  private constructor(private readonly opts: FtpConnectOptions) {
    this.timeoutMs = opts.timeoutMs ?? 30_000;
  }

  static async connect(options: FtpConnectOptions): Promise<FtpClient> {
    assertArg(options.user);
    assertArg(options.password);
    const client = new FtpClient(options);
    try {
      await client.open();
    } catch (err) {
      client.destroy();
      throw err;
    }
    return client;
  }

  private servername(): string | undefined {
    return net.isIP(this.opts.host) ? undefined : this.opts.host;
  }

  private attach(socket: Sock): void {
    this.socket = socket;
    socket.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString('utf8');
      for (;;) {
        const parsed = takeReply(this.buffer);
        if (!parsed) break;
        this.buffer = parsed.rest;
        const waiter = this.waiters.shift();
        if (waiter) waiter.resolve(parsed.reply);
        else this.queued.push(parsed.reply);
      }
    });
    socket.on('error', (err) => this.fail(new FtpError('ftp_connection_failed', err.message)));
    socket.on('close', () => this.fail(new FtpError('ftp_connection_closed', 'The FTP server closed the connection')));
  }

  private detach(socket: Sock): void {
    socket.removeAllListeners('data');
    socket.removeAllListeners('error');
    socket.removeAllListeners('close');
  }

  private fail(err: Error): void {
    if (!this.broken) this.broken = err;
    for (const waiter of this.waiters.splice(0)) waiter.reject(err);
  }

  private read(timeoutMs = this.timeoutMs): Promise<Reply> {
    const ready = this.queued.shift();
    if (ready) return Promise.resolve(ready);
    if (this.broken) return Promise.reject(this.broken);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        const at = this.waiters.indexOf(entry);
        if (at >= 0) this.waiters.splice(at, 1);
        reject(new FtpError('ftp_timeout', 'The FTP server did not answer in time'));
        this.destroy();
      }, timeoutMs);
      const entry = {
        resolve: (r: Reply) => { clearTimeout(timer); resolve(r); },
        reject: (e: Error) => { clearTimeout(timer); reject(e); },
      };
      this.waiters.push(entry);
    });
  }

  private async send(command: string, timeoutMs?: number): Promise<Reply> {
    if (this.broken) throw this.broken;
    this.socket.write(`${assertArg(command)}\r\n`);
    return this.read(timeoutMs);
  }

  /** Sends a command and requires one of `ok`; the error names only the verb, never its argument. */
  private async expect(command: string, ok: number[], code: string): Promise<Reply> {
    const reply = await this.send(command);
    if (!ok.includes(reply.code)) {
      throw new FtpError(code, `${command.split(' ')[0]} → ${reply.code} ${reply.text}`.slice(0, 300), reply.code);
    }
    return reply;
  }

  private async open(): Promise<void> {
    const plain = await tcpConnect(this.opts.host, this.opts.port, this.timeoutMs);
    this.attach(plain);
    const greeting = await this.read();
    if (greeting.code !== 220) throw new FtpError('ftp_connect_failed', `Unexpected greeting ${greeting.code}`, greeting.code);

    if (this.opts.secure) {
      await this.expect('AUTH TLS', [234], 'ftp_tls_refused');
      this.detach(plain);
      const secured = tls.connect({ socket: plain, servername: this.servername(), rejectUnauthorized: this.opts.verifyTls });
      try {
        await Promise.race([
          once(secured, 'secureConnect'),
          new Promise((_, reject) => setTimeout(() => reject(new Error('TLS handshake timed out')), this.timeoutMs)),
        ]);
      } catch (err) {
        secured.destroy();
        throw new FtpError('ftp_tls_failed', (err as Error).message);
      }
      this.attach(secured);
    }

    const user = await this.send(`USER ${this.opts.user}`);
    if (user.code === 331 || user.code === 332) {
      await this.expect(`PASS ${this.opts.password}`, [230, 202], 'ftp_login_failed');
    } else if (user.code !== 230) {
      throw new FtpError('ftp_login_failed', `USER → ${user.code} ${user.text}`.slice(0, 300), user.code);
    }
    if (this.opts.secure) {
      await this.expect('PBSZ 0', [200], 'ftp_tls_refused');
      await this.expect('PROT P', [200], 'ftp_tls_refused');
    }
    await this.expect('TYPE I', [200], 'ftp_command_failed');
    const pwd = await this.send('PWD');
    const quoted = pwd.code === 257 ? /"((?:[^"]|"")*)"/.exec(pwd.text) : null;
    this.home = quoted ? quoted[1].replace(/""/g, '"') : null;
  }

  /**
   * Changes into `dir` (absolute, or relative to the login directory),
   * creating each missing segment unless `create` is false.
   */
  async ensureDir(dir: string, create = true): Promise<void> {
    const base = dir.startsWith('/') ? '/' : this.home;
    if (base) await this.expect(`CWD ${base}`, [250], 'ftp_path_failed');
    for (const part of dir.split('/').filter(Boolean)) {
      const cwd = await this.send(`CWD ${part}`);
      if (cwd.code === 250) continue;
      if (!create) throw new FtpError('ftp_path_failed', `CWD → ${cwd.code} ${cwd.text}`.slice(0, 300), cwd.code);
      await this.send(`MKD ${part}`); // 257 created; 550 may mean it already exists
      await this.expect(`CWD ${part}`, [250], 'ftp_path_failed');
    }
  }

  private async passiveTarget(): Promise<{ host: string; port: number }> {
    const epsv = await this.send('EPSV');
    if (epsv.code === 229) {
      const m = /\(\|\|\|(\d+)\|\)/.exec(epsv.text);
      if (m) return { host: this.opts.host, port: Number(m[1]) };
    }
    const pasv = await this.send('PASV');
    const m = pasv.code === 227 ? /(\d+),(\d+),(\d+),(\d+),(\d+),(\d+)/.exec(pasv.text) : null;
    if (!m) throw new FtpError('ftp_passive_failed', `PASV → ${pasv.code} ${pasv.text}`.slice(0, 300), pasv.code);
    // The advertised address is ignored: behind NAT it is often private. The
    // data channel goes to the host the control channel already reached.
    return { host: this.opts.host, port: Number(m[5]) * 256 + Number(m[6]) };
  }

  private async openData(): Promise<{ socket: Sock; ready: Promise<unknown> }> {
    const target = await this.passiveTarget();
    const raw = await tcpConnect(target.host, target.port, this.timeoutMs);
    raw.setTimeout(this.timeoutMs, () => raw.destroy(new FtpError('ftp_timeout', 'The FTP data channel stalled')));
    if (!this.opts.secure) return { socket: raw, ready: Promise.resolve() };
    const secured = tls.connect({
      socket: raw,
      servername: this.servername(),
      rejectUnauthorized: this.opts.verifyTls,
      session: (this.socket as tls.TLSSocket).getSession?.(),
    });
    const ready = once(secured, 'secureConnect');
    ready.catch(() => undefined);
    return { socket: secured, ready };
  }

  /** Uploads `source` as `name` in the current directory; returns the bytes sent. */
  async upload(name: string, source: Readable, finishTimeoutMs = 10 * 60_000): Promise<number> {
    assertArg(name);
    const { socket, ready } = await this.openData();
    socket.on('error', () => undefined);
    const start = await this.send(`STOR ${name}`);
    if (start.code !== 125 && start.code !== 150) {
      socket.destroy();
      throw new FtpError('ftp_upload_failed', `STOR → ${start.code} ${start.text}`.slice(0, 300), start.code);
    }
    await ready;
    let bytes = 0;
    source.on('data', (chunk: Buffer) => { bytes += chunk.length; });
    source.pipe(socket);
    await finished(socket, { readable: false });
    socket.end();
    const done = await this.read(finishTimeoutMs);
    if (done.code !== 226 && done.code !== 250) {
      throw new FtpError('ftp_upload_failed', `STOR → ${done.code} ${done.text}`.slice(0, 300), done.code);
    }
    return bytes;
  }

  /** Downloads `name` from the current directory into memory. */
  async download(name: string, finishTimeoutMs = 10 * 60_000): Promise<Buffer> {
    assertArg(name);
    const { socket, ready } = await this.openData();
    const chunks: Buffer[] = [];
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    const ended = finished(socket, { writable: false });
    ended.catch(() => undefined);
    const start = await this.send(`RETR ${name}`);
    if (start.code !== 125 && start.code !== 150) {
      socket.destroy();
      throw new FtpError('ftp_download_failed', `RETR → ${start.code} ${start.text}`.slice(0, 300), start.code);
    }
    await ready;
    await ended;
    const done = await this.read(finishTimeoutMs);
    if (done.code !== 226 && done.code !== 250) {
      throw new FtpError('ftp_download_failed', `RETR → ${done.code} ${done.text}`.slice(0, 300), done.code);
    }
    return Buffer.concat(chunks);
  }

  /** Deletes `name` in the current directory. A file already gone (550) is not an error. */
  async remove(name: string): Promise<void> {
    const reply = await this.send(`DELE ${name}`);
    if (reply.code !== 250 && reply.code !== 550) {
      throw new FtpError('ftp_delete_failed', `DELE → ${reply.code} ${reply.text}`.slice(0, 300), reply.code);
    }
  }

  async close(): Promise<void> {
    try {
      if (!this.broken) await this.send('QUIT', 5_000);
    } catch {
      /* closing anyway */
    }
    this.destroy();
  }

  private destroy(): void {
    try {
      this.socket?.destroy();
    } catch {
      /* already closed */
    }
  }
}
