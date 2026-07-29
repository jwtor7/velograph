# Contributing to Velograph

Thank you for helping improve Velograph. It is a public, local-first project,
so privacy and reproducibility are part of every contribution.

## Before writing code

1. Start from a typed GitHub issue with a priority and relevant PRD requirement
   IDs. Discuss a larger design before implementing it.
2. Create one branch and one pull request per issue. Branch from current `main`
   and use `<agent>/<issue>-<short-description>`.
3. Read `AGENTS.md`, `CLAUDE.md`, and the relevant section of
   `Velograph-PRD.md`. Keep the deterministic analytics package free of
   framework, database, network, and LLM dependencies.

## Privacy is a release gate

Never add a real export, route, workout value, timestamp, source/device name,
username path, database, backup, log, credential, or screenshot. Use only
invented inputs under `fixtures/synthetic/`. Do not bypass ignore rules or the
pre-commit hook. If a sensitive item reaches a commit or artifact, stop and
follow the [incident runbook](docs/privacy-incident-response.md).

Run the required local checks before requesting review:

```sh
pnpm install --frozen-lockfile
pnpm format
pnpm lint
pnpm typecheck
pnpm test
pnpm license:check
node scripts/privacy-scan.mjs --all
```

Run narrower checks first when appropriate, but report every command actually
run. Do not start the local server merely to satisfy a contribution check.

## Pull requests

Use the pull-request template completely. Describe scope and non-scope, linked
issue and PRD IDs, tests and evidence, privacy/data-handling impact,
dependencies/licences, and migration or rollback implications. UI evidence must
use synthetic data only. Every PR must attest that it contains no real health,
location, account, credential, or user data.

Changes to `apps/**`, `packages/**`, or `scripts/**` require a meaningful
`CHANGELOG.md` entry under `Unreleased`. A truly non-behavioural source change
may instead use a `Changelog-Exempt: <reason>` commit trailer; see
`docs/releasing.md`.

## Containers and release artifacts

Do not mount exports, credentials, or a data directory inside the checkout
into a container. The checked-in Compose file uses a Docker-managed local
volume and publishes only to host loopback. Before a release, run the history,
artifact, native-container, and exact OCI output checks in
[the release privacy audit guide](docs/release-privacy-audit.md).
Build distributable browser files with `pnpm package:web`, which includes and
verifies the canonical third-party notices.

## Licence status

No open-source licence has been selected or added. Do not add, copy, or imply a
licence without explicit maintainer authority. The outstanding decision is
tracked in PRD §20 and the README; until it is resolved, all rights are
reserved. Upstream dependencies retain their own terms; review and update them
through the [third-party licence gate](docs/third-party-licences.md).
