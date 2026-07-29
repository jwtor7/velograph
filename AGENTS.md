# Repository Guidelines

## Project Structure & Module Organization

Velograph is a pnpm/TypeScript monorepo: the React web client and the loopback Node.js API
live under `apps/` (`apps/web`, `apps/api`, `apps/cli`), reusable/pure packages under
`packages/` (`analytics`, `db`, `importers`, `insights`, `shared`), and invented test inputs
under `fixtures/synthetic/`. `Velograph-PRD.md` and `CLAUDE.md` remain the source-of-truth
spec and guardrails. Keep `packages/analytics` free of framework, database, network, and LLM
dependencies. Define module ownership before concurrent work — see `CLAUDE.md`'s
multi-agent section.

## Build, Test, and Development Commands

See the root [`README.md`](README.md) Quick start for the verified install → import → run
sequence. In summary: `pnpm install`, then `pnpm --filter @velograph/web build` before the
API can serve the web client (there is no `pnpm dev` script), then `node apps/cli/src/index.ts import <path>` to import rides and `node apps/api/src/main.ts` to start the API on
`127.0.0.1:5123`. CI-equivalent checks: `pnpm test`, `pnpm lint`, `pnpm typecheck`,
`pnpm format`, and `node scripts/privacy-scan.mjs --all`. Run only declared scripts.

## Coding Style & Naming Conventions

Use strict TypeScript, two-space indentation, and small modules with explicit boundaries. Use `camelCase` for values/functions, `PascalCase` for components and exported types, and descriptive kebab-case filenames. Store canonical data in SI units and absolute instants; convert only for display. AI may explain deterministic results but must never calculate metrics, charts, or route geometry.

## Testing Guidelines

No test framework or numeric coverage threshold is selected. Add proportionate unit, parser contract, ordered migration, deterministic golden, offline end-to-end, and accessibility tests. Use invented values, dates, filenames, and routes only beneath `fixtures/synthetic/`. Never use real exports, health data, GPS traces, or credentials.

## Commit & Pull Request Guidelines

Start from a typed, prioritized issue; reference relevant PRD requirement IDs; and use `<agent>/<issue>-<short-description>` branches. Write imperative, issue-linked squash titles. Pull requests must state scope, tests and evidence, privacy/data-handling impact, dependency/licence impact, and migration rollback notes. Include synthetic-only UI screenshots and attest that no real health, location, account, credential, or user data is present. Never push directly or force-push to `main`.

Any PR that changes behaviour must update `CHANGELOG.md` under `## [Unreleased]` in the same commit. CI's "Changelog enforcement" job fails a PR that touches `packages/**`, `apps/**`, or `scripts/**` without a `CHANGELOG.md` change; for a genuinely non-behavioural change (docs typo, formatting, comment/test-only edit), add a `Changelog-Exempt: <reason>` trailer to a commit message instead of a changelog entry. Milestones bump the version — root and every workspace package move together, in lockstep — and get a git tag. See `CHANGELOG.md` and `docs/releasing.md` for the full procedure.

## Security & Local-First Boundaries

This is a public repository. Keep `VELO_DATA_DIR` outside the checkout, bind to `127.0.0.1` by default, and preserve offline operation. Never bypass `.gitignore` with `git add -f`; avoid committing logs, databases, archives, environment files, or local absolute paths.
