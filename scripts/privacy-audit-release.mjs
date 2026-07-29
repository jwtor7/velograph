#!/usr/bin/env node
/**
 * Release privacy audit (PRD §12.2 and §18.13).
 *
 * Extends the tracked-worktree scanner to public release surfaces that are
 * easy to overlook: every reachable Git blob, an extracted release artifact,
 * and every file in every layer of a Docker image. Reports rule + synthetic
 * audit path only; never prints matched content.
 *
 * Usage:
 *   node scripts/privacy-audit-release.mjs --working-tree
 *   node scripts/privacy-audit-release.mjs --history
 *   node scripts/privacy-audit-release.mjs --artifact path/to/extracted-output
 *   node scripts/privacy-audit-release.mjs --image velograph:local
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative } from 'node:path';
import { scanFile } from './privacy-scan.mjs';

function command(program, args, options = {}) {
  return execFileSync(program, args, {
    encoding: 'utf8',
    maxBuffer: 128 * 1024 * 1024,
    ...options,
  });
}

function report(scope, violations) {
  if (violations.length === 0) {
    console.log(`release-privacy-audit: ${scope} clean`);
    return 0;
  }
  console.error(`RELEASE PRIVACY AUDIT FAILED — ${scope}: ${violations.length} violation(s):`);
  for (const violation of violations) {
    console.error(
      `  ${violation.path}${violation.line ? ':' + violation.line : ''}  [${violation.rule}]`,
    );
  }
  console.error('No matched values are printed. Treat any published data as exposed.');
  return 1;
}

function scanContent(path, content) {
  return scanFile(path.replaceAll('\\', '/'), content);
}

function scanHistoryContent(path, content) {
  return scanContent(path, content).map((violation) => ({
    ...violation,
    path: `history/${violation.path}`,
  }));
}

function walkFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const absolute = join(root, entry.name);
    if (entry.isDirectory()) files.push(...walkFiles(absolute));
    else if (entry.isFile()) files.push(absolute);
  }
  return files;
}

export function auditArtifact(path) {
  const stat = statSync(path);
  const files = stat.isDirectory() ? walkFiles(path) : [path];
  const violations = [];
  for (const file of files) {
    const artifactPath = stat.isDirectory() ? relative(path, file) : basename(file);
    const auditPath = `artifact/${artifactPath || basename(file)}`;
    violations.push(...scanContent(auditPath, readFileSync(file)));
  }
  return report(`artifact (${files.length} file(s))`, violations);
}

export function auditHistory() {
  // `rev-list --objects --all` walks every blob reachable from local and
  // fetched refs. CI uses checkout fetch-depth 0; a release mirror is needed
  // to audit refs that have already been deleted from every remote.
  const lines = command('git', ['rev-list', '--objects', '--all']).split('\n').filter(Boolean);
  const seen = new Set();
  const violations = [];
  for (const line of lines) {
    const separator = line.indexOf(' ');
    if (separator === -1) continue;
    const objectId = line.slice(0, separator);
    const path = line.slice(separator + 1);
    if (!path || seen.has(`${objectId}\0${path}`)) continue;
    let objectType;
    try {
      objectType = command('git', ['cat-file', '-t', objectId], {
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
    } catch {
      continue;
    }
    if (objectType !== 'blob') continue;
    seen.add(`${objectId}\0${path}`);
    let content;
    try {
      content = execFileSync('git', ['cat-file', 'blob', objectId], {
        maxBuffer: 64 * 1024 * 1024,
      });
    } catch {
      continue;
    }
    // Keep the repository-relative path for scanner policy (notably the
    // synthetic fixture allowlist), then prefix only the human-safe report.
    violations.push(...scanHistoryContent(path, content));
  }
  return report(`history (${seen.size} reachable blob path(s))`, violations);
}

export function auditImage(image) {
  const directory = mkdtempSync(join(tmpdir(), 'velograph-image-audit-'));
  const archive = join(directory, 'image.tar');
  try {
    command('docker', ['image', 'save', '--output', archive, image]);
    const topLevel = command('tar', ['-tf', archive]).split('\n').filter(Boolean);
    const layerNames = topLevel.filter((entry) => entry.endsWith('/layer.tar'));
    const violations = [];
    for (const layerName of layerNames) {
      const layer = execFileSync('tar', ['-xOf', archive, layerName], {
        maxBuffer: 1024 * 1024 * 1024,
      });
      // Stream the nested tar directly; never extract untrusted layer paths to
      // the checkout or another filesystem location.
      const layerEntries = command('tar', ['-tf', '-'], { input: layer })
        .split('\n')
        .filter(Boolean);
      for (const entry of layerEntries) {
        if (entry.endsWith('/') || entry.includes('../')) continue;
        let content;
        try {
          content = execFileSync('tar', ['-xOf', '-', entry], {
            input: layer,
            maxBuffer: 64 * 1024 * 1024,
          });
        } catch {
          continue;
        }
        violations.push(...scanContent(`container/${image}/${layerName}/${entry}`, content));
      }
    }
    return report(`container image ${image}`, violations);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

export function run(argv) {
  const [mode, value] = argv;
  try {
    if (mode === '--working-tree') {
      const output = command('node', ['scripts/privacy-scan.mjs', '--all']);
      process.stdout.write(output);
      return 0;
    }
    if (mode === '--history') return auditHistory();
    if (mode === '--artifact' && value) return auditArtifact(value);
    if (mode === '--image' && value) return auditImage(value);
  } catch (error) {
    console.error(
      `RELEASE PRIVACY AUDIT FAILED — ${error instanceof Error ? error.message : 'unknown error'}`,
    );
    return 1;
  }
  console.error('Usage: --working-tree | --history | --artifact <path> | --image <reference>');
  return 64;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(run(process.argv.slice(2)));
}
