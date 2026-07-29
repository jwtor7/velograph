import { describe, expect, it } from 'vitest';
import { parseHaeCsv } from './adapters.ts';

describe('Health Auto Export CSV header contracts (IMP-004)', () => {
  it('accepts Cycling Distance (km)', () => {
    const parsed = parseHaeCsv(
      'Outdoor Cycling-Cycling Distance-20320710_113000.csv',
      [
        'Date/Time,Cycling Distance (km),Source',
        '2032-07-10T15:30:00Z,0.4,Synth Watch X1',
        '2032-07-10T15:31:00Z,0.5,Synth Watch X1',
      ].join('\n'),
    );
    expect(parsed.kind).toBe('metric');
    if (parsed.kind !== 'metric') return;
    expect(parsed.metric).toBe('distance');
    expect(parsed.samples).toHaveLength(2);
  });

  it('accepts heart-rate count/min aggregate columns', () => {
    const parsed = parseHaeCsv(
      'Outdoor Cycling-Heart Rate-20320710_113000.csv',
      [
        'Date/Time,Min (count/min),Max (count/min),Avg (count/min),Context,Source',
        '2032-07-10T15:30:00Z,110,130,120,Active,Synth Watch X1',
        '2032-07-10T15:31:00Z,115,135,125,Active,Synth Watch X1',
      ].join('\n'),
    );
    expect(parsed.kind).toBe('metric');
    if (parsed.kind !== 'metric') return;
    expect(parsed.metric).toBe('heart_rate');
    expect(parsed.samples).toHaveLength(2);
    expect(parsed.samples[0]).toMatchObject({ value: 120, min: 110, max: 130 });
  });
});
