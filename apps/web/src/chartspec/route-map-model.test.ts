import { describe, expect, it } from 'vitest';
import {
  buildRouteMapModel,
  MAX_GRADIENT_CHUNKS,
  MAX_RENDER_POINTS,
  routePositionAtTime,
} from './route-map-model.ts';

describe('interactive route map model', () => {
  it('preserves recording gaps and never counts the gap as travelled distance', () => {
    const model = buildRouteMapModel([
      {
        points: [
          { lat: -48, lon: -123, t: 0 },
          { lat: -48, lon: -122.9, t: 10 },
        ],
      },
      {
        points: [
          { lat: -48, lon: -121, t: 20 },
          { lat: -48, lon: -120.9, t: 30 },
        ],
      },
    ])!;

    expect(model).not.toBeNull();
    expect(model.gradientChunks).toHaveLength(2);
    expect(model.recordingGapCount).toBe(1);
    expect(model.totalDistanceM).toBeLessThan(20_000);
    expect(model.start.label).toBe('Start');
    expect(model.finish.label).toBe('Finish');
  });

  it('builds markers from full geometry before deterministic render downsampling', () => {
    const points = Array.from({ length: 120_000 }, (_, index) => ({
      lat: -48 + (index % 200) / 100_000,
      lon: -123 + index / 1_000_000,
      t: index * 10,
    }));

    const model = buildRouteMapModel([{ points }])!;

    expect(model.sourcePointCount).toBe(120_000);
    expect(model.renderPointCount).toBeLessThanOrEqual(MAX_RENDER_POINTS);
    expect(model.simplified).toBe(true);
    expect(model.gradientChunks.length).toBeLessThanOrEqual(MAX_GRADIENT_CHUNKS);
    expect(model.start.position).toEqual({ lat: points[0]!.lat, lon: points[0]!.lon });
    expect(model.finish.position).toEqual({
      lat: points[points.length - 1]!.lat,
      lon: points[points.length - 1]!.lon,
    });
    expect(model.directionMarkers).toHaveLength(3);
    expect(model.distanceMarkers.length).toBeGreaterThan(0);
  });

  it('excludes missing and out-of-order times and finds the nearest position', () => {
    const model = buildRouteMapModel([
      {
        points: [
          { lat: -48, lon: -123, t: 0 },
          { lat: -48, lon: -122.9, t: null },
          { lat: -48, lon: -122.8, t: 20 },
          { lat: -48, lon: -122.7, t: 10 },
          { lat: -48, lon: -122.6, t: Number.NaN },
          { lat: -48, lon: -122.5, t: 40 },
        ],
      },
    ])!;

    expect(model.timedIndex.map(({ t }) => t)).toEqual([0, 20, 40]);
    expect(routePositionAtTime(model, 14)).toEqual(model.timedIndex[1]!.position);
    expect(routePositionAtTime(model, 8)).toEqual(model.timedIndex[0]!.position);
  });

  it('splits a run at invalid coordinates instead of bridging across them', () => {
    const model = buildRouteMapModel([
      {
        points: [
          { lat: -48, lon: -123, t: null },
          { lat: -48, lon: -122.9, t: null },
          { lat: Number.NaN, lon: -122.8, t: null },
          { lat: -48, lon: -121, t: null },
          { lat: -48, lon: -120.9, t: null },
        ],
      },
    ])!;

    expect(model.gradientChunks).toHaveLength(2);
    expect(model.totalDistanceM).toBeLessThan(20_000);
  });

  it('unwraps an antimeridian crossing into a compact viewport', () => {
    const model = buildRouteMapModel([
      {
        points: [
          { lat: -48, lon: 179, t: null },
          { lat: -48, lon: -179, t: null },
        ],
      },
    ])!;

    expect(model.bounds[1][1] - model.bounds[0][1]).toBeCloseTo(2, 5);
    expect(model.totalDistanceM).toBeLessThan(200_000);
  });

  it('keeps rounded distance labels clear of the finish marker', () => {
    const model = buildRouteMapModel([
      {
        points: [
          { lat: -48, lon: -123, t: null },
          { lat: -48, lon: -122.72, t: null },
        ],
      },
    ])!;

    expect(model.distanceMarkers.length).toBeGreaterThan(0);
    expect(model.distanceMarkers.at(-1)?.label).not.toBe('20 km');
  });

  it('labels route markers in the selected display units', () => {
    const model = buildRouteMapModel(
      [
        {
          points: [
            { lat: -48, lon: -123, t: null },
            { lat: -48, lon: -122.9, t: null },
          ],
        },
      ],
      'imperial',
    )!;

    expect(model.distanceMarkers.length).toBeGreaterThan(0);
    expect(model.distanceMarkers.every((marker) => /\b(?:mi|ft)$/.test(marker.label))).toBe(true);
    expect(model.distanceMarkers.some((marker) => marker.label.endsWith(' km'))).toBe(false);
  });

  it('keeps hundreds of recorded segments visible while bounding gradient layers', () => {
    const segmentWidth = 1 / 1_000;
    const segments = Array.from({ length: 500 }, (_, index) => ({
      points: [
        { lat: -48 + index / 100_000, lon: -123, t: null },
        { lat: -48 + index / 100_000, lon: -123 + segmentWidth, t: null },
      ],
    }));

    const model = buildRouteMapModel(segments)!;

    expect(model.renderRuns).toHaveLength(500);
    expect(model.renderPointCount).toBe(1_000);
    expect(model.gradientChunks.length).toBeLessThanOrEqual(MAX_GRADIENT_CHUNKS);
  });
});
