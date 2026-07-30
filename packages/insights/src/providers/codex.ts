import {
  spawn as nodeSpawn,
  type ChildProcessWithoutNullStreams,
  type SpawnOptions,
} from 'node:child_process';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stableStringify } from '@velograph/shared';
import {
  InsightGenerationError,
  stableProviderError,
  type InsightGenerationErrorCode,
} from '../errors.ts';
import {
  ABSOLUTE_MAX_PROMPT_BYTES,
  ABSOLUTE_MAX_PROVIDER_OUTPUT_BYTES,
  DEFAULT_MAX_PROMPT_BYTES,
  DEFAULT_MAX_PROVIDER_OUTPUT_BYTES,
  generateValidatedInsight,
  type RawInsightProviderResponse,
} from '../orchestrator.ts';
import type { INSIGHT_OUTPUT_JSON_SCHEMA } from '../schema.ts';
import type { GenerateRequest, InsightProvider } from '../types.ts';

export const DEFAULT_CODEX_TIMEOUT_MS = 120_000;
export const DEFAULT_CODEX_KILL_GRACE_MS = 500;
export const MAX_CODEX_TIMEOUT_MS = 5 * 60_000;
export const MAX_CODEX_KILL_GRACE_MS = 10_000;

const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;
const MODEL_NAME = /^[a-z0-9][a-z0-9._:/-]{0,255}$/i;
const SAFE_ENVIRONMENT_KEYS = [
  'PATH',
  'HOME',
  'CODEX_HOME',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'SSL_CERT_FILE',
  'SSL_CERT_DIR',
  'NODE_EXTRA_CA_CERTS',
  'SYSTEMROOT',
  'WINDIR',
  'COMSPEC',
  'PATHEXT',
] as const;

export interface CodexRunCall {
  executable: string;
  model: string | undefined;
  prompt: string;
  schema: typeof INSIGHT_OUTPUT_JSON_SCHEMA;
  signal: AbortSignal | undefined;
  timeoutMs: number;
  maxInputBytes: number;
  maxOutputBytes: number;
}

/** Injectable process boundary. */
export interface CodexRunner {
  run(call: CodexRunCall): Promise<RawInsightProviderResponse>;
}

export interface CodexSpawnOptions extends SpawnOptions {
  cwd: string;
  env: NodeJS.ProcessEnv;
  shell: false;
  stdio: ['pipe', 'pipe', 'pipe'];
  windowsHide: true;
}

export type CodexSpawn = (
  command: string,
  args: readonly string[],
  options: CodexSpawnOptions,
) => ChildProcessWithoutNullStreams;

export interface NodeCodexRunnerOptions {
  spawn?: CodexSpawn;
  tempRoot?: string;
  killGraceMs?: number;
  environment?: NodeJS.ProcessEnv;
}

export interface CodexProviderOptions {
  executable?: string;
  model?: string;
  runner?: CodexRunner;
  timeoutMs?: number;
  maxInputBytes?: number;
  maxOutputBytes?: number;
}

function invalidConfiguration(): never {
  throw new InsightGenerationError('invalid_request', 'codex');
}

function boundedLimit(value: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) invalidConfiguration();
  return value;
}

function validExecutable(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= 1_024 &&
    !CONTROL_CHARACTER.test(value)
  );
}

function validModel(value: unknown): value is string {
  return typeof value === 'string' && MODEL_NAME.test(value);
}

/**
 * Minimal environment allow-list for the Codex client itself. Secret/API-key
 * and proxy variables are never forwarded. HOME/CODEX_HOME are passed
 * through so the Codex client can perform its own authentication; Velograph
 * never resolves, reads, copies, or logs any credential file.
 */
export function buildCodexEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output: NodeJS.ProcessEnv = { NO_COLOR: '1' };
  const entries = Object.entries(source);
  for (const allowed of SAFE_ENVIRONMENT_KEYS) {
    const entry = entries.find(([key]) => key.toUpperCase() === allowed);
    if (!entry) continue;
    const value = entry[1];
    if (typeof value === 'string' && !value.includes('\0')) output[entry[0]] = value;
  }
  return output;
}

function codexArguments(cwd: string, schemaPath: string, model: string | undefined): string[] {
  return [
    'exec',
    '--ephemeral',
    '--ignore-user-config',
    '--ignore-rules',
    '--skip-git-repo-check',
    '--sandbox',
    'read-only',
    '--color',
    'never',
    '-C',
    cwd,
    '--output-schema',
    schemaPath,
    ...(model === undefined ? [] : ['--model', model]),
    '-c',
    'approval_policy="never"',
    '-c',
    'web_search="disabled"',
    '-c',
    'features.shell_tool=false',
    '-c',
    'features.apps=false',
    '-c',
    'features.multi_agent=false',
    '-c',
    'agents.enabled=false',
    '-c',
    'history.persistence="none"',
    '-c',
    'analytics.enabled=false',
    '-c',
    'shell_environment_policy.inherit="none"',
    '-',
  ];
}

interface ChildRunOptions {
  child: ChildProcessWithoutNullStreams;
  prompt: string;
  signal: AbortSignal | undefined;
  timeoutMs: number;
  maxOutputBytes: number;
  killGraceMs: number;
}

function waitForChild(options: ChildRunOptions): Promise<Buffer> {
  const { child, prompt, signal, timeoutMs, maxOutputBytes, killGraceMs } = options;
  return new Promise<Buffer>((resolve, reject) => {
    let settled = false;
    let terminating: InsightGenerationErrorCode | null = null;
    let capturedBytes = 0;
    let stdoutBytes = 0;
    const stdoutChunks: Buffer[] = [];
    let killTimer: NodeJS.Timeout | undefined;
    let forceTimer: NodeJS.Timeout | undefined;

    const cleanup = (): void => {
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      if (forceTimer) clearTimeout(forceTimer);
      signal?.removeEventListener('abort', abort);
    };

    const finish = (error: InsightGenerationError | null): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error);
      else resolve(Buffer.concat(stdoutChunks, stdoutBytes));
    };

    const terminate = (code: InsightGenerationErrorCode): void => {
      if (settled || terminating !== null) return;
      terminating = code;
      try {
        child.kill('SIGTERM');
      } catch {
        finish(new InsightGenerationError(code, 'codex'));
        return;
      }
      killTimer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          finish(new InsightGenerationError(code, 'codex'));
        }
      }, killGraceMs);
      killTimer.unref?.();
      forceTimer = setTimeout(
        () => finish(new InsightGenerationError(code, 'codex')),
        killGraceMs * 2,
      );
      forceTimer.unref?.();
    };

    const abort = (): void => terminate('generation_cancelled');
    const countOutput = (chunk: Buffer | string, capture: boolean): void => {
      if (settled) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      capturedBytes += bytes.byteLength;
      if (capturedBytes > maxOutputBytes) {
        terminate('provider_output_too_large');
        return;
      }
      if (capture) {
        stdoutBytes += bytes.byteLength;
        stdoutChunks.push(bytes);
      }
    };

    const timeout = setTimeout(() => terminate('provider_timeout'), timeoutMs);
    timeout.unref?.();

    child.stdout.on('data', (chunk: Buffer | string) => countOutput(chunk, true));
    child.stderr.on('data', (chunk: Buffer | string) => countOutput(chunk, false));
    child.once('error', (error: NodeJS.ErrnoException) => {
      if (terminating !== null) {
        finish(new InsightGenerationError(terminating, 'codex'));
        return;
      }
      const code = error.code === 'ENOENT' ? 'provider_unreachable' : 'provider_failed';
      finish(new InsightGenerationError(code, 'codex'));
    });
    child.once('close', (code, signalName) => {
      if (terminating !== null) {
        finish(new InsightGenerationError(terminating, 'codex'));
        return;
      }
      if (code !== 0 || signalName !== null) {
        finish(new InsightGenerationError('provider_failed', 'codex'));
        return;
      }
      finish(null);
    });
    child.stdin.once('error', () => terminate('provider_failed'));
    signal?.addEventListener('abort', abort, { once: true });

    if (signal?.aborted === true) {
      terminate('generation_cancelled');
      return;
    }
    try {
      child.stdin.end(prompt, 'utf8');
    } catch {
      terminate('provider_failed');
    }
  });
}

function normalizeRunnerFailure(error: unknown): InsightGenerationError {
  return stableProviderError(error, 'codex');
}

/**
 * Built-in no-shell Codex runner. Prompt bytes travel only over stdin. The
 * schema lives briefly in a mode-0700 temporary directory and is removed on
 * every success/error/cancellation path. Codex writes only its final message
 * to stdout; progress remains on stderr, and both streams share a hard cap.
 */
export function createNodeCodexRunner(options: NodeCodexRunnerOptions = {}): CodexRunner {
  const spawnImpl: CodexSpawn =
    options.spawn ??
    ((command, args, spawnOptions) =>
      nodeSpawn(command, [...args], spawnOptions) as ChildProcessWithoutNullStreams);
  const tempRoot = options.tempRoot ?? tmpdir();
  const killGraceMs = boundedLimit(
    options.killGraceMs ?? DEFAULT_CODEX_KILL_GRACE_MS,
    MAX_CODEX_KILL_GRACE_MS,
  );
  const baseEnvironment = buildCodexEnvironment(options.environment ?? process.env);

  return {
    async run(call) {
      if (call.signal?.aborted === true) {
        throw new InsightGenerationError('generation_cancelled', 'codex');
      }
      if (
        !validExecutable(call.executable) ||
        (call.model !== undefined && !validModel(call.model))
      ) {
        invalidConfiguration();
      }
      const timeoutMs = boundedLimit(call.timeoutMs, MAX_CODEX_TIMEOUT_MS);
      const maxInputBytes = boundedLimit(call.maxInputBytes, ABSOLUTE_MAX_PROMPT_BYTES);
      const maxOutputBytes = boundedLimit(call.maxOutputBytes, ABSOLUTE_MAX_PROVIDER_OUTPUT_BYTES);
      if (Buffer.byteLength(call.prompt, 'utf8') > maxInputBytes) {
        throw new InsightGenerationError('prompt_too_large', 'codex');
      }

      let directory: string | undefined;
      let result: RawInsightProviderResponse | undefined;
      let failure: InsightGenerationError | undefined;
      try {
        directory = await mkdtemp(join(tempRoot, 'velograph-insight-'));
        await chmod(directory, 0o700);
        const schemaPath = join(directory, 'output-schema.json');
        await writeFile(schemaPath, stableStringify(call.schema), {
          encoding: 'utf8',
          flag: 'wx',
          mode: 0o600,
        });

        const child = spawnImpl(
          call.executable,
          codexArguments(directory, schemaPath, call.model),
          {
            cwd: directory,
            env: {
              ...baseEnvironment,
              TMPDIR: directory,
              TMP: directory,
              TEMP: directory,
            },
            shell: false,
            stdio: ['pipe', 'pipe', 'pipe'],
            windowsHide: true,
          },
        );
        const output = await waitForChild({
          child,
          prompt: call.prompt,
          signal: call.signal,
          timeoutMs,
          maxOutputBytes,
          killGraceMs,
        });
        result = { outputText: output.toString('utf8'), modelId: null };
      } catch (error) {
        failure = normalizeRunnerFailure(error);
      }

      if (directory !== undefined) {
        try {
          await rm(directory, { recursive: true, force: true, maxRetries: 2 });
        } catch {
          throw new InsightGenerationError('provider_cleanup_failed', 'codex');
        }
      }
      if (failure) throw failure;
      if (!result) throw new InsightGenerationError('provider_failed', 'codex');
      return result;
    },
  };
}

export function createCodexProvider(options: CodexProviderOptions = {}): InsightProvider {
  const executable = options.executable ?? 'codex';
  if (!validExecutable(executable)) invalidConfiguration();
  const model = options.model;
  if (model !== undefined && !validModel(model)) invalidConfiguration();
  const timeoutMs = boundedLimit(
    options.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
    MAX_CODEX_TIMEOUT_MS,
  );
  const maxInputBytes = boundedLimit(
    options.maxInputBytes ?? DEFAULT_MAX_PROMPT_BYTES,
    ABSOLUTE_MAX_PROMPT_BYTES,
  );
  const maxOutputBytes = boundedLimit(
    options.maxOutputBytes ?? DEFAULT_MAX_PROVIDER_OUTPUT_BYTES,
    ABSOLUTE_MAX_PROVIDER_OUTPUT_BYTES,
  );
  const runner = options.runner ?? createNodeCodexRunner();

  return {
    id: 'codex',
    describe() {
      return {
        id: 'codex',
        name: 'Codex CLI (OpenAI)',
        destination: 'remote',
        destinationDetail:
          'The minimized payload is sent to OpenAI through the user-installed Codex CLI.',
      };
    },
    availability() {
      // Availability is intentionally side-effect free. A missing executable
      // is reported as provider_unreachable on the first explicit generation.
      return { available: true };
    },
    async generate(request: GenerateRequest) {
      return generateValidatedInsight(
        'codex',
        request,
        ({ prompt, schema, signal }) =>
          runner.run({
            executable,
            model,
            prompt,
            schema,
            signal,
            timeoutMs,
            maxInputBytes,
            maxOutputBytes,
          }),
        { maxPromptBytes: maxInputBytes, maxOutputBytes },
      );
    },
  };
}

export const codexProvider = createCodexProvider();
