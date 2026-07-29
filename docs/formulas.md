# Analytics formulas — `analytics-v2`

Every metric Velograph reports is calculated by the pure `@velograph/analytics` package,
versioned as `FORMULA_VERSION = analytics-v2` and persisted with each snapshot alongside a
settings hash and input hash (ANA-009). The same input, settings, and version produce
byte-identical JSON (verified by golden tests). Values round explicitly to 3 decimals
(elevation to 1 decimal). No clock, locale, network, or randomness is consulted.

`analytics-v2` replaces `analytics-v1` because geometry-derived maximum speed, bounded sample
windows, moving-time decoupling, elevation boundaries, and interpolated distance splits change
results. Existing `analytics-v1` rows remain immutable provenance records; a v2 computation is
stored as a separate snapshot.

## Definitions

- **Window convention** — analytics windows are half-open `[from, to)`.
- **Forward metric weighting** — heart-rate and cadence samples represent their value from the
  sample timestamp forward to the next sample, capped at 90 seconds. The final sample uses the
  stream's median positive interval (60 seconds for a singleton). Every interval is intersected
  with the active workout, half, or split window. A sample exactly at `to` has zero weight.
- **Coverage** — the union of covered time divided by the exact window length, clamped to
  `[0, 1]`. Only positive-weight samples affect averages or extrema.
- **Duration** — `end − start` of the workout span in seconds.
- **Moving time** — the union of capped route intervals whose recorded speed, or
  geometry-derived speed when missing, is at least the configured threshold. The default is
  1.0 m/s, provisional pending PRD §20.3. Route files and segments are hard boundaries, and an
  interval with either timestamp missing is excluded. Overlapping route files never double-count
  time.
- **Distance** — the sum of canonical distance increments. Each increment ends at its row
  timestamp; its interval begins at the prior distance timestamp, with workout start anchoring
  the first row. A zero-duration increment contributes to total distance but supplies no timing
  evidence and is never assigned to a split or half.
- **Distance coverage** — the capped, end-aligned portion of each distance interval divided by
  the window. Distance itself is allocated across window boundaries in proportion to interval
  overlap.
- **Average speed** — distance divided by moving time when route timing exists and moving time is
  positive, otherwise distance divided by workout duration.
- **Maximum speed** — maximum recorded route-point speed. When no recorded speeds exist, each
  valid capped route interval derives speed from haversine distance divided by time.
- **Elevation gain/loss** — a symmetric hysteresis filter (default 1.0 m). The anchor resets at
  every route-file or segment boundary, so a recording gap cannot become elevation gain or loss.
- **Heart-rate zones** — user-configured ascending bpm boundaries are authoritative and never
  inferred from age. Weights are clipped to the workout window. Integer zone seconds use a
  deterministic largest-remainder allocation whose total cannot exceed covered or workout time;
  shares use exact weighted time divided by workout duration.
- **Efficiency** — average speed (km/h) divided by interval-weighted average HR (bpm), reported
  only when HR coverage meets the configured minimum. The default minimum is 0.7, provisional
  pending PRD §20.5. This is descriptive, not clinical.
- **Decoupling proxy** — efficiency is computed separately for each elapsed-time half, but each
  half's speed uses its own route moving time. HR, distance, and route timing must independently
  meet the coverage minimum. A baseline below `0.01 km/h per bpm`, a missing moving interval, or
  an absolute result above 100% returns `null` with a stable unavailability reason rather than an
  unbounded value. Otherwise the result is `(first − second) / first × 100`. It remains
  terrain- and wind-sensitive.
- **Pacing variability** — coefficient of variation of per-sample distance increments.
- **One-kilometre splits** — every cumulative 1 km crossing is linearly interpolated inside the
  contributing distance interval. Multiple crossings in one increment receive distinct times.
  A split that touches an increment without timing evidence is omitted; no one-second fallback is
  invented.
- **Five-minute splits** — distance increments are allocated proportionally across fixed
  five-minute windows; HR uses the same bounded forward weighting.
- **Unavailability** — any metric that cannot be computed carries a stable reason code in
  `unavailable` (RIDE-006); no missing value is silently guessed.
