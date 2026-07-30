# Release procedure

This document is the maintainer-facing companion to [`CHANGELOG.md`](../CHANGELOG.md). It
covers what a version number means for Velograph, how packages are versioned, and the steps
to cut a release.

## Versioning scheme

Velograph follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
(`MAJOR.MINOR.PATCH`). While the project is pre-1.0 (`0.y.z`), semver's own pre-1.0 caveat
applies — the API/data model/CLI surface is not yet considered stable — but this repo
narrows that ambiguity to a concrete local convention:

- **PATCH** (`0.1.x`): bug fixes, guardrail hardening, dependency bumps, and other changes
  with no visible change in behaviour, schema, CLI flags, or API shape.
- **MINOR** (`0.x.0`): new features, new API endpoints or CLI commands, new analytics
  metrics, or a SQLite migration — anything additive that doesn't break existing imported
  data or existing callers.
- **MAJOR** (`x.0.0`, and any `0.x.0 → 0.(x+1).0` while pre-1.0 that is in fact breaking):
  a breaking change — a removed/renamed API field, an incompatible schema change without a
  forward migration, or a changed analytics formula that invalidates prior snapshots
  (`FORMULA_VERSION` bump; see `docs/formulas.md`).

`1.0.0` itself is a product decision (PRD §20), not an engineering trigger — it happens when
the maintainer decides the API, schema, and CLI surface are stable enough to commit to.

### Lockstep versioning across the monorepo

The repository has one version number, not nine. The root `package.json` and all 8 workspace
packages under `apps/*` and `packages/*` (`@velograph/api`, `@velograph/cli`, `@velograph/web`,
`@velograph/analytics`, `@velograph/db`, `@velograph/importers`, `@velograph/insights`,
`@velograph/shared`) are versioned **in lockstep**: every release bumps every `version` field
to the same value in the same commit, whether or not that package's own code changed.

This is a deliberate simplification, not an oversight. The packages are `"private": true`
workspace members of a single application, never published to a registry individually, and
always deployed together — there is no scenario where `@velograph/db` at one version needs
to interoperate with `@velograph/api` at another. Lockstep versioning means a version number
alone (`0.2.0`) unambiguously identifies the state of the whole tree, which is what matters
for bug reports, `CHANGELOG.md` entries, and git tags. Independent per-package versioning
(e.g. Changesets-style) is worth reconsidering only if a package here is ever published
standalone; nothing in this repository anticipates that today.

## Cutting a release

1. **Confirm `CHANGELOG.md` is current.** Every merged PR since the last release should have
   left an entry under `## [Unreleased]` (enforced by CI — see below). Re-read the section
   against `git log <last-tag>..HEAD` and fill in anything missing.
2. **Verify project and third-party licensing.**
   - Confirm the root `LICENSE` matches the canonical `AGPL-3.0-only` text and every
     workspace manifest declares `AGPL-3.0-only`.
   - Run `pnpm license:check` and review `THIRD_PARTY_NOTICES.md` against the release
     dependency/SBOM diff. Resolve every unknown, incompatible, or missing licence or notice.
   - Run the runtime build and package verifiers. Confirm every API, CLI, web, and container
     artifact carries the byte-identical Velograph `LICENSE` separately from third-party
     notices and preserves machine-readable Corresponding Source for that exact version as
     required by the AGPL. A moving branch is not exact-version source.
   - Confirm `COPYRIGHT.md` and `CONTRIBUTING.md` are current and every significant outside
     contribution included in the release has the required CLA recorded privately. Never
     publish signed agreements or contributor PII.
3. **Choose the new version** using the scheme above.
4. **Open a release PR** that, in one commit:
   - Runs `date '+%Y-%m-%d %H:%M:%S %Z (%z)'` and renames `## [Unreleased]` to
     `## [x.y.z] - YYYY-MM-DD` using that machine-local date, then adds a fresh empty
     `## [Unreleased]` section above it.
   - Updates the compare-link reference definitions at the bottom of `CHANGELOG.md`.
   - Bumps `version` in the root `package.json` and in every workspace package's
     `package.json` to the same `x.y.z` (lockstep).
   - Runs `pnpm runtime:build`, `pnpm runtime:verify-artifacts`,
     `pnpm api:verify-package`, and `pnpm cli:verify-package`. The package verifiers must pass
     from clean temporary installs on every Node version in the CI runtime matrix.
5. **Merge the release PR** (squash, per the normal git flow in `CLAUDE.md`/`AGENTS.md`).
6. **Verify the local merge timestamp** with
   `git log -1 --pretty=format:'%cd' --date=local`. If its date does not match the documented
   release date, fix the release documentation before pushing.
7. **Tag the merge commit** on `main`:

   ```sh
   git tag -a vX.Y.Z -m "vX.Y.Z"
   git push origin vX.Y.Z
   ```

8. **Publish a GitHub Release** from the tag, with the `CHANGELOG.md` section for that
   version pasted into the release notes.

## CHANGELOG discipline (enforced by CI)

Any PR that changes behaviour must add an entry under `## [Unreleased]` in `CHANGELOG.md` in
the same commit — this is a rule in `CLAUDE.md` and `AGENTS.md`, not just a suggestion. CI
enforces the mechanical half of it: the **"Changelog enforcement"** job
(`.github/workflows/ci.yml`, `scripts/check-changelog.mjs`) fails a PR that touches
`packages/**`, `apps/**`, or `scripts/**` without also touching `CHANGELOG.md`.

It cannot verify the entry is _meaningful_ — that's still a human review responsibility —
only that the file was touched.

### Escape hatch for non-behavioural changes

Some source-tree changes have no user-visible behaviour and don't warrant a changelog entry:
typo fixes in comments, formatting-only diffs, test-only changes, internal refactors with no
observable effect. For these, add a trailer line to at least one commit message in the PR:

```
Changelog-Exempt: comment typo fix, no behaviour change
```

The check looks for a `Changelog-Exempt: <reason>` line (case-insensitive key) anywhere in
any commit message between the PR's base and head. The reason is required and is shown in
review — use it honestly; a PR that actually changes behaviour and claims exemption is a
review-time problem, not a CI-time one, since CI cannot judge intent.
