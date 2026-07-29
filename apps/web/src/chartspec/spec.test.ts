import { describe, expect, it } from 'vitest';
import {
  buildLineSpec,
  buildRouteSpec,
  downsample,
  fmtDuration,
  routeIndexAt,
  timeAtX,
  valueAt,
} from './spec.ts';

const pts = (n: number, f: (i: number) => number) =>
  Array.from({ length: n }, (_, i) => ({ t: i * 1000, v: f(i) }));

describe('pure chart specs (§9.3 determinism contract)', () => {
  it('is deterministic: same input → identical spec', () => {
    const p = pts(500, (i) => Math.sin(i / 10) * 50 + 100);
    const a = JSON.stringify(buildLineSpec(p, 300, 80));
    const b = JSON.stringify(buildLineSpec(p, 300, 80));
    expect(a).toBe(b);
  });

  it('downsampling preserves extremes', () => {
    const p = pts(1000, (i) => (i === 500 ? 999 : 10));
    const ds = downsample(p, 100);
    expect(ds.length).toBeLessThanOrEqual(101);
    expect(Math.max(...ds.map((d) => d.v))).toBe(999);
  });

  it('line spec spans the viewport and starts with M', () => {
    const spec = buildLineSpec(
      pts(10, (i) => i),
      300,
      80,
    )!;
    expect(spec.path.startsWith('M')).toBe(true);
    expect(spec.area.endsWith('Z')).toBe(true);
    expect(spec.tMax).toBe(9000);
  });

  it('returns null for insufficient points', () => {
    expect(buildLineSpec([], 300, 80)).toBeNull();
    expect(buildLineSpec([{ t: 0, v: 1 }], 300, 80)).toBeNull();
  });

  it('route spec emits one path per segment — gaps never bridged (ROUTE-004)', () => {
    const spec = buildRouteSpec(
      [
        {
          points: [
            { lat: -48.5, lon: -123.5 },
            { lat: -48.51, lon: -123.51 },
          ],
        },
        {
          points: [
            { lat: -48.53, lon: -123.53 },
            { lat: -48.54, lon: -123.54 },
          ],
        },
      ],
      400,
      300,
    )!;
    expect(spec.segmentPaths).toHaveLength(2);
    expect(spec.segmentPaths[0]!.match(/M/g)).toHaveLength(1);
    expect(spec.start).not.toBeNull();
    expect(spec.finish).not.toBeNull();
  });

  it('route projection keeps points inside the viewport', () => {
    const spec = buildRouteSpec(
      [
        {
          points: [
            { lat: -48.5, lon: -123.5 },
            { lat: -48.6, lon: -123.4 },
          ],
        },
      ],
      400,
      300,
    )!;
    for (const [x, y] of [spec.start!, spec.finish!]) {
      expect(x).toBeGreaterThanOrEqual(0);
      expect(x).toBeLessThanOrEqual(400);
      expect(y).toBeGreaterThanOrEqual(0);
      expect(y).toBeLessThanOrEqual(300);
    }
  });

  it('cursor mapping: timeAtX and valueAt interpolate', () => {
    expect(timeAtX(150, 300, 0, 1000)).toBe(500);
    const v = valueAt(
      [
        { t: 0, v: 0 },
        { t: 100, v: 100 },
      ],
      50,
    );
    expect(v).toBe(50);
  });

  it('routeIndexAt finds the nearest timed point', () => {
    const idx = routeIndexAt(
      [
        {
          points: [
            { lat: 0, lon: 0, t: 0 },
            { lat: 0, lon: 0, t: 100 },
            { lat: 0, lon: 0, t: 220 },
          ],
        },
      ],
      110,
    );
    expect(idx).toBe(1);
  });

  it('formats durations deterministically', () => {
    expect(fmtDuration(3725)).toBe('1:02:05');
    expect(fmtDuration(65)).toBe('1:05');
    expect(fmtDuration(null)).toBe('–');
  });
});
