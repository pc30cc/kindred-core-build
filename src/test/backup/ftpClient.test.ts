// @vitest-environment node
/**
 * The minimal FTP client used to send database backups to an operator's FTP
 * server (server/services/backup/ftpClient.ts), against an in-process fake
 * FTP server: login, passive transfers, folders relative to the login
 * directory, and that neither the password nor a crafted name leaks into a
 * command or an error.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import net from 'node:net';
import { Readable } from 'node:stream';
import { FtpClient, FtpError, takeReply } from '../../../server/services/backup/ftpClient';

const USER = 'backup';
const PASSWORD = 'pa55-w0rd-secret';
const HOME = '/home/backup';

interface FakeFtp {
  port: number;
  files: Map<string, Buffer>;
  dirs: Set<string>;
  commands: string[];
  close: () => Promise<void>;
}

function join(dir: string, name: string): string {
  if (name.startsWith('/')) return name.replace(/\/+$/, '') || '/';
  return `${dir === '/' ? '' : dir}/${name}`;
}

async function startFakeFtp(): Promise<FakeFtp> {
  const files = new Map<string, Buffer>();
  const dirs = new Set<string>(['/', '/home', HOME]);
  const commands: string[] = [];
  const servers: net.Server[] = [];

  const server = net.createServer((control) => {
    let cwd = '/';
    let user = '';
    let buffer = '';
    let dataSocket: Promise<net.Socket> | null = null;
    const reply = (line: string) => control.write(`${line}\r\n`);
    reply('220-Fake FTP');
    reply('220 ready');

    control.on('data', async (chunk) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 2);
        commands.push(line);
        const [verb, ...rest] = line.split(' ');
        const arg = rest.join(' ');
        switch (verb) {
          case 'USER': user = arg; reply('331 password please'); break;
          case 'PASS':
            if (user === USER && arg === PASSWORD) { cwd = HOME; reply('230 logged in'); }
            else reply('530 Login incorrect');
            break;
          case 'TYPE': reply('200 binary'); break;
          case 'PWD': reply(`257 "${cwd}" is the current directory`); break;
          case 'CWD': {
            const target = join(cwd, arg);
            if (dirs.has(target)) { cwd = target; reply('250 ok'); } else reply('550 no such directory');
            break;
          }
          case 'MKD': dirs.add(join(cwd, arg)); reply(`257 "${join(cwd, arg)}" created`); break;
          case 'EPSV': {
            const data = net.createServer();
            servers.push(data);
            await new Promise<void>((r) => data.listen(0, '127.0.0.1', () => r()));
            dataSocket = new Promise((r) => data.once('connection', (s) => { data.close(); r(s); }));
            reply(`229 Entering Extended Passive Mode (|||${(data.address() as net.AddressInfo).port}|)`);
            break;
          }
          case 'STOR': {
            const pending = dataSocket!;
            reply('150 send it');
            const s = await pending;
            const parts: Buffer[] = [];
            s.on('data', (c: Buffer) => parts.push(c));
            s.on('end', () => { files.set(join(cwd, arg), Buffer.concat(parts)); reply('226 stored'); });
            break;
          }
          case 'RETR': {
            const file = files.get(join(cwd, arg));
            if (!file) { reply('550 not found'); break; }
            const pending = dataSocket!;
            reply('150 here it comes');
            const s = await pending;
            s.end(file, () => reply('226 sent'));
            break;
          }
          case 'DELE': reply(files.delete(join(cwd, arg)) ? '250 deleted' : '550 not found'); break;
          case 'QUIT': reply('221 bye'); control.end(); break;
          default: reply('502 not implemented');
        }
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as net.AddressInfo).port,
    files,
    dirs,
    commands,
    close: async () => {
      for (const s of servers) s.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

let ftp: FakeFtp;
beforeAll(async () => { ftp = await startFakeFtp(); });
afterAll(async () => { await ftp.close(); });

const connect = (password = PASSWORD) =>
  FtpClient.connect({ host: '127.0.0.1', port: ftp.port, user: USER, password, secure: false, verifyTls: true, timeoutMs: 5_000 });

describe('takeReply', () => {
  it('parses single and multi-line replies and waits for incomplete ones', () => {
    expect(takeReply('220 ready\r\nrest')).toEqual({ reply: { code: 220, text: 'ready' }, rest: 'rest' });
    const multi = takeReply('230-Welcome\r\n230-second\r\n230 done\r\n');
    expect(multi?.reply).toEqual({ code: 230, text: 'Welcome\nsecond\ndone' });
    expect(takeReply('230-Welcome\r\n230-second\r\n')).toBeNull();
    expect(takeReply('220 partial')).toBeNull();
    expect(takeReply('garbage\r\n200 ok\r\n')?.reply.code).toBe(200);
  });
});

describe('FtpClient', () => {
  it('uploads, downloads and deletes in a folder relative to the login directory', async () => {
    const client = await connect();
    const payload = Buffer.from('encrypted backup bytes '.repeat(5000));
    await client.ensureDir('webyar-backups/db');
    const sent = await client.upload('x.dump.enc', Readable.from([payload]));
    expect(sent).toBe(payload.length);
    expect(ftp.files.get(`${HOME}/webyar-backups/db/x.dump.enc`)?.equals(payload)).toBe(true);

    // A second relative ensureDir starts again from the login directory, not the current one.
    await client.ensureDir('webyar-backups/db', false);
    expect((await client.download('x.dump.enc')).equals(payload)).toBe(true);
    await client.remove('x.dump.enc');
    await client.remove('x.dump.enc'); // already gone is fine
    expect(ftp.files.size).toBe(0);
    await client.close();
  });

  it('absolute folders start at the root; a missing folder is not created when asked not to', async () => {
    const client = await connect();
    await client.ensureDir('/srv/backups');
    expect(ftp.dirs.has('/srv/backups')).toBe(true);
    await expect(client.ensureDir('/does/not/exist', false)).rejects.toMatchObject({ code: 'ftp_path_failed' });
    await client.close();
  });

  it('a wrong password fails with ftp_login_failed and the password appears nowhere in the error', async () => {
    const wrong = 'not-the-password-123';
    const err = await connect(wrong).then(() => null, (e: unknown) => e as FtpError);
    expect(err).toBeInstanceOf(FtpError);
    expect(err?.code).toBe('ftp_login_failed');
    expect(err?.message).not.toContain(wrong);
  });

  it('refuses names and credentials with line breaks before anything is sent', async () => {
    await expect(
      FtpClient.connect({ host: '127.0.0.1', port: ftp.port, user: 'a\r\nDELE x', password: 'p', secure: false, verifyTls: true }),
    ).rejects.toMatchObject({ code: 'ftp_invalid_argument' });
    const client = await connect();
    await expect(client.upload('evil\r\nDELE other', Readable.from([Buffer.from('x')]))).rejects.toMatchObject({
      code: 'ftp_invalid_argument',
    });
    await client.close();
    expect(ftp.commands.some((c) => c.startsWith('DELE other'))).toBe(false);
  });
});
