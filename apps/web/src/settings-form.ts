export interface ZoneBoundsDraftResult {
  value: number[] | null;
  error: string | null;
}

export function validateZoneBoundsDraft(bounds: readonly string[]): ZoneBoundsDraftResult {
  if (bounds.length !== 5) {
    return { value: null, error: 'Enter exactly five heart-rate zone boundaries.' };
  }
  const normalized = bounds.map((bound) => bound.trim());
  if (normalized.every((bound) => bound.length === 0)) {
    return { value: null, error: null };
  }
  if (normalized.some((bound) => bound.length === 0)) {
    return {
      value: null,
      error: 'Enter all five boundaries, or leave all five blank to disable zone analysis.',
    };
  }
  const values = normalized.map(Number);
  if (
    values.some(
      (value) => !Number.isFinite(value) || !Number.isInteger(value) || value < 40 || value > 230,
    )
  ) {
    return {
      value: null,
      error: 'Each boundary must be a whole number from 40 to 230 bpm.',
    };
  }
  if (values.some((value, index) => index > 0 && value <= values[index - 1]!)) {
    return {
      value: null,
      error: 'Boundaries must increase strictly from left to right.',
    };
  }
  return { value: values, error: null };
}
