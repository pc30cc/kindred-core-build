/**
 * `@supabase/supabase-js` always calls `${supabaseUrl}/rest/v1/...`
 * (and `/rest/v1/rpc/...` for RPCs) — that `/rest/v1` prefix is normally
 * stripped by Supabase's own API gateway (Kong) in front of PostgREST.
 * A bare PostgREST instance serves tables at its root instead, so this
 * tiny reverse proxy plays Kong's part for the e2e stack: strip the
 * prefix, forward everything else to PostgREST unchanged.
 */
import http from 'node:http';

const PORT = Number(process.env.E2E_GATEWAY_PORT);
const POSTGREST_PORT = Number(process.env.E2E_POSTGREST_PORT);

const server = http.createServer((req, res) => {
  const forwardPath = (req.url || '/').replace(/^\/rest\/v1/, '') || '/';
  const proxyReq = http.request(
    {
      host: '127.0.0.1',
      port: POSTGREST_PORT,
      path: forwardPath,
      method: req.method,
      headers: req.headers,
    },
    (proxyRes) => {
      res.writeHead(proxyRes.statusCode || 502, proxyRes.headers);
      proxyRes.pipe(res);
    },
  );
  proxyReq.on('error', (err) => {
    res.writeHead(502).end(`gateway error: ${err.message}`);
  });
  req.pipe(proxyReq);
});

server.listen(PORT, '127.0.0.1', () => {
  // eslint-disable-next-line no-console
  console.log(`[e2e-postgrest-gateway] :${PORT} -> postgrest :${POSTGREST_PORT} (stripping /rest/v1)`);
});
