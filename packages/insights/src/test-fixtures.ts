import type { RideAnalytics } from '@velograph/analytics';
import { NON_CLINICAL_DISCLAIMER } from './guidance.ts';
import {
  INSIGHT_OUTPUT_SCHEMA_VERSION,
  INSIGHT_SECTION_ORDER,
  type InsightOutput,
} from './schema.ts';

/** Synthetic RideAnalytics fixture for insights tests — no real ride data. */
export function buildAnalyticsFixture(overrides: Partial<RideAnalytics> = {}): RideAnalytics {
  return {
    formulaVersion: 'analytics-v1',
    workoutId: 1,
    durationS: 3600,
    movingTimeS: 3400,
    distanceM: 30000,
    avgSpeedMs: 8.8,
    maxSpeedMs: 15.2,
    heartRate: { avg: 142.5, max: 178, min: 98, coverage: 0.95, sampleCount: 3600 },
    cadence: { avg: 82.3, max: 110, min: 40, coverage: 0.9, sampleCount: 3600 },
    energyKj: 850.2,
    elevation: { gainM: 320, lossM: 300, minM: 10, maxM: 210 },
    zones: [
      { zone: 1, label: 'Z1 Recovery', seconds: 300, share: 0.083 },
      { zone: 2, label: 'Z2 Endurance', seconds: 1500, share: 0.417 },
      { zone: 3, label: 'Z3 Tempo', seconds: 1200, share: 0.333 },
      { zone: 4, label: 'Z4 Threshold', seconds: 600, share: 0.167 },
    ],
    efficiency: 2.1,
    decouplingPct: 6.4,
    pacingVariability: 0.12,
    splits: [],
    unavailable: {},
    ...overrides,
  };
}

/** Fully schema-valid synthetic provider output with no unsupported findings. */
export function buildInsightOutputFixture(promptVersion = 'insight-prompt-v1'): InsightOutput {
  return {
    schemaVersion: INSIGHT_OUTPUT_SCHEMA_VERSION,
    promptVersion,
    disclaimer: NON_CLINICAL_DISCLAIMER,
    sections: INSIGHT_SECTION_ORDER.map((section) => ({
      id: section.id,
      title: section.title,
      findings: [],
    })),
  };
}
