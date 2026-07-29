# Analytics formulas — `analytics-v1`

Every metric Velograph reports is calculated by the pure `@velograph/analytics` package,
versioned as `FORMULA_VERSION = analytics-v1` and persisted with each snapshot alongside a
settings hash and input hash (ANA-009). Same input + settings + version ⇒ byte-identical
JSON (verified by golden tests). All rounding is explicit: values round half-up to 3
decimals (elevation to 1 decimal). No clock, locale, network, or randomness is consulted.

## Definitions

- **Duration** — `end − start` of the workout span (seconds).
- **Interval weighting** — every sample is weighted by the time to the next sample, capped
  at 90 s (the gap cap); the last sample gets the median interval. Zone times and averages
  use these weights, never row counts (ANA-002).
- **Coverage** — sum of interval weights ÷ duration, clamped to [0, 1].
- **Moving time** — total time of route intervals whose recorded speed ≥ the
  moving-speed threshold. **Default 1.0 m/s — provisional pending PRD §20.3**, stored as a
  setting, not a constant.
- **Distance** — sum of distance samples (already canonical metres).
- **Average speed** — distance ÷ moving time when route timing exists, else distance ÷ duration.
- **Max speed** — maximum recorded route point speed.
- **Elevation gain/loss** — a symmetric hysteresis filter (default 1.0 m): an elevation
  change only counts once the running delta from the last accepted anchor exceeds the
  hysteresis; gains and losses accumulate separately.
- **Heart-rate zones** — user-configured ascending bpm boundaries are authoritative; zones
  are never inferred from age. Unconfigured ⇒ zone analysis reported unavailable.
- **Efficiency** — average speed (km/h) ÷ interval-weighted average HR (bpm), reported only
  when HR coverage ≥ the efficiency coverage minimum (**default 0.7 — provisional pending
  PRD §20.5**). A descriptive ratio, not a clinical measure.
- **Decoupling proxy** — efficiency computed separately for each half of the workout span
  (each half needs ≥ 2 HR and 2 distance samples and the coverage minimum); reported as
  relative decline `(first − second) / first × 100`. Labelled terrain- and wind-sensitive.
- **Pacing variability** — coefficient of variation of per-sample distance increments.
- **Splits** — fixed 1 km splits from cumulative distance and fixed 5-minute time splits;
  each reports duration, distance, speed, and interval-weighted average HR.
- **Unavailability** — any metric that cannot be computed carries a stable reason code in
  `unavailable` (RIDE-006); nothing is silently guessed.
