/**
 * Personal-context availability (AI-008). The model must never silently
 * assume sleep, stress, nutrition, weather, soreness, goals, or recovery
 * context — every field defaults to 'not_available' and only flips to
 * 'available' when the caller explicitly supplies it.
 */

export type ContextAvailabilityState = 'not_available' | 'available';

export interface ContextAvailability {
  sleep: ContextAvailabilityState;
  stress: ContextAvailabilityState;
  nutrition: ContextAvailabilityState;
  weather: ContextAvailabilityState;
  soreness: ContextAvailabilityState;
  goals: ContextAvailabilityState;
  recovery: ContextAvailabilityState;
}

export const CONTEXT_FIELDS: readonly (keyof ContextAvailability)[] = [
  'sleep',
  'stress',
  'nutrition',
  'weather',
  'soreness',
  'goals',
  'recovery',
];

export const DEFAULT_CONTEXT_AVAILABILITY: ContextAvailability = {
  sleep: 'not_available',
  stress: 'not_available',
  nutrition: 'not_available',
  weather: 'not_available',
  soreness: 'not_available',
  goals: 'not_available',
  recovery: 'not_available',
};

/**
 * Builds a context-availability record. Only fields explicitly marked `true`
 * in `supplied` become 'available'; everything else stays 'not_available'
 * even if the caller forgets to mention it (AI-008 fail-closed default).
 */
export function buildContextAvailability(
  supplied: Partial<Record<keyof ContextAvailability, boolean>> = {},
): ContextAvailability {
  const result = { ...DEFAULT_CONTEXT_AVAILABILITY };
  for (const field of CONTEXT_FIELDS) {
    if (supplied[field] === true) result[field] = 'available';
  }
  return result;
}
