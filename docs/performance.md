# Performance and clean-install evidence

This document records the reproducible synthetic release gates for the PRD §14
performance targets and the Phase 4 clean-install acceptance criterion. These
checks use invented Health Auto Export-shaped data only. They do not read the
default Velograph data directory, retain a database, or print source filenames,
sample values, coordinates, or temporary paths.

## Performance gate

Build the production runtimes, then run the benchmark with the supported Node
22 runtime:

```sh
pnpm runtime:build
node scripts/performance-benchmark.mjs
```

The script refuses to run on a non-Node-22 major version. It creates an isolated
temporary corpus and data directory, invokes the production CLI importer, opens
the resulting SQLite database for exact count verification, starts the production
API on an ephemeral loopback port, opens the packaged production web client in
headless Chrome, measures ride detail at both browser and API layers, and removes
all temporary artifacts in a `finally` block. Set `VELO_BROWSER_SMOKE_CHROME` to
the Chrome/Chromium executable when platform autodetection is not appropriate.

The deterministic corpus contains:

| Item                       |     Count |
| -------------------------- | --------: |
| Workouts                   |       100 |
| HAE-shaped source files    |       500 |
| Metric series              |       400 |
| Metric samples             |   800,000 |
| GPX routes                 |       100 |
| Route points               |   200,000 |
| Combined metric/route rows | 1,000,000 |

Each workout has four 2,000-row metric streams and one 2,000-point GPX route.
Dates, source strings, measurements, and coordinates are fixed invented values;
coordinates stay inside the repository's synthetic open-ocean fixture box.
Generation is outside the import timer. The import timer begins immediately
before the production CLI process and ends after it exits. The gate then
requires exact normalized database counts, not just a successful exit code.

The production-browser gate begins with zero analytics snapshots and selects five
rides spanning the corpus. Each measurement launches a fresh Chrome profile with
the HTTP cache disabled, then times from `Page.navigate` until the packaged React
UI has rendered seven KPIs, three synchronized time-series charts, the elevation
profile, and an inked Leaflet route canvas. It includes asset loading,
first-open deterministic analytics, React, charts, and map rendering; Chrome
process launch is deliberately outside the navigation timer. One startup or CDP
transport failure may retry before navigation with a fresh profile inside the
same overall smoke deadline; navigation, assertions, and thresholds are never
retried. The same smoke pass
also requires the geospatial controls, endpoint markers, keyboard pan,
chart/map cursor synchronization, clean browser diagnostics, and loopback-only
network requests. A configured basemap is not required for this synthetic
performance corpus: the Leaflet viewport and route overlay remain an actual,
interactive offline map. With five measurements, nearest-rank p95 is the maximum,
so the cold first render cannot be discarded.

The separate `rideDetailApi` diagnostic uses a representative already-imported
workout. Five warm-up requests populate runtime caches, followed by 40 measured
production HTTP requests. Each measurement includes the SQLite query,
deterministic analytics lookup/calculation, response serialization and transfer,
and JSON decoding. The response shape and its 8,000 metric samples plus 2,000
route points are verified before timing is accepted. This warmed API number is
not used as a substitute for the production-browser requirement.

The pass thresholds are:

- import duration strictly below 180,000 ms;
- production-browser ride-open p95 strictly below 1,000 ms;
- warmed ride-detail API p95 strictly below 1,000 ms; and
- exact corpus and normalized database counts.

The default `performance:benchmark` command is the strict release-reference certification and
must be run on documented stable reference hardware. CI's shared `ubuntu-latest` runners vary
in available CPU and I/O, so CI runs `performance:benchmark:ci`: the same corpus, cold-cache
browser coverage, exact counts, functional assertions, five-run nearest-rank calculation, and
API threshold, with a 3,000 ms browser regression ceiling. CI therefore catches material
regressions without representing variable hosted-runner timing as the one-second release
certification. A release still requires the strict default command and a recorded result from
the reference machine.

Successful output is one fixed-schema `performance-benchmark` JSON line capped
at 2,048 bytes. It contains only runtime descriptors, aggregate counts, timings,
the selected `release-reference` or `ci-regression` profile, limits, and pass/fail booleans.
Any failure prints one value-free error code.

## Recorded reference result

Machine-local time: `2026-07-29 21:30:31 EDT (-0400)`.

| Reference characteristic   | Value                            |
| -------------------------- | -------------------------------- |
| Computer                   | MacBook Pro (Mac16,8)            |
| Processor                  | Apple M4 Pro, 14 cores           |
| Memory                     | 48 GB                            |
| Architecture               | arm64                            |
| Operating system           | macOS 26.5.2                     |
| Runtime                    | Node 22.22.3                     |
| Import result              | 2,075.836 ms (limit: 180,000 ms) |
| Browser ride-open result   | 614.546 ms p95 (limit: 1,000 ms) |
| Browser measurements       | 5 fresh Chrome profiles          |
| Cold snapshots after run 1 | 100                              |
| Warmed API result          | 12.395 ms p95 (limit: 1,000 ms)  |
| Measured API requests      | 40, after 5 warm-up requests     |
| Overall result             | Pass                             |

This result is evidence for the documented reference machine, not a promise
that every supported machine will have identical timings. Re-run the gate on
release artifacts and retain its single summary line with the release evidence.

## Clean-installed CLI gate

Run:

```sh
node scripts/verify-cli-package.mjs
```

The verifier packs `@velograph/cli`, installs that tarball into an otherwise
empty temporary npm project, and executes the installed binary rather than
workspace source. In addition to manifest, dependency, migration, notice,
failure-containment, repair, backup, restore, and delete checks, it now verifies
both release-acceptance import forms:

1. a synthetic Health Auto Export-shaped folder; and
2. a ZIP containing the same complete synthetic export shape.

Folder and ZIP are imported into separate fresh data directories. For each, the
verifier requires one workout, all four canonical metric series, 12 metric
samples, the preferred complete four-point GPX route, six portable source
inventory records, and six workout/source links. It then imports the same input
a second time, requires all six files to be reported as duplicates with zero
new workouts, and proves that every normalized table count is unchanged.

All installed-CLI output is checked against the temporary paths, source
filenames, timestamps, source label, measurements, and coordinates before the
verifier can pass. A successful Node 22 run emits only:

```text
cli-package: installed binary passed on Node 22.22.3
```
