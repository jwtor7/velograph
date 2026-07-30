import { EventEmitter } from 'node:events';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { buildInsightPayload } from '../payload.ts';
import { INSIGHT_OUTPUT_JSON_SCHEMA } from '../schema.ts';
import { buildAnalyticsFixture, buildInsightOutputFixture } from '../test-fixtures.ts';
import {
  buildCodexEnvironment,
  codexProvider,
  createCodexProvider,
  createNodeCodexRunner,
  type CodexRunCall,
  type CodexRunner,
  type CodexSpawn,
  type CodexSpawnOptions,
} from './codex.ts';

interface SpawnCapture {
  command?: string;
  args?: readonly string[];
  options?: CodexSpawnOptions;
  stdin: string;
  cwdMode?: number;
  schema?: unknown;
  killSignals: Array<NodeJS.Signals | number | undefined>;
}

function argumentValue(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag);
  if (index < 0 || args[index + 1] === undefined) throw new Error(`missing ${flag}`);
  return args[index + 1]!;
}

function fakeSpawn(
  capture: SpawnCapture,
  behavior: 'success' | 'hang' | 'large-stdout' | 'nonzero' = 'success',
  outputText = JSON.stringify(buildInsightOutputFixture('test-prompt-v1')),
): CodexSpawn {
  return (command, args, options) => {
    capture.command = command;
    capture.args = args;
    capture.options = options;
    capture.cwdMode = statSync(options.cwd).mode & 0o777;
    capture.schema = JSON.parse(
      readFileSync(argumentValue(args, '--output-schema'), 'utf8'),
    ) as unknown;

    const child = new EventEmitter() as EventEmitter & {
      stdin: PassThrough;
      stdout: PassThrough;
      stderr: PassThrough;
      kill: (signal?: NodeJS.Signals | number) => boolean;
    };
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = (signal) => {
      capture.killSignals.push(signal);
      queueMicrotask(() => child.emit('close', null, signal ?? 'SIGTERM'));
      return true;
    };
    child.stdin.on('data', (chunk: Buffer) => {
      capture.stdin += chunk.toString('utf8');
    });
    child.stdin.on('finish', () => {
      if (behavior === 'hang') return;
      if (behavior === 'large-stdout') {
        child.stdout.write('x'.repeat(1_024));
        return;
      }
      if (behavior === 'nonzero') {
        queueMicrotask(() => child.emit('close', 2, null));
        return;
      }
      child.stdout.write(outputText);
      queueMicrotask(() => child.emit('close', 0, null));
    });
    return child as unknown as ReturnType<CodexSpawn>;
  };
}

function runnerCall(overrides: Partial<CodexRunCall> = {}): CodexRunCall {
  return {
    executable: 'codex',
    model: undefined,
    prompt: 'synthetic minimized prompt',
    schema: INSIGHT_OUTPUT_JSON_SCHEMA,
    signal: undefined,
    timeoutMs: 1_000,
    maxInputBytes: 4_096,
    maxOutputBytes: 4_096,
    ...overrides,
  };
}

describe('built-in Codex no-shell runner', () => {
  it('uses stdin-only input, private temporary files, fixed isolation flags, and a filtered environment', async () => {
    const capture: SpawnCapture = { stdin: '', killSignals: [] };
    const tokenKey = ['API', '_TOKEN'].join('');
    const proxyKey = ['HTTP', '_PROXY'].join('');
    const runner = createNodeCodexRunner({
      spawn: fakeSpawn(capture),
      environment: {
        PATH: '/synthetic/bin',
        HOME: '/synthetic/home',
        CODEX_HOME: '/synthetic/codex-home',
        LANG: 'en_CA.UTF-8',
        [tokenKey]: 'synthetic-sensitive-value',
        [proxyKey]: 'http://127.0.0.1:9',
      },
    });

    await expect(runner.run(runnerCall())).resolves.toMatchObject({
      outputText: expect.any(String),
      modelId: null,
    });

    expect(capture.command).toBe('codex');
    expect(capture.stdin).toBe('synthetic minimized prompt');
    expect(capture.args).not.toContain('synthetic minimized prompt');
    expect(capture.args).not.toContain('--output-last-message');
    expect(capture.args?.at(-1)).toBe('-');
    expect(capture.args).toEqual(
      expect.arrayContaining([
        '--ephemeral',
        '--ignore-user-config',
        '--ignore-rules',
        '--skip-git-repo-check',
        'read-only',
        'approval_policy="never"',
        'web_search="disabled"',
        'features.shell_tool=false',
        'features.apps=false',
        'features.multi_agent=false',
        'history.persistence="none"',
      ]),
    );
    expect(capture.options).toMatchObject({
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    expect(capture.options?.env[tokenKey]).toBeUndefined();
    expect(capture.options?.env[proxyKey]).toBeUndefined();
    expect(capture.options?.env.HOME).toBe('/synthetic/home');
    expect(capture.options?.env.CODEX_HOME).toBe('/synthetic/codex-home');
    expect(capture.cwdMode).toBe(0o700);
    expect(capture.schema).toEqual(INSIGHT_OUTPUT_JSON_SCHEMA);
    expect(capture.options?.cwd === undefined || existsSync(capture.options.cwd)).toBe(false);
  });

  it('does not contain code that resolves or reads the Codex credential filename', () => {
    const path = fileURLToPath(new URL('./codex.ts', import.meta.url));
    const source = readFileSync(path, 'utf8');
    const credentialFilename = ['auth', '.json'].join('');
    expect(source).not.toContain(credentialFilename);
    expect(source).not.toContain('exec(');
    expect(source).not.toContain('execFile(');
    expect(source).toContain('shell: false');
  });

  it('filters secret and proxy variables case-insensitively', () => {
    const environment = buildCodexEnvironment({
      Path: '/synthetic/bin',
      Home: '/synthetic/home',
      api_key: 'synthetic-sensitive-value',
      HTTPS_PROXY: 'http://127.0.0.1:9',
    });
    expect(environment.Path).toBe('/synthetic/bin');
    expect(environment.Home).toBe('/synthetic/home');
    expect(environment.api_key).toBeUndefined();
    expect(environment.HTTPS_PROXY).toBeUndefined();
  });

  it('does not allow callers to remove hard time or body ceilings', () => {
    expect(() => createCodexProvider({ timeoutMs: Number.MAX_SAFE_INTEGER })).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
    expect(() => createCodexProvider({ maxOutputBytes: Number.MAX_SAFE_INTEGER })).toThrowError(
      expect.objectContaining({ code: 'invalid_request' }),
    );
  });

  it('terminates and cleans up a timed-out child', async () => {
    const capture: SpawnCapture = { stdin: '', killSignals: [] };
    const runner = createNodeCodexRunner({
      spawn: fakeSpawn(capture, 'hang'),
      killGraceMs: 5,
    });
    await expect(runner.run(runnerCall({ timeoutMs: 10 }))).rejects.toMatchObject({
      code: 'provider_timeout',
    });
    expect(capture.killSignals).toContain('SIGTERM');
    expect(capture.options?.cwd === undefined || existsSync(capture.options.cwd)).toBe(false);
  });

  it('terminates and cleans up a cancelled child', async () => {
    const capture: SpawnCapture = { stdin: '', killSignals: [] };
    const runner = createNodeCodexRunner({
      spawn: fakeSpawn(capture, 'hang'),
      killGraceMs: 5,
    });
    const controller = new AbortController();
    const pending = runner.run(runnerCall({ signal: controller.signal }));
    controller.abort();
    await expect(pending).rejects.toMatchObject({ code: 'generation_cancelled' });
    expect(capture.killSignals).toContain('SIGTERM');
    expect(capture.options?.cwd === undefined || existsSync(capture.options.cwd)).toBe(false);
  });

  it('kills the child when stdout/stderr exceeds the capture cap', async () => {
    const capture: SpawnCapture = { stdin: '', killSignals: [] };
    const runner = createNodeCodexRunner({
      spawn: fakeSpawn(capture, 'large-stdout'),
      killGraceMs: 5,
    });
    await expect(runner.run(runnerCall({ maxOutputBytes: 64 }))).rejects.toMatchObject({
      code: 'provider_output_too_large',
    });
    expect(capture.killSignals).toContain('SIGTERM');
  });

  it('captures the final response from bounded stdout without creating an output file', async () => {
    const capture: SpawnCapture = { stdin: '', killSignals: [] };
    const outputText = JSON.stringify(buildInsightOutputFixture('stdout-prompt-v1'));
    const runner = createNodeCodexRunner({ spawn: fakeSpawn(capture, 'success', outputText) });
    await expect(runner.run(runnerCall())).resolves.toEqual({
      outputText,
      modelId: null,
    });
    expect(capture.args).not.toContain('--output-last-message');
  });

  it('maps non-zero exits to a stable, value-free provider error', async () => {
    const capture: SpawnCapture = { stdin: '', killSignals: [] };
    const runner = createNodeCodexRunner({ spawn: fakeSpawn(capture, 'nonzero') });
    await expect(runner.run(runnerCall())).rejects.toMatchObject({
      code: 'provider_failed',
      message: 'The selected insight provider failed.',
    });
  });
});

describe('Codex provider', () => {
  const payload = buildInsightPayload(buildAnalyticsFixture());
  const promptVersion = 'test-prompt-v1';

  it('reports a remote destination without probing or spawning', () => {
    expect(codexProvider.describe().destination).toBe('remote');
    expect(codexProvider.availability()).toEqual({ available: true });
  });

  it('passes a minimized schema-constrained prompt to an injected runner and validates output', async () => {
    const output = buildInsightOutputFixture(promptVersion);
    const runner: CodexRunner = {
      run: vi.fn(async (call) => {
        expect(call.prompt).toContain('"payloadVersion":"insight-payload-v1"');
        expect(call.prompt).not.toContain('workoutId');
        expect(call.schema).toBe(INSIGHT_OUTPUT_JSON_SCHEMA);
        return { outputText: JSON.stringify(output), modelId: null };
      }),
    };
    const provider = createCodexProvider({ runner, executable: 'codex' });
    await expect(provider.generate({ payload, promptVersion })).resolves.toMatchObject({
      ok: true,
      output,
      modelId: null,
    });
    expect(runner.run).toHaveBeenCalledOnce();
  });

  it('never exposes schema-invalid injected runner output', async () => {
    const runner: CodexRunner = {
      run: vi.fn(async () => ({ outputText: '{"untrusted":true}', modelId: null })),
    };
    const provider = createCodexProvider({ runner });
    await expect(provider.generate({ payload, promptVersion })).rejects.toMatchObject({
      code: 'output_schema_invalid',
    });
  });
});
