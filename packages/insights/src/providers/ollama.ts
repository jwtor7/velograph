import { request as nodeHttpRequest } from 'node:http';
import { InsightGenerationError, stableProviderError } from '../errors.ts';
import {
  ABSOLUTE_MAX_PROMPT_BYTES,
  ABSOLUTE_MAX_PROVIDER_OUTPUT_BYTES,
  DEFAULT_MAX_PROVIDER_OUTPUT_BYTES,
  generateValidatedInsight,
  type RawInsightProviderRequest,
} from '../orchestrator.ts';
import type { INSIGHT_OUTPUT_JSON_SCHEMA } from '../schema.ts';
import type { GenerateRequest, InsightProvider } from '../types.ts';

export const DEFAULT_OLLAMA_ORIGIN = 'http://127.0.0.1:11434';
export const DEFAULT_OLLAMA_TIMEOUT_MS = 60_000;
export const DEFAULT_OLLAMA_REQUEST_BYTES = 256 * 1024;
export const DEFAULT_OLLAMA_RESPONSE_BYTES = 512 * 1024;
export const MAX_OLLAMA_TIMEOUT_MS = 5 * 60_000;

const MODEL_NAME = /^[a-z0-9][a-z0-9._:/-]{0,255}$/i;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export interface OllamaRuntimeCall {
  signal: AbortSignal | undefined;
}

export interface OllamaChatCall extends OllamaRuntimeCall {
  model: string;
  prompt: string;
  schema: typeof INSIGHT_OUTPUT_JSON_SCHEMA;
}

export interface OllamaChatResult {
  outputText: string;
  modelId: string;
}

/** Injectable boundary used by the provider; tests never need a real daemon. */
export interface OllamaRuntime {
  getVersion(call: OllamaRuntimeCall): Promise<string>;
  listModels(call: OllamaRuntimeCall): Promise<readonly string[]>;
  chat(call: OllamaChatCall): Promise<OllamaChatResult>;
}

export interface NodeOllamaRuntimeOptions {
  origin?: string;
  timeoutMs?: number;
  maxRequestBytes?: number;
  maxResponseBytes?: number;
}

export interface OllamaProviderOptions extends NodeOllamaRuntimeOptions {
  model?: string;
  runtime?: OllamaRuntime;
}

export interface OllamaProvider extends InsightProvider {
  getVersion(signal?: AbortSignal): Promise<string>;
  listModels(signal?: AbortSignal): Promise<readonly string[]>;
}

function invalidConfiguration(): never {
  throw new InsightGenerationError('invalid_request', 'ollama');
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) invalidConfiguration();
  return value;
}

function validModelName(value: unknown): value is string {
  return typeof value === 'string' && MODEL_NAME.test(value);
}

/**
 * Accepts only an IP-literal loopback HTTP origin. Hostnames (including
 * localhost), URL credentials, non-canonical numeric IP forms, paths,
 * queries, fragments, and non-HTTP schemes are rejected before any I/O.
 */
export function normalizeOllamaOrigin(input: string): string {
  if (typeof input !== 'string' || input.length > 128) invalidConfiguration();
  const match = /^http:\/\/(127(?:\.(?:0|[1-9]\d{0,2})){3}|\[::1\])(?::([1-9]\d{0,4}))?\/?$/.exec(
    input,
  );
  if (!match) invalidConfiguration();

  const host = match[1]!;
  const portText = match[2];
  if (host.startsWith('127.')) {
    const octets = host.split('.').map(Number);
    if (octets.length !== 4 || octets.some((octet) => octet > 255)) invalidConfiguration();
  }
  if (portText !== undefined && Number(portText) > 65_535) invalidConfiguration();

  const parsed = new URL(input);
  if (
    parsed.protocol !== 'http:' ||
    parsed.username !== '' ||
    parsed.password !== '' ||
    parsed.pathname !== '/' ||
    parsed.search !== '' ||
    parsed.hash !== ''
  ) {
    invalidConfiguration();
  }
  return parsed.origin;
}

function parseJsonResponse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new InsightGenerationError('provider_response_invalid', 'ollama');
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Built-in direct Node HTTP runtime. It never consults proxy environment
 * variables, never follows redirects, and exposes no endpoint capable of
 * pulling a model.
 */
export function createNodeOllamaRuntime(options: NodeOllamaRuntimeOptions = {}): OllamaRuntime {
  const origin = normalizeOllamaOrigin(options.origin ?? DEFAULT_OLLAMA_ORIGIN);
  const timeoutMs = boundedLimit(
    options.timeoutMs ?? DEFAULT_OLLAMA_TIMEOUT_MS,
    MAX_OLLAMA_TIMEOUT_MS,
  );
  const maxRequestBytes = boundedLimit(
    options.maxRequestBytes ?? DEFAULT_OLLAMA_REQUEST_BYTES,
    ABSOLUTE_MAX_PROMPT_BYTES,
  );
  const maxResponseBytes = boundedLimit(
    options.maxResponseBytes ?? DEFAULT_OLLAMA_RESPONSE_BYTES,
    ABSOLUTE_MAX_PROVIDER_OUTPUT_BYTES,
  );

  async function requestJson(
    method: 'GET' | 'POST',
    path: '/api/version' | '/api/tags' | '/api/chat',
    body: unknown,
    signal: AbortSignal | undefined,
  ): Promise<unknown> {
    if (signal?.aborted === true) {
      throw new InsightGenerationError('generation_cancelled', 'ollama');
    }

    const encoded = body === null ? null : Buffer.from(JSON.stringify(body), 'utf8');
    if (encoded !== null && encoded.byteLength > maxRequestBytes) {
      throw new InsightGenerationError('prompt_too_large', 'ollama');
    }

    return new Promise<unknown>((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let responseTooLarge = false;
      let request: ReturnType<typeof nodeHttpRequest>;

      const finish = (error: InsightGenerationError | null, value?: unknown): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve(value);
      };

      const abort = (): void => {
        finish(new InsightGenerationError('generation_cancelled', 'ollama'));
        request.destroy();
      };

      const timeout = setTimeout(() => {
        timedOut = true;
        finish(new InsightGenerationError('provider_timeout', 'ollama'));
        request.destroy();
      }, timeoutMs);
      timeout.unref?.();

      try {
        const target = new URL(path, `${origin}/`);
        request = nodeHttpRequest(
          target,
          {
            method,
            agent: false,
            headers: {
              Accept: 'application/json',
              Connection: 'close',
              ...(encoded === null
                ? {}
                : {
                    'Content-Type': 'application/json',
                    'Content-Length': String(encoded.byteLength),
                  }),
            },
          },
          (response) => {
            const chunks: Buffer[] = [];
            let total = 0;

            response.on('data', (chunk: Buffer | string) => {
              if (settled) return;
              const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
              total += bytes.byteLength;
              if (total > maxResponseBytes) {
                responseTooLarge = true;
                finish(new InsightGenerationError('provider_output_too_large', 'ollama'));
                response.destroy();
                request.destroy();
                return;
              }
              chunks.push(bytes);
            });
            response.on('error', () => {
              if (responseTooLarge) {
                finish(new InsightGenerationError('provider_output_too_large', 'ollama'));
              } else {
                finish(new InsightGenerationError('provider_response_invalid', 'ollama'));
              }
            });
            response.on('aborted', () => {
              finish(new InsightGenerationError('provider_response_invalid', 'ollama'));
            });
            response.on('end', () => {
              if (settled) return;
              const status = response.statusCode ?? 0;
              if (status >= 300 && status < 400) {
                finish(new InsightGenerationError('provider_response_invalid', 'ollama'));
                return;
              }
              if (status < 200 || status >= 300) {
                finish(new InsightGenerationError('provider_failed', 'ollama'));
                return;
              }
              const contentType = response.headers['content-type'];
              if (
                typeof contentType !== 'string' ||
                !contentType.toLowerCase().includes('application/json')
              ) {
                finish(new InsightGenerationError('provider_response_invalid', 'ollama'));
                return;
              }
              const text = Buffer.concat(chunks, total).toString('utf8');
              try {
                finish(null, parseJsonResponse(text));
              } catch (error) {
                finish(
                  error instanceof InsightGenerationError
                    ? error
                    : new InsightGenerationError('provider_response_invalid', 'ollama'),
                );
              }
            });
          },
        );
      } catch {
        finish(new InsightGenerationError('provider_unreachable', 'ollama'));
        return;
      }

      request.on('error', () => {
        if (timedOut) {
          finish(new InsightGenerationError('provider_timeout', 'ollama'));
        } else if (signal?.aborted === true) {
          finish(new InsightGenerationError('generation_cancelled', 'ollama'));
        } else if (responseTooLarge) {
          finish(new InsightGenerationError('provider_output_too_large', 'ollama'));
        } else {
          finish(new InsightGenerationError('provider_unreachable', 'ollama'));
        }
      });
      signal?.addEventListener('abort', abort, { once: true });

      if (encoded === null) request.end();
      else request.end(encoded);
    });
  }

  return {
    async getVersion({ signal }) {
      const raw = await requestJson('GET', '/api/version', null, signal);
      if (!isRecord(raw)) {
        throw new InsightGenerationError('provider_response_invalid', 'ollama');
      }
      const version = raw['version'];
      if (
        typeof version !== 'string' ||
        version.length === 0 ||
        version.length > 128 ||
        CONTROL_CHARACTER.test(version)
      ) {
        throw new InsightGenerationError('provider_response_invalid', 'ollama');
      }
      return version;
    },

    async listModels({ signal }) {
      const raw = await requestJson('GET', '/api/tags', null, signal);
      if (!isRecord(raw) || !Array.isArray(raw['models']) || raw['models'].length > 1_024) {
        throw new InsightGenerationError('provider_response_invalid', 'ollama');
      }
      const names = new Set<string>();
      for (const item of raw['models']) {
        if (!isRecord(item)) {
          throw new InsightGenerationError('provider_response_invalid', 'ollama');
        }
        for (const candidate of [item['name'], item['model']]) {
          if (candidate !== undefined) {
            if (!validModelName(candidate)) {
              throw new InsightGenerationError('provider_response_invalid', 'ollama');
            }
            names.add(candidate);
          }
        }
      }
      return [...names];
    },

    async chat({ model, prompt, schema, signal }) {
      if (!validModelName(model)) invalidConfiguration();
      const raw = await requestJson(
        'POST',
        '/api/chat',
        {
          model,
          stream: false,
          format: schema,
          messages: [{ role: 'user', content: prompt }],
          options: { temperature: 0 },
        },
        signal,
      );
      if (!isRecord(raw) || raw['done'] !== true || !isRecord(raw['message'])) {
        throw new InsightGenerationError('provider_response_invalid', 'ollama');
      }
      const outputText = raw['message']['content'];
      const modelId = raw['model'];
      if (typeof outputText !== 'string' || !validModelName(modelId)) {
        throw new InsightGenerationError('provider_response_invalid', 'ollama');
      }
      return { outputText, modelId };
    },
  };
}

function normalizeRuntimeError(error: unknown): never {
  throw stableProviderError(error, 'ollama');
}

export function createOllamaProvider(options: OllamaProviderOptions = {}): OllamaProvider {
  const model = options.model;
  if (model !== undefined && !validModelName(model)) invalidConfiguration();
  const runtime =
    options.runtime ??
    createNodeOllamaRuntime({
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.maxRequestBytes === undefined
        ? {}
        : { maxRequestBytes: options.maxRequestBytes }),
      ...(options.maxResponseBytes === undefined
        ? {}
        : { maxResponseBytes: options.maxResponseBytes }),
    });

  const provider: OllamaProvider = {
    id: 'ollama',
    describe() {
      return {
        id: 'ollama',
        name: 'Ollama (local)',
        destination: 'local-loopback',
        destinationDetail:
          'The minimized payload is sent only to a configured IP-literal loopback Ollama origin.',
      };
    },
    availability() {
      return model === undefined
        ? { available: false, reason: 'not_configured' }
        : { available: true };
    },
    async getVersion(signal) {
      try {
        return await runtime.getVersion({ signal });
      } catch (error) {
        normalizeRuntimeError(error);
      }
    },
    async listModels(signal) {
      try {
        return await runtime.listModels({ signal });
      } catch (error) {
        normalizeRuntimeError(error);
      }
    },
    async generate(request: GenerateRequest) {
      if (model === undefined) {
        throw new InsightGenerationError('provider_not_configured', 'ollama');
      }
      return generateValidatedInsight(
        'ollama',
        request,
        async (rawRequest: RawInsightProviderRequest) => {
          let installed: readonly string[];
          try {
            installed = await runtime.listModels({ signal: rawRequest.signal });
          } catch (error) {
            normalizeRuntimeError(error);
          }
          if (!installed.includes(model)) {
            throw new InsightGenerationError('provider_model_unavailable', 'ollama');
          }
          try {
            return await runtime.chat({
              model,
              prompt: rawRequest.prompt,
              schema: rawRequest.schema,
              signal: rawRequest.signal,
            });
          } catch (error) {
            normalizeRuntimeError(error);
          }
        },
        { maxOutputBytes: DEFAULT_MAX_PROVIDER_OUTPUT_BYTES },
      );
    },
  };
  return provider;
}

/** Unconfigured by design; `resolveProvider()` still defaults to disabled. */
export const ollamaProvider = createOllamaProvider();
