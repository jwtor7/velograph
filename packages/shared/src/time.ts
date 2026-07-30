/**
 * Instant parsing for import adapters. Storage truth is epoch ms UTC.
 * Accepted shapes (adapter v1):
 *   - ISO 8601 with offset or Z:  2031-04-02T07:30:00Z, 2031-04-02T07:30:00+02:00
 *   - ISO-like without offset:    2031-04-02T07:30:00 / 2031-04-02 07:30:00
 *     (interpreted in `defaultTimeZone` when supplied, otherwise UTC for
 *     backwards-compatible callers)
 */
const ISO_NO_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/;

export interface ParseInstantOptions {
  /**
   * IANA timezone used only for offset-less wall times. Explicit `Z` and
   * numeric offsets always remain authoritative.
   */
  defaultTimeZone?: string | null;
}

interface WallTimeParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
  millisecond: number;
}

const zoneFormatters = new Map<string, Intl.DateTimeFormat>();

/** True when `timeZone` is an IANA timezone understood by this runtime. */
export function isValidTimeZone(timeZone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(0);
    return true;
  } catch {
    return false;
  }
}

/** Host-local IANA timezone, with a deterministic UTC fallback. */
export function systemTimeZone(): string {
  const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return timeZone && isValidTimeZone(timeZone) ? timeZone : 'UTC';
}

function formatterForZone(timeZone: string): Intl.DateTimeFormat {
  const existing = zoneFormatters.get(timeZone);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat('en-CA-u-ca-iso8601', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  });
  zoneFormatters.set(timeZone, formatter);
  return formatter;
}

function localPartsAt(instant: number, timeZone: string): Omit<WallTimeParts, 'millisecond'> {
  const parts = Object.fromEntries(
    formatterForZone(timeZone)
      .formatToParts(new Date(instant))
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, Number(part.value)]),
  );
  return {
    year: parts['year']!,
    month: parts['month']!,
    day: parts['day']!,
    hour: parts['hour']!,
    minute: parts['minute']!,
    second: parts['second']!,
  };
}

function wallTimeAsUtc(parts: WallTimeParts): number {
  const date = new Date(0);
  date.setUTCFullYear(parts.year, parts.month - 1, parts.day);
  date.setUTCHours(parts.hour, parts.minute, parts.second, parts.millisecond);
  return date.getTime();
}

function isValidWallTime(parts: WallTimeParts): boolean {
  if (
    parts.year < 0 ||
    parts.year > 9999 ||
    parts.month < 1 ||
    parts.month > 12 ||
    parts.day < 1 ||
    parts.hour < 0 ||
    parts.hour > 23 ||
    parts.minute < 0 ||
    parts.minute > 59 ||
    parts.second < 0 ||
    parts.second > 59 ||
    parts.millisecond < 0 ||
    parts.millisecond > 999
  ) {
    return false;
  }
  const instant = wallTimeAsUtc(parts);
  if (!Number.isFinite(instant)) return false;
  const roundTrip = new Date(instant);
  return (
    roundTrip.getUTCFullYear() === parts.year &&
    roundTrip.getUTCMonth() + 1 === parts.month &&
    roundTrip.getUTCDate() === parts.day &&
    roundTrip.getUTCHours() === parts.hour &&
    roundTrip.getUTCMinutes() === parts.minute &&
    roundTrip.getUTCSeconds() === parts.second &&
    roundTrip.getUTCMilliseconds() === parts.millisecond
  );
}

/**
 * Resolve an offset-less wall time in an IANA timezone without consulting the
 * host timezone. Ambiguous fall-back times choose the earlier occurrence;
 * nonexistent spring-forward wall times fail closed.
 */
function zonedWallTimeToUtc(parts: WallTimeParts, timeZone: string): number | null {
  if (!isValidTimeZone(timeZone)) return null;
  const desired = wallTimeAsUtc(parts);
  let guess = desired;
  const seen = new Set<number>();
  for (let i = 0; i < 6; i++) {
    if (seen.has(guess)) return null;
    seen.add(guess);
    const local = localPartsAt(guess, timeZone);
    const represented = Date.UTC(
      local.year,
      local.month - 1,
      local.day,
      local.hour,
      local.minute,
      local.second,
      parts.millisecond,
    );
    const delta = desired - represented;
    if (delta === 0) return guess;
    guess += delta;
  }
  return null;
}

export function parseInstant(raw: string, options: ParseInstantOptions = {}): number | null {
  const s = raw.trim();
  let m = ISO_NO_OFFSET.exec(s);
  let offsetMin = 0;
  let hasExplicitOffset = false;
  if (!m) {
    m = ISO_WITH_OFFSET.exec(s);
    if (!m) return null;
    hasExplicitOffset = true;
    const off = m[8]!;
    if (off !== 'Z') {
      const sign = off.startsWith('-') ? -1 : 1;
      const digits = off.slice(1).replace(':', '');
      const offsetHour = Number(digits.slice(0, 2));
      const offsetMinute = Number(digits.slice(2, 4));
      if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) {
        return null;
      }
      offsetMin = sign * (offsetHour * 60 + offsetMinute);
    }
  }
  const [, y, mo, d, h, mi, sec, frac] = m;
  const parts: WallTimeParts = {
    year: Number(y),
    month: Number(mo),
    day: Number(d),
    hour: Number(h),
    minute: Number(mi),
    second: Number(sec),
    millisecond: frac ? Number(frac.padEnd(3, '0')) : 0,
  };
  if (!isValidWallTime(parts)) return null;
  if (!hasExplicitOffset && options.defaultTimeZone) {
    return zonedWallTimeToUtc(parts, options.defaultTimeZone);
  }
  const ms = wallTimeAsUtc(parts);
  if (Number.isNaN(ms)) return null;
  return ms - offsetMin * 60_000;
}

/** Render an epoch-ms instant as a compact UTC ISO string (no ms). */
export function toIsoUtc(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
