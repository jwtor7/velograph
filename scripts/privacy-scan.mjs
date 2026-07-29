#!/usr/bin/env node
/**
 * Velograph privacy scanner (PRD §12.2).
 *
 * Blocks anything data-shaped or personal from entering the public repository:
 * real-export file types outside the synthetic allowlist, SQLite files,
 * archives, GPS coordinates outside the synthetic bounding box, Apple Health
 * source/device strings, Health Auto Export filenames outside fixtures,
 * absolute home-directory paths, credential material, oversized files, and a
 * deliberate leak-marker canary used to test this scanner end to end.
 *
 * Modes:
 *   --staged  scan files staged in the git index (pre-commit hook)
 *   --all     scan every tracked file (CI)
 *   --files <paths...>  scan specific paths on disk (tests)
 *
 * Violation output names the rule and file:line only — never the matched
 * value, which could itself be the sensitive data.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';

const SYNTHETIC_DIR = 'fixtures/synthetic/';

// Coordinates are permitted ONLY inside this box (open ocean near Point Nemo,
// the oceanic pole of inaccessibility) and ONLY under fixtures/synthetic/.
// A route here can trace no real person's ride or home.
export const SYNTHETIC_GEO_BOX = {
  latMin: -52,
  latMax: -44,
  lonMin: -130,
  lonMax: -118,
};

// Canary for testing the scanner itself; assembled so this file never matches.
export const LEAK_MARKER = ['VELOGRAPH', 'SYNTHETIC', 'LEAK', 'MARKER'].join('_');

const DATA_EXTENSIONS = /\.(csv|gpx)$/i;
const ARCHIVE_EXTENSIONS = /\.(zip|tar|tar\.gz|tgz|gz|bz2|xz|7z|rar)$/i;
const SQLITE_EXTENSIONS = /\.(sqlite3?|db|db-wal|db-shm|db-journal|dump)$/i;
const ALLOWED_BINARY = /\.(png|jpe?g|svg|ico|woff2?)$/i;
const MAX_BINARY_BYTES = 4 * 1024 * 1024;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;

// Health Auto Export-shaped workout filenames, e.g.
// "Outdoor Cycling-Heart Rate-YYYYMMDD_HHMMSS.csv"
const HAE_FILENAME = /[A-Za-z ]+Cycling-[A-Za-z /]+-\d{8}_\d{6}\.(csv|gpx|json)$/;

// Home-directory absolute paths reveal usernames. Assembled to avoid self-match.
const HOME_PATH = new RegExp('(/' + 'Users' + '/|/' + 'home' + '/)[A-Za-z0-9._-]+/');

// Apple Health source/device strings that only appear in real exports.
const APPLE_SOURCE_PATTERNS = [
  { id: 'apple-device-string', re: new RegExp('Apple' + '\\s+' + 'Watch') },
  { id: 'apple-hkdevice', re: new RegExp('HK' + 'Device|HK' + 'Quantity' + 'Type') },
  { id: 'apple-bundle-id', re: new RegExp('com\\.apple\\.' + 'health') },
];

const SECRET_PATTERNS = [
  { id: 'private-key-block', re: new RegExp('-----BEGIN[A-Z ]*' + 'PRIVATE KEY-----') },
  { id: 'aws-access-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b/ },
  { id: 'openai-style-key', re: /\bsk-[A-Za-z0-9_-]{24,}\b/ },
  { id: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/ },
];

// Decimal-degree coordinate pair, 3+ decimal places (street-level precision).
const COORD_PAIR = /(-?\d{1,3}\.\d{3,})\s*,\s*(-?\d{1,3}\.\d{3,})/g;
// GPX/JSON style attributes: lat="..." lon="..." / "latitude": ...
const COORD_ATTR = /\b(lat|latitude|lon|longitude)\s*[=:]\s*"?(-?\d{1,3}\.\d{3,})/gi;

const inSyntheticBox = (lat, lon) =>
  lat >= SYNTHETIC_GEO_BOX.latMin &&
  lat <= SYNTHETIC_GEO_BOX.latMax &&
  lon >= SYNTHETIC_GEO_BOX.lonMin &&
  lon <= SYNTHETIC_GEO_BOX.lonMax;

const looksBinary = (buf) => buf.subarray(0, 8000).includes(0);

export function scanFile(path, content) {
  const violations = [];
  const add = (rule, line = 0) => violations.push({ path, rule, line });
  const inSynthetic = path.startsWith(SYNTHETIC_DIR);

  // --- filename / type rules ---
  if (DATA_EXTENSIONS.test(path) && !inSynthetic) add('data-file-outside-synthetic-fixtures');
  if (ARCHIVE_EXTENSIONS.test(path)) add('archive-file');
  if (SQLITE_EXTENSIONS.test(path)) add('sqlite-file-extension');
  if (HAE_FILENAME.test(path) && !inSynthetic) add('health-auto-export-filename-outside-fixtures');
  if (/(^|\/)\.env(\..+)?$/.test(path) && !path.endsWith('.env.example')) add('env-file');
  if (/(^|\/)auth\.json$/.test(path)) add('provider-auth-cache-file');

  // --- content rules ---
  if (content.subarray(0, 16).toString('latin1').startsWith('SQLite format 3')) {
    add('sqlite-magic-bytes');
  }
  if (looksBinary(content)) {
    if (!ALLOWED_BINARY.test(path)) add('unexpected-binary-file');
    if (content.length > MAX_BINARY_BYTES) add('oversized-binary-file');
    return violations;
  }
  if (content.length > MAX_TEXT_BYTES) add('oversized-text-file');

  const text = content.toString('utf8');
  const lines = text.split('\n');
  const lineOf = (index) => text.slice(0, index).split('\n').length;

  lines.forEach((lineText, i) => {
    if (lineText.includes(LEAK_MARKER)) add('leak-marker-canary', i + 1);
    if (HOME_PATH.test(lineText)) add('home-directory-absolute-path', i + 1);
    for (const { id, re } of APPLE_SOURCE_PATTERNS) {
      if (re.test(lineText)) add(id, i + 1);
    }
    for (const { id, re } of SECRET_PATTERNS) {
      if (re.test(lineText)) add(id, i + 1);
    }
  });

  for (const match of text.matchAll(COORD_PAIR)) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue; // not coordinates
    if (!inSynthetic || !inSyntheticBox(lat, lon)) {
      add('gps-coordinates-outside-synthetic-box', lineOf(match.index));
    }
  }
  const attrCoords = { lat: [], lon: [] };
  for (const match of text.matchAll(COORD_ATTR)) {
    const kind = match[1].toLowerCase().startsWith('la') ? 'lat' : 'lon';
    attrCoords[kind].push({ value: Number(match[2]), line: lineOf(match.index) });
  }
  for (const { value, line } of attrCoords.lat) {
    if (Math.abs(value) > 90) continue;
    if (!inSynthetic || value < SYNTHETIC_GEO_BOX.latMin || value > SYNTHETIC_GEO_BOX.latMax) {
      add('gps-latitude-outside-synthetic-box', line);
    }
  }
  for (const { value, line } of attrCoords.lon) {
    if (Math.abs(value) > 180 || Math.abs(value) <= 90) continue; // skip lat-ambiguous
    if (!inSynthetic || value < SYNTHETIC_GEO_BOX.lonMin || value > SYNTHETIC_GEO_BOX.lonMax) {
      add('gps-longitude-outside-synthetic-box', line);
    }
  }

  return violations;
}

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
}

function listFiles(mode) {
  if (mode === '--staged') {
    return git(['diff', '--cached', '--name-only', '--diff-filter=ACMR'])
      .split('\n')
      .filter(Boolean);
  }
  return git(['ls-files']).split('\n').filter(Boolean);
}

function readContent(mode, path) {
  if (mode === '--staged') {
    return execFileSync('git', ['show', `:${path}`], { maxBuffer: 64 * 1024 * 1024 });
  }
  return readFileSync(path);
}

export function run(argv) {
  const mode = argv[0] ?? '--all';
  let files;
  if (mode === '--files') {
    files = argv.slice(1);
  } else {
    files = listFiles(mode);
  }

  const all = [];
  for (const path of files) {
    let content;
    try {
      content = mode === '--files' ? readFileSync(path) : readContent(mode, path);
    } catch {
      continue; // deleted or unreadable; nothing to scan
    }
    if (mode === '--files') {
      try {
        if (statSync(path).isDirectory()) continue;
      } catch {
        continue;
      }
    }
    all.push(...scanFile(path.replaceAll('\\', '/'), content));
  }

  if (all.length > 0) {
    console.error(`PRIVACY SCAN FAILED — ${all.length} violation(s):`);
    for (const v of all) {
      console.error(`  ${v.path}${v.line ? ':' + v.line : ''}  [${v.rule}]`);
    }
    console.error(
      '\nNo matched values are printed; open the file location above to inspect.' +
        '\nSee CLAUDE.md / PRD §12.2. Never bypass with git add -f or --no-verify.',
    );
    return 1;
  }
  console.log(`privacy-scan: ${files.length} file(s) clean (${mode})`);
  return 0;
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  process.exit(run(process.argv.slice(2)));
}
