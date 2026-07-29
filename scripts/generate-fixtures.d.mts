/**
 * Ambient declarations for generate-fixtures.mjs (plain JS, not built by
 * tsc), so TypeScript test code elsewhere in the monorepo — currently
 * apps/api/src/path-import.test.ts — can import `generateCorpus` to build a
 * synthetic Health Auto Export-shaped folder without tripping TS7016. Kept
 * intentionally narrow: only the exports actually consumed outside this
 * script are typed.
 */
export const REPO_ROOT: string;
export const SYNTHETIC_SOURCE: string;

export interface RideDef {
  index: number;
  start: number;
  durationSec: number;
  seed: number;
  gapAt: number | null;
  gapFrac: number;
}

export function mulberry32(seed: number): () => number;
export function rideDefs(count: number, baseSeed?: number): RideDef[];
export function generateRide(def: RideDef): {
  def: RideDef;
  t0: number;
  t1: number;
  hr: { t: number; min: number; max: number; avg: number }[];
  cadence: { t: number; rpm: number }[];
  distance: { t: number; km: number }[];
  energy: { t: number; kj: number }[];
  route: {
    t: number;
    lat: number;
    lon: number;
    alt: number;
    vacc: number;
    hacc: number;
    speed: number;
    course: number;
  }[];
  totalKm: number;
};
export function renderFiles(ride: ReturnType<typeof generateRide>): Map<string, string>;
export function generateCorpus(opts?: { rides?: number; seed?: number }): Map<string, string>;
export function resolveFixtureOutputDir(outArg: string, repoRoot?: string): string;
