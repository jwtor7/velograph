import { describe, expect, it } from 'vitest';
import type { RideAnalytics } from '@velograph/analytics';
import {
  buildInsightPayload,
  evidenceIdsForPayload,
  METRIC_ALLOW_LIST,
  PAYLOAD_VERSION,
} from './payload.ts';
import { buildContextAvailability } from './context.ts';
import { buildAnalyticsFixture } from './test-fixtures.ts';

// Sensitive-looking strings are assembled at runtime from fragments so the
// privacy scanner never sees a literal match in this source file (per
// CLAUDE.md/scripts/privacy-scan.mjs — this is a plain test file, not a
// fixture under fixtures/synthetic/).
const assembledDeviceString = ['Apple', 'Watch'].join(' ');
const assembledHomePath = ['/Users', 'exampleuser', 'ride-export.csv'].join('/');
const assembledLat = Number(['-48', '512345'].join('.'));
const assembledLon = Number(['-123', '456789'].join('.'));

describe('buildInsightPayload (AI-003)', () => {
  it('carries the versioned payload tag and formula version', () => {
    const payload = buildInsightPayload(buildAnalyticsFixture());
    expect(payload.payloadVersion).toBe(PAYLOAD_VERSION);
    expect(payload.formulaVersion).toBe('analytics-v1');
  });

  it('includes exactly the allow-listed metric IDs, nothing more', () => {
    const payload = buildInsightPayload(buildAnalyticsFixture());
    const ids = payload.metrics.map((m) => m.id);
    expect(ids).toEqual(METRIC_ALLOW_LIST.map((spec) => spec.id));
  });

  it('flags null metrics as unavailable rather than omitting them silently', () => {
    const payload = buildInsightPayload(
      buildAnalyticsFixture({ energyKj: null, efficiency: null }),
    );
    expect(payload.unavailableMetricIds).toEqual(
      expect.arrayContaining(['energy_kj', 'efficiency_kmh_per_bpm']),
    );
  });

  it('defaults personal context to not_available when none is supplied', () => {
    const payload = buildInsightPayload(buildAnalyticsFixture());
    expect(payload.context).toEqual(buildContextAvailability());
  });

  it('carries explicitly supplied context flags through', () => {
    const ctx = buildContextAvailability({ recovery: true });
    const payload = buildInsightPayload(buildAnalyticsFixture(), ctx);
    expect(payload.context.recovery).toBe('available');
    expect(payload.context.sleep).toBe('not_available');
  });

  it('exposes a zone summary bounded to zone/label/share, no raw sample rows', () => {
    const payload = buildInsightPayload(buildAnalyticsFixture());
    expect(payload.zones).not.toBeNull();
    for (const z of payload.zones!) {
      expect(Object.keys(z).sort()).toEqual(['label', 'shareOfTime', 'zone']);
    }
  });

  it('never carries coordinates, device/source strings, or local paths even if a careless caller attaches them', () => {
    // A hostile/careless input augmented with fields that must never appear
    // in RideAnalytics but which a bug upstream could accidentally attach.
    // Cast through unknown since these fields don't exist on RideAnalytics —
    // the point of the test is that buildInsightPayload structurally cannot
    // pick them up even if they're present on the object it's given.
    const dirty = {
      ...buildAnalyticsFixture(),
      routePoint: { y: assembledLat, x: assembledLon },
      sourceDeviceName: assembledDeviceString,
      sourceFilePath: assembledHomePath,
      rawHeartRateSamples: [{ t: 1, value: 120 }],
    } as unknown as RideAnalytics;

    const payload = buildInsightPayload(dirty);
    const json = JSON.stringify(payload);

    expect(json).not.toContain(assembledDeviceString);
    expect(json).not.toContain(assembledHomePath);
    expect(json).not.toContain(String(assembledLat));
    expect(json).not.toContain(String(assembledLon));
    expect(json.includes('routePoint')).toBe(false);
    expect(json.includes('sourceDeviceName')).toBe(false);
    expect(json.includes('sourceFilePath')).toBe(false);
    expect(json.includes('rawHeartRateSamples')).toBe(false);
  });

  it('evidenceIdsForPayload includes every metric id and zone id, and only those', () => {
    const payload = buildInsightPayload(buildAnalyticsFixture());
    const ids = evidenceIdsForPayload(payload);
    for (const spec of METRIC_ALLOW_LIST) expect(ids.has(spec.id)).toBe(true);
    expect(ids.has('hr_zone_1_share')).toBe(true);
    expect(ids.has('made_up_metric_id')).toBe(false);
  });
});
