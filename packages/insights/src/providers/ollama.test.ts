import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buildInsightPayload } from '../payload.ts';
import { INSIGHT_OUTPUT_JSON_SCHEMA } from '../schema.ts';
import { buildAnalyticsFixture, buildInsightOutputFixture } from '../test-fixtures.ts';
import {
  createNodeOllamaRuntime,
  createOllamaProvider,
  normalizeOllamaOrigin,
  ollamaProvider,
  type OllamaRuntime,
} from './ollama.ts';

const openServers: ReturnType<typeof createServer>[] = [];

async function listen(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; server: ReturnType<typeof createServer> }> {
  const server = createServer(handler);
  openServers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('test server unavailable');
  return { origin: `http://127.0.0.1:${address.port}`, server };
}

afterEach(async () => {
  await Promise.all(
    openServers.splice(0).map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve());
          server.closeAllConnections();
        }),
    ),
  );
});

describe('Ollama origin policy', () => {
  it.each([
    ['http://127.0.0.1:11434', 'http://127.0.0.1:11434'],
    ['http://127.1.2.3', 'http://127.1.2.3'],
    ['http://[::1]:11434/', 'http://[::1]:11434'],
  ])('accepts the literal loopback origin %s', (input, expected) => {
    expect(normalizeOllamaOrigin(input)).toBe(expected);
  });

  it.each([
    'https://127.0.0.1:11434',
    'http://localhost:11434',
    'http://0.0.0.0:11434',
    'http://192.168.1.2:11434',
    'http://127.0.0.1.example.invalid:11434',
    'http://user:pass@127.0.0.1:11434',
    'http://127.0.0.1:11434/api/chat',
    'http://127.0.0.1:11434?next=elsewhere',
    'http://127.0.0.1:11434#fragment',
    'http://2130706433:11434',
    'http://0x7f000001:11434',
    'http://127.000.000.001:11434',
    'http://127.0.0.1:65536',
  ])('rejects a non-literal or non-origin endpoint without I/O: %s', (input) => {
    expect(() => normalizeOllamaOrigin(input)).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });
});

describe('built-in Node Ollama HTTP runtime', () => {
  it('supports only version, tags, and schema-constrained non-streaming chat', async () => {
    const calls: Array<{ method: string | undefined; path: string | undefined; body: string }> = [];
    const { origin } = await listen((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        calls.push({
          method: request.method,
          path: request.url,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        response.setHeader('Content-Type', 'application/json');
        if (request.url === '/api/version') response.end(JSON.stringify({ version: '1.2.3' }));
        else if (request.url === '/api/tags') {
          response.end(JSON.stringify({ models: [{ name: 'synthetic-model:1' }] }));
        } else {
          response.end(
            JSON.stringify({
              model: 'synthetic-model:1',
              done: true,
              message: { role: 'assistant', content: '{"synthetic":true}' },
            }),
          );
        }
      });
    });
    const runtime = createNodeOllamaRuntime({ origin, timeoutMs: 1_000 });

    await expect(runtime.getVersion({ signal: undefined })).resolves.toBe('1.2.3');
    await expect(runtime.listModels({ signal: undefined })).resolves.toEqual(['synthetic-model:1']);
    await expect(
      runtime.chat({
        model: 'synthetic-model:1',
        prompt: 'synthetic prompt',
        schema: INSIGHT_OUTPUT_JSON_SCHEMA,
        signal: undefined,
      }),
    ).resolves.toEqual({
      outputText: '{"synthetic":true}',
      modelId: 'synthetic-model:1',
    });

    expect(calls.map(({ method, path }) => [method, path])).toEqual([
      ['GET', '/api/version'],
      ['GET', '/api/tags'],
      ['POST', '/api/chat'],
    ]);
    const chatBody = JSON.parse(calls[2]!.body) as Record<string, unknown>;
    expect(chatBody).toMatchObject({
      model: 'synthetic-model:1',
      stream: false,
      format: INSIGHT_OUTPUT_JSON_SCHEMA,
      messages: [{ role: 'user', content: 'synthetic prompt' }],
    });
  });

  it('does not follow redirects', async () => {
    let requestCount = 0;
    const { origin } = await listen((_request, response) => {
      requestCount += 1;
      response.statusCode = 302;
      response.setHeader('Location', 'http://127.0.0.2:9/api/version');
      response.setHeader('Content-Type', 'application/json');
      response.end('{}');
    });
    const runtime = createNodeOllamaRuntime({ origin });
    await expect(runtime.getVersion({ signal: undefined })).rejects.toMatchObject({
      code: 'provider_response_invalid',
    });
    expect(requestCount).toBe(1);
  });

  it('caps response bodies before parsing them', async () => {
    const { origin } = await listen((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({ version: 'x'.repeat(512) }));
    });
    const runtime = createNodeOllamaRuntime({ origin, maxResponseBytes: 64 });
    await expect(runtime.getVersion({ signal: undefined })).rejects.toMatchObject({
      code: 'provider_output_too_large',
    });
  });

  it('maps malformed JSON to a stable response error without throwing outside the request promise', async () => {
    const { origin } = await listen((_request, response) => {
      response.setHeader('Content-Type', 'application/json');
      response.end('{');
    });
    const runtime = createNodeOllamaRuntime({ origin });
    await expect(runtime.getVersion({ signal: undefined })).rejects.toMatchObject({
      code: 'provider_response_invalid',
    });
  });

  it('enforces total timeout and cancellation', async () => {
    const { origin } = await listen(() => {
      // Deliberately never respond; the client must tear down the socket.
    });
    const timed = createNodeOllamaRuntime({ origin, timeoutMs: 15 });
    await expect(timed.getVersion({ signal: undefined })).rejects.toMatchObject({
      code: 'provider_timeout',
    });

    const controller = new AbortController();
    const cancellable = createNodeOllamaRuntime({ origin, timeoutMs: 1_000 });
    const pending = cancellable.getVersion({ signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'generation_cancelled' });
  });

  it('has no model-pull route and uses direct Node HTTP with proxy-free agent selection', () => {
    const path = fileURLToPath(new URL('./ollama.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    expect(source).not.toContain('/api/pull');
    expect(source).not.toContain('/api/create');
    expect(source).not.toContain('fetch(');
    expect(source).not.toContain('node:https');
    expect(source).toContain('agent: false');
  });

  it('does not allow callers to remove the hard resource ceilings', () => {
    expect(() =>
      createNodeOllamaRuntime({ maxResponseBytes: Number.MAX_SAFE_INTEGER }),
    ).toThrowError(expect.objectContaining({ code: 'invalid_request' }));
    expect(() => createNodeOllamaRuntime({ timeoutMs: Number.MAX_SAFE_INTEGER })).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });
});

describe('Ollama provider', () => {
  const payload = buildInsightPayload(buildAnalyticsFixture());
  const promptVersion = 'test-prompt-v1';

  it('keeps the exported singleton unconfigured and disabled-by-selection by default', async () => {
    expect(ollamaProvider.describe().destination).toBe('local-loopback');
    expect(ollamaProvider.availability()).toEqual({
      available: false,
      reason: 'not_configured',
    });
    await expect(ollamaProvider.generate({ payload, promptVersion })).rejects.toMatchObject({
      code: 'provider_not_configured',
    });
  });

  it('checks installed tags before chat and routes output through common validation', async () => {
    const output = buildInsightOutputFixture(promptVersion);
    const runtime: OllamaRuntime = {
      getVersion: vi.fn(async () => '1.2.3'),
      listModels: vi.fn(async () => ['synthetic-model:1']),
      chat: vi.fn(async ({ prompt, schema }) => {
        expect(prompt).toContain('"payloadVersion":"insight-payload-v1"');
        expect(schema).toBe(INSIGHT_OUTPUT_JSON_SCHEMA);
        return {
          outputText: JSON.stringify(output),
          modelId: 'synthetic-model:1',
        };
      }),
    };
    const provider = createOllamaProvider({ model: 'synthetic-model:1', runtime });

    await expect(provider.getVersion()).resolves.toBe('1.2.3');
    await expect(provider.generate({ payload, promptVersion })).resolves.toMatchObject({
      ok: true,
      output,
      modelId: 'synthetic-model:1',
    });
    expect(runtime.listModels).toHaveBeenCalledOnce();
    expect(runtime.chat).toHaveBeenCalledOnce();
  });

  it('never calls chat when the configured model is not installed', async () => {
    const runtime: OllamaRuntime = {
      getVersion: vi.fn(async () => '1.2.3'),
      listModels: vi.fn(async () => ['another-model:1']),
      chat: vi.fn(),
    };
    const provider = createOllamaProvider({ model: 'synthetic-model:1', runtime });
    await expect(provider.generate({ payload, promptVersion })).rejects.toMatchObject({
      code: 'provider_model_unavailable',
    });
    expect(runtime.chat).not.toHaveBeenCalled();
  });

  it('rejects malformed runtime output rather than returning it', async () => {
    const runtime: OllamaRuntime = {
      getVersion: vi.fn(async () => '1.2.3'),
      listModels: vi.fn(async () => ['synthetic-model:1']),
      chat: vi.fn(async () => ({ outputText: 'not-json', modelId: 'synthetic-model:1' })),
    };
    const provider = createOllamaProvider({ model: 'synthetic-model:1', runtime });
    await expect(provider.generate({ payload, promptVersion })).rejects.toMatchObject({
      code: 'output_parse_failed',
    });
  });
});
