#!/usr/bin/env node
/**
 * Owner-only bounded sink for the detached API's stdout/stderr.
 *
 * The sink keeps at most one full previous generation and one current
 * generation. Existing legacy files are verified without following symlinks,
 * tightened to 0600, and truncated to the configured cap before retention.
 */
import {
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  ftruncateSync,
  lstatSync,
  openSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { pathToFileURL } from 'node:url';

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function fail(code) {
  throw new Error(code);
}

function secureExistingTarget(path, code, maxBytes) {
  if (!existsSync(path)) return null;
  let pathStat;
  let descriptor;
  try {
    pathStat = lstatSync(path);
    if (pathStat.isSymbolicLink() || !pathStat.isFile()) fail(code);
    descriptor = openSync(path, constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0));
    let descriptorStat = fstatSync(descriptor);
    if (!descriptorStat.isFile() || !sameIdentity(pathStat, descriptorStat)) fail(code);
    fchmodSync(descriptor, 0o600);
    if (descriptorStat.size > maxBytes) {
      ftruncateSync(descriptor, maxBytes);
      descriptorStat = fstatSync(descriptor);
    }
    return descriptorStat;
  } catch (error) {
    if (error instanceof Error && error.message === code) throw error;
    fail(code);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function createCurrentTarget(path, code) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_APPEND |
        (constants.O_NOFOLLOW ?? 0),
      0o600,
    );
    const descriptorStat = fstatSync(descriptor);
    if (!descriptorStat.isFile()) fail(code);
    fchmodSync(descriptor, 0o600);
    return { descriptor, stat: descriptorStat };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof Error && error.message === code) throw error;
    fail(code);
  }
}

function openCurrentTarget(path, expected, code) {
  let descriptor;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0),
    );
    const descriptorStat = fstatSync(descriptor);
    if (!descriptorStat.isFile() || !sameIdentity(expected, descriptorStat)) fail(code);
    fchmodSync(descriptor, 0o600);
    return { descriptor, stat: descriptorStat };
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor);
    if (error instanceof Error && error.message === code) throw error;
    fail(code);
  }
}

export class BoundedLogFile {
  constructor(path, { maxBytes } = {}) {
    if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) {
      fail('server_log_limit_invalid');
    }
    this.path = path;
    this.previousPath = `${path}.previous`;
    this.maxBytes = maxBytes;
    this.descriptor = undefined;
    this.identity = undefined;
    this.size = 0;

    secureExistingTarget(this.previousPath, 'server_log_rotation_target_invalid', this.maxBytes);
    const current = secureExistingTarget(this.path, 'server_log_target_invalid', this.maxBytes);
    if (current) {
      const opened = openCurrentTarget(this.path, current, 'server_log_target_invalid');
      this.descriptor = opened.descriptor;
      this.identity = opened.stat;
      this.size = opened.stat.size;
      if (this.size >= this.maxBytes) this.rotate();
    } else {
      this.openNewCurrent();
    }
  }

  openNewCurrent() {
    const opened = createCurrentTarget(this.path, 'server_log_target_invalid');
    this.descriptor = opened.descriptor;
    this.identity = opened.stat;
    this.size = 0;
  }

  rotate() {
    if (this.descriptor === undefined || !this.identity) {
      fail('server_log_target_invalid');
    }
    let pathStat;
    try {
      pathStat = lstatSync(this.path);
    } catch {
      fail('server_log_target_invalid');
    }
    const descriptorStat = fstatSync(this.descriptor);
    if (
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      !descriptorStat.isFile() ||
      !sameIdentity(pathStat, descriptorStat) ||
      !sameIdentity(this.identity, descriptorStat)
    ) {
      fail('server_log_target_invalid');
    }
    fchmodSync(this.descriptor, 0o600);
    if (descriptorStat.size > this.maxBytes) {
      ftruncateSync(this.descriptor, this.maxBytes);
    }
    closeSync(this.descriptor);
    this.descriptor = undefined;
    this.identity = undefined;

    if (
      secureExistingTarget(this.previousPath, 'server_log_rotation_target_invalid', this.maxBytes)
    ) {
      rmSync(this.previousPath);
    }
    try {
      renameSync(this.path, this.previousPath);
    } catch {
      fail('server_log_rotation_failed');
    }
    this.openNewCurrent();
  }

  write(value) {
    const content = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let offset = 0;
    while (offset < content.byteLength) {
      if (this.descriptor === undefined) fail('server_log_target_invalid');
      if (this.size >= this.maxBytes) this.rotate();
      const length = Math.min(this.maxBytes - this.size, content.byteLength - offset);
      const written = writeSync(this.descriptor, content, offset, length, null);
      if (written <= 0) fail('server_log_write_failed');
      offset += written;
      this.size += written;
    }
  }

  close() {
    if (this.descriptor === undefined) return;
    closeSync(this.descriptor);
    this.descriptor = undefined;
    this.identity = undefined;
  }
}

export async function runServerLogSink(argv = process.argv.slice(2)) {
  const [path, rawMaxBytes] = argv;
  const maxBytes = Number(rawMaxBytes);
  if (
    typeof path !== 'string' ||
    path.length === 0 ||
    !/^[1-9]\d*$/.test(rawMaxBytes ?? '') ||
    !Number.isSafeInteger(maxBytes)
  ) {
    console.error('Velograph log sink configuration is invalid.');
    return 64;
  }

  let writer;
  try {
    writer = new BoundedLogFile(path, { maxBytes });
    if (typeof process.send === 'function') {
      await new Promise((resolve, reject) => {
        process.send({ type: 'ready' }, (error) => (error ? reject(error) : resolve()));
      });
      process.disconnect();
    }
    for await (const chunk of process.stdin) {
      writer.write(chunk);
    }
    return 0;
  } catch {
    console.error('Velograph log sink failed.');
    return 1;
  } finally {
    writer?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runServerLogSink();
}
