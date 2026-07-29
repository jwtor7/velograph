import { createServer, request } from 'node:http';

const internalPort = Number(process.env['VELO_INTERNAL_PORT'] ?? 5124);
const proxyPort = Number(process.env['VELO_PROXY_PORT'] ?? 5123);

function internalOrigin(origin) {
  if (!origin) return origin;
  try {
    const parsed = new URL(origin);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) return origin;
    return `http://127.0.0.1:${internalPort}`;
  } catch {
    return origin;
  }
}

const proxy = createServer((clientRequest, clientResponse) => {
  const headers = {
    ...clientRequest.headers,
    host: `127.0.0.1:${internalPort}`,
  };
  if (clientRequest.headers.origin) headers.origin = internalOrigin(clientRequest.headers.origin);

  const upstream = request(
    {
      hostname: '127.0.0.1',
      port: internalPort,
      method: clientRequest.method,
      path: clientRequest.url,
      headers,
    },
    (upstreamResponse) => {
      clientResponse.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      upstreamResponse.pipe(clientResponse);
    },
  );

  upstream.on('error', () => {
    if (!clientResponse.headersSent) {
      clientResponse.writeHead(502, { 'content-type': 'application/json' });
    }
    clientResponse.end('{"error":"upstream_unavailable"}');
  });
  clientRequest.pipe(upstream);
});

proxy.listen(proxyPort, '0.0.0.0');

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => proxy.close(() => process.exit(0)));
}
