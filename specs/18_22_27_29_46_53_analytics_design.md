# Feature: Analytics v2 Correctness and Null-Safe Presentation

## Requirements

- While a workout has multiple route files or segments, when analytics input is loaded, the
  system shall preserve every boundary in deterministic route/segment/point order and shall
  represent missing point times as `null`.
- While route timing is absent or discontinuous, when speed or moving time is computed, the
  system shall not create an interval across the gap; usable geometry and elevation shall remain.
- While metric samples are weighted or split across windows, when an interval meets a boundary,
  the system shall clip and interpolate it so coverage, zones, distance, and split times cannot
  exceed their window or be fabricated.
- While analytics snapshots share the same provenance key, when a replay differs, the system
  shall preserve the original immutable result and return a value-free conflict.
- While analytics settings are submitted or loaded, when keys, types, ranges, or zone ordering
  are invalid, the system shall reject the complete update without persistence.
- While efficiency drift is computed, when HR, distance, or route moving-time coverage is
  insufficient or the baseline is unstable, the system shall return `null` with a stable reason.
- While a trend value is unavailable, when charts render, the system shall preserve the gap
  rather than inventing zero; a real zero shall remain visible.
- While a ride is repaired, when canonical data changes, the detail view shall reload the full
  canonical ride, analytics, comparison, chart, route, and cursor domains without a page refresh.

## Architecture

### Frontend

- Settings uses a shared strict parser plus inline accessible error feedback.
- Trends accepts `number | null`, leaves unavailable slots empty, and distinguishes real zero.
- Ride repair keeps its busy state through canonical detail and library reloads.

### Backend

- DB input loading returns every route and keeps `(route_id, segment)` boundaries distinct.
- Snapshot persistence is insert-once with idempotent replay and typed conflict detection.
- Analytics v2 uses bounded intervals, interpolated distance crossings, per-half moving time,
  independent coverage checks, and stable unavailability codes.
- API validation returns privacy-safe, value-free errors and never persists partial settings.

### Security

- Loopback Host, Origin, CSRF, and response-header behavior remains unchanged.
- Every DB query remains parameterized; settings and route rows are treated as untrusted input.
- Error responses contain stable codes only, never source paths, hashes, samples, coordinates, or
  submitted values.
- No new network, telemetry, remote tile, authentication, or credential surface is introduced.

## Implementation Plan

- [x] Load complete nullable route input and preserve all boundaries (#20).
- [x] Make analytics snapshots immutable and replay-safe (#21).
- [x] Add strict shared analytics settings validation and accessible UI feedback (#22).
- [x] Implement analytics-v2 bounded weighting, splits, zones, and moving-time decoupling
      (#18, #19, #29, analytics half of #53).
- [x] Preserve unavailable trend values as gaps (#27).
- [ ] Reload canonical detail state after repair (#46).
- [x] Update formula documentation, golden output, changelog, and synthetic test coverage.
- [ ] Run full quality, privacy, security, performance, and browser gates.
