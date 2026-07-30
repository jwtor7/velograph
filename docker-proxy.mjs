import { createServer, request } from 'node:http';

const internalPort = Number(process.env['VELO_INTERNAL_PORT'] ?? 5124);
const proxyPort = Number(process.env['VELO_PROXY_PORT'] ?? 5123);
const proxyHost = process.env['VELO_PROXY_HOST'] ?? '127.0.0.1';
const loopbackHostnames = new Set(['127.0.0.1', 'localhost', '[::1]']);
if (!new Set(['127.0.0.1', '0.0.0.0']).has(proxyHost)) {
  throw new Error('proxy_configuration_invalid');
}

function publishedAuthority(host) {
  if (typeof host !== 'string') return null;
  const value = host.trim().toLowerCase();
  const match =
    /^(127\.0\.0\.1|localhost)(?::(\d+))?$/.exec(value) ?? /^(\[::1\])(?::(\d+))?$/.exec(value);
  if (!match) return null;

  const port = match[2] === undefined ? 80 : Number(match[2]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return null;
  return { hostname: match[1], port };
}

function internalOrigin(origin, authority) {
  try {
    const parsed = new URL(origin);
    const hostname = parsed.hostname.toLowerCase();
    const port = parsed.port === '' ? 80 : Number(parsed.port);
    const serializedOriginOnly =
      parsed.username === '' &&
      parsed.password === '' &&
      parsed.pathname === '/' &&
      parsed.search === '' &&
      parsed.hash === '';
    if (
      parsed.protocol !== 'http:' ||
      !serializedOriginOnly ||
      !loopbackHostnames.has(hostname) ||
      hostname !== authority.hostname ||
      port !== authority.port
    ) {
      return null;
    }
    return `http://127.0.0.1:${internalPort}`;
  } catch {
    return null;
  }
}

function rejectRequest(clientRequest, clientResponse, error) {
  const body = JSON.stringify({ error });
  clientRequest.resume();
  clientResponse.writeHead(403, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  clientResponse.end(body);
}

const proxy = createServer((clientRequest, clientResponse) => {
  const hostHeaders = clientRequest.headersDistinct.host;
  const authority = hostHeaders?.length === 1 ? publishedAuthority(hostHeaders[0]) : null;
  if (!authority) {
    rejectRequest(clientRequest, clientResponse, 'host_not_allowed');
    return;
  }

  const originHeaders = clientRequest.headersDistinct.origin;
  let rewrittenOrigin;
  if (originHeaders !== undefined) {
    rewrittenOrigin =
      originHeaders.length === 1 ? internalOrigin(originHeaders[0], authority) : null;
    if (!rewrittenOrigin) {
      rejectRequest(clientRequest, clientResponse, 'origin_not_allowed');
      return;
    }
  }

  const headers = {
    ...clientRequest.headers,
    host: `127.0.0.1:${internalPort}`,
  };
  if (rewrittenOrigin) headers.origin = rewrittenOrigin;

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

proxy.listen(proxyPort, proxyHost);

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => proxy.close(() => process.exit(0)));
}
