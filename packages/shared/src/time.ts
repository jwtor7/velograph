/**
 * Instant parsing for import adapters. Storage truth is epoch ms UTC.
 * Accepted shapes (adapter v1):
 *   - ISO 8601 with offset or Z:  2031-04-02T07:30:00Z, 2031-04-02T07:30:00+02:00
 *   - ISO-like without offset:    2031-04-02T07:30:00 / 2031-04-02 07:30:00
 *     (interpreted as UTC — documented adapter-v1 rule, revisited when real
 *     Health Auto Export offset behaviour is versioned in)
 */
const ISO_NO_OFFSET = /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/;
const ISO_WITH_OFFSET =
  /^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|[+-]\d{2}:?\d{2})$/;

export function parseInstant(raw: string): number | null {
  const s = raw.trim();
  let m = ISO_NO_OFFSET.exec(s);
  let offsetMin = 0;
  if (!m) {
    m = ISO_WITH_OFFSET.exec(s);
    if (!m) return null;
    const off = m[8]!;
    if (off !== 'Z') {
      const sign = off.startsWith('-') ? -1 : 1;
      const digits = off.slice(1).replace(':', '');
      offsetMin = sign * (Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4)));
    }
  }
  const [, y, mo, d, h, mi, sec, frac] = m;
  const ms = Date.UTC(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(sec),
    frac ? Number(frac.padEnd(3, '0')) : 0,
  );
  if (Number.isNaN(ms)) return null;
  return ms - offsetMin * 60_000;
}

/** Render an epoch-ms instant as a compact UTC ISO string (no ms). */
export function toIsoUtc(t: number): string {
  return new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');
}
