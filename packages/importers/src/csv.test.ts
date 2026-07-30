import { describe, expect, it } from 'vitest';
import { assertCsvByteLength, CsvStreamParser, DEFAULT_CSV_LIMITS, parseCsv } from './csv.ts';

describe('streaming CSV parser contract', () => {
  it('parses simple rows', () => {
    expect(parseCsv('a,b,c\n1,2,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('handles quoted fields with commas, quotes, and newlines', () => {
    const rows = parseCsv('name,note\n"x,y","he said ""hi""\nsecond line"\n');
    expect(rows[1]).toEqual(['x,y', 'he said "hi"\nsecond line']);
  });

  it('handles CRLF and CR line endings and skips blank lines', () => {
    expect(parseCsv('a,b\r\n1,2\r3,4\r\n\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', '4'],
    ]);
  });

  it('strips a UTF-8 BOM', () => {
    expect(parseCsv('﻿a,b\n1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('is chunk-boundary independent (streaming)', () => {
    const text = 'a,b\n"1,1",2\n3,"4\n4"\n';
    const whole = parseCsv(text);
    for (let cut = 1; cut < text.length - 1; cut++) {
      const rows: string[][] = [];
      const p = new CsvStreamParser((r) => rows.push(r));
      p.push(text.slice(0, cut));
      p.push(text.slice(cut));
      p.end();
      expect(rows).toEqual(whole);
    }
  });

  it('throws on unterminated quotes', () => {
    expect(() => parseCsv('a,"unterminated\n1,2')).toThrow();
  });

  it('fails closed on byte, row, column, and field limits', () => {
    expect(() => assertCsvByteLength(11, 10)).toThrowError(
      expect.objectContaining({ code: 'csv_limits_exceeded' }),
    );
    expect(() =>
      parseCsv('ab', {
        ...DEFAULT_CSV_LIMITS,
        maxBytes: 1,
      }),
    ).toThrowError(expect.objectContaining({ code: 'csv_limits_exceeded' }));
    expect(() =>
      parseCsv('h\n1\n2', {
        ...DEFAULT_CSV_LIMITS,
        maxRows: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: 'csv_limits_exceeded' }));
    expect(() =>
      parseCsv('a,b,c', {
        ...DEFAULT_CSV_LIMITS,
        maxColumns: 2,
      }),
    ).toThrowError(expect.objectContaining({ code: 'csv_limits_exceeded' }));
    expect(() =>
      parseCsv('header\n12345', {
        ...DEFAULT_CSV_LIMITS,
        maxFieldChars: 4,
      }),
    ).toThrowError(expect.objectContaining({ code: 'csv_limits_exceeded' }));
  });
});
