import { describe, expect, it } from 'vitest';
import { isValidTimeZone, parseInstant } from './time.ts';

describe('instant parsing with an explicit import timezone', () => {
  it('keeps explicit Z and numeric offsets authoritative', () => {
    const expected = Date.UTC(2032, 6, 10, 15, 30, 0);
    expect(parseInstant('2032-07-10T15:30:00Z', { defaultTimeZone: 'America/Toronto' })).toBe(
      expected,
    );
    expect(parseInstant('2032-07-10T11:30:00-04:00', { defaultTimeZone: 'Asia/Tokyo' })).toBe(
      expected,
    );
  });

  it('resolves an offset-less summer wall time in a DST-observing timezone', () => {
    expect(parseInstant('2032-07-10 11:30:00', { defaultTimeZone: 'America/Toronto' })).toBe(
      Date.UTC(2032, 6, 10, 15, 30, 0),
    );
  });

  it('resolves an offset-less winter wall time with the seasonal offset', () => {
    expect(parseInstant('2032-01-10 11:30:00', { defaultTimeZone: 'America/Toronto' })).toBe(
      Date.UTC(2032, 0, 10, 16, 30, 0),
    );
  });

  it('fails closed for invalid zones and nonexistent spring-forward wall times', () => {
    expect(isValidTimeZone('Not/A_Zone')).toBe(false);
    expect(parseInstant('2032-03-14 02:30:00', { defaultTimeZone: 'America/Toronto' })).toBeNull();
  });
});
