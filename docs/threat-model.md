# Threat model and privacy review

This review covers the pre-1.0 local application, its supported Docker/Compose
deployment, and the public delivery pipeline. It is a release gate for PRD
§12.3 and Phase 4, not a claim that every implementation risk is closed.

## Assets and trust boundaries

| Asset                                            | Classification             | Boundary                                     | Required protection                                                     |
| ------------------------------------------------ | -------------------------- | -------------------------------------------- | ----------------------------------------------------------------------- |
| Raw exports, route points, notes, and timestamps | Restricted                 | User data directory only                     | No repository, CI, image, telemetry, or provider transfer by default    |
| SQLite database, backups, and derived insights   | Restricted/derived private | Local volume or user-selected data directory | Explicit backup/export, integrity checks, documented at-rest limitation |
| Codex/Ollama credentials and bridge tokens       | Secret                     | OS credential store or process memory        | Never SQLite, logs, image layers, mounts, fixtures, or backups          |
| Deterministic formulas and chart specifications  | Public-safe                | Source and released package                  | Versioned, tested, reproducible from canonical input                    |
| Release source, SBOM, CI logs, and image layers  | Public-safe only           | Git history and release pipeline             | Privacy scan before publication and fail-closed artifact audit          |

The browser, loopback API, SQLite data directory, optional provider process,
container runtime, Git history, CI system, and public registry are separate
trust boundaries. Moving data across any boundary requires an explicit,
documented reason.

## Primary threats and controls

| Threat                                              | Control                                                                                                                                                  | Residual risk / release evidence                                                                                   |
| --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| Real data or credentials enter Git history          | Default-deny ignore rules, synthetic-only fixtures, pre-commit and CI scans, history audit, incident runbook                                             | Deleted content remains exposed; maintainers must rotate, purge, and invalidate affected releases                  |
| Private files enter a container layer or CI context | `.dockerignore`, production-only runtime copy, no source-export/auth mounts, exact OCI application-layer audit, SBOM-enabled multi-architecture CI       | Pinned base-image contents are reviewed through digest/SBOM; do not publish images built from an untrusted context |
| Loopback API is exposed to a LAN                    | API refuses non-loopback binding; Compose maps only host loopback; relay rewrites only loopback Host/Origin                                              | A user can override Docker port settings; this is unsupported without authentication                               |
| Browser cross-site or DNS-rebinding request         | Strict loopback Host/Origin checks, self-only CSP, CSRF header for mutation                                                                              | Browser and proxy behavior must remain covered by API tests when either changes                                    |
| Malicious export archive or GPX                     | Parser limits, entity rejection, traversal/symlink/bomb defenses, atomic import                                                                          | Limits need regression tests and review as supported source shapes evolve                                          |
| Optional AI reveals more than intended              | Disabled by default; minimized, previewed payload; no raw rows, coordinates, source files, notes, or auth cache                                          | Users may explicitly select a remote provider; documentation must keep that disclosure clear                       |
| Dependency or build compromise                      | Frozen lockfile, pinned Actions, clean Node 20.19/26 installs, exact runtime licence/text gate, multi-architecture build, SBOM, manual dependency review | Base images, action pins, allowlist choices, and embedded components require review before a release               |
| Local theft or filesystem recovery                  | OS permissions and full-disk encryption guidance; no unsupported encryption claim                                                                        | SQLite application-level encryption remains a PRD §20 decision                                                     |

## Container deployment review

The supported Compose configuration has one service and one Docker-managed
local data volume. The API stays on the container loopback interface. A tiny
in-container HTTP relay is needed because Docker port forwarding cannot reach a
process bound to that interface directly; it rewrites the public loopback
Host/Origin to the internal loopback API and is published only as
`127.0.0.1:5123` on the host.

The runtime filesystem is read-only except for the data volume and a bounded
temporary filesystem. Capabilities are dropped and privilege escalation is
disabled. The runtime stage receives only the built web client, deployed API,
production dependencies, entrypoint, and relay. Build tooling and development
dependencies stay in the discarded build stage; reviewed native-addon compiler
sources and package test fixtures are pruned only after lifecycle builds
complete. The resulting production deployment is scanned before the runtime
copy. The image build context excludes local data, exports, credentials, logs,
fixtures, and Git metadata. No image is an acceptable backup of user data.

## Release evidence required

Before public release, retain the CI run links or equivalent local evidence for:

1. clean frozen-lockfile verification on Node 20.19 and Node 26, including a
   packaged web-artifact audit on the minimum runtime;
2. deterministic tests, typecheck, lint, formatting, and worktree privacy scan;
3. all-ref Git-history privacy audit, including the release commit and tags;
4. multi-architecture (`linux/amd64`, `linux/arm64`) build with SBOM and
   provenance attestations for each platform;
5. a scan of the exact retained OCI archive intended for publication, with
   archive checksum and platform manifest digests; and
6. a clean runtime dependency gate, exact final web file/package evidence,
   byte-exact application notices, and native Node/`tini` notices in every
   image platform; and
7. independent review of the SBOM, dependencies, project licence status, and this
   threat model.

Do not mark a release secure solely because a local build succeeds. The exact
published digest and the exact public Git history are the relevant objects.
