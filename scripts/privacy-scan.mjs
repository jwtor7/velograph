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
const SQLITE_EXTENSIONS = /\.(sqlite3?|mbtiles|db|db-wal|db-shm|db-journal|dump)$/i;
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

// Real binary signatures ("magic bytes") for every extension ALLOWED_BINARY
// permits. A file extension is a claim, not proof — a renamed CSV, a JPEG
// with a payload appended after EOF, or an SVG rewritten to carry binary
// junk (real SVG is plain XML text and should never contain a NUL byte) must
// all fail this check even though their name matches an allowed pattern.
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ICO_SIGNATURE = Buffer.from([0x00, 0x00, 0x01, 0x00]);

function hasValidBinarySignature(extension, buf) {
  switch (extension) {
    case 'png':
      return buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
    case 'jpg':
    case 'jpeg':
      return buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    case 'ico':
      return buf.length >= 4 && buf.subarray(0, 4).equals(ICO_SIGNATURE);
    case 'woff':
      return buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'wOFF';
    case 'woff2':
      return buf.length >= 4 && buf.subarray(0, 4).toString('latin1') === 'wOF2';
    case 'svg':
      // A legitimate SVG is text and would never have hit the looksBinary
      // (NUL-byte) branch that routes into this function; a NUL-bearing
      // "SVG" is therefore never a valid signature.
      return false;
    default:
      return false;
  }
}

const extensionOf = (path) => (path.match(/\.([A-Za-z0-9]+)$/)?.[1] ?? '').toLowerCase();

// Extract runs of printable ASCII bytes (mirrors the Unix `strings` utility)
// so forbidden text patterns can be found even when they are embedded as
// metadata or an appended payload inside an otherwise-binary buffer.
export function extractPrintableStrings(buf, minLen = 6) {
  const runs = [];
  let start = -1;
  for (let i = 0; i <= buf.length; i++) {
    const byte = i < buf.length ? buf[i] : -1;
    const printable = byte >= 0x20 && byte <= 0x7e;
    if (printable) {
      if (start === -1) start = i;
    } else if (start !== -1) {
      if (i - start >= minLen) runs.push(buf.subarray(start, i).toString('latin1'));
      start = -1;
    }
  }
  return runs.join('\n');
}

// Shared forbidden-pattern scan used for both real text files (real line
// numbers) and printable strings extracted from binary buffers (no
// meaningful line numbers, so callers pass line-number functions that
// return 0 — the report never needs to include a matched value, only a
// rule id and location).
function scanTextForForbiddenPatterns(text, add, inSynthetic, { lineForRow, lineForIndex }) {
  const lines = text.split('\n');
  lines.forEach((lineText, i) => {
    if (lineText.includes(LEAK_MARKER)) add('leak-marker-canary', lineForRow(i));
    if (HOME_PATH.test(lineText)) add('home-directory-absolute-path', lineForRow(i));
    for (const { id, re } of APPLE_SOURCE_PATTERNS) {
      if (re.test(lineText)) add(id, lineForRow(i));
    }
    for (const { id, re } of SECRET_PATTERNS) {
      if (re.test(lineText)) add(id, lineForRow(i));
    }
  });

  for (const match of text.matchAll(COORD_PAIR)) {
    const lat = Number(match[1]);
    const lon = Number(match[2]);
    if (Math.abs(lat) > 90 || Math.abs(lon) > 180) continue; // not coordinates
    if (!inSynthetic || !inSyntheticBox(lat, lon)) {
      add('gps-coordinates-outside-synthetic-box', lineForIndex(match.index));
    }
  }
  const attrCoords = { lat: [], lon: [] };
  for (const match of text.matchAll(COORD_ATTR)) {
    const kind = match[1].toLowerCase().startsWith('la') ? 'lat' : 'lon';
    attrCoords[kind].push({ value: Number(match[2]), line: lineForIndex(match.index) });
  }
  for (const { value, line } of attrCoords.lat) {
    if (Math.abs(value) > 90) continue;
    if (!inSynthetic || value < SYNTHETIC_GEO_BOX.latMin || value > SYNTHETIC_GEO_BOX.latMax) {
      add('gps-latitude-outside-synthetic-box', line);
    }
  }
  for (const { value, line } of attrCoords.lon) {
    // The attribute name already identifies this as a longitude — validate
    // every syntactically valid longitude (magnitude <= 180) against the
    // synthetic box regardless of magnitude. Do NOT skip low-magnitude
    // values: a real-world longitude near 0 is exactly what an attacker
    // (or an accident) would smuggle past a "must look like a longitude"
    // heuristic.
    if (Math.abs(value) > 180) continue;
    if (!inSynthetic || value < SYNTHETIC_GEO_BOX.lonMin || value > SYNTHETIC_GEO_BOX.lonMax) {
      add('gps-longitude-outside-synthetic-box', line);
    }
  }
}

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
    const allowed = ALLOWED_BINARY.test(path);
    if (!allowed) {
      add('unexpected-binary-file');
    } else if (!hasValidBinarySignature(extensionOf(path), content)) {
      // The extension claims an allowed image/font type but the actual
      // bytes don't match — a renamed file or a crafted asset.
      add('binary-signature-mismatch');
    }
    if (content.length > MAX_BINARY_BYTES) add('oversized-binary-file');
    // Extension and even a valid signature are not proof the rest of the
    // buffer is clean: scan printable strings inside for the same
    // forbidden patterns applied to text files (metadata fields, appended
    // payloads after a real image's EOF, etc).
    scanTextForForbiddenPatterns(extractPrintableStrings(content), add, inSynthetic, {
      lineForRow: () => 0,
      lineForIndex: () => 0,
    });
    return violations;
  }
  if (content.length > MAX_TEXT_BYTES) add('oversized-text-file');

  const text = content.toString('utf8');
  const lineOf = (index) => text.slice(0, index).split('\n').length;
  scanTextForForbiddenPatterns(text, add, inSynthetic, {
    lineForRow: (i) => i + 1,
    lineForIndex: lineOf,
  });

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
