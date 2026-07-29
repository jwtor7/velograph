export interface NumericBounds {
  min?: number;
  max?: number;
  minExclusive?: number;
  maxExclusive?: number;
}

const DECIMAL_NUMBER = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * Parse an imported numeric cell without JavaScript's blank-to-zero coercion.
 * `null` means missing, malformed, non-finite, or outside the supplied range;
 * callers decide whether the field is required or optional.
 */
export function parseStrictNumber(
  raw: string | null | undefined,
  bounds: NumericBounds = {},
): number | null {
  if (raw == null) return null;
  const text = raw.trim();
  if (text === '' || !DECIMAL_NUMBER.test(text)) return null;
  const value = Number(text);
  if (!Number.isFinite(value)) return null;
  if (bounds.min != null && value < bounds.min) return null;
  if (bounds.max != null && value > bounds.max) return null;
  if (bounds.minExclusive != null && value <= bounds.minExclusive) return null;
  if (bounds.maxExclusive != null && value >= bounds.maxExclusive) return null;
  return value;
}
