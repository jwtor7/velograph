import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LEAK_MARKER } from './privacy-scan.mjs';
import { auditArtifact } from './privacy-audit-release.mjs';

const temporaryDirectories = [];

function makeArtifactDirectory() {
  const directory = mkdtempSync(join(tmpdir(), 'velograph-release-audit-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(() => {
  while (temporaryDirectories.length > 0) {
    rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
  }
});

describe('release privacy artifact audit', () => {
  it('accepts an ordinary extracted artifact', () => {
    const directory = makeArtifactDirectory();
    writeFileSync(join(directory, 'release-notes.txt'), 'synthetic release notes\n');
    expect(auditArtifact(directory)).toBe(0);
  });

  it('fails without echoing a matched leak marker', () => {
    const directory = makeArtifactDirectory();
    writeFileSync(join(directory, 'release-notes.txt'), LEAK_MARKER);
    const messages = [];
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation((message) => messages.push(message));
    try {
      expect(auditArtifact(directory)).toBe(1);
    } finally {
      error.mockRestore();
    }
    expect(messages.join('\n')).toContain('leak-marker-canary');
    expect(messages.join('\n')).not.toContain(LEAK_MARKER);
  });
});
