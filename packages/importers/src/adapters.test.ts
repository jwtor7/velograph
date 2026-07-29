import { describe, expect, it } from 'vitest';
import { parseHaeCsv, parseHaeFilenameTimestamp, parseHaeFilenameTimestamps } from './adapters.ts';

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

  it('rejects blank and out-of-range required metric values', () => {
    expect(() =>
      parseHaeCsv(
        'Outdoor Cycling-Heart Rate-20320710_113000.csv',
        ['Date/Time,Avg (bpm)', '2032-07-10T15:30:00Z,   '].join('\n'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'numeric_value_invalid' }));
    expect(() =>
      parseHaeCsv(
        'Outdoor Cycling-Heart Rate-20320710_113000.csv',
        ['Date/Time,Avg (bpm)', '2032-07-10T15:30:00Z,301'].join('\n'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'numeric_value_invalid' }));
  });

  it('rejects impossible required timestamps instead of normalizing them', () => {
    expect(() =>
      parseHaeCsv(
        'Outdoor Cycling-Cycling Cadence-20320230_113000.csv',
        ['Date/Time,Cadence (rpm)', '2032-02-30T15:30:00Z,80'].join('\n'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'timestamps_invalid' }));
    expect(() =>
      parseHaeFilenameTimestamp('Outdoor Cycling-Cycling Cadence-20320230_113000.csv'),
    ).toThrowError(expect.objectContaining({ code: 'timestamps_invalid' }));
  });

  it('exposes local-wall-time and UTC filename interpretations for corroboration', () => {
    expect(
      parseHaeFilenameTimestamps('Outdoor Cycling-Cycling Cadence-20320710_113000.csv', {
        timeZone: 'America/Toronto',
      }),
    ).toEqual([Date.UTC(2032, 6, 10, 15, 30, 0), Date.UTC(2032, 6, 10, 11, 30, 0)]);
  });

  it('rejects blank route coordinates and omits blank optional fields', () => {
    const lat = [-48, 75].join('.');
    const lon = [-123, 25].join('.');
    expect(() =>
      parseHaeCsv(
        'Outdoor Cycling-Route-20320710_113000.csv',
        ['Timestamp,Latitude,Longitude', `2032-07-10T15:30:00Z, ,${lon}`].join('\n'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'numeric_value_invalid' }));

    const parsed = parseHaeCsv(
      'Outdoor Cycling-Route-20320710_113000.csv',
      [
        'Timestamp,Latitude,Longitude,Altitude (m),Speed (m/s)',
        `2032-07-10T15:30:00Z,${lat},${lon}, , `,
      ].join('\n'),
    );
    expect(parsed.kind).toBe('route');
    if (parsed.kind !== 'route') return;
    expect(parsed.segments[0]!.points[0]).not.toHaveProperty('ele');
    expect(parsed.segments[0]!.points[0]).not.toHaveProperty('speed');
  });
});
