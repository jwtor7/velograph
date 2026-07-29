import type { ParsedFile } from '@velograph/shared';

/**
 * Workout association (IMP-005): a parsed file is matched to a workout by
 * workout type plus INTERNAL sample-time range with a tolerance window.
 * The filename timestamp is only ever a display hint; association never
 * relies on filename alone.
 */
export const DEFAULT_ASSOCIATION_TOLERANCE_MS = 10 * 60 * 1000;

export function sampleTimeRange(file: ParsedFile): { start: number; end: number } | null {
  if (file.kind === 'metric') {
    if (file.samples.length === 0) return null;
    return { start: file.samples[0]!.t, end: file.samples[file.samples.length - 1]!.t };
  }
  const times = file.segments
    .flatMap((s) => s.points.map((p) => p.t))
    .filter((t): t is number => t != null);
  if (times.length === 0) return null;
  return { start: Math.min(...times), end: Math.max(...times) };
}
