#!/usr/bin/env node
/**
 * Synthetic Health Auto Export-shaped fixture generator (PRD §12.2, §17 Phase 0).
 *
 * Everything emitted is invented: values, dates, source strings, and routes.
 * Routes are random walks inside the SYNTHETIC_GEO_BOX (open ocean near Point
 * Nemo) so they can trace no real person's ride or home. Output is fully
 * deterministic for a given seed — no clock, no Math.random — so tests can
 * assert byte equivalence.
 *
 * Usage: node scripts/generate-fixtures.mjs [--out <dir>] [--seed <n>] [--rides <n>]
 */
import { existsSync, mkdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Repository root, derived from this file's own location (scripts/<file> ->
// one level up) so path validation does not depend on the caller's cwd.
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const SYNTHETIC_SOURCE = 'Synth Watch X1';
const BASE = { lat: -48.5, lon: -123.5 }; // inside the synthetic geo box

/** Deterministic PRNG (mulberry32). */
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const pad = (n, w = 2) => String(n).padStart(w, '0');

/** Invented ride definitions; dates are fictional (year 2031). */
export function rideDefs(count, baseSeed = 1000) {
  const defs = [];
  for (let i = 0; i < count; i++) {
    defs.push({
      index: i,
      // Every 3rd day, alternating morning/evening starts
      start: Date.UTC(2031, 3, 2 + i * 3, i % 2 === 0 ? 7 : 17, 30 + i, 0),
      durationSec: 2400 + i * 900, // 40 min, 55 min, 70 min, ...
      seed: baseSeed + i * 97,
      // ride 1 gets a mid-ride recording gap (tests ROUTE-004 / coverage)
      gapAt: i === 1 ? 0.45 : null,
      gapFrac: 0.08,
    });
  }
  return defs;
}

const isoUtc = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

function haeStamp(ms) {
  const d = new Date(ms);
  return (
    `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}` +
    `_${pad(d.getUTCHours())}${pad(d.getUTCMinutes())}${pad(d.getUTCSeconds())}`
  );
}

function inGap(def, t0, t, t1) {
  if (def.gapAt == null) return false;
  const frac = (t - t0) / (t1 - t0);
  return frac >= def.gapAt && frac < def.gapAt + def.gapFrac;
}

/** Generate all sample streams for one ride. */
export function generateRide(def) {
  const rand = mulberry32(def.seed);
  const t0 = def.start;
  const t1 = t0 + def.durationSec * 1000;
  const hr = [];
  const cadence = [];
  const distance = [];
  const energy = [];
  const route = [];

  let lat = BASE.lat + def.index * 0.05;
  let lon = BASE.lon + def.index * 0.07;
  let heading = rand() * 2 * Math.PI;
  let alt = 20 + rand() * 30;

  // 5 s route cadence; 60 s metric cadence (distinct sampling intervals on purpose)
  for (let t = t0; t <= t1; t += 5000) {
    if (inGap(def, t0, t, t1)) continue;
    heading += (rand() - 0.5) * 0.35;
    const speed = Math.max(1.5, 7 + Math.sin((t - t0) / 300000) * 3 + (rand() - 0.5) * 2);
    const stepMeters = speed * 5;
    lat += (stepMeters / 111320) * Math.cos(heading);
    lon += (stepMeters / (111320 * Math.cos((lat * Math.PI) / 180))) * Math.sin(heading);
    alt = Math.max(0, alt + Math.sin((t - t0) / 180000) * 1.2 + (rand() - 0.5) * 0.8);
    route.push({
      t,
      lat: Number(lat.toFixed(6)),
      lon: Number(lon.toFixed(6)),
      alt: Number(alt.toFixed(1)),
      vacc: Number((2 + rand() * 3).toFixed(1)),
      hacc: Number((3 + rand() * 5).toFixed(1)),
      speed: Number(speed.toFixed(2)),
      course: Number((((heading * 180) / Math.PI + 360) % 360).toFixed(1)),
    });
  }

  let cumKm = 0;
  for (let t = t0; t <= t1; t += 60000) {
    const gap = inGap(def, t0, t, t1);
    const phase = (t - t0) / (t1 - t0);
    const base = 118 + 34 * Math.sin(phase * Math.PI) + def.index * 3;
    const avg = Math.round(base + (rand() - 0.5) * 8);
    if (!gap) {
      hr.push({
        t,
        min: avg - Math.round(2 + rand() * 4),
        max: avg + Math.round(2 + rand() * 6),
        avg,
      });
      cadence.push({ t, rpm: Math.round(72 + 14 * Math.sin(phase * 6) + (rand() - 0.5) * 8) });
    }
    const km = gap ? 0 : Number((0.3 + rand() * 0.25).toFixed(3));
    cumKm += km;
    if (!gap) distance.push({ t, km });
    if (!gap) energy.push({ t, kj: Number((25 + rand() * 15).toFixed(2)) });
  }

  return { def, t0, t1, hr, cadence, distance, energy, route, totalKm: cumKm };
}

const csvEscape = (v) => String(v);

export function renderFiles(ride) {
  const stamp = haeStamp(ride.t0);
  const files = new Map();

  files.set(
    `Outdoor Cycling-Heart Rate-${stamp}.csv`,
    ['Date/Time,Min (bpm),Max (bpm),Avg (bpm),Context,Source']
      .concat(
        ride.hr.map((s) =>
          [isoUtc(s.t), s.min, s.max, s.avg, 'workout', SYNTHETIC_SOURCE].map(csvEscape).join(','),
        ),
      )
      .join('\n') + '\n',
  );
  files.set(
    `Outdoor Cycling-Cycling Cadence-${stamp}.csv`,
    ['Date/Time,Cadence (rpm),Source']
      .concat(ride.cadence.map((s) => [isoUtc(s.t), s.rpm, SYNTHETIC_SOURCE].join(',')))
      .join('\n') + '\n',
  );
  files.set(
    `Outdoor Cycling-Cycling Distance-${stamp}.csv`,
    ['Date/Time,Distance (km),Source']
      .concat(ride.distance.map((s) => [isoUtc(s.t), s.km, SYNTHETIC_SOURCE].join(',')))
      .join('\n') + '\n',
  );
  files.set(
    `Outdoor Cycling-Active Energy-${stamp}.csv`,
    ['Date/Time,Active Energy (kJ),Source']
      .concat(ride.energy.map((s) => [isoUtc(s.t), s.kj, SYNTHETIC_SOURCE].join(',')))
      .join('\n') + '\n',
  );
  files.set(
    `Outdoor Cycling-Route-${stamp}.csv`,
    [
      'Timestamp,Latitude,Longitude,Altitude (m),Vertical Accuracy (m),Horizontal Accuracy (m),Speed (m/s),Course (deg)',
    ]
      .concat(
        ride.route.map((p) =>
          [isoUtc(p.t), p.lat, p.lon, p.alt, p.vacc, p.hacc, p.speed, p.course].join(','),
        ),
      )
      .join('\n') + '\n',
  );

  // GPX: split at the recording gap into separate trkseg elements.
  const segments = [];
  let seg = [];
  let prevT = null;
  for (const p of ride.route) {
    if (prevT != null && p.t - prevT > 60000) {
      segments.push(seg);
      seg = [];
    }
    seg.push(p);
    prevT = p.t;
  }
  if (seg.length) segments.push(seg);
  const gpxSegs = segments
    .map(
      (points) =>
        '    <trkseg>\n' +
        points
          .map(
            (p) =>
              `      <trkpt lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">` +
              `<ele>${p.alt.toFixed(1)}</ele><time>${isoUtc(p.t)}</time></trkpt>`,
          )
          .join('\n') +
        '\n    </trkseg>',
    )
    .join('\n');
  files.set(
    `Outdoor Cycling-Route-${stamp}.gpx`,
    `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<gpx version="1.1" creator="velograph-synthetic-fixtures" xmlns="http://www.topografix.com/GPX/1/1">\n` +
      `  <trk>\n    <name>Synthetic Ride ${ride.def.index + 1}</name>\n${gpxSegs}\n  </trk>\n</gpx>\n`,
  );
  return files;
}

export function generateCorpus({ rides = 3, seed = 1000 } = {}) {
  const all = new Map();
  for (const def of rideDefs(rides, seed)) {
    for (const [name, content] of renderFiles(generateRide(def))) {
      all.set(name, content);
    }
  }
  return all;
}

/** Walk upward from `p` to the nearest ancestor that actually exists. */
function nearestExistingAncestor(p) {
  let cur = p;
  for (;;) {
    if (existsSync(cur)) return cur;
    const parent = dirname(cur);
    if (parent === cur) return cur; // reached filesystem root; give up gracefully
    cur = parent;
  }
}

const isWithin = (root, candidate) => candidate === root || candidate.startsWith(root + sep);

/**
 * Resolve and validate a `--out` argument before ANY deletion happens.
 * Rejects the repository root, anything outside `fixtures/synthetic/`
 * (including `..` traversal, which `resolve()` normalizes away lexically),
 * and symlink escapes (an ancestor directory that is actually a symlink
 * pointing outside the fixture tree) by re-checking the real path of the
 * nearest existing ancestor. Throws with a descriptive message on any
 * rejection; returns the validated absolute path otherwise.
 */
export function resolveFixtureOutputDir(outArg, repoRoot = REPO_ROOT) {
  const resolvedRepoRoot = realpathSync(resolve(repoRoot));
  const fixturesRoot = join(resolvedRepoRoot, 'fixtures', 'synthetic');
  const lexicalTarget = resolve(resolvedRepoRoot, outArg);

  if (lexicalTarget === resolvedRepoRoot) {
    throw new Error(
      `generate-fixtures: refusing to operate on the repository root: ${lexicalTarget}`,
    );
  }
  if (!isWithin(fixturesRoot, lexicalTarget) || lexicalTarget === fixturesRoot) {
    throw new Error(
      `generate-fixtures: --out must resolve inside fixtures/synthetic/, got: ${lexicalTarget}`,
    );
  }

  // Re-resolve through any existing symlinks so an ancestor directory
  // swapped for a symlink (e.g. fixtures/synthetic/rides -> /etc) cannot
  // smuggle deletion/generation outside the fixture tree.
  const existingAncestor = nearestExistingAncestor(lexicalTarget);
  const realAncestor = realpathSync(existingAncestor);
  const remainder = relative(existingAncestor, lexicalTarget);
  const realTarget = remainder ? join(realAncestor, remainder) : realAncestor;
  if (!isWithin(fixturesRoot, realTarget) || realTarget === fixturesRoot) {
    throw new Error(
      `generate-fixtures: --out resolves outside fixtures/synthetic/ via symlink: ${realTarget}`,
    );
  }

  return lexicalTarget;
}

function main(argv) {
  const args = { out: 'fixtures/synthetic/rides', seed: 1000, rides: 3 };
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    if (key && key in args) args[key] = key === 'out' ? argv[i + 1] : Number(argv[i + 1]);
  }

  const target = resolveFixtureOutputDir(args.out);
  const corpus = generateCorpus({ rides: args.rides, seed: args.seed });

  // Generate into a temporary sibling first, then swap it in — the
  // validated fixture directory is only ever removed after generation has
  // fully succeeded, and only that validated path is ever deleted.
  const tmpDir = `${target}.tmp-${process.pid}-${Date.now()}`;
  rmSync(tmpDir, { recursive: true, force: true });
  mkdirSync(tmpDir, { recursive: true });
  for (const [name, content] of corpus) {
    writeFileSync(join(tmpDir, name), content);
  }
  rmSync(target, { recursive: true, force: true });
  renameSync(tmpDir, target);

  console.log(`fixtures:generate wrote ${corpus.size} files to ${target}`);
}

if (process.argv[1] && process.argv[1].endsWith('generate-fixtures.mjs')) {
  main(process.argv.slice(2));
}
