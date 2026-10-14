import http from 'node:http';
import net from 'node:net';
import { lookup } from 'node:dns/promises';
import { isBlockedHostname, isBlockedIpAddress, isSafeOutboundUrl, normalizeHostname } from '../../shared/net/hostGuard.js';

/** Resolve ONCE, validate every answer, then connect to the validated IP.
 * This prevents Chromium doing a second DNS lookup after a safe preflight.
 */
export async function publicDestination(authority: string, resolve = lookup) {
  const url = new URL(`https://${authority}`);
  if (url.port && url.port !== '443') throw new Error('blocked_destination');
  if (!isSafeOutboundUrl(url.toString()) || url.pathname !== '/' || url.search || url.hash) throw new Error('blocked_destination');
  const host = normalizeHostname(url.hostname);
  if (isBlockedHostname(host)) throw new Error('blocked_destination');
  const answers = await resolve(host, { all: true });
  if (!answers.length || answers.some(a => isBlockedIpAddress(a.address, a.family))) throw new Error('blocked_destination');
  return { address: answers[0].address, family: answers[0].family };
}

/** HTTPS/WSS only, for the page AND its frames, scripts, redirects and APIs. */
export async function startBridgeEgress() {
  const sockets = new Set<net.Socket>();
  const server = http.createServer((_req, res) => { res.writeHead(403); res.end(); });
  server.on('connect', async (req, client, head) => {
    const socket = client as net.Socket;
    sockets.add(socket); socket.on('close', () => sockets.delete(socket));
    socket.setTimeout(90_000, () => socket.destroy());
    try {
      const { address, family } = await publicDestination(req.url || '');
      if (socket.destroyed) return;
      const upstream = net.connect({ host: address, family, port: 443 });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.setTimeout(90_000, () => upstream.destroy());
      upstream.on('error', () => socket.destroy());
      socket.on('error', () => upstream.destroy());
      socket.on('close', () => upstream.destroy());
      upstream.once('connect', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        socket.pipe(upstream); upstream.pipe(socket);
      });
    } catch { socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject); server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as net.AddressInfo;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>(resolve => server.close(() => resolve()));
    },
  };
}
