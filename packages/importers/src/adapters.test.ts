import { describe, expect, it } from 'vitest';
import {
  CSV_NORMALIZATION_CHUNK_ROWS,
  classifyImportFileName,
  parseHaeCsv,
  parseHaeCsvSteps,
  parseHaeFilenameTimestamp,
  parseHaeFilenameTimestamps,
  parseHaeGpx,
} from './adapters.ts';

describe('Health Auto Export CSV header contracts (IMP-004)', () => {
  it('classifies an empty or whitespace-only CSV without retaining rows', () => {
    for (const text of ['', '  \n\t']) {
      expect(() =>
        parseHaeCsv('Outdoor Cycling-Heart Rate-20320710_113000.csv', text),
      ).toThrowError(expect.objectContaining({ code: 'empty_file' }));
    }
  });

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
    expect(parsed.samples.map((sample) => sample.value)).toEqual([400, 500]);
  });

  it('converts every supported distance and energy unit to canonical SI', () => {
    const distanceM = parseHaeCsv(
      'Outdoor Cycling-Cycling Distance-20320710_113000.csv',
      ['Date/Time,Cycling Distance (m)', '2032-07-10T15:30:00Z,400'].join('\n'),
    );
    const energyKj = parseHaeCsv(
      'Outdoor Cycling-Active Energy-20320710_113000.csv',
      ['Date/Time,Active Energy (kJ)', '2032-07-10T15:30:00Z,1.5'].join('\n'),
    );
    const energyJ = parseHaeCsv(
      'Outdoor Cycling-Active Energy-20320710_113000.csv',
      ['Date/Time,Active Energy (J)', '2032-07-10T15:30:00Z,1500'].join('\n'),
    );
    const energyKcal = parseHaeCsv(
      'Outdoor Cycling-Active Energy-20320710_113000.csv',
      ['Date/Time,Active Energy (kcal)', '2032-07-10T15:30:00Z,2'].join('\n'),
    );

    for (const parsed of [distanceM, energyKj, energyJ, energyKcal]) {
      expect(parsed.kind).toBe('metric');
    }
    expect(distanceM.kind === 'metric' ? distanceM.samples[0]!.value : null).toBe(400);
    expect(energyKj.kind === 'metric' ? energyKj.samples[0]!.value : null).toBe(1500);
    expect(energyJ.kind === 'metric' ? energyJ.samples[0]!.value : null).toBe(1500);
    expect(energyKcal.kind === 'metric' ? energyKcal.samples[0]!.value : null).toBe(8368);
  });

  it.each([
    ['Cycling Distance', '1'],
    ['Cycling Distance (mi)', '1'],
    ['Active Energy', '1'],
    ['Active Energy (Wh)', '1'],
  ])('rejects missing or unsupported canonical-unit contract: %s', (header, value) => {
    const label = header.startsWith('Cycling') ? 'Cycling Distance' : 'Active Energy';
    expect(() =>
      parseHaeCsv(
        `Outdoor Cycling-${label}-20320710_113000.csv`,
        [`Date/Time,${header}`, `2032-07-10T15:30:00Z,${value}`].join('\n'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'unit_unsupported' }));
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

  it('rejects filename/header metric-kind mismatches before normalizing rows', () => {
    expect(() =>
      parseHaeCsv(
        'Outdoor Cycling-Cycling Cadence-20320710_113000.csv',
        ['Date/Time,Avg (bpm)', '2032-07-10T15:30:00Z,120'].join('\n'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'metric_kind_mismatch' }));

    const lat = [-48, 75].join('.');
    const lon = [-123, 25].join('.');
    expect(() =>
      parseHaeCsv(
        'Outdoor Cycling-Heart Rate-20320710_113000.csv',
        [
          'Timestamp,Latitude,Longitude,Altitude (m),Speed (m/s)',
          `2032-07-10T15:30:00Z,${lat},${lon},100,10`,
        ].join('\n'),
      ),
    ).toThrowError(expect.objectContaining({ code: 'metric_kind_mismatch' }));
  });

  it('yields through bounded parsing and normalization while preserving timestamp order', () => {
    const base = Date.UTC(2032, 0, 1);
    const rowCount = CSV_NORMALIZATION_CHUNK_ROWS * 2 + 17;
    const rows = ['Date/Time,Cadence (rpm)'];
    for (let index = rowCount - 1; index >= 0; index--) {
      rows.push(`${new Date(base + index * 1_000).toISOString()},80`);
    }
    const text = rows.join('\n');
    const steps = parseHaeCsvSteps('Outdoor Cycling-Cycling Cadence-20320101_000000.csv', text);
    let yields = 0;
    let parsed;
    for (;;) {
      const step = steps.next();
      if (step.done) {
        parsed = step.value;
        break;
      }
      yields++;
    }

    expect(yields).toBeGreaterThan(Math.ceil(text.length / (64 * 1024)));
    expect(parsed.kind).toBe('metric');
    if (parsed.kind !== 'metric') return;
    expect(parsed.samples).toHaveLength(rowCount);
    expect(parsed.samples[0]!.t).toBe(base);
    expect(parsed.samples[rowCount - 1]!.t).toBe(base + (rowCount - 1) * 1_000);
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

  it('converts route feet and km/h columns to metres and m/s', () => {
    const lat = [-48, 75].join('.');
    const lon = [-123, 25].join('.');
    const parsed = parseHaeCsv(
      'Outdoor Cycling-Route-20320710_113000.csv',
      [
        'Timestamp,Latitude,Longitude,Altitude (ft),Speed (km/h),Horizontal Accuracy (ft)',
        `2032-07-10T15:30:00Z,${lat},${lon},100,36,10`,
      ].join('\n'),
    );

    expect(parsed.kind).toBe('route');
    if (parsed.kind !== 'route') return;
    expect(parsed.segments[0]!.points[0]).toMatchObject({
      ele: 30.48,
      speed: 10,
      hAcc: 3.048,
    });
  });

  it.each(['Altitude', 'Altitude (yd)', 'Speed', 'Speed (mph)'])(
    'rejects missing or unsupported route units: %s',
    (header) => {
      const lat = [-48, 75].join('.');
      const lon = [-123, 25].join('.');
      expect(() =>
        parseHaeCsv(
          'Outdoor Cycling-Route-20320710_113000.csv',
          [`Timestamp,Latitude,Longitude,${header}`, `2032-07-10T15:30:00Z,${lat},${lon},1`].join(
            '\n',
          ),
        ),
      ).toThrowError(expect.objectContaining({ code: 'unit_unsupported' }));
    },
  );

  it('makes GPX inventory and parsing agree on the canonical route filename', () => {
    const canonical = 'Outdoor Cycling-Route-20320710_113000.gpx';
    const noncanonical = [
      'Outdoor Cycling-Route-synthetic.gpx',
      'Outdoor Cycling-Heart Rate-20320710_113000.gpx',
    ];

    expect(classifyImportFileName(canonical).kind).toBe('supported');
    for (const name of noncanonical) {
      expect(classifyImportFileName(name).kind).toBe('unsupported');
      expect(() => parseHaeGpx(name, '<gpx/>')).toThrowError(
        expect.objectContaining({ code: 'unsupported_file_type' }),
      );
    }
  });
});
