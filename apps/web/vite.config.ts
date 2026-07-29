import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

function readPort(raw: string | undefined, fallback: number, name: string): number {
  const value = raw ?? String(fallback);
  if (!/^\d+$/.test(value)) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 to 65535`);
  }
  return port;
}

const apiPort = readPort(
  process.env['VELO_DEV_API_PORT'] ?? process.env['VELO_PORT'],
  5123,
  'VELO_DEV_API_PORT',
);
const webPort = readPort(process.env['VELO_DEV_WEB_PORT'], 5124, 'VELO_DEV_WEB_PORT');
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const allowedWebOrigins = new Set([`http://127.0.0.1:${webPort}`, `http://localhost:${webPort}`]);

export default defineConfig({
  plugins: [react()],
  server: {
    host: '127.0.0.1',
    port: webPort,
    strictPort: true,
    proxy: {
      '/api': {
        target: apiOrigin,
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (proxyRequest, request) => {
            const origin = request.headers.origin;
            if (typeof origin === 'string' && allowedWebOrigins.has(origin)) {
              proxyRequest.setHeader('Origin', apiOrigin);
            }
          });
        },
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
